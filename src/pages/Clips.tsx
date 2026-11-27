import { useEffect, useMemo, useRef, useState } from "react";
import { Select } from "../components/Select";
import { BrandLogo, brandFor } from "../components/Brand";
import { SegmentedControl, type TabIcon } from "../components/SegmentedControl";
import { TwitchTabIcon } from "../components/Icons";
import { cardTitle, GalleryCard } from "../components/ui";
import { isDesktop, openClipFolder, revealClip, type ClipInfo, type MatchSummary } from "../lib/backend";
import { deleteWithUndo } from "../lib/deleteClips";
import { useTitles } from "../lib/titles";
import { findPairs } from "../lib/pairs";
import type { Settings } from "../lib/settings";
import { useFavourites } from "../lib/favourites";
import { formatSize, type useRecorder } from "../lib/useRecorder";
import { SquaresFour, Star, Trash, User, X } from "@phosphor-icons/react";

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
  const { clips, refreshClips, notify, show } = recorder;
  const titles = useTitles();
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
  const tabs: { value: Tab; label: string; n: number; Icon: TabIcon }[] = [
    { value: "all", label: "All", n: clips.length, Icon: SquaresFour },
    { value: "theirs", label: "Streamer clips", n: theirs, Icon: TwitchTabIcon },
    { value: "mine", label: "My clips", n: clips.length - theirs, Icon: User },
    { value: "fav", label: "Favourites", n: clips.filter((c) => favs.has(c.path)).length, Icon: Star },
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
  }, [clips, tab, query, sort, game, favs, titles]);
  useEffect(() => setLimit(PAGE), [tab, query, sort, game]);

  // More clips load by themselves as the end of the grid scrolls into view.
  const end = useRef<HTMLDivElement>(null);
  const more = shown.length > limit;
  useEffect(() => {
    const el = end.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && setLimit((l) => l + PAGE), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, limit]);

  const totalBytes = clips.reduce((n, c) => n + c.sizeBytes, 0);
  const run = (f: () => Promise<void>) => () => void f().catch((err) => notify(String(err), "bad"));

  /** Gone at once, with Undo in the toast; then to the Recycle Bin. */
  const remove = (c: ClipInfo) => void deleteWithUndo([c], `"${cardTitle(c)}"`, show, refreshClips);

  async function removePicked() {
    const list = clips.filter((c) => picked.has(c.path));
    if (!list.length) return;
    await deleteWithUndo(list, `"${cardTitle(list[0])}"`, show, refreshClips);
    setPicked(new Set());
  }

  return (
    <section className="page wide" aria-label="Clips">
      <div className="tabs-row">
        <SegmentedControl label="Show" value={tab} segments={tabs.map((t) => ({ id: t.value, label: t.label, n: t.n, Icon: t.Icon }))} onChange={setTab} />
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
                onDelete={() => remove(c)}
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

      {more && <div ref={end} className="load-more" aria-hidden="true" />}

      {clips.length > 0 && (
        <footer className="page-foot">
          <span>{formatSize(totalBytes)}{settings.storageLimitGb ? ` of ${settings.storageLimitGb} GB used` : " used"}</span>
          {isDesktop && <button type="button" className="linkish" onClick={run(openClipFolder)}>Open clips folder</button>}
        </footer>
      )}
    </section>
  );
}
