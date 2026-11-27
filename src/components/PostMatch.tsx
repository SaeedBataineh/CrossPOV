import { Diamond, Skull } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { MatchPlayer, MatchSummary } from "../lib/backend";
import { TwitchIcon } from "./Icons";
import { AgentIcon } from "./ValorantArt";

/*
 * The match details, laid out like VALORANT's post-match screen (result and
 * score, a two-row round timeline, each team's scoreboard) but drawn in the
 * app's own panels, type and colours.
 */

interface Streamer {
  login: string;
  name: string;
}

/** Who won each round and how, from your team's side (or team A's when you aren't in the match). */
function roundsOf(match: MatchSummary, ally: string) {
  const teamOf = new Map(match.players.map((p) => [p.puuid, p.team]));
  return match.rounds.map((r) => {
    const deaths = match.kills.filter((k) => k.round === r.index);
    const loser = r.winner ? match.teams.find((t) => t.id !== r.winner)?.id : undefined;
    const lost = loser ? deaths.filter((k) => teamOf.get(k.victim) === loser).length : 0;
    // Five deaths on the losing side is an elimination; anything else is a spike or time win, which the data can't tell apart.
    const how: "elim" | "other" = lost >= 5 ? "elim" : "other";
    return { index: r.index, side: !r.winner ? null : r.winner === ally ? ("ally" as const) : ("enemy" as const), how };
  });
}

export function RoundTimeline({ match, me, fightRounds }: { match: MatchSummary; me?: MatchPlayer; fightRounds: Set<number> }) {
  if (!match.rounds.length) return null;
  const ally = me?.team ?? match.teams[0]?.id ?? "";
  const rounds = roundsOf(match, ally);
  const myKills = me ? match.kills.filter((k) => k.killer === me.puuid) : [];
  const Icon = ({ how }: { how: "elim" | "other" }) => (how === "elim" ? <Skull size={16} weight="fill" aria-hidden /> : <Diamond size={14} weight="fill" aria-hidden />);

  return (
    <section className="vs-timeline" aria-label="Rounds">
      <div className="vs-tl-labels" aria-hidden="true">
        <span className="ally">{me ? "You" : "A"}</span>
        <span />
        <span className="enemy">{me ? "Them" : "B"}</span>
      </div>
      <div className="vs-tl-rounds">
        {rounds.map((r, i) => {
          const kills = myKills.filter((k) => k.round === r.index).length;
          const half = i === 12 || (i >= 24 && i % 2 === 0);
          return (
            <div
              key={r.index}
              className={`vs-round${half ? " half" : ""}${fightRounds.has(r.index) ? " streamer" : ""}`}
              title={`Round ${r.index + 1}: ${r.side === "ally" ? "won" : r.side === "enemy" ? "lost" : "no result"}${r.side && r.how === "elim" ? " by elimination" : ""}${kills ? ` · ${kills} kill${kills === 1 ? "" : "s"}` : ""}${fightRounds.has(r.index) ? " · you fought a streamer" : ""}`}
            >
              <span className={`vs-win ally${r.side === "ally" ? " on" : ""}`}>{r.side === "ally" && <Icon how={r.how} />}</span>
              <span className="vs-num">{r.index + 1}</span>
              <span className={`vs-win enemy${r.side === "enemy" ? " on" : ""}`}>{r.side === "enemy" && <Icon how={r.how} />}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function PostMatchScoreboard({ match, me, streamers, children }: { match: MatchSummary; me?: MatchPlayer; streamers: Map<string, Streamer | null>; children?: ReactNode }) {
  const ally = me?.team ?? match.teams[0]?.id ?? "";
  const allyTeam = match.teams.find((t) => t.id === ally);
  const enemyTeam = match.teams.find((t) => t.id !== ally);
  const won = allyTeam?.won;
  const draw = allyTeam && enemyTeam && allyTeam.roundsWon === enemyTeam.roundsWon;

  // First bloods: the first kill of each round. Multi-kills: rounds with 3 or more kills.
  const firstBloods = new Map<string, number>();
  const multis = new Map<string, number>();
  for (const r of match.rounds) {
    const ks = match.kills.filter((k) => k.round === r.index).sort((a, b) => a.inRoundMs - b.inRoundMs);
    if (ks[0]) firstBloods.set(ks[0].killer, (firstBloods.get(ks[0].killer) ?? 0) + 1);
    const per = new Map<string, number>();
    for (const k of ks) per.set(k.killer, (per.get(k.killer) ?? 0) + 1);
    for (const [who, n] of per) if (n >= 3) multis.set(who, (multis.get(who) ?? 0) + 1);
  }
  const teams = [ally, ...match.teams.map((t) => t.id).filter((t) => t !== ally)];

  const table = (team: string) => {
    const t = match.teams.find((x) => x.id === team);
    const side = team === ally ? "ally" : "enemy";
    const players = match.players.filter((p) => p.team === team).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    return (
      <table key={team} className={`vs-table ${side}`}>
        <thead>
          <tr>
            <th className="vs-player">
              <div className="vs-cell">
              <span className="vs-team">{side === "ally" ? (me ? "Your team" : `Team ${team}`) : me ? "Enemy team" : `Team ${team}`}</span>
              {t && <span className="vs-team-score">{t.roundsWon}</span>}
              </div>
            </th>
            <th>K</th>
            <th>D</th>
            <th>A</th>
            <th>+/−</th>
            <th>K/D</th>
            <th title="First bloods: the first kill of a round">FB</th>
            <th title="Multi-kills: rounds with 3 or more kills">MK</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p) => {
            const mine = p.puuid === me?.puuid;
            const diff = p.kills - p.deaths;
            const live = streamers.get(p.puuid);
            return (
              <tr key={p.puuid} className={mine ? "vs-row me" : "vs-row"}>
                <td className="vs-player">
                  <div className="vs-cell">
                  <span className="vs-agent"><AgentIcon agent={p.agent} className="size-full" /></span>
                  <span className="vs-name">
                    <b>{p.name}<i>#{p.tag}</i></b>
                    <small>{p.agent}{mine ? " · you" : ""}</small>
                  </span>
                  {live && (
                    <a className="vs-live" href={`https://www.twitch.tv/${live.login}`} target="_blank" rel="noreferrer" title={`${live.name} on Twitch`}>
                      <TwitchIcon size={12} /> Twitch
                    </a>
                  )}
                  </div>
                </td>
                <td>{p.kills}</td>
                <td>{p.deaths}</td>
                <td>{p.assists}</td>
                <td className={diff > 0 ? "up" : diff < 0 ? "down" : undefined}>{diff > 0 ? `+${diff}` : diff}</td>
                <td>{(p.kills / Math.max(1, p.deaths)).toFixed(1)}</td>
                <td>{firstBloods.get(p.puuid) ?? 0}</td>
                <td>{multis.get(p.puuid) ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  return (
    <section className="vs-board" aria-label="Scoreboard">
      <header className="vs-head">
        <span className={`vs-result ${draw ? "draw" : won ? "win" : "loss"}`}>{draw ? "Draw" : won ? "Victory" : "Defeat"}</span>
        <span className="vs-score">
          <b className="ally">{allyTeam?.roundsWon ?? "–"}</b>
          <i>–</i>
          <b className="enemy">{enemyTeam?.roundsWon ?? "–"}</b>
        </span>
        <span className="vs-mode">{match.mode} · {match.map}</span>
      </header>
      {children}
      {teams.map(table)}
    </section>
  );
}
