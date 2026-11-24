import { useState } from "react";
import type { Page } from "../components/Sidebar";
import { cardFromClip, ClipCard, Notice } from "../components/ui";
import { findMe, isDesktop, saveClipNow, type MatchSummary, type RecorderStatus } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { matchTimeAgo, scoreLine } from "../lib/useMatches";
import type { useRecorder } from "../lib/useRecorder";

/** 60 -> "01:00", like a recorder's display. */
const clock = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

/** "1080p60", or "Native 60" at native resolution. */
const videoLabel = (s: Settings) => (s.resolution === "native" ? `Native ${s.fps}` : `${s.resolution}${s.fps}`);

function audioSummary(s: Settings): string {
  if (!s.gameAudio && !s.apps.some((a) => a.enabled)) return "Game muted";
  if (s.audioMode === "desktop") return "Everything";
  const apps = s.apps.filter((a) => a.enabled).map((a) => a.exe.replace(/\.exe$/i, ""));
  return [s.gameAudio ? "Game" : null, ...apps].filter(Boolean).join(", ");
}
const QUALITY_LABEL = { low: "Low", medium: "Medium", high: "High", max: "Max" } as const;

function StatusLine({ status, bufferSeconds }: { status: RecorderStatus | null; bufferSeconds: number }) {
  switch (status?.state) {
    case "recording":
      return (
        <span className="status-line">
          <span className="rec">REC</span>
          VALORANT · buffer {bufferSeconds}s{status.encoder ? ` · ${status.encoder}` : ""}
        </span>
      );
    case "waiting":
      return (
        <span className="status-line">
          <span className="dot" />
          {isDesktop ? "Waiting for VALORANT" : "Website demo · recording needs the desktop app"}
        </span>
      );
    case "noFfmpeg":
    case "error":
      return (
        <span className="status-line">
          <span className="dot bad" />
          {status.message ?? "The recorder stopped"}
        </span>
      );
    default:
      return (
        <span className="status-line">
          <span className="dot" />
          Getting ready…
        </span>
      );
  }
}

export default function Home({
  settings,
  recorder,
  matches,
  onNavigate,
}: {
  settings: Settings;
  recorder: ReturnType<typeof useRecorder>;
  matches: MatchSummary[];
  onNavigate: (p: Page) => void;
}) {
  const { status, clips, notify } = recorder;
  const [saving, setSaving] = useState(false);
  const last = matches[0];
  const me = last ? findMe(last, settings.riotId) : undefined;
  const recording = status?.state === "recording";
  const recent = clips.slice(0, 3).map(cardFromClip);

  async function save() {
    setSaving(true);
    notify("Saving clip…", "info");
    try {
      await saveClipNow();
    } finally {
      setTimeout(() => setSaving(false), 2500);
    }
  }

  return (
    <>
      <h1>Home</h1>

      <section className={recording ? "hero-status" : "hero-status idle"} aria-label="Recorder">
        <div className="stack-6">
          <h2>{recording ? "Recording" : status?.state === "error" || status?.state === "noFfmpeg" ? "Recorder stopped" : "Ready"}</h2>
          <StatusLine status={status} bufferSeconds={settings.bufferSeconds} />
        </div>
        <button type="button" className="btn primary big" disabled={!recording || saving} onClick={() => void save()}
          title={recording ? undefined : "Clips can be saved while VALORANT is open"}>
          Save clip <kbd>{settings.hotkey}</kbd>
        </button>
        <div className="meter" aria-hidden="true">
          <div className={recording ? "meter-bar live" : "meter-bar"}>
            {Array.from({ length: Math.min(60, Math.ceil(settings.bufferSeconds / 2)) }, (_, i) => (
              <span key={i} />
            ))}
          </div>
          <div className="meter-legend">
            <span>−{settings.bufferSeconds}s</span>
            <span>{recording ? "replay buffer · always the latest" : "replay buffer · fills when the game opens"}</span>
            <span>now</span>
          </div>
        </div>
      </section>

      {status?.hotkeyError && <Notice tone="warn">{status.hotkeyError}</Notice>}
      {status?.audioWarning && <Notice tone="warn">{status.audioWarning}</Notice>}

      <section className="stat-grid" aria-label="Recorder settings">
        <div className="stat">
          <span className="eyebrow">Replay buffer</span>
          <span className="stat-value">{clock(settings.bufferSeconds)}</span>
        </div>
        <div className="stat">
          <span className="eyebrow">Video</span>
          <span className="stat-value">{videoLabel(settings)}</span>
          <span className="stat-sub">{QUALITY_LABEL[settings.quality]} quality</span>
        </div>
        <div className="stat">
          <span className="eyebrow">Audio</span>
          <span className="stat-value">{audioSummary(settings)}</span>
          <span className="stat-sub">{settings.microphone ? "Mic on" : "Mic off"}</span>
        </div>
        <div className="stat">
          <span className="eyebrow">Storage limit</span>
          <span className="stat-value">{settings.storageLimitGb ? `${settings.storageLimitGb} GB` : "None"}</span>
          <span className="stat-sub">{settings.pruneOldest ? "Oldest clips go first" : "Never deletes clips"}</span>
        </div>
      </section>

      <div className="split">
        <section className="split-main stack-16" aria-labelledby="recent">
          <div className="row-between">
            <h2 id="recent">Recent clips</h2>
            <button type="button" className="link" onClick={() => onNavigate("clips")}>View all</button>
          </div>
          {recent.length ? (
            <div className="clip-grid">
              {recent.map((c) => (
                <ClipCard key={c.key} clip={c} />
              ))}
            </div>
          ) : (
            <div className="card pad empty">
              <strong>No clips yet</strong>
              <span className="muted">
                Open VALORANT and press <kbd className="inline-key">{settings.hotkey}</kbd> after a good play. The last {settings.bufferSeconds} seconds are saved.
              </span>
            </div>
          )}
        </section>

        <section className="split-side card pad stack-16" aria-labelledby="last">
          <h2 id="last">Last match</h2>
          {last ? (
            <>
              <div className="stack-4">
                <strong>{last.map} · {scoreLine(last, me?.team)}</strong>
                <span className="muted small mono">{last.mode}{me ? ` · ${me.agent} · ${me.kills}/${me.deaths}/${me.assists}` : ""} · {matchTimeAgo(last.startedAt)}</span>
              </div>
              <span className="muted small">Streamer check for this lobby arrives in the next update.</span>
            </>
          ) : (
            <span className="muted">
              {settings.riotId ? "Your matches show up here after you play." : "Add your Riot ID in Settings to see your matches here."}
            </span>
          )}
          <button type="button" className="link" style={{ alignSelf: "flex-start" }} onClick={() => onNavigate(settings.riotId ? "streamers" : "settings")}>
            {settings.riotId ? "Match details" : "Open Settings"}
          </button>
        </section>
      </div>
    </>
  );
}
