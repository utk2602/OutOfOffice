# Audio transport

`@outofoffice/voice-sdk` accepts signed PCM16 little-endian mono audio at 16 kHz or 24 kHz. It does not infer encodings, remove WAV headers or resample. Adapters must convert other formats before using this package.

`PcmPacketizer` accepts aligned chunks up to 200 ms and emits 20 ms frames by default (640 bytes at 16 kHz; 960 bytes at 24 kHz). It retains less than one frame between chunks. `finish()` emits the remaining samples without silence padding. Sequence and timestamps derive from sample counts, so input chunk boundaries cannot change timing. Frame buffers are copied to isolate producer memory.

`AudioPlayback` is created for one meeting and generation, with a `PlaybackGate`, a permit, an `AudioSink` and a function returning current approved source versions. It accepts frames of at most 40 ms. Its producer calls `push(frame)` and then `finish()`, while the consumer runs `run()` concurrently. `run()` may be called once. A producer must stop when `push()` returns false. Malformed or discontinuous frames throw `AudioProtocolError` and cancel the generation.

Queued audio defaults to at most 200 ms, excluding the frame currently being sent. Overflow discards the whole queue and closes the generation. Output is paced using a monotonic clock. A delay greater than 100 ms cancels stale output. Gate and source-version checks run immediately before every send, including after pacing waits. Interrupting, muting or replacing the permit prevents the next frame; unmuting never restores old audio.

An owner mute/leave/revoke handler should both update the gate and call `playback.cancel()` to abort an in-flight send or an idle consumer immediately. `AudioSink.send(frame, signal)` must honor abort before writing and must not defer a write beyond cancellation. Send timeout defaults to 100 ms and input inactivity timeout to 1 second. Provider adapters must bound their own network buffers as well.

On abnormal termination the sink is asked to flush. Flush returns `confirmed`, `unsupported` or `failed`; it has a 100 ms timeout. This is an internal contract, not a claim about a meeting provider's cancellation support. A successful send counts transmitted duration only, not audible speech. Stopping provider-buffered playback still requires validation with the actual provider.

Run `pnpm test:audio` for deterministic synthetic fixtures covering variable chunk boundaries, endianness, stream continuity, pacing, backpressure, source changes, mute/revoke/interruption, expiry, transport failure and timeout. Timing is simulated for scheduling tests; these tests do not establish real-world audible latency or speech quality.

`WindowsSpeechSynthesizer` uses the installed Windows stock voice via `System.Speech`, yielding raw 24 kHz PCM. The fixed PowerShell program receives approved text through JSON on stdin; text is never interpolated into shell code. Rendering is limited to 15 seconds of processing and 30 seconds of output. Cancellation kills the renderer. Raw PCM is kept in memory, with explicit WAV export available through `pcmToWav`. `pnpm speech:check` renders a synthetic sentence silently; it requires access to the Windows voice installation. On other operating systems, text mode and synthetic transport tests remain available.

The stream API follows Microsoft's [SetOutputToAudioStream documentation](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.setoutputtoaudiostream).
