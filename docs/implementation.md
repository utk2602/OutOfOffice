# Core implementation decisions

The product and agent name is **OutOfOffice**, superseding the design's working name. The first milestone is the local demo requested by the owner. UI and real hosted meeting dispatch are deferred.

Commit sequence:

1. Workspace, strict input contracts, repeatable checks.
2. Evidence-based responses, turn routing, scoped grants, playback epochs.
3. PCM transport, bounded playback and provider adapters with deterministic replay tests.
4. Durable local control plane, authentication, idempotency, usage, follow-ups and summaries.
5. Runnable CLI demo and integration validation.

Local persistence uses embedded PostgreSQL (PGlite); `DATABASE_URL` selects regular PostgreSQL. This removes the need for a running Docker daemon while preserving relational constraints and SQL. The MVP uses parameterized SQL through a repository boundary instead of adding an unused Prisma layer. Vector retrieval and Redis remain deferred until measured need.

The local responder extracts approved text rather than generating new factual claims. It is deliberately conservative. A native Gemini Live laboratory adapter is separately enabled; its generative audio is not treated as verified readback. Hosted bot creation remains blocked until credentials, consent, retention and cancellation capabilities have been verified. These local checks do not certify behavior in actual meetings.
