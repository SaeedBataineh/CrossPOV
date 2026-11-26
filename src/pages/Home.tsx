import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Select } from "../components/Select";
import { ArrowsClockwise, FilmStrip, GearSix, Play, Sword, TwitchLogo } from "@phosphor-icons/react";
import { MatchCard, type Show } from "../components/MatchCard";
import { SegmentedControl, type Segment } from "../components/SegmentedControl";
import type { Page } from "../components/Sidebar";
import { Keycap } from "../components/TopBar";
import { mapArt } from "../components/ValorantArt";
import { cardTitle, Notice } from "../components/ui";
import {
  addStreamerChannel,
  findMe,
  isDesktop,
  lookupLatestMatch,
  lookupStreamers,
  saveClipNow,
  thumbSrc,
  type RecorderStatus,
  type ClipInfo,
  type MatchStreamers,
  type SuggestedStreamer,
  type MatchSummary,
  type WebStreamer,
} from "../lib/backend";
import { findPairs, matchOf } from "../lib/pairs";
import { REGIONS, type Settings } from "../lib/settings";
import type { useMatches } from "../lib/useMatches";
import { formatDuration, timeAgo, type useRecorder } from "../lib/useRecorder";

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
      <Select label={`Which player was ${s.login}`} placeholder="Choose player" value={puuid} onChange={setPuuid} options={team.map((p) => ({ value: p.puuid, label: `${p.name}#${p.tag} · ${p.agent}` }))} />
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
        <Select label="Player" placeholder="Which player?" value={puuid} onChange={setPuuid} options={others.map((p) => ({ value: p.puuid, label: `${p.name}#${p.tag} · ${me ? (p.team === me.team ? "teammate" : "enemy") : "player"} · ${p.agent}` }))} />
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
      <Select label="Region" value={region} onChange={setRegion} options={REGIONS.map((r) => ({ value: r.value, label: r.value.toUpperCase() }))} className="dd-narrow" />
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

  const tabs: Segment<Show>[] = [
    { id: "all", label: "All matches", Icon: Sword },
    { id: "streamers", label: "With streamers", n: matches.filter(withStreamers).length, Icon: TwitchLogo },
    { id: "mine", label: "My clips only", Icon: FilmStrip },
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

      <div className="grid items-start gap-5 min-[1280px]:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
      {/* Narrower windows: the summary sits above the matches; wide ones show it in the side panel. */}
      {matches.length > 0 && (
        <div className="min-[1280px]:hidden">
          <Summary matches={matches} clips={clips} streamers={streamers} />
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#222225]">
        <SegmentedControl label="Show" value={show} segments={tabs} onChange={setShow} hideZero />
        {isDesktop && (
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={checking || !status?.configured}
            title={status?.lastCheckMs ? `Last checked ${timeAgo(status.lastCheckMs)}` : undefined}
            className="mb-1.5 inline-flex h-9 items-center gap-2 rounded-[10px] border-0 bg-white/[0.05] px-3.5 text-[13px] font-medium text-zinc-200 ring-1 ring-white/[0.07] transition-colors duration-150 ease-out hover:bg-white/[0.1] hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none disabled:opacity-50"
          >
            <ArrowsClockwise size={14} weight="bold" aria-hidden className={checking ? "animate-spin motion-reduce:animate-none" : undefined} />
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
        <div key={show} className="stagger flex flex-col gap-3">
          {all.map((m) =>
            m.id === looked?.match.id ? (
              <MatchCard key={m.id} match={m} riotId={looked.riotId} clips={[]} web={looked.web} onOpen={onOpen} />
            ) : (
              <MatchCard
                key={m.id}
                match={m}
                riotId={settings.riotId}
                notify={recorder.notify}
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
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/[0.08] bg-zinc-900/40 px-6 py-16 text-center">
          <span className="mb-2 grid size-12 place-items-center rounded-2xl bg-gradient-to-b from-white/[0.10] to-white/[0.03] text-zinc-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] ring-1 ring-white/[0.06]">
            <Sword size={22} weight="bold" aria-hidden />
          </span>
          <b className="text-[17px] font-semibold tracking-[-0.02em] text-white">{matches.length ? "Nothing matches" : "No matches yet"}</b>
          <span className="max-w-sm text-[13.5px] text-zinc-400">
            {matches.length
              ? "Try another search or tab."
              : settings.riotId
                ? "Play a match. It shows up a minute or two after it ends."
                : "Add your Riot ID in Settings first."}
          </span>
        </div>
      )}
      </div>

      <aside className="sticky top-0 hidden flex-col gap-4 min-[1280px]:flex" aria-label="Overview">
        {matches.length > 0 && <Summary matches={matches} clips={clips} streamers={streamers} />}
        <RecorderCard status={recorder.status} settings={settings} onSaving={() => recorder.notify("Saving clip…", "info")} onSettings={() => onNavigate("settings")} />
        <RecentClips clips={clips} onOpen={onOpen} onAll={() => onNavigate("clips")} />
      </aside>
      </div>
    </section>
  );
}

// ---------- Summary strip ----------

/** One tile: icon, a big number, and what it means. */
function Tile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/80 p-4 shadow-[0_12px_32px_-22px_rgba(0,0,0,0.8)]">
      <div className="flex items-center gap-2 text-[12px] font-medium text-zinc-400">
        <span className="grid size-6 place-items-center rounded-lg bg-[#3b9eff]/[0.12] text-[#6ab7ff]">{icon}</span>
        {label}
      </div>
      <div className="mt-2.5 text-[26px] leading-none font-semibold tracking-[-0.03em] text-white tabular-nums">{value}</div>
      {sub && <div className="mt-2 text-[12px] text-zinc-500 tabular-nums">{sub}</div>}
    </div>
  );
}

/** Recent form at a glance: win rate, K/D, saved clips, streamer matches. */
function Summary({ matches, clips, streamers }: { matches: MatchSummary[]; clips: ClipInfo[]; streamers: Record<string, MatchStreamers> }) {
  const theirs = clips.filter((c) => c.kind === "theirs").length;
  const withStreamers = matches.filter((m) => streamers[m.id]?.players.length).length;
  const met = new Set(Object.values(streamers).flatMap((s) => s.players.map((p) => p.channel.login))).size;

  return (
    <div className="grid grid-cols-2 gap-3">
      <Tile
        icon={<FilmStrip size={13} weight="bold" aria-hidden />}
        label="Saved clips"
        value={clips.length}
        sub={`${clips.length - theirs} yours · ${theirs} from streamers`}
      />
      <Tile
        icon={<Sword size={13} weight="bold" aria-hidden />}
        label="Streamer matches"
        value={withStreamers}
        sub={`${met} ${met === 1 ? "streamer" : "streamers"} met`}
      />
    </div>
  );
}

// ---------- Side panel ----------

const card = "rounded-2xl border border-white/[0.06] bg-zinc-900/80 p-4 shadow-[0_12px_32px_-22px_rgba(0,0,0,0.8)]";

/** The recorder: what it's doing, the hotkey, and Save clip while recording. */
function RecorderCard({ status, settings, onSaving, onSettings }: { status: RecorderStatus | null; settings: Settings; onSaving: () => void; onSettings: () => void }) {
  const state = status?.state;
  const recording = state === "recording";
  const bad = state === "error" || state === "noFfmpeg";
  const line = !isDesktop ? "Recording works in the Windows app" : recording ? `Recording${status?.game?.name ? ` ${status.game.name}` : ""}` : bad ? "Recorder stopped" : state === "waiting" ? "Waiting for a game" : "Starting…";
  const dot = !isDesktop ? "bg-zinc-500" : recording ? "bg-[#FF453A]" : bad ? "bg-[#FFD60A]" : "bg-[#30D158]";
  return (
    <section className={card} aria-label="Recorder">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[14px] font-semibold text-white">Recorder</h2>
        <button type="button" onClick={onSettings} title="Recording settings" aria-label="Recording settings" className="grid size-7 place-items-center rounded-lg border-0 bg-transparent text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none">
          <GearSix size={15} weight="bold" aria-hidden />
        </button>
      </div>
      <p className="m-0 mt-2 flex items-center gap-2 text-[13px] text-zinc-200">
        <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
        <span className="min-w-0 truncate">{line}</span>
      </p>
      <p className="m-0 mt-3 flex flex-wrap items-center gap-1.5 text-[13px] text-zinc-400">
        Press <Keycap>{settings.hotkey}</Keycap> to save the last <span className="tabular-nums text-zinc-200">{settings.bufferSeconds} s</span>
      </p>
      {recording && (
        <button
          type="button"
          onClick={() => {
            onSaving();
            void saveClipNow();
          }}
          className="mt-3 h-9 w-full rounded-[10px] border-0 bg-white text-[13px] font-semibold text-zinc-950 transition-colors hover:bg-zinc-200 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
        >
          Save clip now
        </button>
      )}
    </section>
  );
}

/** Your newest clips, so the last thing you saved is one click away. */
function RecentClips({ clips, onOpen, onAll }: { clips: ClipInfo[]; onOpen: (c: ClipInfo) => void; onAll: () => void }) {
  const recent = [...clips].sort((a, b) => b.createdMs - a.createdMs).slice(0, 5);
  return (
    <section className={card} aria-label="Recent clips">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[14px] font-semibold text-white">Recent clips</h2>
        {clips.length > 0 && (
          <button type="button" onClick={onAll} className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12.5px] font-medium text-zinc-400 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none">
            See all
          </button>
        )}
      </div>
      {recent.length ? (
        <ul className="m-0 mt-2 flex list-none flex-col p-0">
          {recent.map((c) => {
            const src = thumbSrc(c.thumb) ?? mapArt(c.map);
            return (
              <li key={c.path}>
                <button type="button" onClick={() => onOpen(c)} className="group flex w-full items-center gap-3 rounded-xl border-0 bg-transparent p-1.5 text-left transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none">
                  <span className="relative grid h-10 w-[70px] shrink-0 place-items-center overflow-hidden rounded-lg bg-zinc-800 text-zinc-500">
                    {src ? <img src={src} alt="" className="absolute inset-0 size-full object-cover" /> : <Play size={14} weight="bold" aria-hidden />}
                    {c.durationSec != null && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] leading-4 text-white tabular-nums">{formatDuration(c.durationSec)}</span>}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <b className="truncate text-[13px] font-medium text-zinc-100">{c.kind === "theirs" && c.round ? `R${c.round} · ` : ""}{cardTitle(c)}</b>
                    <span className="truncate text-[12px] text-zinc-400">{[c.kind === "theirs" ? c.streamer : c.map ?? c.game, timeAgo(c.createdMs)].filter(Boolean).join(" · ")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 mt-2 text-[13px] text-zinc-400">Clips you save show up here.</p>
      )}
    </section>
  );
}
