import { useEffect, useState, type ReactNode } from "react";
import { Panel, Row, Seg, Toggle, Volume } from "../components/ui";
import { isDesktop, listAudioApps, listMicDevices } from "../lib/backend";
import type { AppAudio, Settings } from "../lib/settings";
import { useDraft, type Draft } from "../lib/useDraft";

/** "Discord.exe" -> "Discord" */
const appName = (exe: string) => exe.replace(/\.exe$/i, "");
const COLORS = ["#5865f2", "#1db954", "#f2c14e", "#53fc18", "#ff8a86", "#b48bff"];

/** Unsaved-changes indicator with Save, shown in a panel header. */
export function SaveBar({ d }: { d: Draft }) {
  return (
    <span className="row">
      <span className="m tiny muted" role="status">{d.status || (d.dirty ? "unsaved changes" : "")}</span>
      {d.dirty && <button type="button" className="b sm" onClick={d.discard}>Undo</button>}
      <button type="button" className="b sm r" onClick={() => void d.save()} disabled={!d.dirty || d.saving}>{d.saving ? "Saving…" : "Save"}</button>
    </span>
  );
}

function Channel({
  name,
  sub,
  color,
  on,
  onToggle,
  volume,
  onVolume,
  track,
  extra,
}: {
  name: string;
  sub: string;
  color: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  volume: number;
  onVolume: (v: number) => void;
  track: string;
  extra?: ReactNode;
}) {
  return (
    <div className="mixer-row" style={on ? undefined : { opacity: 0.55 }}>
      <span className="row" style={{ gap: 10, minWidth: 0 }}>
        <span className="src-ic" style={{ background: `${color}22`, borderColor: `${color}66`, color }}>{name[0]}</span>
        <span className="stack" style={{ gap: 0, minWidth: 0 }}>
          <b style={{ fontSize: 12.5 }}>{name}</b>
          <span className="m dim ellipsis" style={{ fontSize: 9.5 }}>{sub}</span>
        </span>
      </span>
      <Volume label={name} value={volume} onChange={onVolume} disabled={!on} />
      <span className="m tiny muted">{on ? "recorded" : "not recorded"}</span>
      <span className="row" style={{ justifyContent: "flex-end" }}>
        <Toggle label={`Record ${name}`} checked={on} onChange={onToggle} />
        <span className="pill" style={{ height: 22, padding: "0 6px" }} title="Audio track in the clip file">{on ? track : "—"}</span>
        {extra}
      </span>
    </div>
  );
}

export default function Audio({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const d = useDraft(settings, onSaved);
  const { draft, set } = d;
  const [running, setRunning] = useState<string[]>([]);
  const [mics, setMics] = useState<string[]>([]);

  async function refresh() {
    try {
      setRunning((await listAudioApps()).map((a) => a.exe));
    } catch {
      setRunning([]);
    }
  }
  useEffect(() => {
    void refresh();
    listMicDevices().then(setMics, () => setMics([]));
  }, []);

  const setApp = (i: number, patch: Partial<AppAudio>) => set("apps", draft.apps.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const micTrack = draft.separateTracks ? "T2" : "T1";
  const gameMode = draft.audioMode === "game";
  const notAdded = running.filter((a) => !draft.apps.some((x) => x.exe.toLowerCase() === a.toLowerCase()) && !/^valorant/i.test(a));
  const track1 = [gameMode ? "VALORANT" : "Desktop", ...(gameMode ? draft.apps.filter((a) => a.enabled).map((a) => appName(a.exe)) : [])];

  return (
    <>
      <div className="s8 col">
        <Panel title="Mixer" color="var(--rec)" right={<SaveBar d={d} />}>
          <div className="mixer-row head"><span>Source</span><span>Volume in clips</span><span /><span style={{ textAlign: "right" }}>Record · track</span></div>
          <Channel
            name={gameMode ? "VALORANT" : "Desktop audio"}
            sub={gameMode ? "VALORANT-Win64-Shipping.exe" : "everything you hear"}
            color="#e5332f"
            on={draft.gameAudio}
            onToggle={(v) => set("gameAudio", v)}
            volume={draft.gameVolume}
            onVolume={(v) => set("gameVolume", v)}
            track="T1"
          />
          {gameMode &&
            draft.apps.map((app, i) => (
              <Channel
                key={app.exe}
                name={appName(app.exe)}
                sub={app.exe}
                color={COLORS[i % COLORS.length]}
                on={app.enabled}
                onToggle={(v) => setApp(i, { enabled: v })}
                volume={app.volume}
                onVolume={(v) => setApp(i, { volume: v })}
                track="T1"
                extra={<button type="button" className="b sm icon" style={{ width: 24 }} aria-label={`Remove ${appName(app.exe)}`} onClick={() => set("apps", draft.apps.filter((_, j) => j !== i))}>✕</button>}
              />
            ))}
          <Channel
            name="Microphone"
            sub={draft.micDevice === "default" ? "default device" : draft.micDevice}
            color="#e8e8e8"
            on={draft.microphone}
            onToggle={(v) => set("microphone", v)}
            volume={draft.micVolume}
            onVolume={(v) => set("micVolume", v)}
            track={micTrack}
          />
          <p className="note">
            {gameMode
              ? "Only the game and the apps listed here are recorded. Music, browsers and anything else stay out of your clips."
              : "Whole desktop: everything you hear is recorded, including music and notifications."}
          </p>
        </Panel>

        <Panel title="Tracks in each clip" color="var(--warn)" right={<Toggle label="Separate audio tracks" checked={draft.separateTracks} onChange={(v) => set("separateTracks", v)} />}>
          <div className="pad stats" style={{ gridTemplateColumns: draft.separateTracks ? "1fr 1fr" : "1fr" }}>
            <div className="stat"><span>Track 1 · {draft.separateTracks ? "game + apps" : "everything"}</span><b style={{ fontSize: 12 }}>{[...track1, ...(!draft.separateTracks && draft.microphone ? ["Mic"] : [])].join(", ")}</b></div>
            {draft.separateTracks && <div className="stat"><span>Track 2 · your mic</span><b style={{ fontSize: 12 }}>{draft.microphone ? (draft.micDevice === "default" ? "Default mic" : draft.micDevice) : "off"}</b></div>}
          </div>
          <p className="note">Separate tracks make editing easier: you can turn your voice down without touching the game.</p>
        </Panel>
      </div>

      <div className="s4 col">
        <Panel title="What gets recorded" color="var(--kick)">
          <Row label="Capture mode" help={gameMode ? "keeps music and browsers out" : "everything you hear"}>
            <Seg label="Capture mode" value={draft.audioMode} onChange={(v) => set("audioMode", v)} options={[{ value: "game", label: "Game + apps" }, { value: "desktop", label: "Whole desktop" }]} />
          </Row>
          <Row label="Clip sound" help="a beep when a clip is saved"><Toggle label="Clip sound" checked={draft.clipSound} onChange={(v) => set("clipSound", v)} /></Row>
        </Panel>

        <Panel title="Microphone" color="var(--text)">
          <Row label="Record my mic"><Toggle label="Record my mic" checked={draft.microphone} onChange={(v) => set("microphone", v)} /></Row>
          <Row label="Device">
            <select className="input" style={{ maxWidth: 200 }} aria-label="Microphone device" value={draft.micDevice} onChange={(e) => set("micDevice", e.target.value)}>
              <option value="default">Default device</option>
              {mics.map((m) => <option key={m} value={m}>{m}</option>)}
              {draft.micDevice !== "default" && !mics.includes(draft.micDevice) && <option value={draft.micDevice}>{draft.micDevice} (not connected)</option>}
            </select>
          </Row>
        </Panel>

        <Panel title="Apps making sound" color="var(--twitch)" right={<button type="button" className="b sm" onClick={() => void refresh()}>Refresh</button>}>
          {!gameMode ? (
            <div className="empty"><span>Whole desktop already records every app. Switch to Game + apps to pick them one by one.</span></div>
          ) : notAdded.length ? (
            notAdded.map((exe) => (
              <Row key={exe} label={appName(exe)} help={exe}>
                <button type="button" className="b sm" onClick={() => set("apps", [...draft.apps, { exe, enabled: true, volume: 100 }])}>+ Record</button>
              </Row>
            ))
          ) : (
            <div className="empty"><span>{isDesktop ? "No other apps are playing sound right now. Start one (for example Discord) and press Refresh." : "The desktop app lists the apps playing sound here."}</span></div>
          )}
        </Panel>
      </div>
    </>
  );
}
