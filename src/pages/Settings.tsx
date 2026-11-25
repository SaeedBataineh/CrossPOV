import { lazy, Suspense, useState, type KeyboardEvent } from "react";
import { Panel, Row, Seg, Toggle } from "../components/ui";
import { isDesktop, pickFolder } from "../lib/backend";
import { estimateClipMb, REGIONS, targetMbps, type Settings as S } from "../lib/settings";
import { useDraft } from "../lib/useDraft";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** Turns a key press into a shortcut string the global-shortcut backend understands, e.g. "Ctrl+Shift+F9". */
function shortcutFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key: string;
  if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (["Home", "End", "Insert", "Delete", "PageUp", "PageDown", "PrintScreen", "Pause"].includes(e.code)) key = e.code;
  else return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, key].join("+");
}

const opts = <T extends string | number>(values: T[], label: (v: T) => string = String) => values.map((value) => ({ value, label: label(value) }));
const PADS = opts([15, 30, 60, 90, 120]);

const Audio = lazy(() => import("./Audio"));

/** Settings, with Audio as its own tab (one at a time, so each keeps its own unsaved changes). */
export default function SettingsPage({ settings, onSaved }: { settings: S; onSaved: (s: S) => void }) {
  const [tab, setTab] = useState<"general" | "audio">("general");
  return (
    <>
      <div className="s12 toolbar">
        <h1 className="page-title">Settings</h1>
        <div className="chips" role="tablist" aria-label="Settings sections">
          <button type="button" role="tab" aria-selected={tab === "general"} onClick={() => setTab("general")}>General</button>
          <button type="button" role="tab" aria-selected={tab === "audio"} onClick={() => setTab("audio")}>Audio</button>
        </div>
      </div>
      {tab === "general" ? <GeneralSettings settings={settings} onSaved={onSaved} /> : (
        <Suspense fallback={<p className="muted s12">Loading…</p>}>
          <Audio settings={settings} onSaved={onSaved} />
        </Suspense>
      )}
    </>
  );
}

function GeneralSettings({ settings, onSaved }: { settings: S; onSaved: (s: S) => void }) {
  const d = useDraft(settings, onSaved);
  const { draft, set } = d;
  const [listening, setListening] = useState(false);

  async function browse() {
    const folder = await pickFolder(draft.clipFolder);
    if (folder) set("clipFolder", folder);
  }

  function captureHotkey(e: KeyboardEvent<HTMLButtonElement>) {
    if (!listening) return;
    e.preventDefault();
    if (e.key === "Escape") {
      setListening(false);
      return;
    }
    const combo = shortcutFromEvent(e);
    if (combo) {
      set("hotkey", combo);
      setListening(false);
    }
  }

  const riotIdOk = draft.riotId.trim() === "" || /^[^#]+#[^#\s]+$/.test(draft.riotId.trim());
  const nothingToClip = draft.streamerAuto && !draft.clipKilledYou && !draft.clipYouKilled && !draft.clipWholeRound;

  return (
    <>
      <section className="panel s12" aria-label="Save settings">
        <div className="row-wrap" style={{ padding: "8px 12px", gap: 10 }}>
          <span className="m tiny muted">≈ {Math.round(targetMbps(draft))} Mbps · about {Math.round(estimateClipMb(draft))} MB per {draft.bufferSeconds} s clip</span>
          <span className="spacer" />
          <span className="m tiny muted" role="status">{d.status || (d.dirty ? "unsaved changes" : "all saved")}</span>
          <button type="button" className="b sm" onClick={() => void d.reset()}>Reset to defaults</button>
          {d.dirty && <button type="button" className="b sm" onClick={d.discard}>Undo</button>}
          <button type="button" className="b sm r" onClick={() => void d.save()} disabled={!d.dirty || d.saving}>{d.saving ? "Saving…" : "Save"}</button>
        </div>
      </section>

      <div className="s4 col">
        <Panel title="Recording" color="var(--rec)" right={<span className="m tiny dim">your clips</span>}>
          <Row label="Frame rate"><Seg label="Frame rate" value={draft.fps} onChange={(v) => set("fps", v)} options={opts([30, 60, 120, 144, 240])} /></Row>
          <Row label="Resolution" help="native = your monitor">
            <Seg label="Resolution" value={draft.resolution} onChange={(v) => set("resolution", v)} options={[{ value: "native", label: "Native" }, { value: "1440p", label: "1440p" }, { value: "1080p", label: "1080p" }, { value: "720p", label: "720p" }]} />
          </Row>
          <Row label="Quality" help="higher = sharper, bigger files">
            <Seg label="Quality" value={draft.quality} onChange={(v) => set("quality", v)} options={[{ value: "low", label: "Low" }, { value: "medium", label: "Med" }, { value: "high", label: "High" }, { value: "max", label: "Max" }]} />
          </Row>
          <Row label="Encoder" help="GPU keeps your FPS up">
            <Seg label="Encoder" value={draft.encoder} onChange={(v) => set("encoder", v)} options={[{ value: "auto", label: "Auto" }, { value: "nvenc", label: "NVENC" }, { value: "amf", label: "AMF" }, { value: "qsv", label: "Intel" }, { value: "cpu", label: "CPU" }]} />
          </Row>
          <Row label="File type" help="MKV survives crashes">
            <Seg label="File type" value={draft.format} onChange={(v) => set("format", v)} options={[{ value: "mp4", label: "MP4" }, { value: "mkv", label: "MKV" }]} />
          </Row>
        </Panel>

        <Panel title="Hotkey and replay" color="var(--warn)">
          <Row label="Save clip" help={listening ? "press the new key or combo · Esc cancels" : "works while you're in game"}>
            <span className="row">
              <span className="pill"><b>{draft.hotkey}</b></span>
              <button type="button" className={listening ? "b sm r" : "b sm"} onClick={() => setListening((l) => !l)} onKeyDown={captureHotkey} onBlur={() => setListening(false)}>
                {listening ? "Press a key…" : "Change"}
              </button>
            </span>
          </Row>
          <Row label="Clip length" help="how far back a hotkey clip goes"><Seg label="Clip length" value={draft.bufferSeconds} onChange={(v) => set("bufferSeconds", v)} options={opts([15, 30, 60, 120, 300])} /></Row>
          <Row label="Clip sound" help="a beep so you know it worked"><Toggle label="Clip sound" checked={draft.clipSound} onChange={(v) => set("clipSound", v)} /></Row>
        </Panel>
      </div>

      <div className="s4 col">
        <Panel title="Streamer clips" color="var(--twitch)" right={<span className="m tiny dim">after each match</span>}>
          <Row label="Auto-clip streamers" help="in your matches"><Toggle label="Auto-clip streamers" checked={draft.streamerAuto} onChange={(v) => set("streamerAuto", v)} /></Row>
          <Row label="When they killed you" help="turn off to skip every clip where the streamer killed you"><Toggle label="When they killed you" checked={draft.clipKilledYou} onChange={(v) => set("clipKilledYou", v)} /></Row>
          <Row label="When you killed them" help="their POV of your kill"><Toggle label="When you killed them" checked={draft.clipYouKilled} onChange={(v) => set("clipYouKilled", v)} /></Row>
          <Row label="Whole rounds" help="the full round instead of the fight"><Toggle label="Whole rounds" checked={draft.clipWholeRound} onChange={(v) => set("clipWholeRound", v)} /></Row>
          {nothingToClip && <p className="note warn">Everything above is off, so no streamer clips will be downloaded.</p>}
          <Row label="Seconds before" help="up to 2 minutes"><Seg label="Seconds before" value={draft.secondsBefore} onChange={(v) => set("secondsBefore", v)} options={PADS} /></Row>
          <Row label="Seconds after" help="up to 2 minutes"><Seg label="Seconds after" value={draft.secondsAfter} onChange={(v) => set("secondsAfter", v)} options={PADS} /></Row>
          <Row label="Download quality">
            <Seg label="Download quality" value={draft.downloadQuality} onChange={(v) => set("downloadQuality", v)} options={[{ value: "source", label: "Source" }, { value: "1080p", label: "1080p" }, { value: "720p", label: "720p" }]} />
          </Row>
          <Row label="Grab right after the match" help="saves fights while they're still live"><Toggle label="Grab right after the match" checked={draft.grabAfterMatch} onChange={(v) => set("grabAfterMatch", v)} /></Row>
          <Row label="Wait for a VOD" help="some streamers publish late"><Seg label="Wait for a VOD" value={draft.vodWaitHours} onChange={(v) => set("vodWaitHours", v)} options={opts([12, 24, 48], (v) => `${v} h`)} /></Row>
          <Row label="Side-by-side export" help="your POV next to theirs"><span className="pill">coming soon</span></Row>
          <Row label="VOD archives, YouTube, Kick" help="more places to find VODs"><span className="pill">coming soon</span></Row>
        </Panel>
      </div>

      <div className="s4 col">
        <Panel title="Account" color="var(--kick)" right={<span className="m tiny good">● {draft.serverUrl.replace(/^https?:\/\//, "")}</span>}>
          <Row label="Riot ID" help={riotIdOk ? "only used to find your matches" : "type it as Name#TAG"}>
            <input className="input" style={{ width: 170 }} placeholder="Name#TAG" value={draft.riotId} onChange={(e) => set("riotId", e.target.value)} aria-invalid={!riotIdOk} aria-label="Riot ID" spellCheck={false} />
          </Row>
          <Row label="Region">
            <select className="input" aria-label="Region" value={draft.region} onChange={(e) => set("region", e.target.value)}>
              {REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Row>
          <p className="note">Your PC never talks to Riot or the game. Match data comes from the CrossPOV server.</p>
        </Panel>

        <Panel title="Storage" color="var(--text)">
          <Row label="Clip folder" help={<span className="path">{draft.clipFolder || "Videos\\CrossPOV"}</span>}>
            <button type="button" className="b sm" onClick={() => void browse()} disabled={!isDesktop}>Change</button>
          </Row>
          <Row label="Space for clips">
            <Seg label="Space for clips" value={draft.storageLimitGb} onChange={(v) => set("storageLimitGb", v)} options={[{ value: 25, label: "25 GB" }, { value: 50, label: "50 GB" }, { value: 100, label: "100 GB" }, { value: 0, label: "No limit" }]} />
          </Row>
          <Row label="Delete oldest at the limit" help="your newest clip is always kept"><Toggle label="Delete oldest at the limit" checked={draft.pruneOldest} onChange={(v) => set("pruneOldest", v)} /></Row>
        </Panel>

        <Panel title="App" color="var(--warn)">
          <Row label="Start with Windows" help="starts quietly in the tray"><Toggle label="Start with Windows" checked={draft.startWithWindows} onChange={(v) => set("startWithWindows", v)} /></Row>
          <Row label="Close to tray" help="keeps recording ready"><Toggle label="Close to tray" checked={draft.minimizeToTray} onChange={(v) => set("minimizeToTray", v)} /></Row>
          <Row label="Notifications" help={'e.g. "3 streamer clips saved"'}><Toggle label="Notifications" checked={draft.notifications} onChange={(v) => set("notifications", v)} /></Row>
          <Row label="Version" help="Not endorsed by Riot Games"><span className="pill">v{__APP_VERSION__}</span></Row>
        </Panel>
      </div>
    </>
  );
}
