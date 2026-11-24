import { useEffect, useMemo, useState } from "react";
import { ClipCard, ClipThumb, clipMoment, clipTitle, clockOrAgo, Panel, Seg } from "../components/ui";
import { deleteClip, isDesktop, openClip, openClipFolder, revealClip, type ClipInfo } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { formatDuration, formatSize, type useRecorder } from "../lib/useRecorder";

type Tab = "all" | "mine" | "theirs";
type Sort = "newest" | "longest" | "largest";
const PER_PAGE = 9;

/** Filter groups: each maps a clip to the value it is grouped by. */
const GROUPS: { id: string; title: string; key: (c: ClipInfo) => string | null }[] = [
  { id: "moment", title: "Moment", key: (c) => (c.kind === "mine" ? "Hotkey clip" : c.moment ?? "Streamer clip") },
  { id: "streamer", title: "Streamer", key: (c) => c.streamer },
  { id: "map", title: "Map", key: (c) => c.map },
  {
    id: "when",
    title: "When",
    key: (c) => {
      const days = Math.floor((new Date().setHours(24, 0, 0, 0) - c.createdMs) / 86_400_000);
      return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "This week" : "Older";
    },
  },
];

export default function Clips({
  settings,
  recorder,
  query,
  onQuery,
}: {
  settings: Settings;
  recorder: ReturnType<typeof useRecorder>;
  query: string;
  onQuery: (q: string) => void;
}) {
  const { clips, refreshClips, notify } = recorder;
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  /** Values the user unticked, per group. */
  const [hidden, setHidden] = useState<Record<string, Set<string>>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const totalBytes = clips.reduce((n, c) => n + c.sizeBytes, 0);
  const limitBytes = settings.storageLimitGb * 1024 ** 3;

  const groups = useMemo(
    () =>
      GROUPS.map((g) => {
        const counts = new Map<string, number>();
        for (const c of clips) {
          const v = g.key(c);
          if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        return { ...g, values: [...counts.entries()].sort((a, b) => b[1] - a[1]) };
      }).filter((g) => g.values.length > 0),
    [clips],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = clips.filter((c) => {
      if (tab !== "all" && c.kind !== tab) return false;
      for (const g of GROUPS) {
        const v = g.key(c);
        if (v && hidden[g.id]?.has(v)) return false;
      }
      return !q || [clipTitle(c), c.name, c.streamer, c.map, c.moment].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
    const by: Record<Sort, (a: ClipInfo, b: ClipInfo) => number> = {
      newest: (a, b) => b.createdMs - a.createdMs,
      longest: (a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0),
      largest: (a, b) => b.sizeBytes - a.sizeBytes,
    };
    return [...list].sort(by[sort]);
  }, [clips, tab, hidden, query, sort]);

  useEffect(() => setPage(0), [tab, hidden, query, sort]);
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const onPage = shown.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const current = shown.find((c) => c.path === selected) ?? shown[0];

  const toggleHidden = (group: string, value: string) =>
    setHidden((h) => {
      const next = new Set(h[group]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...h, [group]: next };
    });
  const toggleChecked = (path: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const run = (f: () => Promise<void>) => () => void f().catch((err) => notify(String(err), "bad"));

  async function remove(paths: string[]) {
    if (!paths.length) return;
    const what = paths.length === 1 ? `"${clipTitle(clips.find((c) => c.path === paths[0])!)}"` : `${paths.length} clips`;
    if (!window.confirm(`Delete ${what}? This can't be undone.`)) return;
    try {
      for (const p of paths) await deleteClip(p);
      setChecked(new Set());
    } catch (err) {
      notify(`Couldn't delete: ${String(err)}`, "bad");
    }
    refreshClips();
  }

  const mine = clips.filter((c) => c.kind === "mine").length;
  const tabs = [
    { value: "all" as Tab, label: `All ${clips.length}` },
    { value: "mine" as Tab, label: `Your POV ${mine}` },
    { value: "theirs" as Tab, label: `Their POV ${clips.length - mine}` },
  ];

  return (
    <>
      <section className="panel s12" aria-label="Clip tools">
        <div className="row-wrap" style={{ padding: "9px 12px", gap: 10 }}>
          <Seg label="Clip type" value={tab} onChange={setTab} options={tabs} />
          <span className="m tiny dim">SORT</span>
          <Seg label="Sort" value={sort} onChange={setSort} options={[{ value: "newest", label: "Newest" }, { value: "longest", label: "Longest" }, { value: "largest", label: "Largest" }]} />
          {query && <button type="button" className="pill" onClick={() => onQuery("")}>“{query}” ✕</button>}
          <span className="spacer" />
          <span className="stack" style={{ gap: 3, width: 190 }}>
            <span className="m tiny muted row" style={{ justifyContent: "space-between" }}>
              <span>{formatSize(totalBytes)} used</span>
              <span>{settings.storageLimitGb ? `limit ${settings.storageLimitGb} GB` : "no limit"}</span>
            </span>
            <span className="bar"><i style={{ width: `${limitBytes ? Math.min(100, (totalBytes / limitBytes) * 100) : 0}%` }} /></span>
          </span>
          <button type="button" className="b" onClick={run(openClipFolder)} disabled={!isDesktop}>Open folder</button>
          <button type="button" className="b" disabled={!checked.size} onClick={() => void remove([...checked])}>Delete ({checked.size})</button>
        </div>
      </section>

      <Panel title="Filters" color="var(--warn)" className="s2" right={<button type="button" className="linkish m tiny purple" onClick={() => setHidden({})}>reset</button>}>
        <div style={{ padding: "2px 12px 12px" }}>
          {groups.length === 0 && <p className="muted small">Filters appear once you have clips.</p>}
          {groups.map((g) => (
            <div key={g.id}>
              <div className="gh">{g.title}</div>
              {g.values.map(([v, n]) => {
                const on = !hidden[g.id]?.has(v);
                return (
                  <button key={v} type="button" className="fl" role="checkbox" aria-checked={on} onClick={() => toggleHidden(g.id, v)}>
                    <span className={on ? "cb on" : "cb"} />
                    <span className="ellipsis">{v}</span>
                    <em>{n}</em>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Clips" className="s7" right={<span className="m tiny dim">{shown.length ? `showing ${page * PER_PAGE + 1}–${page * PER_PAGE + onPage.length} of ${shown.length}` : "0 clips"}{checked.size ? ` · ${checked.size} ticked` : ""}</span>}>
        {onPage.length ? (
          <>
            <div className="pad clip-grid">
              {onPage.map((c) => (
                <div key={c.path} style={{ position: "relative", display: "flex" }}>
                  <ClipCard clip={c} selected={c.path === current?.path} onSelect={() => setSelected(c.path)} onOpen={run(() => openClip(c.path))} />
                  <button type="button" className="cb" role="checkbox" aria-checked={checked.has(c.path)} aria-label={`Tick ${clipTitle(c)}`}
                    style={{ position: "absolute", right: 6, top: 6, zIndex: 2, width: 16, height: 16, background: checked.has(c.path) ? undefined : "#000a" }}
                    onClick={() => toggleChecked(c.path)} />
                </div>
              ))}
            </div>
            <div className="row" style={{ justifyContent: "space-between", padding: "0 12px 12px" }}>
              <span className="m tiny dim">double-click a clip to play it</span>
              {pages > 1 && (
                <span className="row">
                  <button type="button" className="pill" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</button>
                  <span className="pill"><b>{page + 1}</b>&nbsp;/ {pages}</span>
                  <button type="button" className="pill" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next ›</button>
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="empty">
            <strong>{clips.length ? "No clips match" : "No clips yet"}</strong>
            <span>
              {clips.length
                ? "Change the filters or the search."
                : tab === "theirs"
                  ? "Streamer clips appear after you play against someone who was streaming."
                  : `Press ${settings.hotkey} in game to save the last ${settings.bufferSeconds} seconds.`}
            </span>
          </div>
        )}
      </Panel>

      <Panel title="Selected" color="var(--twitch)" className="s3" right={current && <span className="m tiny dim">{shown.indexOf(current) + 1} of {shown.length}</span>}>
        {current ? (
          <div className="pad stack">
            <div style={{ borderRadius: 4, overflow: "hidden", border: `1px solid ${current.kind === "theirs" ? "var(--twitch)" : "var(--line-2)"}` }}>
              <ClipThumb clip={current} big label={current.kind === "theirs" ? `THEIR POV${current.streamer ? ` · ${current.streamer}` : ""}` : "YOUR POV"} />
            </div>
            <b style={{ fontSize: 14 }}>{clipTitle(current)}</b>
            <table className="kv">
              <tbody>
                <tr><td>Type</td><td>{current.kind === "theirs" ? <span className="chip"><span className="pf-dot" />Their POV</span> : "Your POV"}</td></tr>
                {current.streamer && <tr><td>Streamer</td><td>twitch.tv/{current.streamer}</td></tr>}
                {current.map && <tr><td>Map</td><td>{current.map}</td></tr>}
                {current.round != null && <tr><td>Round</td><td>{current.round}</td></tr>}
                <tr><td>Moment</td><td>{clipMoment(current)}</td></tr>
                <tr><td>Length</td><td>{formatDuration(current.durationSec) || "—"}</td></tr>
                <tr><td>Size</td><td>{formatSize(current.sizeBytes)}</td></tr>
                <tr><td>Saved</td><td>{clockOrAgo(current.createdMs)}</td></tr>
                <tr><td>File</td><td>{current.name}</td></tr>
              </tbody>
            </table>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <button type="button" className="b r" onClick={run(() => openClip(current.path))}>▶ Play</button>
              <button type="button" className="b" onClick={run(() => revealClip(current.path))}>Show in folder</button>
              <button type="button" className="b" style={{ gridColumn: "span 2" }} onClick={() => void remove([current.path])}>Delete</button>
            </div>
          </div>
        ) : (
          <div className="empty"><span>Pick a clip to see its details.</span></div>
        )}
      </Panel>
    </>
  );
}
