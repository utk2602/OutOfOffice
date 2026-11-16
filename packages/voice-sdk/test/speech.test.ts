import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav, tone, AudioProtocolError, parseRecognition } from '../src/index.ts';

test('explicit WAV export describes the exact PCM samples and format', () => {
  const pcm = tone(24000, 20); const wav = pcmToWav(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16); assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});
test('WAV export rejects malformed or unbounded output', () => {
  for (const pcm of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(1_440_002)]) assert.throws(() => pcmToWav(pcm), AudioProtocolError);
});
test('recognition accepts final text and validates confidence bounds', () => {
  assert.deepEqual(parseRecognition({ text: ' Out of office, what is the status? ', confidence: 0.8 }), { text: 'Out of office, what is the status?', confidence: 0.8 });
  for (const value of [null, { text: '', confidence: 1 }, { text: 'hello', confidence: NaN }, { text: 'hello', confidence: 1.1 }, { text: 'hello' }]) assert.throws(() => parseRecognition(value));
});
