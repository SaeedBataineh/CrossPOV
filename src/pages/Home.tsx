import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Page } from "../components/Shell";
import { cardTitle, GalleryCard, Notice, PendingCard } from "../components/ui";
import {
  addStreamerChannel,
  findMe,
  isDesktop,
  lookupLatestMatch,
  lookupStreamers,
  type ClipInfo,
  type MatchPlayer,
  type MatchStreamers,
  type SuggestedStreamer,
  type MatchSummary,
  type WebStreamer,
} from "../lib/backend";
import { progress, result, resultColor, streamerLabel } from "../lib/matchInfo";
import { findPairs, matchOf, type Pair } from "../lib/pairs";
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


/** Every round as a coloured block: won, lost, and the ones with a streamer fight marked. */
function Rounds({ match, me, fightRounds }: { match: MatchSummary; me?: MatchPlayer; fightRounds: Set<number> }) {
  if (!match.rounds.length) return null;
  const myKills = me ? match.kills.filter((k) => k.killer === me.puuid) : [];
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="rounds">
        {match.rounds.map((round) => {
          const kills = myKills.filter((k) => k.round === round.index).length;
          const cls = ["rnd", !me || !round.winner ? "unknown" : round.winner === me.team ? "won" : "lost", fightRounds.has(round.index) ? "streamer" : ""].join(" ");
          return (
            <div key={round.index} className={cls} title={`Round ${round.index + 1}${kills ? `: ${kills} kill${kills === 1 ? "" : "s"}` : ""}${fightRounds.has(round.index) ? " · fought a streamer" : ""}`}>
              <span>{round.index + 1}</span>
              {kills > 0 && <i>{kills}</i>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Both teams, shown on request. */
function Scoreboard({ match, me, live }: { match: MatchSummary; me?: MatchPlayer; live: Map<string, Live | null> }) {
  const teams = [...new Set(match.players.map((p) => p.team))].sort((a, b) => (a === me?.team ? -1 : b === me?.team ? 1 : 0));
  return (
    <div className="teams">
      {teams.map((team) => {
        const t = match.teams.find((x) => x.id === team);
        const mine = team === me?.team;
        const players = match.players.filter((p) => p.team === team).sort((a, b) => b.kills - a.kills);
        return (
          <div key={team} className="soft-box" style={{ padding: "6px 4px" }}>
            <table className="tbl">
              <thead><tr><th colSpan={2}>{mine ? "Your team" : me ? "Enemy team" : `Team ${team}`}{t ? ` · ${t.roundsWon}` : ""}</th><th style={{ textAlign: "right" }}>K / D / A</th></tr></thead>
              <tbody>
                {players.map((p) => {
                  const l = live.get(p.puuid);
                  return (
                    <tr key={p.puuid} className={p.puuid === me?.puuid ? "you-row" : undefined}>
                      <td className="ellipsis" style={{ maxWidth: 220 }}><b>{p.name}</b> <span className="dim">#{p.tag}</span><span className="muted small" style={{ display: "block" }}>{p.agent}{p.puuid === me?.puuid ? " · you" : ""}</span></td>
                      <td>{l && <a className="streamer-link" href={`https://www.twitch.tv/${l.login}`} target="_blank" rel="noreferrer">{l.name}</a>}</td>
                      <td className="num" style={{ textAlign: "right" }}>{p.kills} / {p.deaths} / {p.assists}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
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

/** Which matches and cards the Home tabs show. */
export type Show = "all" | "streamers" | "mine";

function MatchView({
  match,
  riotId,
  clips,
  myClips = [],
  pairs = [],
  show = "all",
  streamers,
  web,
  onOpen,
  actions,
  children,
}: {
  match: MatchSummary;
  riotId: string;
  clips: ClipInfo[];
  /** Your own clips saved during this match. */
  myClips?: ClipInfo[];
  pairs?: Pair[];
  show?: Show;
  streamers?: MatchStreamers;
  web?: WebStreamer[] | "checking";
  onOpen: (c: ClipInfo) => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
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
    clips.find(
      (c) =>
        c.kind === "theirs" &&
        (c.matchId ? c.matchId === match.id : !c.map || c.map === match.map) &&
        c.round === f.round + 1 &&
        [f.login, f.name].some((n) => n.toLowerCase() === c.streamer?.toLowerCase()),
    );
  const pairOf = (c: ClipInfo) => pairs.find((p) => p.theirs.path === c.path || p.mine.path === c.path);
  const what = (f: Fight) => (f.killed && f.died ? "traded kills" : f.killed ? "you killed them" : "they killed you");

  const [open, setOpen] = useState(false);
  const score = r ? r.score : match.teams.map((t) => t.roundsWon).join("–");
  const progressOf = (puuid: string) => {
    const st = streamers?.players.find((x) => x.puuid === puuid);
    // A bar only while clips are actually downloading.
    return st && st.status === "working" && !st.checking ? progress(st) : null;
  };
  // Cards only for clips saved or on their way; a streamer with no clips coming
  // (sub-only VOD, no VOD) is one line in the header instead of empty boxes.
  const cards = fights.filter((f) => clipFor(f) || f.status.tone === "warn" || f.status.tone === "purple");
  const issues = liveList.map((p) => live.get(p.puuid)!).filter((l) => l.tone === "bad").map((l) => `${l.name}: ${l.text}`);
  const why = web === "checking" ? "checking who was live…"
    : !checked ? "streamers checked a minute or two after the match"
    : !liveList.length ? "no streamers"
    : issues.length ? issues.join(", ")
    : !fights.length && me ? "you didn't fight the streamers"
    : "";

  // Cards: each fight with a streamer (both sides when you saved it too), then your other clips.
  const paired = new Set<string>();
  const tiles: ReactNode[] = [];
  if (show !== "mine") {
    for (const f of cards) {
      const c = clipFor(f);
      const title = `R${f.round + 1} · ${what(f)}`;
      if (!c) {
        tiles.push(
          <PendingCard key={`${f.login}-${f.round}`} title={title} meta={f.name}>
            <span className={`pending-text ${f.status.tone}`}>{f.status.tone === "good" ? "clip deleted" : f.status.text}</span>
          </PendingCard>,
        );
        continue;
      }
      const p = pairOf(c);
      if (p) paired.add(p.mine.path);
      tiles.push(<GalleryCard key={c.path} clip={c} other={p?.mine} title={title} meta={p ? `Both sides · ${f.name}` : `Their side · ${f.name}`} onPlay={() => onOpen(c)} />);
    }
  } else {
    for (const c of myClips) {
      const p = pairOf(c);
      if (!p) continue;
      paired.add(c.path);
      tiles.push(<GalleryCard key={c.path} clip={c} other={p.theirs} title={cardTitle(c)} meta={`Both sides · ${p.theirs.streamer ?? "streamer"}`} onPlay={() => onOpen(c)} />);
    }
  }
  for (const c of myClips) {
    if (paired.has(c.path)) continue;
    const into = Math.max(0, Math.round((c.createdMs - (c.durationSec ?? 0) * 1000 - Date.parse(match.startedAt)) / 1000));
    tiles.push(<GalleryCard key={c.path} clip={c} title="Your clip" meta={`Saved with your hotkey · ${Math.floor(into / 60)}:${String(into % 60).padStart(2, "0")} into the match`} onPlay={() => onOpen(c)} />);
  }

  return (
    <article className={tiles.length || open ? "match-card" : "match-card compact"}>
      <div className="match-card-head">
        <b className="map">{match.map}</b>
        <b style={{ color: resultColor(r?.letter) }}>{score}</b>
        <span className="muted grow ellipsis">
          {[me && `${me.agent} · ${me.kills} / ${me.deaths} / ${me.assists}`, matchTimeAgo(match.startedAt), why].filter(Boolean).join(" · ")}
        </span>
        <button type="button" className="linkish muted" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Details"}</button>
      </div>

      {tiles.length > 0 && <div className="gallery">{tiles}</div>}

      {open && (
        <div className="match-details">
          {liveList.length > 0 && (
            <div className="streamer-cards">
              {liveList.map((p) => {
                const l = live.get(p.puuid)!;
                const pct = progressOf(p.puuid);
                return (
                  <div key={p.puuid} className="streamer-card">
                    <span className="avatar" aria-hidden="true">{l.name.slice(0, 2).toUpperCase()}</span>
                    <span className="grow stack" style={{ gap: 3 }}>
                      <a href={`https://www.twitch.tv/${l.login}`} target="_blank" rel="noreferrer"><b>{l.name}</b></a>
                      <span className="muted small">{me ? (p.team === me.team ? "Teammate" : "Enemy") : "Player"} · {p.agent}</span>
                      <span className={`small ${l.tone}`}>{l.text}</span>
                      {pct != null && pct < 100 && <span className="bar"><i style={{ width: `${Math.max(4, pct)}%` }} /></span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {children}
          <Rounds match={match} me={me} fightRounds={fightRounds} />
          <Scoreboard match={match} me={me} live={live} />
          {!me && <p className="muted" style={{ margin: 0 }}>Your Riot ID isn't in this match, so your fights can't be shown.</p>}
          {actions}
        </div>
      )}
      {streamers?.error && <p className="small bad" style={{ margin: 0 }}>{streamers.error}</p>}
    </article>
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

/** What a match is searched by: map, agent, players, streamers. */
function matchText(m: MatchSummary, streamers?: MatchStreamers): string {
  return [m.map, m.mode, ...m.players.flatMap((p) => [p.name, p.agent]), ...(streamers?.players ?? []).map((p) => p.channel.displayName)].join(" ").toLowerCase();
}

/** Home: every match, with your clips and the streamers' clips from it. */
export default function Home({
  settings,
  matchesState,
  recorder,
  query,
  onNavigate,
  onOpen,
}: {
  settings: Settings;
  matchesState: ReturnType<typeof useMatches>;
  recorder: ReturnType<typeof useRecorder>;
  query: string;
  onNavigate: (p: Page) => void;
  onOpen: (c: ClipInfo) => void;
}) {
  const { matches, status, checking, checkNow, streamers, putStreamers, checkStreamers } = matchesState;
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [recheckError, setRecheckError] = useState("");
  const [show, setShow] = useState<Show>("all");
  /** Website demo: a real match the visitor looked up. */
  const [looked, setLooked] = useState<{ match: MatchSummary; riotId: string; web?: WebStreamer[] | "checking" } | null>(null);

  const clips = recorder.clips;
  const pairs = useMemo(() => findPairs(clips, matches), [clips, matches]);
  const mineByMatch = useMemo(() => {
    const by = new Map<string, ClipInfo[]>();
    for (const c of clips) {
      if (c.kind !== "mine") continue;
      const m = matchOf(c, matches);
      if (m) by.set(m.id, [...(by.get(m.id) ?? []), c].sort((a, b) => a.createdMs - b.createdMs));
    }
    return by;
  }, [clips, matches]);

  const withStreamers = (m: MatchSummary) => Boolean(streamers[m.id]?.players.length);
  const q = query.trim().toLowerCase();
  const shown = matches.filter(
    (m) =>
      (show === "all" || (show === "streamers" ? withStreamers(m) : mineByMatch.has(m.id))) &&
      (!q || matchText(m, streamers[m.id]).includes(q)),
  );
  const all = looked && show !== "mine" ? [looked.match, ...shown.filter((m) => m.id !== looked.match.id)] : shown;

  async function recheck(id: string) {
    setRechecking(id);
    setRecheckError("");
    try {
      await checkStreamers(id);
    } catch (err) {
      setRecheckError(String(err));
    } finally {
      setRechecking(null);
    }
  }

  const tabs: { id: Show; label: string; n?: number }[] = [
    { id: "all", label: "All matches" },
    { id: "streamers", label: "With streamers", n: matches.filter(withStreamers).length },
    { id: "mine", label: "My clips only" },
  ];

  return (
    <section className="page wide" aria-label="Home">
      {status && !status.configured && isDesktop && (
        <Notice tone="warn">
          Add your Riot ID in Settings so CrossPOV can find your matches.{" "}
          <button type="button" className="linkish" onClick={() => onNavigate("settings")}>Open Settings</button>
        </Notice>
      )}
      {status?.error && status.configured && <Notice tone="bad">{status.error}</Notice>}
      {recheckError && <Notice tone="bad">{recheckError}</Notice>}

      <div className="tabs-row">
        <div className="tabs" role="tablist" aria-label="Show">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={show === t.id} onClick={() => setShow(t.id)}>
              {t.label}
              {t.n ? <span className="count">{t.n}</span> : null}
            </button>
          ))}
        </div>
        {isDesktop && (
          <button type="button" className="btn quiet sm-btn" onClick={() => void checkNow()} disabled={checking || !status?.configured} title={status?.lastCheckMs ? `Last checked ${timeAgo(status.lastCheckMs)}` : undefined}>
            {checking ? "Checking…" : "Check for new matches"}
          </button>
        )}
      </div>

      {!isDesktop && (
        <DemoLookup
          onFound={(m, riotId, web) => {
            setLooked({ match: m, riotId, web });
          }}
        />
      )}
      {all.length ? (
        <div className="match-feed">
          {all.map((m) =>
            m.id === looked?.match.id ? (
              <MatchView key={m.id} match={m} riotId={looked.riotId} clips={[]} web={looked.web} onOpen={onOpen} />
            ) : (
              <MatchView
                key={m.id}
                match={m}
                riotId={settings.riotId}
                clips={clips}
                myClips={mineByMatch.get(m.id)}
                pairs={pairs}
                show={show}
                streamers={streamers[m.id]}
                onOpen={onOpen}
                actions={isDesktop && <button type="button" className="btn quiet" style={{ alignSelf: "flex-start" }} onClick={() => void recheck(m.id)} disabled={rechecking === m.id}>{rechecking === m.id ? "Checking…" : "Check this match again"}</button>}
              >
                {(streamers[m.id]?.suggested ?? []).map((s) => (
                  <Suggestion key={s.login} match={m} riotId={settings.riotId} s={s} onAdded={putStreamers} />
                ))}
                {isDesktop && <AddChannel match={m} riotId={settings.riotId} onAdded={putStreamers} />}
              </MatchView>
            ),
          )}
        </div>
      ) : (
        <div className="empty-state">
          <b>{matches.length ? "Nothing matches" : "No matches yet"}</b>
          <span>
            {matches.length
              ? "Try another search or tab."
              : settings.riotId
                ? "Play a match. It shows up a minute or two after it ends."
                : "Add your Riot ID in Settings first."}
          </span>
        </div>
      )}
    </section>
  );
}
