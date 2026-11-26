// Ties clips to matches, and your clip to the streamer's clip of the same fight.
//
// Your clips: the file is written when you press the hotkey, so a clip covers
// [saved - length, saved] in real time. Streamer clips remember where they
// start in the match, so their real start is match start + that many seconds.
import type { ClipInfo, MatchSummary } from "./backend";

/** Real time (ms) a clip starts and ends, if we can tell. */
export function clipSpan(c: ClipInfo, matches: MatchSummary[]): [number, number] | null {
  const len = (c.durationSec ?? 0) * 1000;
  if (c.kind === "mine") return len ? [c.createdMs - len, c.createdMs] : null;
  const m = c.matchId ? matches.find((x) => x.id === c.matchId) : undefined;
  if (!m || c.matchStartSec == null || !len) return null;
  const start = Date.parse(m.startedAt) + c.matchStartSec * 1000;
  return [start, start + len];
}

/** The match a clip belongs to, or undefined. */
export function matchOf(c: ClipInfo, matches: MatchSummary[]): MatchSummary | undefined {
  if (c.kind === "theirs") {
    if (c.matchId) return matches.find((m) => m.id === c.matchId);
    return undefined;
  }
  // Your clip: saved while the match was on (or within 2 minutes of its end).
  return matches.find((m) => {
    const start = Date.parse(m.startedAt);
    return c.createdMs >= start && c.createdMs <= start + (m.lengthMs || 0) + 120_000;
  });
}

/** Overlap in ms between two time spans. */
const overlap = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/**
 * The clip from the other side of the same fight, and how many seconds later
 * the other clip starts than this one (negative: it starts earlier).
 */
export interface Pair {
  mine: ClipInfo;
  theirs: ClipInfo;
  /** Seconds into your clip where the streamer's clip begins. */
  offsetSec: number;
}

/** Every your-clip/their-clip pair that shows the same moment. */
export function findPairs(clips: ClipInfo[], matches: MatchSummary[]): Pair[] {
  const pairs: Pair[] = [];
  const mine = clips.filter((c) => c.kind === "mine").map((c) => ({ c, span: clipSpan(c, matches) }));
  for (const t of clips.filter((c) => c.kind === "theirs")) {
    const ts = clipSpan(t, matches);
    if (!ts) continue;
    let best: { c: ClipInfo; span: [number, number]; o: number } | null = null;
    for (const m of mine) {
      if (!m.span) continue;
      const o = overlap(ts, m.span);
      // At least 3 seconds of the same moment, the most overlap wins.
      if (o >= 3000 && (!best || o > best.o)) best = { c: m.c, span: m.span, o };
    }
    if (best) pairs.push({ mine: best.c, theirs: t, offsetSec: (ts[0] - best.span[0]) / 1000 });
  }
  return pairs;
}

/** Pairs this clip is part of. */
export const pairsWith = (c: ClipInfo, pairs: Pair[]) => pairs.filter((p) => p.mine.path === c.path || p.theirs.path === c.path);

/** "1h2m3s" for a Twitch link's ?t= */
export function twitchTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
}

/** Their VOD at the start of this clip, on Twitch. Only Twitch VOD links are trusted. */
export function vodLink(c: ClipInfo): string | null {
  if (!c.vodUrl || c.vodStartSec == null) return null;
  try {
    const u = new URL(c.vodUrl);
    if (u.protocol !== "https:" || !/(^|\.)twitch\.tv$/.test(u.hostname)) return null;
    u.searchParams.set("t", twitchTime(c.vodStartSec));
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Seconds into a clip where you and this streamer fought (kills between you two),
 * for the markers under the video.
 */
export function fightMarks(c: ClipInfo, match: MatchSummary | undefined, mePuuid: string | undefined, streamerPuuid: string | undefined, matches: MatchSummary[]): number[] {
  if (!match || !mePuuid) return [];
  const span = clipSpan(c, matches);
  if (!span) return [];
  const start = Date.parse(match.startedAt);
  return match.kills
    .filter((k) => (k.killer === mePuuid || k.victim === mePuuid) && (!streamerPuuid || k.killer === streamerPuuid || k.victim === streamerPuuid))
    .map((k) => (start + k.atMs - span[0]) / 1000)
    .filter((t) => t >= 0 && t <= (c.durationSec ?? 0));
}
