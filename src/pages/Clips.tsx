import { useEffect, useMemo, useState } from "react";
import { cardTitle, clipTitle, GalleryCard } from "../components/ui";
import { deleteClip, isDesktop, openClip, openClipFolder, revealClip, thumbSrc, type ClipInfo } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { formatDuration, formatSize, timeAgo, type useRecorder } from "../lib/useRecorder";

type Tab = "all" | "theirs" | "mine";
type Sort = "newest" | "longest" | "largest";
const PAGE = 24;

const SORTS: Record<Sort, (a: ClipInfo, b: ClipInfo) => number> = {
  newest: (a, b) => b.createdMs - a.createdMs,
  longest: (a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0),
  largest: (a, b) => b.sizeBytes - a.sizeBytes,
};

/** "Today", "Yesterday", "Monday", or "12 Nov". */
function dayLabel(ms: number): string {
  const day = new Date(ms).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  const days = Math.round((today - day) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The newest streamer clip, big, with what happened and the two things you'd do with it. */
function Featured({ clip, onPlay, onReveal }: { clip: ClipInfo; onPlay: () => void; onReveal?: () => void }) {
  const src = thumbSrc(clip.thumb);
  return (
    <div className="featured">
      <button type="button" className="featured-thumb" onClick={onPlay} aria-label={`Play ${cardTitle(clip)}`}>
        {src && <img src={src} alt="" />}
        <span className="play-ring" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor" /></svg>
        </span>
        {clip.durationSec != null && <span className="len">{formatDuration(clip.durationSec)}</span>}
      </button>
      <div className="featured-info">
        <span className="eyebrow">Newest streamer clip</span>
        <h2>{cardTitle(clip)}</h2>
        <span className="muted">
          {[clip.streamer && `from ${clip.streamer}'s stream`, clip.map, clip.round != null && `round ${clip.round}`].filter(Boolean).join(" · ")}
        </span>
        <span className="muted small">{timeAgo(clip.createdMs)} · {formatSize(clip.sizeBytes)}</span>
        <div className="row" style={{ gap: 10, marginTop: 14 }}>
          <button type="button" className="btn primary" onClick={onPlay}>Play</button>
          {onReveal && <button type="button" className="btn" onClick={onReveal}>Show in folder</button>}
        </div>
      </div>
    </div>
  );
}

export default function Clips({ settings, recorder }: { settings: Settings; recorder: ReturnType<typeof useRecorder> }) {
  const { clips, refreshClips, notify } = recorder;
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const theirs = clips.filter((c) => c.kind === "theirs").length;
  const tabs: { value: Tab; label: string; n: number }[] = [
    { value: "all", label: "All", n: clips.length },
    { value: "theirs", label: "Streamer clips", n: theirs },
    { value: "mine", label: "My clips", n: clips.length - theirs },
  ];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clips
      .filter((c) => (tab === "all" || c.kind === tab) && (!q || [cardTitle(c), c.name, c.streamer, c.map, c.moment].filter(Boolean).join(" ").toLowerCase().includes(q)))
      .sort(SORTS[sort]);
  }, [clips, tab, query, sort]);
  useEffect(() => setLimit(PAGE), [tab, query, sort]);

  // Group by day when showing newest first; other sorts are one list.
  const groups = useMemo(() => {
    const list = shown.slice(0, limit);
    if (sort !== "newest") return [{ label: "", clips: list }];
    const out: { label: string; clips: ClipInfo[] }[] = [];
    for (const c of list) {
      const label = dayLabel(c.createdMs);
      if (out[out.length - 1]?.label !== label) out.push({ label, clips: [] });
      out[out.length - 1].clips.push(c);
    }
    return out;
  }, [shown, limit, sort]);

  const featured = !query && tab !== "mine" ? clips.find((c) => c.kind === "theirs") : undefined;
  const totalBytes = clips.reduce((n, c) => n + c.sizeBytes, 0);
  const limitBytes = settings.storageLimitGb * 1024 ** 3;
  const run = (f: () => Promise<void>) => () => void f().catch((err) => notify(String(err), "bad"));

  async function remove(c: ClipInfo) {
    if (!window.confirm(`Delete "${clipTitle(c)}"? This can't be undone.`)) return;
    try {
      await deleteClip(c.path);
    } catch (err) {
      notify(`Couldn't delete: ${String(err)}`, "bad");
    }
    refreshClips();
  }

  return (
    <section className="s12 page" aria-label="Clips">
      {featured && (
        <div className="clips-top">
          <Featured clip={featured} onPlay={run(() => openClip(featured.path))} onReveal={isDesktop ? run(() => revealClip(featured.path)) : undefined} />
          <aside className="summary">
            <div className="summary-stat"><b>{theirs}</b><span>streamer clips</span></div>
            <div className="summary-stat"><b>{clips.length - theirs}</b><span>your clips</span></div>
            <div className="summary-stat">
              <b>{formatSize(totalBytes)}</b>
              <span>{settings.storageLimitGb ? `of ${settings.storageLimitGb} GB used` : "used"}</span>
              {limitBytes > 0 && <span className="bar" style={{ marginTop: 8 }}><i style={{ width: `${Math.min(100, (totalBytes / limitBytes) * 100)}%` }} /></span>}
            </div>
            {isDesktop && <button type="button" className="btn quiet" onClick={run(openClipFolder)}>Open clips folder</button>}
          </aside>
        </div>
      )}

      <div className="toolbar">
        <div className="chips" role="radiogroup" aria-label="Show">
          {tabs.map((t) => (
            <button key={t.value} type="button" role="radio" aria-checked={tab === t.value} onClick={() => setTab(t.value)}>
              {t.label} <span className="count">{t.n}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="field search-field">
          <span className="sr-only">Search clips</span>
          <input type="search" placeholder="Search streamer, map…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="field">
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="newest">Newest</option>
            <option value="longest">Longest</option>
            <option value="largest">Largest</option>
          </select>
        </label>
      </div>

      {shown.length ? (
        groups.map((g) => (
          <div key={g.label || "all"} className="day-group">
            {g.label && <h2 className="day-label">{g.label} <span>{g.clips.length}</span></h2>}
            <div className="gallery">
              {g.clips.map((c) => (
                <GalleryCard
                  key={c.path}
                  clip={c}
                  onPlay={run(() => openClip(c.path))}
                  onReveal={isDesktop ? run(() => revealClip(c.path)) : undefined}
                  onDelete={() => void remove(c)}
                />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="empty-state">
          <b>{clips.length ? "No clips match" : tab === "theirs" ? "No streamer clips yet" : "No clips yet"}</b>
          <span>
            {clips.length
              ? "Try another search or filter."
              : tab === "theirs"
                ? "They appear here after you play against someone who was streaming."
                : `Press ${settings.hotkey} in game to save the last ${settings.bufferSeconds} seconds.`}
          </span>
        </div>
      )}

      {shown.length > limit && (
        <button type="button" className="btn quiet center" onClick={() => setLimit(limit + PAGE)}>Show more</button>
      )}
    </section>
  );
}
