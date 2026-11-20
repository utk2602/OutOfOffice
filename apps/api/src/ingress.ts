import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { parseWebhook, verifyWebhook } from '@outofoffice/meeting-sdk';
import { parseMedia } from '../../../packages/meeting-sdk/src/socket.ts';
import type { HostedMeetings } from './hosted.ts';

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 32_000) throw new Error('Webhook body too large.'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** A separate callback-only server. Never route the control API through a tunnel. */
export function createProviderIngress(hosted: HostedMeetings, webhookSecret: string) {
  const rate = new Map<string, { since: number; count: number }>();
  const match = (url: string | undefined) => /^\/attendee\/([a-f0-9-]{36})\/([a-f0-9]{64})\/(events|media)$/.exec(url ?? '');
  const server = createServer((request, response) => {
    const handle = async () => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
      const route = match(request.url);
      if (!route || route[3] !== 'events' || request.method !== 'POST' || request.headers.origin || !request.headers['content-type']?.startsWith('application/json')) { response.writeHead(404).end(); return; }
      const id = route[1]!;
      const attempt = await hosted.authorize(id, route[2]!);
      if (!attempt) { response.writeHead(403).end(); return; }
      const entry = rate.get(id) ?? { since: Date.now(), count: 0 };
      if (Date.now() - entry.since > 60_000) { entry.since = Date.now(); entry.count = 0; }
      entry.count++; rate.set(id, entry);
      if (entry.count > 1200) { response.writeHead(429).end(); return; }
      const payload = await body(request);
      const signature = request.headers['x-webhook-signature'];
      if (typeof signature !== 'string' || !verifyWebhook(payload, signature, webhookSecret)) { response.writeHead(403).end(); return; }
      const event = parseWebhook(payload);
      if (event && event.botId !== attempt.botId) { response.writeHead(403).end(); return; }
      if (event) await hosted.event(id, event);
      response.writeHead(200).end();
    };
    void handle().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64_000, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const upgrade = async () => {
      const route = match(request.url);
      if (!route || route[3] !== 'media' || request.headers.origin) { socket.destroy(); return; }
      const attempt = await hosted.authorize(route[1]!, route[2]!);
      if (!attempt?.botId) { socket.destroy(); return; }
      if (sockets.clients.size >= 2) { socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, connection => {
        hosted.connect(attempt.meetingId, connection);
        let count = 0; let since = Date.now();
        connection.on('error', () => undefined);
        connection.on('message', (data, binary) => {
          try {
            if (binary) throw new Error('JSON media envelope required.');
            if (Date.now() - since > 1000) { count = 0; since = Date.now(); }
            if (++count > 150) throw new Error('Media rate exceeded.');
            parseMedia(JSON.parse(data.toString()), attempt.botId!); hosted.mediaReceived(attempt.meetingId);
          } catch { connection.close(1008, 'Invalid media'); }
        });
      });
    };
    void upgrade().catch(() => socket.destroy());
  });
  return {
    server,
    listen: (port: number) => new Promise<void>((resolve, reject) => {
      const error = (reason: Error) => reject(reason); server.once('error', error);
      server.listen(port, '127.0.0.1', () => { server.off('error', error); resolve(); });
    }),
    close: async () => {
      for (const socket of sockets.clients) socket.terminate(); sockets.close();
      if (server.listening) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
      rate.clear();
    },
  };
}
