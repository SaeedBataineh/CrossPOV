import { useMemo } from "react";
import type { Page } from "../components/Shell";
import { ClipCard, ClipThumb, clipMoment, clipTitle, clockOrAgo, Notice, shortWhen, Panel, Stat } from "../components/ui";
import { findMe, isDesktop, openClip, revealClip } from "../lib/backend";
import { allStreamers, isToday, matchEndMs, result } from "../lib/matchInfo";
import type { Settings } from "../lib/settings";
import type { useMatches } from "../lib/useMatches";
import { formatDuration, formatSize, type useRecorder } from "../lib/useRecorder";

interface FeedItem {
  at: number;
  title: string;
  sub: string;
  color: string;
}

export default function Home({
  settings,
  recorder,
  matchesState,
  onNavigate,
}: {
  settings: Settings;
  recorder: ReturnType<typeof useRecorder>;
  matchesState: ReturnType<typeof useMatches>;
  onNavigate: (p: Page) => void;
}) {
  const { status, clips, notify } = recorder;
  const { matches, streamers } = matchesState;

  const featured = clips.find((c) => c.kind === "theirs");
  const recent = clips.slice(0, 3);
  const today = clips.filter((c) => isToday(c.createdMs));
  const metToday = new Set(
    allStreamers(streamers)
      .filter(({ matchId }) => {
        const m = matches.find((x) => x.id === matchId);
        return m && isToday(matchEndMs(m));
      })
      .map(({ player }) => player.channel.login),
  ).size;

  const feed = useMemo(() => {
    const items: FeedItem[] = [];
    for (const c of clips.slice(0, 20)) {
      items.push(
        c.kind === "theirs"
          ? { at: c.createdMs, title: "Streamer clip saved", sub: [clipTitle(c), clipMoment(c)].join(" · "), color: "var(--twitch)" }
          : { at: c.createdMs, title: `Clip saved · ${settings.hotkey}`, sub: `${formatDuration(c.durationSec)} · ${formatSize(c.sizeBytes)}`, color: "var(--text)" },
      );
    }
    for (const m of matches.slice(0, 10)) {
      const r = result(m, findMe(m, settings.riotId));
      items.push({ at: matchEndMs(m), title: `Match ended · ${m.map}`, sub: [m.mode, r && `${r.letter === "W" ? "Win" : r.letter === "L" ? "Loss" : "Draw"} ${r.score}`, `${m.kills.length} kills synced`].filter(Boolean).join(" · "), color: "var(--kick)" });
      const s = streamers[m.id];
      if (s?.checkedMs) {
        const n = s.players.length;
        items.push({ at: s.checkedMs, title: "Streamers checked", sub: n ? `${n} of ${m.players.length - 1} players were live` : "nobody in the lobby was live", color: "var(--warn)" });
      }
    }
    return items.filter((i) => Number.isFinite(i.at)).sort((a, b) => b.at - a.at).slice(0, 14);
  }, [clips, matches, streamers, settings.riotId, settings.hotkey]);

  const run = (f: () => Promise<void>) => () => void f().catch((err) => notify(String(err), "bad"));

  return (
    <>
      {status?.hotkeyError && <Notice tone="warn">{status.hotkeyError}</Notice>}
      {status?.audioWarning && <Notice tone="warn">{status.audioWarning}</Notice>}
      {(status?.state === "error" || status?.state === "noFfmpeg") && status.message && <Notice tone="bad">{status.message}</Notice>}
      {!settings.riotId && (
        <Notice tone="warn">
          Add your Riot ID so CrossPOV can find streamers in your matches.{" "}
          <button type="button" className="linkish" onClick={() => onNavigate("settings")}>Open Settings</button>
        </Notice>
      )}

      <Panel title="Today" color="var(--twitch)" className="s12" right={<span className="m tiny dim">{new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>}>
        <div className="pad stats">
          <Stat label="Your clips" value={today.filter((c) => c.kind === "mine").length} />
          <Stat label="Streamers met" value={metToday} purple />
          <Stat label="Their-POV clips" value={today.filter((c) => c.kind === "theirs").length} purple />
        </div>
      </Panel>

      <div className="s8 col">
        <Panel
          title="Newest streamer clip"
          color="var(--twitch)"
          right={featured && (
            <span className="row">
              {featured.map && <span className="pill">{featured.map}{featured.round ? ` · R${featured.round}` : ""}</span>}
              {featured.moment && <span className="pill">{featured.moment}</span>}
              {featured.streamer && <span className="pill purple"><span className="pf-dot" />twitch.tv/{featured.streamer}</span>}
            </span>
          )}
        >
          {featured ? (
            <div className="pad" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)", gap: 12 }}>
              <div style={{ borderRadius: 4, overflow: "hidden", border: "1px solid var(--twitch)" }}>
                <ClipThumb clip={featured} big label={`THEIR POV${featured.streamer ? ` · ${featured.streamer}` : ""}`} />
              </div>
              <div className="stack" style={{ justifyContent: "space-between" }}>
                <table className="kv">
                  <tbody>
                    <tr><td>Clip</td><td>{clipTitle(featured)}</td></tr>
                    <tr><td>Moment</td><td>{clipMoment(featured)}</td></tr>
                    <tr><td>Length</td><td>{formatDuration(featured.durationSec) || "—"} ({settings.secondsBefore} s before, {settings.secondsAfter} s after)</td></tr>
                    <tr><td>Size</td><td>{formatSize(featured.sizeBytes)}</td></tr>
                    <tr><td>Saved</td><td>{clockOrAgo(featured.createdMs)}</td></tr>
                  </tbody>
                </table>
                <div className="row-wrap">
                  <button type="button" className="b r" onClick={run(() => openClip(featured.path))}>▶ Play</button>
                  <button type="button" className="b" onClick={run(() => revealClip(featured.path))}>Show in folder</button>
                  <button type="button" className="b" onClick={() => onNavigate("streamers")}>All streamer clips</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty">
              <strong>No streamer clips yet</strong>
              <span>
                After a match, CrossPOV checks once whether anyone in your lobby was streaming, then saves your fights from their VOD.
                {!isDesktop && " This needs the desktop app."}
              </span>
            </div>
          )}
        </Panel>

        <Panel title="Recent clips" right={<span className="row"><span className="pill">All {clips.length}</span><button type="button" className="pill" onClick={() => onNavigate("clips")}>Open clips ›</button></span>}>
          {recent.length ? (
            <div className="pad clip-grid">
              {recent.map((c) => (
                <ClipCard key={c.path} clip={c} onSelect={run(() => openClip(c.path))} />
              ))}
            </div>
          ) : (
            <div className="empty">
              <strong>No clips yet</strong>
              <span>Open VALORANT and press <kbd className="m">{settings.hotkey}</kbd> after a good play. The last {settings.bufferSeconds} seconds are saved.</span>
            </div>
          )}
        </Panel>
      </div>

      <div className="s4 col">
        <Panel title="Activity" color="var(--warn)" className="fill" right={<span className="m tiny dim">live</span>}>
          {feed.length ? (
            <ol className="feed">
              {feed.map((f, i) => (
                <li key={i}>
                  <time title={new Date(f.at).toLocaleString()}>{shortWhen(f.at)}</time>
                  <span className="d" style={{ background: f.color }} />
                  <span><b>{f.title}</b><span>{f.sub}</span></span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty"><span>Clips, matches and streamer checks show up here.</span></div>
          )}
        </Panel>
      </div>
    </>
  );
}
