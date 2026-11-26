import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { RefreshCw, Swords } from "lucide-react";
import { MatchCard, type Show } from "../components/MatchCard";
import { SegmentedControl } from "../components/SegmentedControl";
import type { Page } from "../components/Sidebar";
import { Notice } from "../components/ui";
import {
  addStreamerChannel,
  findMe,
  isDesktop,
  lookupLatestMatch,
  lookupStreamers,
  type ClipInfo,
  type MatchStreamers,
  type SuggestedStreamer,
  type MatchSummary,
  type WebStreamer,
} from "../lib/backend";
import { result } from "../lib/matchInfo";
import { findPairs, matchOf } from "../lib/pairs";
import { REGIONS, type Settings } from "../lib/settings";
import type { useMatches } from "../lib/useMatches";
import { timeAgo, type useRecorder } from "../lib/useRecorder";

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
    <form className="flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-panel py-1.5 pr-1.5 pl-4">
        <span className="min-w-[11rem] flex-1 truncate text-sm text-quiet max-sm:basis-full">
          <b className="font-medium text-ink">Try it with a real match.</b><span className="hidden xl:inline"> Enter any Riot ID to load its latest match and see who was live.</span>
        </span>
        <div className="flex h-8 max-sm:min-w-0 max-sm:flex-1">
          <label className="flex w-[180px] max-sm:w-auto max-sm:min-w-0 max-sm:flex-1">
            <span className="sr-only">Riot ID</span>
            <input
              placeholder="Name#TAG"
              value={riotId}
              onChange={(e) => setRiotId(e.target.value)}
              spellCheck={false}
              className="h-full w-full min-w-0 rounded-l-md border border-zinc-700 bg-canvas px-2.5 text-sm text-body outline-none placeholder:text-quiet hover:border-zinc-600 focus:border-zinc-400"
            />
          </label>
          <label className="flex shrink-0">
            <span className="sr-only">Region</span>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="h-full rounded-r-md border border-l-0 border-zinc-700 bg-canvas px-2 font-mono text-[13px] font-semibold text-body outline-none hover:border-zinc-600 focus:border-zinc-400"
            >
              {REGIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.value.toUpperCase()}</option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="submit"
          disabled={busy || !riotId.includes("#")}
          className="h-8 shrink-0 rounded-md border border-ink bg-ink px-3.5 text-[13px] font-semibold text-canvas transition-colors duration-150 ease-out hover:bg-zinc-200 focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-panel focus-visible:outline-none disabled:opacity-45"
        >
          {busy ? "Loading…" : "Look up"}
        </button>
      </div>
      {error && <span className="text-[13px] text-loss" role="alert">{error}</span>}
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

      {matches.length > 0 && <Summary matches={matches} riotId={settings.riotId} clips={clips} streamers={streamers} />}

      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line">
        <SegmentedControl label="Show" value={show} segments={tabs} onChange={setShow} hideZero />
        {isDesktop && (
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={checking || !status?.configured}
            title={status?.lastCheckMs ? `Last checked ${timeAgo(status.lastCheckMs)}` : undefined}
            className="mb-1.5 inline-flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-transparent px-3 text-[13px] font-medium text-body transition-colors duration-150 ease-out hover:border-zinc-600 hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:outline-none disabled:opacity-45"
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden className={checking ? "animate-spin motion-reduce:animate-none" : undefined} />
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
        <div className="flex flex-col gap-2.5">
          {all.map((m) =>
            m.id === looked?.match.id ? (
              <MatchCard key={m.id} match={m} riotId={looked.riotId} clips={[]} web={looked.web} onOpen={onOpen} />
            ) : (
              <MatchCard
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
              </MatchCard>
            ),
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-zinc-800 px-6 py-16 text-center">
          <span className="mb-2 grid size-11 place-items-center rounded-md border border-zinc-800 bg-panel text-body">
            <Swords size={20} strokeWidth={1.75} aria-hidden />
          </span>
          <b className="text-[18px] font-semibold tracking-[-0.02em] text-ink">{matches.length ? "Nothing matches" : "No matches yet"}</b>
          <span className="max-w-sm text-sm text-quiet">
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

// ---------- Summary strip ----------

/** One cell of the strip: a label, a big number, and what it's made of. */
function Cell({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-panel px-5 py-4">
      <span className="text-[13px] text-quiet">{label}</span>
      <span className="font-mono text-[26px] leading-none font-semibold tracking-[-0.02em] text-ink tabular-nums">{value}</span>
      {sub && <span className="text-[13px] text-pretty text-quiet">{sub}</span>}
    </div>
  );
}

/** Recent form at a glance: win rate, K/D, saved clips, streamer matches. One strip, hairlines between. */
function Summary({ matches, riotId, clips, streamers }: { matches: MatchSummary[]; riotId: string; clips: ClipInfo[]; streamers: Record<string, MatchStreamers> }) {
  const recent = matches.slice(0, 20);
  const played = recent.flatMap((m) => {
    const me = findMe(m, riotId);
    const r = result(m, me);
    return me && r ? [{ me, letter: r.letter }] : [];
  });
  const wins = played.filter((p) => p.letter === "W").length;
  const losses = played.filter((p) => p.letter === "L").length;
  const rate = played.length ? Math.round((wins / played.length) * 100) : null;
  const kills = played.reduce((n, p) => n + p.me.kills, 0);
  const deaths = played.reduce((n, p) => n + p.me.deaths, 0);
  const theirs = clips.filter((c) => c.kind === "theirs").length;
  const withStreamers = matches.filter((m) => streamers[m.id]?.players.length).length;
  const met = new Set(Object.values(streamers).flatMap((s) => s.players.map((p) => p.channel.login))).size;
  const num = (n: ReactNode) => <span className="font-mono font-semibold text-body tabular-nums">{n}</span>;

  return (
    // Hairlines between cells: a 1px gap over the line colour, so they stay right when the strip wraps to 2 × 2.
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line xl:grid-cols-4">
      <Cell
        label="Win rate"
        value={rate == null ? "–" : `${rate}%`}
        sub={
          played.length ? (
            <span className="flex items-center gap-2.5">
              <span>{num(wins)}W · {num(losses)}L</span>
              <span className="flex gap-[3px]" aria-label={`Last ${Math.min(10, played.length)} results`}>
                {played.slice(0, 10).reverse().map((p, i) => (
                  <i key={i} className={`h-3 w-1.5 rounded-[1px] ${p.letter === "W" ? "bg-win" : p.letter === "L" ? "bg-loss" : "bg-zinc-600"}`} />
                ))}
              </span>
            </span>
          ) : "Add your Riot ID to see it"
        }
      />
      <Cell label="K/D ratio" value={played.length ? (kills / Math.max(1, deaths)).toFixed(2) : "–"} sub={played.length ? <>{num(kills)} kills · {num(deaths)} deaths</> : undefined} />
      <Cell label="Saved clips" value={clips.length} sub={<>{num(clips.length - theirs)} yours · {num(theirs)} from streamers</>} />
      <Cell label="Streamer matches" value={withStreamers} sub={<>{num(met)} {met === 1 ? "streamer" : "streamers"} met</>} />
    </div>
  );
}
