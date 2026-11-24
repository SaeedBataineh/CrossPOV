import type { MatchPlayer, MatchStreamers, MatchSummary, StreamerPlayer } from "./backend";

export const matchEndMs = (m: MatchSummary) => Date.parse(m.startedAt) + (m.lengthMs || 0);

export const isToday = (ms: number) => new Date(ms).toDateString() === new Date().toDateString();

/** "W" / "L" / "D" and the score from the user's side, or null if we don't know their team. */
export function result(m: MatchSummary, me?: MatchPlayer): { letter: "W" | "L" | "D"; score: string } | null {
  const mine = m.teams.find((t) => t.id === me?.team);
  const other = m.teams.find((t) => t.id !== me?.team);
  if (!mine || !other) return null;
  return { letter: mine.won ? "W" : other.won ? "L" : "D", score: `${mine.roundsWon}–${other.roundsWon}` };
}

export const resultColor = (letter?: string) => (letter === "W" ? "var(--win)" : letter === "L" ? "var(--loss)" : "#555");

/** Text and colour class for one streamer's progress. */
export function streamerLabel(s: StreamerPlayer): { text: string; tone: "good" | "warn" | "purple" | "bad" | "muted" } {
  switch (s.status) {
    case "working":
      if (s.vod?.live) return { text: `live · waits for VOD (${s.clips}/${s.fights})`, tone: "purple" };
      return { text: `downloading ${s.clips}/${s.fights}`, tone: "warn" };
    case "clipped":
      return { text: `${s.clips} ${s.clips === 1 ? "clip" : "clips"} saved`, tone: "good" };
    case "noFights":
      return { text: "you didn't fight", tone: "muted" };
    case "noVod":
      return { text: "was live · no VOD saved", tone: "bad" };
    case "subOnly":
      return { text: "VOD is sub-only", tone: "bad" };
    case "failed":
      return { text: "couldn't get clips", tone: "bad" };
  }
}

/** Share of the fights already saved, 0-100. */
export function progress(s: StreamerPlayer): number {
  if (s.status === "clipped") return 100;
  if (!s.fights) return 0;
  return Math.round((s.clips / s.fights) * 100);
}

export function allStreamers(states: Record<string, MatchStreamers>): { matchId: string; player: StreamerPlayer }[] {
  return Object.values(states).flatMap((s) => s.players.map((player) => ({ matchId: s.matchId, player })));
}

/** First two letters of a name, for round avatars. */
export const ini = (name: string) => name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
