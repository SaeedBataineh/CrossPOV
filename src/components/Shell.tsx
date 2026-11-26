import type { ReactNode } from "react";
import { isDesktop, saveClipNow, type RecorderStatus, type UpdateStatus } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { ClipsIcon, GearIcon, HomeIcon, Logo, SearchIcon, StreamIcon } from "./Icons";

export type Page = "home" | "clips" | "streamers" | "settings";

const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: "home", label: "Home", icon: <HomeIcon size={20} /> },
  { id: "clips", label: "Clips", icon: <ClipsIcon size={20} /> },
  { id: "streamers", label: "Streamers", icon: <StreamIcon size={20} /> },
];

function RailItem({ page, id, label, icon, onNavigate }: { page: Page; id: Page; label: string; icon: ReactNode; onNavigate: (p: Page) => void }) {
  return (
    <button type="button" className="rail-item" aria-current={page === id ? "page" : undefined} onClick={() => onNavigate(id)}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** The slim menu on the left: the pages, and Settings at the bottom. */
export function Rail({ page, update, onNavigate }: { page: Page; update: UpdateStatus | null; onNavigate: (p: Page) => void }) {
  return (
    <nav className="rail" aria-label="Main">
      <span className="rail-logo" title="CrossPOV"><Logo size={28} /></span>
      {NAV.map((n) => (
        <RailItem key={n.id} page={page} {...n} onNavigate={onNavigate} />
      ))}
      <span className="spacer" />
      {update?.state === "waiting" && (
        <span className="rail-note" title={`Update v${update.version} installs as soon as VALORANT is closed`}>Update after game</span>
      )}
      <RailItem page={page} id="settings" label="Settings" icon={<GearIcon size={20} />} onNavigate={onNavigate} />
      {!isDesktop && <a className="rail-item" href="/"><span>About</span></a>}
    </nav>
  );
}

/** Top bar: search (where it applies) and the recorder, with a Save clip button. */
export function TopBar({
  settings,
  status,
  query,
  onQuery,
  searchLabel,
  onSaving,
  title,
}: {
  settings: Settings;
  status: RecorderStatus | null;
  query: string;
  onQuery: (q: string) => void;
  /** No search box when undefined. */
  searchLabel?: string;
  onSaving: () => void;
  /** Shown instead of the search box. */
  title?: ReactNode;
}) {
  const state = status?.state;
  const recording = state === "recording";
  const bad = state === "error" || state === "noFfmpeg";
  const line = !isDesktop
    ? "Website demo"
    : recording ? "Recording"
    : bad ? "Recorder stopped"
    : state === "waiting" ? "Waiting for VALORANT"
    : "Starting…";

  return (
    <header className="topbar">
      {searchLabel ? (
        <label className="top-search">
          <SearchIcon size={16} />
          <span className="sr-only">{searchLabel}</span>
          <input type="search" placeholder={searchLabel} value={query} onChange={(e) => onQuery(e.target.value)} spellCheck={false} />
        </label>
      ) : (
        <div className="top-title">{title}</div>
      )}
      <span className="spacer" />
      <div className="rec-status" title={status?.message ?? undefined} role="status">
        <span className={`dot ${recording ? "rec" : bad ? "bad" : "idle"}`} aria-hidden="true" />
        <b>{line}</b>
        {isDesktop && <span className="muted">· press <kbd>{settings.hotkey}</kbd> to save the last {settings.bufferSeconds} s</span>}
      </div>
      {recording && (
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            onSaving();
            void saveClipNow();
          }}
        >
          Save clip
        </button>
      )}
    </header>
  );
}
