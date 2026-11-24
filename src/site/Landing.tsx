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
export default function Landing() {
  return (
    <div className="site">
      <header className="site-nav">
        <a href="/" className="site-brand"><Logo size={26} /> CrossPOV</a>
        <nav aria-label="Site">
          <a href="#how">How it works</a>
          <a href="#platforms">Platforms</a>
          <a href="#data">Player data</a>
          <a href="/demo" className="site-btn">Try the demo</a>
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
              <a href="/demo" className="site-btn primary">Try the demo</a>
              <a href="#how" className="site-btn">How it works</a>
            </div>
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
      </main>

      <footer className="site-footer">
        <p className="site-brand small-brand"><Logo size={20} /> CrossPOV</p>
        <p>
          <a href="/demo">Demo</a> · <a href="/privacy">Privacy</a> · <a href="mailto:contact@crosspov.com">contact@crosspov.com</a>
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
