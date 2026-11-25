// Finding which players in a match were streaming on Twitch while it was
// played. Uses Twitch's official Helix API with an app token (client
// credentials); the client id and secret are Worker secrets.

import type { MatchPlayer, MatchSummary } from "./match.ts";

export interface TwitchEnv {
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  /** Test overrides. */
  TWITCH_API_BASE?: string;
  TWITCH_AUTH_BASE?: string;
}

export interface StreamerVod {
  id: string;
  url: string;
  /** When the stream (and so the VOD) started. */
  startedAt: string;
  durationSec: number;
  /** Seconds into the VOD at which the match started. */
  offsetSec: number;
  /** True while the stream is still live (the VOD is still growing). */
  live: boolean;
}

export interface StreamerResult {
  puuid: string;
  name: string;
  tag: string;
  channel: { id: string; login: string; displayName: string };
  /** The VOD covering the match, or null if they were live but don't save VODs. */
  vod: StreamerVod | null;
  /** Game category if they're live right now. */
  liveGame: string | null;
}

export class TwitchError extends Error {}

// ---- names ----

/**
 * Twitch logins a Riot name could correspond to, best guess first.
 * "TTV Salt_Boran" -> ["ttvsalt_boran", "salt_boran", "saltboran"].
 */
export function loginCandidates(riotName: string): string[] {
  const base = riotName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "");
  const cleaned = base.replace(/[^a-z0-9_]/g, "");
  const stripped = cleaned.replace(/^(ttv|twitch)_?/, "").replace(/_?(ttv|twitch)$/, "");
  const out: string[] = [];
  for (const c of [cleaned, stripped, stripped.replace(/_/g, "")]) {
    if (/^[a-z0-9_]{4,25}$/.test(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** A player's account is a streamer's main when its Riot name is (a form of) the channel name. */
export function isMainAccount(riotName: string, login: string): boolean {
  return loginCandidates(riotName).includes(login.toLowerCase());
}

/** "3h2m1s" -> 10921 */
export function parseTwitchDuration(d: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(d.trim());
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

// ---- Helix ----

interface Token {
  value: string;
  expires: number;
}
let cachedToken: Token | null = null;

async function appToken(env: TwitchEnv): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const q = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID ?? "",
    client_secret: env.TWITCH_CLIENT_SECRET ?? "",
    grant_type: "client_credentials",
  });
  const res = await fetch(`${env.TWITCH_AUTH_BASE ?? "https://id.twitch.tv"}/oauth2/token`, { method: "POST", body: q });
  if (!res.ok) throw new TwitchError(`Twitch rejected the app credentials (${res.status}).`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

/** For tests: forget the cached token. */
export function resetTwitchToken() {
  cachedToken = null;
}

async function helix<T>(env: TwitchEnv, path: string, params: [string, string][]): Promise<T[]> {
  const token = await appToken(env);
  const url = `${env.TWITCH_API_BASE ?? "https://api.twitch.tv"}/helix/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { "Client-Id": env.TWITCH_CLIENT_ID ?? "", Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    resetTwitchToken();
    throw new TwitchError("Twitch token expired, try again.");
  }
  if (res.status === 429) throw new TwitchError("Twitch is rate limiting us, try again in a minute.");
  if (!res.ok) throw new TwitchError(`Twitch error (${res.status}).`);
  return ((await res.json()) as { data: T[] }).data ?? [];
}

interface HUser {
  id: string;
  login: string;
  display_name: string;
}
interface HStream {
  user_id: string;
  game_name: string;
  started_at: string;
  id: string;
}
interface HVideo {
  id: string;
  url: string;
  created_at: string;
  duration: string;
  type: string;
  stream_id: string | null;
}

/** Was this VOD recording when the match started? Allows a minute of slack. */
export function vodCovers(v: { startMs: number; durationSec: number }, matchStartMs: number): boolean {
  return v.startMs <= matchStartMs + 60_000 && v.startMs + v.durationSec * 1000 >= matchStartMs;
}

/**
 * Players in `match` (except `excludePuuid`, the requester) who were
 * streaming on Twitch when it started.
 */
export async function findStreamers(env: TwitchEnv, match: MatchSummary, excludePuuid?: string, known?: Map<string, string>): Promise<StreamerResult[]> {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) throw new TwitchError("Server is missing its Twitch credentials.");
  const matchStart = Date.parse(match.startedAt);
  if (Number.isNaN(matchStart)) return [];

  // 1. Which candidate logins exist? One call for everyone (max 100 logins).
  // A channel already saved for a player (their main or a smurf) goes first.
  const byLogin = new Map<string, MatchPlayer>();
  for (const p of match.players) {
    if (p.puuid === excludePuuid) continue;
    const saved = known?.get(p.puuid);
    if (saved && !byLogin.has(saved)) byLogin.set(saved, p);
  }
  for (const p of match.players) {
    if (p.puuid === excludePuuid) continue;
    for (const login of loginCandidates(p.name)) if (!byLogin.has(login)) byLogin.set(login, p);
  }
  if (byLogin.size === 0) return [];
  const users = await helix<HUser>(env, "users", [...byLogin.keys()].slice(0, 100).map((l) => ["login", l]));

  // One channel per player: the first candidate (best guess) that exists.
  const chosen = new Map<string, HUser>();
  for (const [login, player] of byLogin) {
    const user = users.find((u) => u.login.toLowerCase() === login);
    if (user && !chosen.has(player.puuid)) chosen.set(player.puuid, user);
  }
  if (chosen.size === 0) return [];

  return checkChannels(env, match, chosen, matchStart);
}

/** Keeps the chosen channels whose broadcast covered the match start. */
async function checkChannels(env: TwitchEnv, match: MatchSummary, chosen: Map<string, HUser>, matchStart: number): Promise<StreamerResult[]> {
  // 2. Who is live right now (one call).
  const live = await helix<HStream>(env, "streams", [...chosen.values()].map((u) => ["user_id", u.id]));

  // 3. For each channel, a past broadcast (VOD) covering the match start.
  const results: StreamerResult[] = [];
  for (const [puuid, user] of chosen) {
    const player = match.players.find((p) => p.puuid === puuid)!;
    const stream = live.find((s) => s.user_id === user.id) ?? null;
    const videos = await helix<HVideo>(env, "videos", [["user_id", user.id], ["type", "archive"], ["first", "10"]]);
    const vod = videos
      .map((v) => ({ v, startMs: Date.parse(v.created_at), durationSec: parseTwitchDuration(v.duration) }))
      .find((x) => vodCovers(x, matchStart));
    const liveSinceBeforeMatch = stream !== null && Date.parse(stream.started_at) <= matchStart + 60_000;
    if (!vod && !liveSinceBeforeMatch) continue; // Not streaming during this match.
    results.push({
      puuid,
      name: player.name,
      tag: player.tag,
      channel: { id: user.id, login: user.login, displayName: user.display_name },
      vod: vod
        ? {
            id: vod.v.id,
            url: vod.v.url,
            startedAt: vod.v.created_at,
            durationSec: vod.durationSec,
            offsetSec: Math.round((matchStart - vod.startMs) / 1000),
            live: stream !== null && vod.v.stream_id === stream.id,
          }
        : null,
      liveGame: stream?.game_name ?? null,
    });
  }
  return results;
}


/**
 * The user says `login` is the channel of player `puuid` in this match
 * ("Played against a streamer it missed?"). Same timing check as above.
 */
export async function checkChannel(env: TwitchEnv, match: MatchSummary, puuid: string, login: string): Promise<StreamerResult[]> {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) throw new TwitchError("Server is missing its Twitch credentials.");
  if (!match.players.some((p) => p.puuid === puuid)) return [];
  const matchStart = Date.parse(match.startedAt);
  const users = await helix<HUser>(env, "users", [["login", login.toLowerCase()]]);
  if (users.length === 0) throw new TwitchError(`There's no Twitch channel called ${login}.`);
  return checkChannels(env, match, new Map([[puuid, users[0]]]), matchStart);
}
