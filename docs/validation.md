# OutOfOffice validation

The implementation includes the local core MVP and an opt-in hosted integration: a personal delegate, owner-scoped facts, version-pinned grants, a guarded responder, offline stock speech, a local microphone harness, persistent records, Attendee bot/caption/audio adapters, transcript-verified Gemini Live speech, a CLI and an authenticated NestJS control API. Hosted behavior is tested with local provider fixtures; actual Google Meet acceptance is pending. UI remains deferred.

The automated suite currently contains 126 passing tests. The synthetic evaluation contains 28 passing cases. Checks run locally; no GitHub Actions workflow is included.

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
- Attendee request contracts, no automatic creation retry, bounded responses, webhook signatures and PCM envelope validation.
- Gemini generation completion, exact transcript matching, multiple audio parts, cancellation and late connection cleanup using a fake Live connector.
- A callback server over actual local HTTP/WebSocket connections: consent/disclosure gates, admitted caption responses, duplicate/revised/stale captions, barge-in, media loss, new-participant consent changes, ambiguous creation, provider deletion failure and restart reconciliation.
- Hosted reservations surviving restart/deletion, pinned provider identity, cross-owner isolation and cumulative hosted budget enforcement.
- `pnpm smoke:built` starts the compiled API against an isolated embedded database, checks authenticated control and cleans up its own generated data. Hosted calls are disabled in that check.

`pnpm eval:agent` runs the checked-in 28-case synthetic regression corpus, including positive answers, unrelated questions, stale/private/ungranted evidence, conflicting facts, commitment requests, echo, mute and revocation. All expected routes must match, and every ANSWER must be an exact concatenation of its cited approved facts. This corpus is small and deterministic. Its pass rate does not estimate general conversational accuracy or live-meeting reliability.

Important limits:

- Answers are extracted verbatim, with conservative lexical routing. There is no LLM, vector retrieval or semantic conflict detector. Conflicting same-title facts are detected; the app cannot prove consistency across arbitrary natural-language sources.
- The default synthetic fixture tests format, routing and interruption. It does not establish naturalness, real microphone accuracy, multi-speaker diarization, echo cancellation or production latency.
- Windows spoken output renders before playing. Gemini Live output is fully buffered for transcript verification before meeting transmission. Neither path has demonstrated the design's latency targets.
- The Windows microphone harness rejects confidence below 0.65. This is a conservative local rule, not a calibrated probability threshold or speaker identity check.
- Stream flush is unsupported for HTTP playback and the documented Attendee socket contract. Interrupted partial hosted playback requests leave. CLI playback checks current permission, but exported files cannot be remotely recalled.
- Embedded PostgreSQL is tested; a separate PostgreSQL server and distributed worker deployment are not acceptance-tested here.
- Authentication is a local bearer secret, with a loopback-only API. Browser sessions and Better Auth belong to the UI phase. Do not publicly expose this server.
- Local simulation usage measures duration; hosted usage reserves and conservatively consumes the full allocation. No vendor free quota or billing has been verified. Provider calls are disabled by default and require explicit configuration and dispatch.
- Meeting content pruning runs at startup. Hosted records with unresolved provider deletion are preserved for reconciliation. Redacted usage metadata remains after content deletion to preserve budget accounting.

The actual Google Meet release gates in `design.md` remain open. They require controlled meetings, provider credentials, participant authorization, tested media behavior, measured end-to-end latency and verified provider retention/cancellation behavior.
