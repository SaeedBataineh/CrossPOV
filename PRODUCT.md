# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the repository and the redesign brief (2026-11-26); the product interview was skipped at the user's direction. Confirm or correct any line.

## Platform

web

(A Windows desktop app built with Tauri v2 / WebView2. The same frontend serves the website, with the app running on sample data at `/demo`.)

## Users
VALORANT players on Windows who want to keep their own highlights and see the other side of their fights: the streamer's POV when an opponent or teammate was live on Twitch.

## Product Purpose
CrossPOV keeps a replay buffer running while a game is open. Pressing the hotkey (F9 by default) saves the last N seconds. After each match it checks who was live, finds their Twitch VOD and downloads the streamer's side of every fight with you, so both POVs of a fight can be watched side by side.

## Positioning
It pairs your clip with the streamer's clip of the same fight, matched by round and timestamp from the match data. A plain clipper can't do that.

## Operating Context
Used between matches and after a session, on the same PC that runs the game, often on a second monitor. Sessions are short: check the last match, watch a fight, save or share a clip (Copy for Discord).

## Capabilities and Constraints
- Pages: Home (matches with their clips), Clips, Streamers, Settings (Games, Recording, Hotkey and replay, Streamer clips, Audio, Account and app), the clip Viewer.
- Recorder states: starting, waiting for a game, recording, error, no FFmpeg.
- Minimum window size is 900 × 600.
- Map and agent art loads from media.valorant-api.com, falling back to drawn initials when offline.
- Streamer avatars load through crosspov.com, so the PC never contacts Twitch directly.
- Not endorsed by Riot Games.

## Brand Commitments
- Name: CrossPOV. Voice: plain, short, second person ("Your clip", "they killed you").

## Evidence on Hand
Sample matches, clips and streamers in `src/lib/demoData.ts`. No testimonials, user counts or benchmarks exist; don't invent any.

## Product Principles
- Fights first: the match and its fights are the unit, not the file.
- Both sides of a fight belong together.
- Stay out of the way of the game: fast, quiet, no surprises while playing.
