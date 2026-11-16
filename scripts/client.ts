import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnvironment } from '../apps/api/src/config.ts';
import { pcmToWav } from '../packages/voice-sdk/src/index.ts';
import { LocalClient, ApiError } from './client-lib.ts';

const help = `OutOfOffice local agent CLI

pnpm agent create-agent --owner Alex [--topics "project status,blockers"]
pnpm agent agents | history | approvals | usage | health
pnpm agent add-fact <agentId> --title Title --topic "project status" --text "Approved fact" [--approve]
pnpm agent facts <agentId>
pnpm agent update-fact <factId> --file patch.json
pnpm agent update-agent <agentId> --file patch.json
pnpm agent delete-fact <factId>
pnpm agent delete-agent <agentId>
pnpm agent meeting <agentId> --authorize [--sources id,id] [--duration 300] [--title Standup] [--key retry-key]
pnpm agent ask <meetingId> "OutOfOffice, what is the status?" [--speaker Sam] [--speak]
pnpm agent render <meetingId> <responseId> --out answer.wav
pnpm agent mute|unmute|interrupt|leave|revoke <meetingId>
pnpm agent show|summary|export|watch <meetingId> [--out file.json]
pnpm agent resolve <followUpId> "Owner response"
pnpm agent dismiss <followUpId>
pnpm agent delete-meeting <meetingId>

Facts are private unless --approve explicitly makes them meeting-shareable.
--speak plays the stock Windows voice; render explicitly saves a WAV file.
All meetings are local simulations. No Google Meet bot is dispatched.`;

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  owner: { type: 'string' }, topics: { type: 'string' }, prohibited: { type: 'string' },
  title: { type: 'string' }, topic: { type: 'string' }, text: { type: 'string' }, approve: { type: 'boolean' },
  sources: { type: 'string' }, duration: { type: 'string' }, authorize: { type: 'boolean' }, key: { type: 'string' },
  speaker: { type: 'string' }, speak: { type: 'boolean' }, out: { type: 'string' }, file: { type: 'string' }, help: { type: 'boolean' },
} });
function required(value: string | undefined, label: string): string { if (!value) throw new Error(`${label} is required. Run pnpm agent --help.`); return value; }
const part = (index: number) => encodeURIComponent(required(positionals[index], `Argument ${index}`));
async function payload() { return JSON.parse(await readFile(required(values.file, '--file'), 'utf8')); }

async function render(client: LocalClient, meetingId: string, responseId: string): Promise<Buffer> {
  const response = await client.request(`/api/v1/meetings/${meetingId}/responses/${responseId}/audio`, 'POST', undefined, {}, AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]));
  const reader = response.body!.getReader(); const chunks: Buffer[] = []; let bytes = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    bytes += chunk.value.length;
    if (bytes > 1_440_000) { await reader.cancel(); throw new Error('Audio exceeded the local output limit.'); }
    chunks.push(Buffer.from(chunk.value));
  }
  const permission = await client.json<{ allowed: boolean }>(`/api/v1/meetings/${meetingId}/responses/${responseId}/permission`);
  if (!permission.allowed) throw new Error('Speech was interrupted or its permission expired; partial audio was discarded.');
  return pcmToWav(Buffer.concat(chunks));
}

async function play(client: LocalClient, meetingId: string, responseId: string, wav: Buffer): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Local audible playback currently requires Windows. Use render --out to export a WAV instead.');
  const script = '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $stream = New-Object System.IO.MemoryStream(,$bytes); $player = New-Object System.Media.SoundPlayer($stream); try { $player.PlaySync() } finally { $player.Dispose(); $stream.Dispose() }';
  const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  let ended = false;
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', () => { ended = true; reject(new Error('Could not start local playback.')); });
    child.once('close', code => { ended = true; code === 0 ? resolve() : reject(new Error('Local playback stopped.')); });
  });
  const kill = () => { child.kill(); };
  controller.signal.addEventListener('abort', kill, { once: true }); process.once('exit', kill);
  child.stdin.on('error', () => undefined); child.stdin.end(wav.toString('base64'));
  const monitor = async () => {
    while (!ended) {
      await delay(100); if (ended) return;
      controller.signal.throwIfAborted();
      const permissionResponse = await client.request(`/api/v1/meetings/${meetingId}/responses/${responseId}/permission`, 'GET', undefined, {}, AbortSignal.any([controller.signal, AbortSignal.timeout(100)]));
      const permission = await permissionResponse.json() as { allowed: boolean };
      if (!permission.allowed) throw new Error('Playback stopped because the floor or source permission changed.');
    }
  };
  try { await Promise.race([exit, monitor()]); }
  finally { child.kill(); controller.signal.removeEventListener('abort', kill); process.off('exit', kill); }
}

async function main() {
  const command = positionals[0];
  if (!command || values.help || command === 'help') { console.log(help); return; }
  const config = loadEnvironment();
  const client = new LocalClient(`http://${config.HOST === '::1' ? '[::1]' : config.HOST}:${config.PORT}`, config.LOCAL_API_TOKEN);
  let output: unknown;
  switch (command) {
    case 'health': output = await client.json('/health/ready'); break;
    case 'agents': output = await client.json('/api/v1/agents'); break;
    case 'history': output = await client.json('/api/v1/meetings'); break;
    case 'approvals': output = await client.json('/api/v1/approvals'); break;
    case 'usage': output = await client.json('/api/v1/usage'); break;
    case 'create-agent': output = await client.json('/api/v1/agents', 'POST', { ownerName: required(values.owner, '--owner'), allowedTopics: (values.topics ?? 'project status,blockers').split(',').map(topic => topic.trim()), prohibitedTopics: values.prohibited?.split(',').map(topic => topic.trim()) ?? [] }); break;
    case 'facts': output = await client.json(`/api/v1/agents/${part(1)}/knowledge`); break;
    case 'add-fact': output = await client.json(`/api/v1/agents/${part(1)}/knowledge`, 'POST', { title: required(values.title, '--title'), topic: required(values.topic, '--topic'), text: required(values.text, '--text'), approved: values.approve ?? false, sensitivity: values.approve ? 'MEETING' : 'PRIVATE' }); break;
    case 'update-fact': output = await client.json(`/api/v1/knowledge/${part(1)}`, 'PATCH', await payload()); break;
    case 'update-agent': output = await client.json(`/api/v1/agents/${part(1)}`, 'PATCH', await payload()); break;
    case 'delete-fact': output = await client.json(`/api/v1/knowledge/${part(1)}`, 'DELETE'); break;
    case 'delete-agent': output = await client.json(`/api/v1/agents/${part(1)}`, 'DELETE'); break;
    case 'meeting': {
      if (!values.authorize) throw new Error('Use --authorize to confirm this local meeting may use your selected approved facts.');
      const agentId = part(1);
      const sources = values.sources?.split(',') ?? (await client.json<any[]>(`/api/v1/agents/${agentId}/knowledge`)).filter(fact => fact.approved && fact.sensitivity === 'MEETING' && (!fact.validUntil || Date.parse(fact.validUntil) > Date.now())).map(fact => fact.id);
      output = await client.json('/api/v1/meetings', 'POST', { agentId, title: values.title ?? 'Local standup', sourceIds: sources, maxDurationSeconds: Number(values.duration ?? 300), ownerAuthorized: true }, { 'Idempotency-Key': values.key ?? randomUUID() }); break;
    }
    case 'ask': {
      const meetingId = part(1);
      const response = await client.json<any>(`/api/v1/meetings/${meetingId}/utterances`, 'POST', { eventId: randomUUID(), speaker: values.speaker ?? 'Participant', text: required(positionals[2], 'Question') });
      console.log(JSON.stringify(response, null, 2));
      if (values.speak && response.playbackStatus === 'AUTHORIZED') await play(client, meetingId, response.id, await render(client, meetingId, response.id));
      return;
    }
    case 'render': {
      const wav = await render(client, part(1), part(2)); const file = required(values.out, '--out');
      await writeFile(file, wav, { flag: 'wx' }); console.log(JSON.stringify({ file, bytes: wav.length, format: 'PCM16 mono WAV, 24 kHz' }, null, 2)); return;
    }
    case 'mute': case 'unmute': case 'interrupt': case 'leave': case 'revoke': output = await client.json(`/api/v1/meetings/${part(1)}/${command}`, 'POST'); break;
    case 'show': output = await client.json(`/api/v1/meetings/${part(1)}`); break;
    case 'summary': case 'export': output = await client.json(`/api/v1/meetings/${part(1)}/${command}`); break;
    case 'resolve': output = await client.json(`/api/v1/approvals/${part(1)}/resolve`, 'POST', { answer: required(positionals[2], 'Owner response') }); break;
    case 'dismiss': output = await client.json(`/api/v1/approvals/${part(1)}/resolve`, 'POST', { answer: null }); break;
    case 'delete-meeting': output = await client.json(`/api/v1/meetings/${part(1)}`, 'DELETE'); break;
    case 'watch': {
      const stream = await client.request(`/api/v1/meetings/${part(1)}/events`, 'GET', undefined, {}, controller.signal);
      const reader = stream.body!.getReader(); const decoder = new TextDecoder();
      while (true) { const chunk = await reader.read(); if (chunk.done) break; process.stdout.write(decoder.decode(chunk.value, { stream: true })); } return;
    }
    default: throw new Error(`Unknown command: ${command}. Run pnpm agent --help.`);
  }
  const text = JSON.stringify(output, null, 2);
  if (values.out) { await writeFile(values.out, `${text}\n`, { flag: 'wx' }); console.log(`Saved ${values.out}`); }
  else console.log(text);
}
main().catch(error => {
  if (controller.signal.aborted) { process.exitCode = 130; return; }
  console.error(error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'The command failed.'); process.exitCode = 1;
});
