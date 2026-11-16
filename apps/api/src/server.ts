import 'reflect-metadata';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Module, Param, Patch, Post, Req, Res,
  HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { z } from 'zod';
import { agentInputSchema, factInputSchema, idSchema, textSchema, utteranceInputSchema,
  type SessionRecord } from '@outofoffice/shared';
import { RecordStore, StoreError } from '@outofoffice/database';
import { SessionError, type SpeechSynthesizer } from '@outofoffice/voice-worker';
import { WindowsSpeechSynthesizer } from '@outofoffice/voice-sdk';
import { AgentService, summarize } from './service.ts';

type Request = IncomingMessage & { ownerId: string; requestId: string; originalUrl: string };
type Response = ServerResponse & { status(code: number): Response; json(value: unknown): Response };
const SERVICE = Symbol('AgentService');
const owner = (request: Request) => request.ownerId;
const identifier = (value: string) => idSchema.parse(value);

class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    if (response.headersSent) { response.end(); return; }
    let status = 500; let code = 'INTERNAL_ERROR'; let message = 'The operation failed. No new speech is authorized.';
    if (error instanceof StoreError) { status = error.status; code = error.code; message = error.message; }
    else if (error instanceof SessionError) { status = error.code === 'NOT_FOUND' ? 404 : 409; code = error.code; message = error.message; }
    else if (error instanceof z.ZodError) { status = 400; code = 'INVALID_REQUEST'; message = error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '); }
    else if (error instanceof HttpException) { status = error.getStatus(); code = status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST'; message = status === 404 ? 'Route not found.' : 'Invalid request.'; }
    else if (error && typeof error === 'object' && 'status' in error && (error.status === 400 || error.status === 413)) {
      status = error.status; code = status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON'; message = 'Request body is invalid or too large.';
    }
    response.status(status).json({ error: { code, message, requestId: request.requestId ?? randomUUID() } });
  }
}

@Controller('api/v1')
class ApiController {
  constructor(@Inject(SERVICE) private readonly service: AgentService) {}
  @Get('agents') listAgents(@Req() request: Request) { return this.service.store.listAgents(owner(request)); }
  @Post('agents') createAgent(@Req() request: Request, @Body() body: unknown) { return this.service.store.createAgent(owner(request), agentInputSchema.parse(body)); }
  @Get('agents/:id') getAgent(@Req() request: Request, @Param('id') id: string) { return this.service.store.getAgent(owner(request), identifier(id)); }
  @Patch('agents/:id') updateAgent(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) { return this.service.changeAgent(owner(request), identifier(id), body); }
  @Delete('agents/:id') deleteAgent(@Req() request: Request, @Param('id') id: string) { return this.service.deleteAgent(owner(request), identifier(id)); }
  @Post('agents/:id/knowledge') createFact(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.service.store.createFact(owner(request), identifier(id), factInputSchema.parse(body));
  }
  @Get('agents/:id/knowledge') listFacts(@Req() request: Request, @Param('id') id: string) { return this.service.listFacts(owner(request), identifier(id)); }
  @Patch('knowledge/:id') changeFact(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) { return this.service.changeFact(owner(request), identifier(id), body); }
  @Delete('knowledge/:id') deleteFact(@Req() request: Request, @Param('id') id: string) { return this.service.changeFact(owner(request), identifier(id), null); }
  @Post('meetings') @HttpCode(202)
  async dispatch(@Req() request: Request, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const result = await this.service.dispatch(owner(request), body, key ?? ''); return { ...result.record.meeting, created: result.created };
  }
  @Get('meetings') meetings(@Req() request: Request) { return this.service.store.listMeetings(owner(request)); }
  @Get('meetings/:id') record(@Req() request: Request, @Param('id') id: string) { return this.service.getRecord(owner(request), identifier(id)); }
  @Get('meetings/:id/transcript') async transcript(@Req() request: Request, @Param('id') id: string) { return (await this.service.getRecord(owner(request), identifier(id))).transcript; }
  @Get('meetings/:id/summary') async summary(@Req() request: Request, @Param('id') id: string) { return summarize(await this.service.getRecord(owner(request), identifier(id))); }
  @Get('meetings/:id/export') exportMeeting(@Req() request: Request, @Param('id') id: string) { return this.service.getRecord(owner(request), identifier(id)); }
  @Get('meetings/:id/responses/:responseId/permission') permission(@Req() request: Request, @Param('id') id: string, @Param('responseId') responseId: string) {
    return this.service.playbackPermission(owner(request), identifier(id), identifier(responseId));
  }
  @Post('meetings/:id/utterances') @HttpCode(200)
  utterance(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) { return this.service.receive(owner(request), identifier(id), utteranceInputSchema.parse(body)); }
  @Post('meetings/:id/:action') @HttpCode(200)
  control(@Req() request: Request, @Param('id') id: string, @Param('action') action: string) {
    return this.service.control(owner(request), identifier(id), z.enum(['mute', 'unmute', 'interrupt', 'leave', 'revoke']).parse(action));
  }
  @Delete('meetings/:id') deleteMeeting(@Req() request: Request, @Param('id') id: string) { return this.service.deleteMeeting(owner(request), identifier(id)); }
  @Get('usage') usage(@Req() request: Request) { return this.service.store.usage(owner(request)); }
  @Get('approvals') async approvals(@Req() request: Request) {
    const rows = await this.service.store.database.query<{ document: SessionRecord }>('SELECT s.document FROM session_records s JOIN meetings m ON m.id=s.meeting_id WHERE m.owner_id=$1', [owner(request)]);
    return rows.rows.flatMap(row => row.document.followUps).filter(item => item.status === 'pending');
  }
  @Post('approvals/:id/resolve') @HttpCode(200)
  resolve(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = z.object({ answer: textSchema.nullable() }).strict().parse(body);
    return this.service.resolve(owner(request), identifier(id), input.answer);
  }
  @Get('meetings/:id/events')
  async events(@Req() request: Request, @Res() response: Response, @Param('id') rawId: string) {
    const id = identifier(rawId); const initial = await this.service.getRecord(owner(request), id);
    const dispose = this.service.subscribe(id, event => {
      if (response.destroyed) return;
      if (response.writableLength > 64_000) { response.destroy(); return; }
      response.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'meeting.deleted') response.end();
    });
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15_000);
    response.on('close', () => { clearInterval(heartbeat); dispose(); });
  }
  @Post('meetings/:id/responses/:responseId/audio')
  async audio(@Req() request: Request, @Res() response: Response, @Param('id') rawId: string, @Param('responseId') rawResponseId: string) {
    const id = identifier(rawId); const responseId = identifier(rawResponseId);
    const record = await this.service.getRecord(owner(request), id);
    if (!record.responses.some(item => item.id === responseId)) throw new StoreError('NOT_FOUND', 'Response not found.', 404);
    let completed = false;
    const disconnected = () => { if (!completed) void this.service.control(owner(request), id, 'interrupt').catch(() => undefined); };
    response.on('close', disconnected);
    try {
      const result = await this.service.speak(owner(request), id, responseId, {
        send: async (frame, signal) => {
          signal.throwIfAborted();
          if (response.destroyed) throw new Error('Audio client disconnected.');
          if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Audio-Format': 'pcm_s16le', 'X-Audio-Sample-Rate': '24000', 'X-Audio-Channels': '1' });
          if (!response.write(frame.pcm)) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { response.off('drain', drained); response.off('close', closed); signal.removeEventListener('abort', cancelled); };
            const drained = () => { cleanup(); resolve(); };
            const closed = () => { cleanup(); reject(new Error('Audio client disconnected.')); };
            const cancelled = () => { cleanup(); reject(signal.reason); };
            response.once('drain', drained); response.once('close', closed); signal.addEventListener('abort', cancelled, { once: true });
          });
        },
        flush: async () => 'unsupported',
      });
      completed = true;
      if (!response.headersSent) response.status(409).json({ error: { code: 'NO_AUDIO', message: `Audio stopped: ${result.reason}`, requestId: request.requestId } });
      else response.end();
    } finally { completed = true; response.off('close', disconnected); }
  }
}

export type ApiIdentity = { ownerId: string; token: string };
export async function createApi(options: { store: RecordStore; identities: ApiIdentity[]; synthesizer?: SpeechSynthesizer }) {
  if (!options.identities.length || options.identities.some(identity => !idSchema.safeParse(identity.ownerId).success || identity.token.length < 32) ||
      new Set(options.identities.map(identity => identity.token)).size !== options.identities.length) throw new Error('Configure unique local API tokens of at least 32 characters and valid owner IDs.');
  for (const identity of options.identities) await options.store.ensureOwner(identity.ownerId);
  const service = new AgentService(options.store, options.synthesizer ?? new WindowsSpeechSynthesizer());
  await service.initialize();
  @Module({ controllers: [ApiController], providers: [{ provide: SERVICE, useValue: service }] })
  class LocalModule {}
  const app = await NestFactory.create<NestExpressApplication>(LocalModule, { logger: false, bodyParser: false, abortOnError: false });
  app.useGlobalFilters(new ErrorFilter());
  const credentials = options.identities.map(identity => ({ ownerId: identity.ownerId, digest: createHash('sha256').update(identity.token).digest() }));
  const rates = new Map<string, { count: number; since: number }>();
  app.use((request: Request, response: Response, next: () => void) => {
    request.requestId = randomUUID(); response.setHeader('X-Request-Id', request.requestId); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-store');
    const fail = (status: number, code: string, message: string) => response.status(status).json({ error: { code, message, requestId: request.requestId } });
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) || request.headers.origin) { fail(403, 'LOCAL_CLIENT_REQUIRED', 'Use an authenticated local CLI client.'); return; }
    if (request.url === '/health/live') { response.json({ status: 'ok', mode: 'local' }); return; }
    const authorization = request.headers.authorization ?? '';
    const digest = createHash('sha256').update(authorization.startsWith('Bearer ') ? authorization.slice(7) : '').digest();
    const identity = credentials.find(credential => timingSafeEqual(credential.digest, digest));
    if (!identity) { fail(401, 'UNAUTHORIZED', 'A valid local bearer token is required.'); return; }
    request.ownerId = identity.ownerId;
    const rate = rates.get(identity.ownerId) ?? { count: 0, since: Date.now() };
    if (Date.now() - rate.since >= 60_000) { rate.count = 0; rate.since = Date.now(); }
    rate.count++; rates.set(identity.ownerId, rate);
    if (rate.count > 600) { fail(429, 'RATE_LIMIT', 'Local request limit exceeded.'); return; }
    if (request.url === '/health/ready') {
      void options.store.database.query('SELECT 1').then(() => response.json({ status: 'ready', mode: 'local' }), () => fail(503, 'DATABASE_UNAVAILABLE', 'The database is unavailable.')); return;
    }
    next();
  });
  app.useBodyParser('json', { limit: '16kb', strict: true });
  await app.init();
  const server = app.getHttpServer() as import('node:http').Server;
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  return { app, service, close: async () => { await service.close(); server.closeAllConnections(); await app.close(); } };
}
