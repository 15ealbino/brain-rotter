# Brain Rotter

Record a work conference call, transcribe it locally, then replay it with a synced transcript on one side of the screen and brain-rot stimulation panels on the other.

Everything runs on your machine. Meeting audio is never uploaded anywhere — transcription uses a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) build, not a cloud API.

> **Status: early. Working but not finished.** Typecheck, lint and build pass, and the app launches. The record → transcribe → playback path has not been exercised end-to-end against a real meeting yet. See [Known gaps](#known-gaps).

## What it does

**Record** — captures your conference call's system audio (what everyone else says) mixed with your microphone (what you say), so both ends land in the transcript. Live elapsed timer and level meter while recording.

**Transcribe** — converts the recording to 16 kHz mono WAV and runs whisper.cpp over it, producing timestamped segments.

**Play back** — a resizable split view:

```
┌──────────────────────────────┬──────────────────────────────┐
│  TRANSCRIPT                  │  BRAIN ROT                   │
│                              │  [video][flappy][web][run]   │
│  ▸ play / pause / seek       │                              │
│  ▸ speed control             │   ┌────────────────────┐     │
│                              │   │                    │     │
│  00:14  Right, so the Q3     │   │   9:16 panel       │     │
│  00:19  numbers came in ...  │   │                    │     │
│▶ 00:26  ...and that's why    │   │                    │     │
│  00:31  we're pushing the    │   └────────────────────┘     │
│  00:38  launch to November.  │                              │
│                              │   (splittable — stack two)   │
│  [ search transcript ]       │                              │
└──────────────────────────────┴──────────────────────────────┘
```

The segment under the playhead highlights and auto-scrolls into view. Click any segment to seek there. Search filters and jumps.

**Library** — past recordings with date, duration and transcription status.

### The four brain-rot panels

| Panel | What it is |
|---|---|
| **Video** | Shuffles and loop-plays muted clips from a folder you choose, in a vertical 9:16 frame, auto-advancing. |
| **Flappy** | An original side-scrolling bird game on `<canvas>`. Click or space to flap. High score persists. |
| **Web** | An embedded view of any URL you paste into Settings. |
| **Runner** | An original 3-lane endless runner. Arrow keys to switch lane, jump and duck. Speed ramps up. High score persists. |

## A note on content and copyright

The original brief asked for Subway Surfers and TikTok. Those are copyrighted, and both platforms' terms forbid programmatic scraping — so this app ships neither, and never downloads or scrapes third-party content.

Instead: the two games are written from scratch with procedurally generated visuals, borrowing the *genre* and nothing else — no sprites, assets, audio, code or branding from the originals. The video and web panels are empty vessels that play only what you point them at: your own local files, your own pasted links. Whatever you put there is between you and the rights holder.

## Prerequisites

- **Node.js ≥ 20.10** and npm (only needed to build from source)
- **whisper.cpp** — see [Setting up whisper.cpp](#setting-up-whispercpp)
- **Linux:** PipeWire plus a working `xdg-desktop-portal` backend. System-audio capture on Wayland goes through the portal; without it you get microphone-only.
- **Windows:** Windows 10 or later. Desktop audio loopback is built in, no extra setup.
- ffmpeg is **not** required — a static binary ships via the `ffmpeg-static` package.

## Install from source

```bash
git clone https://github.com/15ealbino/brain-rotter.git
cd brain-rotter
npm install
npm run dev
```

`npm run dev` starts Electron with hot reload. For a production run without packaging:

```bash
npm run build && npm start
```

## Building installers

```bash
npm run build:linux   # AppImage + .deb  → release/
npm run build:win     # NSIS .exe        → release/
npm run build:all     # both
```

Cross-building the Windows target from Linux needs Wine installed; building on the matching OS is the reliable path.

### Installing a built artifact

```bash
sudo apt install ./release/brain-rotter_0.1.0_amd64.deb   # Debian/Ubuntu

chmod +x release/Brain-Rotter-0.1.0.AppImage             # any Linux
./release/Brain-Rotter-0.1.0.AppImage
```

On Windows, run the `.exe` from `release/` and follow the installer.

## Setting up whisper.cpp

No binary is vendored — whisper.cpp binaries are large and platform-specific — so Brain Rotter looks for one you installed. It searches, in order: the path you set in Settings, a bundled copy under `resources/whisper/`, your `PATH`, and common install locations. It accepts `whisper-cli`, `whisper-cpp`, `whisper`, or the pre-1.6 `main` name.

**Linux / macOS**

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build && cmake --build build -j --config Release
```

Then add `build/bin` to your `PATH`, or point **Settings → whisper.cpp binary** at `build/bin/whisper-cli`.

**Windows**

Download a release build from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), unzip it, and point **Settings → whisper.cpp binary** at `whisper-cli.exe`.

If no binary is found, the app tells you so with these instructions rather than failing silently.

### Models

Models download on first use from Hugging Face into the app's `userData/models/` directory, with a progress bar. Pick one in Settings:

| Model | Size | Notes |
|---|---|---|
| `tiny.en` | ~75 MB | Fastest, roughest. Fine for a quick skim. |
| `base.en` | ~142 MB | **Default.** Good accuracy/speed balance for meetings. |
| `small.en` | ~466 MB | Better on crosstalk and accents. ~3× slower. |
| `medium.en` | ~1.5 GB | Best quality here. Slow without a GPU build. |

On CPU, `base.en` transcribes at roughly real time — a 30-minute meeting takes about 30 minutes.

## Permissions

**Linux** — starting a recording opens the desktop portal's screen-share picker. Choose the screen or window playing the call; only its audio track is kept, the video is discarded immediately. If the portal is missing or you cancel, recording falls back to microphone-only and says so.

**Windows** — desktop audio is captured via loopback with no picker. Grant microphone access if prompted.

Brain Rotter grants only `media` and `display-capture` permission requests from its own window and denies everything else.

## Configuring the panels

**Settings → Video folder** — choose a directory of `.mp4` / `.webm` files. They play muted, shuffled, on loop. Nothing is downloaded; you supply the files.

**Settings → Web panel URL** — paste any URL. Some sites send headers refusing to be embedded, and the panel will say so when that happens.

**Settings → Storage location** — where recordings and transcripts live. Defaults to `userData/recordings/`. Models always stay in `userData/models/` so they survive a storage move.

## Where your data lives

```
<userData>/
├── recordings/          audio + transcript.json per recording
├── models/              downloaded GGML models
└── settings.json
```

`<userData>` is `~/.config/brain-rotter` on Linux and `%APPDATA%\brain-rotter` on Windows. Recordings and transcripts are gitignored and never leave the machine.

## Troubleshooting

**"whisper.cpp not found"** — install it per the section above, or set the binary path in Settings.

**Transcript is empty or garbage** — check the recording actually captured audio (play it back from the Library). If it's mic-only when you expected the call, the portal likely failed; see permissions.

**Recording captured only my voice** — system audio wasn't available. On Linux, confirm PipeWire is running (`pactl info`) and an `xdg-desktop-portal` backend is installed.

**Model download fails** — it needs network access to `huggingface.co`. You can also drop a `ggml-*.bin` into `userData/models/` by hand.

**Web panel is blank** — that site refuses embedding. Nothing to fix on this end; try a different URL.

**AppImage won't launch** — `chmod +x` it. On some distros you may need `--no-sandbox` or a properly configured user namespace.

## Project structure

```
src/
├── main/                Electron main process
│   ├── index.ts         window, display-media handler, permissions
│   ├── ipc.ts           IPC handlers
│   ├── whisper.ts       binary detection, transcription, JSON parsing
│   ├── modelDownload.ts model catalog + downloader
│   ├── ffmpeg.ts        webm → 16kHz mono wav
│   ├── recordings.ts    recording index + storage
│   ├── settings.ts      persisted settings
│   ├── mediaProtocol.ts custom protocol for serving local media
│   └── errors.ts        typed error class
├── preload/             contextBridge surface
├── shared/              IPC channel + payload types shared by both sides
└── renderer/src/
    ├── screens/         Record, Library, Playback, Settings
    ├── components/      SplitPane, TranscriptPane, BrainRotPane, panels/
    ├── games/           flappy.ts, runner.ts — engine logic
    ├── lib/             recorder.ts (WebAudio mix + MediaRecorder), api, format
    └── state/           app state
```

Security: `contextIsolation: true`, `nodeIntegration: false`, no remote module. The renderer reaches the main process only through typed IPC channels declared in `src/shared/`.

## Recording Teams meetings with a bot instead

Desktop-audio capture works, but it depends on your OS cooperating and it records whatever is coming out of your speakers. For Microsoft Teams there is a cleaner option: **[`teams-bot/`](teams-bot/)** is a C#/.NET Teams meeting-recording bot that you invite to a meeting. It joins as a visible participant, tells Teams it is recording (so Teams shows its own recording notification), announces itself in the meeting chat, and captures the meeting audio server-side as a 16 kHz mono WAV — then writes it straight into this app's recordings library, where it shows up in the Library and transcribes through the same local whisper.cpp path.

It never hides, never joins a meeting it was not added to, and never persists a byte of audio before Graph's `updateRecordingStatus` API has returned success.

The catch is hosting: application-hosted media bots need an x64 **Windows Server** host with a public IP, a real DNS name, a valid TLS certificate, and a wide TCP port range open for media — a tunnel can front the signalling endpoint but cannot carry the media. See **[teams-bot/README.md](teams-bot/README.md)** for the full picture, including the honest version of what happens when the bot and this app are on different machines.

## Known gaps

- Not yet verified end-to-end against a real conference call. Treat the capture path as unproven.
- No automated tests.
- No whisper.cpp binary is vendored into the packaged builds, so a fresh install requires the manual whisper setup above.
- Windows installer has been configured but never actually built or run.
- The `teams-bot/` component compiles clean but its media layer has never captured audio from a real Teams meeting — see its own [status note](teams-bot/README.md#build-status).

## License

MIT
