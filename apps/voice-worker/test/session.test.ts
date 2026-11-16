import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, SessionError, type SpeechSynthesizer } from '../src/index.ts';
import { tone, type AudioSink } from '@outofoffice/voice-sdk';
import type { Agent, Fact, Meeting, UtteranceInput } from '@outofoffice/shared';

const now = Date.now();
const agent: Agent = { id: 'agent', ownerId: 'owner', displayName: 'OutOfOffice', ownerName: 'Alex', allowedTopics: ['project status'], prohibitedTopics: ['salary'], createdAt: new Date(now).toISOString() };
const fact: Fact = { id: 'fact', ownerId: 'owner', agentId: 'agent', title: 'Reconciliation', topic: 'project status', text: 'Implementation is complete. Validation is pending.', approved: true, sensitivity: 'MEETING', validUntil: null, updatedAt: new Date(now).toISOString(), version: 1 };
const meeting: Meeting = { id: 'meeting', ownerId: 'owner', agentId: 'agent', title: 'Standup', provider: 'local', status: 'ACTIVE', speechState: 'READY', sourceIds: ['fact'], maxDurationSeconds: 300, startedAt: new Date(now).toISOString(), endedAt: null, grantVersion: 1, epoch: 0, idempotencyKey: 'test' };
const utterance = (text = 'OutOfOffice, what is the reconciliation status?', eventId = 'turn'): UtteranceInput => ({ eventId, speaker: 'Sam', text, origin: 'participant' });
const synthesizer: SpeechSynthesizer = { async *synthesize(_text, signal) { signal.throwIfAborted(); yield tone(24000, 100); } };
const sink: AudioSink = { send: async (_frame, signal) => { signal.throwIfAborted(); }, flush: async () => 'confirmed' };

test('session routes approved text through packetization and paced playback exactly once', async () => {
  const session = new VoiceSession(agent, meeting, [fact]);
  const response = session.receive(utterance()); assert.equal(response.text, fact.text);
  let spoken = ''; const result = await session.speak(response.id, { async *synthesize(text) { spoken = text; yield tone(24000, 60); } }, sink);
  assert.equal(result.sentFrames, 3); assert.equal(result.reason, 'completed'); assert.equal(spoken, fact.text);
  assert.equal(session.snapshot().responses[0]?.playbackStatus, 'TRANSMITTED');
  await assert.rejects(session.speak(response.id, synthesizer, sink), SessionError);
});
test('duplicate event returns its decision without taking the floor or generating again', () => {
  const session = new VoiceSession(agent, meeting, [fact]); const response = session.receive(utterance());
  assert.deepEqual(session.receive(utterance()), response);
  assert.equal(session.snapshot().transcript.length, 1);
  assert.throws(() => session.receive(utterance('different question')), SessionError);
});
test('unrelated participant speech cancels pending output; duplicate and bot echo do not', async () => {
  const session = new VoiceSession(agent, meeting, [fact]); const response = session.receive(utterance());
  const ignored = session.receive(utterance('Team, can we move on?', 'other')); assert.equal(ignored.kind, 'IGNORE');
  await assert.rejects(session.speak(response.id, synthesizer, sink), SessionError);
  const fresh = session.receive(utterance(undefined, 'fresh'));
  session.receive({ ...utterance('I am the AI delegate.', 'echo'), origin: 'delegate' });
  assert.equal((await session.speak(fresh.id, synthesizer, sink)).reason, 'completed');
});
for (const control of ['mute', 'interrupt', 'end', 'replaceFacts'] as const) {
  test(`${control} during transmission stops remaining frames`, async () => {
    const session = new VoiceSession(agent, meeting, [fact]); const response = session.receive(utterance()); let count = 0;
    const result = await session.speak(response.id, synthesizer, { ...sink, send: async () => {
      count++; if (control === 'replaceFacts') session.replaceFacts([{ ...fact, approved: false }]); else session[control]();
    } });
    assert.equal(count, 1); assert.notEqual(result.reason, 'completed');
    assert.equal(session.snapshot().responses[0]?.playbackStatus, 'INTERRUPTED');
  });
}
test('mute and unmute discard old speech; a fresh question can answer', async () => {
  const session = new VoiceSession(agent, meeting, [fact]); const response = session.receive(utterance());
  session.mute(); assert.equal(session.receive(utterance(undefined, 'muted')).kind, 'IGNORE'); session.unmute();
  await assert.rejects(session.speak(response.id, synthesizer, sink), SessionError);
  assert.equal(session.receive(utterance(undefined, 'new')).kind, 'ANSWER');
});
test('changed facts cannot silently acquire the original meeting grant', () => {
  const session = new VoiceSession(agent, meeting, [fact]);
  session.replaceFacts([{ ...fact, version: 2, text: 'A new statement.' }]);
  assert.equal(session.receive(utterance()).reason, 'NO_APPROVED_EVIDENCE');
});
test('follow-up resolution never creates speech or a new response', () => {
  const session = new VoiceSession(agent, meeting, [fact]); session.receive(utterance('OutOfOffice, promise delivery tomorrow.'));
  const followUp = session.snapshot().followUps[0]!; session.resolveFollowUp(followUp.id, 'I will check.');
  assert.equal(session.snapshot().followUps[0]?.status, 'resolved'); assert.equal(session.snapshot().responses.length, 1);
});
test('expiry terminates the session and terminal status cannot reopen', () => {
  let clock = now; const session = new VoiceSession(agent, meeting, [fact], () => clock);
  clock += 300_000; assert.equal(session.snapshot().meeting.status, 'EXPIRED');
  assert.throws(() => session.receive(utterance()), SessionError); assert.throws(() => session.unmute(), SessionError);
  session.end('COMPLETED'); assert.equal(session.snapshot().meeting.status, 'EXPIRED');
});
test('a synthesizer stalled before its first chunk can be cancelled', async () => {
  const session = new VoiceSession(agent, meeting, [fact]); const response = session.receive(utterance());
  const pending = session.speak(response.id, { async *synthesize() { await new Promise(() => {}); yield Buffer.alloc(960); } }, sink);
  session.mute(); assert.notEqual((await pending).reason, 'completed');
});
test('caller mutations cannot change session ownership, evidence or output', () => {
  const current = structuredClone(fact); const source = structuredClone(agent);
  const session = new VoiceSession(source, meeting, [current]); current.text = 'tampered'; source.allowedTopics = [];
  assert.equal(session.receive(utterance()).text, fact.text);
  const snapshot = session.snapshot(); snapshot.meeting.speechState = 'BLOCKED'; assert.equal(session.snapshot().meeting.speechState, 'READY');
});
test('a speech adapter startup failure releases the active operation', async () => {
  const session = new VoiceSession(agent, meeting, [fact]); const response = session.receive(utterance());
  await assert.rejects(session.speak(response.id, { synthesize() { throw new Error('Unavailable'); } }, sink), SessionError);
  assert.equal(session.snapshot().responses[0]?.playbackStatus, 'FAILED');
  const next = session.receive(utterance(undefined, 'retry'));
  assert.equal((await session.speak(next.id, synthesizer, sink)).reason, 'completed');
});
