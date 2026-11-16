# Core implementation decisions

The product and agent name is **OutOfOffice**, superseding the design's working name. The first milestone is the local demo requested by the owner. UI and real hosted meeting dispatch are deferred.

Commit sequence:

1. Workspace, strict input contracts, repeatable checks.
2. Evidence-based responses, turn routing, scoped grants, playback epochs.
3. PCM transport, bounded playback and provider adapters with deterministic replay tests.
4. Durable local control plane, authentication, idempotency, usage, follow-ups and summaries.
5. Runnable CLI demo and integration validation.

Local persistence uses embedded PostgreSQL (PGlite); `DATABASE_URL` selects regular PostgreSQL. This removes the need for a running Docker daemon while preserving relational constraints and SQL. The MVP uses parameterized SQL through a repository boundary instead of adding an unused Prisma layer. Vector retrieval and Redis remain deferred until measured need.

The local responder extracts approved text rather than generating new factual claims. It is deliberately conservative. Windows stock speech and an explicit single-utterance microphone harness provide the local audio loop. A future native Gemini Live adapter must remain separate from exact approved readback. Hosted bot creation remains unimplemented until credentials, consent, retention and cancellation capabilities can be verified. These local checks do not certify behavior in actual meetings.

The local API uses a generated bearer secret and rejects browser origins. Better Auth and dashboard sessions are deferred with the UI. The embedded database and worker have a single process owner; PostgreSQL uses an advisory ownership lock and the embedded database directory uses a process lock. Background audio never passes through a durable job queue.
