import type { ReactNode } from "react";
import { isDesktop, saveClipNow, type RecorderStatus, type UpdateStatus } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { ClipsIcon, GearIcon, Logo, MatchesIcon, StreamIcon } from "./Icons";

export type Page = "clips" | "matches" | "streamers" | "settings";

const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: "clips", label: "Clips", icon: <ClipsIcon size={20} /> },
  { id: "matches", label: "Matches", icon: <MatchesIcon size={20} /> },
  { id: "streamers", label: "Streamers", icon: <StreamIcon size={20} /> },
];

function NavItem({ page, id, label, icon, onNavigate }: { page: Page; id: Page; label: string; icon: ReactNode; onNavigate: (p: Page) => void }) {
  return (
    <button type="button" className="nav-item" aria-current={page === id ? "page" : undefined} onClick={() => onNavigate(id)}>
      {icon}
      {label}
    </button>
  );
}

/** Everything lives in the left sidebar: the pages, the recorder, Settings. */
export function Sidebar({
  page,
  settings,
  status,
  onNavigate,
  onSaving,
  update,
}: {
  page: Page;
  update: UpdateStatus | null;
  settings: Settings;
  status: RecorderStatus | null;
  onNavigate: (p: Page) => void;
  onSaving: () => void;
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
    <aside className="sidebar">
      <div className="brand">
        <Logo size={24} />
        CrossPOV
      </div>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <NavItem key={n.id} page={page} {...n} onNavigate={onNavigate} />
        ))}
      </nav>
      <span className="spacer" />
      {update?.state === "waiting" && (
        <p className="side-note" title="CrossPOV updates itself as soon as VALORANT is closed">Update v{update.version} installs after this game</p>
      )}
      <div className="rec-card" title={status?.message ?? undefined}>
        <span className="row" style={{ gap: 8 }}>
          <span className={`dot ${recording ? "rec" : bad ? "bad" : "idle"}`} aria-hidden="true" />
          <b>{line}</b>
        </span>
        {recording ? (
          <button
            type="button"
            className="btn quiet sm-btn"
            title={`Save the last ${settings.bufferSeconds} s`}
            onClick={() => {
              onSaving();
              void saveClipNow();
            }}
          >
            Save clip · {settings.hotkey}
          </button>
        ) : (
          isDesktop && <span className="muted small">{settings.hotkey} saves a clip in game</span>
        )}
      </div>
      <NavItem page={page} id="settings" label="Settings" icon={<GearIcon size={20} />} onNavigate={onNavigate} />
      {!isDesktop && <a className="nav-item" href="/">About CrossPOV</a>}
    </aside>
  );
}
