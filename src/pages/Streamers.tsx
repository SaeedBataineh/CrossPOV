import { useState, type FormEvent } from "react";
import type { Page } from "../components/Sidebar";
import { Notice } from "../components/ui";
import {
  addStreamerChannel,
  findMe,
  isDesktop,
  lookupLatestMatch,
  type MatchStreamers,
  type MatchSummary,
  type StreamerPlayer,
} from "../lib/backend";
import { REGIONS, type Settings } from "../lib/settings";
import { matchTimeAgo, scoreLine, type useMatches } from "../lib/useMatches";
import { timeAgo } from "../lib/useRecorder";

/** Text and tone for one streamer's progress. */
function streamerLabel(s: StreamerPlayer): { text: string; tone: string } {
  switch (s.status) {
    case "working":
      if (s.vod?.live) return { text: `Live · saving clips (${s.clips}/${s.fights})`, tone: "waiting" };
      return { text: `Saving clips (${s.clips}/${s.fights})`, tone: "checking" };
    case "clipped":
      return { text: `${s.clips} ${s.clips === 1 ? "clip" : "clips"} saved`, tone: "clipped" };
    case "noFights":
      return { text: "Streamer · you didn't fight", tone: "" };
    case "noVod":
      return { text: "Was live · no VOD saved", tone: "novod" };
    case "subOnly":
      return { text: "Sub-only VOD · skipped", tone: "subonly" };
    case "failed":
      return { text: "Couldn't get clips", tone: "novod" };
  }
}

function Lobby({ match, riotId, streamers }: { match: MatchSummary; riotId: string; streamers?: MatchStreamers }) {
  const me = findMe(match, riotId);
  const players = [...match.players].sort((a, b) => {
    const team = (p: typeof a) => (me && p.team === me.team ? 0 : 1);
    return team(a) - team(b) || b.kills - a.kills;
  });
  const checked = Boolean(streamers?.checkedMs);
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
            {players.map((p) => {
              const st = streamers?.players.find((s) => s.puuid === p.puuid);
              const label = st ? streamerLabel(st) : null;
              return (
                <tr key={p.puuid}>
                  <td>
                    <strong>{p.name}</strong>
                    <span className="muted">#{p.tag}</span>
                    {me?.puuid === p.puuid && <span className="status-pill" style={{ marginLeft: 8 }}>You</span>}
                  </td>
                  <td className="muted">{me ? (p.team === me.team ? "Your team" : "Enemy") : p.team}</td>
                  <td>{p.agent}</td>
                  <td className="mono">{p.kills} / {p.deaths} / {p.assists}</td>
                  <td>
                    {me?.puuid === p.puuid ? null : st && label ? (
                      <span className="stack-2">
                        <a href={`https://www.twitch.tv/${st.channel.login}`} target="_blank" rel="noreferrer">twitch.tv/{st.channel.login}</a>
                        <span className={`status-text ${label.tone}`} title={st.message ?? undefined}>{label.text}</span>
                      </span>
                    ) : (
                      <span className="muted">{checked ? "Not streaming" : isDesktop ? "Checking soon…" : "—"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {streamers?.error && <Notice tone="bad">{streamers.error}</Notice>}
    </div>
  );
}

/** "Played against a streamer it missed?": link a player to a Twitch channel. */
function AddChannel({ match, riotId, onAdded }: { match: MatchSummary; riotId: string; onAdded: (s: MatchStreamers) => void }) {
  const me = findMe(match, riotId);
  const others = match.players.filter((p) => p.puuid !== me?.puuid);
  const [puuid, setPuuid] = useState("");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAdded(await addStreamerChannel(match.id, puuid, channel.trim()));
      setChannel("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card pad stack-12" onSubmit={(e) => void submit(e)}>
      <h2 className="h3">Played against a streamer it missed?</h2>
      <span className="muted">Pick the player and paste their channel. CrossPOV checks they were live during this match, then clips your fights from their VOD.</span>
      <div className="row-wrap">
        <label htmlFor="add-player" className="sr-only">Player</label>
        <select id="add-player" className="input" value={puuid} onChange={(e) => setPuuid(e.target.value)}>
          <option value="">Which player?</option>
          {others.map((p) => (
            <option key={p.puuid} value={p.puuid}>{p.name}#{p.tag} · {p.agent}</option>
          ))}
        </select>
        <label htmlFor="add-channel" className="sr-only">Twitch channel</label>
        <input id="add-channel" className="input grow" placeholder="twitch.tv/channel" value={channel} onChange={(e) => setChannel(e.target.value)} spellCheck={false} />
        <button type="submit" className="btn primary" disabled={busy || !puuid || channel.trim().length < 3}>
          {busy ? "Checking…" : "Check VOD"}
        </button>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
    </form>
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
  const { matches, status, checking, checkNow, streamers, putStreamers, checkStreamers } = matchesState;
  const [selected, setSelected] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState("");
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

  async function recheck() {
    if (!match) return;
    setRechecking(true);
    setRecheckError("");
    try {
      await checkStreamers(match.id);
    } catch (err) {
      setRecheckError(String(err));
    } finally {
      setRechecking(false);
    }
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
      {!settings.streamerAuto && <Notice tone="warn">Automatic streamer clips are off in Settings. Use “Check streamers” on a match.</Notice>}

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
              const found = streamers[m.id]?.players.length ?? 0;
              const clips = streamers[m.id]?.players.reduce((n, p) => n + p.clips, 0) ?? 0;
              return (
                <button key={m.id} type="button" className="match-item" aria-pressed={m.id === match?.id} onClick={() => setSelected(m.id)}>
                  <span className="row-between">
                    <strong>{m.map}</strong>
                    <span className="muted small">{matchTimeAgo(m.startedAt)}</span>
                  </span>
                  <span className="muted small mono">{m.mode} · {scoreLine(m, me?.team)}{me ? ` · ${me.agent}` : ""}</span>
                  {found > 0 && (
                    <span className={`status-pill ${clips ? "clipped" : "waiting"}`}>
                      {found} {found === 1 ? "streamer" : "streamers"}{clips ? ` · ${clips} clips` : ""}
                    </span>
                  )}
                </button>
              );
            })}
          </section>
          {match && (
            <section className="split-main stack-16" aria-labelledby="lobby">
              <div className="row-wrap" style={{ justifyContent: "flex-end" }}>
                <span className="muted small">
                  {streamers[match.id]?.checkedMs ? `Streamers checked ${timeAgo(streamers[match.id]!.checkedMs!)}` : "Streamers not checked yet"}
                </span>
                <button type="button" className="btn" onClick={() => void recheck()} disabled={rechecking}>
                  {rechecking ? "Checking…" : "Check streamers"}
                </button>
              </div>
              {recheckError && <Notice tone="bad">{recheckError}</Notice>}
              <Lobby match={match} riotId={settings.riotId} streamers={streamers[match.id]} />
              <AddChannel match={match} riotId={settings.riotId} onAdded={putStreamers} />
            </section>
          )}
        </div>
      )}
    </>
  );
}
