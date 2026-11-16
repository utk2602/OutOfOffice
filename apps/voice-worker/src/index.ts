import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { decideTurn, eligibleFacts, PlaybackGate, type PlaybackPermit } from '@outofoffice/agent-core';
import { utteranceInputSchema, type Agent, type Fact, type Meeting, type MeetingStatus,
  type ResponseRecord, type SessionRecord, type UtteranceInput } from '@outofoffice/shared';
import { AudioPlayback, PcmPacketizer, type AudioSink, type PlaybackResult } from '@outofoffice/voice-sdk';

export interface SpeechSynthesizer {
  /** Only approved text is supplied. Yield raw 24 kHz PCM16 mono chunks of at most 200 ms. */
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Buffer>;
}

export class SessionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** One in-process owner per meeting. All public reads are snapshots. */
export class VoiceSession {
  private readonly gate: PlaybackGate;
  private readonly permits = new Map<string, PlaybackPermit>();
  private readonly grantSources: Record<string, number>;
  private readonly record: SessionRecord;
  private facts: Fact[];
  private operation: { responseId: string; playback: AudioPlayback; abort: AbortController } | undefined;
  constructor(private readonly agent: Agent, meeting: Meeting, facts: Fact[], private readonly clock: () => number = Date.now) {
    if (agent.id !== meeting.agentId || agent.ownerId !== meeting.ownerId) throw new SessionError('INVALID_OWNER', 'Meeting owner mismatch.');
    this.agent = structuredClone(agent);
    this.record = { meeting: structuredClone(meeting), transcript: [], responses: [], followUps: [] };
    this.facts = structuredClone(facts);
    this.grantSources = Object.fromEntries(facts.filter(fact => meeting.sourceIds.includes(fact.id)).map(fact => [fact.id, fact.version]));
    this.gate = new PlaybackGate(Date.parse(meeting.startedAt) + meeting.maxDurationSeconds * 1000, clock);
    if (meeting.status !== 'ACTIVE') this.gate.revoke();
    else if (meeting.speechState !== 'READY') this.gate.mute();
  }
  snapshot(): SessionRecord { this.expire(); return structuredClone(this.record); }
  private scopedFacts(): Fact[] { return this.facts.filter(fact => this.grantSources[fact.id] === fact.version); }
  private currentSources(): Record<string, number> {
    const context = { agent: this.agent, meeting: this.record.meeting, facts: this.scopedFacts(), now: this.clock(),
      utterance: { eventId: 'check', speaker: 'owner', text: 'check', origin: 'participant' as const } };
    return Object.fromEntries(eligibleFacts(context).map(fact => [fact.id, fact.version]));
  }
  private expire(): void {
    const meeting = this.record.meeting;
    if (meeting.status === 'ACTIVE' && this.clock() >= Date.parse(meeting.startedAt) + meeting.maxDurationSeconds * 1000) this.end('EXPIRED');
  }
  receive(input: UtteranceInput): ResponseRecord {
    const utterance = utteranceInputSchema.parse(input);
    const previous = this.record.responses.find(response => response.eventId === utterance.eventId);
    if (previous) {
      const entry = this.record.transcript.find(turn => turn.eventId === utterance.eventId)!;
      if (entry.text !== utterance.text || entry.speaker !== utterance.speaker || entry.origin !== utterance.origin) {
        throw new SessionError('EVENT_CONFLICT', 'The event ID was already used for a different utterance.');
      }
      return structuredClone(previous);
    }
    this.expire();
    if (this.record.meeting.status !== 'ACTIVE') throw new SessionError('MEETING_ENDED', 'The meeting is no longer active.');
    if (this.record.transcript.length >= 1000 || this.record.transcript.reduce((total, turn) => total + turn.text.length, 0) + utterance.text.length > 200_000) {
      this.end('COMPLETED'); throw new SessionError('TRANSCRIPT_LIMIT', 'The local meeting transcript limit was reached.');
    }
    // A genuine participant turn yields the floor even when it is unrelated to the delegate.
    if (utterance.origin === 'participant') this.interrupt();
    const decision = decideTurn({ agent: this.agent, meeting: this.record.meeting, facts: this.scopedFacts(), utterance, now: this.clock() });
    const permit = decision.text ? this.gate.begin(Object.fromEntries(decision.evidence.map(source => [source.sourceId, source.version]))) : null;
    const response: ResponseRecord = {
      ...decision, id: randomUUID(), meetingId: this.record.meeting.id, eventId: utterance.eventId,
      speaker: utterance.speaker, question: utterance.text, epoch: this.gate.currentEpoch,
      grantVersion: this.record.meeting.grantVersion, createdAt: new Date(this.clock()).toISOString(),
      playbackStatus: permit ? 'AUTHORIZED' : 'NOT_SPOKEN',
    };
    this.record.meeting.epoch = this.gate.currentEpoch;
    this.record.transcript.push({ ...utterance, receivedAt: response.createdAt });
    this.record.responses.push(response);
    if (permit) this.permits.set(response.id, permit);
    if (decision.kind === 'DEFER') this.record.followUps.push({ id: randomUUID(), meetingId: response.meetingId,
      responseId: response.id, question: utterance.text, reason: decision.reason, status: 'pending', ownerResponse: null });
    return structuredClone(response);
  }
  interrupt(): void {
    this.gate.interrupt();
    if (this.operation) {
      const active = this.record.responses.find(response => response.id === this.operation!.responseId);
      if (active) active.playbackStatus = 'INTERRUPTED';
      this.operation.abort.abort(); this.operation.playback.cancel();
    }
    for (const response of this.record.responses) if (response.playbackStatus === 'AUTHORIZED') response.playbackStatus = 'CANCELLED';
    this.permits.clear(); this.record.meeting.epoch = this.gate.currentEpoch;
  }
  mute(): void { this.interrupt(); this.gate.mute(); this.record.meeting.speechState = this.record.meeting.status === 'ACTIVE' ? 'MUTED' : 'BLOCKED'; this.record.meeting.epoch = this.gate.currentEpoch; }
  unmute(): void {
    this.expire();
    if (this.record.meeting.status !== 'ACTIVE') throw new SessionError('MEETING_ENDED', 'An ended meeting cannot be unmuted.');
    this.interrupt(); this.gate.unmute(); this.record.meeting.speechState = 'READY'; this.record.meeting.epoch = this.gate.currentEpoch;
  }
  end(status: Exclude<MeetingStatus, 'ACTIVE'> = 'COMPLETED'): void {
    if (this.record.meeting.status !== 'ACTIVE') return;
    this.interrupt(); this.gate.revoke(); this.record.meeting.status = status;
    this.record.meeting.speechState = 'BLOCKED'; this.record.meeting.grantVersion++;
    this.record.meeting.endedAt = new Date(this.clock()).toISOString(); this.record.meeting.epoch = this.gate.currentEpoch;
  }
  replaceFacts(facts: Fact[]): void { this.interrupt(); this.facts = structuredClone(facts); }
  resolveFollowUp(id: string, text: string | null): void {
    const followUp = this.record.followUps.find(item => item.id === id);
    if (!followUp) throw new SessionError('NOT_FOUND', 'Follow-up not found.');
    followUp.status = text ? 'resolved' : 'dismissed'; followUp.ownerResponse = text;
    // Recording the owner's answer never grants a speaking permit.
  }
  async speak(responseId: string, synthesizer: SpeechSynthesizer, sink: AudioSink): Promise<PlaybackResult> {
    this.expire();
    const response = this.record.responses.find(item => item.id === responseId);
    const permit = this.permits.get(responseId);
    if (!response?.text || response.playbackStatus !== 'AUTHORIZED' || !permit || !this.gate.allows(permit, this.currentSources()) || this.operation) {
      throw new SessionError('SPEECH_BLOCKED', 'This response no longer has permission to speak.');
    }
    this.permits.delete(responseId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Speech generation timed out.')), 30_000);
    const playback = new AudioPlayback({ meetingId: response.meetingId, generationId: response.id, sampleRateHz: 24000,
      gate: this.gate, permit, sink, currentSources: () => this.currentSources(), idleTimeoutMs: 15_000 });
    this.operation = { responseId, playback, abort: controller };
    let iterator: AsyncIterator<Buffer>;
    try { iterator = synthesizer.synthesize(response.text, controller.signal)[Symbol.asyncIterator](); }
    catch {
      clearTimeout(timeout); controller.abort(); playback.cancel(); this.operation = undefined;
      response.playbackStatus = 'FAILED';
      throw new SessionError('SYNTHESIS_FAILED', 'The speech adapter could not start.');
    }
    const pump = async () => {
      const packetizer = new PcmPacketizer({ meetingId: response.meetingId, streamId: response.id,
        sampleRateHz: 24000, timestampMs: 0, generationId: response.id });
      const enqueue = async (pcm: Buffer) => {
        for (const frame of packetizer.push(pcm)) {
          while (playback.bufferedMs >= 100) await delay(5, undefined, { signal: controller.signal });
          controller.signal.throwIfAborted(); if (!playback.push(frame)) throw new Error('Playback closed.');
        }
      };
      try {
        while (true) {
          const chunk = await abortable(iterator.next(), controller.signal);
          if (chunk.done) break;
          await enqueue(chunk.value);
        }
        for (const frame of packetizer.finish()) {
          controller.signal.throwIfAborted(); playback.push(frame);
        }
        playback.finish();
      } catch { playback.cancel(); }
    };
    try {
      const producer = pump();
      const result = await playback.run();
      controller.abort(); await producer;
      if (this.record.responses.find(item => item.id === responseId)?.playbackStatus !== 'INTERRUPTED') {
        response.playbackStatus = result.reason === 'completed' && result.sentFrames > 0 ? 'TRANSMITTED' : 'FAILED';
      }
      return result;
    } finally {
      clearTimeout(timeout); controller.abort(); playback.cancel();
      void iterator.return?.().catch(() => undefined);
      this.operation = undefined;
    }
  }
}
