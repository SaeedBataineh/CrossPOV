import { useEffect, useState } from "react";
import type { Page } from "../components/Shell";
import { Notice } from "../components/ui";
import { isDesktop, linkedChannels, removeLinkedChannel, type LinkedChannel } from "../lib/backend";
import { allStreamers, ini, progress, streamerLabel } from "../lib/matchInfo";
import type { Settings } from "../lib/settings";
import { matchTimeAgo, type useMatches } from "../lib/useMatches";
import type { useRecorder } from "../lib/useRecorder";

/** Channels the user linked to players by hand. Stored on this PC only. */
function LinkedChannels({ notify }: { notify: (text: string, tone: "good" | "bad" | "info") => void }) {
  const [links, setLinks] = useState<LinkedChannel[] | null>(null);
  useEffect(() => {
    linkedChannels().then(setLinks, () => setLinks([]));
  }, []);
  async function remove(l: LinkedChannel) {
    try {
      await removeLinkedChannel(l.puuid);
      setLinks((all) => (all ?? []).filter((x) => x.puuid !== l.puuid));
    } catch (err) {
      notify(String(err), "bad");
    }
  }
  if (!links?.length) return null;
  return (
    <section className="stack" style={{ gap: 12 }} aria-label="Channels you linked">
      <h2 className="section-title">Channels you linked <span>kept on this PC only</span></h2>
      <div className="list">
        {links.map((l) => (
          <div key={l.puuid} className="list-row">
            <span className="avatar sm" aria-hidden="true">{ini(l.login)}</span>
            <span className="grow stack" style={{ gap: 2 }}>
              <a href={`https://www.twitch.tv/${l.login}`} target="_blank" rel="noreferrer"><b>{l.login}</b></a>
              <span className="muted small">{l.label}{l.seen ? ` · found again ${l.seen}×` : ""}</span>
            </span>
            <button type="button" className="btn quiet" onClick={() => void remove(l)}>Forget</button>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Streamers({
  settings,
  recorder,
  matchesState,
  onNavigate,
}: {
  settings: Settings;
  recorder: ReturnType<typeof useRecorder>;
  matchesState: ReturnType<typeof useMatches>;
  onNavigate: (p: Page) => void;
}) {
  const { matches, streamers } = matchesState;
  const rows = allStreamers(streamers)
    .map((r) => ({ ...r, match: matches.find((m) => m.id === r.matchId) }))
    .sort((a, b) => Date.parse(b.match?.startedAt ?? "") - Date.parse(a.match?.startedAt ?? ""));


  const nothingToClip = !settings.clipKilledYou && !settings.clipYouKilled && !settings.clipWholeRound;

  return (
    <section className="s12 page narrow" aria-label="Streamers">
      <header className="page-head">
        <h1>Streamers</h1>
        <span className="spacer" />
        <button type="button" className="btn quiet" onClick={() => onNavigate("settings")}>Clip settings</button>
      </header>
      {nothingToClip && <Notice tone="warn">Every kind of streamer clip is turned off in Settings, so nothing will be downloaded.</Notice>}
      {!settings.streamerAuto && <Notice tone="warn">Auto-clipping streamers is off in Settings.</Notice>}

      {rows.length ? (
        <div className="list">
          {rows.map(({ matchId, player: p, match }) => {
            const l = streamerLabel(p);
            const pct = p.status === "working" && !p.checking ? progress(p) : null;
            return (
              <div key={`${matchId}-${p.puuid}`} className="list-row">
                <span className="avatar sm" aria-hidden="true">{ini(p.channel.displayName)}</span>
                <span className="grow stack" style={{ gap: 2, minWidth: 0 }}>
                  <a href={`https://www.twitch.tv/${p.channel.login}`} target="_blank" rel="noreferrer"><b>{p.channel.displayName}</b></a>
                  <span className="muted small">{match ? `${match.map} · ${matchTimeAgo(match.startedAt)}` : ""}{p.fights ? ` · ${p.fights} fight${p.fights === 1 ? "" : "s"}` : ""}</span>
                </span>
                <span className="stack" style={{ gap: 4, alignItems: "flex-end", minWidth: 180 }}>
                  <span className={`small ${l.tone}`} title={p.message ?? undefined}>{l.text}</span>
                  {pct != null && pct < 100 && <span className="bar" style={{ width: 140 }}><i style={{ width: `${Math.max(4, pct)}%` }} /></span>}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <b>No streamers yet</b>
          <span>
            {isDesktop
              ? "When someone in your match was streaming, they show up here and their clips download after the match."
              : "The website demo can't download clips. Try a match lookup on the Matches page."}
          </span>
        </div>
      )}

      <LinkedChannels notify={recorder.notify} />
    </section>
  );
}
