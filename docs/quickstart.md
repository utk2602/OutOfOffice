# Run OutOfOffice locally

Use Node 22.12+ (24 LTS recommended) and pnpm 10.12.4. In Windows PowerShell, use `pnpm.cmd` if execution policy blocks the `pnpm.ps1` shim. Do not change your machine's execution policy just for this project.

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm start
```

The API listens at `http://127.0.0.1:4000`. `setup:local` generates a random bearer secret in the ignored `.env` file and preserves an existing file. The CLI reads the same local file; you do not need to copy the token into a command. Local PostgreSQL data lives in `.data/postgres`. Docker and model keys are not required. Run only one API process for this workspace. Stop it with Ctrl+C before starting a replacement.

In a second terminal:

```sh
pnpm agent create-agent --owner Alex
```

Copy the returned agent `id` into the next commands in place of `<agentId>`:

```sh
pnpm agent add-fact <agentId> --title Reconciliation --topic "project status" --text "The implementation is complete. Validation is pending; no delivery date is confirmed." --approve
pnpm agent meeting <agentId> --authorize --title "Engineering standup"
```

Copy the returned meeting `id` in place of `<meetingId>`:

```sh
pnpm agent ask <meetingId> "OutOfOffice, what is the reconciliation status?"
pnpm agent ask <meetingId> "OutOfOffice, promise deployment tomorrow."
pnpm agent approvals
pnpm agent mute <meetingId>
pnpm agent unmute <meetingId>
pnpm agent leave <meetingId>
pnpm agent summary <meetingId>
pnpm agent usage
```

The first answer cites its source. The commitment request defers and creates a follow-up. Resolving it with `pnpm agent resolve <followUpId> "Owner response"` records the answer without sending speech. A fact is private unless explicitly approved; indexing it never grants permission. If a fact is edited, start a new authorized meeting to grant the new version.

For spoken answers on Windows:

```sh
pnpm agent ask <meetingId> "OutOfOffice, what is the status?" --speak
pnpm agent listen <meetingId> --speak
```

These require an active, unmuted meeting. `ask --speak` uses the stock Windows voice. `listen` explicitly opens the default microphone for one English utterance and rejects low-confidence recognition. It is an optional laboratory harness, not production meeting transcription. The native voice is rendered before local audible playback; this route is not designed to meet the real-time response-latency targets in the design. During audible playback, the CLI checks permission every 100 ms and stops on changed permission or API loss. Hardware/OS buffering can still affect audible stop time.

Rendering/export is explicit. After an answer, copy its response `id`:

```sh
pnpm agent render <meetingId> <responseId> --out .data/answer.wav
pnpm agent export <meetingId> --out .data/meeting.json
```

A response may be rendered once and must still own the floor. Another participant turn, mute, revocation, expiry or source change invalidates it. `render` saves a WAV and does not play it. Exports contain your authorized meeting data; delete exported files yourself when no longer needed. Output commands refuse to overwrite existing files.

No setup is required for the isolated demonstration:

```sh
pnpm demo
pnpm demo --voice
pnpm speech:check --recognize
```

`demo` starts an ephemeral local API and database, exercises the workflow and shuts both down. `--voice` additionally verifies actual stock speech streaming silently. `speech:check --recognize` benchmarks the synthetic speech loop with the microphone off. Native speech commands need Windows, an installed stock voice and, for recognition, an English speech recognizer. Access may be restricted inside an agent's filesystem sandbox; run them from your normal local terminal if required.

Quality checks and build:

```sh
pnpm typecheck
pnpm test
pnpm eval:agent
pnpm build
pnpm start:built
```

The build emits `apps/api/dist/main.js`. The built API uses the same `.env` and database as development and also requires installed workspace dependencies. Stop the development API before using `start:built`.

`DATABASE_URL` optionally selects an existing PostgreSQL server. This driver and its SQL are type checked; acceptance tests currently run against embedded PostgreSQL. No server is provisioned automatically. The local usage budget measures simulation time and is unrelated to any vendor billing.

Live Google Meet bots, Attendee/Gemini transport, multi-participant STT, native model responses, participant-consent controls, vendor retention verification and the dashboard remain the next integration milestone. Keys alone do not enable them. The current app never dispatches a hosted bot or calls a model API.
