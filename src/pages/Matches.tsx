import { useState, type FormEvent, type ReactNode } from "react";
import type { Page } from "../components/Shell";
import { GalleryCard, Notice, PendingCard } from "../components/ui";
import {
  addStreamerChannel,
  findMe,
  isDesktop,
  lookupLatestMatch,
  lookupStreamers,
  openClip,
  type ClipInfo,
  type MatchPlayer,
  type MatchStreamers,
  type SuggestedStreamer,
  type MatchSummary,
  type WebStreamer,
} from "../lib/backend";
import { result, resultColor, streamerLabel } from "../lib/matchInfo";
import { REGIONS, type Settings } from "../lib/settings";
import { matchTimeAgo, type useMatches } from "../lib/useMatches";
import { timeAgo, type useRecorder } from "../lib/useRecorder";

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


/** Rounds strip and both teams: the details, shown on request. */
function Scoreboard({ match, me, live, fightRounds, web, checked }: {
  match: MatchSummary;
  me?: MatchPlayer;
  live: Map<string, Live | null>;
  fightRounds: Set<number>;
  web?: WebStreamer[] | "checking";
  checked: boolean;
}) {
  const myKills = me ? match.kills.filter((k) => k.killer === me.puuid) : [];
  const teams = [...new Set(match.players.map((p) => p.team))].sort((a, b) => (a === me?.team ? -1 : b === me?.team ? 1 : 0));
  return (
    <div className="stack" style={{ gap: 16 }}>
      {match.rounds.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="rounds">
            {match.rounds.map((round) => {
              const kills = myKills.filter((k) => k.round === round.index).length;
              const cls = ["rnd", !me || !round.winner ? "unknown" : round.winner === me.team ? "won" : "lost", fightRounds.has(round.index) ? "streamer" : ""].join(" ");
              return <div key={round.index} className={cls} title={`Round ${round.index + 1}${kills ? `: ${kills} kill${kills === 1 ? "" : "s"}` : ""}`}><span>{round.index + 1}</span></div>;
            })}
          </div>
          <span className="muted small">Green won, red lost, outlined rounds had a fight with a streamer.</span>
        </div>
      )}
      <div className="teams">
        {teams.map((team) => {
          const t = match.teams.find((x) => x.id === team);
          const mine = team === me?.team;
          const players = match.players.filter((p) => p.team === team).sort((a, b) => b.kills - a.kills);
          return (
            <table key={team} className="tbl">
              <thead><tr><th colSpan={3}>{mine ? "Your team" : me ? "Enemy team" : `Team ${team}`}{t ? ` · ${t.roundsWon}` : ""}</th></tr></thead>
              <tbody>
                {players.map((p) => {
                  const l = live.get(p.puuid);
                  return (
                    <tr key={p.puuid}>
                      <td className="ellipsis" style={{ maxWidth: 220 }}><b>{p.name}</b> <span className="dim">#{p.tag}</span> <span className="muted">· {p.agent}</span></td>
                      <td className="num">{p.kills}/{p.deaths}/{p.assists}</td>
                      <td style={{ textAlign: "right" }}>
                        {p.puuid === me?.puuid ? <span className="dim">you</span>
                          : l ? <a className="streamer-link" href={`https://www.twitch.tv/${l.login}`} target="_blank" rel="noreferrer">{l.name}</a>
                          : <span className="dim">{web === "checking" ? "checking…" : checked ? "" : ""}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        })}
      </div>
    </div>
  );
}

/** One fight (or trade) with a streamer: its clip when saved, otherwise where it's at. */
interface Fight {
  round: number;
  login: string;
  name: string;
  killed: boolean;
  died: boolean;
  status: Live;
}

function MatchView({
  match,
  riotId,
  clips,
  streamers,
  web,
  onPlay,
  actions,
  children,
}: {
  match: MatchSummary;
  riotId: string;
  clips: ClipInfo[];
  streamers?: MatchStreamers;
  web?: WebStreamer[] | "checking";
  onPlay: (c: ClipInfo) => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const [showBoard, setShowBoard] = useState(false);
  const me = findMe(match, riotId);
  const r = result(match, me);
  const checked = Boolean(streamers?.checkedMs) || Array.isArray(web);
  const live = new Map(match.players.map((p) => [p.puuid, liveInfo(p, match, me, streamers, web)]));
  const liveList = match.players.filter((p) => live.get(p.puuid) && p.puuid !== me?.puuid);

  const fights: Fight[] = [];
  if (me) {
    for (const k of [...match.kills].sort((a, b) => a.atMs - b.atMs)) {
      const them = k.killer === me.puuid ? k.victim : k.victim === me.puuid ? k.killer : null;
      const l = them ? live.get(them) : null;
      if (!them || !l) continue;
      const f = fights.find((x) => x.round === k.round && x.login === l.login);
      if (f) {
        f.killed ||= k.killer === me.puuid;
        f.died ||= k.victim === me.puuid;
      } else {
        fights.push({ round: k.round, login: l.login, name: l.name, killed: k.killer === me.puuid, died: k.victim === me.puuid, status: l });
      }
    }
  }
  const fightRounds = new Set(fights.map((f) => f.round));
  const clipFor = (f: Fight) =>
    clips.find((c) => c.kind === "theirs" && c.streamer?.toLowerCase() === f.login.toLowerCase() && c.round === f.round + 1 && (!c.map || c.map === match.map));
  const what = (f: Fight) => (f.killed && f.died ? "traded kills" : f.killed ? "you killed them" : "they killed you");

  const outcome = r ? `${r.letter === "W" ? "Win" : r.letter === "L" ? "Loss" : "Draw"} ${r.score}` : match.teams.map((t) => t.roundsWon).join("–");
  const streamerLine = web === "checking" ? "Checking who was live on Twitch…"
    : !checked ? "Streamers are checked a minute or two after the match."
    : liveList.length ? `${liveList.length} streamer${liveList.length === 1 ? " was" : "s were"} in this match.`
    : "Nobody in this lobby was streaming.";

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="match-head">
        <div className="stack" style={{ gap: 6 }}>
          <h1>{match.map} · <span style={{ color: resultColor(r?.letter) }}>{outcome}</span></h1>
          <span className="muted">
            {[me && `You played ${me.agent}, ${me.kills}/${me.deaths}/${me.assists}`, match.mode, matchTimeAgo(match.startedAt)].filter(Boolean).join(" · ")}
          </span>
        </div>
        <span className="row" style={{ gap: 8 }}>
          {actions}
          <button type="button" className="btn quiet" aria-expanded={showBoard} onClick={() => setShowBoard(!showBoard)}>{showBoard ? "Hide scoreboard" : "Scoreboard"}</button>
        </span>
      </div>

      <div className="streamer-line">
        <span>{streamerLine}</span>
        {liveList.map((p) => {
          const l = live.get(p.puuid)!;
          return (
            <a key={p.puuid} className="streamer-chip" href={`https://www.twitch.tv/${l.login}`} target="_blank" rel="noreferrer">
              <b>{l.name}</b> <span className={l.tone}>{l.text}</span>
            </a>
          );
        })}
      </div>

      {fights.length > 0 && (
        <div className="gallery">
          {fights.map((f) => {
            const c = clipFor(f);
            const title = `Round ${f.round + 1} · ${what(f)}`;
            return c ? (
              <GalleryCard key={`${f.login}-${f.round}`} clip={c} title={title} meta={f.name} onPlay={() => onPlay(c)} />
            ) : (
              <PendingCard key={`${f.login}-${f.round}`} title={title} meta={f.name}>
                <span className={`pending-text ${f.status.tone}`}>{f.status.text}</span>
              </PendingCard>
            );
          })}
        </div>
      )}
      {checked && liveList.length > 0 && !fights.length && me && <p className="muted">You didn't fight any of them this match.</p>}
      {!me && <p className="muted">Your Riot ID isn't in this match, so your fights can't be shown.</p>}

      {children}

      {showBoard && <Scoreboard match={match} me={me} live={live} fightRounds={fightRounds} web={web} checked={checked} />}
      {streamers?.error && <p className="small bad">{streamers.error}</p>}
    </div>
  );
}

/** One stream the scoreboard scanner found in this match: the user picks which player it was. */
function Suggestion({ match, riotId, s, onAdded }: { match: MatchSummary; riotId: string; s: SuggestedStreamer; onAdded: (m: MatchStreamers) => void }) {
  const me = findMe(match, riotId);
  const team = match.players.filter((p) => p.team === s.team && p.puuid !== me?.puuid);
  const [puuid, setPuuid] = useState(team.length === 1 ? team[0].puuid : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const side = !me ? `team ${s.team}` : s.team === me.team ? "your team" : "the enemy team";

  async function link() {
    setBusy(true);
    setError("");
    try {
      onAdded(await addStreamerChannel(match.id, puuid, s.login, s.delaySec));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="soft-row">
      <span className="grow">
        <b><a href={`https://www.twitch.tv/${s.login}`} target="_blank" rel="noreferrer">{s.displayName || s.login}</a></b>{" "}
        <span className="muted">was on {side} (found by their scoreboard). Which player were they?</span>
        {error && <span className="small bad" style={{ display: "block" }}>{error}</span>}
      </span>
      <label className="field">
        <span className="sr-only">Which player was {s.login}</span>
        <select value={puuid} onChange={(e) => setPuuid(e.target.value)}>
          <option value="">Choose player</option>
          {team.map((p) => (
            <option key={p.puuid} value={p.puuid}>{p.name}#{p.tag} · {p.agent}</option>
          ))}
        </select>
      </label>
      <button type="button" className="btn primary" disabled={!puuid || busy} onClick={() => void link()}>{busy ? "Checking…" : "Link"}</button>
    </div>
  );
}

/** "Missed a streamer?": link a player to a Twitch channel. Hidden behind a button. */
function AddChannel({ match, riotId, onAdded }: { match: MatchSummary; riotId: string; onAdded: (s: MatchStreamers) => void }) {
  const me = findMe(match, riotId);
  const others = match.players.filter((p) => p.puuid !== me?.puuid);
  const [open, setOpen] = useState(false);
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
      setOpen(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <button type="button" className="linkish muted" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>Add a streamer we missed</button>;
  return (
    <form className="soft-box stack" onSubmit={(e) => void submit(e)}>
      <b>Add a streamer we missed</b>
      <span className="muted small">
        Clips follow the player you pick, so choose the right one. CrossPOV first checks the scoreboard in their VOD shows this game, so
        a wrong channel or player gets no clips. The link is kept on this PC only.
      </span>
      <div className="row-wrap" style={{ gap: 8 }}>
        <label className="field">
          <span className="sr-only">Player</span>
          <select value={puuid} onChange={(e) => setPuuid(e.target.value)}>
            <option value="">Which player?</option>
            {others.map((p) => (
              <option key={p.puuid} value={p.puuid}>{p.name}#{p.tag} · {me ? (p.team === me.team ? "teammate" : "enemy") : "player"} · {p.agent}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span className="sr-only">Twitch channel</span>
          <input placeholder="twitch.tv/channel" value={channel} onChange={(e) => setChannel(e.target.value)} spellCheck={false} />
        </label>
        <button type="submit" className="btn primary" disabled={busy || !puuid || channel.trim().length < 3}>{busy ? "Checking…" : "Check VOD"}</button>
        <button type="button" className="btn quiet" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <span className="small bad">{error}</span>}
    </form>
  );
}

/** Website demo: look up any Riot ID's latest real match through this site's server. */
function DemoLookup({ onFound }: { onFound: (m: MatchSummary, riotId: string, web: WebStreamer[] | "checking" | undefined) => void }) {
  const [riotId, setRiotId] = useState("");
  const [region, setRegion] = useState("eu");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const id = riotId.trim();
      const m = await lookupLatestMatch(id, region);
      onFound(m, id, "checking");
      try {
        onFound(m, id, await lookupStreamers(m, findMe(m, id)?.puuid));
      } catch (err) {
        onFound(m, id, undefined);
        setError(`Streamer check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="soft-row" onSubmit={(e) => void submit(e)}>
      <span className="grow"><b>Try it with a real match.</b> <span className="muted">Enter any Riot ID to load its latest match and see who was live.</span></span>
      <label className="field">
        <span className="sr-only">Riot ID</span>
        <input placeholder="Name#TAG" value={riotId} onChange={(e) => setRiotId(e.target.value)} spellCheck={false} />
      </label>
      <label className="field">
        <span className="sr-only">Region</span>
        <select value={region} onChange={(e) => setRegion(e.target.value)}>
          {REGIONS.map((r) => (
            <option key={r.value} value={r.value}>{r.value.toUpperCase()}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn primary" disabled={busy || !riotId.includes("#")}>{busy ? "Loading…" : "Look up"}</button>
      {error && <span className="small bad" role="alert" style={{ flexBasis: "100%" }}>{error}</span>}
    </form>
  );
}

export default function Matches({
  settings,
  matchesState,
  recorder,
  onNavigate,
}: {
  settings: Settings;
  matchesState: ReturnType<typeof useMatches>;
  recorder: ReturnType<typeof useRecorder>;
  onNavigate: (p: Page) => void;
}) {
  const { matches, status, checking, checkNow, streamers, putStreamers, checkStreamers } = matchesState;
  const [selected, setSelected] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState("");
  /** Website demo: a real match the visitor looked up. */
  const [looked, setLooked] = useState<{ match: MatchSummary; riotId: string; web?: WebStreamer[] | "checking" } | null>(null);

  const all = looked ? [looked.match, ...matches.filter((m) => m.id !== looked.match.id)] : matches;
  const match = all.find((m) => m.id === selected) ?? all[0];
  const play = (c: ClipInfo) => void openClip(c.path).catch((err) => recorder.notify(String(err), "bad"));

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
    <section className="s12 page" aria-label="Matches">
      {status && !status.configured && isDesktop && (
        <Notice tone="warn">
          Add your Riot ID in Settings so CrossPOV can find your matches.{" "}
          <button type="button" className="linkish" onClick={() => onNavigate("settings")}>Open Settings</button>
        </Notice>
      )}
      {status?.error && status.configured && <Notice tone="bad">{status.error}</Notice>}
      {recheckError && <Notice tone="bad">{recheckError}</Notice>}
      {!isDesktop && (
        <DemoLookup
          onFound={(m, riotId, web) => {
            setLooked({ match: m, riotId, web });
            setSelected(m.id);
          }}
        />
      )}

      <div className="match-strip" role="list" aria-label="Your matches">
        {all.map((m) => {
          const isLooked = m.id === looked?.match.id;
          const me = findMe(m, isLooked ? looked.riotId : settings.riotId);
          const r = result(m, me);
          const n = streamers[m.id]?.players.length ?? 0;
          return (
            <button key={m.id} type="button" role="listitem" aria-current={m.id === match?.id ? "true" : undefined} onClick={() => setSelected(m.id)}>
              <b>{m.map} <span style={{ color: resultColor(r?.letter) }}>{r ? r.score : m.teams.map((t) => t.roundsWon).join("–")}</span></b>
              <span>{matchTimeAgo(m.startedAt)}{n ? ` · ${n} streamer${n === 1 ? "" : "s"}` : ""}</span>
            </button>
          );
        })}
        {isDesktop && (
          <button type="button" className="strip-action" onClick={() => void checkNow()} disabled={checking || !status?.configured} title={status?.lastCheckMs ? `Last checked ${timeAgo(status.lastCheckMs)}` : undefined}>
            {checking ? "Checking…" : "Check now"}
          </button>
        )}
      </div>

      {match && match.id === looked?.match.id ? (
        <MatchView match={match} riotId={looked.riotId} clips={[]} web={looked.web} onPlay={play} />
      ) : match ? (
        <MatchView
          match={match}
          riotId={settings.riotId}
          clips={recorder.clips}
          streamers={streamers[match.id]}
          onPlay={play}
          actions={isDesktop && <button type="button" className="btn quiet" onClick={() => void recheck()} disabled={rechecking}>{rechecking ? "Checking…" : "Check again"}</button>}
        >
          {(streamers[match.id]?.suggested ?? []).map((s) => (
            <Suggestion key={s.login} match={match} riotId={settings.riotId} s={s} onAdded={putStreamers} />
          ))}
          {isDesktop && <AddChannel match={match} riotId={settings.riotId} onAdded={putStreamers} />}
        </MatchView>
      ) : (
        <div className="empty-state">
          <b>No matches yet</b>
          <span>{settings.riotId ? "Play a match. It shows up a minute or two after it ends." : "Add your Riot ID in Settings first."}</span>
        </div>
      )}
    </section>
  );
}
