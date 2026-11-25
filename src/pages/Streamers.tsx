import { useEffect, useState } from "react";
import type { Page } from "../components/Shell";
import { Notice, Panel, Row, Seg, Toggle } from "../components/ui";
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
  return (
    <Panel title="Channels you linked" color="var(--warn)" right={<span className="m tiny dim">on this PC only</span>}>
      {links && links.length > 0 ? (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Channel</th><th>Player when linked</th><th>Found again</th><th /></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.puuid}>
                  <td><span className="ini">{ini(l.login)}</span><a href={`https://www.twitch.tv/${l.login}`} target="_blank" rel="noreferrer"><b>{l.login}</b></a></td>
                  <td className="small">{l.label}</td>
                  <td className="m small">{l.seen ? `${l.seen}×` : "not yet"}</td>
                  <td style={{ textAlign: "right" }}><button type="button" className="b sm" onClick={() => void remove(l)}>Forget</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <span>
            Played a streamer on a smurf or a name CrossPOV didn't recognise? Open the match on the <b>Matches</b> page and use
            "Missed a streamer?". The link stays on this PC and is checked automatically next time you meet them.
          </span>
        </div>
      )}
      <p className="note">Links store the channel, not Riot names. The list lives only on this PC: the server is asked about one match at a time and keeps nothing, and links are never shared with other players.</p>
    </Panel>
  );
}

const PADS = [15, 30, 60, 90, 120].map((v) => ({ value: v, label: String(v) }));
const TONE_COLOR: Record<string, string> = {
  good: "var(--good)",
  warn: "var(--warn)",
  purple: "var(--twitch-text)",
  bad: "var(--pink)",
  muted: "var(--muted)",
};

export default function Streamers({
  settings,
  recorder,
  matchesState,
  quickSave,
  onNavigate,
}: {
  settings: Settings;
  recorder: ReturnType<typeof useRecorder>;
  matchesState: ReturnType<typeof useMatches>;
  quickSave: (patch: Partial<Settings>) => Promise<void>;
  onNavigate: (p: Page) => void;
}) {
  const { matches, streamers } = matchesState;
  const rows = allStreamers(streamers)
    .map((r) => ({ ...r, match: matches.find((m) => m.id === r.matchId) }))
    .sort((a, b) => Date.parse(b.match?.startedAt ?? "") - Date.parse(a.match?.startedAt ?? ""));


  const set = <K extends keyof Settings>(key: K) => (v: Settings[K]) => void quickSave({ [key]: v } as Partial<Settings>);
  const nothingToClip = !settings.clipKilledYou && !settings.clipYouKilled && !settings.clipWholeRound;

  return (
    <>
      {nothingToClip && <Notice tone="warn">Every kind of streamer clip is turned off, so nothing will be downloaded. Turn on at least one in Clip rules.</Notice>}

      <div className="s8 col">
        <Panel title="Streamer downloads">
          {rows.length ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Streamer</th><th>Match</th><th>Fights</th><th>Source</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map(({ matchId, player: p, match }) => {
                    const l = streamerLabel(p);
                    const color = TONE_COLOR[l.tone];
                    return (
                      <tr key={`${matchId}-${p.puuid}`}>
                        <td className="ellipsis" style={{ maxWidth: 200 }}>
                          <span className="ini">{ini(p.channel.displayName)}</span>
                          <a href={`https://www.twitch.tv/${p.channel.login}`} target="_blank" rel="noreferrer"><b>{p.channel.displayName}</b></a>
                        </td>
                        <td className="small">{match ? `${match.map} · ${matchTimeAgo(match.startedAt)}` : "—"}</td>
                        <td className="num">{p.fights}</td>
                        <td className="small muted">{p.vod ? (p.vod.live ? "live stream" : "Twitch VOD") : "—"}{p.manual ? " · added by you" : ""}</td>
                        <td style={{ width: 170 }} title={p.message ?? undefined}>
                          <div className="bar"><i style={{ width: `${progress(p)}%`, background: color }} /></div>
                          <span className="tiny" style={{ color }}>{l.text}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <strong>No streamers yet</strong>
              <span>
                {isDesktop
                  ? "When someone in your match was streaming, their clips download here after the match."
                  : "The website demo can't download clips. Try a match lookup on the Matches page."}
              </span>
            </div>
          )}
        </Panel>

        <LinkedChannels notify={recorder.notify} />

      </div>

      <div className="s4 col">
        <Panel title="Clip rules" right={<button type="button" className="linkish muted small" onClick={() => onNavigate("settings")}>All settings</button>}>
          <Row label="Auto-clip streamers" help="after every match"><Toggle label="Auto-clip streamers" checked={settings.streamerAuto} onChange={set("streamerAuto")} /></Row>
          <Row label="When they killed you" help="turn off to skip these downloads"><Toggle label="When they killed you" checked={settings.clipKilledYou} onChange={set("clipKilledYou")} /></Row>
          <Row label="When you killed them"><Toggle label="When you killed them" checked={settings.clipYouKilled} onChange={set("clipYouKilled")} /></Row>
          <Row label="Whole rounds" help="bigger clips"><Toggle label="Whole rounds" checked={settings.clipWholeRound} onChange={set("clipWholeRound")} /></Row>
          <Row label="Seconds before"><Seg label="Seconds before" value={settings.secondsBefore} onChange={set("secondsBefore")} options={PADS} /></Row>
          <Row label="Seconds after"><Seg label="Seconds after" value={settings.secondsAfter} onChange={set("secondsAfter")} options={PADS} /></Row>
        </Panel>
        <Panel title="VODs">
          <Row label="Grab right after the match" help="in case the VOD is deleted later"><Toggle label="Grab right after the match" checked={settings.grabAfterMatch} onChange={set("grabAfterMatch")} /></Row>
          <Row label="Wait for a VOD" help="keep trying after the stream ends">
            <Seg label="Wait for a VOD" value={settings.vodWaitHours} onChange={set("vodWaitHours")} options={[12, 24, 48].map((v) => ({ value: v, label: `${v} h` }))} />
          </Row>
        </Panel>
      </div>
    </>
  );
}
