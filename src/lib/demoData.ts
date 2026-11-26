// Sample data for the website demo (crosspov.com/demo), so visitors see the
// app with clips, matches and streamers in it. All names are made up.
// Only loaded in the browser, never in the desktop app.
import type { ClipInfo, MatchPlayer, MatchStreamers, MatchSummary } from "./backend";

export const DEMO_RIOT_ID = "DemoPlayer#CPV";

const MIN = 60_000;

function player(puuid: string, name: string, tag: string, team: string, agent: string, kda: [number, number, number]): MatchPlayer {
  return { puuid, name, tag, team, agent, kills: kda[0], deaths: kda[1], assists: kda[2] };
}

const PLAYERS: MatchPlayer[] = [
  player("me", "DemoPlayer", "CPV", "Blue", "Jett", [25, 14, 4]),
  player("t1", "Nova", "7781", "Blue", "Sova", [18, 10, 8]),
  player("t2", "kestrel", "EUW", "Blue", "Omen", [16, 14, 7]),
  player("t3", "frostbyte", "000", "Blue", "Killjoy", [15, 13, 5]),
  player("t4", "Mango", "2210", "Blue", "Skye", [7, 15, 3]),
  player("s2", "streamer_two", "TTV", "Red", "Raze", [17, 15, 2]),
  player("e1", "Quill", "4410", "Red", "Clove", [17, 20, 6]),
  player("s1", "streamer_one", "LIVE", "Red", "Reyna", [14, 16, 7]),
  player("e2", "Orbit", "321", "Red", "Neon", [10, 16, 3]),
  player("e3", "Pyre", "0001", "Red", "Cypher", [8, 14, 4]),
];

/** Builds a plausible match: who won each round, your kills and deaths, and a few fights with the streamers. */
function match(id: string, map: string, mode: string, minutesAgo: number, won: number[], streamerFights: Record<number, string>): MatchSummary {
  const myKills = [1, 2, 0, 1, 3, 0, 2, 1, 1, 0, 2, 1, 1, 5, 0, 1, 1, 2, 0, 1, 1, 1, 2, 0];
  const enemies = ["e1", "e2", "e3", "s2", "s1"];
  const kills: MatchSummary["kills"] = [];
  won.forEach((w, r) => {
    const base = r * 100_000;
    const fightWith = streamerFights[r];
    for (let j = 0; j < myKills[r % myKills.length]; j++) {
      const victim = j === 0 && fightWith && w ? fightWith : enemies[(r + j) % 3];
      kills.push({ round: r, atMs: base + 18_000 + j * 6_000, inRoundMs: 18_000 + j * 6_000, killer: "me", victim, weapon: "Vandal" });
    }
    if (!w) kills.push({ round: r, atMs: base + 61_000, inRoundMs: 61_000, killer: fightWith ?? enemies[r % 3], victim: "me", weapon: "Phantom" });
    kills.push({ round: r, atMs: base + 40_000, inRoundMs: 40_000, killer: "t1", victim: enemies[(r + 1) % 3], weapon: "Ghost" });
  });
  const blue = won.filter(Boolean).length;
  return {
    id,
    map,
    mode,
    region: "eu",
    startedAt: new Date(Date.now() - minutesAgo * MIN).toISOString(),
    lengthMs: won.length * 100_000,
    teams: [
      { id: "Blue", won: blue > won.length - blue, roundsWon: blue },
      { id: "Red", won: won.length - blue > blue, roundsWon: won.length - blue },
    ],
    players: PLAYERS,
    rounds: won.map((w, i) => ({ index: i, winner: w ? "Blue" : "Red", startMs: i * 100_000 })),
    kills: kills.sort((a, b) => a.atMs - b.atMs),
  };
}

export function demoMatches(): MatchSummary[] {
  return [
    match("demo-ascent", "Ascent", "Competitive", 70, [1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1], { 2: "s2", 8: "s2", 13: "s2", 16: "s1" }),
    match("demo-lotus", "Lotus", "Competitive", 200, [0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0], { 10: "e1" }),
    match("demo-bind", "Bind", "Competitive", 26 * 60, [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1], {}),
    match("demo-haven", "Haven", "Unrated", 27 * 60, [1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1], {}),
  ];
}

export function demoStreamers(): MatchStreamers[] {
  const now = Date.now();
  const ch = (login: string) => ({ id: login, login, displayName: login });
  const vod = (offsetSec: number) => ({ id: "demo", url: "https://www.twitch.tv/videos/demo", startedAt: "", durationSec: 14_400, offsetSec, live: false });
  return [
    {
      matchId: "demo-ascent",
      checkedMs: now - 35 * MIN,
      error: null,
      finished: false,
      players: [
        { puuid: "s2", name: "streamer_two", channel: ch("streamer_two"), vod: vod(4360), status: "clipped", clips: 3, fights: 3, message: null, manual: false },
        { puuid: "s1", name: "streamer_one", channel: ch("streamer_one"), vod: vod(310), status: "working", clips: 1, fights: 2, message: null, manual: false },
      ],
      // Found by the scoreboard scanner: name doesn't match, so the user picks the player.
      suggested: [{ login: "quiet_queue", displayName: "quiet_queue", team: "Red", delaySec: 30 }],
    },
    {
      matchId: "demo-lotus",
      checkedMs: now - 165 * MIN,
      error: null,
      finished: true,
      players: [{ puuid: "e1", name: "nightowl_val", channel: ch("nightowl_val"), vod: null, status: "subOnly", clips: 0, fights: 1, message: "The VOD is for subscribers only.", manual: false }],
    },
    { matchId: "demo-bind", checkedMs: now - 25 * 60 * MIN, error: null, finished: true, players: [] },
    { matchId: "demo-haven", checkedMs: now - 26 * 60 * MIN, error: null, finished: true, players: [] },
  ];
}

export function demoClips(): ClipInfo[] {
  const now = Date.now();
  const clip = (name: string, kind: ClipInfo["kind"], minutesAgo: number, durationSec: number, mb: number, extra: Partial<ClipInfo> = {}): ClipInfo => ({
    path: `demo/${name}.mp4`,
    name,
    kind,
    sizeBytes: mb * 1024 ** 2,
    createdMs: now - minutesAgo * MIN,
    durationSec,
    thumb: null,
    streamer: null,
    round: null,
    moment: null,
    map: "Ascent",
    ...extra,
  });
  return [
    clip("streamer_one_R17_you-killed", "theirs", 29, 108, 300, { streamer: "streamer_one", round: 17, moment: "You killed them", matchId: "demo-ascent", matchStartSec: 1558, vodUrl: "https://www.twitch.tv/videos/demo", vodStartSec: 1868 }),
    clip("streamer_two_R14_killed-you", "theirs", 30, 120, 412, { streamer: "streamer_two", round: 14, moment: "They killed you", matchId: "demo-ascent", matchStartSec: 1301, vodUrl: "https://www.twitch.tv/videos/demo", vodStartSec: 5661 }),
    clip("streamer_two_R9_you-killed", "theirs", 31, 120, 405, { streamer: "streamer_two", round: 9, moment: "You killed them", matchId: "demo-ascent", matchStartSec: 758, vodUrl: "https://www.twitch.tv/videos/demo", vodStartSec: 5118 }),
    clip("streamer_two_R3_killed-you", "theirs", 31, 120, 398, { streamer: "streamer_two", round: 3, moment: "They killed you", matchId: "demo-ascent", matchStartSec: 201, vodUrl: "https://www.twitch.tv/videos/demo", vodStartSec: 4561 }),
    clip("Clip_Round-9", "mine", 56, 60, 186),
    clip("Clip_Round-17", "mine", 42.8, 60, 190),
    clip("Clip_Round-14-clutch", "mine", 41, 60, 188),
    clip("Clip_Round-5", "mine", 60, 60, 186),
    clip("Clip_Round-3-ace", "mine", 150, 60, 191, { map: "Lotus" }),
    clip("Clip_Round-22-retake", "mine", 1500, 30, 94, { map: "Bind" }),
    clip("Clip_Op-flick", "mine", 1530, 60, 180, { map: "Bind" }),
    clip("Clip_Haven-1v3", "mine", 1620, 60, 172, { map: "Haven" }),
  ];
}
