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

/** The match as the scanner needs it: score timeline only, no player data. */
export function scannerMatch(m: MatchSummary): { id: string; startedAt: number; lengthMs: number; teams: string[]; rounds: { startMs: number; winner: string | null }[] } | null {
  const startedAt = Date.parse(m.startedAt);
  const teams = m.teams.map((t) => t.id).slice(0, 2);
  const rounds = m.rounds.filter((r) => r.startMs != null).map((r) => ({ startMs: r.startMs as number, winner: r.winner }));
  if (Number.isNaN(startedAt) || teams.length !== 2 || rounds.length < 4) return null; // deathmatch etc.: no round score to match
  return { id: m.id, startedAt, lengthMs: m.lengthMs, teams, rounds };
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
