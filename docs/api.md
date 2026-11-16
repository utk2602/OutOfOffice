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
| `POST /meetings` | Local dispatch. Requires `Idempotency-Key`, `ownerAuthorized: true`, an agent and approved source IDs. No hosted provider can be dispatched. |
| `GET /meetings` | Most recent 100 meetings, ordered by start time. |
| `GET /meetings/:id` | State, transcript, responses, provenance and follow-ups. |
| `POST /meetings/:id/utterances` | Submit one finalized attributed local transcript event with a unique eventId. |
| `POST /meetings/:id/mute`, `/unmute`, `/interrupt`, `/leave`, `/revoke` | Owner controls override output; unmute never replays old speech. |
| `POST /meetings/:id/responses/:responseId/audio` | Render approved text and stream paced raw PCM16 little-endian mono at 24 kHz. Each response is renderable at most once. |
| `GET /meetings/:id/responses/:responseId/permission` | Recheck floor, source validity and session permission for local audible playback. |
| `GET /meetings/:id/transcript`, `/summary`, `/export` | Authorized text, extractive summary and JSON export. |
| `GET /meetings/:id/events` | SSE, beginning with a snapshot. There is no replay buffer; reconnect clients must refetch state. |
| `DELETE /meetings/:id` | Revoke, stop the worker and delete meeting content. |
| `GET /approvals` | Unresolved owner follow-ups. |
| `POST /approvals/:id/resolve` | `{ answer: "text" }` resolves; `{ answer: null }` dismisses. Never automatically speaks. |
| `GET /usage` | Actual local seconds, reservations and global remaining budget. These are local safeguards, not vendor usage or billing. |

`GET /health/live` is unauthenticated. `GET /health/ready` requires authentication and checks database access.

Facts are version-pinned at dispatch. Reapproval after an edit authorizes future meetings, not the already-running grant. Start a new meeting to use the revised fact. Meeting transcripts and summaries expire after 30 days; redacted audit events after 90 days. Pruning runs at startup. The usage ledger remains to prevent deletion from refunding consumed usage. Deleting a source does not rewrite historical responses containing that source; delete the corresponding meeting content or agent as well when that text must be removed.

Summary output separates participant statements, delegate drafts, playback status and unresolved questions. Participant statements remain unverified and decisions are not inferred. `TRANSMITTED` means accepted by the local audio transport; it does not certify what anyone heard.

On restart, previously ACTIVE meetings become DISCONNECTED with blocked speech, pending drafts are cancelled and usage is conservatively settled up to the configured duration. They never reconnect or replay automatically. A new meeting needs a new explicit dispatch.
