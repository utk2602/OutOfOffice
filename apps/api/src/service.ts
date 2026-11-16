import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { VoiceSession, SessionError, type SpeechSynthesizer } from '@outofoffice/voice-worker';
import { RecordStore, StoreError } from '@outofoffice/database';
import { agentInputSchema, factInputSchema, meetingInputSchema, type EventEnvelope, type SessionRecord,
  type Agent, type UtteranceInput } from '@outofoffice/shared';
import type { AudioSink } from '@outofoffice/voice-sdk';

export function summarize(record: SessionRecord) {
  return {
    meetingId: record.meeting.id, title: record.meeting.title, status: record.meeting.status,
    method: 'extractive',
    participantStatements: record.transcript.filter(turn => turn.origin === 'participant').map(turn => ({ eventId: turn.eventId, speaker: turn.speaker, text: turn.text })),
    delegateResponses: record.responses.filter(response => response.kind !== 'IGNORE').map(response => ({
      responseId: response.id, kind: response.kind, text: response.text, evidence: response.evidence,
      playbackStatus: response.playbackStatus,
    })),
    unresolvedQuestions: record.followUps.filter(item => item.status === 'pending'),
    decisions: [],
    note: 'Participant statements are unverified. Response text is an approved draft; transmission does not prove audible delivery. No decisions or commitments are inferred.',
  };
}

export class AgentService {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly events = new EventEmitter();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly deleted = new Set<string>();
  private readonly subscribers = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private closing = false;
  get isClosing(): boolean { return this.closing; }
  constructor(readonly store: RecordStore, private readonly synth: SpeechSynthesizer) { this.events.setMaxListeners(100); }
  async initialize(): Promise<void> {
    await this.store.recoverInterrupted(); await this.store.pruneRetention();
    this.timer = setInterval(() => { void this.tick(); }, 250); this.timer.unref();
  }
  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(work);
    this.locks.set(key, task);
    try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }
  private emit(record: SessionRecord, type: string, payload: unknown = record.meeting): void {
    const event: EventEnvelope = { eventId: randomUUID(), meetingId: record.meeting.id, occurredAt: new Date().toISOString(), type, payload };
    this.events.emit(record.meeting.id, event);
  }
  subscribe(id: string, listener: (event: EventEnvelope) => void): () => void {
    const count = this.subscribers.get(id) ?? 0;
    if (count >= 10) throw new StoreError('SUBSCRIBER_LIMIT', 'Too many live event subscribers.', 429);
    this.subscribers.set(id, count + 1); this.events.on(id, listener);
    return () => { this.events.off(id, listener); const left = (this.subscribers.get(id) ?? 1) - 1; if (left) this.subscribers.set(id, left); else this.subscribers.delete(id); };
  }
  private async persist(owner: string, session: VoiceSession): Promise<SessionRecord> {
    const record = session.snapshot();
    try { await this.store.saveRecord(owner, record); }
    catch (error) { session.end('DISCONNECTED'); this.sessions.delete(record.meeting.id); throw error; }
    return record;
  }
  async getRecord(owner: string, id: string): Promise<SessionRecord> {
    const persisted = await this.store.getRecord(owner, id);
    const session = this.sessions.get(persisted.meeting.id);
    if (session) return session.snapshot();
    if (persisted.meeting.status === 'ACTIVE') {
      persisted.meeting.status = 'DISCONNECTED'; persisted.meeting.speechState = 'BLOCKED';
      persisted.meeting.epoch++; persisted.meeting.grantVersion++; persisted.meeting.endedAt = new Date().toISOString();
      await this.store.saveRecord(owner, persisted);
    }
    return persisted;
  }
  async dispatch(owner: string, body: unknown, key: string) {
    return this.serial('dispatch', async () => {
      if (this.closing) throw new StoreError('SHUTTING_DOWN', 'The local worker is shutting down.', 503);
      const input = meetingInputSchema.parse(body); const result = await this.store.dispatch(owner, input, key);
      if (result.created) {
        try {
          const agent = await this.store.getAgent(owner, input.agentId);
          const facts = (await this.store.database.query<{ document: import('@outofoffice/shared').Fact }>(
            "SELECT f.document FROM facts f JOIN meeting_sources s ON s.source_id=f.id AND s.owner_id=f.owner_id WHERE s.meeting_id=$1 AND f.owner_id=$2 AND (f.document->>'version')::integer=s.source_version", [result.record.meeting.id, owner])).rows.map(row => row.document);
          this.sessions.set(result.record.meeting.id, new VoiceSession(agent, result.record.meeting, facts)); this.emit(result.record, 'meeting.state');
        } catch (error) {
          result.record.meeting.status = 'DISCONNECTED'; result.record.meeting.speechState = 'BLOCKED'; result.record.meeting.endedAt = new Date().toISOString();
          await this.store.saveRecord(owner, result.record); throw error;
        }
      }
      return { ...result, record: await this.getRecord(owner, result.record.meeting.id) };
    });
  }
  async receive(owner: string, id: string, input: UtteranceInput) {
    return this.serial(id, async () => {
      await this.store.getRecord(owner, id); const session = this.requireSession(id);
      const response = session.receive(input); const record = await this.persist(owner, session);
      this.emit(record, 'agent.response', response); return response;
    });
  }
  private requireSession(id: string): VoiceSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError('MEETING_ENDED', 'There is no active local worker for this meeting.');
    return session;
  }
  async control(owner: string, id: string, action: 'mute' | 'unmute' | 'interrupt' | 'leave' | 'revoke') {
    await this.store.getRecord(owner, id);
    const session = this.sessions.get(id);
    if (!session) {
      if (action === 'leave' || action === 'revoke' || action === 'mute') return this.getRecord(owner, id);
      throw new SessionError('MEETING_ENDED', 'The meeting has ended.');
    }
    // Cancellation is synchronous after ownership verification; it never waits behind slow persistence.
    if (action === 'leave') session.end(); else if (action === 'revoke') session.end('REVOKED'); else session[action]();
    return this.serial(id, async () => { const record = await this.persist(owner, session); this.emit(record, 'meeting.state'); return record; });
  }
  async listFacts(owner: string, agentId: string) {
    await this.store.getAgent(owner, agentId);
    return (await this.store.database.query<{ document: import('@outofoffice/shared').Fact }>('SELECT document FROM facts WHERE owner_id=$1 AND agent_id=$2 ORDER BY id', [owner, agentId])).rows.map(row => row.document);
  }
  async changeFact(owner: string, id: string, body: unknown | null) {
    return this.serial('dispatch', async () => {
      const current = await this.store.getFact(owner, id);
      const affected = [...this.sessions.values()].filter(session => session.snapshot().meeting.ownerId === owner && session.snapshot().meeting.agentId === current.agentId);
      for (const session of affected) session.replaceFacts([]);
      let updated;
      if (body === null) await this.store.deleteFact(owner, id);
      else {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('INVALID_REQUEST', 'Expected an object.');
        const { title, topic, text, approved, sensitivity, validUntil } = current;
        const patch = body as Record<string, unknown>;
        const candidate = { title, topic, text, approved, sensitivity, validUntil, ...patch };
        if (['text', 'topic', 'title'].some(key => Object.hasOwn(patch, key)) && !Object.hasOwn(patch, 'approved')) candidate.approved = false;
        updated = await this.store.updateFact(owner, id, factInputSchema.parse(candidate));
      }
      const facts = await this.listFacts(owner, current.agentId);
      for (const session of affected) {
        session.replaceFacts(facts);
        await this.serial(session.snapshot().meeting.id, async () => {
          const record = await this.persist(owner, session); this.emit(record, 'knowledge.changed', { sourceId: id });
        });
      }
      return updated ?? { deleted: true };
    });
  }
  async changeAgent(owner: string, id: string, body: unknown): Promise<Agent> {
    return this.serial('dispatch', async () => {
    const current = await this.store.getAgent(owner, id);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('INVALID_REQUEST', 'Expected an object.');
    const { displayName, ownerName, allowedTopics, prohibitedTopics } = current;
    const input = agentInputSchema.parse({ displayName, ownerName, allowedTopics, prohibitedTopics, ...body });
    for (const session of this.sessions.values()) if (session.snapshot().meeting.ownerId === owner && session.snapshot().meeting.agentId === id) await this.control(owner, session.snapshot().meeting.id, 'revoke');
    return this.store.updateAgent(owner, id, input);
    });
  }
  async playbackPermission(owner: string, id: string, responseId: string): Promise<{ allowed: boolean }> {
    const record = await this.getRecord(owner, id);
    if (!record.responses.some(response => response.id === responseId)) throw new StoreError('NOT_FOUND', 'Response not found.', 404);
    return { allowed: this.sessions.get(id)?.canPlay(responseId) ?? false };
  }
  async deleteAgent(owner: string, id: string) {
    return this.serial('dispatch', async () => {
      await this.store.getAgent(owner, id);
      const meetings = await this.store.database.query<{ id: string }>('SELECT id FROM meetings WHERE owner_id=$1 AND agent_id=$2', [owner, id]);
      for (const meeting of meetings.rows) await this.deleteMeeting(owner, meeting.id);
      await this.store.deleteAgent(owner, id); return { deleted: true };
    });
  }
  async speak(owner: string, id: string, responseId: string, sink: AudioSink) {
    await this.store.getRecord(owner, id); const session = this.requireSession(id);
    try { return await session.speak(responseId, this.synth, sink); }
    finally { if (!this.deleted.has(id)) await this.serial(id, async () => { const record = await this.persist(owner, session); this.emit(record, 'agent.playback'); }); }
  }
  async resolve(owner: string, id: string, answer: string | null) {
    const rows = await this.store.database.query<{ document: SessionRecord }>('SELECT s.document FROM session_records s JOIN meetings m ON m.id=s.meeting_id WHERE m.owner_id=$1', [owner]);
    const match = rows.rows.find(row => row.document.followUps.some(item => item.id === id));
    if (!match) throw new StoreError('NOT_FOUND', 'Follow-up not found.', 404);
    const meetingId = match.document.meeting.id;
    return this.serial(meetingId, async () => {
      const session = this.sessions.get(meetingId);
      let record: SessionRecord;
      if (session) { session.resolveFollowUp(id, answer); record = session.snapshot(); }
      else { record = await this.store.getRecord(owner, meetingId); const followUp = record.followUps.find(item => item.id === id)!; followUp.status = answer ? 'resolved' : 'dismissed'; followUp.ownerResponse = answer; }
      await this.store.saveRecord(owner, record); this.emit(record, 'approval.updated', { id }); return record.followUps.find(item => item.id === id)!;
    });
  }
  async deleteMeeting(owner: string, id: string) {
    await this.store.getRecord(owner, id);
    if (this.sessions.has(id)) await this.control(owner, id, 'revoke');
    return this.serial(id, async () => {
      const record = await this.store.getRecord(owner, id); this.deleted.add(id);
      await this.store.deleteMeeting(owner, id); this.sessions.delete(id); this.emit(record, 'meeting.deleted', { id }); return { deleted: true };
    });
  }
  private async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      for (const [id, session] of this.sessions) {
        if (session.snapshot().meeting.status !== 'ACTIVE') await this.serial(id, async () => {
          if (this.deleted.has(id)) return;
          const record = await this.persist(session.snapshot().meeting.ownerId, session); this.emit(record, 'meeting.state');
          // Terminal sessions without subscribers can be evicted; stored records remain readable.
          this.sessions.delete(id);
        });
      }
    } catch { for (const session of this.sessions.values()) session.end('DISCONNECTED'); }
    finally { this.ticking = false; }
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    for (const session of this.sessions.values()) {
      session.end('DISCONNECTED');
      try { await this.persist(session.snapshot().meeting.ownerId, session); } catch { /* Restart reconciliation remains authoritative. */ }
    }
    await Promise.allSettled([...this.locks.values()]); this.events.removeAllListeners();
    // A dispatch already in flight when shutdown began may have attached a session while locks drained.
    for (const session of this.sessions.values()) {
      if (session.snapshot().meeting.status !== 'ACTIVE') continue;
      session.end('DISCONNECTED');
      try { await this.persist(session.snapshot().meeting.ownerId, session); } catch { /* Restart recovery settles any remaining reservation. */ }
    }
    this.sessions.clear();
  }
}
