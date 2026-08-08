# Brain Rotter — Teams meeting recorder

A Microsoft Teams **application-hosted media bot**. You add it to a meeting; it joins as a visible participant, tells Teams it is recording, announces itself in the meeting chat, and captures the meeting audio to a 16 kHz mono WAV that lands in the [Brain Rotter](../README.md) desktop app's library, ready for local whisper.cpp transcription.

It replaces the parent app's desktop-audio capture with something that actually works for meetings: clean server-side audio at the source, no screen-share portal dance, no "did it pick up system audio or just my mic".

> **Status: builds and runs; the media path has never been exercised against a real meeting.**
> The whole solution compiles clean on .NET 8 (verified on Linux, see [Build status](#build-status)), the HTTP surface and the brain-rotter sink are verified end to end, and the WAV output is a valid 16 kHz mono file. But the Real-time Media Platform will not initialize outside x64 Windows Server, so **no audio has ever been captured from an actual Teams call by this code.** Treat the media layer as unproven and read [Deployment reality](#deployment-reality) before you budget time for this.

---

## Contents

- [What it does, exactly](#what-it-does-exactly)
- [Recording consent behaviour](#recording-consent-behaviour) — read this one
- [Prerequisites](#prerequisites)
- [Deployment reality](#deployment-reality) — the thing that trips everyone up
- [Setup walkthrough](#setup-walkthrough)
- [Configuration](#configuration)
- [Running it](#running-it)
- [HTTP API](#http-api)
- [How audio reaches brain-rotter](#how-audio-reaches-brain-rotter)
- [Local development, and its limits](#local-development-and-its-limits)
- [Architecture](#architecture)
- [Build status](#build-status)
- [Troubleshooting](#troubleshooting)
- [Privacy, consent and the law](#privacy-consent-and-the-law)

---

## What it does, exactly

1. You add the **Brain Rotter Recorder** app to a Teams meeting, or POST its join URL to `/api/join`.
2. The bot joins the meeting as itself — an application participant with its own name and icon in the roster. If the meeting admits to lobby, it waits there until an organizer lets it in (or gives up after `LobbyTimeoutSeconds`).
3. Once the call is established, it calls Graph's `updateRecordingStatus(recording)`. **Teams then shows its standard "recording has started" notification to everyone.**
4. Only after that call *succeeds* does it open a file and start capturing. It posts a message in the meeting chat: *"🔴 Brain Rotter Recorder is now recording this meeting."*
5. Audio streams to disk as 16 kHz mono PCM WAV for as long as the meeting runs.
6. When the meeting ends, the bot is removed, everyone leaves, or you POST to `/api/leave/{callId}`: capture stops, `updateRecordingStatus(notRecording)` fires, a stop message goes to the chat, and the recording is committed into brain-rotter's library with `transcription: "none"` so the app offers to transcribe it.

### What it deliberately does not do

- It does not hide itself, suppress the recording indicator, or pretend to be a human.
- It does not join meetings it was not explicitly added to or pointed at. There is no calendar scraping and no discovery.
- It does not send audio or video. Its media socket is receive-only; it cannot be heard.
- It does not upload anything anywhere. Audio goes to a local path, and transcription is whisper.cpp on your machine.

---

## Recording consent behaviour

This is the part that is not optional, so it is worth being precise about.

Microsoft's terms for the Media Access API, quoted verbatim from the [`updateRecordingStatus` reference](https://learn.microsoft.com/graph/api/call-updaterecordingstatus):

> You may NOT use the Media Access API to record or otherwise persist media content from calls or meetings that your application accesses, or data derived from that media content ("record" or "recording"), without first calling the **updateRecordingStatus** API to indicate that recording has begun, and receiving a success reply from that API. If your application begins recording any meeting, it must end the recording prior to calling the **updateRecordingStatus** API to indicate that the recording has ended.

The code is built so that violating this is not something you can do by accident:

- `RecordingConsent` ([`Bot/RecordingConsent.cs`](src/BrainRotter.TeamsBot/Bot/RecordingConsent.cs)) has a private constructor. The only way to get one is `RecordingConsentGate.RequestAsync`, which returns it exclusively after `updateRecordingStatus(recording)` completes without throwing.
- `AudioCaptureSink.StartAsync` ([`Media/AudioCaptureSink.cs`](src/BrainRotter.TeamsBot/Media/AudioCaptureSink.cs)) takes a non-nullable `RecordingConsent` as its first argument. The file handle is opened and the `AudioMediaReceived` handler is subscribed *inside* that method. Before consent there is no file, no subscription, and no reference held to any media buffer.
- The recording folder is not even allocated until consent is granted.

If the call fails, `CallHandler` logs `RECORDING CONSENT DENIED`, leaves the meeting, and persists nothing — no folder, no file, no index row.

On teardown `updateRecordingStatus(notRecording)` is called. If *that* fails it is logged as an error but does not stop the already-captured audio from being finalized; the file is already on disk and losing it would help nobody.

**Two separate notices go out**, and neither substitutes for the other:

| Notice | Driven by | Can it be disabled? |
|---|---|---|
| Teams' own recording banner / "recording has started" toast | `updateRecordingStatus` | **No.** It is a consequence of the API call the bot is required to make. |
| Chat message on start and stop | `MeetingChatAnnouncer` | Yes, `Bot:AnnounceInMeetingChat=false` — but the banner still appears. |

---

## Prerequisites

| | |
|---|---|
| **.NET SDK 8.0** | LTS. `dotnet --version` should print 8.x. Newer SDKs build it too; the project targets `net8.0`. |
| **Microsoft 365 tenant with Global Admin** | You need to grant tenant-wide admin consent for `Calls.AccessMedia.All`. A [Microsoft 365 Developer Program](https://developer.microsoft.com/microsoft-365/dev-program) tenant is the right place to do this. |
| **Azure subscription** | For the Azure Bot resource, and for the Windows Server VM that hosts the media. |
| **A Windows Server host** | x64, ≥ 2 CPU cores, public IP, real DNS name, valid TLS certificate. See below. |
| **PowerShell 7** and the `Microsoft.Graph` module | For the setup script: `Install-Module Microsoft.Graph -Scope CurrentUser` |

---

## Deployment reality

**This is the single biggest thing that trips people up, so it is up front rather than buried.**

An application-hosted media bot has **two independent network paths**, and they have completely different requirements.

```
                    ┌──────────────────────────────────────────┐
                    │            Microsoft Teams               │
                    └───────┬──────────────────────┬───────────┘
                            │                      │
      SIGNALLING            │                      │        MEDIA
      HTTPS/443             │                      │        direct TCP, MTLS
      call notifications    │                      │        the actual audio
      JSON                  │                      │        ports 8445 + 49152-65279
                            │                      │
                            ▼                      ▼
                  ┌───────────────────┐  ┌───────────────────────┐
                  │  POST /api/calls  │  │ Real-time Media       │
                  │  ASP.NET Core     │  │ Platform (native x64) │
                  │                   │  │                       │
                  │  a tunnel CAN     │  │  a tunnel CANNOT      │
                  │  front this       │  │  carry this           │
                  └───────────────────┘  └───────────────────────┘
                            └──────── same Windows Server VM ─────┘
```

### The requirements, plainly

**1. Windows Server. Not Linux, not a container on Linux, not App Service.**
`Microsoft.Graph.Communications.Calls.Media` depends on `Microsoft.Skype.Bots.Media`, which ships x64 **Windows** native libraries. Microsoft's own [requirements page](https://learn.microsoft.com/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots) says production bots "must be deployed on a Windows Server guest Operating System in Azure", and that the bot "can't be deployed as an Azure web app". Supported hosts: IaaS VM, VM Scale Set, Service Fabric, or AKS with Windows nodes.

The C# in this repo compiles fine on Linux — the managed reference assemblies are cross-platform — but `MediaPlatform.Initialize` throws at runtime off Windows. There is no stub or fake covering this; see [Local development](#local-development-and-its-limits).

**2. An instance-level public IP.** Not a load-balancer VIP that fans out. Media is pinned to the exact VM instance that accepted the call, and Teams connects back to *that instance* directly. On a scale set that means a NAT rule per instance; on a single VM, just a public IP on the NIC.

**3. A real DNS name resolving to that IP**, set as `Bot:MediaServiceFqdn`.

**4. A publicly trusted TLS certificate** for that name, installed in `LocalMachine\My` with its private key, thumbprint in `Bot:CertificateThumbprint`. The media platform authenticates to Teams with **MTLS** using this certificate. A self-signed certificate will not work. Let's Encrypt via win-acme is fine.

**5. Firewall / NSG rules.** Inbound from the internet:

| Port(s) | Protocol | What for |
|---|---|---|
| `443` | TCP | Signalling — Graph POSTs call notifications to `/api/calls` |
| `8445` (`Bot:MediaInstancePublicPort`) | TCP | Media platform control channel |
| `49152–65279` | TCP | Media traffic. This is the platform's default `MediaPortRange`. |

Also open these on the **Windows Firewall inside the VM**, not just the NSG. Half the "bot joins but there is no audio" reports are an NSG that was opened and a Windows Firewall that was not.

> The port range is wide because the platform allocates per-call. You can narrow it via `MediaPlatformInstanceSettings.MediaPortRange` if you know your concurrency ceiling, but the default is what is documented and tested.

**6. ngrok / dev tunnels / Cloudflare Tunnel front the signalling endpoint and nothing else.** They speak HTTP. The media leg is a direct TCP connection from Teams' media edge to your public IP on the media port range, authenticated with your certificate. There is no HTTP in it and no tunnel product will carry it. A tunnel gets you as far as "the bot joins the meeting and then no audio ever arrives", which looks like a bug and is not.

**7. Sizing.** Minimum two CPU cores; Microsoft recommends a Dv2-series or anything with four vCPUs. Audio-only (what this bot does) is far cheaper than video, but the media stack does all its codec work on the CPU — no GPU offload.

**8. Keep the SDK current.** Microsoft deprecates `Microsoft.Graph.Communications.Calls.Media` builds server-side: *"The bot must use either the newest available version of the NuGet package, or a version that isn't more than three months old. Older versions of the library are deprecated and don't work after a few months."* Put a recurring reminder on the `PackageReference` in the csproj. A bot that worked in March and mysteriously fails in July is usually this.

---

## Setup walkthrough

### 1. Register the Entra ID application

```powershell
cd teams-bot
pwsh ./scripts/Register-BotApp.ps1 -CreateSecret
```

The script is idempotent — re-running it reuses the existing app, skips permissions already present, and prints exactly what it changed. Add `-WhatIfOnly` to see the plan without writing.

It adds these Microsoft Graph **application** permissions:

| Permission | Verified GUID | Why |
|---|---|---|
| `Calls.AccessMedia.All` | `a7a681dc-756e-4909-b988-f160edc6655f` | Receive the raw audio. Also the least-privileged permission `updateRecordingStatus` accepts. **Without this there is no recording at all.** |
| `Calls.JoinGroupCall.All` | `f6b49018-60ab-4f81-83bd-22caeabfed2d` | Join a scheduled meeting as the application identity. |
| `Calls.JoinGroupCallAsGuest.All` | `fd7ccf6b-3d28-418b-9701-cd10f5cd2fd4` | Join anonymously with a display name. Not used by default. |
| `OnlineMeetings.Read.All` | `c1684f21-1984-47fa-9d61-2dc8c296bb70` | Resolve a meeting from a VTC conference id instead of a join URL. Optional. |

All four GUIDs were checked against the [Microsoft Graph permissions reference](https://learn.microsoft.com/graph/permissions-reference) rather than copied from memory.

**Not requested, on purpose:** `Calls.Initiate.All` / `Calls.InitiateGroupCall.All` would let the app ring people directly, which a bot that only ever joins meetings does not need. `Teamwork.Migrate.All` is the only Graph application permission that can post a chat message and it is scoped to message *migration* — the bot uses the Bot Framework Connector for its announcements instead, which needs no Graph permission at all.

### 2. Grant admin consent

The script prints:

```
https://login.microsoftonline.com/<tenant>/adminconsent?client_id=<app-id>
```

A Global Administrator opens it and approves. Read the consent screen first: `Calls.AccessMedia.All` grants an application the ability to receive audio and video from meetings it is invited to, tenant-wide. Grant it on a tenant you own.

### 3. Create the Azure Bot resource

In the Azure portal → **Create a resource** → **Azure Bot**:

- **Type of App:** Single Tenant (matches `SignInAudience: AzureADMyOrg` from the script)
- **Creation type:** *Use existing app registration*, and paste the app id from step 1
- After creation → **Configuration** → **Messaging endpoint**: `https://<your-host>/api/calls`
- → **Channels** → **Microsoft Teams** → tick **Calling**, and set the calling webhook to the same `https://<your-host>/api/calls`

The calling checkbox on the Teams channel is separate from the messaging endpoint and easy to miss. Without it, Teams never sends call notifications.

### 4. Build and upload the Teams app package

```bash
./scripts/package-teams-app.sh --bot-app-id <app-id> --hostname bot.contoso.com
# or
pwsh ./scripts/Package-TeamsApp.ps1 -BotAppId <app-id> -BotHostname bot.contoso.com
```

Save the generated Teams app GUID and pass it on every rebuild (`--teams-app-id`), or Teams treats each upload as a brand-new app instead of an upgrade.

Upload `dist/brain-rotter-recorder.zip` in Teams → **Apps** → **Manage your apps** → **Upload an app** → **Upload a custom app**.

See [`appPackage/README.md`](appPackage/README.md) for what is in the manifest and why.

### 5. Policy gotchas

- **Custom app upload must be enabled.** Teams admin center → *Teams apps* → *Setup policies* → *Global* → **Upload custom apps: On**. If "Upload a custom app" is missing from the Teams UI, this is why. Policy changes can take a few hours to apply.
- **App permission policies** must allow custom apps, or the app installs for you and nobody else.
- **Anonymous / guest join** must be permitted if you plan to use `Calls.JoinGroupCallAsGuest.All`.
- Meetings with **lobby enabled for everyone** put the bot in the lobby. Somebody has to admit it. The bot waits `LobbyTimeoutSeconds` then leaves.

---

## Configuration

`appsettings.json` holds structure and placeholders only. Real values come from environment variables or .NET user-secrets. Nothing secret is committed.

Copy [`.env.example`](.env.example) — it documents every setting — or:

```bash
cd src/BrainRotter.TeamsBot
dotnet user-secrets set Bot:AppId       "<app-id>"
dotnet user-secrets set Bot:TenantId    "<tenant-id>"
dotnet user-secrets set Bot:AppSecret   "<secret>"
```

Environment variables use `__` for nesting: `Bot__AppSecret`, `BrainRotter__StorageRoot`.

The service validates configuration at startup and exits with a specific message per missing value rather than failing on the first join.

---

## Running it

```powershell
cd teams-bot/src/BrainRotter.TeamsBot
dotnet run -c Release
```

As a Windows service, publish and register with `sc.exe` or NSSM:

```powershell
dotnet publish -c Release -r win-x64 --self-contained false -o C:\brain-rotter-bot
sc.exe create BrainRotterBot binPath= "C:\brain-rotter-bot\BrainRotter.TeamsBot.exe" start= auto
```

Check `GET /healthz`:

```json
{
  "status": "healthy",
  "mediaPlatform": "ready",
  "sink": "brain-rotter",
  "storageRoot": "C:\\Users\\svc\\AppData\\Roaming\\brain-rotter\\recordings",
  "storageWritable": true,
  "activeCalls": 0
}
```

`"mediaPlatform": "unavailable"` means no meeting can be recorded, and `mediaPlatformDetail` says why. The endpoint returns 503 in that state so a load balancer takes the instance out.

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/calls` | Graph call-notification webhook. **Authenticated by the Graph Communications SDK**, not by MVC: the bearer token must be signed by the calling platform, carry `https://graph.microsoft.com` as issuer, name this bot's app id as audience, and include a tenant claim. Verified to return **401** for a missing or forged token. |
| `POST` | `/api/join` | `{"joinUrl": "https://teams.microsoft.com/l/meetup-join/..."}`. Parses thread id, organizer id and tenant id out of the URL and joins. `503` if the media platform is unavailable, `400` for an unparseable URL. |
| `POST` | `/api/leave/{callId}` | Leave and finalize. `404` for an unknown call. |
| `GET` | `/api/calls` | Live calls: state, thread id, whether recording, captured duration, participant count, dropped frames. |
| `GET` | `/healthz` | Liveness plus media-platform and storage status. |

```bash
curl -X POST https://bot.contoso.com/api/join \
  -H 'Content-Type: application/json' \
  -d '{"joinUrl":"https://teams.microsoft.com/l/meetup-join/19%3ameeting_..."}'
```

> `/api/join` and `/api/leave` have **no authentication of their own**. Do not expose them to the internet — bind them to a private interface, put them behind a reverse proxy with auth, or restrict them at the NSG. `/api/calls` and `/healthz` are the only endpoints that need to be publicly reachable.

---

## How audio reaches brain-rotter

The sink writes into the layout documented at the top of [`src/main/recordings.ts`](../src/main/recordings.ts):

```
<storageRoot>/
├── index.json                      list of recordings, newest first
└── <recording-id>/
    ├── audio.wav                   16 kHz mono PCM
    ├── meta.json                   a copy of the index row
    └── speakers.json               speaker attribution (ignored by the app)
```

- **`transcription` is `"none"`** — the same value the app's own `saveRecording()` writes. That is what makes the Library treat it as not-yet-transcribed and offer to run whisper over it.
- **`audioFile` is `"audio.wav"`.** The field exists so the extension can vary; the app resolves playback and transcription through it. Its ffmpeg step (`toWhisperWav`) re-reads whatever is there, and a 16 kHz mono WAV passes through essentially untouched.
- **`id` is a lowercase GUID**, which satisfies the `/^[A-Za-z0-9_-]+$/` guard in `recordingDir()`.
- **Index writes are atomic**: take a cross-process lock, re-read from disk, remove only our own id, append, sort newest-first, write `index.json.tmp`, fsync, rename over the original. Existing rows are never clobbered. Verified with five concurrent commits against an index that already contained a row written by the app — all six rows survived.
- **`meta.json` is always written before the index.** If the index write fails or races, the app's `rebuildIndexFromDisk()` recovers the recording from the folder.

> **Residual race, stated plainly.** The Electron app does not take the bot's lock — it has no idea the bot exists. The lock therefore only serialises bot instances against each other. If the app writes `index.json` in the millisecond window between the bot's read and its rename, the app's row can still be lost. It is recoverable (`meta.json` is on disk and the app rebuilds from it), but closing the window properly needs a change on the Electron side, which is out of scope for this component.

### Where the storage root comes from

Same rules as the app, in order:

1. `BrainRotter:StorageRoot` — explicit override, always wins.
2. `<userData>/settings.json` → `storageRoot`, if non-empty. Exactly what `storageRoot()` in `src/main/settings.ts` reads.
3. `<userData>/recordings`.

`<userData>` follows Electron: `%APPDATA%\brain-rotter` on Windows, `~/.config/brain-rotter` on Linux, `~/Library/Application Support/brain-rotter` on macOS. `BrainRotter:UserDataDir` overrides the base.

### The cross-machine case, honestly

**The bot runs on a Windows Server VM in Azure. The desktop app runs on your laptop. Nothing in this repo moves files between them.**

The sink writes to a path on the *bot's* filesystem. If you leave `BrainRotter:StorageRoot` blank on an Azure VM, recordings pile up in that VM's `%APPDATA%\brain-rotter\recordings` where your laptop will never see them. You have to bridge that gap yourself. Realistic options:

| Option | How | Notes |
|---|---|---|
| **SMB share** | Set `BrainRotter__StorageRoot=\\fileserver\share\brain-rotter`, point the app's Settings → Storage location at the same share | Simplest if both machines are on one network or VPN. The bot's service account needs write access. Two writers on one `index.json` — the atomic write helps, but see the residual race above. |
| **Sync folder** | Bot writes to a OneDrive/Dropbox/Syncthing folder on the VM; app's storage root is the synced copy on the laptop | Easy, but sync is eventually-consistent: a recording appears in the Library minutes later, and two machines editing `index.json` will produce conflict copies. Prefer this only if the app is not also recording. |
| **Scheduled pull** | Bot writes locally; a `robocopy`/`rsync`/`azcopy` job pulls whole `<recording-id>/` folders to the laptop or a share | Most robust. Copy the folder *first*, then let the app rebuild — or copy `meta.json` last so a partially-copied folder is never indexed. |
| **Run the app on the VM** | Storage root is genuinely local | Fine for a headless "record and transcribe" box. You lose the point of the app, which is playback with the brain-rot panels. |

If you only care about transcripts, the simplest thing is: let the bot record to the VM, copy the `<recording-id>` folders down whenever you feel like it, drop them into your local storage root, and let the app rebuild its index from the `meta.json` files.

---

## Local development, and its limits

You can run the service on Linux or macOS with:

```json
"Bot": { "AllowStartWithoutMediaPlatform": true }
```

**What works:** the service starts, `/healthz` reports `degraded` with the reason, `/api/calls` webhook authentication runs and rejects forged tokens, `/api/calls` (GET) and `/api/leave` work, join-URL parsing works, and the entire brain-rotter sink — WAV writing, `meta.json`, atomic index merge, speaker attribution — works and can be exercised directly.

**What does not work:** joining a meeting. `/api/join` returns `503` with the media platform's failure reason. No audio is captured, because the native media stack is not there.

There is **no stub, mock or fake media layer.** That is deliberate: a fake would let this look finished while never having touched a real audio frame. The flag only skips media-platform *initialization* so the rest of the service is reachable; every media code path is the real thing and is only ever exercised on Windows.

Even on Windows, a dev tunnel is only half the story — see [Deployment reality](#deployment-reality). A realistic dev loop is a small Azure Windows VM with a public IP, a DNS name and a Let's Encrypt certificate, deployed to on each change. There is no way around this; it is the shape of the platform.

---

## Architecture

```
teams-bot/
├── appPackage/                 Teams app manifest + original icons
├── scripts/                    Register-BotApp.ps1, packaging scripts
└── src/BrainRotter.TeamsBot/
    ├── Program.cs              DI, config validation, graceful shutdown
    ├── Configuration/          BotOptions, BrainRotterOptions
    ├── Authentication/         outbound Graph tokens + inbound webhook validation
    ├── Bot/
    │   ├── TeamsRecordingBot   Graph Communications client, join/leave, live calls
    │   ├── CallHandler         one meeting: lobby, roster, the consent gate, teardown
    │   ├── RecordingConsent    the type that makes recording-before-consent uncompilable
    │   ├── MeetingJoinUrl      join URL -> thread id / organizer id / tenant id
    │   └── MeetingChatAnnouncer  Bot Framework Connector REST, start/stop messages
    ├── Media/
    │   ├── AudioCaptureSink    socket -> bounded channel -> disk, with backpressure
    │   ├── WhisperWavWriter    streaming 16 kHz mono WAV, sizes patched on close
    │   └── PcmResampler        format conversion for non-Pcm16K configurations
    ├── Sinks/
    │   ├── IRecordingSink      pluggable output
    │   ├── BrainRotterSink     the parent app's layout
    │   ├── RecordingIndexWriter  atomic, concurrency-safe index.json merge
    │   └── StorageRootResolver resolves the root the way the app does
    └── Controllers/            /api/calls, /api/join, /api/leave, /api/calls, /healthz
```

### Notes on a few decisions

**Memory on long meetings.** `AudioMediaReceived` fires on a media thread ~50×/second. The handler copies the unmanaged buffer into a pooled array and drops it into a **bounded** channel (500 frames ≈ 10 s); one background task does the file I/O. When the channel is full — stalled disk, paused VM — frames are dropped and counted rather than queued. A dropped frame is 20 ms of silence in the transcript; an unbounded queue is an OOM that loses the whole meeting. Memory is flat regardless of duration, and the WAV header sizes are patched on close so nothing is held to compute them.

**Mixed vs unmixed audio.** The socket requests **both** (`ReceiveUnmixedMeetingAudio` + `EnableLocalAudioMixingForUnmixed`). Per-participant audio is strictly more information, but Microsoft documents it as *"optimized for machine cognition (e.g., speech recognition) rather than for human perception (such as call recording and playback)"* — and brain-rotter's `RecordingMeta` has exactly one `audioFile` and its player plays exactly one track. So the **mix** is what becomes `audio.wav`, and the unmixed side is used for speaker attribution in `speakers.json`.

**No resampling in the normal path.** The socket asks for `AudioFormat.Pcm16K`, which is already 16 kHz mono 16-bit — precisely what whisper.cpp wants. `PcmResampler` exists for the case where someone reconfigures the socket to 44.1/48 kHz stereo, so the WAV is never mislabelled.

**Chat announcements go through the Bot Framework Connector, not Graph.** Graph only lets an *application* POST to `/chats/{id}/messages` with `Teamwork.Migrate.All`, which is documented as being for message import and would be the wrong permission to ask an admin for. The Connector REST API is the supported route for a bot to speak in a conversation it is part of. It is called directly rather than via the Bot Builder SDK, whose transitive `Microsoft.IdentityModel` versions conflict with the Graph 5.x stack.

---

## Build status

Verified on **Linux** (Linux Mint 22.3, x64) with **.NET SDK 8.0.423**:

```
$ dotnet build -c Release
  Determining projects to restore...
  Restored /home/ealbino/brain-rotter/teams-bot/src/BrainRotter.TeamsBot/BrainRotter.TeamsBot.csproj
  BrainRotter.TeamsBot -> .../bin/Release/net8.0/BrainRotter.TeamsBot.dll

Build succeeded.
    0 Warning(s)
    0 Error(s)
```

`Microsoft.Graph.Communications.Calls.Media` **1.2.0.17950** and `Microsoft.Skype.Bots.Media` **1.31.0.225-preview** restore and compile on Linux — the managed reference assemblies are cross-platform. **Compiling is not running.** The native media stack is x64 Windows only, and everything past `MediaPlatform.Initialize` has never executed.

What has actually been run and verified, on Linux:

- Service starts, validates configuration, and reports `degraded` on `/healthz` with the media-platform reason.
- `POST /api/calls` returns **401** for both a missing bearer token and a forged one.
- `POST /api/join` returns **400** for a malformed URL and **503** when the media platform is unavailable; a real Teams join URL parses to the right thread id, organizer id and tenant id.
- `GET /api/calls` → `200`, `POST /api/leave/<unknown>` → `404`.
- `WhisperWavWriter` produces a file `ffmpeg` reads as `pcm_s16le, 16000 Hz, mono, s16`, duration exact to the sample.
- `BrainRotterSink` + `RecordingIndexWriter`: six concurrent/sequential commits against an index pre-populated with an app-written row left all six rows intact, with correct `meta.json`, `speakers.json` and `transcription: "none"`.

What has **not** been verified: joining a real meeting, `updateRecordingStatus` against live Graph, receiving a single audio frame from Teams, the chat announcement round-tripping through the Bot Connector, the Teams app package installing, or the setup script against a live tenant.

---

## Troubleshooting

**Bot joins but no audio ever arrives.** Almost always the media path. Check, in order: the media ports (`8445` and `49152–65279`) are open on the **NSG *and* the Windows Firewall**; `Bot:MediaServiceFqdn` resolves to this instance's public IP from *outside* the VM; the certificate is in `LocalMachine\My` with its private key and chains to a public root; you are not trying to route media through a tunnel.

**`RECORDING CONSENT DENIED` in the log, bot leaves immediately.** `updateRecordingStatus` failed. Nearly always `Calls.AccessMedia.All` is missing or admin consent was never granted. Re-check the consent URL from the setup script.

**Bot never receives a call notification.** `supportsCalling: true` in the manifest, and the **Calling** tickbox on the Azure Bot's Teams channel with the webhook set to `https://<host>/api/calls`. These are two separate settings and both are needed.

**Bot sits in the lobby forever, then leaves.** Expected when the meeting admits everyone to lobby. Somebody has to admit it, or the organizer can change the meeting's lobby setting.

**"Upload a custom app" is missing in Teams.** Teams admin center → *Teams apps* → *Setup policies* → *Global* → **Upload custom apps: On**. Allow a few hours.

**Worked for months, now every call fails.** Check the `Microsoft.Graph.Communications.Calls.Media` version. Microsoft deprecates builds older than about three months server-side.

**Chat announcement fails, recording works.** Non-fatal by design; the Teams banner is already up. Check the app is actually installed in the meeting and that `Bot:BotConnectorServiceUrl` matches your cloud.

**`storageWritable: false` on `/healthz`.** The service account cannot write the storage root. On a UNC path, remember a Windows service running as `LocalSystem` has no network identity.

**Frames dropped, gaps in the recording.** `GET /api/calls` reports `framesDropped`. The disk is not keeping up. Use a local SSD rather than a network share as the capture target and copy afterwards.

---

## Privacy, consent and the law

**Participants are notified.** Teams shows its own recording notification because the bot calls `updateRecordingStatus`, and the bot posts a message in the meeting chat when recording starts and stops. It appears in the roster under its own name with its own icon. There is no mode in which it records silently, and nothing here should be modified to create one.

**Recording law varies, a lot.** Some jurisdictions require every participant's consent (all-party consent); others require only one party's. Some have specific rules for employee monitoring, works-council notification, or recordings that cross borders. Meetings with people in multiple countries may be subject to several regimes at once. A notification banner is not the same thing as consent, and this software cannot tell you which rules apply to your meeting.

**Your organisation probably has a policy.** Check it before recording a work call. Many employers require explicit approval for third-party recording tools, and "there was a banner" is not a defence against an internal policy.

**Read the Media Access API terms before production use.** They are on the [`updateRecordingStatus` reference page](https://learn.microsoft.com/graph/api/call-updaterecordingstatus) and impose obligations on your *application*, not just on this code. This repo implements the specific requirement it can implement in code — never persisting media without a success reply from that API. The rest is on you.

**What this software does with the audio.** It writes it to a path you configure and does nothing else. No cloud transcription, no telemetry, no third-party service. Transcription is whisper.cpp running on your machine. That is a property of this implementation, not a legal position.

---

## License

MIT, same as the parent project.
