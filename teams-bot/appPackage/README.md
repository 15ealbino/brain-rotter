# Teams app package

Three files go into the sideloadable zip: `manifest.json`, `color.png` (192×192), `outline.png` (32×32, transparent with a white glyph). Both icons are original artwork generated for this repo.

## Placeholders you must replace

`manifest.json` ships with four `REPLACE-WITH-*` values. `scripts/Package-TeamsApp.ps1` / `package-teams-app.sh` will substitute them for you and refuse to build a zip if any are left.

| Placeholder | What to put there | Where to get it |
|---|---|---|
| `REPLACE-WITH-TEAMS-APP-GUID` (`id`) | A brand-new GUID identifying the **Teams app**. Not the bot id. | `[guid]::NewGuid()` in PowerShell, or `uuidgen` |
| `REPLACE-WITH-ENTRA-APP-ID` (`bots[0].botId`, `webApplicationInfo.id`) | The Entra ID **application (client) id** — the same value as `Bot:AppId` | printed by `scripts/Register-BotApp.ps1` |
| `REPLACE-WITH-BOT-HOSTNAME` (`validDomains`) | Hostname of `Bot:BotBaseUrl`, no scheme | e.g. `bot.contoso.com` |

## Why the manifest looks the way it does

**`supportsCalling: true`** is the switch that makes Teams route call and meeting signalling to the bot's `callbackUri`. Without it the app installs fine, can be added to a meeting, and then silently never receives a call notification. This is the single most common reason a calling bot "does nothing".

**`supportsVideo: false`** on purpose. The bot opens an audio socket only. Claiming video makes Teams negotiate video streams the bot would then have to decode in software (the media platform does not use the GPU), at real CPU cost, for nothing.

**`manifestVersion: 1.19`** because it is broadly accepted by tenant admin centres for sideloading and supports application-context RSC (which needs ≥ 1.6). Newer schema versions work too — bump `manifestVersion` and `$schema` together.

**RSC permissions.** These are *resource-specific* consent: the meeting organizer or a presenter grants them for one meeting when the app is added, rather than an admin granting them tenant-wide. The four requested here were checked against the current [supported RSC permissions](https://learn.microsoft.com/microsoftteams/platform/graph-api/rsc/resource-specific-consent) list and are all valid in **application** context:

| Permission | Why |
|---|---|
| `Calls.JoinGroupCalls.Chat` | join the call attached to this meeting |
| `Calls.AccessMedia.Chat` | receive the media streams |
| `OnlineMeeting.ReadBasic.Chat` | read the meeting subject for the recording title |
| `OnlineMeetingParticipant.Read.Chat` | read the roster so participants can be named |

Note the RSC names use plural `Calls.JoinGroupCalls.Chat` while the tenant-wide equivalent is singular `Calls.JoinGroupCall.All`. That inconsistency is Microsoft's, not a typo here.

RSC is *complementary* to the tenant-wide `Calls.*.All` application permissions the bot also needs — it is not a replacement, and it is not what authorises recording. `Calls.AccessMedia.All` plus a successful `updateRecordingStatus` is what authorises recording.

Permissions that look relevant but are **delegated-only** and therefore cannot be used by this bot: `OnlineMeetingIncomingAudio.Detect.Chat`, `OnlineMeetingActiveSpeaker.Read.Chat`, `OnlineMeetingAudioVideo.Stream.Chat`.

## Building the zip

```powershell
pwsh ./scripts/Package-TeamsApp.ps1 -BotAppId <entra-app-id> -BotHostname bot.contoso.com
```

```bash
./scripts/package-teams-app.sh --bot-app-id <entra-app-id> --hostname bot.contoso.com
```

Both write `teams-bot/dist/brain-rotter-recorder.zip`. Upload it in Teams → Apps → **Manage your apps** → **Upload an app** → **Upload a custom app**.
