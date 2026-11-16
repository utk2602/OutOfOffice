import { spawn } from 'node:child_process';
import { join } from 'node:path';

export type Recognition = { text: string; confidence: number };
export function parseRecognition(value: unknown): Recognition {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' ||
      !value.text.trim() || value.text.length > 4000 || !('confidence' in value) || typeof value.confidence !== 'number' ||
      !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error('No valid final speech utterance was recognized.');
  return { text: value.text.trim(), confidence: value.confidence };
}

const recognitionScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
Add-Type -AssemblyName System.Speech
$info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq 'en' } | Select-Object -First 1
if (-not $info) { throw 'An offline English recognizer is not installed.' }
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
$stream = $null
try {
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $names = New-Object System.Speech.Recognition.Choices
  $names.Add('Out of office')
  $names.Add('AI delegate')
  $builder = New-Object System.Speech.Recognition.GrammarBuilder
  $builder.Culture = $info.Culture
  $builder.Append($names)
  $builder.AppendDictation()
  $engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($builder)))
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(4)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(5)
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(600)
  if ($request.mode -eq 'microphone') { $engine.SetInputToDefaultAudioDevice() }
  elseif ($request.mode -eq 'pcm') {
    $bytes = [Convert]::FromBase64String([string]$request.pcm)
    $stream = New-Object System.IO.MemoryStream(,$bytes)
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $engine.SetInputToAudioStream($stream, $format)
  } else { throw 'Unsupported input mode.' }
  $result = $engine.Recognize([TimeSpan]::FromSeconds(10))
  if (-not $result) { throw 'No utterance recognized.' }
  @{ text = $result.Text; confidence = [double]$result.Confidence } | ConvertTo-Json -Compress
} finally { $engine.Dispose(); if ($stream) { $stream.Dispose() } }
`;

/** Single-utterance local harness. It does not diarize a meeting or assert speaker identity. */
export class WindowsSpeechRecognizer {
  /** Calling this method is the explicit action that activates the default microphone. */
  listen(signal: AbortSignal): Promise<Recognition> { return this.recognize({ mode: 'microphone' }, signal); }
  recognizePcm(pcm: Buffer, signal: AbortSignal): Promise<Recognition> {
    if (!pcm.length || pcm.length % 2 || pcm.length > 1_440_000) throw new Error('Expected bounded PCM16 mono at 24 kHz.');
    return this.recognize({ mode: 'pcm', pcm: pcm.toString('base64') }, signal);
  }
  private async recognize(input: object, signal: AbortSignal): Promise<Recognition> {
    signal.throwIfAborted();
    if (process.platform !== 'win32') throw new Error('Offline microphone input currently requires Windows and an English recognizer.');
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', recognitionScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let bytes = 0; let settled = false;
      const complete = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
        if (error) { child.kill(); reject(error); } else resolve(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
      };
      const cancel = () => complete(new Error('Speech recognition cancelled.'));
      const timer = setTimeout(() => complete(new Error('Speech recognition timed out.')), 20_000);
      signal.addEventListener('abort', cancel, { once: true });
      child.once('error', () => complete(new Error('Could not start the offline speech recognizer.')));
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16_000) complete(new Error('Recognition output exceeded its limit.')); else chunks.push(chunk); });
      child.stderr.resume(); child.stdin.on('error', () => undefined);
      child.once('close', code => complete(code === 0 ? undefined : new Error('No speech recognized. Check the installed English recognizer and selected input device.')));
      child.stdin.end(JSON.stringify(input));
    });
    return parseRecognition(JSON.parse(result));
  }
}
