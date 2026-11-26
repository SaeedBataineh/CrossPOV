import { useEffect, useMemo, useState } from "react";
import { cardTitle, clipTitle, GalleryCard } from "../components/ui";
import { deleteClip, isDesktop, openClipFolder, revealClip, type ClipInfo, type MatchSummary } from "../lib/backend";
import { findPairs } from "../lib/pairs";
import type { Settings } from "../lib/settings";
import { formatSize, type useRecorder } from "../lib/useRecorder";

type Tab = "all" | "theirs" | "mine";
type Sort = "newest" | "longest" | "largest";
const PAGE = 24;

/** Which game a clip is from: streamer clips and clips with a map are VALORANT. Older clips may not know. */
const gameOf = (c: ClipInfo) => (c.kind === "theirs" ? "VALORANT" : c.game ?? (c.map ? "VALORANT" : "Other"));

const SORTS: Record<Sort, (a: ClipInfo, b: ClipInfo) => number> = {
  newest: (a, b) => b.createdMs - a.createdMs,
  longest: (a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0),
  largest: (a, b) => b.sizeBytes - a.sizeBytes,
};

/** Every clip in one grid, newest first. Search comes from the top bar. */
export default function Clips({
  settings,
  recorder,
  matches,
  query,
  onOpen,
}: {
  settings: Settings;
  recorder: ReturnType<typeof useRecorder>;
  matches: MatchSummary[];
  query: string;
  onOpen: (c: ClipInfo) => void;
}) {
  const { clips, refreshClips, notify } = recorder;
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [game, setGame] = useState("all");
  const games = useMemo(() => [...new Set(clips.map(gameOf))].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b))), [clips]);
  const [limit, setLimit] = useState(PAGE);
  const pairs = useMemo(() => findPairs(clips, matches), [clips, matches]);

  const theirs = clips.filter((c) => c.kind === "theirs").length;
  const tabs: { value: Tab; label: string; n: number }[] = [
    { value: "all", label: "All", n: clips.length },
    { value: "theirs", label: "Streamer clips", n: theirs },
    { value: "mine", label: "My clips", n: clips.length - theirs },
  ];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clips
      .filter(
        (c) =>
          (tab === "all" || c.kind === tab) &&
          (game === "all" || gameOf(c) === game) &&
          (!q || [cardTitle(c), c.name, c.streamer, c.map, c.moment, c.game].filter(Boolean).join(" ").toLowerCase().includes(q)),
      )
      .sort(SORTS[sort]);
  }, [clips, tab, query, sort, game]);
  useEffect(() => setLimit(PAGE), [tab, query, sort, game]);

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
    <section className="page wide" aria-label="Clips">
      <div className="tabs-row">
        <div className="tabs" role="tablist" aria-label="Show">
          {tabs.map((t) => (
            <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)}>
              {t.label} <span className="count">{t.n}</span>
            </button>
          ))}
        </div>
        <span className="row" style={{ gap: 8, marginBottom: 8 }}>
        {games.length > 1 && (
          <label className="field">
            <span className="sr-only">Game</span>
            <select value={game} onChange={(e) => setGame(e.target.value)}>
              <option value="all">All games</option>
              {games.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field" style={{ marginBottom: 0 }}>
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="newest">Newest</option>
            <option value="longest">Longest</option>
            <option value="largest">Largest</option>
          </select>
        </label>
        </span>
      </div>

      {shown.length ? (
        <div className="gallery">
          {shown.slice(0, limit).map((c) => {
            const p = pairs.find((x) => x.mine.path === c.path || x.theirs.path === c.path);
            return (
              <GalleryCard
                key={c.path}
                clip={c}
                other={p ? (c.kind === "mine" ? p.theirs : p.mine) : undefined}
                onPlay={() => onOpen(c)}
                onReveal={isDesktop ? run(() => revealClip(c.path)) : undefined}
                onDelete={() => void remove(c)}
              />
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <b>{clips.length ? "No clips match" : tab === "theirs" ? "No streamer clips yet" : "No clips yet"}</b>
          <span>
            {clips.length
              ? "Try another search or tab."
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
