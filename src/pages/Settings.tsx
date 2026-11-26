import { lazy, Suspense, useEffect, useState, type KeyboardEvent } from "react";
import { Panel, Row, SaveState, Seg, Toggle } from "../components/ui";
import { diagnostics, isDesktop, pickFolder } from "../lib/backend";
import { estimateClipMb, REGIONS, targetMbps, type Settings as S } from "../lib/settings";
import { same, validRiotId } from "../lib/riotId";
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

/** "Copy diagnostics": what the app is doing, ready to paste into a message when something's wrong. */
function ProblemReport() {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    const report = await diagnostics().catch((err) => `Couldn't collect diagnostics: ${String(err)}`);
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setText(null);
    } catch {
      setText(report); // clipboard blocked: show it to copy by hand
    }
  }
  return (
    <>
      <Row label="Something not working?" help={copied ? "Copied. Paste it into your message to us." : "copies a short report (versions, errors, settings) to paste when asking for help"}>
        <button type="button" className="b sm" onClick={() => void copy()}>Copy diagnostics</button>
      </Row>
      {text && <textarea className="input" readOnly value={text} rows={10} style={{ margin: "0 18px 16px", height: "auto", fontFamily: "var(--mono)", fontSize: 12 }} aria-label="Diagnostics" />}
    </>
  );
}

type Section = "recording" | "hotkey" | "streamers" | "audio" | "account";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "recording", label: "Recording" },
  { id: "hotkey", label: "Hotkey and replay" },
  { id: "streamers", label: "Streamer clips" },
  { id: "audio", label: "Audio" },
  { id: "account", label: "Account and app" },
];

/** Settings: the topics in a list on the left, the chosen one on the right. Changes save by themselves. */
export default function SettingsPage({ settings, onSaved }: { settings: S; onSaved: (s: S) => void }) {
  const [tab, setTab] = useState<Section>("recording");
  return (
    <section className="settings-layout" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? "true" : undefined} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>
      <div className="settings-body">
        {tab === "audio" ? (
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <div className="settings-audio"><Audio settings={settings} onSaved={onSaved} /></div>
          </Suspense>
        ) : (
          <GeneralSettings settings={settings} onSaved={onSaved} section={tab} />
        )}
      </div>
    </section>
  );
}

/**
 * Riot ID: saved when you leave the box or press Enter, not on every key,
 * because switching to another account clears the match history.
 */
function RiotIdField({ value, onCommit }: { value: string; onCommit: (id: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const ok = text.trim() === "" || validRiotId(text);

  function commit() {
    const id = text.trim();
    if (same(id, value) || !ok) return;
    if (value.trim() && !window.confirm(`Switch to ${id || "no account"}? Your match history for ${value.trim()} will be cleared. Your clips stay.`)) {
      setText(value);
      return;
    }
    onCommit(id);
  }

  return (
    <input
      className="input"
      style={{ width: 190 }}
      placeholder="Name#TAG"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(value);
      }}
      aria-invalid={!ok}
      aria-label="Riot ID"
      spellCheck={false}
    />
  );
}

function GeneralSettings({ settings, onSaved, section }: { settings: S; onSaved: (s: S) => void; section: Section }) {
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

  const nothingToClip = draft.streamerAuto && !draft.clipKilledYou && !draft.clipYouKilled && !draft.clipWholeRound;

  return (
    <>
      <header className="settings-head">
        <h2>{SECTIONS.find((x) => x.id === section)?.label}</h2>
        <SaveState d={d} />
      </header>

      {section === "recording" && (
        <>
        <Panel title="Recording">
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
        </>
      )}

      {section === "hotkey" && (
        <>
        <Panel title="Hotkey and replay">
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
          <p className="note">About {Math.round(targetMbps(draft))} Mbps, so a {draft.bufferSeconds} s clip is about {Math.round(estimateClipMb(draft))} MB.</p>
        </Panel>
        </>
      )}

      {section === "streamers" && (
        <Panel title="Streamer clips">
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
        </Panel>
      )}

      {section === "account" && (
        <>
        <Panel title="Account">
          <Row label="Riot ID" help="only used to find your matches · switching accounts clears your match history">
            <RiotIdField value={draft.riotId} onCommit={(id) => set("riotId", id)} />
          </Row>
          <Row label="Region">
            <select className="input" aria-label="Region" value={draft.region} onChange={(e) => set("region", e.target.value)}>
              {REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Row>
          <p className="note">Your PC never talks to Riot or the game. Match data comes from the CrossPOV server.</p>
        </Panel>

        <Panel title="Storage">
          <Row label="Clip folder" help={<span className="path">{draft.clipFolder || "Videos\\CrossPOV"}</span>}>
            <button type="button" className="b sm" onClick={() => void browse()} disabled={!isDesktop}>Change</button>
          </Row>
          <Row label="Space for clips">
            <Seg label="Space for clips" value={draft.storageLimitGb} onChange={(v) => set("storageLimitGb", v)} options={[{ value: 25, label: "25 GB" }, { value: 50, label: "50 GB" }, { value: 100, label: "100 GB" }, { value: 0, label: "No limit" }]} />
          </Row>
          <Row label="Delete oldest at the limit" help="your newest clip is always kept"><Toggle label="Delete oldest at the limit" checked={draft.pruneOldest} onChange={(v) => set("pruneOldest", v)} /></Row>
        </Panel>

        <Panel title="App">
          <Row label="Start with Windows" help="starts quietly in the tray"><Toggle label="Start with Windows" checked={draft.startWithWindows} onChange={(v) => set("startWithWindows", v)} /></Row>
          <Row label="Close to tray" help="keeps recording ready"><Toggle label="Close to tray" checked={draft.minimizeToTray} onChange={(v) => set("minimizeToTray", v)} /></Row>
          <Row label="Notifications" help={'e.g. "3 streamer clips saved"'}><Toggle label="Notifications" checked={draft.notifications} onChange={(v) => set("notifications", v)} /></Row>
          <Row label="Version" help="Not endorsed by Riot Games"><span className="pill">v{__APP_VERSION__}</span></Row>
          <ProblemReport />
        </Panel>
        <button
          type="button"
          className="linkish muted small"
          style={{ alignSelf: "flex-start" }}
          onClick={() => {
            if (window.confirm("Reset all settings to their defaults? Your Riot ID, region and clips stay.")) void d.reset();
          }}
        >
          Reset all settings to defaults
        </button>
        </>
      )}
    </>
  );
}
