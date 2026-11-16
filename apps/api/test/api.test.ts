import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database, RecordStore } from '@outofoffice/database';
import { tone } from '@outofoffice/voice-sdk';
import { createApi } from '../src/server.ts';

const first = { ownerId: randomUUID(), token: 'a'.repeat(64) };
const second = { ownerId: randomUUID(), token: 'b'.repeat(64) };
let db: Database;
let api: Awaited<ReturnType<typeof createApi>>;
let base: string;
let voiceMode: 'short' | 'long' = 'short';
before(async () => {
  db = await Database.open();
  api = await createApi({ store: new RecordStore(db, { budgetSeconds: 14400, maxMeetingSeconds: 900, maxConcurrentMeetings: 2 }), identities: [first, second], synthesizer: {
    async *synthesize(_text, signal) { for (let index = 0; index < (voiceMode === 'long' ? 10 : 1); index++) { signal.throwIfAborted(); yield tone(24000, 100); } },
  } });
  await api.app.listen(0, '127.0.0.1'); base = await api.app.getUrl();
});
after(async () => { await api.close(); await db.close(); });
async function request(path: string, method = 'GET', body?: unknown, identity = first, extraHeaders: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${identity.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(path: string, method = 'GET', body?: unknown, identity = first, headers: Record<string, string> = {}): Promise<any> {
  const response = await request(path, method, body, identity, headers); const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function fixture() {
  const agent = await json('/api/v1/agents', 'POST', { ownerName: 'Alex', allowedTopics: ['project status', 'blockers'], prohibitedTopics: ['salary'] });
  const fact = await json(`/api/v1/agents/${agent.id}/knowledge`, 'POST', { title: 'Reconciliation', topic: 'project status', text: 'Implementation is complete. Validation is pending.', approved: true, sensitivity: 'MEETING' });
  const input = { agentId: agent.id, title: 'Local standup', sourceIds: [fact.id], maxDurationSeconds: 60, ownerAuthorized: true };
  const meeting = await json('/api/v1/meetings', 'POST', input, first, { 'Idempotency-Key': randomUUID() });
  return { agent, fact, input, meeting };
}
const ask = (id: string, text = 'OutOfOffice, what is the reconciliation status?', eventId = randomUUID()) => json(`/api/v1/meetings/${id}/utterances`, 'POST', { eventId, speaker: 'Sam', text });
afterEach(async () => {
  voiceMode = 'short';
  for (const identity of [first, second]) {
    const meetings = await json('/api/v1/meetings', 'GET', undefined, identity);
    for (const meeting of meetings) if (meeting.status === 'ACTIVE') await json(`/api/v1/meetings/${meeting.id}/leave`, 'POST', undefined, identity);
  }
});

test('health is available; data requires authentication and rejects browser origins', async () => {
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/agents`)).status, 401);
  assert.equal((await request('/api/v1/agents', 'GET', undefined, first, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/health/ready')).status, 200);
});
test('invalid JSON, oversized bodies and unknown ownership fields are rejected', async () => {
  assert.equal((await request('/api/v1/agents', 'POST', { ownerName: 'Alex', ownerId: second.ownerId, allowedTopics: ['status'] })).status, 400);
  const malformed = await fetch(`${base}/api/v1/agents`, { method: 'POST', headers: { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const large = await request('/api/v1/agents', 'POST', { ownerName: 'x'.repeat(20000), allowedTopics: ['status'] }); assert.equal(large.status, 413);
  assert.equal((await request('/api/v1/agents/not-a-uuid')).status, 400);
});
test('owner can create a delegate, dispatch, ask, inspect evidence, export and summarize', async () => {
  const { agent, fact, meeting } = await fixture(); assert.equal(agent.displayName, 'OutOfOffice');
  const response = await ask(meeting.id); assert.equal(response.kind, 'ANSWER'); assert.equal(response.text, fact.text);
  assert.equal(response.evidence[0].sourceId, fact.id);
  assert.equal((await ask(meeting.id, 'Team, what is the status?')).kind, 'IGNORE');
  const summary = await json(`/api/v1/meetings/${meeting.id}/summary`);
  assert.equal(summary.method, 'extractive'); assert.deepEqual(summary.decisions, []);
  assert.equal((await json(`/api/v1/meetings/${meeting.id}/export`)).transcript.length, 2);
});
test('all owned resources are inaccessible to a second identity', async () => {
  const { agent, fact, meeting } = await fixture();
  for (const path of [`/agents/${agent.id}`, `/agents/${agent.id}/knowledge`, `/meetings/${meeting.id}`, `/meetings/${meeting.id}/transcript`, `/meetings/${meeting.id}/summary`, `/meetings/${meeting.id}/events`, `/meetings/${meeting.id}/export`]) {
    assert.equal((await request(`/api/v1${path}`, 'GET', undefined, second)).status, 404);
  }
  assert.equal((await request(`/api/v1/meetings/${meeting.id}/mute`, 'POST', undefined, second)).status, 404);
  assert.equal((await request(`/api/v1/knowledge/${fact.id}`, 'DELETE', undefined, second)).status, 404);
  assert.equal((await request(`/api/v1/agents/${agent.id}/knowledge`, 'POST', { title: 'Bad', topic: 'project status', text: 'No.' }, second)).status, 404);
});
test('HTTP dispatch is idempotent and rejects mismatched or missing keys and hosted providers', async () => {
  const { input, meeting } = await fixture(); await json(`/api/v1/meetings/${meeting.id}/leave`, 'POST');
  const headers = { 'Idempotency-Key': 'http-retry' };
  const results = await Promise.all(Array.from({ length: 4 }, () => json('/api/v1/meetings', 'POST', input, first, headers)));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal((await request('/api/v1/meetings', 'POST', { ...input, title: 'Other' }, first, headers)).status, 409);
  assert.equal((await request('/api/v1/meetings', 'POST', input)).status, 400);
  assert.equal((await request('/api/v1/meetings', 'POST', { ...input, provider: 'attendee' }, first, headers)).status, 400);
});
test('mute/unmute invalidates old speech and permits only a fresh question', async () => {
  const { meeting } = await fixture(); const old = await ask(meeting.id);
  await json(`/api/v1/meetings/${meeting.id}/mute`, 'POST');
  assert.equal((await ask(meeting.id)).kind, 'IGNORE'); await json(`/api/v1/meetings/${meeting.id}/unmute`, 'POST');
  assert.equal((await request(`/api/v1/meetings/${meeting.id}/responses/${old.id}/audio`, 'POST')).status, 409);
  const fresh = await ask(meeting.id); const audio = await request(`/api/v1/meetings/${meeting.id}/responses/${fresh.id}/audio`, 'POST');
  assert.equal(audio.status, 200); assert.equal(audio.headers.get('x-audio-format'), 'pcm_s16le'); assert.equal((await audio.arrayBuffer()).byteLength, 4800);
  const record = await json(`/api/v1/meetings/${meeting.id}`); assert.equal(record.responses.at(-1).playbackStatus, 'TRANSMITTED');
  assert.equal((await json(`/api/v1/meetings/${meeting.id}/responses/${fresh.id}/permission`)).allowed, true);
  await json(`/api/v1/meetings/${meeting.id}/interrupt`, 'POST');
  assert.equal((await json(`/api/v1/meetings/${meeting.id}/responses/${fresh.id}/permission`)).allowed, false);
});
test('mute during HTTP audio prevents the remaining stream from being transmitted', async () => {
  voiceMode = 'long'; const { meeting } = await fixture(); const response = await ask(meeting.id);
  const audio = await request(`/api/v1/meetings/${meeting.id}/responses/${response.id}/audio`, 'POST'); assert.equal(audio.status, 200);
  await json(`/api/v1/meetings/${meeting.id}/mute`, 'POST');
  assert.ok((await audio.arrayBuffer()).byteLength < 48000);
  assert.equal((await json(`/api/v1/meetings/${meeting.id}`)).responses[0].playbackStatus, 'INTERRUPTED');
});
test('source revocation blocks pending speech and later retrieval; edits require reapproval', async () => {
  const { fact, meeting } = await fixture(); const response = await ask(meeting.id);
  const edited = await json(`/api/v1/knowledge/${fact.id}`, 'PATCH', { text: 'Validation is now complete.' }); assert.equal(edited.approved, false);
  assert.equal((await request(`/api/v1/meetings/${meeting.id}/responses/${response.id}/audio`, 'POST')).status, 409);
  await json(`/api/v1/knowledge/${fact.id}`, 'PATCH', { approved: true });
  assert.equal((await ask(meeting.id)).kind, 'DEFER');
  await json(`/api/v1/knowledge/${fact.id}`, 'DELETE'); assert.equal((await ask(meeting.id)).kind, 'DEFER');
});
test('unsupported commitments create owner follow-ups without accepting commitments', async () => {
  const { meeting } = await fixture(); const response = await ask(meeting.id, 'OutOfOffice, promise deployment tomorrow.'); assert.equal(response.kind, 'DEFER');
  const approval = (await json('/api/v1/approvals')).find((item: any) => item.meetingId === meeting.id); assert.ok(approval);
  assert.equal((await request(`/api/v1/approvals/${approval.id}/resolve`, 'POST', { answer: 'Owner response' }, second)).status, 404);
  await json(`/api/v1/approvals/${approval.id}/resolve`, 'POST', { answer: 'I need to verify the timeline.' });
  const record = await json(`/api/v1/meetings/${meeting.id}`); assert.equal(record.responses.length, 1); assert.equal(record.followUps[0].status, 'resolved');
});
test('SSE begins with an authorized snapshot and streams response events', async () => {
  const { meeting } = await fixture(); const controller = new AbortController();
  const response = await fetch(`${base}/api/v1/meetings/${meeting.id}/events`, { headers: { Authorization: `Bearer ${first.token}` }, signal: controller.signal });
  const reader = response.body!.getReader(); const initial = await reader.read(); assert.match(new TextDecoder().decode(initial.value), /event: snapshot/);
  await ask(meeting.id); const event = await reader.read(); assert.match(new TextDecoder().decode(event.value), /agent.response/);
  controller.abort(); await reader.cancel().catch(() => undefined);
});
test('owner data deletion stops the worker and preserves consumed usage', async () => {
  const { meeting } = await fixture(); await ask(meeting.id);
  const beforeUsage = await json('/api/v1/usage'); await json(`/api/v1/meetings/${meeting.id}`, 'DELETE');
  assert.equal((await request(`/api/v1/meetings/${meeting.id}`)).status, 404);
  const usage = await json('/api/v1/usage'); assert.equal(usage.reservedSeconds, 0); assert.ok(usage.actualSeconds >= beforeUsage.actualSeconds);
});
test('deleting an agent revokes and deletes its meetings and knowledge under the owner scope', async () => {
  const { agent, meeting } = await fixture();
  assert.equal((await request(`/api/v1/agents/${agent.id}`, 'DELETE', undefined, second)).status, 404);
  await json(`/api/v1/agents/${agent.id}`, 'DELETE');
  assert.equal((await request(`/api/v1/agents/${agent.id}`)).status, 404);
  assert.equal((await request(`/api/v1/meetings/${meeting.id}`)).status, 404);
  assert.equal((await json('/api/v1/usage')).reservedSeconds, 0);
});
