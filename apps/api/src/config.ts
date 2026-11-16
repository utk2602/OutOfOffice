import { z } from 'zod';

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
});
export function loadEnvironment() {
  try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const result = environmentSchema.safeParse(process.env);
  if (!result.success) throw new Error(`Invalid local configuration (${result.error.issues.map(issue => issue.path.join('.')).join(', ')}). Run pnpm setup:local and check .env.`);
  return result.data;
}
