import assert from 'node:assert/strict';
import { WindowsSpeechSynthesizer, WindowsSpeechRecognizer } from '../packages/voice-sdk/src/index.ts';

const chunks: Buffer[] = [];
const recognize = process.argv.includes('--recognize');
for await (const chunk of new WindowsSpeechSynthesizer().synthesize(recognize ? 'Out of office, what is the reconciliation status?' : 'This is OutOfOffice. Validation is pending.', new AbortController().signal)) chunks.push(chunk);
const pcm = Buffer.concat(chunks);
assert.ok(pcm.length > 9600); assert.equal(pcm.length % 2, 0); assert.ok(pcm.some(byte => byte !== 0));
const recognized = recognize ? await new WindowsSpeechRecognizer().recognizePcm(pcm, new AbortController().signal) : null;
console.log(JSON.stringify({ adapter: 'Windows stock voice', sampleRateHz: 24000, samples: pcm.length / 2, durationMs: Math.round(pcm.length / 48), renderedSilently: true, microphoneActivated: false, recognition: recognized }, null, 2));
if (recognized) { assert.ok(recognized.confidence >= 0.65, 'Recognition did not pass the CLI confidence threshold.'); assert.match(recognized.text, /^out of office\b/i); }
