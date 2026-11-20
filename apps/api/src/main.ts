import { Database, RecordStore } from '@outofoffice/database';
import { mkdir } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { createApi } from './server.ts';
import { loadEnvironment, hostedConfigurationIssues } from './config.ts';
import { AttendeeProvider } from '@outofoffice/meeting-sdk';
import { GeminiSpeechSynthesizer, WindowsSpeechSynthesizer } from '@outofoffice/voice-sdk';

async function main() {
  const config = loadEnvironment();
  const issues = hostedConfigurationIssues(config);
  if (config.ENABLE_HOSTED_MEETINGS && issues.length) throw new Error('Hosted configuration is incomplete. Run pnpm providers:check.');
  await mkdir(config.DATA_DIRECTORY, { recursive: true });
  const release = await lockfile.lock(config.DATA_DIRECTORY, { stale: 10_000, update: 2000, retries: 0 });
  let database: Database | undefined;
  let api: Awaited<ReturnType<typeof createApi>> | undefined;
  try {
    database = await Database.open(config.DATABASE_URL ? { url: config.DATABASE_URL } : { directory: config.DATA_DIRECTORY });
    const store = new RecordStore(database, { budgetSeconds: config.LOCAL_BUDGET_SECONDS, maxMeetingSeconds: config.MAX_MEETING_SECONDS, maxConcurrentMeetings: config.MAX_CONCURRENT_MEETINGS, hostedBudgetSeconds: config.HOSTED_BUDGET_SECONDS });
    api = await createApi({ store, identities: [{ ownerId: config.LOCAL_OWNER_ID, token: config.LOCAL_API_TOKEN }],
      ...(config.ENABLE_HOSTED_MEETINGS ? { hosted: {
        provider: new AttendeeProvider(config.ATTENDEE_API_KEY), publicUrl: config.PROVIDER_PUBLIC_URL,
        webhookSecret: config.ATTENDEE_WEBHOOK_SECRET, callbackPort: config.PROVIDER_CALLBACK_PORT,
        synthesizer: config.LIVE_SPEECH_PROVIDER === 'gemini' ? new GeminiSpeechSynthesizer({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_LIVE_MODEL, voice: config.GEMINI_VOICE }) : new WindowsSpeechSynthesizer(),
      } } : {}),
    });
    await api.app.listen(config.PORT, config.HOST);
    console.log(JSON.stringify({ event: 'api.ready', url: `http://${config.HOST === '::1' ? '[::1]' : config.HOST}:${config.PORT}`, mode: config.ENABLE_HOSTED_MEETINGS ? 'hosted-enabled' : 'local', agent: 'OutOfOffice', ...(config.ENABLE_HOSTED_MEETINGS ? { callbackPort: config.PROVIDER_CALLBACK_PORT } : {}) }));
    let stopping = false;
    const shutdown = async () => { if (stopping) return; stopping = true; try { await api?.close(); await database?.close(); } finally { await release(); } };
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
  } catch (error) { await api?.close(); await database?.close(); await release(); throw error; }
}
main().catch(error => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED') console.error('Another OutOfOffice process owns this workspace. Stop it before starting a replacement.');
  else console.error('OutOfOffice could not start. Run pnpm setup:local and pnpm providers:check; check configuration, database access, and whether the port is in use.');
  process.exitCode = 1;
});
