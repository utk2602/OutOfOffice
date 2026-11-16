# OutOfOffice

An explicitly disclosed meeting delegate that answers from approved facts. Core implementation of [the product design](design.md), developed in small, tested commits. The agent is named **OutOfOffice**.

This is a local laboratory MVP. It does not currently join Google Meet. It answers from approved facts and can speak offline on Windows. No external API calls or paid services are enabled.

Use Node.js 22.12+ (Node 24 LTS recommended) and pnpm 10.12.4. In Windows PowerShell, use `pnpm.cmd` if execution policy blocks `pnpm.ps1`.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:audio
pnpm demo
```

Implemented core packages:

- `shared`: strict request contracts, private-by-default facts, supported meeting URL validation.
- `agent-core`: direct-address routing, scoped evidence, conservative deferral, revocable playback permits.
- `voice-sdk`: PCM16 validation and packetization, bounded playback, pacing, per-frame authorization and cancellation.
- `voice-worker`: meeting session runtime, event deduplication, pinned knowledge grants, follow-ups, control commands and guarded speech orchestration.

The responder uses verbatim approved facts. Windows stock speech can render that text offline; `pnpm speech:check` verifies the installed voice without playing sound. It does not call an LLM. Automated audio tests use synthetic tones and fake transports. The audio transport contract and limitations are described in [docs/audio.md](docs/audio.md).

PostgreSQL persistence, scoped grants and transactional dispatch are implemented in `packages/database`. The NestJS API and CLI cover the local meeting workflow. See [the local API contract](docs/api.md). UI and live meeting integration remain deferred.

Start your persistent personal workspace:

```sh
pnpm setup:local
pnpm start
```

In another terminal, run `pnpm agent --help`. `pnpm demo` runs the complete workflow in an isolated in-memory database. `pnpm demo --voice` additionally streams real stock speech silently on Windows.

`pnpm agent listen <meetingId> --speak` explicitly captures one local microphone utterance, routes its transcript and speaks an authorized answer. This optional Windows English harness rejects recognition confidence below 0.65; it does not identify meeting speakers. `pnpm speech:check --recognize` tests synthesis and recognition using synthetic audio without opening the microphone.
