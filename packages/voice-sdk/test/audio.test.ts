import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackGate } from '@outofoffice/agent-core';
import { AudioPlayback, AudioProtocolError, PcmPacketizer, durationMs, tone, validateFrame, validatePcm,
  type AudioFrame, type AudioSink, type PlaybackClock, type SampleRate } from '../src/index.ts';

function packetizer(sampleRateHz: SampleRate = 24000) {
  return new PcmPacketizer({ meetingId: 'meeting', streamId: 'voice', timestampMs: 1000, sampleRateHz, generationId: 'turn' });
}
function frames(count = 3): AudioFrame[] { return packetizer().push(tone(24000, count * 20)); }
function harness(overrides: Partial<ConstructorParameters<typeof AudioPlayback>[0]> = {}) {
  const gate = new PlaybackGate(Date.now() + 60_000);
  const sent: AudioFrame[] = [];
  const sendTimes: number[] = [];
  let flushes = 0;
  let now = 0;
  const clock: PlaybackClock = {
    now: () => now,
    sleep: async (milliseconds, signal) => { signal.throwIfAborted(); now += milliseconds; },
  };
  const sink: AudioSink = {
    send: async (frame, signal) => { signal.throwIfAborted(); sent.push(frame); sendTimes.push(now); },
    flush: async () => { flushes++; return 'confirmed'; },
  };
  const playback = new AudioPlayback({
    meetingId: 'meeting', generationId: 'turn', sampleRateHz: 24000, gate,
    permit: gate.begin({ fact: 1 })!, currentSources: () => ({ fact: 1 }), sink, clock, ...overrides,
  });
  return { playback, gate, sent, sendTimes, clock, sink, flushes: () => flushes, advance: (ms: number) => { now += ms; } };
}

test('PCM uses the expected sample counts and signed little-endian values', () => {
  assert.equal(tone(16000, 20).length, 640);
  assert.equal(tone(24000, 20).length, 960);
  const pcm = Buffer.alloc(640); pcm.writeInt16LE(-32768, 0); pcm.writeInt16LE(32767, 2);
  validatePcm(pcm, 16000);
  assert.equal(pcm[0], 0); assert.equal(pcm[1], 128); assert.equal(pcm.readInt16LE(2), 32767);
});
test('malformed, oversized and container audio cannot enter the PCM path', () => {
  for (const pcm of [Buffer.alloc(0), Buffer.alloc(3), Buffer.from('RIFF12345678'), Buffer.alloc(16000)]) {
    assert.throws(() => validatePcm(pcm, 16000), AudioProtocolError);
  }
  assert.throws(() => validatePcm(Buffer.alloc(640), 48000), AudioProtocolError);
  assert.throws(() => validatePcm(Buffer.alloc(640), 16000, Number.NaN), AudioProtocolError);
  assert.throws(() => validateFrame({ ...frames(1)[0]!, sequence: -1 }), AudioProtocolError);
});
for (const sampleRate of [16000, 24000] as const) {
  test(`variable ${sampleRate} Hz chunks preserve every sample and timestamp`, () => {
    const source = tone(sampleRate, 95);
    const stream = packetizer(sampleRate);
    const output = [
      ...stream.push(source.subarray(0, 142)),
      ...stream.push(source.subarray(142, 818)),
      ...stream.push(source.subarray(818)), ...stream.finish(),
    ];
    assert.deepEqual(Buffer.concat(output.map(frame => frame.pcm)), source);
    assert.equal(output.length, 5);
    assert.equal(output[4]?.timestampMs, 1080);
    assert.equal(durationMs(output[4]!), 15);
    assert.equal(stream.retainedBytes, 0);
    assert.deepEqual(stream.finish(), []);
    assert.throws(() => stream.push(source.subarray(0, 2)), AudioProtocolError);
  });
}
test('packetizer retains less than a frame and copies producer memory', () => {
  const stream = packetizer();
  stream.push(Buffer.alloc(958, 1)); assert.equal(stream.retainedBytes, 958);
  const chunk = Buffer.alloc(960, 2); const output = stream.push(chunk);
  chunk.fill(3);
  assert.equal(output[0]?.pcm[959], 2); assert.ok(stream.retainedBytes < 960);
});
test('frames are sent at audio time, without a burst, and input memory is isolated', async () => {
  const h = harness(); const input = frames();
  for (const frame of input) h.playback.push(frame);
  const original = Buffer.from(input[0]!.pcm); input[0]!.pcm.fill(0);
  h.playback.finish(); const result = await h.playback.run();
  assert.equal(result.reason, 'completed'); assert.equal(result.sentFrames, 3);
  assert.equal(result.transmittedMs, 60); assert.equal(result.flush, 'not_needed');
  assert.deepEqual(h.sendTimes, [0, 20, 40]);
  assert.deepEqual(h.sent[0]?.pcm, original); assert.equal(h.playback.bufferedMs, 0);
  await assert.rejects(h.playback.run(), AudioProtocolError);
});
test('an asynchronous producer wakes playback and closes an empty stream', async () => {
  const h = harness(); const result = h.playback.run();
  await Promise.resolve(); h.playback.push(frames(1)[0]!); h.playback.finish();
  assert.equal((await result).sentFrames, 1);
  const empty = harness(); const ended = empty.playback.run(); empty.playback.finish();
  assert.equal((await ended).reason, 'completed');
});
test('queue overflow cancels the whole generation instead of keeping stale audio', async () => {
  const h = harness({ maxQueueMs: 40 }); const input = frames();
  assert.equal(h.playback.push(input[0]!), true); assert.equal(h.playback.push(input[1]!), true);
  assert.equal(h.playback.bufferedMs, 40);
  assert.equal(h.playback.push(input[2]!), false); assert.equal(h.playback.bufferedMs, 0);
  const result = await h.playback.run();
  assert.equal(result.reason, 'backpressure'); assert.equal(result.sentFrames, 0); assert.equal(h.flushes(), 1);
});
for (const [label, mutate] of [
  ['meeting', (frame: AudioFrame) => ({ ...frame, meetingId: 'other' })],
  ['generation', (frame: AudioFrame) => ({ ...frame, generationId: 'old' })],
  ['sample rate', (frame: AudioFrame) => ({ ...frame, sampleRateHz: 16000 as const })],
  ['sequence', (frame: AudioFrame) => ({ ...frame, sequence: frame.sequence + 2 })],
  ['timestamp', (frame: AudioFrame) => ({ ...frame, timestampMs: frame.timestampMs + 100 })],
  ['stream', (frame: AudioFrame) => ({ ...frame, streamId: 'other' })],
] as const) {
  test(`a mismatched ${label} cancels playback`, async () => {
    const h = harness(); const input = frames(2); h.playback.push(input[0]!);
    assert.throws(() => h.playback.push(mutate(input[1]!)), AudioProtocolError);
    assert.equal((await h.playback.run()).sentFrames, 0);
  });
}
for (const event of ['mute', 'interrupt', 'revoke', 'new-turn', 'source-revision'] as const) {
  test(`${event} between frames blocks queued output`, async () => {
    const h = harness(); let version = 1;
    const playback = new AudioPlayback({
      meetingId: 'meeting', generationId: 'turn', sampleRateHz: 24000,
      gate: h.gate, permit: h.gate.begin({ fact: 1 })!, currentSources: () => ({ fact: version }),
      sink: h.sink,
      clock: { now: h.clock.now, sleep: async ms => {
        h.advance(ms);
        if (event === 'source-revision') version++;
        else if (event === 'new-turn') h.gate.begin();
        else h.gate[event]();
      } },
    });
    frames().forEach(frame => playback.push(frame)); playback.finish();
    const result = await playback.run();
    assert.equal(result.reason, 'permission_revoked'); assert.equal(result.sentFrames, 1);
    assert.equal(result.flush, 'confirmed'); assert.equal(playback.push(frames(1)[0]!), false);
  });
}
test('unmute never resurrects the old generation', async () => {
  const h = harness(); frames().forEach(frame => h.playback.push(frame)); h.playback.finish();
  h.gate.mute(); h.gate.unmute();
  assert.equal((await h.playback.run()).sentFrames, 0);
});
test('expired grants cannot emit audio', async () => {
  let now = 0; const gate = new PlaybackGate(10, () => now);
  const h = harness({ gate, permit: gate.begin()!, currentSources: () => ({}) });
  frames(1).forEach(frame => h.playback.push(frame)); h.playback.finish(); now = 10;
  assert.equal((await h.playback.run()).reason, 'permission_revoked'); assert.equal(h.sent.length, 0);
});
test('an interrupted waiting consumer settles without needing more input', async () => {
  const h = harness(); const pending = h.playback.run();
  h.playback.cancel(); assert.equal((await pending).reason, 'cancelled');
  assert.equal(h.playback.bufferedMs, 0);
});
test('a stalled producer times out and releases the generation', async () => {
  const h = harness({ idleTimeoutMs: 10 });
  const result = await h.playback.run(); assert.equal(result.reason, 'input_timeout');
  assert.equal(result.sentFrames, 0);
});
test('slow transport is aborted and unsupported provider flush is reported', async () => {
  let aborted = false;
  const h = harness({ sendTimeoutMs: 10, sink: {
    send: async (_frame, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
    flush: async () => 'unsupported',
  } });
  frames(1).forEach(frame => h.playback.push(frame)); h.playback.finish();
  const result = await h.playback.run();
  assert.equal(result.reason, 'transport_timeout'); assert.equal(result.flush, 'unsupported');
  assert.equal(aborted, true); assert.equal(result.sentFrames, 0);
});
test('transport errors and failed flush do not leave queued audio', async () => {
  const h = harness({ sink: {
    send: async () => { throw new Error('Connection lost.'); },
    flush: async () => { throw new Error('No connection.'); },
  } });
  frames().forEach(frame => h.playback.push(frame)); h.playback.finish();
  const result = await h.playback.run();
  assert.equal(result.reason, 'transport_error'); assert.equal(result.flush, 'failed');
  assert.equal(h.playback.bufferedMs, 0);
});
test('delayed output is discarded rather than played after the conversation moves on', async () => {
  const h = harness();
  const playback = new AudioPlayback({
    meetingId: 'meeting', generationId: 'turn', sampleRateHz: 24000,
    gate: h.gate, permit: h.gate.begin()!, currentSources: () => ({}), clock: h.clock,
    sink: { send: async frame => { h.sent.push(frame); h.advance(200); }, flush: h.sink.flush },
  });
  frames().forEach(frame => playback.push(frame)); playback.finish();
  const result = await playback.run(); assert.equal(result.reason, 'stale_audio'); assert.equal(result.sentFrames, 1);
});
test('an event-loop stall during pacing cannot leak stale audio', async () => {
  const h = harness();
  const playback = new AudioPlayback({
    meetingId: 'meeting', generationId: 'turn', sampleRateHz: 24000,
    gate: h.gate, permit: h.gate.begin()!, currentSources: () => ({}), sink: h.sink,
    clock: { now: h.clock.now, sleep: async ms => { h.advance(ms + 200); } },
  });
  frames().forEach(frame => playback.push(frame)); playback.finish();
  assert.equal((await playback.run()).reason, 'stale_audio');
  assert.equal(h.sent.length, 1);
});
