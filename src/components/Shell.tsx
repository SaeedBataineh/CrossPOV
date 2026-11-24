import { useEffect, useState, type ReactNode } from "react";
import { isDesktop, saveClipNow, type RecorderStatus, type UpdateStatus } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { AudioIcon, ClipsIcon, GearIcon, HomeIcon, Logo, MatchesIcon, SearchIcon, StreamIcon } from "./Icons";

export type Page = "home" | "clips" | "matches" | "streamers" | "audio" | "settings";

const ITEMS: { id: Page; label: string; icon: ReactNode }[] = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "clips", label: "Clips", icon: <ClipsIcon /> },
  { id: "matches", label: "Matches", icon: <MatchesIcon /> },
  { id: "streamers", label: "Streamers", icon: <StreamIcon /> },
  { id: "audio", label: "Audio", icon: <AudioIcon /> },
  { id: "settings", label: "Settings", icon: <GearIcon /> },
];

const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");

/** "REC 00:47:12" while recording; counts from when this window saw recording start. */
function RecPill({ status }: { status: RecorderStatus | null }) {
  const recording = status?.state === "recording";
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => setSince(recording ? Date.now() : null), [recording]);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  if (recording) return <span className="pill rec" title={status?.encoder ? `Encoder: ${status.encoder}` : undefined}>REC {hms(since ? Math.floor((Date.now() - since) / 1000) : 0)}</span>;
  const text =
    status?.state === "error" || status?.state === "noFfmpeg" ? "Recorder stopped"
    : !isDesktop ? "Website demo"
    : status?.state === "waiting" ? "Waiting for VALORANT"
    : "Starting…";
  const bad = status?.state === "error" || status?.state === "noFfmpeg";
  return <span className={bad ? "pill warn" : "pill idle"} title={status?.message ?? undefined}>{text}</span>;
}

function initials(riotId: string): string {
  const name = riotId.split("#")[0].trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase() || "?";
}

export function TopBar({
  settings,
  status,
  query,
  onQuery,
  onNavigate,
  onSaving,
  update,
}: {
  update: UpdateStatus | null;
  settings: Settings;
  status: RecorderStatus | null;
  query: string;
  onQuery: (q: string) => void;
  onNavigate: (p: Page) => void;
  onSaving: () => void;
}) {
  const recording = status?.state === "recording";
  return (
    <header className="topbar">
      <div className="brand">
        <Logo size={24} />
        CrossPOV <small>v{__APP_VERSION__}</small>
      </div>
      <label className="search">
        <SearchIcon size={14} />
        <span className="sr-only">Search clips</span>
        <input
          type="search"
          placeholder="Search clips, streamers, maps…"
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            onNavigate("clips");
          }}
        />
      </label>
      <span className="spacer" />
      {update?.state === "waiting" && (
        <span className="pill purple" title="CrossPOV updates itself as soon as VALORANT is closed">Update v{update.version} · after this game</span>
      )}
      <RecPill status={status} />
      <button
        type="button"
        className="pill"
        disabled={!recording}
        title={recording ? `Save the last ${settings.bufferSeconds} s` : "Clips can be saved while VALORANT is open"}
        onClick={() => {
          onSaving();
          void saveClipNow();
        }}
      >
        Save <b>{settings.hotkey}</b>
      </button>
      <button type="button" className="account" onClick={() => onNavigate("settings")} title="Account settings">
        <span className="av" aria-hidden="true">{settings.riotId ? initials(settings.riotId) : "?"}</span>
        <span>
          <b>{settings.riotId || "Add your Riot ID"}</b>
          <span>{settings.riotId ? `${settings.region.toUpperCase()} · matches on` : "needed for streamer clips"}</span>
        </span>
      </button>
    </header>
  );
}

export function Rail({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  return (
    <nav className="rail" aria-label="Main">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.id === "settings" ? "last" : undefined}
          aria-current={page === item.id ? "page" : undefined}
          onClick={() => onNavigate(item.id)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
      {!isDesktop && <a className="rail-foot" href="/">About</a>}
    </nav>
  );
}
