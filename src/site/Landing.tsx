import { Logo } from "../components/Icons";
import "./site.css";

/** Public landing page at "/". The interactive demo lives at "/demo". */
export default function Landing() {
  return (
    <div className="site">
      <header className="site-nav">
        <a href="/" className="site-brand"><Logo size={22} /> CrossPOV</a>
        <nav aria-label="Site">
          <a href="#how">How it works</a>
          <a href="#data">Player data</a>
          <a href="/demo" className="site-btn">Try the demo</a>
        </nav>
      </header>

      <main>
        <section className="site-hero">
          <p className="site-rec"><span className="rec">REC</span> for VALORANT on Windows</p>
          <h1>See your fights from the other side.</h1>
          <p className="site-lead">
            CrossPOV saves your best plays with one hotkey. If a streamer was in your match, it finds the moments you fought
            in their public Twitch VOD and clips them from their point of view, automatically.
          </p>
          <div className="site-actions">
            <a href="/demo" className="site-btn primary">Try the demo</a>
            <a href="#how" className="site-btn">How it works</a>
          </div>
        </section>

        <section className="site-figure" aria-label="Example of a CrossPOV match">
          <div className="mock-head">
            <strong>Ascent · Competitive</strong>
            <span className="mono">13–9 Win · 12 min ago</span>
          </div>
          <div className="mock-row"><span>You</span><span>Jett</span><span className="mono">24 / 15 / 4</span><span className="muted">—</span></div>
          <div className="mock-row"><span>example_streamer</span><span>Omen</span><span className="mono">17 / 18 / 6</span><span className="good">VOD found · 3 fights clipped</span></div>
          <div className="mock-row"><span>another_player</span><span>Sage</span><span className="mono">11 / 16 / 9</span><span className="muted">Not streaming</span></div>
          <div className="mock-clips">
            <div className="mock-clip"><span className="tag them">THEM</span><span className="mono">0:20</span><b>They killed you · round 9</b></div>
            <div className="mock-clip"><span className="tag them">THEM</span><span className="mono">0:20</span><b>You killed them · round 17</b></div>
            <div className="mock-clip"><span className="tag you">YOU</span><span className="mono">0:45</span><b>Round 14 clutch</b></div>
          </div>
          <p className="site-caption">Illustration. Names are examples.</p>
        </section>

        <section id="how" className="site-section">
          <h2>How it works</h2>
          <ol className="site-steps">
            <li>
              <b>Clip your own plays.</b>
              <span>CrossPOV keeps the last 15–120 seconds of your screen while VALORANT is open. Press F9 to save them. Video is encoded on your graphics card, and audio can be limited to the game only.</span>
            </li>
            <li>
              <b>After the match, get the timeline.</b>
              <span>Once a match has ended, the CrossPOV server looks up its timeline: players, agents and the time of every kill. Nothing is fetched during a match.</span>
            </li>
            <li>
              <b>Find streamers in the lobby.</b>
              <span>For each player, CrossPOV checks for a Twitch channel with their name that was broadcasting when the match started. Same-name accounts that weren't live at that moment are ignored.</span>
            </li>
            <li>
              <b>Clip their side of your fights.</b>
              <span>The kill times become timestamps in their public VOD, and only those few seconds are downloaded. Sub-only VODs are skipped.</span>
            </li>
          </ol>
        </section>

        <section id="data" className="site-section">
          <h2>What CrossPOV does and doesn't do</h2>
          <div className="site-grid">
            <div>
              <h3>Does</h3>
              <ul>
                <li>Record your own screen, like OBS, and save clips to your PC</li>
                <li>Look up match data <b>after</b> a match has ended</li>
                <li>Use public Twitch broadcasts that streamers chose to save</li>
                <li>Keep API keys on the server, never in the app</li>
              </ul>
            </div>
            <div>
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
        <p>
          <a href="/demo">Demo</a> · <a href="/privacy">Privacy</a>
        </p>
        <p className="muted small">
          CrossPOV isn&rsquo;t endorsed by Riot Games and doesn&rsquo;t reflect the views or opinions of Riot Games or anyone
          officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are
          trademarks or registered trademarks of Riot Games, Inc. Twitch is a trademark of Twitch Interactive, Inc.
        </p>
      </footer>
    </div>
  );
}
