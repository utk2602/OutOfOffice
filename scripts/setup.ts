import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const template = await readFile('.env.example', 'utf8');
try {
  await writeFile('.env', template.replace('LOCAL_API_TOKEN=', `LOCAL_API_TOKEN=${randomBytes(32).toString('hex')}`), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a local API secret. External providers remain disabled.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  console.log('.env already exists; left it unchanged.');
}
