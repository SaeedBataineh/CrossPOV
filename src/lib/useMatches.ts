import { useCallback, useEffect, useState } from "react";
import {
  checkMatchesNow,
  isDesktop,
  listMatches,
  matchesStatus,
  onMatchesStatus,
  onMatchFound,
  type MatchesStatus,
  type MatchSummary,
} from "./backend";

/** Matches saved by the desktop app, kept live as new ones are found. */
export function useMatches() {
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [status, setStatus] = useState<MatchesStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const unlisten: Array<() => void> = [];
    listMatches().then((m) => alive && setMatches(m), () => {});
    matchesStatus().then((s) => alive && setStatus(s), () => {});
    onMatchFound((m) => setMatches((prev) => [m, ...prev.filter((p) => p.id !== m.id)])).then((u) => unlisten.push(u));
    onMatchesStatus((s) => setStatus(s)).then((u) => unlisten.push(u));
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
    };
  }, []);

  /** Asks the server now; errors land in `status.error`. */
  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      const m = await checkMatchesNow();
      setMatches((prev) => (prev.some((p) => p.id === m.id) ? prev : [m, ...prev]));
    } catch {
      // The backend also reports the error through matches-status.
    } finally {
      setChecking(false);
    }
  }, []);

  return { matches, status, checking, checkNow };
}

export function matchTimeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.round((now - t) / 60000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** "13–9 Win" from the user's point of view, or the plain score. */
export function scoreLine(m: MatchSummary, myTeam?: string): string {
  const mine = m.teams.find((t) => t.id === myTeam);
  const other = m.teams.find((t) => t.id !== myTeam);
  if (mine && other) return `${mine.roundsWon}–${other.roundsWon} ${mine.won ? "Win" : other.won ? "Loss" : "Draw"}`;
  return m.teams.map((t) => t.roundsWon).join("–");
}
