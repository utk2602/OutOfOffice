# Local control API

The NestJS API binds to loopback only. It accepts CLI bearer authentication, rejects browser Origin headers and unrecognized Host headers, limits JSON bodies to 16 KB, and returns `{ error: { code, message, requestId } }`. `.env` holds one personal workspace's generated token; Better Auth, browser sessions and multi-user account registration are deferred with the UI. Automated tests inject two independent identities to check tenant isolation. Do not expose this development API through a public tunnel.

The local worker is in the API process. An embedded-database directory lock prevents two servers from using the same local database. A PostgreSQL advisory lock provides the single-process ownership check when `DATABASE_URL` is configured. Redis and distributed worker ownership are not implemented.

All paths below start with `/api/v1`.

| Method and path | Behavior |
| --- | --- |
| `GET/POST /agents` | List/create owned delegates; name defaults to OutOfOffice. |
| `GET/PATCH/DELETE /agents/:id` | Read/update/delete a delegate. Settings changes revoke its running meetings. Deletion removes its knowledge and meeting content. |
| `GET/POST /agents/:id/knowledge` | List/create facts. Default approval is false; default sensitivity is PRIVATE. |
| `PATCH/DELETE /knowledge/:id` | Correct/revoke/delete a fact. Content edits clear approval unless explicitly reapproved. Any change invalidates its current meeting version grant. |
| `POST /meetings` | Requires `Idempotency-Key`, `ownerAuthorized: true`, an agent and approved sources. Default provider is `local`; `attendee` additionally requires a validated `meetingUrl`, `participantsConsented: true`, `providerDataAccepted: true` and enabled hosted configuration. |
| `GET /meetings/:id/provider` | Owned hosted attempt, provider state, callback readiness, speech request count, deletion status and first-frame transmission samples. No capabilities or credentials are returned. |
| `POST /meetings/:id/enable-speaking` | Requires `{ participantsConsented: true, disclosureConfirmed: true }`, admission, a caption and connected media. |
| `POST /meetings/:id/reconcile` | Reconcile the existing provider attempt; never creates another bot. |
| `GET /meetings` | Most recent 100 meetings, ordered by start time. |
| `GET /meetings/:id` | State, transcript, responses, provenance and follow-ups. |
| `POST /meetings/:id/utterances` | Local simulations only: submit one finalized attributed transcript event. Hosted text must come from signed provider callbacks. |
| `POST /meetings/:id/mute`, `/unmute`, `/interrupt`, `/leave`, `/revoke` | Owner controls override output; unmute never replays old speech. |
| `POST /meetings/:id/responses/:responseId/audio` | Local simulations only: render approved text as paced raw PCM16 mono at 24 kHz, at most once. Hosted playback is owned by the meeting transport. |
| `GET /meetings/:id/responses/:responseId/permission` | Recheck floor, source validity and session permission for local audible playback. |
| `GET /meetings/:id/transcript`, `/summary`, `/export` | Authorized text, extractive summary and JSON export. |
| `GET /meetings/:id/events` | SSE, beginning with a snapshot. There is no replay buffer; reconnect clients must refetch state. |
| `DELETE /meetings/:id` | Revoke and delete content. Hosted deletion additionally requires confirmed termination and provider data deletion; failures preserve the attempt for retry. |
| `GET /approvals` | Unresolved owner follow-ups. |
| `POST /approvals/:id/resolve` | `{ answer: "text" }` resolves; `{ answer: null }` dismisses. Never automatically speaks. |
| `GET /usage` | Owner consumption/reservations and global budgets, including separate hosted consumed/reserved/remaining allocation fields. Hosted termination consumes the full reserved duration. These are application safeguards, not vendor invoices. |

`GET /health/live` is unauthenticated. `GET /health/ready` requires authentication and checks database access.

Facts are version-pinned at dispatch. Reapproval after an edit authorizes future meetings, not the already-running grant. Start a new meeting to use the revised fact. Meeting transcripts and summaries expire after 30 days; redacted audit events after 90 days. Pruning runs at startup. The usage ledger remains to prevent deletion from refunding consumed usage. Deleting a source does not rewrite historical responses containing that source; delete the corresponding meeting content or agent as well when that text must be removed.

Summary output separates participant statements, delegate drafts, playback status and unresolved questions. Participant statements remain unverified and decisions are not inferred. `TRANSMITTED` means accepted by the local audio transport; it does not certify what anyone heard.

On restart, previously ACTIVE meetings become DISCONNECTED with blocked speech, pending drafts are cancelled and usage is conservatively settled up to the configured duration. They never reconnect or replay automatically. A new meeting needs a new explicit dispatch.

When hosted integration is enabled, a separate loopback callback server accepts only capability-bound `/attendee/:meetingId/:capability/events` POSTs and `/media` WebSocket upgrades. It has no control routes. Events require the project's canonical-JSON HMAC signature and pinned bot ID. Tunnel this callback port only. Hosted restart recovery stops/reconciles old attempts and retains uncertain reservations; it never recreates a bot or grants speech. See [the hosted guide](hosted.md).
