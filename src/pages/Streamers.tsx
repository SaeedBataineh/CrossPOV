import { useState } from "react";
import { SampleBanner } from "../components/ui";
import { SAMPLE_MATCHES, STATUS_LABEL } from "../lib/sample";

export default function Streamers() {
  const [selected, setSelected] = useState(SAMPLE_MATCHES[0].id);
  const [channel, setChannel] = useState("");
  const match = SAMPLE_MATCHES.find((m) => m.id === selected) ?? SAMPLE_MATCHES[0];

  return (
    <>
      <header className="stack-6">
        <h1>Streamer matches</h1>
        <span className="muted">
          After each match, CrossPOV checks the lobby for streamers and clips your fights from their stream.
        </span>
      </header>

      <SampleBanner>Matches below are sample data. Streamer detection is added in a later update.</SampleBanner>

      <div className="split">
        <section className="split-narrow stack-8" aria-label="Recent matches">
          {SAMPLE_MATCHES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="match-item"
              aria-pressed={m.id === selected}
              onClick={() => setSelected(m.id)}
            >
              <span className="row-between">
                <strong>{m.title}</strong>
                <span className="muted">{m.when}</span>
              </span>
              <span className={`status-pill ${m.summaryStatus}`}>{m.summary}</span>
            </button>
          ))}
        </section>

        <section className="split-main stack-16" aria-labelledby="lobby">
          <div className="card pad stack-16">
            <div className="row-between">
              <h2 id="lobby">Lobby · {match.title}</h2>
              <span className="muted">{match.when}</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Player</th>
                    <th scope="col">Team</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {match.players.map((p) => (
                    <tr key={p.name}>
                      <td><strong>{p.name}</strong></td>
                      <td className="muted">{p.team}</td>
                      <td>{p.channel ? `twitch.tv/${p.channel}` : "—"}</td>
                      <td>
                        <span className={`status-pill ${p.status}`}>
                          {STATUS_LABEL[p.status]}{p.clips ? ` · ${p.clips} clips` : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <form className="card pad stack-12" onSubmit={(e) => e.preventDefault()}>
            <h2 className="h3">Played against a streamer it missed?</h2>
            <span className="muted">
              Paste their channel. CrossPOV checks their VOD against this match (map, agents, timing) before clipping.
            </span>
            <div className="row-wrap">
              <label htmlFor="chan" className="sr-only">Twitch channel</label>
              <input id="chan" className="input grow" placeholder="twitch.tv/channel" value={channel} onChange={(e) => setChannel(e.target.value)} />
              <button type="submit" className="btn primary" disabled title="Available once streamer detection is added">
                Check VOD
              </button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
