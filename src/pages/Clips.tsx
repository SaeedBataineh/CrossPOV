import { useEffect, useMemo, useState } from "react";
import { cardTitle, clipTitle, GalleryCard } from "../components/ui";
import { deleteClip, isDesktop, openClipFolder, revealClip, type ClipInfo } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { formatSize, type useRecorder } from "../lib/useRecorder";

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

export default function Clips({ settings, recorder, onPlay }: { settings: Settings; recorder: ReturnType<typeof useRecorder>; onPlay: (c: ClipInfo) => void }) {
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

  const totalBytes = clips.reduce((n, c) => n + c.sizeBytes, 0);
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
      <header className="page-head">
        <h1>Clips</h1>
        <span className="spacer" />
        <label className="field search-field">
          <span className="sr-only">Search clips</span>
          <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="field">
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="newest">Newest</option>
            <option value="longest">Longest</option>
            <option value="largest">Largest</option>
          </select>
        </label>
      </header>
      <div className="chips" role="radiogroup" aria-label="Show">
        {tabs.map((t) => (
          <button key={t.value} type="button" role="radio" aria-checked={tab === t.value} onClick={() => setTab(t.value)}>
            {t.label} <span className="count">{t.n}</span>
          </button>
        ))}
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
                  onPlay={() => onPlay(c)}
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

      {clips.length > 0 && (
        <footer className="page-foot">
          <span>{formatSize(totalBytes)}{settings.storageLimitGb ? ` of ${settings.storageLimitGb} GB used` : " used"}</span>
          {isDesktop && <button type="button" className="linkish" onClick={run(openClipFolder)}>Open clips folder</button>}
        </footer>
      )}
    </section>
  );
}
