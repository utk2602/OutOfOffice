# Core implementation decisions

The product and agent name is **OutOfOffice**, superseding the design's working name. The local demo is implemented. Opt-in hosted dispatch now has provider adapters and integration tests; actual provider acceptance is deferred until the owner supplies credentials and a consented meeting. UI remains deferred.

Commit sequence:

1. Workspace, strict input contracts, repeatable checks.
2. Evidence-based responses, turn routing, scoped grants, playback epochs.
3. PCM transport, bounded playback and provider adapters with deterministic replay tests.
4. Durable local control plane, authentication, idempotency, usage, follow-ups and summaries.
5. Runnable CLI demo and integration validation.

Local persistence uses embedded PostgreSQL (PGlite); `DATABASE_URL` selects regular PostgreSQL. This removes the need for a running Docker daemon while preserving relational constraints and SQL. The MVP uses parameterized SQL through a repository boundary instead of adding an unused Prisma layer. Vector retrieval and Redis remain deferred until measured need.

The responder extracts approved text rather than generating new factual claims. Windows stock speech and an explicit single-utterance microphone harness provide the local audio loop. The Gemini Live adapter receives only permitted response text, buffers the complete bounded generation and compares its output transcription before releasing PCM. It does not decide speaking permission, receive private context or gain tools. Full-turn verification trades latency for conservative output control; real speech and transcription fidelity remain acceptance checks.

The Attendee adapter requests closed captions and no stored recordings. A dedicated callback server verifies per-attempt capabilities, project HMAC signatures and bot identity. Hosted bot attempts are persisted before external creation. Ambiguous creation is reconciled without retries; reservations remain held until termination is confirmed. Hosted allocations are consumed conservatively in full, and deletion requires a provider deletion acknowledgement. Mixed input PCM is validated and immediately discarded; attributed captions supply text, and participant speech events trigger cancellation. The missing documented provider playback-flush acknowledgement requires leaving after interrupted partial output.

The local API uses a generated bearer secret and rejects browser origins. Better Auth and dashboard sessions are deferred with the UI. The embedded database and worker have a single process owner; PostgreSQL uses an advisory ownership lock and the embedded database directory uses a process lock. Background audio never passes through a durable job queue.
