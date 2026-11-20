import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AttendeeProvider, ProviderError, createBotBody, parseWebhook, verifyWebhook } from '../src/index.ts';
import { parseMedia } from '../src/socket.ts';

const input = { meetingId: '00000000-0000-4000-8000-000000000001', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: "Alex's AI Delegate | OutOfOffice", mediaUrl: 'wss://example.com/media/capability', webhookUrl: 'https://example.com/webhooks/capability', maxDurationSeconds: 300 };
test('provider request explicitly disables stored recordings and paid transcription and bounds uptime', () => {
  const body = createBotBody(input);
  assert.equal(body.recording_settings.format, 'none');
  assert.equal(body.debug_settings.create_debug_recording, false);
  assert.deepEqual(body.transcription_settings, { meeting_closed_captions: { google_meet_language: 'en-US' } });
  assert.equal(body.automatic_leave_settings.max_uptime_seconds, 300);
  assert.match(body.deduplication_key, /^outofoffice-/);
  assert.match(body.bot_chat_message.message, /disclosed AI/);
  assert.throws(() => createBotBody({ ...input, meetingUrl: 'https://evil.example/a' }));
  assert.throws(() => createBotBody({ ...input, mediaUrl: 'ws://example.com/media' }));
});
test('creation is never automatically retried after an ambiguous transport failure', async () => {
  let calls = 0;
  const provider = new AttendeeProvider('synthetic-key', async () => { calls++; throw new Error('Sensitive transport detail'); });
  await assert.rejects(provider.createBot(input), error => error instanceof ProviderError && error.ambiguous && !error.message.includes('Sensitive'));
  assert.equal(calls, 1);
});
test('4xx is a definitive rejection while malformed success and 5xx remain uncertain', async () => {
  for (const status of [400, 503, 201]) {
    const provider = new AttendeeProvider('synthetic-key', async () => new Response('{}', { status }));
    await assert.rejects(provider.createBot(input), error => error instanceof ProviderError && error.ambiguous === (status !== 400));
  }
});
test('bot lookup is deduplicated and rejects incomplete pagination', async () => {
  let url = '';
  const provider = new AttendeeProvider('synthetic-key', async value => {
    url = String(value); return Response.json({ results: [{ id: 'bot_123', state: 'joining', deduplication_key: 'safe' }, { id: 'bot_other', state: 'joining', deduplication_key: 'other' }], next: null });
  });
  assert.equal((await provider.findBots('safe')).length, 1); assert.match(url, /deduplication_key=safe$/);
  const paged = new AttendeeProvider('synthetic-key', async () => Response.json({ results: [], next: 'https://evil.example/page' }));
  await assert.rejects(paged.findBots('safe'), /provider request failed/);
});
test('webhook signature matches the documented sorted JSON/base64 HMAC contract and fails tampering', () => {
  const secret = Buffer.from('synthetic-project-webhook-secret').toString('base64');
  const payload = { z: ['é', { b: 2, a: 1 }], a: 'hello' };
  const canonical = JSON.stringify({ a: 'hello', z: ['é', { a: 1, b: 2 }] });
  const signature = createHmac('sha256', Buffer.from(secret, 'base64')).update(canonical).digest('base64');
  assert.equal(verifyWebhook(payload, signature, secret), true);
  assert.equal(verifyWebhook({ ...payload, a: 'changed' }, signature, secret), false);
  assert.equal(verifyWebhook(payload, 'wrong', secret), false);
});
test('caption webhooks normalize attribution and preserve event identity', () => {
  const event = parseWebhook({ bot_id: 'bot_123', idempotency_key: 'delivery-1', trigger: 'transcript.update', data: {
    speaker_uuid: 'person-1', speaker_name: 'Sam', timestamp_ms: 100, duration_ms: 500,
    transcription: { transcript: 'OutOfOffice, what is the status?' },
  } });
  assert.equal(event?.kind, 'transcript'); assert.equal(event?.id, 'delivery-1');
  assert.throws(() => parseWebhook({ bot_id: 'bot_123', idempotency_key: 'x', trigger: 'transcript.update', data: { text: 'invented shape' } }));
});
test('incoming mixed PCM rejects wrong bot identity, WAV and invalid formats', () => {
  const payload = { bot_id: 'bot_123', trigger: 'realtime_audio.mixed', data: { sample_rate: 16000, timestamp_ms: 10, chunk: Buffer.alloc(640).toString('base64') } };
  assert.equal(parseMedia(payload, 'bot_123').samples, 320);
  assert.throws(() => parseMedia(payload, 'bot_other'));
  assert.throws(() => parseMedia({ ...payload, data: { ...payload.data, chunk: Buffer.from('RIFFabcd').toString('base64') } }, 'bot_123'));
});
