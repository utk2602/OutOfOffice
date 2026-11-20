import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { parseMeetUrl } from '@outofoffice/shared';

export const botSchema = z.object({
  id: z.string().regex(/^bot_[a-zA-Z0-9]+$/), state: z.string().min(1).max(80),
  deduplication_key: z.string().nullable().optional(),
});
export type ProviderBot = z.infer<typeof botSchema>;
export const isProviderEnded = (state: string) => ['ended', 'fatal_error', 'data_deleted', 'post_processing'].includes(state);
export const isProviderJoined = (state: string) => ['joined_recording', 'joined_not_recording'].includes(state);
export class ProviderError extends Error {
  constructor(readonly code: string, readonly ambiguous = false, readonly status?: number) {
    super(code === 'CREATE_UNCERTAIN' ? 'Bot creation is uncertain. Reconcile the existing attempt; do not dispatch again.' : 'The meeting provider request failed. Check provider status and credentials.');
  }
}
export type CreateBot = { meetingId: string; meetingUrl: string; botName: string; mediaUrl: string; webhookUrl: string; maxDurationSeconds: number };
export interface MeetingProvider {
  createBot(input: CreateBot): Promise<ProviderBot>;
  getBot(id: string): Promise<ProviderBot>;
  findBots(key: string): Promise<ProviderBot[]>;
  leaveBot(id: string): Promise<void>;
  deleteBotData(id: string): Promise<void>;
}
function callback(value: string, protocol: string): string {
  const url = new URL(value);
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash) throw new Error('Invalid provider callback URL.');
  return url.toString();
}
export function createBotBody(input: CreateBot) {
  if (!Number.isInteger(input.maxDurationSeconds) || input.maxDurationSeconds < 30 || input.maxDurationSeconds > 900) throw new Error('Invalid meeting duration.');
  return {
    meeting_url: parseMeetUrl(input.meetingUrl), bot_name: input.botName.slice(0, 120),
    deduplication_key: `outofoffice-${z.uuid().parse(input.meetingId)}`,
    metadata: { outofoffice_meeting_id: input.meetingId },
    bot_chat_message: { to: 'everyone', message: `${input.botName}. I am a disclosed AI delegate. I use meeting captions and speak only from my owner’s approved facts. Please tell my owner if you do not consent; my owner must revoke the session.` },
    transcription_settings: { meeting_closed_captions: { google_meet_language: 'en-US' } },
    recording_settings: { format: 'none', record_async_transcription_audio_chunks: false, record_chat_messages_when_paused: false, record_participant_speech_start_stop_events: true },
    debug_settings: { create_debug_recording: false },
    automatic_leave_settings: {
      max_uptime_seconds: input.maxDurationSeconds, waiting_room_timeout_seconds: 120,
      wait_for_host_to_start_meeting_timeout_seconds: 120, enable_closed_captions_timeout_seconds: 60,
      only_participant_in_meeting_timeout_seconds: 30,
    },
    websocket_settings: { audio: { url: callback(input.mediaUrl, 'wss:'), sample_rate: 16000 } },
    webhooks: [{ url: callback(input.webhookUrl, 'https:'), triggers: ['bot.state_change', 'transcript.update', 'participant_events.join_leave', 'participant_events.speech_start_stop'] }],
  };
}
export class AttendeeProvider implements MeetingProvider {
  constructor(private readonly apiKey: string, private readonly transport: typeof fetch = fetch) {
    if (apiKey.length < 8) throw new Error('An Attendee API key is required.');
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const creation = path === '/bots' && method === 'POST';
    try {
      const response = await this.transport(`https://app.attendee.dev/api/v1${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new ProviderError(creation && response.status >= 500 ? 'CREATE_UNCERTAIN' : 'PROVIDER_REJECTED', creation && response.status >= 500, response.status);
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 256_000) { await reader.cancel(); throw new Error('Oversized provider response.'); } chunks.push(chunk.value); }
      const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(creation ? 'CREATE_UNCERTAIN' : 'PROVIDER_UNAVAILABLE', creation);
    }
  }
  async createBot(input: CreateBot): Promise<ProviderBot> {
    const body = createBotBody(input);
    try { return botSchema.parse(await this.request('/bots', 'POST', body)); }
    catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError('CREATE_UNCERTAIN', true); }
  }
  async getBot(id: string): Promise<ProviderBot> { return botSchema.parse(await this.request(`/bots/${botSchema.shape.id.parse(id)}`)); }
  async findBots(key: string): Promise<ProviderBot[]> {
    const page = z.object({ results: z.array(botSchema).max(100), next: z.string().nullable().optional() }).parse(await this.request(`/bots?deduplication_key=${encodeURIComponent(key)}`));
    // Ambiguous pagination must never be mistaken for proof that no bot exists.
    if (page.next) throw new ProviderError('RECONCILIATION_INCOMPLETE');
    return page.results.filter(bot => bot.deduplication_key === key);
  }
  async leaveBot(id: string): Promise<void> { await this.request(`/bots/${botSchema.shape.id.parse(id)}/leave`, 'POST'); }
  async deleteBotData(id: string): Promise<void> { await this.request(`/bots/${botSchema.shape.id.parse(id)}/delete_data`, 'POST'); }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export function verifyWebhook(payload: unknown, signature: string, secret: string): boolean {
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(signature) || !/^[a-zA-Z0-9+/]+={0,2}$/.test(secret)) return false;
  const expected = createHmac('sha256', Buffer.from(secret, 'base64')).update(JSON.stringify(canonical(payload))).digest();
  const received = Buffer.from(signature, 'base64');
  return received.length === expected.length && timingSafeEqual(expected, received);
}
const envelope = z.object({ bot_id: botSchema.shape.id, idempotency_key: z.string().min(1).max(100), trigger: z.string().max(100), data: z.unknown() });
export type ProviderEvent =
  | { id: string; botId: string; kind: 'state'; state: string; at: string }
  | { id: string; botId: string; kind: 'transcript'; participantId: string; speaker: string; text: string; timestampMs: number; durationMs: number }
  | { id: string; botId: string; kind: 'participant'; participantId: string; name: string; action: string; timestampMs: number };
export function parseWebhook(payload: unknown): ProviderEvent | null {
  const event = envelope.parse(payload); const base = { id: event.idempotency_key, botId: event.bot_id };
  if (event.trigger === 'bot.state_change') {
    const data = z.object({ new_state: z.string().min(1).max(80), created_at: z.iso.datetime({ offset: true }) }).parse(event.data);
    return { ...base, kind: 'state', state: data.new_state, at: data.created_at };
  }
  if (event.trigger === 'transcript.update') {
    const data = z.object({ speaker_uuid: z.string().min(1).max(200), speaker_name: z.string().min(1).max(80), timestamp_ms: z.number().finite().nonnegative(), duration_ms: z.number().min(0).max(900_000), transcription: z.object({ transcript: z.string().trim().min(1).max(4000) }).nullable() }).parse(event.data);
    if (!data.transcription) return null;
    return { ...base, kind: 'transcript', participantId: data.speaker_uuid, speaker: data.speaker_name, text: data.transcription.transcript, timestampMs: data.timestamp_ms, durationMs: data.duration_ms };
  }
  if (event.trigger.startsWith('participant_events.')) {
    const data = z.object({ participant_uuid: z.string().min(1).max(200), participant_name: z.string().max(120), event_type: z.enum(['join', 'leave', 'speech_start', 'speech_stop']), timestamp_ms: z.number().finite().nonnegative() }).parse(event.data);
    return { ...base, kind: 'participant', participantId: data.participant_uuid, name: data.participant_name, action: data.event_type, timestampMs: data.timestamp_ms };
  }
  return null;
}
