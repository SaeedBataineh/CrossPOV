// The always-on scoreboard scanner on the VPS: after a match, it says which
// live streams showed this match's score (and confirmed it in their VODs),
// which finds streamers whose Riot name doesn't match their channel.
//
// Requests are signed with SCANNER_KEY (HMAC-SHA256 over "<time>.<METHOD> <path>.<body>"),
// matching tools/scanner/api.py. If the scanner is slow or down, streamer
// checks carry on without it.

import type { MatchSummary } from "./match.ts";

export interface ScannerEnv {
  /** e.g. http://<vps ip>:8787 */
  SCANNER_URL?: string;
  SCANNER_KEY?: string;
}

export interface ScannerStream {
  login: string;
  userId?: string;
  displayName?: string;
  /** Team id of the streamer in this match. */
  team: string;
  /** Their measured broadcast delay. */
  delaySec?: number | null;
}

export interface ScannerResult {
  status: "pending" | "done" | "off" | "error";
  streams: ScannerStream[];
}

const enc = new TextEncoder();

export async function sign(key: string, ts: string, method: string, path: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, enc.encode(`${ts}.${method} ${path}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function call(env: ScannerEnv, method: string, path: string, body = "", timeoutMs = 6000): Promise<unknown> {
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(env.SCANNER_URL!.replace(/\/+$/, "") + path, {
    method,
    body: method === "POST" ? body : undefined,
    headers: {
      "content-type": "application/json",
      "x-crosspov-time": ts,
      "x-crosspov-signature": await sign(env.SCANNER_KEY!, ts, method, path, body),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`scanner ${res.status}`);
  return res.json();
}

/**
 * The match as the scanner needs it: the score timeline only, no player data.
 * `events`: rounds that ended with the whole losing team dead, and when. The
 * HUD score changes at exactly that moment, so the scanner can measure how far
 * a streamer's VOD is shifted from the match clock (agent select, stream delay).
 */
export function scannerMatch(m: MatchSummary): {
  id: string;
  startedAt: number;
  lengthMs: number;
  teams: string[];
  rounds: { startMs: number; winner: string | null }[];
  events: { decidedMs: number; round: number }[];
} | null {
  const startedAt = Date.parse(m.startedAt);
  const teams = m.teams.map((t) => t.id).slice(0, 2);
  const timed = m.rounds.filter((r) => r.startMs != null);
  const rounds = timed.map((r) => ({ startMs: r.startMs as number, winner: r.winner }));
  if (Number.isNaN(startedAt) || teams.length !== 2 || rounds.length < 4) return null; // deathmatch etc.: no round score to match
  return { id: m.id, startedAt, lengthMs: m.lengthMs, teams, rounds, events: eliminations(m, timed.map((r) => r.index)) };
}

/** (time, position in `order`) of rounds the winners decided by killing the whole other team. */
export function eliminations(m: MatchSummary, order: number[]): { decidedMs: number; round: number }[] {
  const teamOf = new Map(m.players.map((p) => [p.puuid, p.team]));
  const size = (team: string) => m.players.filter((p) => p.team === team).length;
  const out: { decidedMs: number; round: number }[] = [];
  m.rounds.forEach((r) => {
    const pos = order.indexOf(r.index);
    if (pos < 0 || !r.winner) return;
    const loser = m.teams.find((t) => t.id !== r.winner)?.id;
    if (!loser) return;
    const deaths = m.kills.filter((k) => k.round === r.index && teamOf.get(k.victim) === loser);
    if (new Set(deaths.map((k) => k.victim)).size >= size(loser) && deaths.length) {
      out.push({ decidedMs: Math.max(...deaths.map((k) => k.atMs)), round: pos });
    }
  });
  return out.slice(0, 40);
}

export async function scannerStreams(env: ScannerEnv, m: MatchSummary): Promise<ScannerResult> {
  if (!env.SCANNER_URL || !env.SCANNER_KEY) return { status: "off", streams: [] };
  const body = scannerMatch(m);
  if (!body) return { status: "done", streams: [] };
  try {
    const r = (await call(env, "POST", "/match", JSON.stringify(body))) as { status?: string; streams?: ScannerStream[] };
    const streams = (r.streams ?? []).filter((s) => typeof s.login === "string" && /^[a-z0-9_]{3,25}$/i.test(s.login) && typeof s.team === "string");
    return { status: r.status === "done" ? "done" : "pending", streams };
  } catch {
    return { status: "error", streams: [] };
  }
}

export async function scannerHealth(env: ScannerEnv): Promise<unknown> {
  if (!env.SCANNER_URL || !env.SCANNER_KEY) return false;
  try {
    return await call(env, "GET", "/health", "", 4000);
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) };
  }
}

export type VerifyVerdict = "pending" | "match" | "otherTeam" | "different" | "unknown" | "off";

export interface VerifyResult {
  verdict: VerifyVerdict;
  /** How many seconds later than the match clock things happen in their VOD (measured), else null. */
  delaySec?: number | null;
}

/**
 * mode "check" (a channel linked by hand): does their VOD show this match's
 * score, from `team`'s side, and how shifted is it? mode "shift" (found by
 * name, so surely in the match): only measure the shift.
 */
export async function scannerVerify(env: ScannerEnv, m: MatchSummary, login: string, team: string, mode: "check" | "shift" = "check"): Promise<VerifyResult> {
  if (!env.SCANNER_URL || !env.SCANNER_KEY) return { verdict: "off" };
  const body = scannerMatch(m);
  if (!body) return { verdict: "unknown" }; // deathmatch etc.: no round score to read
  try {
    const r = (await call(env, "POST", "/verify", JSON.stringify({ ...body, login, team, mode }))) as { status?: string; verdict?: string; shiftSec?: number | null };
    if (r.status !== "done") return { verdict: "pending" };
    const verdict = (["match", "otherTeam", "different", "unknown"] as const).find((v) => v === r.verdict) ?? "unknown";
    const shift = typeof r.shiftSec === "number" && r.shiftSec >= 0 && r.shiftSec <= 300 ? r.shiftSec : null;
    return { verdict, delaySec: shift };
  } catch {
    return { verdict: "unknown" }; // scanner down: don't block the link
  }
}

// ---- Streamer accounts: Riot account -> Twitch channel, kept on the VPS ----

export interface KnownLink {
  puuid: string;
  login: string;
  userId?: string;
  kind: "main" | "smurf";
}

/** Saved Twitch channels of these players (mains and smurfs). Empty if the VPS isn't set up or answers slowly. */
export async function scannerLinks(env: ScannerEnv, puuids: string[]): Promise<Map<string, KnownLink>> {
  const out = new Map<string, KnownLink>();
  if (!env.SCANNER_URL || !env.SCANNER_KEY || !puuids.length) return out;
  try {
    const r = (await call(env, "POST", "/links/lookup", JSON.stringify({ puuids: puuids.slice(0, 20) }), 4000)) as { links?: KnownLink[] };
    for (const l of r.links ?? []) {
      if (typeof l.puuid === "string" && typeof l.login === "string" && /^[a-z0-9_]{3,25}$/.test(l.login)) out.set(l.puuid, l);
    }
  } catch {
    // The VPS being down never stops streamer checks; name matching still works.
  }
  return out;
}

/** Saves links the server has checked (live under that name, or a VOD whose scoreboard showed the match). */
export async function scannerSaveLinks(env: ScannerEnv, links: (KnownLink & { source: string })[]): Promise<void> {
  if (!env.SCANNER_URL || !env.SCANNER_KEY || !links.length) return;
  try {
    await call(env, "POST", "/links/save", JSON.stringify({ links: links.slice(0, 20) }), 4000);
  } catch {
    // Best effort: the link is found again next time.
  }
}
