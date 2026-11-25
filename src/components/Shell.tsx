import { isDesktop, saveClipNow, type RecorderStatus, type UpdateStatus } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { GearIcon, Logo } from "./Icons";

export type Page = "clips" | "matches" | "streamers" | "settings";

const TABS: { id: Page; label: string }[] = [
  { id: "clips", label: "Clips" },
  { id: "matches", label: "Matches" },
  { id: "streamers", label: "Streamers" },
];

/** One quiet line: what the recorder is doing. */
function RecStatus({ status, hotkey }: { status: RecorderStatus | null; hotkey: string }) {
  const state = status?.state;
  const bad = state === "error" || state === "noFfmpeg";
  const text = !isDesktop
    ? "Website demo"
    : state === "recording" ? `Recording · ${hotkey} to save`
    : bad ? "Recorder stopped"
    : state === "waiting" ? "Waiting for VALORANT"
    : "Starting…";
  const dot = state === "recording" ? "rec" : bad ? "bad" : "idle";
  return (
    <span className="rec-status" title={status?.message ?? undefined}>
      <span className={`dot ${dot}`} aria-hidden="true" />
      {text}
    </span>
  );
}

export function TopBar({
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
  const recording = status?.state === "recording";
  return (
    <header className="topbar">
      <div className="brand">
        <Logo size={22} />
        CrossPOV
      </div>
      <nav className="tabs" aria-label="Main">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-current={page === t.id ? "page" : undefined} onClick={() => onNavigate(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <span className="spacer" />
      {update?.state === "waiting" && (
        <span className="soft-pill" title="CrossPOV updates itself as soon as VALORANT is closed">Update v{update.version} after this game</span>
      )}
      <RecStatus status={status} hotkey={settings.hotkey} />
      {recording && (
        <button
          type="button"
          className="btn quiet"
          title={`Save the last ${settings.bufferSeconds} s`}
          onClick={() => {
            onSaving();
            void saveClipNow();
          }}
        >
          Save clip
        </button>
      )}
      <button type="button" className="icon-btn" aria-label="Settings" aria-current={page === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}>
        <GearIcon size={20} />
      </button>
      {!isDesktop && <a className="about-link" href="/">About</a>}
    </header>
  );
}
