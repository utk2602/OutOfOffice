import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
await access(join(root, 'apps/api/dist/main.js'));
const scratchRoot = resolve(root, '.data'); await mkdir(scratchRoot, { recursive: true });
const directory = await mkdtemp(join(scratchRoot, 'compiled-smoke-'));
const probe = createServer();
await new Promise<void>(resolveReady => probe.listen(0, '127.0.0.1', resolveReady));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(resolveClosed => probe.close(() => resolveClosed()));
const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
  cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
    LOCAL_API_TOKEN: token, LOCAL_OWNER_ID: '00000000-0000-4000-8000-000000000001',
    DATA_DIRECTORY: directory, DATABASE_URL: '', ENABLE_HOSTED_MEETINGS: 'false' },
});
const closed = new Promise<void>(resolveClosed => child.once('close', () => resolveClosed()));
let failedToSpawn = false; child.once('error', () => { failedToSpawn = true; });
const request = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
  method, signal: AbortSignal.timeout(1000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
try {
  let ready = false;
  const startupDeadline = Date.now() + 30_000;
  while (Date.now() < startupDeadline) {
    if (failedToSpawn || child.exitCode !== null) throw new Error('Compiled API exited before readiness.');
    try { const response = await request('/health/ready'); ready = response.ok && (await response.json() as { mode: string }).mode === 'local'; } catch { /* Wait for isolated database startup. */ }
    if (ready) break; await delay(100);
  }
  if (!ready) throw new Error('Compiled API did not become ready.');
  const created = await request('/api/v1/agents', 'POST', { ownerName: 'Synthetic smoke test', allowedTopics: ['project status'] });
  if (!created.ok || (await created.json() as { displayName: string }).displayName !== 'OutOfOffice') throw new Error('Compiled control API failed.');
  console.log(JSON.stringify({ compiledApi: 'ready', embeddedDatabase: 'connected', authenticatedControl: 'passed', hostedCalls: 'disabled' }, null, 2));
} finally {
  child.kill(); await closed;
  if (dirname(resolve(directory)) !== scratchRoot || !basename(directory).startsWith('compiled-smoke-')) throw new Error('Unsafe smoke-test cleanup target.');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const lockPath = `${directory}.lock`;
  try {
    const state = await lstat(lockPath);
    if (!state.isDirectory() || state.isSymbolicLink() || dirname(lockPath) !== scratchRoot) throw new Error('Unexpected smoke-test lock.');
    await rmdir(lockPath); // Only remove an empty lock belonging to this test process.
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
