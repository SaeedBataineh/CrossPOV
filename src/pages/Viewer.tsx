import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, cardMeta, cardTitle } from "../components/ui";
import { clipVideoSrc, deleteClip, findMe, isDesktop, openClip, revealClip, type ClipInfo, type MatchStreamers, type MatchSummary } from "../lib/backend";
import { result, resultColor } from "../lib/matchInfo";
import { findPairs, fightMarks, matchOf, pairsWith, vodLink } from "../lib/pairs";
import type { Settings } from "../lib/settings";
import { formatDuration } from "../lib/useRecorder";

type View = "mine" | "theirs" | "both";

/** A playable address for a clip, or null when it can only open outside (MKV, website demo). */
function useVideoSrc(clip: ClipInfo | undefined) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setSrc(undefined);
    if (!clip) return;
    clipVideoSrc(clip.path).then(
      (url) => alive && setSrc(url),
      () => alive && setSrc(null),
    );
    return () => {
      alive = false;
    };
  }, [clip]);
  return src;
}

/** Where the video would be, when it can't play inside the app. */
function NoVideo({ clip, onOutside }: { clip: ClipInfo; onOutside: () => void }) {
  return (
    <div className="video-box empty">
      <span className="muted">{isDesktop ? "This clip can't play inside the app." : "Videos play in the Windows app."}</span>
      {isDesktop && <button type="button" className="btn quiet" onClick={onOutside}>Open {clip.name.endsWith(".mkv") ? "MKV " : ""}in your player</button>}
    </div>
  );
}

/** Thin bar under a video with a mark at each fight; click a mark to jump there. */
function Marks({ marks, duration, onSeek }: { marks: number[]; duration: number; onSeek: (t: number) => void }) {
  if (!marks.length || !duration) return null;
  return (
    <div className="fight-marks">
      <div className="fight-track" aria-hidden="true" />
      {marks.map((t, i) => (
        <button
          key={i}
          type="button"
          className="fight-mark"
          style={{ left: `${Math.min(100, (t / duration) * 100)}%` }}
          onClick={() => onSeek(Math.max(0, t - 3))}
          aria-label={`Jump to the fight at ${formatDuration(t)}`}
          title={`Fight at ${formatDuration(t)}`}
        />
      ))}
      <span className="muted small">{marks.length === 1 ? "The fight" : "Fights"}: {marks.map((t) => formatDuration(t)).join(", ")} · click a mark to jump</span>
    </div>
  );
}

/** Both clips playing together: yours drives, theirs follows at the right moment. */
function SideBySide({ mine, theirs, mineSrc, theirSrc, offsetSec }: { mine: ClipInfo; theirs: ClipInfo; mineSrc: string; theirSrc: string; offsetSec: number }) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const [nudge, setNudge] = useState(0);
  const [theirSound, setTheirSound] = useState(false);
  const lag = offsetSec + nudge;

  useEffect(() => {
    const va = a.current;
    const vb = b.current;
    if (!va || !vb) return;
    const follow = () => {
      const t = va.currentTime - lag;
      const inside = t >= 0 && t <= (vb.duration || theirs.durationSec || 0);
      if (!inside) {
        vb.pause();
        vb.currentTime = Math.max(0, Math.min(t, vb.duration || 0));
        return;
      }
      if (Math.abs(vb.currentTime - t) > 0.25) vb.currentTime = t;
      if (va.paused) vb.pause();
      else if (vb.paused) void vb.play().catch(() => {});
    };
    const events = ["play", "pause", "seeked", "timeupdate", "ratechange"] as const;
    events.forEach((e) => va.addEventListener(e, follow));
    const rate = () => (vb.playbackRate = va.playbackRate);
    va.addEventListener("ratechange", rate);
    follow();
    return () => {
      events.forEach((e) => va.removeEventListener(e, follow));
      va.removeEventListener("ratechange", rate);
    };
  }, [lag, theirs.durationSec]);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="side-by-side">
        <figure>
          <video ref={a} src={mineSrc} controls playsInline><track kind="captions" /></video>
          <figcaption><span className="tag you">YOU</span>{cardTitle(mine)}</figcaption>
        </figure>
        <figure>
          <video ref={b} src={theirSrc} playsInline muted={!theirSound}><track kind="captions" /></video>
          <figcaption><span className="tag them">THEM</span>{theirs.streamer ?? "Streamer"}</figcaption>
        </figure>
      </div>
      <div className="row-wrap" style={{ gap: 8 }}>
        <span className="muted small">Your clip controls both. If they're slightly out of step:</span>
        <button type="button" className="btn quiet sm-btn" onClick={() => setNudge((n) => n - 0.5)}>Theirs earlier</button>
        <button type="button" className="btn quiet sm-btn" onClick={() => setNudge((n) => n + 0.5)}>Theirs later</button>
        {nudge !== 0 && <button type="button" className="linkish muted small" onClick={() => setNudge(0)}>Reset ({nudge > 0 ? "+" : ""}{nudge} s)</button>}
        <span className="spacer" />
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={theirSound} onChange={(e) => setTheirSound(e.target.checked)} />
          Their sound
        </label>
      </div>
    </div>
  );
}

/** One clip, full page: switch between your view, theirs, or both side by side. */
export default function Viewer({
  clip,
  clips,
  matches,
  streamers,
  settings,
  onBack,
  onOpen,
  onDeleted,
  notify,
}: {
  clip: ClipInfo;
  clips: ClipInfo[];
  matches: MatchSummary[];
  streamers: Record<string, MatchStreamers>;
  settings: Settings;
  onBack: () => void;
  onOpen: (c: ClipInfo) => void;
  onDeleted: () => void;
  notify: (text: string, tone: "good" | "bad" | "info") => void;
}) {
  const pairs = useMemo(() => findPairs(clips, matches), [clips, matches]);
  const pair = pairsWith(clip, pairs)[0];
  const mine = clip.kind === "mine" ? clip : pair?.mine;
  const theirs = clip.kind === "theirs" ? clip : pair?.theirs;
  const [view, setView] = useState<View>(clip.kind);
  useEffect(() => setView(clip.kind), [clip]);

  const shownClip = view === "mine" ? mine : theirs;
  const mineSrc = useVideoSrc(mine);
  const theirSrc = useVideoSrc(theirs);
  const src = view === "mine" ? mineSrc : theirSrc;
  const video = useRef<HTMLVideoElement>(null);

  const match = matchOf(clip, matches) ?? (pair ? matchOf(pair.mine, matches) : undefined);
  const me = match ? findMe(match, settings.riotId) : undefined;
  const r = match ? result(match, me) : null;
  const st = match && theirs ? streamers[match.id]?.players.find((p) => [p.channel.login, p.channel.displayName].some((n) => n.toLowerCase() === theirs.streamer?.toLowerCase())) : undefined;
  const streamerPlayer = st && match ? match.players.find((p) => p.puuid === st.puuid) : undefined;
  const marks = shownClip ? fightMarks(shownClip, match, me?.puuid, st?.puuid, matches) : [];
  const vod = theirs ? vodLink(theirs) : null;
  const more = match ? clips.filter((c) => c.path !== mine?.path && c.path !== theirs?.path && matchOf(c, matches)?.id === match.id) : [];

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) onBack();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onBack]);

  const run = (f: () => Promise<void>) => () => void f().catch((err) => notify(String(err), "bad"));
  async function remove() {
    if (!window.confirm(`Delete "${cardTitle(clip)}"? This can't be undone.`)) return;
    try {
      await deleteClip(clip.path);
      onDeleted();
    } catch (err) {
      notify(`Couldn't delete: ${String(err)}`, "bad");
    }
  }

  const views: { id: View; label: string; ok: boolean }[] = [
    { id: "mine", label: "Your view", ok: Boolean(mine) },
    { id: "theirs", label: theirs?.streamer ? `${theirs.streamer}'s view` : "Their view", ok: Boolean(theirs) },
    { id: "both", label: "Side by side", ok: Boolean(mine && theirs) },
  ];

  return (
    <section className="viewer" aria-label={cardTitle(clip)}>
      <header className="viewer-head">
        <button type="button" className="back" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          {match ? <>{match.map} {r && <b style={{ color: resultColor(r.letter) }}>{r.score}</b>}</> : "Back"}
        </button>
        <span className="sep" aria-hidden="true">/</span>
        <h1 className="ellipsis">{clip.round != null ? `R${clip.round} · ` : ""}{cardTitle(clip)}</h1>
      </header>

      <div className="viewer-body">
        <div className="viewer-main">
          {(mine && theirs) || views.filter((v) => v.ok).length > 1 ? (
            <div className="seg" role="tablist" aria-label="View">
              {views.filter((v) => v.ok).map((v) => (
                <button key={v.id} type="button" role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}>{v.label}</button>
              ))}
            </div>
          ) : null}

          {view === "both" && mine && theirs && pair ? (
            mineSrc && theirSrc ? (
              <SideBySide mine={mine} theirs={theirs} mineSrc={mineSrc} theirSrc={theirSrc} offsetSec={pair.offsetSec} />
            ) : mineSrc === undefined || theirSrc === undefined ? (
              <div className="video-box" />
            ) : (
              <NoVideo clip={mineSrc ? theirs : mine} onOutside={run(() => openClip((mineSrc ? theirs : mine).path))} />
            )
          ) : shownClip ? (
            <>
              {src === undefined ? (
                <div className="video-box" />
              ) : src ? (
                <div className="video-box">
                  <span className={shownClip.kind === "theirs" ? "tag them" : "tag you"}>{shownClip.kind === "theirs" ? `THEIR VIEW · ${shownClip.streamer ?? ""}` : "YOUR VIEW"}</span>
                  <video ref={video} key={shownClip.path} src={src} controls autoPlay playsInline><track kind="captions" /></video>
                </div>
              ) : (
                <NoVideo clip={shownClip} onOutside={run(() => openClip(shownClip.path))} />
              )}
              <Marks marks={marks} duration={shownClip.durationSec ?? 0} onSeek={(t) => { if (video.current) video.current.currentTime = t; }} />
            </>
          ) : null}
        </div>

        <aside className="viewer-side">
          {theirs && (
            <div className="side-box">
              <p className="eyebrow">The other side</p>
              <div className="row" style={{ gap: 12 }}>
                <Avatar name={theirs.streamer ?? "?"} avatar={st?.channel.avatar} size={40} />
                <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <b className="ellipsis">{theirs.streamer ?? "Streamer"}</b>
                  <span className="muted small">
                    {[streamerPlayer && me ? (streamerPlayer.team === me.team ? "Teammate" : "Enemy") : null, streamerPlayer?.agent, "Twitch"].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </div>
              <p className="muted small" style={{ margin: 0 }}>{mine ? "Lined up with your clip from their public VOD." : "Cut from their public VOD."}</p>
              {vod && <a className="btn quiet full" href={vod} target="_blank" rel="noreferrer">Open their VOD on Twitch</a>}
            </div>
          )}

          {more.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <p className="eyebrow">More from this match</p>
              {more.slice(0, 6).map((c) => (
                <button key={c.path} type="button" className="mini-clip" onClick={() => onOpen(c)}>
                  <span className={c.kind === "theirs" ? "mini-thumb theirs" : "mini-thumb"} aria-hidden="true" />
                  <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                    <b className="ellipsis">{c.round != null ? `R${c.round} · ` : ""}{cardTitle(c)}</b>
                    <span className="muted small ellipsis">{c.kind === "theirs" ? c.streamer : cardMeta(c)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <span className="spacer" />
          <div className="row" style={{ gap: 8 }}>
            {isDesktop && <button type="button" className="btn quiet grow" onClick={run(() => revealClip(clip.path))}>Show in folder</button>}
            {isDesktop && <button type="button" className="btn quiet grow" onClick={run(() => openClip((shownClip ?? clip).path))}>Open in player</button>}
            <button type="button" className="btn quiet danger" onClick={() => void remove()} aria-label="Delete this clip" title="Delete this clip">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}
