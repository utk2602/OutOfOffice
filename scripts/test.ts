import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

async function discover(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.filter(entry => entry.name !== 'node_modules').map(entry =>
    entry.isDirectory() ? discover(join(directory, entry.name)) :
      entry.name.endsWith('.test.ts') ? [join(directory, entry.name)] : []));
  return nested.flat();
}
const files = (await Promise.all(['packages', 'apps'].map(async root => {
  try { return await discover(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}))).flat().sort();
if (!files.length) throw new Error('No tests discovered.');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
