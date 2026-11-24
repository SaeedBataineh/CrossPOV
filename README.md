# CrossPOV

Save your best VALORANT plays with one hotkey. If a streamer was in your
match, CrossPOV automatically finds the fight on their stream and clips it
from their POV.

> **Status: step 4 (first part).** Hotkey clips, match data, and automatic
> streamer clips from Twitch VODs work. Still to come in step 4: the shared
> streamer list, VOD archive sites, YouTube/Kick, and stream-delay correction.

CrossPOV never reads game memory, injects code or talks to the game client.
It only records your screen, like OBS.

## Download (Windows)

1. Open the repository's **Actions** tab → **Build Windows app** → the latest
   successful run.
2. Download **CrossPOV-windows** under *Artifacts* and unzip it:
   - `CrossPOV-portable.zip`: unzip and run `CrossPOV.exe`, nothing to install.
     Keep `ffmpeg.exe` next to it.
   - `CrossPOV_x.y.z_x64-setup.exe`: installer with a Start menu entry.

Pushing a tag like `v0.1.0` also attaches both files to a GitHub Release.

Needs Windows 10 or 11 with Microsoft Edge WebView2. It's built into Windows 11,
and the installer adds it if it's missing.

## What works in this version

**Recording (step 2)**
- Starts recording automatically when VALORANT opens and stops when it closes
- Replay buffer: press the hotkey (default **F9**) to save the last 15-120 s.
  The clip includes the moment you pressed it.
- GPU encoding (NVIDIA NVENC, AMD AMF, Intel Quick Sync), picked
  automatically. At native resolution, frames go from screen capture to the
  encoder without touching the CPU. If a driver refuses that, CrossPOV
  retries in compatibility mode, then on the CPU.
- **Per-app audio, like OBS**: by default only VALORANT's sound is
  recorded, so Spotify, browser tabs and notifications stay out. Add apps
  such as Discord one by one, each with its own volume and mute. Or pick
  "Everything you hear". Needs Windows 10 version 2004 or newer; older
  versions fall back to everything you hear, and the app tells you.
- Microphone with device choice and volume, on its own track if you like
- Clip sound, "Clip saved" notification, thumbnails, Play / Show in folder /
  Delete, storage limit with oldest-first cleanup
- Tray menu: "Save clip now"

**Match data (step 3)**
- Enter your Riot ID and region in Settings. While VALORANT is open (and for
  10 minutes after), the app asks the CrossPOV server for your latest match
  every 2 minutes and saves new ones. Your PC never contacts Riot.
- Streamer matches shows each match's lobby: players, teams, agents, K/D/A.
- The demo website (`/`) has a "look up a match" box so anyone can try it.

**Streamer clips (step 4)**
- After each match the server checks every other player: does a Twitch
  channel with that name exist, and was it broadcasting when the match
  started? Only those count, which filters out same-name accounts.
- For each streamer, the app finds your fights with them from the kill
  timestamps, converts them to VOD times, and downloads only those seconds
  (yt-dlp). Still-live streams are clipped as soon as the VOD catches up.
- Sub-only VODs are skipped. "Played against a streamer it missed?" lets you
  link a player to a channel by hand.

**App**
- Home, Clips, Streamer matches and Settings screens
- All settings save to `%APPDATA%\app.crosspov.desktop\settings.json`:
  frame rate, resolution, quality, encoder, format, hotkey, clip length,
  audio, streamer clip options, storage and app behaviour
- Tray icon: left-click opens the window; right-click menu has Open,
  Open clip folder, Quit
- Closing the window keeps CrossPOV in the tray and **unloads the UI
  completely** to free memory (turn off in Settings → App)
- Start with Windows (starts hidden in the tray)
- Only one copy runs at a time; launching again brings the window forward

## Develop

Requirements: Node 22+, Rust (stable) and, on Windows, the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

On Windows, fetch FFmpeg once with `pwsh scripts/get-ffmpeg.ps1`.

Testing without VALORANT: set `CROSSPOV_ALWAYS_RECORD=1` to record all the
time, or `CROSSPOV_GAME_EXE=SomeGame.exe` to treat another game as the game.

```bash
npm install
npm run tauri dev     # run the desktop app with hot reload
npm run dev           # UI only, in the browser (settings use localStorage)
npm run tauri build   # release build: src-tauri/target/release/crosspov.exe
cargo test --manifest-path src-tauri/Cargo.toml   # includes a real record-and-save test when FFmpeg is installed
```

FFmpeg ships as an LGPL build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).

### Server (Cloudflare Worker)

One Worker serves the demo website and the API (`wrangler.jsonc`):

| Route | What |
|---|---|
| `GET /api/health` | `{ ok, matchData }`: whether the match-data key is set |
| `GET /api/latest-match?region=eu&name=…&tag=…` | Latest match for a Riot ID |
| `GET /api/match/<region>/<id>` | A match by id |
| `GET /api/match/<region>/<id>/streamers?me=<puuid>` | Players who were live on Twitch during the match, with VOD and offset |
| `GET /api/match/<region>/<id>/channel?login=…&puuid=…` | Check a channel the user names for a player |
| everything else | The demo website (the app's UI) |

Cloudflare rebuilds it on every push (`npm run build`, then `npx wrangler deploy`).
Secrets, set in the Cloudflare dashboard (Settings → Variables and Secrets,
type **Secret**), never in the repo: `HENRIK_API_KEY`, `TWITCH_CLIENT_ID`,
`TWITCH_CLIENT_SECRET`.
Responses are cached at the edge (latest match 60 s, finished matches 7 days).

```bash
npm run test:server        # server tests (fake upstream)
npx wrangler dev           # run it locally; put HENRIK_API_KEY in a .dev.vars file (gitignored)
```

### Layout

| Path | What |
|---|---|
| `src/` | React + TypeScript UI (also runs as a website for the Riot review demo) |
| `src/lib/settings.ts` | Settings type and defaults; must match `src-tauri/src/settings.rs` |
| `src/lib/backend.ts` | Calls into Rust in the app, localStorage fallback in the browser |
| `src-tauri/src/lib.rs` | Tray, window lifecycle, settings commands |
| `src-tauri/src/settings.rs` | Settings storage and validation |
| `src-tauri/src/recorder.rs` | Starts/stops FFmpeg with the game, saves clips from the buffer |
| `src-tauri/src/ffmpeg.rs` | FFmpeg command lines, encoder detection |
| `src-tauri/src/audio.rs` | Audio mixer: game, apps and mic into one clocked stream |
| `src-tauri/src/win_audio.rs` | Windows per-app audio capture, audio app list, beep |
| `src-tauri/src/clips.rs` | Clip folder: list, delete, storage limit |
| `src-tauri/src/matches.rs` | Asks the server for new matches, saves them locally |
| `server/src/` | Cloudflare Worker: API routes, HenrikDev calls, caching |
| `server/test/` | Server tests |
| `src-tauri/src/streamers.rs` | Streamer clips: fights → VOD times → yt-dlp section downloads |
| `scripts/get-ytdlp.ps1` | Downloads the yt-dlp build that ships with the app |
| `scripts/get-ffmpeg.ps1` | Downloads the FFmpeg build that ships with the app |
| `.github/workflows/build-windows.yml` | Builds the `.exe` and installer on Windows |

## Roadmap

1. ~~App skeleton, tray, settings, `.exe` build~~
2. ~~Recorder (GPU encoding, replay buffer, per-app audio) and hotkey clips~~
3. ~~Server with match data~~
4. Streamer detection and VOD sources
5. Public demo website and video, then the Riot API application
6. Sign in with Riot (RSO)
7. Official Riot API

---

CrossPOV isn't endorsed by Riot Games and doesn't reflect the views or
opinions of Riot Games or anyone officially involved in producing or managing
Riot Games properties. Riot Games, and all associated properties are
trademarks or registered trademarks of Riot Games, Inc.
