import { useState, type FormEvent, type ReactNode } from "react";
import type { Page } from "../components/Shell";
import { Notice, Panel, Seg, Stat } from "../components/ui";
import {
  addStreamerChannel,
  findMe,
  isDesktop,
  lookupLatestMatch,
  lookupStreamers,
  type MatchPlayer,
  type MatchStreamers,
  type MatchSummary,
  type WebStreamer,
} from "../lib/backend";
import { ini, result, resultColor, streamerLabel } from "../lib/matchInfo";
import { REGIONS, type Settings } from "../lib/settings";
import { matchTimeAgo, type useMatches } from "../lib/useMatches";
import { formatDuration, timeAgo } from "../lib/useRecorder";

/** What we know about one player being a streamer, from the app or the website demo. */
interface Live {
  login: string;
  name: string;
  text: string;
  tone: string;
}

function liveInfo(p: MatchPlayer, match: MatchSummary, me: MatchPlayer | undefined, streamers?: MatchStreamers, web?: WebStreamer[] | "checking"): Live | null {
  const st = streamers?.players.find((s) => s.puuid === p.puuid);
  if (st) {
    const l = streamerLabel(st);
    return { login: st.channel.login, name: st.channel.displayName, text: l.text, tone: l.tone };
  }
  const ws = Array.isArray(web) ? web.find((w) => w.puuid === p.puuid) : undefined;
  if (ws) {
    const fights = me ? match.kills.filter((k) => (k.killer === me.puuid && k.victim === p.puuid) || (k.killer === p.puuid && k.victim === me.puuid)).length : 0;
    return { login: ws.channel.login, name: ws.channel.displayName, text: ws.vod ? (me ? `VOD found · ${fights} fights` : "VOD found") : "was live · no VOD saved", tone: ws.vod ? "good" : "bad" };
  }
  return null;
}

const mmss = (ms: number) => formatDuration(Math.max(0, Math.round(ms / 1000)));

function MatchDetail({
  match,
  riotId,
  streamers,
  web,
  actions,
}: {
  match: MatchSummary;
  riotId: string;
  streamers?: MatchStreamers;
  web?: WebStreamer[] | "checking";
  actions?: ReactNode;
}) {
  const me = findMe(match, riotId);
  const r = result(match, me);
  const checked = Boolean(streamers?.checkedMs) || Array.isArray(web);
  const live = new Map(match.players.map((p) => [p.puuid, liveInfo(p, match, me, streamers, web)]));
  const streamerIds = new Set([...live.entries()].filter(([, v]) => v).map(([k]) => k));

  const myKills = me ? match.kills.filter((k) => k.killer === me.puuid) : [];
  const firstBloods = new Set<number>();
  if (me) {
    const first = new Map<number, (typeof match.kills)[number]>();
    for (const k of match.kills) if (!first.has(k.round) || k.inRoundMs < first.get(k.round)!.inRoundMs) first.set(k.round, k);
    for (const [round, k] of first) if (k.killer === me.puuid) firstBloods.add(round);
  }
  const fights = me
    ? match.kills
        .filter((k) => (k.killer === me.puuid && streamerIds.has(k.victim)) || (k.victim === me.puuid && streamerIds.has(k.killer)))
        .sort((a, b) => a.atMs - b.atMs)
    : [];
  const fightRounds = new Set(fights.map((k) => k.round));

  const teams = [...new Set(match.players.map((p) => p.team))].sort((a, b) => (a === me?.team ? -1 : b === me?.team ? 1 : 0));
  const teamInfo = (id: string) => match.teams.find((t) => t.id === id);

  return (
    <>
      <Panel
        title={`${match.map} · ${match.mode}${r ? ` · ${r.letter === "W" ? "Win" : r.letter === "L" ? "Loss" : "Draw"} ${r.score}` : ""}`}
        color={resultColor(r?.letter)}
        right={
          <span className="row-wrap" style={{ justifyContent: "flex-end" }}>
            <span className="pill">{matchTimeAgo(match.startedAt)}</span>
            {match.lengthMs > 0 && <span className="pill">{mmss(match.lengthMs)}</span>}
            <span className="pill">{match.kills.length} kills synced</span>
            {streamers?.checkedMs ? <span className="pill good">✓ checked · {timeAgo(streamers.checkedMs)}</span> : web === "checking" ? <span className="pill warn">checking Twitch…</span> : !checked && <span className="pill">not checked yet</span>}
          </span>
        }
      >
        <div className="pad stack">
          <div className="stats" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
            <Stat label="K / D / A" value={me ? `${me.kills}/${me.deaths}/${me.assists}` : "—"} />
            <Stat label="K / D" value={me ? (me.kills / Math.max(1, me.deaths)).toFixed(2) : "—"} />
            <Stat label="Agent" value={me?.agent ?? "—"} />
            <Stat label="First bloods" value={me ? firstBloods.size : "—"} />
            <Stat label="Streamers" value={streamerIds.size} purple />
            <Stat label="Streamer fights" value={fights.length} purple />
          </div>
          {match.rounds.length > 0 && (
            <>
              <div className="rounds">
                {match.rounds.map((round) => {
                  const kills = myKills.filter((k) => k.round === round.index).length;
                  const died = me && match.kills.some((k) => k.round === round.index && k.victim === me.puuid);
                  const cls = ["rnd", !me || !round.winner ? "unknown" : round.winner === me.team ? "won" : "", fightRounds.has(round.index) ? "streamer" : ""].join(" ");
                  return (
                    <div key={round.index} className={cls} title={`Round ${round.index + 1}`}>
                      <span className="n">{round.index + 1}</span>
                      <span className="k">{"●".repeat(Math.min(kills, 5))}</span>
                      <span className="x">{died ? "✕" : ""}</span>
                    </div>
                  );
                })}
              </div>
              <div className="legend">
                <span><span style={{ color: "var(--win)" }}>■</span> won</span>
                <span><span style={{ color: "var(--loss)" }}>■</span> lost</span>
                <span>● your kills</span>
                <span style={{ color: "#ff7b7b" }}>✕ you died</span>
                <span className="purple">▢ fought a streamer</span>
              </div>
            </>
          )}
          {!me && <span className="muted small">Your Riot ID isn't in this match, so wins, kills and fights can't be shown from your side.</span>}
        </div>
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 12 }}>
        {teams.map((team) => {
          const t = teamInfo(team);
          const mine = team === me?.team;
          const players = match.players.filter((p) => p.team === team).sort((a, b) => b.kills - a.kills);
          return (
            <section key={team} className="panel" aria-label={mine ? "Your team" : `Team ${team}`}>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr className="team-head"><th colSpan={3} style={{ color: mine ? "var(--good)" : "var(--rec-text)", background: mine ? "#0f1a13" : "#1a0f0f" }}>{mine ? "Your team" : me ? "Enemy" : team}{t ? ` · ${t.roundsWon}` : ""}</th></tr>
                    <tr><th>Player</th><th>K/D/A</th><th>Streamer</th></tr>
                  </thead>
                  <tbody>
                    {players.map((p) => {
                      const l = live.get(p.puuid);
                      return (
                        <tr key={p.puuid}>
                          <td className="ellipsis" style={{ maxWidth: 200 }}>
                            <span className="ag" title={p.agent}>{ini(p.agent)}</span>
                            <b>{p.name}</b> <span className="m tiny dim">#{p.tag}</span>
                          </td>
                          <td className="m">{p.kills}/{p.deaths}/{p.assists}</td>
                          <td>
                            {p.puuid === me?.puuid ? <span className="dim small">you</span>
                              : l ? (
                                <span className="stack" style={{ gap: 2, alignItems: "flex-start" }}>
                                  <a className="chip" href={`https://www.twitch.tv/${l.login}`} target="_blank" rel="noreferrer"><span className="pf-dot" />{l.name}</a>
                                  <span className={`small ${l.tone}`}>{l.text}</span>
                                </span>
                              ) : <span className="dim small">{web === "checking" ? "checking…" : checked ? "—" : isDesktop ? "checks soon" : "—"}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>

      <Panel title="Fights with streamers" color="var(--twitch)" right={actions}>
        {fights.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Round</th><th>Streamer</th><th>Moment</th><th>At</th><th>Clips</th></tr></thead>
              <tbody>
                {fights.map((k, i) => {
                  const them = k.killer === me?.puuid ? k.victim : k.killer;
                  const l = live.get(them)!;
                  return (
                    <tr key={i}>
                      <td className="m">R{k.round + 1}</td>
                      <td><span className="chip"><span className="pf-dot" />{l.name}</span></td>
                      <td>{k.killer === me?.puuid ? "you killed them" : "they killed you"}</td>
                      <td className="m">{mmss(k.inRoundMs)}</td>
                      <td className={`small ${l.tone}`}>{l.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            <span>{!checked ? "Streamers haven't been checked for this match yet." : streamerIds.size ? "You didn't fight any of the streamers in this match." : "Nobody in this lobby was streaming."}</span>
          </div>
        )}
        {streamers?.error && <p className="note bad">{streamers.error}</p>}
      </Panel>
    </>
  );
}

/** "Played against a streamer it missed?": link a player to a Twitch channel. */
function AddChannel({ match, riotId, onAdded }: { match: MatchSummary; riotId: string; onAdded: (s: MatchStreamers) => void }) {
  const me = findMe(match, riotId);
  const others = match.players.filter((p) => p.puuid !== me?.puuid);
  const [puuid, setPuuid] = useState("");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAdded(await addStreamerChannel(match.id, puuid, channel.trim()));
      setChannel("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Missed a streamer?" color="var(--warn)">
      <form className="pad stack" onSubmit={(e) => void submit(e)}>
        <span className="muted small">Pick the player and paste their channel. CrossPOV checks they were live during this match, then clips your fights from their VOD.</span>
        <div className="row-wrap">
          <select className="input" aria-label="Player" value={puuid} onChange={(e) => setPuuid(e.target.value)}>
            <option value="">Which player?</option>
            {others.map((p) => (
              <option key={p.puuid} value={p.puuid}>{p.name}#{p.tag} · {p.agent}</option>
            ))}
          </select>
          <input className="input grow" aria-label="Twitch channel" placeholder="twitch.tv/channel" value={channel} onChange={(e) => setChannel(e.target.value)} spellCheck={false} />
          <button type="submit" className="b r" disabled={busy || !puuid || channel.trim().length < 3}>{busy ? "Checking…" : "Check VOD"}</button>
        </div>
        {error && <span className="small bad">{error}</span>}
      </form>
    </Panel>
  );
}

/** Website demo: look up any Riot ID's latest match through this site's server. */
function DemoLookup() {
  const [riotId, setRiotId] = useState("");
  const [region, setRegion] = useState("eu");
  const [match, setMatch] = useState<MatchSummary | null>(null);
  const [web, setWeb] = useState<WebStreamer[] | "checking" | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setWeb(undefined);
    try {
      const m = await lookupLatestMatch(riotId.trim(), region);
      setMatch(m);
      setWeb("checking");
      try {
        setWeb(await lookupStreamers(m, findMe(m, riotId)?.puuid));
      } catch (err) {
        setWeb(undefined);
        setError(`Streamer check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      setMatch(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Panel title="Try it: look up a match" color="var(--kick)" className="s4">
        <form className="pad stack" onSubmit={(e) => void submit(e)}>
          <span className="muted small">
            Enter a Riot ID to load its latest finished match and check which players were streaming on Twitch, the same steps the
            desktop app runs after each game. Clips themselves are made by the app on your PC.
          </span>
          <input className="input" aria-label="Riot ID" placeholder="Name#TAG" value={riotId} onChange={(e) => setRiotId(e.target.value)} spellCheck={false} />
          <select className="input" aria-label="Region" value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button type="submit" className="b r" disabled={busy || !riotId.includes("#")}>{busy ? "Loading…" : "Look up"}</button>
          {error && <span className="small bad" role="alert">{error}</span>}
        </form>
      </Panel>
      <div className="s8 col">
        {match ? (
          <MatchDetail match={match} riotId={riotId} web={web} />
        ) : (
          <Panel title="Match"><div className="empty"><span>The match, both teams and any streamers show up here.</span></div></Panel>
        )}
      </div>
    </>
  );
}

type Filter = "all" | "streamers" | "competitive";

export default function Matches({
  settings,
  matchesState,
  onNavigate,
}: {
  settings: Settings;
  matchesState: ReturnType<typeof useMatches>;
  onNavigate: (p: Page) => void;
}) {
  const { matches, status, checking, checkNow, streamers, putStreamers, checkStreamers } = matchesState;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState("");

  if (!isDesktop) return <DemoLookup />;

  const shown = matches.filter((m) =>
    filter === "streamers" ? (streamers[m.id]?.players.length ?? 0) > 0 : filter === "competitive" ? /competitive/i.test(m.mode) : true,
  );
  const match = shown.find((m) => m.id === selected) ?? shown[0];

  async function recheck() {
    if (!match) return;
    setRechecking(true);
    setRecheckError("");
    try {
      await checkStreamers(match.id);
    } catch (err) {
      setRecheckError(String(err));
    } finally {
      setRechecking(false);
    }
  }

  return (
    <>
      {status && !status.configured && (
        <Notice tone="warn">
          Add your Riot ID in Settings so CrossPOV can find your matches.{" "}
          <button type="button" className="linkish" onClick={() => onNavigate("settings")}>Open Settings</button>
        </Notice>
      )}
      {status?.error && status.configured && <Notice tone="bad">{status.error}</Notice>}
      {recheckError && <Notice tone="bad">{recheckError}</Notice>}

      <Panel
        title="Match history"
        color="var(--kick)"
        className="s4"
        right={<button type="button" className="b sm" onClick={() => void checkNow()} disabled={checking || !status?.configured}>{checking ? "Checking…" : "Check now"}</button>}
      >
        <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
          <Seg label="Show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "streamers", label: "With streamers" }, { value: "competitive", label: "Competitive" }]} />
        </div>
        {shown.length ? (
          <ul className="match-list">
            {shown.map((m) => {
              const me = findMe(m, settings.riotId);
              const r = result(m, me);
              const s = streamers[m.id];
              const n = s?.players.length ?? 0;
              return (
                <li key={m.id}>
                  <button type="button" aria-pressed={m.id === match?.id} onClick={() => setSelected(m.id)}>
                    <span className="res" style={{ background: resultColor(r?.letter) }} />
                    <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                      <b style={{ fontSize: 12.5 }}>{m.map} <span className="dim" style={{ fontWeight: 500, fontSize: 11 }}>· {m.mode}</span></b>
                      <span className="m tiny muted">{me ? `${me.kills}/${me.deaths}/${me.assists} · ` : ""}{matchTimeAgo(m.startedAt)}</span>
                    </span>
                    <span className="stack" style={{ gap: 2, alignItems: "flex-end" }}>
                      <b className="m" style={{ fontSize: 12, color: resultColor(r?.letter) }}>{r ? `${r.letter} ${r.score}` : m.teams.map((t) => t.roundsWon).join("–")}</b>
                      <span className={`tiny ${n ? "purple" : "dim"}`}>{n ? `${n} streamer${n === 1 ? "" : "s"}` : s?.checkedMs ? "no streamers" : ""}</span>
                      <span className="m dim" style={{ fontSize: 9 }}>{s?.checkedMs ? "✓ checked" : "not checked yet"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="empty">
            <strong>No matches{filter !== "all" ? " here" : " yet"}</strong>
            <span>{settings.riotId ? "Play a match. It shows up a minute or two after it ends." : "Add your Riot ID in Settings first."}</span>
          </div>
        )}
        <p className="note">
          {status?.lastCheckMs ? `Last checked ${timeAgo(status.lastCheckMs)}. ` : ""}Each match is checked for streamers once, and a second time if nobody was live.
        </p>
      </Panel>

      <div className="s8 col">
        {match ? (
          <>
            <MatchDetail
              match={match}
              riotId={settings.riotId}
              streamers={streamers[match.id]}
              actions={<button type="button" className="b sm" onClick={() => void recheck()} disabled={rechecking}>{rechecking ? "Checking…" : "Check again"}</button>}
            />
            <AddChannel match={match} riotId={settings.riotId} onAdded={putStreamers} />
          </>
        ) : (
          <Panel title="Match"><div className="empty"><span>Pick a match to see both teams, your rounds and any streamers.</span></div></Panel>
        )}
      </div>
    </>
  );
}
