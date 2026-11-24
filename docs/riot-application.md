# Riot production key application: CrossPOV

Apply at https://developer.riotgames.com → sign in → **Register Product** →
**Production API Key** → game **VALORANT**.

Before submitting, check every box in the checklist at the bottom.

---

## Product name

CrossPOV

## Product URL

https://crosspov.batainehsaeed1.workers.dev

## Description (paste as-is)

CrossPOV is a Windows desktop app for VALORANT players. It keeps a rolling
recording of the player's own screen (standard Windows screen capture,
encoded on the GPU) and saves a clip when the player presses a hotkey. It
does not read game memory, inject code, or communicate with the VALORANT or
Riot client.

After a match has ended, our server requests that match's timeline
(VAL-MATCH-V1). We use it for one feature: finding streamers in the lobby.
For each player, the server checks Twitch's official API for a channel with
that player's name that was broadcasting when the match started. When the
streamer's public VOD is available, the app uses the kill timestamps to
download only the seconds where the user and that streamer fought, so the
user can watch the fight from both sides. Subscriber-only and deleted VODs
are never accessed.

Match data is requested only after a match has ended and is never shown
during a match, so it gives no competitive advantage. API keys stay on our
server (Cloudflare Workers) and are never shipped in the app. Responses are
cached (finished matches for 7 days) and requests are rate-limited per user
to stay well inside our limits. Clips stay on the user's PC; we have no user
accounts, ads or analytics.

We will add Riot Sign-On (RSO) so players opt in by signing in with their
Riot account instead of typing a Riot ID. During development we use a
third-party VALORANT data service; with a production key the server will
call the Riot API directly.

## How reviewers can test it (no download, no account)

1. Open https://crosspov.batainehsaeed1.workers.dev/demo
2. Go to **Streamer matches**.
3. Enter any Riot ID (Name#TAG) that has played recently and pick its region,
   then **Look up**.
4. The page shows that player's latest finished match (map, score, all ten
   players with agent and K/D/A) and, for each other player, whether they were
   streaming on Twitch during the match. When a VOD was found it shows how
   many fights between the two players would be clipped.

The landing page (https://crosspov.batainehsaeed1.workers.dev) explains the
product and its data use; the privacy policy is at `/privacy`.

Demo video (desktop app): [YouTube link, unlisted]

## API usage

| Endpoint | When | Volume |
|---|---|---|
| VAL-MATCH-V1 matchlist by PUUID | Every 2 min while the user's game is open, plus 10 min after it closes | ~1 per user per 2 min while playing; cached 60 s |
| VAL-MATCH-V1 match by id | Once per new match | Cached 7 days |

## Legal notice (also on every page)

CrossPOV isn't endorsed by Riot Games and doesn't reflect the views or
opinions of Riot Games or anyone officially involved in producing or
managing Riot Games properties. Riot Games, and all associated properties
are trademarks or registered trademarks of Riot Games, Inc.

---

## Demo video script (2–3 minutes)

Record with OBS (or CrossPOV itself) at 1080p. Upload to YouTube as
**Unlisted** and paste the link above. No music needed; captions or a short
voice-over are enough.

1. **Intro (10 s).** CrossPOV home screen. "CrossPOV records your own screen
   and clips VALORANT plays. It never touches the game client."
2. **Settings (20 s).** Recording settings (frame rate, encoder), then Audio:
   "VALORANT only", adding Discord, mic. Then Your account: Riot ID and region.
3. **Hotkey clip (30 s).** Start VALORANT. Home shows `REC`. Play a round, press
   F9, show the "Clip saved" notification and the clip in Clips.
4. **After the match (30 s).** Finish the match. Within two minutes it appears
   in Streamer matches: map, score, all ten players. Point out the Streamer
   column.
5. **Streamer clip (40 s).** Best with a friend who streams on Twitch with VODs
   on: show "VOD found · N fights", then the clips in Clips → Streamer POV.
   Play one. If no streamer was in your match, use "Played against a streamer
   it missed?" with a friend's channel.
6. **Data use (15 s).** Show the website's "does / doesn't" section and the
   privacy policy.

## Checklist before submitting

- [ ] Website loads: `/`, `/demo`, `/privacy`
- [ ] `/demo` lookup works with your own Riot ID
- [ ] Contact email added to the privacy page (`src/site/Privacy.tsx`, `CONTACT`)
- [ ] Demo video uploaded (Unlisted) and link pasted above
- [ ] Description above re-read and accurate
- [ ] Your HenrikDev key rotated (the first one was shared in chat)
