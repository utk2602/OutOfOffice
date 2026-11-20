import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Database, RecordStore } from '@outofoffice/database';
import { tone } from '@outofoffice/voice-sdk';
import { ProviderError, type CreateBot, type ProviderBot, type MeetingProvider } from '@outofoffice/meeting-sdk';
import { createApi } from '../src/server.ts';

class FakeProvider implements MeetingProvider {
  creates: CreateBot[] = []; bots = new Map<string, ProviderBot>(); leaves = 0; deletes = 0;
  ambiguous = false; deleteFails = false;
  async createBot(input: CreateBot) {
    this.creates.push(input); const bot = { id: `bot_${this.creates.length}`, state: 'joining', deduplication_key: `outofoffice-${input.meetingId}` };
    this.bots.set(bot.id, bot);
    if (this.ambiguous) throw new ProviderError('CREATE_UNCERTAIN', true);
    return bot;
  }
  async getBot(id: string) { return { ...this.bots.get(id)! }; }
  async findBots(key: string) { return [...this.bots.values()].filter(bot => bot.deduplication_key === key); }
  async leaveBot(id: string) { this.leaves++; this.bots.get(id)!.state = 'ended'; }
  async deleteBotData() { if (this.deleteFails) throw new Error('Provider unavailable'); this.deletes++; }
}
const identity = { ownerId: randomUUID(), token: 'h'.repeat(64) };
const other = { ownerId: randomUUID(), token: 'o'.repeat(64) };
const secret = Buffer.from('synthetic-project-webhook-secret').toString('base64');
let db: Database; let api: Awaited<ReturnType<typeof createApi>>; let base: string; let callbacks: string;
let provider: FakeProvider; let longSpeech = false; const spoken: string[] = [];
const peers = new Set<WebSocket>(); const timers = new Set<ReturnType<typeof setInterval>>();
async function start() {
  api = await createApi({ store: new RecordStore(db, { budgetSeconds: 14400, maxMeetingSeconds: 900, maxConcurrentMeetings: 1, hostedBudgetSeconds: 14400 }), identities: [identity, other],
    hosted: { provider, publicUrl: 'https://callbacks.example.com', callbackPort: 0, webhookSecret: secret, synthesizer: {
      async *synthesize(text, signal) { spoken.push(text); for (let index = 0; index < (longSpeech ? 20 : 1); index++) { signal.throwIfAborted(); yield tone(24000, 100); } },
    } },
  });
  await api.app.listen(0, '127.0.0.1'); base = await api.app.getUrl();
  callbacks = `http://127.0.0.1:${(api.ingress!.server.address() as { port: number }).port}`;
}
before(async () => { db = await Database.open(); provider = new FakeProvider(); await start(); });
after(async () => { await api.close(); await db.close(); });
async function request(path: string, method = 'GET', body?: unknown, who = identity) {
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(path: string, method = 'GET', body?: unknown): Promise<any> { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; }
async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 5000; while (Date.now() < end) { if (await predicate()) return; await delay(15); } assert.fail(message);
}
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
async function webhook(input: CreateBot, botId: string, trigger: string, data: unknown, delivery = randomUUID(), valid = true) {
  const payload = { bot_id: botId, idempotency_key: delivery, trigger, data };
  const signature = createHmac('sha256', Buffer.from(secret, 'base64')).update(JSON.stringify(canonical(payload))).digest('base64');
  return fetch(`${callbacks}${new URL(input.webhookUrl).pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': valid ? signature : 'invalid' }, body: JSON.stringify(payload) });
}
async function fixture() {
  const agent = await json('/api/v1/agents', 'POST', { ownerName: 'Alex', allowedTopics: ['project status'] });
  const fact = await json(`/api/v1/agents/${agent.id}/knowledge`, 'POST', { title: 'Reconciliation', topic: 'project status', text: 'Validation is pending.', approved: true, sensitivity: 'MEETING' });
  const body = { agentId: agent.id, title: 'Controlled Meet', provider: 'attendee', meetingUrl: 'https://meet.google.com/abc-defg-hij', sourceIds: [fact.id], ownerAuthorized: true, participantsConsented: true, providerDataAccepted: true, maxDurationSeconds: 60 };
  const key = randomUUID();
  const response = await fetch(`${base}/api/v1/meetings`, { method: 'POST', headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const meeting: any = await response.json(); assert.equal(response.status, 202, JSON.stringify(meeting));
  const input = provider.creates.at(-1)!; const bot = [...provider.bots.values()].at(-1)!;
  return { agent, fact, meeting, input, bot, body, key };
}
async function connect(input: CreateBot) {
  const socket = new WebSocket(`${callbacks.replace('http:', 'ws:')}${new URL(input.mediaUrl).pathname}`);
  peers.add(socket); const frames: unknown[] = []; socket.on('message', data => frames.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  const keepAlive = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ bot_id: [...provider.bots.values()].at(-1)!.id, trigger: 'realtime_audio.mixed', data: { sample_rate: 16000, timestamp_ms: Date.now(), chunk: Buffer.alloc(640).toString('base64') } })); }, 100);
  timers.add(keepAlive); return { socket, frames };
}
async function caption(f: Awaited<ReturnType<typeof fixture>>, text: string, timestamp = Date.now(), delivery = randomUUID()) {
  return webhook(f.input, f.bot.id, 'transcript.update', { speaker_uuid: 'sam-1', speaker_name: 'Sam', timestamp_ms: timestamp, duration_ms: 0, transcription: { transcript: text } }, delivery);
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const media = await connect(f.input); f.bot.state = 'joined_recording';
  assert.equal((await webhook(f.input, f.bot.id, 'bot.state_change', { new_state: f.bot.state, created_at: new Date().toISOString() })).status, 200);
  assert.equal((await caption(f, 'Hello everyone.')).status, 200);
  await json(`/api/v1/meetings/${f.meeting.id}/enable-speaking`, 'POST', { participantsConsented: true, disclosureConfirmed: true }); return media;
}
afterEach(async () => {
  for (const timer of timers) clearInterval(timer); timers.clear();
  for (const peer of peers) peer.terminate(); peers.clear();
  provider.ambiguous = false; provider.deleteFails = false; longSpeech = false; spoken.length = 0;
  for (const meeting of await api.service.store.listMeetings(identity.ownerId)) {
    await api.hosted!.stop(identity.ownerId, meeting.id);
    await api.hosted!.reconcile(identity.ownerId, meeting.id);
    await api.service.deleteMeeting(identity.ownerId, meeting.id);
  }
});

test('live bot stays muted until admission, caption, socket and explicit disclosure confirmation', async () => {
  const f = await fixture(); assert.equal(f.meeting.speechState, 'MUTED');
  assert.equal((await request(`/api/v1/meetings/${f.meeting.id}/unmute`, 'POST')).status, 409);
  assert.equal((await request(`/api/v1/meetings/${f.meeting.id}/enable-speaking`, 'POST', { participantsConsented: true, disclosureConfirmed: true })).status, 409);
  const { frames } = await ready(f);
  assert.equal((await caption(f, 'OutOfOffice, what is the reconciliation status?')).status, 200);
  await until(async () => (await json(`/api/v1/meetings/${f.meeting.id}`)).responses.some((response: any) => response.playbackStatus === 'TRANSMITTED'), 'Audio was not transmitted');
  assert.deepEqual(spoken, ['Validation is pending.']); assert.ok(frames.length > 0);
  assert.equal((frames[0] as any).trigger, 'realtime_audio.bot_output');
  assert.equal((await request(`/api/v1/meetings/${f.meeting.id}/provider`, 'GET', undefined, other)).status, 404);
});
test('callback ingress verifies signatures, bot binding and capability and exposes no control API', async () => {
  const f = await fixture();
  assert.equal((await webhook(f.input, f.bot.id, 'bot.state_change', { new_state: 'joining', created_at: new Date().toISOString() }, randomUUID(), false)).status, 403);
  assert.equal((await webhook(f.input, 'bot_wrong', 'bot.state_change', { new_state: 'joining', created_at: new Date().toISOString() })).status, 403);
  assert.equal((await fetch(`${callbacks}/api/v1/agents`)).status, 404);
  assert.equal((await request(`/api/v1/meetings/${f.meeting.id}/utterances`, 'POST', { eventId: 'manual', speaker: 'Owner', text: 'OutOfOffice, hello?' })).status, 409);
});
test('duplicate and revised captions never trigger duplicate answers; stale captions never speak', async () => {
  const f = await fixture(); await ready(f); const timestamp = Date.now(); const delivery = randomUUID();
  await caption(f, 'OutOfOffice, what is the reconciliation status?', timestamp, delivery);
  await until(() => spoken.length === 1, 'Expected one synthesis');
  await caption(f, 'OutOfOffice, what is the reconciliation status?', timestamp, delivery);
  await caption(f, 'OutOfOffice, promise deployment tomorrow.', timestamp);
  await caption(f, 'OutOfOffice, what is the status?', timestamp - 30_000);
  const record = await json(`/api/v1/meetings/${f.meeting.id}`);
  assert.equal(record.responses.filter((response: any) => response.kind === 'ANSWER').length, 1); assert.equal(spoken.length, 1);
});
test('authenticated participant barge-in stops new frames and requests leave when provider flush is unsupported', async () => {
  const f = await fixture(); const media = await ready(f); longSpeech = true;
  await caption(f, 'OutOfOffice, what is the reconciliation status?');
  await until(() => media.frames.length >= 1, 'Expected initial audio frame'); const count = media.frames.length;
  const start = performance.now();
  await webhook(f.input, f.bot.id, 'participant_events.speech_start_stop', { participant_uuid: 'sam-1', participant_name: 'Sam', event_type: 'speech_start', timestamp_ms: Date.now() });
  await until(() => f.bot.state === 'ended', 'Provider leave was not requested');
  assert.ok(performance.now() - start < 1000); assert.ok(media.frames.length <= count + 1);
  assert.equal((await json(`/api/v1/meetings/${f.meeting.id}`)).meeting.speechState, 'BLOCKED');
});
test('ambiguous bot creation is reconciled without another create call or refunded reservation', async () => {
  provider.ambiguous = true; const before = provider.creates.length; const f = await fixture();
  await api.hosted!.reconcile(identity.ownerId, f.meeting.id);
  assert.equal(provider.creates.length, before + 1);
  const record = await json(`/api/v1/meetings/${f.meeting.id}`); assert.equal(record.meeting.speechState, 'BLOCKED');
  const retry = await fetch(`${base}/api/v1/meetings`, { method: 'POST', headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': f.key }, body: JSON.stringify(f.body) });
  assert.equal(retry.status, 202); assert.equal(provider.creates.length, before + 1);
});
test('provider deletion failure keeps local evidence for retry and never claims successful deletion', async () => {
  const f = await fixture(); await api.hosted!.stop(identity.ownerId, f.meeting.id); await api.hosted!.reconcile(identity.ownerId, f.meeting.id);
  provider.deleteFails = true;
  assert.equal((await request(`/api/v1/meetings/${f.meeting.id}`, 'DELETE')).status, 502);
  assert.equal((await json(`/api/v1/meetings/${f.meeting.id}/provider`)).deletion, 'pending');
  assert.equal((await request(`/api/v1/meetings/${f.meeting.id}`)).status, 200);
  provider.deleteFails = false; await json(`/api/v1/meetings/${f.meeting.id}`, 'DELETE');
  assert.equal((await request(`/api/v1/meetings/${f.meeting.id}`)).status, 404);
});
test('media disconnect blocks speech and requests provider leave', async () => {
  const f = await fixture(); const { socket } = await ready(f); socket.close();
  await until(() => f.bot.state === 'ended', 'Lost media did not stop the provider');
  assert.equal((await json(`/api/v1/meetings/${f.meeting.id}`)).meeting.speechState, 'BLOCKED');
});
test('a new participant after consent closes the session instead of collecting an unconsented turn', async () => {
  const f = await fixture(); await ready(f);
  await webhook(f.input, f.bot.id, 'participant_events.join_leave', { participant_uuid: 'late-joiner', participant_name: 'New participant', event_type: 'join', timestamp_ms: Date.now() });
  assert.equal((await json(`/api/v1/meetings/${f.meeting.id}`)).meeting.status, 'COMPLETED');
  assert.equal((await json(`/api/v1/meetings/${f.meeting.id}/provider`)).lastError, 'PARTICIPANT_CHANGE_REQUIRES_CONSENT');
});
test('restart reconciles and stops the old bot without recreating or resuming speech', async () => {
  const f = await fixture(); const before = provider.creates.length;
  await api.close(); await start();
  const status = await json(`/api/v1/meetings/${f.meeting.id}/provider`);
  assert.equal(status.state, 'ENDED'); assert.equal(status.disclosureConfirmed, false);
  assert.equal(provider.creates.length, before);
  assert.equal((await json(`/api/v1/meetings/${f.meeting.id}`)).meeting.status, 'COMPLETED');
});
