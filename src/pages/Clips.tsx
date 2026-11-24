import { useMemo, useState } from "react";
import { SearchIcon } from "../components/Icons";
import { ClipCard, SampleBanner } from "../components/ui";
import { isDesktop, openClipFolder } from "../lib/backend";
import { SAMPLE_CLIPS, type ClipKind } from "../lib/sample";

type Tab = "all" | ClipKind;
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All clips" },
  { id: "mine", label: "My clips" },
  { id: "theirs", label: "Streamer POV" },
];

export default function Clips() {
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SAMPLE_CLIPS.filter(
      (c) => (tab === "all" || c.kind === tab) && (!q || `${c.title} ${c.meta}`.toLowerCase().includes(q)),
    );
  }, [tab, query]);

  return (
    <>
      <header className="page-head">
        <h1>Clips</h1>
        <div className="row-wrap">
          <label className="search">
            <SearchIcon />
            <span className="sr-only">Search clips</span>
            <input type="search" placeholder="Search clips or streamers" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button type="button" className="btn" onClick={() => void openClipFolder()} disabled={!isDesktop}>
            Open folder
          </button>
        </div>
      </header>

      <SampleBanner>These are sample clips. Real clips appear here once recording is added.</SampleBanner>

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
            <ClipCard key={c.id} clip={c} actions />
          ))}
        </div>
      ) : (
        <p className="muted">No clips match.</p>
      )}
    </>
  );
}
