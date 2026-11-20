# Run a controlled Google Meet test

OutOfOffice now includes an Attendee adapter, signed caption callbacks, bidirectional PCM transport, owner controls, durable bot attempts and an optional Gemini Live speech renderer. Automated tests exercise the entire local HTTP/WebSocket path with a fake provider. Actual Attendee admission, Gemini availability, provider retention and audible behavior still require a controlled meeting test.

The control API stays on port 4000. Only the separate callback server on port 4001 goes through a tunnel. The current workflow uses the CLI; a dashboard and browser login remain deferred.

## Configure accounts and local values

Run from the repository root in Windows PowerShell:

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd setup:local
```

Setup adds missing fields to `.env` without replacing existing values. Fill secrets only in this ignored local file. The following values extend the [local quickstart](quickstart.md).

| Variable | Value and source |
| --- | --- |
| `ENABLE_HOSTED_MEETINGS` | Set to `true` when you are ready to start the callback integration. Default is `false`. |
| `ATTENDEE_API_KEY` | An API key for your Attendee project. Verify that your available trial covers the test before dispatch. |
| `ATTENDEE_WEBHOOK_SECRET` | The base64 signing secret from the same project's **Settings > Webhooks** page. This is different from the API key. See [Attendee webhook verification](https://docs.attendee.dev/guides/webhooks). |
| `PROVIDER_PUBLIC_URL` | The public HTTPS origin printed by your tunnel, for example `https://example.trycloudflare.com`. No path, port, credentials or query string. |
| `PROVIDER_CALLBACK_PORT` | Keep `4001`; the tunnel must target this port. |
| `HOSTED_BUDGET_SECONDS` | Keep `900` for the first experiments. This is a cumulative application allocation, not a vendor billing limit. |
| `LIVE_SPEECH_PROVIDER` | Keep `windows` for offline stock speech on Windows. Set `gemini` to use the guarded Live renderer below. |
| `GEMINI_API_KEY` | Required only with `LIVE_SPEECH_PROVIDER=gemini`. Create it in [Google AI Studio](https://aistudio.google.com/apikey) for an eligible project. |
| `GEMINI_LIVE_MODEL` | Required with Gemini. Use an exact Live model ID available to your account; consult the [current Live API guide](https://ai.google.dev/gemini-api/docs/live). There is no assumed model or automatic fallback. |
| `GEMINI_VOICE` | Keep `Kore` for stock Gemini speech. |

Verify free/trial eligibility and account limits directly with both providers. The app does not enable billing or determine whether a model request is free. It reserves hosted seconds and limits a meeting to 30 speech requests; provider billing and quota remain separate. Use synthetic meeting facts until provider data handling is verified.

`HOST`, `PORT`, `LOCAL_API_TOKEN`, `LOCAL_OWNER_ID`, `DATA_DIRECTORY`, `DATABASE_URL`, `MAX_MEETING_SECONDS`, `LOCAL_BUDGET_SECONDS` and `MAX_CONCURRENT_MEETINGS` retain their local quickstart values. `DATABASE_URL` can stay blank. The obsolete `ENABLE_GEMINI_LAB` field is unused and can be removed from an older `.env`.

## Start the tunnel and API

Install `cloudflared` using [Cloudflare's instructions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/). In terminal 1:

```powershell
cloudflared tunnel --url http://127.0.0.1:4001
```

Copy the generated HTTPS origin into `PROVIDER_PUBLIC_URL`. A Quick Tunnel's hostname changes when it restarts; update `.env` and restart the API before creating another meeting. Keep the tunnel running. Do not put an interactive access/login screen in front of provider callbacks.

In terminal 2:

```powershell
pnpm.cmd providers:check
pnpm.cmd start
```

`providers:check` reports missing configuration names without printing secret values. It performs no network calls and does not verify account access or quota. `start` opens the local API and the callback server when hosted mode is enabled. Starting the app never creates a bot; it reconciles and stops any previously interrupted hosted attempt.

## Create and admit the disclosed delegate

In terminal 3, create a delegate and copy its returned `id`:

```powershell
pnpm.cmd agent create-agent --owner Alex
$agentId = 'paste-the-agent-id'
pnpm.cmd agent add-fact $agentId --title Reconciliation --topic 'project status' --text 'Validation is pending. No delivery date is confirmed.' --approve
```

Open a Google Meet meeting you control. Obtain agreement from every test participant to the disclosed AI delegate and caption processing. Then replace the URL below and dispatch a short test:

```powershell
$meetUrl = 'paste-your-authorized-google-meet-url'
pnpm.cmd agent meeting $agentId --meet $meetUrl --authorize --consent --accept-provider-data --duration 120
$meetingId = 'paste-the-returned-meeting-id'
pnpm.cmd agent provider $meetingId
```

Admit the participant named **Alex's AI Delegate | OutOfOffice**. The bot is configured to post its identity and role in meeting chat. It requests Google Meet English captions, disables stored recordings and debug recordings, and sets provider-side uptime/admission limits. These are requested settings; the real acceptance test must verify provider behavior. Attendee still processes meeting audio/captions and can retain text, events and metadata.

The bot initially stays muted. Have a consenting participant say a short sentence. Check that `provider` reports a joined state, `captionsSeen: true` and `mediaConnected: true`. After verifying the disclosure and consent in the actual meeting:

```powershell
pnpm.cmd agent enable-speaking $meetingId --consent --disclosed
pnpm.cmd agent watch $meetingId
```

In Google Meet, say **"Out of office, what is the reconciliation status?"** The delegate should read the approved fact. A commitment request such as **"Out of office, promise deployment tomorrow"** should defer and create an owner follow-up. Unaddressed conversation should receive no answer. Hosted meetings accept transcripts only from authenticated provider captions; the CLI `ask` and microphone harness are for local simulations.

## Controls and cleanup

```powershell
pnpm.cmd agent mute $meetingId
pnpm.cmd agent unmute $meetingId
pnpm.cmd agent leave $meetingId
pnpm.cmd agent reconcile $meetingId
pnpm.cmd agent provider $meetingId
pnpm.cmd agent summary $meetingId
```

Unmute permits only a fresh question. Media loss, denied collection permission, expiry and termination block output. A new participant after consent closes the session so the owner can establish consent for a new test. The provider has no documented playback-flush acknowledgement: after an interruption with partially transmitted output, OutOfOffice requests leave rather than resuming possibly buffered audio. Audible stop time remains a live acceptance measurement.

Wait until provider status is `ENDED` before deleting content:

```powershell
pnpm.cmd agent delete-meeting $meetingId
```

Deletion first requests removal of provider data. Failure preserves the local attempt and returns an error for retry. Attendee's [data deletion endpoint](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/delete_data) retains metadata; successful local deletion does not claim erasure of that metadata or Gemini's provider-side records.

If creation is `UNCERTAIN`, retain the meeting ID and run `reconcile`. Do not dispatch another bot with a new key. A missing or ambiguous provider lookup keeps the attempt quarantined and its reservation intact. Resolve the existing attempt in the provider dashboard/support before retrying reconciliation. Restart never recreates the bot or resumes speech.

Hosted allocations are consumed in full after confirmed termination, even for shorter meetings, and survive local content deletion. `agent usage` separately reports global hosted consumption, reservations and remaining allocation. These conservative values are application safeguards and do not represent vendor invoices.

## Acceptance and speech limits

The Gemini renderer opens one bounded Live session per permitted response. It receives only approved response text and has no tools or meeting audio feed. It buffers at most 24 seconds of PCM, verifies the complete output transcript against the approved wording, then releases paced audio. A mismatch, missing transcript, interruption or timeout releases no audio. Provider transcription is not an independent verification of every audible sample.

Both Windows rendering and full-turn Gemini verification add latency. `agent provider` includes caption-delay and first-frame transmission samples; they do not measure when participants actually hear sound. Record admission, an approved answer, unrelated conversation, a commitment deferral, mute/revoke, interruption, actual audible timing, maximum duration, restart recovery and deletion results during the live test. The response-latency and reliability targets in `design.md` remain unverified until those measurements exist.
