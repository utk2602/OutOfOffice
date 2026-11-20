import { createHash, randomUUID } from 'node:crypto';
import { eligibleFacts } from '@outofoffice/agent-core';
import type { Agent, AgentInput, Fact, FactInput, Meeting, MeetingInput, SessionRecord, HostedAttempt } from '@outofoffice/shared';
import { Database, type Queryable } from './database.ts';

export class StoreError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const notFound = () => new StoreError('NOT_FOUND', 'Resource not found.', 404);
async function document<T>(tx: Queryable, sql: string, params: unknown[]): Promise<T> {
  const result = await tx.query<{ document: T }>(sql, params);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].document;
}

export class RecordStore {
  constructor(readonly database: Database, private readonly limits: { budgetSeconds: number; maxMeetingSeconds: number; maxConcurrentMeetings: number; hostedBudgetSeconds?: number },
    private readonly clock: () => number = Date.now) {}
  async ensureOwner(ownerId: string): Promise<void> { await this.database.query('INSERT INTO owners(id) VALUES ($1) ON CONFLICT DO NOTHING', [ownerId]); }
  private async audit(tx: Queryable, owner: string, id: string, action: string) {
    await tx.query('INSERT INTO audits(id,owner_id,resource_id,action,created_at) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), owner, id, action, new Date(this.clock()).toISOString()]);
  }
  async createAgent(ownerId: string, input: AgentInput): Promise<Agent> {
    const agent = { ...input, id: randomUUID(), ownerId, createdAt: new Date(this.clock()).toISOString() };
    await this.database.transaction(async tx => {
      await tx.query('INSERT INTO agents(id,owner_id,document) VALUES ($1,$2,$3)', [agent.id, ownerId, JSON.stringify(agent)]);
      await this.audit(tx, ownerId, agent.id, 'agent.created');
    }); return agent;
  }
  async listAgents(owner: string): Promise<Agent[]> { return (await this.database.query<{ document: Agent }>('SELECT document FROM agents WHERE owner_id=$1 ORDER BY id', [owner])).rows.map(row => row.document); }
  async getAgent(owner: string, id: string): Promise<Agent> { return document(this.database, 'SELECT document FROM agents WHERE owner_id=$1 AND id=$2', [owner, id]); }
  async updateAgent(owner: string, id: string, input: AgentInput): Promise<Agent> {
    return this.database.transaction(async tx => {
      const current = await document<Agent>(tx, 'SELECT document FROM agents WHERE owner_id=$1 AND id=$2', [owner, id]);
      const agent = { ...current, ...input }; await tx.query('UPDATE agents SET document=$3 WHERE owner_id=$1 AND id=$2', [owner, id, JSON.stringify(agent)]);
      await this.audit(tx, owner, id, 'agent.updated'); return agent;
    });
  }
  async createFact(owner: string, agentId: string, input: FactInput): Promise<Fact> {
    return this.database.transaction(async tx => {
      await document<Agent>(tx, 'SELECT document FROM agents WHERE owner_id=$1 AND id=$2', [owner, agentId]);
      const fact: Fact = { ...input, id: randomUUID(), ownerId: owner, agentId, version: 1, updatedAt: new Date(this.clock()).toISOString() };
      await tx.query('INSERT INTO facts(id,owner_id,agent_id,document) VALUES ($1,$2,$3,$4)', [fact.id, owner, agentId, JSON.stringify(fact)]);
      await this.audit(tx, owner, fact.id, 'fact.created'); return fact;
    });
  }
  async listFacts(owner: string, agentId: string): Promise<Fact[]> {
    await this.getAgent(owner, agentId);
    return (await this.database.query<{ document: Fact }>('SELECT document FROM facts WHERE owner_id=$1 AND agent_id=$2 ORDER BY id', [owner, agentId])).rows.map(row => row.document);
  }
  async getFact(owner: string, id: string): Promise<Fact> { return document(this.database, 'SELECT document FROM facts WHERE owner_id=$1 AND id=$2', [owner, id]); }
  async updateFact(owner: string, id: string, input: FactInput): Promise<Fact> {
    return this.database.transaction(async tx => {
      const current = await document<Fact>(tx, 'SELECT document FROM facts WHERE owner_id=$1 AND id=$2', [owner, id]);
      const fact = { ...current, ...input, version: current.version + 1, updatedAt: new Date(this.clock()).toISOString() };
      await tx.query('UPDATE facts SET document=$3 WHERE owner_id=$1 AND id=$2', [owner, id, JSON.stringify(fact)]);
      await this.audit(tx, owner, id, 'fact.updated'); return fact;
    });
  }
  async deleteFact(owner: string, id: string): Promise<void> {
    await this.database.transaction(async tx => {
      await document<Fact>(tx, 'SELECT document FROM facts WHERE owner_id=$1 AND id=$2', [owner, id]);
      await tx.query('DELETE FROM facts WHERE owner_id=$1 AND id=$2', [owner, id]); await this.audit(tx, owner, id, 'fact.deleted');
    });
  }
  async deleteAgent(owner: string, id: string): Promise<void> {
    await this.database.transaction(async tx => {
      await document<Agent>(tx, 'SELECT document FROM agents WHERE owner_id=$1 AND id=$2', [owner, id]);
      const active = await tx.query("SELECT id FROM meetings WHERE owner_id=$1 AND agent_id=$2 AND status='ACTIVE'", [owner, id]);
      if (active.rows.length) throw new StoreError('MEETING_ACTIVE', 'Stop the agent meetings before deletion.', 409);
      const pending = await tx.query("SELECT h.meeting_id FROM hosted_attempts h JOIN meetings m ON m.id=h.meeting_id WHERE m.owner_id=$1 AND m.agent_id=$2 AND h.document->>'deletion' <> 'confirmed'", [owner, id]);
      if (pending.rows.length) throw new StoreError('PROVIDER_DATA_PENDING', 'Delete provider data for this agent before deleting its local records.', 409);
      await tx.query('DELETE FROM agents WHERE owner_id=$1 AND id=$2', [owner, id]);
      await this.audit(tx, owner, id, 'agent.deleted');
    });
  }
  async dispatch(owner: string, input: MeetingInput, key: string): Promise<{ record: SessionRecord; created: boolean }> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new StoreError('INVALID_IDEMPOTENCY_KEY', 'Use an Idempotency-Key of 1–100 letters, digits, hyphens or underscores.');
    const hash = createHash('sha256').update(JSON.stringify({ ...input, sourceIds: [...input.sourceIds].sort() })).digest('hex');
    return this.database.transaction(async tx => {
      const prior = await tx.query<{ id: string; request_hash: string }>('SELECT id,request_hash FROM meetings WHERE owner_id=$1 AND idempotency_key=$2', [owner, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) throw new StoreError('IDEMPOTENCY_CONFLICT', 'This key was used with a different request.', 409);
        return { record: await document<SessionRecord>(tx, 'SELECT document FROM session_records WHERE meeting_id=$1', [prior.rows[0].id]), created: false };
      }
      if (input.maxDurationSeconds > this.limits.maxMeetingSeconds) throw new StoreError('DURATION_LIMIT', 'Requested duration exceeds the configured limit.');
      if (new Set(input.sourceIds).size !== input.sourceIds.length) throw new StoreError('DUPLICATE_SOURCES', 'Source IDs must be unique.');
      const active = await tx.query<{ owner_id: string }>("SELECT owner_id FROM meetings WHERE status='ACTIVE'");
      if (active.rows.some(row => row.owner_id === owner)) throw new StoreError('ACTIVE_MEETING', 'This owner already has an active meeting.', 409);
      if (active.rows.length >= this.limits.maxConcurrentMeetings) throw new StoreError('CAPACITY_LIMIT', 'Local meeting capacity is full.', 429);
      const total = await tx.query<{ seconds: string }>('SELECT COALESCE(SUM(reserved_seconds + actual_seconds),0)::text AS seconds FROM usage_ledger');
      if (Number(total.rows[0]?.seconds ?? 0) + input.maxDurationSeconds > this.limits.budgetSeconds) throw new StoreError('BUDGET_EXHAUSTED', 'The configured local meeting budget is exhausted.', 429);
      const pending = await tx.query("SELECT meeting_id FROM hosted_attempts WHERE document->>'state' <> 'ENDED'");
      if (pending.rows.length) throw new StoreError('HOSTED_ATTEMPT_PENDING', 'An unresolved hosted bot must be reconciled and stopped before another dispatch.', 409);
      if (input.provider === 'attendee') {
        const hosted = await tx.query<{ seconds: string }>("SELECT COALESCE(SUM(reserved_seconds+actual_seconds),0)::text AS seconds FROM usage_ledger WHERE provider='attendee'");
        if (Number(hosted.rows[0]?.seconds ?? 0) + input.maxDurationSeconds > (this.limits.hostedBudgetSeconds ?? 900)) throw new StoreError('HOSTED_BUDGET_EXHAUSTED', 'The configured cumulative hosted allocation is exhausted.', 429);
      }
      const agent = await document<Agent>(tx, 'SELECT document FROM agents WHERE owner_id=$1 AND id=$2', [owner, input.agentId]);
      const facts = (await tx.query<{ document: Fact }>('SELECT document FROM facts WHERE owner_id=$1 AND agent_id=$2', [owner, agent.id])).rows.map(row => row.document);
      const meeting: Meeting = { id: randomUUID(), ownerId: owner, agentId: agent.id, title: input.title, provider: input.provider,
        status: 'ACTIVE', speechState: input.provider === 'attendee' ? 'MUTED' : 'READY', sourceIds: input.sourceIds, maxDurationSeconds: input.maxDurationSeconds,
        startedAt: new Date(this.clock()).toISOString(), endedAt: null, grantVersion: 1, epoch: 0, idempotencyKey: key };
      const allowed = eligibleFacts({ agent, meeting, facts, now: this.clock(), utterance: { eventId: 'dispatch', speaker: 'owner', text: 'dispatch', origin: 'participant' } });
      if (input.sourceIds.some(id => !allowed.some(fact => fact.id === id))) throw new StoreError('SOURCE_NOT_APPROVED', 'Every source must be current, approved and shareable for this agent.');
      const record: SessionRecord = { meeting, transcript: [], responses: [], followUps: [] };
      await tx.query('INSERT INTO meetings(id,owner_id,agent_id,status,idempotency_key,request_hash,reserved_seconds,document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [meeting.id, owner, agent.id, meeting.status, key, hash, input.maxDurationSeconds, JSON.stringify(meeting)]);
      await tx.query('INSERT INTO session_records(meeting_id,document) VALUES ($1,$2)', [meeting.id, JSON.stringify(record)]);
      await tx.query('INSERT INTO usage_ledger(id,owner_id,reserved_seconds,actual_seconds) VALUES ($1,$2,$3,0)', [meeting.id, owner, input.maxDurationSeconds]);
      await tx.query('UPDATE usage_ledger SET provider=$2 WHERE id=$1', [meeting.id, meeting.provider]);
      if (input.provider === 'attendee') {
        const attempt: HostedAttempt = { meetingId: meeting.id, ownerId: owner, meetingUrl: input.meetingUrl!,
          botName: `${agent.ownerName}'s AI Delegate | OutOfOffice`.slice(0, 120), botId: null,
          state: 'PREPARED', providerState: 'not_created', capabilityHash: null, consentAt: meeting.startedAt,
          updatedAt: meeting.startedAt, lastStateAt: null, speechCalls: 0, lastError: null, deletion: 'not_requested', disclosureConfirmedAt: null, latencySamples: [] };
        await tx.query('INSERT INTO hosted_attempts(meeting_id,owner_id,document) VALUES ($1,$2,$3)', [meeting.id, owner, JSON.stringify(attempt)]);
      }
      for (const id of input.sourceIds) await tx.query('INSERT INTO meeting_sources(meeting_id,owner_id,source_id,source_version) VALUES ($1,$2,$3,$4)', [meeting.id, owner, id, allowed.find(fact => fact.id === id)!.version]);
      await this.audit(tx, owner, meeting.id, 'meeting.dispatched'); return { record, created: true };
    });
  }
  async getRecord(owner: string, id: string): Promise<SessionRecord> {
    return document(this.database, 'SELECT s.document FROM session_records s JOIN meetings m ON m.id=s.meeting_id WHERE m.owner_id=$1 AND m.id=$2', [owner, id]);
  }
  async listMeetings(owner: string): Promise<Meeting[]> {
    return (await this.database.query<{ document: Meeting }>("SELECT document FROM meetings WHERE owner_id=$1 ORDER BY document->>'startedAt' DESC LIMIT 100", [owner])).rows.map(row => row.document);
  }
  async saveRecord(owner: string, record: SessionRecord): Promise<void> {
    await this.database.transaction(async tx => {
      const current = await document<Meeting>(tx, 'SELECT document FROM meetings WHERE owner_id=$1 AND id=$2', [owner, record.meeting.id]);
      if (record.meeting.ownerId !== owner || record.meeting.agentId !== current.agentId) throw new StoreError('INVALID_OWNER', 'Meeting owner mismatch.', 403);
      if (current.status !== 'ACTIVE' && record.meeting.status !== current.status) throw new StoreError('TERMINAL_STATE', 'An ended meeting cannot change its terminal state.', 409);
      const terminal = record.meeting.status !== 'ACTIVE';
      const attempt = current.provider === 'attendee' ? await document<HostedAttempt>(tx, 'SELECT document FROM hosted_attempts WHERE owner_id=$1 AND meeting_id=$2', [owner, current.id]) : null;
      const unsettled = attempt && attempt.state !== 'ENDED';
      const settled = terminal && !unsettled;
      // Hosted allocations are conservatively consumed in full, including uncertain creation.
      const actual = settled ? attempt ? attempt.providerState === 'not_created' ? 0 : current.maxDurationSeconds : Math.min(current.maxDurationSeconds, Math.max(0, Math.ceil((Date.parse(record.meeting.endedAt!) - Date.parse(current.startedAt)) / 1000))) : 0;
      await tx.query('UPDATE meetings SET status=$3,document=$4,reserved_seconds=$5,actual_seconds=$6 WHERE owner_id=$1 AND id=$2',
        [owner, current.id, record.meeting.status, JSON.stringify(record.meeting), settled ? 0 : current.maxDurationSeconds, actual]);
      await tx.query('UPDATE session_records SET document=$2 WHERE meeting_id=$1', [current.id, JSON.stringify(record)]);
      await tx.query('UPDATE usage_ledger SET reserved_seconds=$2,actual_seconds=$3 WHERE id=$1', [current.id, settled ? 0 : current.maxDurationSeconds, actual]);
      if (current.status !== record.meeting.status) await this.audit(tx, owner, current.id, `meeting.${record.meeting.status.toLowerCase()}`);
      else if (current.speechState !== record.meeting.speechState) await this.audit(tx, owner, current.id, `speech.${record.meeting.speechState.toLowerCase()}`);
    });
  }
  async deleteMeeting(owner: string, id: string): Promise<void> {
    await this.database.transaction(async tx => {
      const meeting = await document<Meeting>(tx, 'SELECT document FROM meetings WHERE owner_id=$1 AND id=$2', [owner, id]);
      if (meeting.status === 'ACTIVE') throw new StoreError('MEETING_ACTIVE', 'Leave or revoke the meeting before deletion.', 409);
      if (meeting.provider === 'attendee') {
        const attempt = await document<HostedAttempt>(tx, 'SELECT document FROM hosted_attempts WHERE owner_id=$1 AND meeting_id=$2', [owner, id]);
        if (attempt.state !== 'ENDED' || attempt.deletion !== 'confirmed') throw new StoreError('PROVIDER_DATA_PENDING', 'Confirm bot termination and provider data deletion before deleting the local record.', 409);
      }
      await tx.query('DELETE FROM meetings WHERE owner_id=$1 AND id=$2', [owner, id]); await this.audit(tx, owner, id, 'meeting.deleted');
    });
  }
  async usage(owner: string): Promise<{ actualSeconds: number; reservedSeconds: number; globalRemainingSeconds: number; budgetSeconds: number }> {
    const own = await this.database.query<{ actual: string; reserved: string }>('SELECT COALESCE(SUM(actual_seconds),0)::text AS actual,COALESCE(SUM(reserved_seconds),0)::text AS reserved FROM usage_ledger WHERE owner_id=$1', [owner]);
    const global = await this.database.query<{ total: string }>('SELECT COALESCE(SUM(actual_seconds+reserved_seconds),0)::text AS total FROM usage_ledger');
    return { actualSeconds: Number(own.rows[0]?.actual ?? 0), reservedSeconds: Number(own.rows[0]?.reserved ?? 0),
      globalRemainingSeconds: Math.max(0, this.limits.budgetSeconds - Number(global.rows[0]?.total ?? 0)), budgetSeconds: this.limits.budgetSeconds };
  }
  async recoverInterrupted(): Promise<void> {
    const rows = await this.database.query<{ document: SessionRecord }>("SELECT s.document FROM session_records s JOIN meetings m ON m.id=s.meeting_id WHERE m.status='ACTIVE'");
    for (const row of rows.rows) {
      const record = row.document; record.meeting.status = 'DISCONNECTED'; record.meeting.speechState = 'BLOCKED';
      record.meeting.epoch++; record.meeting.grantVersion++; record.meeting.endedAt = new Date(this.clock()).toISOString();
      for (const response of record.responses) if (response.playbackStatus === 'AUTHORIZED') response.playbackStatus = 'CANCELLED';
      await this.saveRecord(record.meeting.ownerId, record);
    }
  }
  async getAttempt(owner: string, id: string): Promise<HostedAttempt> {
    return document(this.database, 'SELECT document FROM hosted_attempts WHERE owner_id=$1 AND meeting_id=$2', [owner, id]);
  }
  async listAttempts(): Promise<HostedAttempt[]> {
    return (await this.database.query<{ document: HostedAttempt }>('SELECT document FROM hosted_attempts')).rows.map(row => row.document);
  }
  async updateAttempt(attempt: HostedAttempt): Promise<void> {
    await this.database.transaction(async tx => {
      const current = await document<HostedAttempt>(tx, 'SELECT document FROM hosted_attempts WHERE owner_id=$1 AND meeting_id=$2', [attempt.ownerId, attempt.meetingId]);
      if (current.state === 'ENDED' && attempt.state !== 'ENDED') throw new StoreError('TERMINAL_STATE', 'A terminated provider attempt cannot reopen.', 409);
      if (attempt.botId !== current.botId && current.botId) throw new StoreError('BOT_ID_CONFLICT', 'Provider bot identity is already pinned.', 409);
      await tx.query('UPDATE hosted_attempts SET document=$3 WHERE owner_id=$1 AND meeting_id=$2', [attempt.ownerId, attempt.meetingId, JSON.stringify(attempt)]);
    });
  }
  async pruneRetention(): Promise<void> {
    const meetingCutoff = new Date(this.clock() - 30 * 86400_000).toISOString();
    const auditCutoff = new Date(this.clock() - 90 * 86400_000).toISOString();
    await this.database.transaction(async tx => {
      await tx.query("DELETE FROM meetings WHERE status <> 'ACTIVE' AND document->>'endedAt' < $1 AND id NOT IN (SELECT meeting_id FROM hosted_attempts WHERE document->>'deletion' <> 'confirmed')", [meetingCutoff]);
      await tx.query('DELETE FROM audits WHERE created_at < $1', [auditCutoff]);
    });
  }
}
