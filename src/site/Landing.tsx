import { useEffect, useState } from "react";
import "@fontsource-variable/figtree";
import "./clean.css";

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

function WindowsMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M1 3l7-1v6.5H1zM9 1.9l8-1.2v7.8H9zM1 9.5h7V16l-7-1zM9 9.5h8v7.8l-8-1.2z" fill="currentColor" />
    </svg>
  );
}

/** Public landing page at "/". The interactive demo lives at "/demo". */
export default function Landing() {
  const latest = useLatestVersion();
  return (
    <div className="cl">
      <main className="cl-main">
        <header className="cl-nav">
          <a href="/" className="cl-brand">
            <img src="/favicon.svg" alt="" width="22" height="22" />
            CrossPOV
          </a>
          <nav aria-label="Site">
            <a href="/demo" className="cl-hide">Demo</a>
            <a href="/privacy" className="cl-hide">Privacy</a>
            <a href="/download" className="cl-btn cl-btn-primary cl-btn-sm">Download</a>
          </nav>
        </header>

        <section className="cl-hero">
          <h1 className="cl-rise">Your play, and the streamer&rsquo;s view of it.</h1>
          <p className="cl-lead cl-rise d2">
            Press F9 in VALORANT to save a clip. After the match, CrossPOV gets the same fight from anyone who was live.
          </p>
          <div className="cl-actions cl-rise d3">
            <a href="/download" className="cl-btn cl-btn-primary">
              <WindowsMark />
              Download for Windows
            </a>
            <a href="/demo" className="cl-btn cl-btn-ghost">Try the demo</a>
          </div>
          <p className="cl-fine cl-rise d3">
            Free{latest ? ` · v${latest.version}` : ""} · Windows 10 and 11
          </p>
          <ul className="cl-works cl-rise d3" aria-label="Where streamer clips come from">
            <li><PlatformLogo name="twitch" size={16} />Twitch</li>
            <li><PlatformLogo name="youtube" size={16} />YouTube soon</li>
            <li><PlatformLogo name="kick" size={16} />Kick soon</li>
            <li className="cl-sep" aria-hidden="true">|</li>
            <li>Never touches the game</li>
          </ul>
          <div className="cl-shot cl-rise d3">
            <img
              src="/app-matches.jpg"
              alt="The CrossPOV app: your matches, with clips from the streamers you played against"
              width="2720"
              height="1640"
            />
          </div>
        </section>
      </main>

      <footer className="cl-footer">
        <div className="cl-footer-in">
          <p>
            Windows says &ldquo;Windows protected your PC&rdquo;? Click <b>More info</b>, then <b>Run anyway</b>. It shows
            this for new apps. CrossPOV only records your screen, like OBS.
          </p>
          <p>
            <a href="/download">Download</a> · <a href="/demo">Demo</a> · <a href="/privacy">Privacy</a> ·{" "}
            <a href="mailto:contact@crosspov.com">contact@crosspov.com</a>
          </p>
          <p className="cl-legal">
            CrossPOV isn&rsquo;t endorsed by Riot Games and doesn&rsquo;t reflect the views or opinions of Riot Games or anyone
            officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are
            trademarks or registered trademarks of Riot Games, Inc. Twitch, YouTube and Kick are trademarks of their respective
            owners; CrossPOV is not affiliated with them.
          </p>
        </div>
      </footer>
    </div>
  );
}
