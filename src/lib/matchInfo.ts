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
/** "under a minute left", "about 3 min left", "about 1 h 20 min left". */
export function timeLeft(sec: number): string {
  if (sec < 60) return "under a minute left";
  const min = Math.round(sec / 60);
  return min < 60 ? `about ${min} min left` : `about ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""} left`;
}

export function streamerLabel(s: StreamerPlayer, teammate = false): { text: string; tone: "good" | "warn" | "purple" | "bad" | "muted" } {
  // You can't fight a teammate, so there's never anything of theirs to clip.
  if (teammate && s.status !== "clipped") return { text: "your teammate · nothing to clip", tone: "muted" };
  // The VPS lines a VOD up in under a minute; the app asks every 10 s.
  if (s.checking) return { text: `${s.manual ? "checking it was this match" : "lining up their VOD"} · about a minute`, tone: "purple" };
  const eta = s.status === "working" && s.etaSec ? ` · ${timeLeft(s.etaSec)}` : "";
  if (s.status === "failed" && s.message?.includes("different game")) return { text: "was in a different game", tone: "bad" };
  if (s.status === "failed" && s.message?.includes("other team")) return { text: "wrong player picked", tone: "bad" };
  switch (s.status) {
    case "working":
      if (!s.fights) return { text: s.vod?.live ? "live · waits for VOD" : "looking for your fights", tone: "purple" };
      if (s.vod?.live) return { text: `live · waits for VOD (${s.clips}/${s.fights})${eta}`, tone: "purple" };
      return { text: `downloading ${s.clips}/${s.fights}${eta}`, tone: "warn" };
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
