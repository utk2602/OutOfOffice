import type { Agent, Decision, Fact, Meeting, UtteranceInput } from '@outofoffice/shared';

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const includesPhrase = (text: string, phrase: string) => (` ${normalize(text)} `).includes(` ${normalize(phrase)} `);
const stopWords = new Set('the a an is are was were of on to for in and or with my your his her their our what how when where can could please share give tell me us about any does do has have there update status project work current latest today'.split(' '));
const words = (value: string) => normalize(value).split(' ').filter(word => word.length > 2 && !stopWords.has(word)).map(word => word.replace(/s$/, ''));
const deferred = (reason: string): Decision => ({
  kind: 'DEFER', reason,
  text: "I don't have approved information or authority to answer that. I'll leave it for my owner to follow up.",
  evidence: [],
});
const ignore = (reason: string): Decision => ({ kind: 'IGNORE', reason, text: null, evidence: [] });

export type TurnContext = {
  agent: Agent; meeting: Meeting; facts: Fact[]; utterance: UtteranceInput; now: number;
};

/** Conservative routing: only an explicit salutation at the start claims the floor. */
export function isAddressed(text: string, name: string): boolean {
  const names = [name, 'AI delegate'].map(escape).join('|');
  return new RegExp(`^(?:(?:hey|hi|hello|okay|ok)\\s+)?(?:${names})(?=[\\s,:?!]|$)`, 'i').test(text.trim());
}

export function eligibleFacts(context: TurnContext): Fact[] {
  const { meeting, agent, facts, now } = context;
  if (meeting.ownerId !== agent.ownerId || meeting.agentId !== agent.id) return [];
  return facts.filter(fact => fact.ownerId === meeting.ownerId && fact.agentId === agent.id &&
    meeting.sourceIds.includes(fact.id) && fact.approved && fact.sensitivity === 'MEETING' &&
    (!fact.validUntil || Date.parse(fact.validUntil) > now) &&
    agent.allowedTopics.some(topic => normalize(topic) === normalize(fact.topic)) &&
    !agent.prohibitedTopics.some(topic => includesPhrase(`${fact.topic} ${fact.title} ${fact.text}`, topic)));
}

/** No model invents the wording: output is verbatim from the approved, scoped facts. */
export function decideTurn(context: TurnContext): Decision {
  const { meeting, agent, utterance, now } = context;
  if (meeting.status !== 'ACTIVE' || meeting.speechState !== 'READY' ||
      now >= Date.parse(meeting.startedAt) + meeting.maxDurationSeconds * 1000) return ignore('SPEECH_BLOCKED');
  if (utterance.origin === 'delegate') return ignore('OWN_OUTPUT');
  if (!isAddressed(utterance.text, agent.displayName)) return ignore('NOT_ADDRESSED');
  const question = utterance.text;
  if (agent.prohibitedTopics.some(topic => includesPhrase(question, topic))) return deferred('RESTRICTED_TOPIC');
  if (/\b(ignore|override|forget|bypass)\b.*\b(rule|instruction|policy|previous|system|approval)s?\b|\bsystem prompt\b|\bpretend\b|\brepeat (?:exactly|after me)\b/i.test(question)) return deferred('UNTRUSTED_INSTRUCTION');
  if (/\b(password|credential|secret|private|confidential)\b/i.test(question)) return deferred('RESTRICTED_REQUEST');
  if (/\b(promise|guarantee|commit|pledge|approve|authorize|agree|accept|schedule|send|delete|change)\b|\bupdate (?:the|my|our|your|a)\b/i.test(question) ||
      /\b(can|could|will|would)\b.{0,50}\b(deliver|ship|deploy|finish|release)\b/i.test(question)) return deferred('COMMITMENT_OR_ACTION');
  if (!/\?|\b(what|how|when|where|why|which|who|can|could|would|share|tell|give|report|any|is|are|do|did)\b/i.test(question)) return deferred('INCOMPLETE_QUESTION');

  const facts = eligibleFacts(context);
  const identityWords = new Set(words(`${agent.displayName} ${agent.ownerName} AI delegate hey hi hello okay ok`));
  const queryWords = new Set(words(question).filter(word => !identityWords.has(word)));
  const ranked = facts.map(fact => ({ fact, score: words(`${fact.topic} ${fact.title}`).filter(word => queryWords.has(word)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt));
  // A generic update is allowed only for the explicitly approved project-status topic.
  const selected = ranked.length ? ranked.filter(item => item.score === ranked[0]!.score).map(item => item.fact).slice(0, 2) :
    /\b(update|status)\b/i.test(question) && queryWords.size === 0 ? facts.filter(fact => normalize(fact.topic) === 'project status').slice(0, 2) : [];
  if (!selected.length) return deferred('NO_APPROVED_EVIDENCE');
  for (const fact of selected) {
    if (facts.some(other => other.id !== fact.id && normalize(other.title) === normalize(fact.title) && other.text !== fact.text)) return deferred('CONFLICTING_EVIDENCE');
    if (fact.text.length > 600) return deferred('FACT_TOO_LONG');
  }
  const answer = [...new Set(selected.map(fact => fact.text))].join(' ');
  if (answer.length > 900) return deferred('FACT_TOO_LONG');
  return {
    kind: 'ANSWER', reason: 'APPROVED_EVIDENCE', text: answer,
    evidence: selected.map(fact => ({ sourceId: fact.id, version: fact.version, title: fact.title, excerpt: fact.text, updatedAt: fact.updatedAt })),
  };
}

export type PlaybackPermit = Readonly<{
  epoch: number; grantVersion: number; expiresAt: number; sourceVersions: Readonly<Record<string, number>>;
}>;

/** A permit is checked on every audio frame, never just at generation start. */
export class PlaybackGate {
  private epoch = 0;
  private grantVersion = 1;
  private state: 'READY' | 'MUTED' | 'CLOSED' = 'READY';
  constructor(private readonly expiresAt: number, private readonly clock: () => number = Date.now) {}
  begin(sourceVersions: Record<string, number> = {}): PlaybackPermit | null {
    this.interrupt();
    if (this.state !== 'READY' || this.clock() >= this.expiresAt) return null;
    return Object.freeze({ epoch: this.epoch, grantVersion: this.grantVersion, expiresAt: this.expiresAt, sourceVersions: Object.freeze({ ...sourceVersions }) });
  }
  allows(permit: PlaybackPermit, currentSourceVersions: Record<string, number> = {}): boolean {
    return this.state === 'READY' && this.clock() < Math.min(this.expiresAt, permit.expiresAt) &&
      permit.epoch === this.epoch && permit.grantVersion === this.grantVersion &&
      Object.entries(permit.sourceVersions).every(([id, version]) => currentSourceVersions[id] === version);
  }
  interrupt(): void { this.epoch++; }
  mute(): void { this.state = 'MUTED'; this.interrupt(); }
  unmute(): void { if (this.state !== 'CLOSED') { this.state = 'READY'; this.interrupt(); } }
  revoke(): void { this.state = 'CLOSED'; this.grantVersion++; this.interrupt(); }
  get currentEpoch(): number { return this.epoch; }
}
