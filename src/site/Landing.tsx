import { useEffect, useState } from "react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./studio.css";

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

type Platform = "twitch" | "youtube" | "kick";

/** The platforms' own marks, used only to say where streamer clips come from. */
export function PlatformLogo({ name, size = 22 }: { name: Platform; size?: number }) {
  const label = { twitch: "Twitch", youtube: "YouTube", kick: "Kick" }[name];
  if (name === "twitch") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
        <path fill="#9146ff" d="M2.15 0 .58 4.1v16.8h5.71V24h3.22l3.04-3.1h4.6l6.25-6.2V0zm19.33 13.6-3.58 3.6h-5.71l-3.04 3.1v-3.1H4.32V2.1h17.16z" />
        <path fill="#9146ff" d="M17.9 6.2v6.2h-2.14V6.2zm-5.72 0v6.2h-2.15V6.2z" />
      </svg>
    );
  }
  if (name === "youtube") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
        <path fill="#ff0033" d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81" />
        <path fill="#fff" d="M9.55 15.57V8.43L15.82 12z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <rect width="24" height="24" rx="5" fill="#53fc18" />
      <path fill="#0b0b0f" d="M5 4h4.5v4.2h1.5V6.1h1.6V4H17v5h-1.6v1.6h-1.5v2.8h1.5V15H17v5h-4.4v-2.1H11v-2.1H9.5V20H5z" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" fill="none" stroke="#5fd08a" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const SCREENS = [
  { label: "Clips", body: "Yours and theirs side by side, playable right in the app." },
  { label: "Matches", body: "Every match with its score, who you played and which streamers were in it." },
  { label: "Streamers", body: "Each streamer you fought, and how their clips are coming along." },
];

/** The three app screens, switching on their own until someone picks one. */
function Screens() {
  const [tab, setTab] = useState(0);
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (!auto || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setTab((n) => (n + 1) % SCREENS.length), 4500);
    return () => clearInterval(t);
  }, [auto]);
  return (
    <section id="features" className="st-section">
      <h2 className="st-h2">Three screens. Nothing else.</h2>
      <div role="tablist" aria-label="App screens" className="st-tabs">
        {SCREENS.map((s, i) => (
          <button
            key={s.label}
            type="button"
            role="tab"
            id={`st-tab-${i}`}
            aria-selected={i === tab}
            aria-controls="st-screen"
            className={i === tab ? "on" : ""}
            onClick={() => {
              setAuto(false);
              setTab(i);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="st-screen-row">
        <div className="st-screen" id="st-screen" role="tabpanel" aria-labelledby={`st-tab-${tab}`}>
          <div className="st-screen-nav" aria-hidden="true">
            {SCREENS.map((s, i) => <span key={s.label} className={i === tab ? "on" : ""} />)}
          </div>
          <div key={tab} className={`st-screen-body st-fade s${tab}`} aria-hidden="true">
            {tab === 0 && Array.from({ length: 6 }, (_, i) => <span key={i} className={i % 2 ? "alt" : ""} />)}
            {tab === 1 && ["win", "loss", "win"].map((r, i) => <span key={i} className={r} />)}
            {tab === 2 && Array.from({ length: 4 }, (_, i) => <span key={i} className={i === 1 ? "hl" : ""} />)}
          </div>
        </div>
        <div className="st-screen-text">
          <h3>{SCREENS[tab].label}</h3>
          <p>{SCREENS[tab].body}</p>
        </div>
      </div>
    </section>
  );
}

/** Public landing page at "/". The interactive demo lives at "/demo". */
export default function Landing() {
  const latest = useLatestVersion();
  return (
    <div className="st">
      <header className="st-nav">
        <a href="/" className="st-brand">
          <span className="st-mark" aria-hidden="true"><span /></span>
          CrossPOV
        </a>
        <nav aria-label="Site">
          <a href="#features">Features</a>
          <a href="#platforms">Platforms</a>
          <a href="/demo">Demo</a>
          <a href="#download" className="st-nav-cta">Download</a>
        </nav>
      </header>

      <main>
        <section className="st-hero">
          <div className="st-hero-copy">
            <p className="st-eyebrow st-rise"><span className="st-dot" /> For VALORANT on Windows</p>
            <h1 className="st-rise2">
              Your match ends.
              <br />
              Their clips{" "}
              <span className="st-sr">arrive.</span>
              <span className="st-cycle" aria-hidden="true">
                <span>
                  <span>arrive.</span>
                  <span>line up.</span>
                  <span>download.</span>
                  <span>arrive.</span>
                </span>
              </span>
            </h1>
            <p className="st-lead st-rise3">
              Save your plays with one hotkey. If a streamer was in your match, CrossPOV finds the moments you fought in
              their VOD and clips them from their point of view, automatically.
            </p>
            <div className="st-actions">
              <a href="/download" className="st-btn primary">Download for Windows</a>
              <a href="/demo" className="st-btn">Open the live demo</a>
            </div>
            <p className="st-fine">
              {latest ? `Version ${latest.version} · ` : ""}Free · Windows 10 and 11 · one file · updates itself
            </p>
            <div className="st-works">
              <span>Their side from</span>
              <PlatformLogo name="twitch" size={20} />
              <PlatformLogo name="youtube" size={20} />
              <PlatformLogo name="kick" size={20} />
            </div>
          </div>

          <figure className="st-card" aria-label="Animation: a finished match finds a streamer and their clips arrive">
            <div className="st-in1 st-card-head">
              <span>Ascent · 13–9</span>
              <span className="st-win">WIN · just now</span>
            </div>
            <div className="st-in2 st-avatars" aria-hidden="true">
              {Array.from({ length: 5 }, (_, i) => <span key={`a${i}`} />)}
              <span className="st-split" />
              {Array.from({ length: 5 }, (_, i) => <span key={`b${i}`} className={i === 1 ? "them hl" : "them"} />)}
            </div>
            <div className="st-in3 st-streamer">
              <div className="st-streamer-row">
                <span className="st-who">
                  <PlatformLogo name="twitch" size={16} />
                  streamer_one <span className="st-dim">· Enemy · Jett</span>
                </span>
                <span className="st-state">
                  <span className="st-before">lining up VOD</span>
                  <span className="st-after">3 clips saved</span>
                </span>
              </div>
              <div className="st-bar"><div className="st-fill" /></div>
            </div>
            <div className="st-thumbs" aria-hidden="true">
              <div className="st-drop1"><span>R4</span></div>
              <div className="st-drop2"><span>R9</span></div>
              <div className="st-drop3"><span>R14</span></div>
            </div>
            <figcaption>Illustration. Names and clips are examples.</figcaption>
          </figure>
        </section>

        <Screens />

        <section className="st-section st-facts">
          <div className="st-rise"><b>F9</b><span>One key saves your play</span></div>
          <div className="st-rise2"><b>15–120 s</b><span>How far back it keeps</span></div>
          <div className="st-rise3"><b>No setup</b><span>One file, updates itself</span></div>
        </section>

        <section id="platforms" className="st-section st-two">
          <div className="st-panel">
            <h2>Where their side comes from</h2>
            <div className="st-pf">
              <span className="st-pf-name"><PlatformLogo name="twitch" /> Twitch</span>
              <span className="st-good">Available</span>
            </div>
            <p className="st-pf-note">Public VODs, grabbed right after your match. Sub-only VODs are skipped.</p>
            <div className="st-pf">
              <span className="st-pf-name"><PlatformLogo name="youtube" /> YouTube</span>
              <span className="st-dim">Coming soon</span>
            </div>
            <div className="st-pf">
              <span className="st-pf-name"><PlatformLogo name="kick" /> Kick</span>
              <span className="st-dim">Coming soon</span>
            </div>
          </div>
          <div className="st-panel">
            <h2>Fair play</h2>
            <p className="st-check"><Check />Never reads game memory, injects code or talks to the game</p>
            <p className="st-check"><Check />Shows nothing about other players during a match</p>
            <p className="st-check"><Check />Only public VODs streamers chose to save; no sub-only or deleted ones</p>
            <p className="st-check"><Check />Clips stay on your PC; API keys stay on the server</p>
            <p className="st-dim st-small">Details: <a href="/privacy">privacy policy</a>.</p>
          </div>
        </section>

        <section id="download" className="st-section">
          <div className="st-cta">
            <div>
              <h2>Ready for your next match?</h2>
              <p>
                CrossPOV.exe · one file, nothing to install
                {latest ? ` · version ${latest.version}${latest.date ? `, ${latest.date}` : ""}` : ""}
              </p>
            </div>
            <a href="/download" className="st-btn dark">Download for Windows</a>
          </div>
          <p className="st-note">
            <strong>Windows says &ldquo;Windows protected your PC&rdquo;?</strong> Click <b>More info</b>, then{" "}
            <b>Run anyway</b>. Windows shows this for new apps it hasn&rsquo;t seen many downloads of yet. CrossPOV never
            touches the game or the Riot client; it only records your screen, like OBS. Needs Windows 10 or 11 (64-bit).
          </p>
        </section>
      </main>

      <footer className="st-footer">
        <p>
          <a href="/download">Download</a> · <a href="/demo">Demo</a> · <a href="/privacy">Privacy</a> ·{" "}
          <a href="mailto:contact@crosspov.com">contact@crosspov.com</a>
        </p>
        <p className="st-legal">
          CrossPOV isn&rsquo;t endorsed by Riot Games and doesn&rsquo;t reflect the views or opinions of Riot Games or anyone
          officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are
          trademarks or registered trademarks of Riot Games, Inc. Twitch, YouTube and Kick are trademarks of their respective
          owners; CrossPOV is not affiliated with them.
        </p>
      </footer>
    </div>
  );
}
