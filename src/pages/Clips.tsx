import { useEffect, useMemo, useState } from "react";
import { Select } from "../components/Select";
import { BrandLogo, brandFor } from "../components/Brand";
import { SegmentedControl } from "../components/SegmentedControl";
import { cardTitle, clipTitle, GalleryCard } from "../components/ui";
import { deleteClip, isDesktop, openClipFolder, revealClip, type ClipInfo, type MatchSummary } from "../lib/backend";
import { findPairs } from "../lib/pairs";
import type { Settings } from "../lib/settings";
import { useFavourites } from "../lib/favourites";
import { formatSize, type useRecorder } from "../lib/useRecorder";
import { Trash, X } from "@phosphor-icons/react";

/** A game's logo, when we know it. */
const brandLogo = (name: string) => {
  const b = brandFor(name);
  return b ? <BrandLogo icon={b} size={14} /> : undefined;
};

type Tab = "all" | "theirs" | "mine" | "fav";
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
  const favs = useFavourites();
  /** Clips ticked for a bulk action. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const togglePick = (path: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const pairs = useMemo(() => findPairs(clips, matches), [clips, matches]);

  const theirs = clips.filter((c) => c.kind === "theirs").length;
  const tabs: { value: Tab; label: string; n: number }[] = [
    { value: "all", label: "All", n: clips.length },
    { value: "theirs", label: "Streamer clips", n: theirs },
    { value: "mine", label: "My clips", n: clips.length - theirs },
    { value: "fav", label: "Favourites", n: clips.filter((c) => favs.has(c.path)).length },
  ];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clips
      .filter(
        (c) =>
          (tab === "all" || (tab === "fav" ? favs.has(c.path) : c.kind === tab)) &&
          (game === "all" || gameOf(c) === game) &&
          (!q || [cardTitle(c), c.name, c.streamer, c.map, c.moment, c.game].filter(Boolean).join(" ").toLowerCase().includes(q)),
      )
      .sort(SORTS[sort]);
  }, [clips, tab, query, sort, game, favs]);
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

  async function removePicked() {
    const list = clips.filter((c) => picked.has(c.path));
    if (!list.length || !window.confirm(`Delete ${list.length} clip${list.length === 1 ? "" : "s"}? This can't be undone.`)) return;
    let failed = 0;
    for (const c of list) {
      try {
        await deleteClip(c.path);
      } catch {
        failed++;
      }
    }
    if (failed) notify(`Couldn't delete ${failed} of ${list.length} clips.`, "bad");
    setPicked(new Set());
    refreshClips();
  }

  return (
    <section className="page wide" aria-label="Clips">
      <div className="tabs-row">
        <SegmentedControl label="Show" value={tab} segments={tabs.map((t) => ({ id: t.value, label: t.label, n: t.n }))} onChange={setTab} />
        <span className="row" style={{ gap: 8 }}>
        {games.length > 1 && (
          <Select label="Game" value={game} onChange={setGame} options={[{ value: "all", label: "All games" }, ...games.map((g) => ({ value: g, label: g, icon: brandLogo(g) }))]} />
        )}
        <Select<Sort> label="Sort" value={sort} onChange={setSort} options={[{ value: "newest", label: "Newest" }, { value: "longest", label: "Longest" }, { value: "largest", label: "Largest" }]} />
        </span>
      </div>

      {picked.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Selected clips">
          <b>{picked.size} selected</b>
          <button type="button" className="linkish" onClick={() => setPicked(new Set(shown.map((c) => c.path)))}>Select all {shown.length}</button>
          <span className="spacer" />
          <button type="button" className="btn danger sm-btn" onClick={() => void removePicked()}><Trash size={15} weight="bold" aria-hidden />Delete</button>
          <button type="button" className="btn sm-btn" onClick={() => setPicked(new Set())}><X size={14} weight="bold" aria-hidden />Clear</button>
        </div>
      )}

      {shown.length ? (
        <div className="gallery" key={tab}>
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
                selected={picked.has(c.path)}
                onSelect={() => togglePick(c.path)}
                notify={notify}
              />
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <b>{tab === "fav" && clips.length ? "No favourites yet" : clips.length ? "No clips match" : tab === "theirs" ? "No streamer clips yet" : "No clips yet"}</b>
          <span>
            {tab === "fav" && clips.length
              ? "Hover a clip and click its star to keep it here."
              : clips.length
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
