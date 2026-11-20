import type WebSocket from 'ws';
import { z } from 'zod';
import type { AudioFrame, AudioSink } from '@outofoffice/voice-sdk';
import { botSchema } from './index.ts';

/** Attendee documents no playback flush acknowledgement: transmitted never means heard. */
export class AttendeeAudioSink implements AudioSink {
  constructor(private readonly socket: WebSocket) {}
  async send(frame: AudioFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.socket.readyState !== 1 || this.socket.bufferedAmount > 9600) throw new Error('Meeting audio transport is unavailable or behind.');
    await new Promise<void>((resolve, reject) => {
      const abort = () => { reject(new Error('Meeting audio transmission cancelled.')); };
      signal.addEventListener('abort', abort, { once: true });
      this.socket.send(JSON.stringify({ trigger: 'realtime_audio.bot_output', data: { chunk: frame.pcm.toString('base64'), sample_rate: frame.sampleRateHz } }), error => {
        signal.removeEventListener('abort', abort); error ? reject(new Error('Meeting audio transmission failed.')) : resolve();
      });
    });
  }
  async flush(): Promise<'unsupported'> { return 'unsupported'; }
}
const incoming = z.object({ bot_id: botSchema.shape.id, trigger: z.literal('realtime_audio.mixed'),
  data: z.object({ sample_rate: z.literal(16000), timestamp_ms: z.number().finite().nonnegative(), chunk: z.string().min(4).max(44_000).regex(/^[a-zA-Z0-9+/]+={0,2}$/) }) });
export function parseMedia(value: unknown, botId: string): { timestampMs: number; samples: number } {
  const event = incoming.parse(value);
  if (event.bot_id !== botId) throw new Error('Unexpected meeting audio identity.');
  const pcm = Buffer.from(event.data.chunk, 'base64');
  if (pcm.length > 32_000 || pcm.length % 2 || pcm.toString('ascii', 0, 4) === 'RIFF') throw new Error('Invalid raw meeting PCM.');
  // Validate and immediately discard mixed audio; captions supply attributed text.
  return { timestampMs: event.data.timestamp_ms, samples: pcm.length / 2 };
}
