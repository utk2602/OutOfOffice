import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, RecordStore } from '@outofoffice/database';
import { tone } from '@outofoffice/voice-sdk';
import { createApi } from '../src/server.ts';

test('the real CLI creates, questions, controls, renders and deletes a local meeting', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const identity = { ownerId: randomUUID(), token: randomBytes(32).toString('hex') };
  const db = await Database.open();
  const api = await createApi({ store: new RecordStore(db, { budgetSeconds: 900, maxMeetingSeconds: 900, maxConcurrentMeetings: 1 }), identities: [identity],
    synthesizer: { async *synthesize() { yield tone(24000, 60); } } });
  const directory = await mkdtemp(join(tmpdir(), 'outofoffice-cli-'));
  try {
    await api.app.listen(0, '127.0.0.1'); const port = new URL(await api.app.getUrl()).port;
    const run = async (...args: string[]): Promise<any> => new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/client.ts', ...args], {
        cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: port, LOCAL_API_TOKEN: identity.token, LOCAL_OWNER_ID: identity.ownerId },
        windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', reject); child.once('close', code => {
        if (code !== 0) { reject(new Error(`CLI failed: ${stderr}`)); return; }
        try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error('CLI did not return JSON.')); }
      });
    });
    const agent = await run('create-agent', '--owner', 'Alex');
    const fact = await run('add-fact', agent.id, '--title', 'Reconciliation', '--topic', 'project status', '--text', 'Validation is pending.', '--approve');
    assert.equal(fact.approved, true);
    const meeting = await run('meeting', agent.id, '--authorize');
    const answer = await run('ask', meeting.id, 'OutOfOffice, what is the reconciliation status?'); assert.equal(answer.text, fact.text);
    const output = join(directory, 'answer.wav'); await run('render', meeting.id, answer.id, '--out', output);
    const wav = await readFile(output); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.length, 44 + 2880);
    await run('mute', meeting.id); assert.equal((await run('ask', meeting.id, 'OutOfOffice, what is the status?')).kind, 'IGNORE');
    await run('unmute', meeting.id); await run('ask', meeting.id, 'OutOfOffice, promise deployment tomorrow.');
    const followUp = (await run('approvals'))[0]; await run('resolve', followUp.id, 'I need to check.');
    await run('leave', meeting.id); assert.equal((await run('summary', meeting.id)).unresolvedQuestions.length, 0);
    const exported = await run('export', meeting.id); assert.equal(exported.meeting.status, 'COMPLETED');
    await run('delete-meeting', meeting.id); assert.deepEqual(await run('history'), []);
    assert.equal((await run('usage')).reservedSeconds, 0);
  } finally {
    await api.close(); await db.close();
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('outofoffice-cli-')) throw new Error('Unsafe temporary cleanup target.');
    await rm(target, { recursive: true, force: true });
  }
});
