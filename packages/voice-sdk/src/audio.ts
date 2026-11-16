export type SampleRate = 16000 | 24000;
export type AudioFrame = Readonly<{
  meetingId: string;
  streamId: string;
  timestampMs: number;
  sampleRateHz: SampleRate;
  pcm: Buffer;
  sequence: number;
  generationId?: string;
}>;

export class AudioProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'AudioProtocolError'; }
}

/** All buffers are signed PCM16, little endian, mono. Conversion happens at adapters. */
export function validatePcm(pcm: Buffer, sampleRateHz: number, maxDurationMs = 200): asserts sampleRateHz is SampleRate {
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 200) throw new AudioProtocolError('Invalid PCM duration limit.');
  if (sampleRateHz !== 16000 && sampleRateHz !== 24000) throw new AudioProtocolError('Unsupported PCM sample rate.');
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2) throw new AudioProtocolError('PCM must contain aligned 16-bit samples.');
  if (pcm.subarray(0, 4).toString('ascii') === 'RIFF') throw new AudioProtocolError('WAV containers are not raw PCM.');
  if (pcm.length > sampleRateHz * 2 * maxDurationMs / 1000) throw new AudioProtocolError('PCM chunk exceeds the duration limit.');
}

export function validateFrame(frame: AudioFrame): void {
  validatePcm(frame.pcm, frame.sampleRateHz, 40);
  if (!frame.meetingId || !frame.streamId || !Number.isFinite(frame.timestampMs) || frame.timestampMs < 0 ||
      !Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
    throw new AudioProtocolError('Audio frame identity or timing is invalid.');
  }
}

export const durationMs = (frame: AudioFrame): number => frame.pcm.length * 1000 / (frame.sampleRateHz * 2);

/** Reblocks aligned variable-size chunks without losing samples or retaining whole utterances. */
export class PcmPacketizer {
  private remainder = Buffer.alloc(0);
  private sequence = 0;
  private emittedSamples = 0;
  private ended = false;
  private readonly frameBytes: number;
  constructor(private readonly identity: {
    meetingId: string; streamId: string; sampleRateHz: SampleRate; timestampMs: number; generationId?: string;
  }, frameMs: 20 | 40 = 20) {
    if (identity.sampleRateHz !== 16000 && identity.sampleRateHz !== 24000) throw new AudioProtocolError('Unsupported sample rate.');
    if (frameMs !== 20 && frameMs !== 40) throw new AudioProtocolError('Unsupported frame duration.');
    this.frameBytes = identity.sampleRateHz * 2 * frameMs / 1000;
  }
  push(pcm: Buffer): AudioFrame[] {
    if (this.ended) throw new AudioProtocolError('Audio stream is closed.');
    validatePcm(pcm, this.identity.sampleRateHz);
    const input = Buffer.concat([this.remainder, pcm]);
    const frames: AudioFrame[] = [];
    let offset = 0;
    while (offset + this.frameBytes <= input.length) {
      frames.push(this.makeFrame(input.subarray(offset, offset + this.frameBytes)));
      offset += this.frameBytes;
    }
    this.remainder = Buffer.from(input.subarray(offset));
    return frames;
  }
  finish(): AudioFrame[] {
    if (this.ended) return [];
    this.ended = true;
    const frames = this.remainder.length ? [this.makeFrame(this.remainder)] : [];
    this.remainder = Buffer.alloc(0);
    return frames;
  }
  private makeFrame(pcm: Buffer): AudioFrame {
    const frame: AudioFrame = {
      ...this.identity,
      timestampMs: this.identity.timestampMs + this.emittedSamples * 1000 / this.identity.sampleRateHz,
      sequence: this.sequence++, pcm: Buffer.from(pcm),
    };
    validateFrame(frame);
    this.emittedSamples += pcm.length / 2;
    return frame;
  }
  get retainedBytes(): number { return this.remainder.length; }
}

/** Synthetic fixtures only: this tone is not a speech synthesizer. */
export function tone(sampleRateHz: SampleRate, milliseconds: number, frequencyHz = 440): Buffer {
  if (![16000, 24000].includes(sampleRateHz) || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 1000 ||
      !Number.isFinite(frequencyHz) || frequencyHz <= 0 || frequencyHz >= sampleRateHz / 2) {
    throw new AudioProtocolError('Invalid synthetic tone parameters.');
  }
  const samples = Math.round(sampleRateHz * milliseconds / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequencyHz * index / sampleRateHz) * 8192), index * 2);
  }
  return pcm;
}
