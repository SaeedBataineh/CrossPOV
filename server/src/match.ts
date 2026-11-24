// CrossPOV's own match format: only what the app needs, in a stable shape
// that doesn't change when the upstream data source does. The desktop app
// mirrors this in src-tauri/src/matches.rs.

export interface MatchPlayer {
  puuid: string;
  name: string;
  tag: string;
  /** Team id, e.g. "Red" / "Blue". */
  team: string;
  agent: string;
  kills: number;
  deaths: number;
  assists: number;
}

export interface MatchRound {
  /** 0-based. */
  index: number;
  winner: string | null;
  /** When the round started, in ms from the start of the match (null if unknown). */
  startMs: number | null;
}

export interface MatchKill {
  round: number;
  /** Ms from the start of the match. Used to find the moment in a streamer's VOD. */
  atMs: number;
  inRoundMs: number;
  killer: string; // puuid
  victim: string; // puuid
  weapon: string | null;
}

export interface MatchSummary {
  id: string;
  map: string;
  mode: string;
  region: string;
  /** ISO time the match started. */
  startedAt: string;
  lengthMs: number;
  teams: { id: string; won: boolean; roundsWon: number }[];
  players: MatchPlayer[];
  rounds: MatchRound[];
  kills: MatchKill[];
}

// ---- HenrikDev v4 match shape (only the fields we read) ----

interface HPlayerRef {
  puuid?: string;
}
interface HKill {
  round?: number;
  time_in_match_in_ms?: number;
  time_in_round_in_ms?: number;
  killer?: HPlayerRef;
  victim?: HPlayerRef;
  weapon?: { name?: string | null } | null;
}
interface HPlayer {
  puuid?: string;
  name?: string;
  tag?: string;
  team_id?: string;
  agent?: { name?: string };
  stats?: { kills?: number; deaths?: number; assists?: number };
}
export interface HMatch {
  metadata?: {
    match_id?: string;
    map?: { name?: string };
    queue?: { id?: string; name?: string | null };
    region?: string | null;
    started_at?: string;
    game_length_in_ms?: number;
  };
  players?: HPlayer[];
  teams?: { team_id?: string; won?: boolean; rounds?: { won?: number } }[];
  rounds?: { id?: number; winning_team?: string | null }[];
  kills?: HKill[];
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);

/** Converts a HenrikDev v4 match into a MatchSummary. Throws if it has no id. */
export function fromHenrikV4(m: HMatch): MatchSummary {
  const meta = m.metadata ?? {};
  const id = str(meta.match_id);
  if (!id) throw new Error("match has no id");

  const kills: MatchKill[] = (m.kills ?? [])
    .filter((k) => k.killer?.puuid && k.victim?.puuid)
    .map((k) => ({
      round: num(k.round),
      atMs: num(k.time_in_match_in_ms),
      inRoundMs: num(k.time_in_round_in_ms),
      killer: str(k.killer?.puuid),
      victim: str(k.victim?.puuid),
      weapon: k.weapon?.name ?? null,
    }))
    .sort((a, b) => a.atMs - b.atMs);

  // Rounds carry no start time; each kill tells us (match time - round time).
  const roundStart = new Map<number, number>();
  for (const k of kills) {
    const start = k.atMs - k.inRoundMs;
    const prev = roundStart.get(k.round);
    if (prev === undefined || start < prev) roundStart.set(k.round, start);
  }

  return {
    id,
    map: str(meta.map?.name, "Unknown map"),
    mode: str(meta.queue?.name ?? meta.queue?.id, "Unknown mode"),
    region: str(meta.region),
    startedAt: str(meta.started_at),
    lengthMs: num(meta.game_length_in_ms),
    teams: (m.teams ?? []).map((t) => ({ id: str(t.team_id), won: Boolean(t.won), roundsWon: num(t.rounds?.won) })),
    players: (m.players ?? [])
      .filter((p) => p.puuid)
      .map((p) => ({
        puuid: str(p.puuid),
        name: str(p.name),
        tag: str(p.tag),
        team: str(p.team_id),
        agent: str(p.agent?.name, "Unknown"),
        kills: num(p.stats?.kills),
        deaths: num(p.stats?.deaths),
        assists: num(p.stats?.assists),
      })),
    rounds: (m.rounds ?? []).map((r, i) => {
      const index = num(r.id, i);
      return { index, winner: r.winning_team ?? null, startMs: roundStart.get(index) ?? null };
    }),
    kills,
  };
}
