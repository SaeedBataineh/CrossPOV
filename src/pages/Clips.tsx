import { useEffect, useMemo, useState } from "react";
import { cardTitle, clipTitle, GalleryCard } from "../components/ui";
import { deleteClip, isDesktop, openClip, openClipFolder, revealClip, type ClipInfo } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { formatSize, type useRecorder } from "../lib/useRecorder";

type Tab = "all" | "theirs" | "mine";
type Sort = "newest" | "longest" | "largest";
const PAGE = 24;

const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "theirs", label: "Streamer clips" },
  { value: "mine", label: "My clips" },
];

const SORTS: Record<Sort, (a: ClipInfo, b: ClipInfo) => number> = {
  newest: (a, b) => b.createdMs - a.createdMs,
  longest: (a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0),
  largest: (a, b) => b.sizeBytes - a.sizeBytes,
};

export default function Clips({ settings, recorder }: { settings: Settings; recorder: ReturnType<typeof useRecorder> }) {
  const { clips, refreshClips, notify } = recorder;
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clips
      .filter((c) => (tab === "all" || c.kind === tab) && (!q || [cardTitle(c), c.name, c.streamer, c.map, c.moment].filter(Boolean).join(" ").toLowerCase().includes(q)))
      .sort(SORTS[sort]);
  }, [clips, tab, query, sort]);
  useEffect(() => setLimit(PAGE), [tab, query, sort]);

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
      <div className="toolbar">
        <div className="chips" role="radiogroup" aria-label="Show">
          {TABS.map((t) => (
            <button key={t.value} type="button" role="radio" aria-checked={tab === t.value} onClick={() => setTab(t.value)}>{t.label}</button>
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
        <div className="gallery">
          {shown.slice(0, limit).map((c) => (
            <GalleryCard
              key={c.path}
              clip={c}
              onPlay={run(() => openClip(c.path))}
              onReveal={isDesktop ? run(() => revealClip(c.path)) : undefined}
              onDelete={() => void remove(c)}
            />
          ))}
        </div>
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

      <footer className="page-foot">
        <span>{clips.length} clips · {formatSize(totalBytes)}{settings.storageLimitGb ? ` of ${settings.storageLimitGb} GB` : ""}</span>
        {isDesktop && <button type="button" className="linkish" onClick={run(openClipFolder)}>Open clips folder</button>}
      </footer>
    </section>
  );
}
