import { useState, type FormEvent } from "react";
import type { Page } from "../components/Sidebar";
import { Notice } from "../components/ui";
import { findMe, isDesktop, lookupLatestMatch, type MatchSummary } from "../lib/backend";
import { REGIONS, type Settings } from "../lib/settings";
import { matchTimeAgo, scoreLine, type useMatches } from "../lib/useMatches";
import { timeAgo } from "../lib/useRecorder";

function Lobby({ match, riotId }: { match: MatchSummary; riotId: string }) {
  const me = findMe(match, riotId);
  const players = [...match.players].sort((a, b) => {
    const team = (p: typeof a) => (me && p.team === me.team ? 0 : 1);
    return team(a) - team(b) || b.kills - a.kills;
  });
  return (
    <div className="card pad stack-16">
      <div className="row-between">
        <h2 id="lobby">{match.map} · {match.mode}</h2>
        <span className="muted mono small">{scoreLine(match, me?.team)} · {matchTimeAgo(match.startedAt)}</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Team</th>
              <th scope="col">Agent</th>
              <th scope="col">K / D / A</th>
              <th scope="col">Streamer</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.puuid}>
                <td>
                  <strong>{p.name}</strong>
                  <span className="muted">#{p.tag}</span>
                  {me?.puuid === p.puuid && <span className="status-pill" style={{ marginLeft: 8 }}>You</span>}
                </td>
                <td className="muted">{me ? (p.team === me.team ? "Your team" : "Enemy") : p.team}</td>
                <td>{p.agent}</td>
                <td className="mono">{p.kills} / {p.deaths} / {p.assists}</td>
                <td className="muted">{me?.puuid === p.puuid ? "" : "Not checked yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Streamer detection is the next update: CrossPOV will check each player here for a live stream and clip your fights from their VOD.
      </p>
    </div>
  );
}

/** Website demo: look up any Riot ID's latest match through this site's server. */
function DemoLookup() {
  const [riotId, setRiotId] = useState("");
  const [region, setRegion] = useState("eu");
  const [match, setMatch] = useState<MatchSummary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setMatch(await lookupLatestMatch(riotId.trim(), region));
    } catch (err) {
      setMatch(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="card pad stack-12" onSubmit={(e) => void submit(e)}>
        <h2 className="h3">Try it: look up a match</h2>
        <span className="muted">Enter a Riot ID to load its latest match, the same data the desktop app uses after each game.</span>
        <div className="row-wrap">
          <label htmlFor="demo-riot" className="sr-only">Riot ID</label>
          <input id="demo-riot" className="input grow" placeholder="Name#TAG" value={riotId} onChange={(e) => setRiotId(e.target.value)} spellCheck={false} />
          <label htmlFor="demo-region" className="sr-only">Region</label>
          <select id="demo-region" className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button type="submit" className="btn primary" disabled={busy || !riotId.includes("#")}>{busy ? "Loading…" : "Look up"}</button>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
      </form>
      {match && <Lobby match={match} riotId={riotId} />}
    </>
  );
}

export default function Streamers({
  settings,
  matchesState,
  onNavigate,
}: {
  settings: Settings;
  matchesState: ReturnType<typeof useMatches>;
  onNavigate: (p: Page) => void;
}) {
  const { matches, status, checking, checkNow } = matchesState;
  const [selected, setSelected] = useState<string | null>(null);
  const match = matches.find((m) => m.id === selected) ?? matches[0];

  if (!isDesktop) {
    return (
      <>
        <header className="stack-6">
          <h1>Streamer matches</h1>
          <span className="muted">After each match, CrossPOV checks the lobby for streamers and clips your fights from their stream.</span>
        </header>
        <DemoLookup />
      </>
    );
  }

  return (
    <>
      <header className="page-head">
        <div className="stack-6">
          <h1>Streamer matches</h1>
          <span className="status-line">
            {status?.lastCheckMs ? `Last checked ${timeAgo(status.lastCheckMs)}` : "Checks for new matches while VALORANT is open"}
          </span>
        </div>
        <button type="button" className="btn" onClick={() => void checkNow()} disabled={checking || !status?.configured}>
          {checking ? "Checking…" : "Check for new match"}
        </button>
      </header>

      {status && !status.configured && (
        <Notice tone="warn">
          Add your Riot ID in Settings so CrossPOV can find your matches.{" "}
          <button type="button" className="link" onClick={() => onNavigate("settings")}>Open Settings</button>
        </Notice>
      )}
      {status?.error && status.configured && <Notice tone="bad">{status.error}</Notice>}

      {matches.length === 0 ? (
        <div className="card pad empty">
          <strong>No matches yet</strong>
          <span className="muted">
            {settings.riotId ? "Play a match. It shows up here a minute or two after it ends." : "Add your Riot ID in Settings first."}
          </span>
        </div>
      ) : (
        <div className="split">
          <section className="split-narrow stack-8" aria-label="Recent matches">
            {matches.map((m) => {
              const me = findMe(m, settings.riotId);
              return (
                <button key={m.id} type="button" className="match-item" aria-pressed={m.id === match?.id} onClick={() => setSelected(m.id)}>
                  <span className="row-between">
                    <strong>{m.map}</strong>
                    <span className="muted small">{matchTimeAgo(m.startedAt)}</span>
                  </span>
                  <span className="muted small mono">{m.mode} · {scoreLine(m, me?.team)}{me ? ` · ${me.agent}` : ""}</span>
                </button>
              );
            })}
          </section>
          <section className="split-main stack-16" aria-labelledby="lobby">
            {match && <Lobby match={match} riotId={settings.riotId} />}
          </section>
        </div>
      )}
    </>
  );
}
