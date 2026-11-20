import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentSchema, hostedConfigurationIssues } from '../src/config.ts';

const token = 'synthetic-local-token-with-at-least-32-characters';
const live = { LOCAL_API_TOKEN: token, ENABLE_HOSTED_MEETINGS: 'true', ATTENDEE_API_KEY: 'synthetic-attendee-key',
  ATTENDEE_WEBHOOK_SECRET: Buffer.from('synthetic-signing-secret-32-bytes').toString('base64'),
  PROVIDER_PUBLIC_URL: 'https://callbacks.example.com', LIVE_SPEECH_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-gemini-key', GEMINI_LIVE_MODEL: 'test-live-model' };
test('hosted dispatch is opt-in and string false never enables it', () => {
  assert.equal(environmentSchema.parse({ LOCAL_API_TOKEN: token }).ENABLE_HOSTED_MEETINGS, false);
  assert.equal(environmentSchema.parse({ ...live, ENABLE_HOSTED_MEETINGS: 'false' }).ENABLE_HOSTED_MEETINGS, false);
  assert.equal(environmentSchema.safeParse({ ...live, ENABLE_HOSTED_MEETINGS: 'yes' }).success, false);
});
test('hosted readiness requires distinct ports, a public HTTPS origin and project signing secret', () => {
  assert.deepEqual(hostedConfigurationIssues(environmentSchema.parse(live)), []);
  for (const url of ['http://callbacks.example.com', 'https://localhost', 'https://127.0.0.1', 'https://user:password@callbacks.example.com', 'https://callbacks.example.com/path', 'https://callbacks.example.com?token=secret']) {
    assert.ok(hostedConfigurationIssues(environmentSchema.parse({ ...live, PROVIDER_PUBLIC_URL: url })).some(issue => issue.startsWith('PROVIDER_PUBLIC_URL')));
  }
  assert.ok(hostedConfigurationIssues(environmentSchema.parse({ ...live, PROVIDER_CALLBACK_PORT: 4000 })).some(issue => issue.startsWith('PROVIDER_CALLBACK_PORT')));
  assert.ok(hostedConfigurationIssues(environmentSchema.parse({ ...live, ATTENDEE_WEBHOOK_SECRET: 'wrong' })).includes('ATTENDEE_WEBHOOK_SECRET'));
});
test('Gemini speech requires explicit credentials and a model without enabling calls during configuration checks', () => {
  const config = environmentSchema.parse({ ...live, GEMINI_API_KEY: '', GEMINI_LIVE_MODEL: '' });
  assert.ok(hostedConfigurationIssues(config).includes('GEMINI_API_KEY'));
  assert.ok(hostedConfigurationIssues(config).includes('GEMINI_LIVE_MODEL'));
});
