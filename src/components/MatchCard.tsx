import { useState, type ReactNode } from "react";
import { CaretDown, Clock, SpinnerGap } from "@phosphor-icons/react";
import { findMe, type ClipInfo, type MatchPlayer, type MatchStreamers, type MatchSummary, type WebStreamer } from "../lib/backend";
import { progress, result, streamerLabel } from "../lib/matchInfo";
import type { Pair } from "../lib/pairs";
import { matchTimeAgo } from "../lib/useMatches";
import { TwitchIcon } from "./Icons";
import { Avatar, cardTitle, GalleryCard, PendingCard } from "./ui";
import { MapThumb } from "./ValorantArt";
import { PostMatchScoreboard, RoundTimeline } from "./PostMatch";

/** What we know about one player being a streamer, from the app or the website demo. */
interface Live {
  login: string;
  agent: string;
  name: string;
  avatar?: string | null;
  text: string;
  tone: string;
}

function liveInfo(p: MatchPlayer, match: MatchSummary, me: MatchPlayer | undefined, streamers?: MatchStreamers, web?: WebStreamer[] | "checking"): Live | null {
  const st = streamers?.players.find((s) => s.puuid === p.puuid);
  if (st) {
    const l = streamerLabel(st, Boolean(me && p.team === me.team));
    return { login: st.channel.login, agent: p.agent, name: st.channel.displayName, avatar: st.channel.avatar, text: l.text, tone: l.tone };
  }
  const ws = Array.isArray(web) ? web.find((w) => w.puuid === p.puuid) : undefined;
  if (ws) {
    const fights = me ? match.kills.filter((k) => (k.killer === me.puuid && k.victim === p.puuid) || (k.killer === p.puuid && k.victim === me.puuid)).length : 0;
    return { login: ws.channel.login, agent: p.agent, name: ws.channel.displayName, avatar: ws.channel.avatar, text: ws.vod ? (me ? `VOD found · ${fights} fights` : "VOD found") : "was live · no VOD saved", tone: ws.vod ? "good" : "bad" };
  }
  return null;
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

// ---------- Header pieces ----------

const RESULT = {
  W: { label: "Win", cls: "text-[#4ADE80]" },
  L: { label: "Loss", cls: "text-[#FB7185]" },
  D: { label: "Draw", cls: "text-zinc-300" },
} as const;

/** The score in plain numbers, with "Win" or "Loss" under it in the result's colour. */
function ResultPill({ letter, score }: { letter?: "W" | "L" | "D"; score: string }) {
  const r = letter ? RESULT[letter] : null;
  return (
    <span className="flex w-[64px] shrink-0 flex-col items-end gap-0.5">
      <b className="text-[17px] leading-tight font-semibold tracking-[-0.01em] text-white tabular-nums">{score}</b>
      {r && <span className={`text-[10px] font-semibold tracking-[0.08em] uppercase ${r.cls}`}>{r.label}</span>}
    </span>
  );
}

/** A number over a small muted label. */
function Stat({ value, label, className = "", dim }: { value: ReactNode; label: string; className?: string; dim?: boolean }) {
  return (
    <span className={`flex flex-col items-end gap-0.5 ${className}`}>
      <b className={`text-[15px] leading-tight font-semibold tracking-[-0.01em] tabular-nums ${dim ? "text-zinc-500" : "text-zinc-50"}`}>{value}</b>
      <span className="text-[10px] font-medium tracking-[0.06em] whitespace-nowrap text-zinc-500 uppercase">{label}</span>
    </span>
  );
}

function StreamerBadge({ live, checking, checked }: { live: Live[]; checking: boolean; checked: boolean }) {
  if (live.length) {
    const text = live.length === 1 ? live[0].name : `${live.length} streamers`;
    return (
      <span
        title={live.map((l) => `${l.name}: ${l.text}`).join("\n")}
        className="inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-lg bg-white/[0.04] py-1 pr-3 pl-1 text-[12.5px] font-medium text-zinc-200 ring-1 ring-white/[0.07] ring-inset"
      >
        <span className="flex shrink-0 -space-x-1">
          {live.slice(0, 3).map((l) => (
            <span key={l.login} className="overflow-hidden rounded-md ring-2 ring-zinc-900 [&>*]:rounded-md">
              <Avatar name={l.name} avatar={l.avatar} agent={l.agent} size={24} />
            </span>
          ))}
        </span>
        <TwitchIcon size={12} color="#a78bfa" />
        <span className="truncate">{text}</span>
      </span>
    );
  }
  const Icon = checking ? SpinnerGap : !checked ? Clock : null;
  return (
    <span className="inline-flex h-8 items-center gap-1.5 px-1 text-[12px] font-medium text-zinc-400">
      {Icon && <Icon size={13} className={checking ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden />}
      {checking ? "Checking who was live" : !checked ? "Checked after the match" : "No streamers"}
    </span>
  );
}

// ---------- The card ----------

export function MatchCard({
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
  notify,
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
  /** Shows "Copy for Discord" on the clip cards when given. */
  notify?: (text: string, tone: "good" | "bad" | "info") => void;
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
  // Details render on first open and stay mounted, so closing can animate too.
  const [opened, setOpened] = useState(false);
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
  const note = checked && liveList.length ? (issues.length ? issues.join(", ") : !fights.length && me ? "you didn't fight the streamers" : "") : "";

  // Cards: each fight with a streamer (both sides when you saved it too), then your other clips.
  const paired = new Set<string>();
  const tiles: ReactNode[] = [];
  let saved = 0;
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
      saved++;
      tiles.push(<GalleryCard key={c.path} clip={c} other={p?.mine} title={title} meta={p ? `Both sides · ${f.name}` : `Their side · ${f.name}`} notify={notify} onPlay={() => onOpen(c)} />);
    }
  } else {
    for (const c of myClips) {
      const p = pairOf(c);
      if (!p) continue;
      paired.add(c.path);
      saved++;
      tiles.push(<GalleryCard key={c.path} clip={c} other={p.theirs} title={cardTitle(c)} meta={`Both sides · ${p.theirs.streamer ?? "streamer"}`} notify={notify} onPlay={() => onOpen(c)} />);
    }
  }
  for (const c of myClips) {
    if (paired.has(c.path)) continue;
    saved++;
    const into = Math.max(0, Math.round((c.createdMs - (c.durationSec ?? 0) * 1000 - Date.parse(match.startedAt)) / 1000));
    tiles.push(<GalleryCard key={c.path} clip={c} title="Your clip" meta={`Saved with your hotkey · ${Math.floor(into / 60)}:${String(into % 60).padStart(2, "0")} into the match`} notify={notify} onPlay={() => onOpen(c)} />);
  }

  const minutes = match.lengthMs ? Math.round(match.lengthMs / 60000) : 0;
  const brief = web === "checking" ? "checking who was live…"
    : !checked ? "streamers checked after the match"
    : !liveList.length ? "no streamers"
    : liveList.length === 1 ? live.get(liveList[0].puuid)!.name
    : `${liveList.length} streamers`;
  const meta = [match.mode, matchTimeAgo(match.startedAt), minutes ? `${minutes} min` : null].filter(Boolean).join(" · ");

  return (
    <article
      aria-label={`${match.map}, ${score}`}
      className="@container group/card relative rounded-2xl border border-white/[0.06] bg-zinc-900/80 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_12px_32px_-20px_rgba(0,0,0,0.8)] transition-[border-color,background-color] duration-200 ease-out hover:border-white/[0.1] hover:bg-zinc-900"
    >
      <div className="flex items-center gap-4 p-3.5 pr-4">
        <MapThumb map={match.map} agent={me?.agent} />

        <div className="min-w-0 flex-1 pl-1">
          <h3 className="m-0 truncate text-[17px] leading-tight font-semibold tracking-[-0.02em] text-white">
            {match.map}
            {me && <span className="ml-2 text-[13px] font-medium tracking-normal text-zinc-500">{me.agent}</span>}
          </h3>
          <p className="m-0 mt-1 truncate text-[12.5px] text-zinc-500 tabular-nums">
            {meta}
            {me && <span className="@[60rem]:hidden"> · {me.kills} / {me.deaths} / {me.assists}</span>}
            <span className="@[46rem]:hidden"> · {brief}</span>
            {note && <span className={issues.length ? "text-[#FF6961]" : undefined}> · {note}</span>}
          </p>
        </div>

        <ResultPill letter={r?.letter} score={score} />

        {me && (
          <div className="hidden shrink-0 items-center gap-6 border-x border-white/[0.06] px-6 @[60rem]:flex">
            <Stat value={<>{me.kills}<span className="text-zinc-600"> / </span>{me.deaths}<span className="text-zinc-600"> / </span>{me.assists}</>} label="K / D / A" className="w-[92px]" />
            <Stat value={saved} label="Clips" className="w-[34px]" dim={!saved} />
          </div>
        )}

        <div className="hidden w-[190px] shrink-0 justify-start @[46rem]:flex">
          <StreamerBadge live={liveList.map((p) => live.get(p.puuid)!)} checking={web === "checking"} checked={checked} />
        </div>

        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpened(true);
            setOpen(!open);
          }}
          // Render the details as the pointer arrives, so opening starts at once.
          onPointerEnter={() => setOpened(true)}
          onFocus={() => setOpened(true)}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border-0 bg-white/[0.05] pr-2.5 pl-3 text-[12.5px] font-medium text-zinc-200 ring-1 ring-white/[0.06] transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] hover:bg-white/[0.1] hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
        >
          {open ? "Hide" : "Details"}
          <CaretDown size={14} weight="bold" aria-hidden className={`transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {tiles.length > 0 && <div className="gallery border-t border-white/[0.05] px-4 pt-4 pb-5">{tiles}</div>}

      <div className={open ? "expand open" : "expand"} inert={!open}>
        <div className="expand-inner">
        {opened && (
        <div className="match-details mx-4 mb-4">
          {liveList.length > 0 && (
            <div className="streamer-cards">
              {liveList.map((p) => {
                const l = live.get(p.puuid)!;
                const pct = progressOf(p.puuid);
                return (
                  <div key={p.puuid} className="streamer-card">
                    <Avatar name={l.name} avatar={l.avatar} agent={l.agent} size={44} />
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
          <PostMatchScoreboard match={match} me={me} streamers={live}>
            <RoundTimeline match={match} me={me} fightRounds={fightRounds} />
          </PostMatchScoreboard>
          {!me && <p className="muted" style={{ margin: 0 }}>Your Riot ID isn't in this match, so your fights can't be shown.</p>}
          {actions}
        </div>
        )}
        </div>
      </div>
      {streamers?.error && <p className="small bad mx-4 mb-4 mt-0">{streamers.error}</p>}
    </article>
  );
}
