import { useState } from "react";
import type { Page } from "../components/Sidebar";
import { cardFromClip, ClipCard, Notice, SampleBanner } from "../components/ui";
import { isDesktop, saveClipNow, type RecorderStatus } from "../lib/backend";
import { SAMPLE_MATCHES, STATUS_LABEL } from "../lib/sample";
import type { Settings } from "../lib/settings";
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
  onNavigate,
}: {
  settings: Settings;
  recorder: ReturnType<typeof useRecorder>;
  onNavigate: (p: Page) => void;
}) {
  const { status, clips, notify } = recorder;
  const [saving, setSaving] = useState(false);
  const last = SAMPLE_MATCHES[0];
  const recording = status?.state === "recording";
  const recent = clips.slice(0, 4).map(cardFromClip);

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
      <header className="page-head">
        <div className="stack-6">
          <h1>Home</h1>
          <StatusLine status={status} bufferSeconds={settings.bufferSeconds} />
        </div>
        <button type="button" className="btn primary big" disabled={!recording || saving} onClick={() => void save()}
          title={recording ? undefined : "Clips can be saved while VALORANT is open"}>
          Save clip <kbd>{settings.hotkey}</kbd>
        </button>
      </header>

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
          <div className="stack-4">
            <h2 id="last">Last match</h2>
            <span className="muted">{last.title} · {last.when}</span>
          </div>
          <SampleBanner>Sample data. Streamer detection arrives in step 4.</SampleBanner>
          <ul className="plain">
            {last.players.filter((p) => p.channel).map((p) => (
              <li key={p.name} className="mini-player">
                <strong>{p.name}</strong>
                <span className={`status-text ${p.status}`}>
                  {p.clips ? `${p.clips} clips` : STATUS_LABEL[p.status]}
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="link" onClick={() => onNavigate("streamers")}>See match details</button>
        </section>
      </div>
    </>
  );
}
