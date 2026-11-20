# OutOfOffice

An explicitly disclosed meeting delegate that answers from approved facts. Core implementation of [the product design](design.md), developed in small, tested commits. The agent is named **OutOfOffice**.

The local demo answers from approved facts and can speak offline on Windows. An opt-in Google Meet integration now connects Attendee captions and audio to the same policy gate, with Windows or transcript-verified Gemini Live speech. Hosted calls are disabled by default. The provider path is covered by local contract/integration tests; real meeting acceptance is pending.

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
- `meeting-sdk`: Attendee bot requests, signed webhooks, caption contracts and bounded PCM socket output.
- `voice-worker`: meeting session runtime, event deduplication, pinned knowledge grants, follow-ups, control commands and guarded speech orchestration.

The responder uses verbatim approved facts. Windows stock speech renders that text offline; optional Gemini Live speech is withheld until its output transcript matches the approved text. Automated audio tests use synthetic tones and fake transports. The audio transport contract and limitations are described in [docs/audio.md](docs/audio.md).

PostgreSQL persistence, scoped grants, transactional dispatch and recoverable hosted attempts are implemented in `packages/database`. The NestJS API and CLI cover meeting controls, follow-ups, summaries and provider reconciliation. See [the control API contract](docs/api.md). UI remains deferred.

Start your persistent personal workspace:

```sh
pnpm setup:local
pnpm start
```

In another terminal, run `pnpm agent --help`. `pnpm demo` runs the complete workflow in an isolated in-memory database. `pnpm demo --voice` additionally streams real stock speech silently on Windows.

Follow the [step-by-step quickstart](docs/quickstart.md) for delegate setup, approved facts, questions, controls, spoken answers and exports. [Validation and remaining integration limits](docs/validation.md) describe what is tested.

For actual Google Meet setup, follow [the hosted meeting guide](docs/hosted.md). `pnpm setup:local` adds missing provider fields to an existing `.env` without replacing its values; `pnpm providers:check` checks configuration without external calls. Live acceptance has been deferred by the owner until credentials and a consented meeting are available.

`pnpm agent listen <meetingId> --speak` explicitly captures one local microphone utterance, routes its transcript and speaks an authorized answer. This optional Windows English harness rejects recognition confidence below 0.65; it does not identify meeting speakers. `pnpm speech:check --recognize` tests synthesis and recognition using synthetic audio without opening the microphone.
