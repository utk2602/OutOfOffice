import { z } from 'zod';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const environmentSchema = z.object({
  HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOCAL_API_TOKEN: z.string().min(32),
  LOCAL_OWNER_ID: z.uuid().default('00000000-0000-4000-8000-000000000001'),
  DATA_DIRECTORY: z.string().min(1).default('.data'),
  DATABASE_URL: z.string().default(''),
  MAX_MEETING_SECONDS: z.coerce.number().int().min(30).max(900).default(900),
  LOCAL_BUDGET_SECONDS: z.coerce.number().int().min(30).max(1_000_000).default(14400),
  MAX_CONCURRENT_MEETINGS: z.coerce.number().int().min(1).max(2).default(1),
  ENABLE_HOSTED_MEETINGS: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  ATTENDEE_API_KEY: z.string().default(''),
  ATTENDEE_WEBHOOK_SECRET: z.string().default(''),
  PROVIDER_PUBLIC_URL: z.string().default(''),
  PROVIDER_CALLBACK_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  HOSTED_BUDGET_SECONDS: z.coerce.number().int().min(30).max(14400).default(900),
  LIVE_SPEECH_PROVIDER: z.enum(['windows', 'gemini']).default('windows'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_LIVE_MODEL: z.string().default(''),
  GEMINI_VOICE: z.string().regex(/^[A-Za-z]{1,40}$/).default('Kore'),
});
export type Environment = z.infer<typeof environmentSchema>;
export function hostedConfigurationIssues(config: Environment): string[] {
  const missing: string[] = [];
  if (!config.ENABLE_HOSTED_MEETINGS) missing.push('ENABLE_HOSTED_MEETINGS=true');
  if (config.ATTENDEE_API_KEY.length < 8) missing.push('ATTENDEE_API_KEY');
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(config.ATTENDEE_WEBHOOK_SECRET) || Buffer.from(config.ATTENDEE_WEBHOOK_SECRET, 'base64').length < 16) missing.push('ATTENDEE_WEBHOOK_SECRET');
  try {
    const url = new URL(config.PROVIDER_PUBLIC_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port || url.hostname === 'localhost' || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) throw new Error();
  } catch { missing.push('PROVIDER_PUBLIC_URL (public HTTPS origin)'); }
  if (config.PROVIDER_CALLBACK_PORT === config.PORT) missing.push('PROVIDER_CALLBACK_PORT (must differ from PORT)');
  if (config.LIVE_SPEECH_PROVIDER === 'gemini') {
    if (!config.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
    if (!/^[a-zA-Z0-9._/-]{1,120}$/.test(config.GEMINI_LIVE_MODEL)) missing.push('GEMINI_LIVE_MODEL');
  } else if (process.platform !== 'win32') missing.push('LIVE_SPEECH_PROVIDER=gemini (Windows speech unavailable on this OS)');
  return missing;
}
export function loadEnvironment() {
  let root = process.cwd();
  while (!existsSync(join(root, 'pnpm-workspace.yaml')) && dirname(root) !== root) root = dirname(root);
  if (!existsSync(join(root, 'pnpm-workspace.yaml'))) root = process.cwd();
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const result = environmentSchema.safeParse(process.env);
  if (!result.success) throw new Error(`Invalid local configuration (${result.error.issues.map(issue => issue.path.join('.')).join(', ')}). Run pnpm setup:local and check .env.`);
  return { ...result.data, DATA_DIRECTORY: resolve(root, result.data.DATA_DIRECTORY) };
}
