import { setTimeout as delay } from 'node:timers/promises';
import type { PlaybackGate, PlaybackPermit } from '@outofoffice/agent-core';
import { AudioProtocolError, durationMs, validateFrame, type AudioFrame, type SampleRate } from './audio.ts';

export type FlushResult = 'confirmed' | 'unsupported' | 'failed';
export interface AudioSink {
  /** Honor abort before writing. Resolving means accepted, not confirmed audible. */
  send(frame: AudioFrame, signal: AbortSignal): Promise<void>;
  /** Report cancellation honestly; already buffered provider audio may remain audible. */
  flush(signal: AbortSignal): Promise<FlushResult>;
}
export type StopReason = 'completed' | 'cancelled' | 'permission_revoked' | 'backpressure' |
  'stale_audio' | 'input_timeout' | 'transport_timeout' | 'transport_error';
export type PlaybackResult = {
  reason: StopReason; sentFrames: number; transmittedMs: number; flush: FlushResult | 'not_needed';
};
export type PlaybackClock = { now(): number; sleep(milliseconds: number, signal: AbortSignal): Promise<void> };
const clock: PlaybackClock = {
  now: () => performance.now(),
  sleep: async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); },
};

class DeadlineExceeded extends Error {}

/** Race I/O with abort and timeout, and always abort the losing operation. */
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal): Promise<T> {
  parent.throwIfAborted();
  const child = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new DeadlineExceeded()); child.abort(); }, timeoutMs);
    aborted = () => { reject(parent.reason ?? new Error('Cancelled.')); child.abort(); };
    parent.addEventListener('abort', aborted, { once: true });
  });
  try { return await Promise.race([operation(child.signal), deadline]); }
  finally {
    clearTimeout(timer);
    if (aborted) parent.removeEventListener('abort', aborted);
    child.abort();
  }
}

/** One bounded producer/consumer stream per generation. Never reuse it after cancellation. */
export class AudioPlayback {
  private frames: AudioFrame[] = [];
  private queuedSamples = 0;
  private sequence: number | undefined;
  private streamId: string | undefined;
  private lastEndMs: number | undefined;
  private inputEnded = false;
  private started = false;
  private finished = false;
  private stopReason: StopReason | undefined;
  private readonly abort = new AbortController();
  private wake: (() => void) | undefined;
  private readonly time: PlaybackClock;
  private readonly maxQueuedSamples: number;
  constructor(private readonly options: {
    meetingId: string; generationId: string; sampleRateHz: SampleRate;
    gate: PlaybackGate; permit: PlaybackPermit; sink: AudioSink;
    currentSources: () => Record<string, number>;
    maxQueueMs?: number; maxLatenessMs?: number; idleTimeoutMs?: number; sendTimeoutMs?: number;
    clock?: PlaybackClock;
  }) {
    const queueMs = options.maxQueueMs ?? 200;
    if (![16000, 24000].includes(options.sampleRateHz) || !Number.isFinite(queueMs) || queueMs < 40 || queueMs > 500) {
      throw new AudioProtocolError('Invalid playback buffer configuration.');
    }
    for (const value of [options.maxLatenessMs ?? 100, options.idleTimeoutMs ?? 1000, options.sendTimeoutMs ?? 100]) {
      if (!Number.isFinite(value) || value <= 0) throw new AudioProtocolError('Invalid playback timeout.');
    }
    this.maxQueuedSamples = options.sampleRateHz * queueMs / 1000;
    this.time = options.clock ?? clock;
  }
  push(frame: AudioFrame): boolean {
    if (this.finished || this.inputEnded || this.abort.signal.aborted) return false;
    try {
      validateFrame(frame);
      if (frame.meetingId !== this.options.meetingId || frame.generationId !== this.options.generationId ||
          frame.sampleRateHz !== this.options.sampleRateHz || (this.streamId !== undefined && frame.streamId !== this.streamId) ||
          (this.sequence !== undefined && frame.sequence !== this.sequence + 1) ||
          (this.lastEndMs !== undefined && Math.abs(frame.timestampMs - this.lastEndMs) > 0.1)) {
        throw new AudioProtocolError('Mismatched generation, stream or audio sequence.');
      }
      if (this.queuedSamples + frame.pcm.length / 2 > this.maxQueuedSamples) {
        this.stop('backpressure');
        return false;
      }
      this.frames.push({ ...frame, pcm: Buffer.from(frame.pcm) });
      this.queuedSamples += frame.pcm.length / 2;
      this.sequence = frame.sequence;
      this.streamId = frame.streamId;
      this.lastEndMs = frame.timestampMs + durationMs(frame);
      this.wake?.();
      return true;
    } catch (error) {
      this.stop('transport_error');
      throw error;
    }
  }
  finish(): void { this.inputEnded = true; this.wake?.(); }
  cancel(): void { this.stop('cancelled'); }
  private stop(reason: StopReason): void {
    this.stopReason ??= reason;
    this.abort.abort();
    this.frames = [];
    this.queuedSamples = 0;
    this.wake?.();
  }
  private permitted(): boolean {
    return this.options.gate.allows(this.options.permit, this.options.currentSources());
  }
  private async next(): Promise<AudioFrame | null> {
    if (!this.frames.length && !this.inputEnded) {
      await bounded(async signal => {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { this.wake = undefined; reject(signal.reason); };
          this.wake = () => { signal.removeEventListener('abort', onAbort); this.wake = undefined; resolve(); };
          signal.addEventListener('abort', onAbort, { once: true });
          // A producer may finish while the listener is being installed.
          if (this.frames.length || this.inputEnded) this.wake();
        });
      }, this.options.idleTimeoutMs ?? 1000, this.abort.signal);
    }
    const frame = this.frames.shift();
    if (frame) this.queuedSamples -= frame.pcm.length / 2;
    return frame ?? null;
  }
  async run(): Promise<PlaybackResult> {
    if (this.started) throw new AudioProtocolError('Playback can run only once.');
    this.started = true;
    let sentFrames = 0;
    let transmittedMs = 0;
    let deadline: number | undefined;
    try {
      while (!this.stopReason) {
        if (!this.permitted()) { this.stop('permission_revoked'); break; }
        let frame: AudioFrame | null;
        try { frame = await this.next(); }
        catch (error) {
          if (error instanceof DeadlineExceeded) this.stop('input_timeout');
          throw error;
        }
        if (!frame) break;
        deadline ??= this.time.now();
        if (this.time.now() - deadline > (this.options.maxLatenessMs ?? 100)) { this.stop('stale_audio'); break; }
        const waitMs = deadline - this.time.now();
        if (waitMs > 0) await this.time.sleep(waitMs, this.abort.signal);
        // Recheck after every async boundary immediately before audio is sent.
        if (this.time.now() - deadline > (this.options.maxLatenessMs ?? 100)) { this.stop('stale_audio'); break; }
        if (!this.permitted()) { this.stop('permission_revoked'); break; }
        this.abort.signal.throwIfAborted();
        try { await bounded(signal => this.options.sink.send(frame, signal), this.options.sendTimeoutMs ?? 100, this.abort.signal); }
        catch (error) {
          if (error instanceof DeadlineExceeded) this.stop('transport_timeout');
          throw error;
        }
        sentFrames++;
        transmittedMs += durationMs(frame);
        deadline += durationMs(frame);
      }
    } catch {
      this.stopReason ??= this.abort.signal.aborted ? 'cancelled' : 'transport_error';
    }
    this.finished = true;
    this.frames = [];
    this.queuedSamples = 0;
    this.abort.abort();
    let flush: PlaybackResult['flush'] = 'not_needed';
    if (this.stopReason) {
      try { flush = await bounded(signal => this.options.sink.flush(signal), 100, new AbortController().signal); }
      catch { flush = 'failed'; }
    }
    return { reason: this.stopReason ?? 'completed', sentFrames, transmittedMs, flush };
  }
  get bufferedMs(): number { return this.queuedSamples * 1000 / this.options.sampleRateHz; }
}
