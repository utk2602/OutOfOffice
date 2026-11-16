import { readFile } from 'node:fs/promises';
import { decideTurn, type TurnContext } from '../packages/agent-core/src/index.ts';
import type { DecisionKind } from '../packages/shared/src/index.ts';

type Mode = 'private' | 'expired' | 'other-owner' | 'ungranted' | 'conflict' | 'muted' | 'revoked' | 'bot-echo';
const cases = JSON.parse(await readFile(new URL('../fixtures/agent-evaluation.json', import.meta.url), 'utf8')) as Array<{ question: string; expected: DecisionKind; mode?: Mode }>;
const now = Date.parse('2026-11-17T09:00:00Z');
const base: TurnContext = {
  now,
  agent: { id: 'agent', ownerId: 'owner', displayName: 'OutOfOffice', ownerName: 'Alex', allowedTopics: ['project status', 'blockers'], prohibitedTopics: ['salary'], createdAt: new Date(now).toISOString() },
  meeting: { id: 'meeting', ownerId: 'owner', agentId: 'agent', title: 'Evaluation standup', provider: 'local', status: 'ACTIVE', speechState: 'READY', sourceIds: ['status', 'blockers'], maxDurationSeconds: 300, startedAt: new Date(now).toISOString(), endedAt: null, grantVersion: 1, epoch: 0, idempotencyKey: 'evaluation' },
  facts: [
    { id: 'status', ownerId: 'owner', agentId: 'agent', title: 'Reconciliation', topic: 'project status', text: 'The implementation is complete. Validation is pending; no delivery date is confirmed.', approved: true, sensitivity: 'MEETING', validUntil: null, version: 1, updatedAt: new Date(now).toISOString() },
    { id: 'blockers', ownerId: 'owner', agentId: 'agent', title: 'Staging blockers', topic: 'blockers', text: 'Access to the synthetic staging environment is blocked.', approved: true, sensitivity: 'MEETING', validUntil: null, version: 1, updatedAt: new Date(now).toISOString() },
  ],
  utterance: { eventId: 'evaluation', speaker: 'Sam', text: '', origin: 'participant' },
};
let passed = 0; let answers = 0; let supported = 0;
const failures: Array<{ question: string; mode: string; expected: string; actual: string; reason: string }> = [];
for (const item of cases) {
  const context = structuredClone(base); context.utterance.text = item.question;
  const fact = context.facts[0]!;
  switch (item.mode) {
    case 'private': fact.sensitivity = 'PRIVATE'; break;
    case 'expired': fact.validUntil = new Date(now - 1).toISOString(); break;
    case 'other-owner': fact.ownerId = 'other'; break;
    case 'ungranted': context.meeting.sourceIds = ['blockers']; break;
    case 'conflict': context.facts.push({ ...fact, id: 'contradiction', text: 'Implementation is incomplete.' }); context.meeting.sourceIds.push('contradiction'); break;
    case 'muted': context.meeting.speechState = 'MUTED'; break;
    case 'revoked': context.meeting.status = 'REVOKED'; break;
    case 'bot-echo': context.utterance.origin = 'delegate'; break;
  }
  const decision = decideTurn(context);
  if (decision.kind === item.expected) passed++;
  else failures.push({ question: item.question, mode: item.mode ?? 'normal', expected: item.expected, actual: decision.kind, reason: decision.reason });
  if (decision.kind === 'ANSWER') {
    answers++;
    const facts = decision.evidence.map(evidence => context.facts.find(source => source.id === evidence.sourceId && source.version === evidence.version));
    if (facts.every(source => source?.approved && source.sensitivity === 'MEETING' && source.ownerId === context.meeting.ownerId && context.meeting.sourceIds.includes(source.id)) &&
        decision.text === [...new Set(facts.map(source => source!.text))].join(' ')) supported++;
  }
}
console.log(JSON.stringify({ corpus: 'synthetic local policy scenarios', cases: cases.length, passed, answers, supportedAnswers: supported,
  routingAccuracy: passed / cases.length, evidenceSupport: answers ? supported / answers : null, failures,
  limitation: 'Small deterministic regression corpus; not a measurement of live-meeting accuracy, ASR accuracy or general language understanding.' }, null, 2));
if (passed !== cases.length || supported !== answers || answers === 0) process.exitCode = 1;
