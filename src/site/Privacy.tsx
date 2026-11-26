import { Logo } from "../components/Icons";
import "@fontsource-variable/figtree";
import "../styles.css";
import "./site.css";

/** Where people can reach the developer. Shown on the page only when set. */
const CONTACT = "contact@crosspov.com";
const UPDATED = "25 November 2026";

export default function Privacy() {
  return (
    <div className="site">
      <header className="site-nav">
        <a href="/" className="site-brand"><Logo size={22} /> CrossPOV</a>
        <nav aria-label="Site">
          <a href="/">Home</a>
          <a href="/demo" className="site-btn">Try the demo</a>
        </nav>
      </header>
      <main className="site-doc">
        <h1>Privacy policy</h1>
        <p className="muted">Last updated {UPDATED}</p>

        <h2>Summary</h2>
        <p>
          CrossPOV is a Windows app that records your own screen and saves clips to your PC. To find streamers you played
          against, it looks up your finished matches and checks public Twitch data. It has no user accounts, no ads and no
          analytics, and it never uploads your clips.
        </p>

        <h2>What the app stores on your PC</h2>
        <ul>
          <li>Your settings, including the Riot ID and region you enter (or your Riot sign-in, once available).</li>
          <li>Your clips and their thumbnails, in the clip folder you choose. You can delete them at any time.</li>
          <li>Summaries of your recent matches (up to 50) and which streamers were found in them.</li>
          <li>A temporary replay buffer while the game is open, which is overwritten continuously and cleared when recording stops.</li>
        </ul>

        <h2>What is sent to the CrossPOV server</h2>
        <ul>
          <li>Your Riot ID and region, to look up your latest finished match.</li>
          <li>A match id, to check which players in it were streaming.</li>
          <li>If you use “Played against a streamer it missed?”, the Twitch channel name you type.</li>
        </ul>
        <p>
          The server runs on Cloudflare. It keeps match data and streamer results in Cloudflare&rsquo;s cache for up to 7 days
          to avoid repeated lookups, and keeps no other records about you. Like any website, Cloudflare processes your IP
          address to deliver requests; CrossPOV uses it only for short-term rate limiting and does not store it.
        </p>

        <h2>Streamers&rsquo; accounts</h2>
        <p>
          To find streamers who play on other accounts, CrossPOV keeps a private list of which VALORANT accounts belong to which
          Twitch channels. An account is added only after a check: its name matches a channel that was live during the match, or
          the scoreboard in the channel&rsquo;s public VOD showed that exact match. The list holds the account&rsquo;s Riot player
          id, the Twitch channel, and when it was confirmed. It is kept on CrossPOV&rsquo;s own server, is never published,
          listed or searchable, and is only used to check the players of a match a user has played. A streamer who doesn&rsquo;t
          want their accounts kept can ask to be removed; their entries are deleted and never added again.
        </p>
        <p>
          The scoreboard scanner also reads the score shown on public VALORANT streams on Twitch and keeps those readings for
          6 hours.
        </p>

        <h2>Data from other services</h2>
        <ul>
          <li>
            <b>Match data</b> (players&rsquo; Riot IDs, agents, scores and kill times) comes from a VALORANT data service and is
            only requested after a match has ended. CrossPOV never shows other players&rsquo; information during a match.
          </li>
          <li>
            <b>Twitch</b>: public channel information and public past broadcasts (VODs), via Twitch&rsquo;s official API.
            Subscriber-only and deleted VODs are not accessed.
          </li>
        </ul>

        <h2>What CrossPOV never does</h2>
        <ul>
          <li>Read game memory, inject code, or communicate with the VALORANT or Riot client on your PC.</li>
          <li>Sell or share your data, or use it for advertising.</li>
          <li>Upload your recordings or clips.</li>
        </ul>

        <h2>Your choices</h2>
        <ul>
          <li>Turn off automatic streamer clips, or remove your Riot ID, in Settings.</li>
          <li>Delete clips from the app or your clip folder; uninstalling removes the app&rsquo;s data folder.</li>
          {CONTACT && <li>Questions or removal requests (including streamers asking to have their accounts removed): <a href={`mailto:${CONTACT}`}>{CONTACT}</a></li>}
        </ul>

        <p className="muted small">
          CrossPOV isn&rsquo;t endorsed by Riot Games and doesn&rsquo;t reflect the views or opinions of Riot Games or anyone
          officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are
          trademarks or registered trademarks of Riot Games, Inc.
        </p>
      </main>
    </div>
  );
}
