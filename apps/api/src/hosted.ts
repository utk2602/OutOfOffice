import { createHash, randomBytes } from 'node:crypto';
import type WebSocket from 'ws';
import { StoreError } from '@outofoffice/database';
import type { HostedAttempt } from '@outofoffice/shared';
import { isProviderEnded, isProviderJoined, ProviderError, type MeetingProvider, type ProviderEvent } from '@outofoffice/meeting-sdk';
import { AttendeeAudioSink } from '../../../packages/meeting-sdk/src/socket.ts';
import type { SpeechSynthesizer } from '@outofoffice/voice-worker';
import type { AgentService } from './service.ts';

type Runtime = {
  owner: string; botId: string | null; botName: string; socket: WebSocket | null; seen: Set<string>; turns: Set<string>; disclosed: boolean;
  captionsSeen: boolean; joined: boolean; lastMediaAt: number; lastStateAt: number; lastTurnEnd: number;
  lastSpeechAt: number; speaking: boolean; playback: Promise<void> | null; unsubscribe: () => void;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class HostedMeetings {
  private readonly runtime = new Map<string, Runtime>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private closing = false;
  constructor(readonly service: AgentService, readonly provider: MeetingProvider,
    private readonly synthesizer: SpeechSynthesizer, private readonly publicUrl: string,
    private readonly clock: () => number = Date.now) {}
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const task = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(work); this.locks.set(id, task);
    try { return await task; } finally { if (this.locks.get(id) === task) this.locks.delete(id); }
  }
  private async save(attempt: HostedAttempt): Promise<void> {
    attempt.updatedAt = new Date(this.clock()).toISOString(); await this.service.store.updateAttempt(attempt);
  }
  async initialize(): Promise<void> {
    // Never resume speech or recreate a bot after process loss. Reconcile and stop it instead.
    for (const attempt of await this.service.store.listAttempts()) if (attempt.state !== 'ENDED') {
      await this.serial(attempt.meetingId, async () => {
        if (attempt.state === 'PREPARED') { attempt.state = 'ENDED'; attempt.deletion = 'confirmed'; await this.save(attempt); }
        else await this.reconcileAttempt(attempt, true);
        await this.service.store.saveRecord(attempt.ownerId, await this.service.store.getRecord(attempt.ownerId, attempt.meetingId));
      });
    }
    this.timer = setInterval(() => { void this.poll(); }, 5000); this.timer.unref();
  }
  async start(owner: string, id: string): Promise<void> {
    await this.serial(id, async () => {
      if (this.closing) throw new StoreError('SHUTTING_DOWN', 'Hosted worker is shutting down.', 503);
      const attempt = await this.service.store.getAttempt(owner, id);
      if (attempt.state !== 'PREPARED') return;
      const record = await this.service.getRecord(owner, id);
      const capability = randomBytes(32).toString('hex');
      attempt.capabilityHash = digest(capability); attempt.state = 'CREATING';
      await this.save(attempt); // Durable before the external side effect.
      const rt: Runtime = { owner, botId: null, botName: attempt.botName, socket: null, seen: new Set(), turns: new Set(), disclosed: false, captionsSeen: false, joined: false,
        lastMediaAt: 0, lastStateAt: 0, lastTurnEnd: 0, lastSpeechAt: 0, speaking: false, playback: null,
        unsubscribe: this.service.subscribe(id, event => { if (event.type === 'meeting.state') {
          const meeting = event.payload as { status: string };
          if (meeting.status !== 'ACTIVE') void this.stop(owner, id).catch(() => undefined);
        } }),
      };
      this.runtime.set(id, rt);
      const path = `/attendee/${id}/${capability}`;
      try {
        const bot = await this.provider.createBot({ meetingId: id, meetingUrl: attempt.meetingUrl, botName: attempt.botName,
          webhookUrl: `${this.publicUrl}${path}/events`, mediaUrl: `${this.publicUrl.replace(/^https:/, 'wss:')}${path}/media`, maxDurationSeconds: record.meeting.maxDurationSeconds });
        attempt.botId = bot.id; attempt.providerState = bot.state; attempt.state = 'TRACKING'; await this.save(attempt);
        rt.botId = bot.id;
        rt.joined = isProviderJoined(bot.state);
      } catch (error) {
        attempt.lastError = error instanceof ProviderError ? error.code : 'CREATE_UNCERTAIN';
        if (error instanceof ProviderError && !error.ambiguous) { attempt.state = 'ENDED'; attempt.providerState = 'not_created'; attempt.deletion = 'confirmed'; }
        else attempt.state = 'UNCERTAIN';
        await this.save(attempt); await this.service.control(owner, id, 'leave', true);
        this.detach(id);
      }
    });
  }
  async authorize(id: string, capability: string): Promise<HostedAttempt | null> {
    if (this.closing || !/^[a-f0-9]{64}$/.test(capability)) return null;
    const rt = this.runtime.get(id); if (!rt) return null;
    const attempt = await this.service.store.getAttempt(rt.owner, id);
    return attempt.capabilityHash === digest(capability) && attempt.state === 'TRACKING' && attempt.botId ? attempt : null;
  }
  connect(id: string, socket: WebSocket): void {
    const rt = this.runtime.get(id);
    if (!rt || rt.socket) { socket.close(1008, 'Connection unavailable'); return; }
    rt.socket = socket; rt.lastMediaAt = this.clock();
    socket.once('close', () => {
      if (rt.socket !== socket) return;
      rt.socket = null; rt.disclosed = false;
      this.service.interruptImmediately(id);
      void this.service.control(rt.owner, id, 'mute', true).then(() => this.stop(rt.owner, id)).catch(() => undefined);
    });
  }
  mediaReceived(id: string): void { const rt = this.runtime.get(id); if (rt) rt.lastMediaAt = this.clock(); }
  assertCanSpeak(id: string): void {
    const rt = this.runtime.get(id);
    if (!rt || !rt.joined || !rt.disclosed || !rt.captionsSeen || !rt.socket || rt.socket.readyState !== 1 || this.clock() - rt.lastMediaAt > 10_000) throw new StoreError('HOSTED_NOT_READY', 'Confirm disclosure and consent after admission, a working caption and media connection.', 409);
  }
  async enableSpeaking(owner: string, id: string): Promise<unknown> {
    return this.serial(id, async () => {
      const attempt = await this.service.store.getAttempt(owner, id); const rt = this.runtime.get(id);
      if (attempt.state !== 'TRACKING' || !isProviderJoined(attempt.providerState) || !rt?.captionsSeen || !rt.socket || rt.socket.readyState !== 1) throw new StoreError('HOSTED_NOT_READY', 'Wait for admission, a caption and the media connection before confirming disclosure.', 409);
      rt.disclosed = true; this.assertCanSpeak(id);
      attempt.disclosureConfirmedAt = new Date(this.clock()).toISOString(); await this.save(attempt);
      const record = await this.service.control(owner, id, 'unmute', true);
      return { meetingId: id, speechState: record.meeting.speechState, disclosureConfirmed: true };
    });
  }
  async event(id: string, event: ProviderEvent): Promise<void> {
    if (this.closing) return;
    const active = this.runtime.get(id);
    if (active?.botId === event.botId) {
      // Cancellation precedes lifecycle/database queues, including a slow provider status poll.
      if (event.kind === 'participant' && event.name !== active.botName &&
        event.action === 'speech_start' && event.timestampMs >= active.lastTurnEnd && Math.abs(this.clock() - event.timestampMs) <= 5000) this.service.interruptImmediately(id);
      if (event.kind === 'participant' && event.name !== active.botName && event.action === 'join' && active.disclosed) this.service.interruptImmediately(id);
      if (event.kind === 'transcript' && event.speaker !== active.botName && !active.seen.has(event.id) &&
        !active.turns.has(digest(`${event.botId}:${event.participantId}:${event.timestampMs}`))) this.service.interruptImmediately(id);
      if (event.kind === 'state' && !isProviderJoined(event.state) && Date.parse(event.at) >= active.lastStateAt) {
        active.disclosed = false; active.joined = false; this.service.interruptImmediately(id);
      }
    }
    await this.serial(id, async () => {
      if (this.closing) return;
      const rt = this.runtime.get(id); if (!rt) return;
      const attempt = await this.service.store.getAttempt(rt.owner, id);
      if (attempt.botId !== event.botId || attempt.state !== 'TRACKING') return;
      if (rt.seen.has(event.id)) return;
      if (rt.seen.size >= 4000) { await this.stopAttempt(attempt, 'EVENT_LIMIT'); return; }
      rt.seen.add(event.id);
      if (event.kind === 'state') {
        const at = Date.parse(event.at);
        if (at < rt.lastStateAt || at > this.clock() + 30_000) return;
        rt.lastStateAt = at; attempt.lastStateAt = event.at; attempt.providerState = event.state;
        rt.joined = isProviderJoined(event.state);
        if (isProviderEnded(event.state)) { await this.finish(attempt); return; }
        if (!isProviderJoined(event.state)) { rt.disclosed = false; await this.service.control(rt.owner, id, 'mute', true); }
        if (event.state === 'joined_recording_permission_denied') { await this.stopAttempt(attempt, 'RECORDING_PERMISSION_DENIED'); return; }
        await this.save(attempt); return;
      }
      const now = this.clock();
      if (event.timestampMs > now + 2000 || event.timestampMs < Date.parse(attempt.consentAt) - 2000) return;
      if (event.kind === 'participant') {
        if (event.name === attempt.botName) return;
        if (event.action === 'join' && rt.disclosed) { await this.stopAttempt(attempt, 'PARTICIPANT_CHANGE_REQUIRES_CONSENT'); return; }
        if (event.action === 'speech_start' && event.timestampMs >= rt.lastTurnEnd && now - event.timestampMs <= 5000) {
          rt.lastSpeechAt = Math.max(rt.lastSpeechAt, event.timestampMs);
          await this.service.control(rt.owner, id, 'interrupt', true);
        }
        return;
      }
      if (event.speaker === attempt.botName) return;
      rt.captionsSeen = true;
      const end = event.timestampMs + event.durationMs;
      const turnKey = digest(`${event.botId}:${event.participantId}:${event.timestampMs}`);
      if (rt.turns.has(turnKey)) return; // Caption revisions never create a second speaking turn.
      rt.turns.add(turnKey);
      if (end < rt.lastTurnEnd || end < rt.lastSpeechAt - 500 || now - end > 10_000 || end > now + 2000) { attempt.lastError = 'STALE_OR_REORDERED_CAPTION'; await this.save(attempt); return; }
      rt.lastTurnEnd = Math.max(rt.lastTurnEnd, end);
      const captionReceivedAt = this.clock();
      const response = await this.service.receive(rt.owner, id, { eventId: turnKey, speaker: event.speaker, text: event.text, origin: 'participant' });
      if (response.playbackStatus !== 'AUTHORIZED') return;
      try { this.assertCanSpeak(id); } catch { await this.service.control(rt.owner, id, 'mute', true); return; }
      if (attempt.speechCalls >= 30) { await this.stopAttempt(attempt, 'SPEECH_CALL_LIMIT'); return; }
      attempt.speechCalls++; await this.save(attempt);
      const prior = rt.playback ?? Promise.resolve();
      rt.playback = prior.catch(() => undefined).then(async () => {
        try {
          this.assertCanSpeak(id); rt.speaking = true;
          const transport = new AttendeeAudioSink(rt.socket!);
          let firstFrameAt: number | undefined;
          const result = await this.service.speak(rt.owner, id, response.id, {
            send: async (frame, signal) => { this.assertCanSpeak(id); await transport.send(frame, signal); firstFrameAt ??= this.clock(); },
            flush: () => transport.flush(),
          }, this.synthesizer);
          if (firstFrameAt !== undefined) await this.serial(id, async () => {
            const current = await this.service.store.getAttempt(rt.owner, id);
            current.latencySamples = [...(current.latencySamples ?? []), { captionDelayMs: Math.max(0, captionReceivedAt - end),
              firstFrameFromCaptionMs: firstFrameAt! - captionReceivedAt, firstFrameFromQuestionEndMs: Math.max(0, firstFrameAt! - end) }].slice(-30);
            await this.save(current);
          });
          // No documented provider flush: after partial transmission, leave rather than resume stale buffered speech.
          if (result.reason !== 'completed' && (result.sentFrames > 0 || result.reason === 'transport_timeout' || result.reason === 'transport_error')) await this.stop(rt.owner, id);
          else if (result.reason !== 'completed') {
            const record = await this.service.getRecord(rt.owner, id);
            if (record.responses.find(item => item.id === response.id)?.playbackStatus === 'FAILED') {
              await this.service.control(rt.owner, id, 'mute', true);
              await this.serial(id, async () => { const current = await this.service.store.getAttempt(rt.owner, id); current.lastError = 'SPEECH_FAILED'; await this.save(current); });
            }
          }
        } catch {
          const record = await this.service.getRecord(rt.owner, id).catch(() => null);
          const cancelled = record?.responses.find(item => item.id === response.id)?.playbackStatus;
          if (cancelled !== 'CANCELLED' && cancelled !== 'INTERRUPTED') await this.service.control(rt.owner, id, 'mute', true).catch(() => undefined);
        }
        finally { rt.speaking = false; }
      });
    });
  }
  private detach(id: string): void {
    const rt = this.runtime.get(id); if (!rt) return;
    this.runtime.delete(id); rt.unsubscribe(); rt.socket?.close(1000, 'Session stopped');
  }
  private async finish(attempt: HostedAttempt): Promise<void> {
    attempt.state = 'ENDED'; attempt.capabilityHash = null; await this.save(attempt); this.detach(attempt.meetingId);
    await this.service.control(attempt.ownerId, attempt.meetingId, 'leave', true);
    await this.service.store.saveRecord(attempt.ownerId, await this.service.store.getRecord(attempt.ownerId, attempt.meetingId));
  }
  private async stopAttempt(attempt: HostedAttempt, error?: string): Promise<void> {
    if (error) attempt.lastError = error;
    await this.service.control(attempt.ownerId, attempt.meetingId, 'leave', true);
    attempt.capabilityHash = null; this.detach(attempt.meetingId);
    if (attempt.state === 'ENDED') return;
    if (attempt.state === 'PREPARED') { attempt.state = 'ENDED'; attempt.providerState = 'not_created'; attempt.deletion = 'confirmed'; await this.save(attempt); }
    else {
      attempt.state = attempt.botId ? 'STOPPING' : 'UNCERTAIN'; await this.save(attempt);
      await this.reconcileAttempt(attempt, true);
    }
    await this.service.store.saveRecord(attempt.ownerId, await this.service.store.getRecord(attempt.ownerId, attempt.meetingId));
  }
  async stop(owner: string, id: string): Promise<void> {
    await this.serial(id, async () => { const attempt = await this.service.store.getAttempt(owner, id); await this.stopAttempt(attempt); });
  }
  private async reconcileAttempt(attempt: HostedAttempt, stop: boolean): Promise<void> {
    try {
      if (!attempt.botId) {
        const bots = await this.provider.findBots(`outofoffice-${attempt.meetingId}`);
        if (bots.length !== 1) { attempt.state = 'UNCERTAIN'; attempt.lastError = 'CREATION_REQUIRES_RECONCILIATION'; await this.save(attempt); return; }
        attempt.botId = bots[0]!.id;
      }
      const bot = await this.provider.getBot(attempt.botId); attempt.providerState = bot.state;
      const rt = this.runtime.get(attempt.meetingId);
      if (rt) {
        rt.joined = isProviderJoined(bot.state);
        if (!rt.joined) { rt.disclosed = false; await this.service.control(attempt.ownerId, attempt.meetingId, 'mute', true); }
      }
      if (isProviderEnded(bot.state)) { await this.finish(attempt); return; }
      if (stop) { attempt.state = 'STOPPING'; await this.save(attempt); await this.provider.leaveBot(bot.id); }
      else await this.save(attempt);
    } catch {
      const rt = this.runtime.get(attempt.meetingId);
      if (rt) { rt.disclosed = false; rt.joined = false; await this.service.control(attempt.ownerId, attempt.meetingId, 'mute', true).catch(() => undefined); }
      attempt.lastError = 'PROVIDER_RECONCILIATION_FAILED'; await this.save(attempt);
    }
  }
  async reconcile(owner: string, id: string): Promise<unknown> {
    await this.serial(id, async () => {
      const attempt = await this.service.store.getAttempt(owner, id);
      if (attempt.state !== 'ENDED') await this.reconcileAttempt(attempt, !this.runtime.has(id) || attempt.state !== 'TRACKING');
    });
    return this.status(owner, id);
  }
  async status(owner: string, id: string) {
    const attempt = await this.service.store.getAttempt(owner, id); const rt = this.runtime.get(id);
    return { meetingId: id, botId: attempt.botId, state: attempt.state, providerState: attempt.providerState,
      mediaConnected: rt?.socket?.readyState === 1, captionsSeen: rt?.captionsSeen ?? false, disclosureConfirmed: rt?.disclosed ?? false,
      speechCalls: attempt.speechCalls, lastError: attempt.lastError, deletion: attempt.deletion, playbackFlush: 'unsupported',
      disclosureConfirmedAt: attempt.disclosureConfirmedAt, latencySamples: attempt.latencySamples ?? [], latencyMeaning: 'frame accepted by transport, not confirmed audible', updatedAt: attempt.updatedAt };
  }
  async deleteData(owner: string, id: string): Promise<void> {
    await this.stop(owner, id);
    await this.serial(id, async () => {
      const attempt = await this.service.store.getAttempt(owner, id);
      if (attempt.state !== 'ENDED') throw new StoreError('PROVIDER_END_PENDING', 'Provider termination is not confirmed. Reconcile before deletion.', 409);
      if (attempt.deletion === 'confirmed') return;
      attempt.deletion = 'pending'; await this.save(attempt);
      try { if (attempt.botId) await this.provider.deleteBotData(attempt.botId); attempt.deletion = 'confirmed'; attempt.lastError = null; await this.save(attempt); }
      catch { throw new StoreError('PROVIDER_DELETE_PENDING', 'Provider data deletion failed. The local record is preserved for retry.', 502); }
    });
  }
  private async poll(): Promise<void> {
    if (this.polling || this.closing) return; this.polling = true;
    try {
      for (const attempt of await this.service.store.listAttempts()) {
        if (attempt.state === 'ENDED') continue;
        await this.serial(attempt.meetingId, async () => {
          const current = await this.service.store.getAttempt(attempt.ownerId, attempt.meetingId);
          if (current.state === 'ENDED') return;
          const record = await this.service.getRecord(current.ownerId, current.meetingId); const rt = this.runtime.get(current.meetingId);
          if (record.meeting.status !== 'ACTIVE' || !rt || (rt.socket && this.clock() - rt.lastMediaAt > 10_000)) await this.stopAttempt(current);
          else await this.reconcileAttempt(current, false);
        });
      }
    } catch { /* No recovery path automatically grants speech or recreates a bot. */ }
    finally { this.polling = false; }
  }
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.timer);
    const playback = [...this.runtime.values()].flatMap(rt => rt.playback ? [rt.playback] : []);
    for (const attempt of await this.service.store.listAttempts()) if (attempt.state !== 'ENDED') await this.stop(attempt.ownerId, attempt.meetingId).catch(() => undefined);
    await Promise.allSettled([...this.locks.values()]);
    await Promise.allSettled(playback);
    for (const id of this.runtime.keys()) this.detach(id);
  }
}
