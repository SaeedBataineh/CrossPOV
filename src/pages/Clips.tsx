import { useMemo, useState } from "react";
import { SearchIcon } from "../components/Icons";
import { cardFromClip, cardFromSample, ClipCard, type CardClip } from "../components/ui";
import { deleteClip, isDesktop, openClip, openClipFolder, revealClip } from "../lib/backend";
import { SAMPLE_CLIPS } from "../lib/sample";
import { formatSize, type useRecorder } from "../lib/useRecorder";

type Tab = "all" | "mine" | "theirs";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All clips" },
  { id: "mine", label: "My clips" },
  { id: "theirs", label: "Streamer POV" },
];

export default function Clips({ recorder }: { recorder: ReturnType<typeof useRecorder> }) {
  const { clips, refreshClips, notify } = recorder;
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");

  const sizeByKey = useMemo(() => new Map(clips.map((c) => [c.path, c.sizeBytes])), [clips]);
  const cards: CardClip[] = useMemo(() => {
    const real = clips.map(cardFromClip);
    // Streamer clips come in step 4; until then show labelled samples.
    const samples = SAMPLE_CLIPS.filter((c) => c.kind === "theirs").map(cardFromSample);
    return [...real, ...samples];
  }, [clips]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => (tab === "all" || c.kind === tab) && (!q || `${c.title} ${c.meta}`.toLowerCase().includes(q)));
  }, [cards, tab, query]);

  async function remove(c: CardClip) {
    if (!window.confirm(`Delete "${c.title}"? This can't be undone.`)) return;
    try {
      await deleteClip(c.key);
      refreshClips();
    } catch (err) {
      notify(`Couldn't delete: ${String(err)}`, "bad");
    }
  }

  const run = (f: () => Promise<void>) => () => void f().catch((err) => notify(String(err), "bad"));

  return (
    <>
      <header className="page-head">
        <h1>Clips</h1>
        <div className="row-wrap">
          <label className="search">
            <SearchIcon />
            <span className="sr-only">Search clips</span>
            <input type="search" placeholder="Search clips" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button type="button" className="btn" onClick={run(openClipFolder)} disabled={!isDesktop}>
            Open folder
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Clip type">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {shown.length ? (
        <div className="clip-grid wide">
          {shown.map((c) => (
            <ClipCard
              key={c.key}
              clip={c}
              actions={
                c.sample ? (
                  <span className="muted small">Sample · streamer clips arrive in step 4</span>
                ) : (
                  <>
                    <button type="button" className="btn primary" onClick={run(() => openClip(c.key))}>Play</button>
                    <button type="button" className="btn" onClick={run(() => revealClip(c.key))}>Show in folder</button>
                    <button type="button" className="btn icon" aria-label={`Delete ${c.title}`} title={`Delete (${formatSize(sizeByKey.get(c.key) ?? 0)})`} onClick={() => void remove(c)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                    </button>
                  </>
                )
              }
            />
          ))}
        </div>
      ) : (
        <p className="muted">{clips.length || tab !== "mine" ? "No clips match." : "No clips yet. Press your hotkey in game to save one."}</p>
      )}
    </>
  );
}
