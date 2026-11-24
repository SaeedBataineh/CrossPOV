import type { Page } from "../components/Sidebar";
import { ClipCard, SampleBanner } from "../components/ui";
import { SAMPLE_CLIPS, SAMPLE_MATCHES, STATUS_LABEL } from "../lib/sample";
import type { Settings } from "../lib/settings";

const RES_LABEL = { native: "Native", "1440p": "1440p", "1080p": "1080p", "720p": "720p" } as const;
const QUALITY_LABEL = { low: "Low", medium: "Medium", high: "High", max: "Max" } as const;

export default function Home({ settings, onNavigate }: { settings: Settings; onNavigate: (p: Page) => void }) {
  const last = SAMPLE_MATCHES[0];
  return (
    <>
      <header className="page-head">
        <div className="stack-6">
          <h1>Home</h1>
          <span className="status-line">
            <span className="dot idle" />
            Waiting for the game · recorder arrives in the next update
          </span>
        </div>
        <button type="button" className="btn primary big" disabled title="Available once the recorder is added">
          Save clip <kbd>{settings.hotkey}</kbd>
        </button>
      </header>

      <SampleBanner>Clips and matches below are sample data until recording and streamer detection are added.</SampleBanner>

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
          <span className="eyebrow">Streamer clips</span>
          <span className="stat-value accent">{settings.streamerAuto ? "On" : "Off"}</span>
          <span className="muted">Automatic after each match</span>
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
          <div className="clip-grid">
            {SAMPLE_CLIPS.slice(0, 4).map((c) => (
              <ClipCard key={c.id} clip={c} />
            ))}
          </div>
        </section>

        <section className="split-side card pad stack-16" aria-labelledby="last">
          <div className="stack-4">
            <h2 id="last">Last match</h2>
            <span className="muted">{last.title} · {last.when}</span>
          </div>
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
