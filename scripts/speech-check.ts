import assert from 'node:assert/strict';
import { WindowsSpeechSynthesizer } from '../packages/voice-sdk/src/index.ts';

const chunks: Buffer[] = [];
for await (const chunk of new WindowsSpeechSynthesizer().synthesize('This is OutOfOffice. Validation is pending.', new AbortController().signal)) chunks.push(chunk);
const pcm = Buffer.concat(chunks);
assert.ok(pcm.length > 9600); assert.equal(pcm.length % 2, 0); assert.ok(pcm.some(byte => byte !== 0));
console.log(JSON.stringify({ adapter: 'Windows stock voice', sampleRateHz: 24000, samples: pcm.length / 2, durationMs: Math.round(pcm.length / 48), renderedSilently: true }, null, 2));
