# Local MVP validation

The implementation is a local core MVP: a personal delegate, owner-scoped facts, version-pinned meeting grants, a guarded responder, real offline stock speech, a local microphone harness, persistent records, a CLI and an authenticated NestJS control API. No UI or hosted meeting integration is claimed.

The automated suite currently contains 99 passing tests. The synthetic evaluation contains 28 passing cases. Checks run locally; no GitHub Actions workflow is included.

Verification performed on the development machine:

- TypeScript strict type checking.
- Unit tests for schemas, routing, evidence, playback permits, PCM formats, packetization, pacing, queue bounds, interruption and transport failure.
- Session tests for policy-to-audio orchestration, event deduplication, lifecycle controls, source changes, expiry and cancellation during speech generation.
- Embedded PostgreSQL tests for owner constraints, dispatch races, idempotency, usage, rollback, retention and clean reopen durability.
- HTTP tests with two independent identities for the control workflow, SSE, streaming speech cancellation and deletion.
- A real CLI subprocess test covering creation, dispatch, answering, WAV export, mute/unmute, follow-ups, summary and deletion.
- `pnpm demo` and `pnpm demo --voice`; the latter streams actual stock speech using dummy facts without playing sound.
- A native synthetic speech-to-recognition check with the microphone off. An explicit spoken-name grammar was necessary for the default name.
- A build and startup smoke check of the compiled API.

`pnpm eval:agent` runs the checked-in 28-case synthetic regression corpus, including positive answers, unrelated questions, stale/private/ungranted evidence, conflicting facts, commitment requests, echo, mute and revocation. All expected routes must match, and every ANSWER must be an exact concatenation of its cited approved facts. This corpus is small and deterministic. Its pass rate does not estimate general conversational accuracy or live-meeting reliability.

Important limits:

- Answers are extracted verbatim, with conservative lexical routing. There is no LLM, vector retrieval or semantic conflict detector. Conflicting same-title facts are detected; the app cannot prove consistency across arbitrary natural-language sources.
- The default synthetic fixture tests format, routing and interruption. It does not establish naturalness, real microphone accuracy, multi-speaker diarization, echo cancellation or production latency.
- Local spoken output renders before playing. Live low-latency model audio is a separate adapter milestone.
- The Windows microphone harness rejects confidence below 0.65. This is a conservative local rule, not a calibrated probability threshold or speaker identity check.
- Stream flush is reported as unsupported for HTTP playback. CLI playback checks current permission, but exported files can be played independently and cannot be remotely recalled.
- Embedded PostgreSQL is tested; a separate PostgreSQL server and distributed worker deployment are not acceptance-tested here.
- Authentication is a local bearer secret, with a loopback-only API. Browser sessions and Better Auth belong to the UI phase. Do not publicly expose this server.
- Usage is local simulated duration; no vendor usage, free quota or billing is verified. No provider calls are enabled.
- Meeting content pruning runs at startup. Redacted usage metadata remains after content deletion to preserve budget accounting.

The actual Google Meet release gates in `design.md` remain open. They require controlled meetings, provider credentials, participant authorization, tested media behavior, measured end-to-end latency and verified provider retention/cancellation behavior.
