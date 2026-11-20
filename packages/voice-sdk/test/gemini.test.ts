import test from 'node:test';
import assert from 'node:assert/strict';
import type { LiveConnectParameters, LiveServerMessage } from '@google/genai';
import { GeminiSpeechSynthesizer, type LiveConnector } from '../src/gemini.ts';

function harness(events: unknown[], inspect?: (parameters: LiveConnectParameters, text: string) => void) {
  let closed = 0;
  const connect: LiveConnector = async parameters => ({
    close: () => { closed++; },
    sendClientContent: message => {
      inspect?.(parameters, JSON.stringify(message));
      queueMicrotask(() => { for (const event of events) parameters.callbacks.onmessage(event as LiveServerMessage); });
    },
  });
  return { synthesizer: new GeminiSpeechSynthesizer({ apiKey: 'synthetic', model: 'test-live', connect, timeoutMs: 100 }), closed: () => closed };
}
const audio = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(1920).toString('base64') } };
async function collect(synth: GeminiSpeechSynthesizer, text: string, signal = new AbortController().signal) {
  const chunks: Buffer[] = []; for await (const chunk of synth.synthesize(text, signal)) chunks.push(chunk); return Buffer.concat(chunks);
}
test('Gemini output is withheld until the complete transcription matches approved wording', async () => {
  const h = harness([{ serverContent: { modelTurn: { parts: [audio, audio] }, outputTranscription: { text: 'Validation is pending.' }, turnComplete: true } }], (parameters, text) => {
    assert.equal(parameters.config?.outputAudioTranscription !== undefined, true);
    assert.match(text, /Validation is pending/); assert.equal(text.includes('private'), false);
  });
  assert.equal((await collect(h.synthesizer, 'Validation is pending.')).length, 3840);
  assert.equal(h.closed(), 1);
});
test('extra commitments, missing transcription, wrong sample rate and interrupted output release no samples', async () => {
  for (const content of [
    { modelTurn: { parts: [audio] }, outputTranscription: { text: 'Validation is pending. I promise tomorrow.' }, turnComplete: true },
    { modelTurn: { parts: [audio] }, turnComplete: true },
    { modelTurn: { parts: [{ inlineData: { ...audio.inlineData, mimeType: 'audio/pcm;rate=16000' } }] }, outputTranscription: { text: 'Validation is pending.' }, turnComplete: true },
    { interrupted: true },
  ]) {
    const h = harness([{ serverContent: content }]); let yielded = 0;
    await assert.rejects(async () => { for await (const chunk of h.synthesizer.synthesize('Validation is pending.', new AbortController().signal)) yielded += chunk.length; });
    assert.equal(yielded, 0); assert.equal(h.closed(), 1);
  }
});
test('missing turn completion times out and closes the Live session', async () => {
  const h = harness([]); await assert.rejects(collect(h.synthesizer, 'Approved.'), /no audio was released/); assert.equal(h.closed(), 1);
});
test('cancellation during slow connection returns promptly and closes a late socket', async () => {
  let closed = 0;
  const controller = new AbortController();
  const synth = new GeminiSpeechSynthesizer({ apiKey: 'synthetic', model: 'test-live', timeoutMs: 30,
    connect: () => new Promise(resolve => setTimeout(() => resolve({ close: () => { closed++; }, sendClientContent: () => undefined }), 80)) });
  const result = collect(synth, 'Approved.', controller.signal); controller.abort();
  await assert.rejects(result); await new Promise(resolve => setTimeout(resolve, 100)); assert.ok(closed >= 1);
});
