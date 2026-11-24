import { useState } from "react";
import type { Page } from "../components/Sidebar";
import { cardFromClip, ClipCard, Notice, SampleBanner } from "../components/ui";
import { isDesktop, saveClipNow, type RecorderStatus } from "../lib/backend";
import { SAMPLE_MATCHES, STATUS_LABEL } from "../lib/sample";
import type { Settings } from "../lib/settings";
import type { useRecorder } from "../lib/useRecorder";

const RES_LABEL = { native: "Native", "1440p": "1440p", "1080p": "1080p", "720p": "720p" } as const;
const QUALITY_LABEL = { low: "Low", medium: "Medium", high: "High", max: "Max" } as const;

function statusLine(s: RecorderStatus | null, bufferSeconds: number): { text: string; dot: string } {
  switch (s?.state) {
    case "recording":
      return { text: `Recording · last ${bufferSeconds} s ready to save · ${s.encoder ?? ""}`, dot: "live" };
    case "waiting":
      return { text: isDesktop ? "Waiting for VALORANT to open" : "Website demo · recording needs the desktop app", dot: "idle" };
    case "noFfmpeg":
    case "error":
      return { text: s.message ?? "The recorder stopped", dot: "bad" };
    default:
      return { text: "Getting the recorder ready…", dot: "idle" };
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
  const line = statusLine(status, settings.bufferSeconds);
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
          <span className="status-line">
            <span className={`dot ${line.dot}`} />
            {line.text}
          </span>
        </div>
        <button type="button" className="btn primary big" disabled={!recording || saving} onClick={() => void save()}
          title={recording ? undefined : "Clips can be saved while VALORANT is open"}>
          Save clip <kbd>{settings.hotkey}</kbd>
        </button>
      </header>

      {status?.hotkeyError && <Notice tone="warn">{status.hotkeyError}</Notice>}
      {status?.audioWarning && <Notice tone="warn">{status.audioWarning}</Notice>}

      <section className="stat-grid" aria-label="Status">
        <div className="card stat">
          <span className="eyebrow">Replay buffer</span>
          <span className="stat-value">Last {settings.bufferSeconds} s</span>
          <span className="muted">
            {RES_LABEL[settings.resolution]} · {settings.fps} fps · {QUALITY_LABEL[settings.quality]}
          </span>
        </div>
        <div className="card stat">
          <span className="eyebrow">Clip hotkey</span>
          <span className="stat-value">{settings.hotkey}</span>
          <span className="muted">Press after a play to save it</span>
        </div>
        <div className="card stat">
          <span className="eyebrow">Audio in clips</span>
          <span className="stat-value">
            {settings.audioMode === "desktop" ? "Everything" : `Game${settings.apps.some((a) => a.enabled) ? " + apps" : " only"}`}
          </span>
          <span className="muted">{settings.microphone ? "Mic on" : "Mic off"}</span>
        </div>
        <div className="card stat">
          <span className="eyebrow">Storage limit</span>
          <span className="stat-value">{settings.storageLimitGb ? `${settings.storageLimitGb} GB` : "None"}</span>
          <span className="muted">{settings.pruneOldest ? "Oldest clips removed when full" : "Never deletes clips"}</span>
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
          <ul className="plain stack-10">
            {last.players.filter((p) => p.channel).map((p) => (
              <li key={p.name} className="mini-player">
                <span className={`avatar ${p.status}`}>{p.name.slice(0, 2).toUpperCase()}</span>
                <span className="stack-2">
                  <strong>{p.name}</strong>
                  <span className={`status-text ${p.status}`}>
                    {STATUS_LABEL[p.status]}{p.clips ? ` · ${p.clips} clips` : ""}
                  </span>
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
