import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { AudioProtocolError, type SampleRate } from './audio.ts';

// Only this fixed program is executed. User text travels as JSON on stdin, never as shell code.
const renderScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$stream = New-Object System.IO.MemoryStream
try {
  if ($request.voice) { $synth.SelectVoice([string]$request.voice) }
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToAudioStream($stream, $format)
  $synth.Speak([string]$request.text)
  $synth.SetOutputToNull()
  $bytes = $stream.ToArray()
  $output = [Console]::OpenStandardOutput()
  $output.Write($bytes, 0, $bytes.Length)
} finally { $synth.Dispose(); $stream.Dispose() }
`;

/** Offline Windows stock voice. No voice cloning, network request, or participant audio retention. */
export class WindowsSpeechSynthesizer {
  constructor(private readonly voice?: string) {}
  async *synthesize(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    signal.throwIfAborted();
    if (process.platform !== 'win32') throw new Error('Windows speech is unavailable on this platform. Use text mode or provide a speech adapter.');
    if (!text.trim() || text.length > 900) throw new Error('Speech text must contain 1–900 characters.');
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const audio = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', renderScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let bytes = 0; let settled = false;
      const complete = (error?: Error) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        if (error) { child.kill(); reject(error); } else resolve(Buffer.concat(chunks));
      };
      const cancel = () => complete(new Error('Speech rendering cancelled.'));
      const timer = setTimeout(() => complete(new Error('Local speech rendering timed out.')), 15_000);
      signal.addEventListener('abort', cancel, { once: true });
      child.on('error', () => complete(new Error('Could not start Windows speech.')));
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_440_000) complete(new Error('Speech exceeds the 30-second local limit.'));
        else chunks.push(chunk);
      });
      child.stderr.resume(); // Never echo child diagnostics containing user text.
      child.stdin.on('error', () => undefined);
      child.on('close', code => complete(code === 0 && bytes > 0 ? undefined : new Error('Windows speech failed; verify an installed stock voice is available.')));
      child.stdin.end(JSON.stringify({ text, voice: this.voice ?? '' }), 'utf8');
      if (signal.aborted) cancel();
    });
    if (audio.length % 2 || audio.subarray(0, 4).toString('ascii') === 'RIFF') throw new AudioProtocolError('The local voice did not return raw PCM16.');
    for (let offset = 0; offset < audio.length; offset += 9600) {
      signal.throwIfAborted(); yield audio.subarray(offset, offset + 9600);
    }
  }
}

/** Export is explicit; HTTP playback itself uses raw PCM and does not add a WAV header per frame. */
export function pcmToWav(pcm: Buffer, rate: SampleRate = 24000): Buffer {
  if (!pcm.length || pcm.length % 2 || pcm.length > 1_440_000 || (rate !== 16000 && rate !== 24000)) throw new AudioProtocolError('Invalid PCM WAV export.');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
