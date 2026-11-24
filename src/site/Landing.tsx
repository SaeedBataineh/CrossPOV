import { useEffect, useState } from "react";
import { Logo } from "../components/Icons";
import "./site.css";

/** A stylised game frame (no real game art): HUD strip, crosshair, a tag. */
function Pane({ who, platform }: { who: "you" | "them"; platform?: string }) {
  return (
    <div className={`pane ${who}`}>
      <div className="pane-hud">
        <span className="mono">7</span>
        <span className="mono timer">1:23</span>
        <span className="mono">5</span>
      </div>
      <svg className="pane-cross" width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <path d="M17 6v8M17 20v8M6 17h8M20 17h8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className={`pane-tag ${who}`}>
        {who === "you" ? "YOUR POV" : "THEIR POV"}
        {platform && <span className="pane-pf"><span className="pf-dot twitch" />{platform}</span>}
      </span>
    </div>
  );
}

/** Public landing page at "/". The interactive demo lives at "/demo". */
/** Plain four-pane window mark (not Microsoft's logo). */
function WindowsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ marginRight: 8 }}>
      <path fill="currentColor" d="M1 2.5 7 1.7V7.5H1zM8 1.6 15 .6V7.5H8zM1 8.5h6v5.8l-6-.8zM8 8.5h7v6.9l-7-1z" />
    </svg>
  );
}

/** The newest release, e.g. { version: "0.1.2", date: "24 Nov 2026" }, from our own server. */
function useLatestVersion() {
  const [latest, setLatest] = useState<{ version: string; date: string } | null>(null);
  useEffect(() => {
    fetch("/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { version?: string; releasedAt?: string } | null) => {
        if (!b?.version) return;
        const d = b.releasedAt ? new Date(b.releasedAt) : null;
        const date = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
        setLatest({ version: b.version, date });
      })
      .catch(() => {});
  }, []);
  return latest;
}

export default function Landing() {
  const latest = useLatestVersion();
  return (
    <div className="site">
      <header className="site-nav">
        <a href="/" className="site-brand"><Logo size={26} /> CrossPOV</a>
        <nav aria-label="Site">
          <a href="#how">How it works</a>
          <a href="#platforms">Platforms</a>
          <a href="#data">Player data</a>
          <a href="/demo">Demo</a>
          <a href="#download" className="site-btn primary">Download</a>
        </nav>
      </header>

      <main>
        <section className="hero2">
          <div className="hero2-copy">
            <p className="site-rec"><span className="rec">REC</span> for VALORANT on Windows</p>
            <h1>
              Every fight.
              <br />
              <span className="tri-text">Both sides.</span>
            </h1>
            <p className="site-lead">
              Save your plays with one hotkey. If a streamer was in your match, CrossPOV finds the moments you fought in
              their VOD and clips them from their point of view, automatically.
            </p>
            <div className="site-actions">
              <a href="/download" className="site-btn primary"><WindowsIcon /> Download for Windows</a>
              <a href="/demo" className="site-btn">Try the demo</a>
            </div>
            <p className="site-fine">
              {latest ? `Version ${latest.version} · ` : ""}Free · Windows 10 and 11 · one file, no setup · updates itself
            </p>
          </div>

          <figure className="duel" aria-label="Illustration: the same fight from your POV and the streamer's POV, synced">
            <div className="duel-panes">
              <Pane who="you" />
              <span className="duel-vs" aria-hidden="true">
                <Logo size={34} />
              </span>
              <Pane who="them" platform="Twitch" />
            </div>
            <div className="duel-timeline" aria-hidden="true">
              <span className="tl-track" />
              <span className="tl-mark" style={{ left: "30%" }} />
              <span className="tl-mark them" style={{ left: "72%" }} />
              <span className="tl-label" style={{ left: "30%" }}>You killed them · R9</span>
              <span className="tl-label them" style={{ left: "72%" }}>They killed you · R14</span>
            </div>
            <figcaption>Illustration. One match, both POVs, lined up by the kill times.</figcaption>
          </figure>
        </section>

        <section id="platforms" className="site-section">
          <h2>Where their side comes from</h2>
          <div className="pf-cards">
            <div className="pf-card twitch">
              <span className="pf-name"><span className="pf-dot twitch" /> Twitch</span>
              <span className="chip twitch">Available</span>
              <p>Public VODs, grabbed right after your match. Sub-only VODs are skipped.</p>
            </div>
            <div className="pf-card youtube">
              <span className="pf-name"><span className="pf-dot youtube" /> YouTube</span>
              <span className="chip">Coming soon</span>
              <p>Streams and uploads from streamers who broadcast on YouTube.</p>
            </div>
            <div className="pf-card kick">
              <span className="pf-name"><span className="pf-dot kick" /> Kick</span>
              <span className="chip">Coming soon</span>
              <p>Public VODs from Kick streamers.</p>
            </div>
          </div>
        </section>

        <section id="how" className="site-section">
          <h2>How it works</h2>
          <ol className="site-steps">
            <li>
              <b>Clip your own plays.</b>
              <span>CrossPOV keeps the last 15–120 seconds while VALORANT is open. Press F9 to save. Encoded on your graphics card; audio can be the game only.</span>
            </li>
            <li>
              <b>After the match, get the timeline.</b>
              <span>Once a match has ended, the CrossPOV server looks up its timeline: players, agents and the time of every kill. Nothing is fetched during a match.</span>
            </li>
            <li>
              <b>Find streamers in the lobby.</b>
              <span>Each player is checked for a channel with their name that was live when the match started. Same-name accounts that weren't live are ignored.</span>
            </li>
            <li>
              <b>Clip their side of your fights.</b>
              <span>Kill times become timestamps in their public VOD, and only those seconds are downloaded.</span>
            </li>
          </ol>
        </section>

        <section id="data" className="site-section">
          <h2>What CrossPOV does and doesn't do</h2>
          <div className="site-grid">
            <div className="site-box">
              <h3>Does</h3>
              <ul>
                <li>Record your own screen, like OBS, and save clips to your PC</li>
                <li>Look up match data <b>after</b> a match has ended</li>
                <li>Use public broadcasts that streamers chose to save</li>
                <li>Keep API keys on the server, never in the app</li>
              </ul>
            </div>
            <div className="site-box">
              <h3>Doesn't</h3>
              <ul>
                <li>Read game memory, inject code or talk to the game client</li>
                <li>Show anything about other players during a match</li>
                <li>Unlock sub-only or deleted VODs</li>
                <li>Upload your clips anywhere: they stay on your PC</li>
              </ul>
            </div>
          </div>
          <p className="muted">Details: <a href="/privacy">privacy policy</a>.</p>
        </section>
        <section id="download" className="site-section site-download" aria-labelledby="download-title">
          <h2 id="download-title">Download CrossPOV</h2>
          <div className="dl-cards">
            <a className="dl-card main" href="/download">
              <span className="dl-name"><WindowsIcon /> CrossPOV.exe</span>
              <span className="dl-desc">One file. Double-click to run, nothing to install. Updates itself.</span>
              <span className="dl-meta mono">
                {latest ? `Version ${latest.version}${latest.date ? ` · released ${latest.date}` : ""} · ` : ""}about 38 MB
              </span>
            </a>
          </div>
          <div className="dl-note">
            <strong>Windows says &ldquo;Windows protected your PC&rdquo;?</strong> Click <b>More info</b>, then <b>Run anyway</b>.
            Windows shows this for new apps it hasn&rsquo;t seen many downloads of yet. CrossPOV never touches the game or
            the Riot client; it only records your screen, like OBS.
          </div>
          <p className="muted small">
            Needs Windows 10 or 11 (64-bit). All versions are on{" "}
            <a href="https://github.com/SaeedBataineh/CrossPOV/releases" target="_blank" rel="noreferrer">GitHub</a>.
          </p>
        </section>
      </main>


      <footer className="site-footer">
        <p className="site-brand small-brand"><Logo size={20} /> CrossPOV</p>
        <p>
          <a href="/download">Download</a> · <a href="/demo">Demo</a> · <a href="/privacy">Privacy</a> · <a href="mailto:contact@crosspov.com">contact@crosspov.com</a>
        </p>
        <p className="muted small">
          CrossPOV isn&rsquo;t endorsed by Riot Games and doesn&rsquo;t reflect the views or opinions of Riot Games or anyone
          officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are
          trademarks or registered trademarks of Riot Games, Inc. Twitch, YouTube and Kick are trademarks of their
          respective owners; CrossPOV is not affiliated with them.
        </p>
      </footer>
    </div>
  );
}
