# CrossPOV

Save your best VALORANT plays with one hotkey. If a streamer was in your
match, CrossPOV automatically finds the fight on their stream and clips it
from their POV.

> **Status: step 1 of the build plan.** The app shell, tray icon, settings and
> Windows build work. Clips and streamer matches shown in the app are sample
> data until recording (step 2) and streamer detection (step 4) are added.

CrossPOV never reads game memory, injects code or talks to the game client.
It only records your screen, like OBS.

## Download (Windows)

1. Open the repository's **Actions** tab → **Build Windows app** → the latest
   successful run.
2. Download **CrossPOV-windows** under *Artifacts* and unzip it:
   - `CrossPOV.exe`: launch it directly, nothing to install.
   - `CrossPOV_x.y.z_x64-setup.exe`: installer with a Start menu entry.

Pushing a tag like `v0.1.0` also attaches both files to a GitHub Release.

Needs Windows 10 or 11 with Microsoft Edge WebView2. It's built into Windows 11,
and the installer adds it if it's missing.

## What works in this version

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

```bash
npm install
npm run tauri dev     # run the desktop app with hot reload
npm run dev           # UI only, in the browser (settings use localStorage)
npm run tauri build   # release build: src-tauri/target/release/crosspov.exe
cargo test --manifest-path src-tauri/Cargo.toml
```

### Layout

| Path | What |
|---|---|
| `src/` | React + TypeScript UI (also runs as a website for the Riot review demo) |
| `src/lib/settings.ts` | Settings type and defaults; must match `src-tauri/src/settings.rs` |
| `src/lib/backend.ts` | Calls into Rust in the app, localStorage fallback in the browser |
| `src-tauri/src/lib.rs` | Tray, window lifecycle, settings commands |
| `src-tauri/src/settings.rs` | Settings storage and validation |
| `.github/workflows/build-windows.yml` | Builds the `.exe` and installer on Windows |

## Roadmap

1. ~~App skeleton, tray, settings, `.exe` build~~
2. Recorder (GPU encoding, replay buffer) and hotkey clips
3. Server with match data
4. Streamer detection and VOD sources
5. Public demo website and video, then the Riot API application
6. Sign in with Riot (RSO)
7. Official Riot API

---

CrossPOV isn't endorsed by Riot Games and doesn't reflect the views or
opinions of Riot Games or anyone officially involved in producing or managing
Riot Games properties. Riot Games, and all associated properties are
trademarks or registered trademarks of Riot Games, Inc.
