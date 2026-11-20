import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Database, RecordStore, StoreError } from '../src/index.ts';
import { agentInputSchema, factInputSchema, type MeetingInput } from '@outofoffice/shared';

let db: Database;
let now = Date.now();
const limits = { budgetSeconds: 120, maxMeetingSeconds: 900, maxConcurrentMeetings: 2 };
let store: RecordStore;
before(async () => { db = await Database.open(); store = new RecordStore(db, limits, () => now); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.query('TRUNCATE owners CASCADE'); now = Date.now(); });
async function owner() {
  const id = randomUUID(); await store.ensureOwner(id);
  const agent = await store.createAgent(id, agentInputSchema.parse({ ownerName: 'Alex', allowedTopics: ['project status'] }));
  const fact = await store.createFact(id, agent.id, factInputSchema.parse({ title: 'Reconciliation', topic: 'project status', text: 'Validation is pending.', approved: true, sensitivity: 'MEETING' }));
  const input: MeetingInput = { agentId: agent.id, title: 'Local standup', provider: 'local', maxDurationSeconds: 60, sourceIds: [fact.id], ownerAuthorized: true };
  return { id, agent, fact, input };
}
const errorCode = (code: string) => (error: unknown) => error instanceof StoreError && error.code === code;

test('hosted dispatch atomically creates a muted attempt and retains its reservation after restart', async () => {
  const user = await owner();
  const result = await store.dispatch(user.id, { ...user.input, provider: 'attendee', meetingUrl: 'https://meet.google.com/abc-defg-hij', participantsConsented: true, providerDataAccepted: true }, 'hosted');
  const id = result.record.meeting.id;
  assert.equal(result.record.meeting.speechState, 'MUTED');
  const attempt = await store.getAttempt(user.id, id); assert.equal(attempt.state, 'PREPARED');
  attempt.state = 'UNCERTAIN'; await store.updateAttempt(attempt);
  now += 1000; await store.recoverInterrupted();
  assert.equal((await store.usage(user.id)).reservedSeconds, 60);
  await assert.rejects(store.deleteMeeting(user.id, id), errorCode('PROVIDER_DATA_PENDING'));
  await assert.rejects(store.deleteAgent(user.id, user.agent.id), errorCode('PROVIDER_DATA_PENDING'));
  const other = await owner(); await assert.rejects(store.dispatch(other.id, other.input, 'other'), errorCode('HOSTED_ATTEMPT_PENDING'));
  attempt.state = 'ENDED'; attempt.providerState = 'ended'; attempt.deletion = 'confirmed'; await store.updateAttempt(attempt);
  await store.saveRecord(user.id, await store.getRecord(user.id, id));
  assert.equal((await store.usage(user.id)).actualSeconds, 60);
  assert.equal((await store.usage(user.id)).reservedSeconds, 0);
  await store.deleteMeeting(user.id, id);
  assert.equal((await store.usage(user.id)).actualSeconds, 60);
});
test('provider attempts reject cross-owner access, identity changes and terminal reopening', async () => {
  const user = await owner(); const other = await owner();
  const { record } = await store.dispatch(user.id, { ...user.input, provider: 'attendee', meetingUrl: 'https://meet.google.com/abc-defg-hij', participantsConsented: true, providerDataAccepted: true }, 'pinned');
  await assert.rejects(store.getAttempt(other.id, record.meeting.id), errorCode('NOT_FOUND'));
  const attempt = await store.getAttempt(user.id, record.meeting.id); attempt.botId = 'bot_123'; await store.updateAttempt(attempt);
  await assert.rejects(store.updateAttempt({ ...attempt, botId: 'bot_other' }), errorCode('BOT_ID_CONFLICT'));
  attempt.state = 'ENDED'; await store.updateAttempt(attempt);
  await assert.rejects(store.updateAttempt({ ...attempt, state: 'TRACKING' }), errorCode('TERMINAL_STATE'));
});
test('hosted usage cap survives local content deletion', async () => {
  const user = await owner(); const bounded = new RecordStore(db, { ...limits, hostedBudgetSeconds: 60 }, () => now);
  const input: MeetingInput = { ...user.input, provider: 'attendee', meetingUrl: 'https://meet.google.com/abc-defg-hij', participantsConsented: true, providerDataAccepted: true };
  const { record } = await bounded.dispatch(user.id, input, 'first-hosted');
  const attempt = await bounded.getAttempt(user.id, record.meeting.id); attempt.state = 'ENDED'; attempt.providerState = 'ended'; attempt.deletion = 'confirmed'; await bounded.updateAttempt(attempt);
  record.meeting.status = 'COMPLETED'; record.meeting.endedAt = new Date(now).toISOString(); await bounded.saveRecord(user.id, record);
  await bounded.deleteMeeting(user.id, record.meeting.id);
  await assert.rejects(bounded.dispatch(user.id, input, 'next-hosted'), errorCode('HOSTED_BUDGET_EXHAUSTED'));
});

test('concurrent identical dispatch reserves usage once and returns one meeting', async () => {
  const user = await owner();
  const results = await Promise.all(Array.from({ length: 5 }, () => store.dispatch(user.id, user.input, 'once')));
  assert.equal(new Set(results.map(result => result.record.meeting.id)).size, 1);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal((await store.usage(user.id)).reservedSeconds, 60);
});
test('idempotency mismatches and a second active meeting are rejected', async () => {
  const user = await owner(); await store.dispatch(user.id, user.input, 'one');
  await assert.rejects(store.dispatch(user.id, { ...user.input, title: 'Other' }, 'one'), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(store.dispatch(user.id, user.input, 'two'), errorCode('ACTIVE_MEETING'));
});
test('two tenants cannot reserve beyond the global budget', async () => {
  const first = await owner(); const second = await owner();
  await store.dispatch(first.id, { ...first.input, maxDurationSeconds: 90 }, 'first');
  await assert.rejects(store.dispatch(second.id, second.input, 'second'), errorCode('BUDGET_EXHAUSTED'));
  assert.equal((await store.usage(second.id)).reservedSeconds, 0);
});
test('invalid or private evidence rolls back dispatch and the reservation', async () => {
  const user = await owner(); await store.updateFact(user.id, user.fact.id, factInputSchema.parse({ title: user.fact.title, topic: user.fact.topic, text: user.fact.text, approved: false, sensitivity: 'PRIVATE' }));
  await assert.rejects(store.dispatch(user.id, user.input, 'private'), errorCode('SOURCE_NOT_APPROVED'));
  assert.equal((await store.listMeetings(user.id)).length, 0); assert.equal((await store.usage(user.id)).reservedSeconds, 0);
});
test('tenant scope is checked for agents, facts and meetings and enforced by foreign keys', async () => {
  const first = await owner(); const second = await owner();
  await assert.rejects(store.getAgent(second.id, first.agent.id), errorCode('NOT_FOUND'));
  await assert.rejects(store.getFact(second.id, first.fact.id), errorCode('NOT_FOUND'));
  await assert.rejects(store.createFact(second.id, first.agent.id, factInputSchema.parse({ title: 'Bad', topic: 'project status', text: 'No.' })), errorCode('NOT_FOUND'));
  const { record } = await store.dispatch(first.id, first.input, 'meeting');
  await assert.rejects(store.getRecord(second.id, record.meeting.id), errorCode('NOT_FOUND'));
  await assert.rejects(db.query('INSERT INTO meeting_sources(meeting_id,owner_id,source_id,source_version) VALUES ($1,$2,$3,1)', [record.meeting.id, first.id, second.fact.id]));
});
test('ending a session settles usage; deleting its content cannot refund consumed time', async () => {
  const user = await owner(); const { record } = await store.dispatch(user.id, user.input, 'usage');
  now += 21_000; record.meeting.status = 'COMPLETED'; record.meeting.endedAt = new Date(now).toISOString();
  record.meeting.speechState = 'BLOCKED'; await store.saveRecord(user.id, record);
  assert.equal((await store.usage(user.id)).actualSeconds, 21); assert.equal((await store.usage(user.id)).reservedSeconds, 0);
  await store.deleteMeeting(user.id, record.meeting.id);
  assert.equal((await store.usage(user.id)).actualSeconds, 21);
  await assert.rejects(store.getRecord(user.id, record.meeting.id), errorCode('NOT_FOUND'));
});
test('restart blocks interrupted sessions and settles reservations conservatively', async () => {
  const user = await owner(); const { record } = await store.dispatch(user.id, user.input, 'restart');
  now += 5000; await store.recoverInterrupted();
  const recovered = await store.getRecord(user.id, record.meeting.id);
  assert.equal(recovered.meeting.status, 'DISCONNECTED'); assert.equal(recovered.meeting.speechState, 'BLOCKED');
  assert.equal((await store.usage(user.id)).actualSeconds, 5);
  await assert.rejects(store.saveRecord(user.id, record), errorCode('TERMINAL_STATE'));
});
test('fact versions advance and active meeting deletion is rejected', async () => {
  const user = await owner();
  const updated = await store.updateFact(user.id, user.fact.id, factInputSchema.parse({ title: user.fact.title, topic: user.fact.topic, text: 'Updated validation.' }));
  assert.equal(updated.version, 2);
  await store.updateFact(user.id, user.fact.id, factInputSchema.parse({ title: user.fact.title, topic: user.fact.topic, text: 'Updated validation.', approved: true, sensitivity: 'MEETING' }));
  const { record } = await store.dispatch(user.id, user.input, 'active');
  await assert.rejects(store.deleteMeeting(user.id, record.meeting.id), errorCode('MEETING_ACTIVE'));
});
test('embedded PostgreSQL retains documents across a clean close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outofoffice-db-'));
  let disk: Database | undefined;
  try {
    disk = await Database.open({ directory }); const local = new RecordStore(disk, limits);
    const id = randomUUID(); await local.ensureOwner(id);
    const agent = await local.createAgent(id, agentInputSchema.parse({ ownerName: 'Alex', allowedTopics: ['project status'] }));
    await disk.close(); disk = await Database.open({ directory });
    assert.equal((await new RecordStore(disk, limits).getAgent(id, agent.id)).displayName, 'OutOfOffice');
  } finally {
    await disk?.close();
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('outofoffice-db-')) throw new Error('Unsafe temporary cleanup target.');
    await rm(target, { recursive: true, force: true });
  }
});
test('retention removes old meeting content while preserving the usage ledger', async () => {
  const user = await owner(); const { record } = await store.dispatch(user.id, user.input, 'retention');
  now += 10_000; record.meeting.status = 'COMPLETED'; record.meeting.speechState = 'BLOCKED';
  record.meeting.endedAt = new Date(now).toISOString(); await store.saveRecord(user.id, record);
  now += 31 * 86400_000; await store.pruneRetention();
  await assert.rejects(store.getRecord(user.id, record.meeting.id), errorCode('NOT_FOUND'));
  assert.equal((await store.usage(user.id)).actualSeconds, 10);
});
