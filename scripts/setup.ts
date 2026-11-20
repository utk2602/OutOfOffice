import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';

const template = await readFile('.env.example', 'utf8');
try {
  await writeFile('.env', template.replace('LOCAL_API_TOKEN=', `LOCAL_API_TOKEN=${randomBytes(32).toString('hex')}`), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a local API secret. External providers remain disabled.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  const existing = await readFile('.env', 'utf8');
  const names = new Set([...existing.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(match => match[1]));
  const missing = template.split(/\r?\n/).filter(line => /^([A-Z][A-Z0-9_]*)=/.test(line) && !names.has(line.slice(0, line.indexOf('='))))
    .map(line => line === 'LOCAL_API_TOKEN=' ? `LOCAL_API_TOKEN=${randomBytes(32).toString('hex')}` : line);
  if (missing.length) {
    await appendFile('.env', `\n# New configuration fields; existing values were preserved.\n${missing.join('\n')}\n`);
    console.log('Added missing configuration fields to .env; existing values were preserved. Hosted meetings remain opt-in.');
  } else console.log('.env already contains the current fields; left it unchanged.');
}
