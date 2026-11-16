# OutOfOffice

An explicitly disclosed meeting delegate that answers from approved facts. Core implementation of [the product design](design.md), developed in small, tested commits. The agent is named **OutOfOffice**.

This repository starts with a local laboratory demo. It does not currently join Google Meet. No external API calls or paid services are enabled by default.

Use Node.js 22.12+ (Node 24 LTS recommended) and pnpm 10.12.4. In Windows PowerShell, use `pnpm.cmd` if execution policy blocks `pnpm.ps1`.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:audio
```

Implemented core packages:

- `shared`: strict request contracts, private-by-default facts, supported meeting URL validation.
- `agent-core`: direct-address routing, scoped evidence, conservative deferral, revocable playback permits.
- `voice-sdk`: PCM16 validation and packetization, bounded playback, pacing, per-frame authorization and cancellation.
- `voice-worker`: meeting session runtime, event deduplication, pinned knowledge grants, follow-ups, control commands and guarded speech orchestration.

The responder uses verbatim approved facts. Windows stock speech can render that text offline; `pnpm speech:check` verifies the installed voice without playing sound. It does not call an LLM. Automated audio tests use synthetic tones and fake transports. The audio transport contract and limitations are described in [docs/audio.md](docs/audio.md).

PostgreSQL persistence, scoped grants and transactional dispatch are implemented in `packages/database`. The local API and runnable meeting demo are subsequent commits. No UI or live meeting integration is implemented yet.
