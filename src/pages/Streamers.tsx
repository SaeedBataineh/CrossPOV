import { useEffect, useState } from "react";
import type { Page } from "../components/Shell";
import { Notice } from "../components/ui";
import { findMe, isDesktop, linkedChannels, removeLinkedChannel, type ClipInfo, type LinkedChannel } from "../lib/backend";
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
      <div className="list boxed">
        {links.map((l) => (
          <div key={l.puuid} className="list-row">
            <span className="avatar sq" aria-hidden="true">{ini(l.login)}</span>
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
  onOpen,
}: {
  settings: Settings;
  recorder: ReturnType<typeof useRecorder>;
  matchesState: ReturnType<typeof useMatches>;
  onNavigate: (p: Page) => void;
  onOpen: (c: ClipInfo) => void;
}) {
  const { matches, streamers } = matchesState;
  const rows = allStreamers(streamers)
    .map((r) => ({ ...r, match: matches.find((m) => m.id === r.matchId) }))
    .sort((a, b) => Date.parse(b.match?.startedAt ?? "") - Date.parse(a.match?.startedAt ?? ""));


  const nothingToClip = !settings.clipKilledYou && !settings.clipYouKilled && !settings.clipWholeRound;

  /** The first saved clip of this streamer from this match. */
  const firstClip = (matchId: string, names: string[]) =>
    recorder.clips
      .filter((c) => c.kind === "theirs" && (!c.matchId || c.matchId === matchId) && names.some((n) => n.toLowerCase() === c.streamer?.toLowerCase()))
      .sort((a, b) => (a.round ?? 0) - (b.round ?? 0))[0];

  return (
    <section className="page" aria-label="Streamers">
      <div className="tabs-row plain">
        <p className="muted" style={{ margin: 0 }}>Everyone who was live in your matches, and how their side is coming along.</p>
        <button type="button" className="btn quiet sm-btn" onClick={() => onNavigate("settings")}>Streamer clip settings</button>
      </div>
      {nothingToClip && <Notice tone="warn">Every kind of streamer clip is turned off in Settings, so nothing will be downloaded.</Notice>}
      {!settings.streamerAuto && <Notice tone="warn">Auto-clipping streamers is off in Settings.</Notice>}

      {rows.length ? (
        <div className="table" role="table" aria-label="Streamers">
          <div className="table-row head" role="row">
            <span role="columnheader">Streamer</span>
            <span role="columnheader">Match</span>
            <span role="columnheader">Their side</span>
            <span role="columnheader"><span className="sr-only">Watch</span></span>
          </div>
          {rows.map(({ matchId, player: p, match }) => {
            const who = match?.players.find((x) => x.puuid === p.puuid);
            const me = match ? findMe(match, settings.riotId) : undefined;
            const mate = Boolean(me && who && who.team === me.team);
            const l = streamerLabel(p, mate);
            const pct = p.status === "working" && !p.checking && !mate ? progress(p) : null;
            const clip = firstClip(matchId, [p.channel.login, p.channel.displayName]);
            return (
              <div key={`${matchId}-${p.puuid}`} className="table-row" role="row">
                <span role="cell" className="row" style={{ gap: 12, minWidth: 0 }}>
                  <span className="avatar sq" aria-hidden="true">{ini(p.channel.displayName)}</span>
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <a href={`https://www.twitch.tv/${p.channel.login}`} target="_blank" rel="noreferrer"><b className="ellipsis">{p.channel.displayName}</b></a>
                    <span className="muted small ellipsis">{["Twitch", mate ? "Teammate" : me && who ? "Enemy" : null, who?.agent].filter(Boolean).join(" · ")}</span>
                  </span>
                </span>
                <span role="cell" className="muted">{match ? `${match.map} · ${matchTimeAgo(match.startedAt)}` : ""}{p.fights ? ` · ${p.fights} fight${p.fights === 1 ? "" : "s"}` : ""}</span>
                <span role="cell" className="stack" style={{ gap: 6 }}>
                  <span className={`small ${l.tone}`} title={p.message ?? undefined}>{l.text}</span>
                  {pct != null && pct < 100 && <span className="bar" style={{ width: 160 }}><i style={{ width: `${Math.max(4, pct)}%` }} /></span>}
                </span>
                <span role="cell" style={{ justifySelf: "end" }}>
                  {clip && <button type="button" className="btn primary sm-btn" onClick={() => onOpen(clip)}>Watch</button>}
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
              : "The website demo can't download clips. Try a match lookup on the Home page."}
          </span>
        </div>
      )}

      <LinkedChannels notify={recorder.notify} />
    </section>
  );
}
