import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Pills, Toggle } from "../components/ui";
import { defaultClipFolder, isDesktop, pickFolder, saveSettings } from "../lib/backend";
import { DEFAULT_SETTINGS, estimateClipMb, targetMbps, type Settings as S } from "../lib/settings";

function Row({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        <span className="muted small">{help}</span>
      </div>
      {children}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="card settings-section">
      <div className="settings-head">
        <h2>{title}</h2>
        <span className="muted">{sub}</span>
      </div>
      {children}
    </section>
  );
}

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

export default function Settings({ settings, onSaved }: { settings: S; onSaved: (s: S) => void }) {
  const [draft, setDraft] = useState<S>(settings);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = <K extends keyof S>(key: K, value: S[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus("");
  };

  async function save() {
    setSaving(true);
    try {
      const stored = await saveSettings(draft);
      onSaved(stored);
      setStatus("Saved");
    } catch (err) {
      setStatus(`Could not save: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setDraft({ ...DEFAULT_SETTINGS, clipFolder: await defaultClipFolder() });
    setStatus("Defaults restored. Press Save to keep them.");
  }

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

  const mb = estimateClipMb(draft);
  const secOpts = [3, 5, 10, 15].map((v) => ({ value: v, label: `${v} s` }));

  return (
    <div className="settings-page">
      <header className="page-head">
        <div className="stack-6">
          <h1>Settings</h1>
          <span className="muted">
            Estimated clip size:{" "}
            <strong className="text">
              ~{Math.round(mb)} MB per {draft.bufferSeconds} s clip (~{Math.round(targetMbps(draft))} Mbps)
            </strong>
          </span>
        </div>
        <div className="row-wrap">
          <span className="muted" role="status">{status || (dirty ? "Unsaved changes" : "")}</span>
          <button type="button" className="btn" onClick={() => void reset()}>Reset to defaults</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <Section title="Recording" sub="Applies to clips you save with the hotkey.">
        <Row label="Frame rate" help="Higher looks smoother but makes bigger files.">
          <Pills label="Frame rate" value={draft.fps} onChange={(v) => set("fps", v)}
            options={[30, 60, 120, 144].map((v) => ({ value: v, label: String(v) }))} />
        </Row>
        <Row label="Resolution" help="Native records at your monitor resolution.">
          <Pills label="Resolution" value={draft.resolution} onChange={(v) => set("resolution", v)}
            options={[{ value: "native", label: "Native" }, { value: "1440p", label: "1440p" }, { value: "1080p", label: "1080p" }, { value: "720p", label: "720p" }]} />
        </Row>
        <Row label="Quality" help="Controls the bitrate. Higher means sharper and bigger files.">
          <Pills label="Quality" value={draft.quality} onChange={(v) => set("quality", v)}
            options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "max", label: "Max" }]} />
        </Row>
        <Row label="Encoder" help="GPU encoders barely affect in-game FPS. Auto picks the best one you have.">
          <select className="input select" aria-label="Encoder" value={draft.encoder} onChange={(e) => set("encoder", e.target.value as S["encoder"])}>
            <option value="auto">Auto (recommended)</option>
            <option value="nvenc">NVIDIA NVENC</option>
            <option value="amf">AMD AMF</option>
            <option value="qsv">Intel Quick Sync</option>
            <option value="x264">CPU (x264, slowest)</option>
          </select>
        </Row>
        <Row label="File format" help="MP4 plays everywhere. MKV survives crashes.">
          <Pills label="File format" value={draft.format} onChange={(v) => set("format", v)}
            options={[{ value: "mp4", label: "MP4" }, { value: "mkv", label: "MKV" }]} />
        </Row>
      </Section>

      <Section title="Hotkey and replay buffer" sub="CrossPOV keeps the last few seconds in memory. Press the hotkey to save them.">
        <Row label="Save clip hotkey" help={listening ? "Press the new key or combo. Esc cancels." : "Works while the game is focused."}>
          <div className="row-wrap">
            <kbd className="key">{draft.hotkey}</kbd>
            <button type="button" className={listening ? "btn primary" : "btn"} onClick={() => setListening((l) => !l)}
              onKeyDown={captureHotkey} onBlur={() => setListening(false)}>
              {listening ? "Press a key…" : "Change"}
            </button>
          </div>
        </Row>
        <Row label="Clip length" help="How far back a hotkey clip goes.">
          <Pills label="Clip length" value={draft.bufferSeconds} onChange={(v) => set("bufferSeconds", v)}
            options={[15, 30, 60, 90, 120].map((v) => ({ value: v, label: `${v} s` }))} />
        </Row>
        <Row label="Sound when a clip is saved" help="A short beep so you know it worked.">
          <Toggle label="Sound when a clip is saved" checked={draft.clipSound} onChange={(v) => set("clipSound", v)} />
        </Row>
      </Section>

      <Section title="Audio" sub="What gets recorded with your clips.">
        <Row label="Game audio" help="Record in-game sound.">
          <Toggle label="Game audio" checked={draft.gameAudio} onChange={(v) => set("gameAudio", v)} />
        </Row>
        <Row label="Microphone" help="Record your voice.">
          <Toggle label="Microphone" checked={draft.microphone} onChange={(v) => set("microphone", v)} />
        </Row>
        <Row label="Microphone device" help="Your devices are listed once the recorder is added.">
          <select className="input select" aria-label="Microphone device" value={draft.micDevice} onChange={(e) => set("micDevice", e.target.value)}>
            <option value="default">Default device</option>
          </select>
        </Row>
        <Row label="Separate audio tracks" help="Game and mic on separate tracks, easier to edit.">
          <Toggle label="Separate audio tracks" checked={draft.separateTracks} onChange={(v) => set("separateTracks", v)} />
        </Row>
      </Section>

      <Section title="Streamer clips" sub="Automatic. Runs after the match ends.">
        <Row label="Auto-clip streamers in my matches" help="Turn off to only use manual checks.">
          <Toggle label="Auto-clip streamers" checked={draft.streamerAuto} onChange={(v) => set("streamerAuto", v)} />
        </Row>
        <Row label="When they killed you" help="Clip their POV of killing you.">
          <Toggle label="When they killed you" checked={draft.clipKilledYou} onChange={(v) => set("clipKilledYou", v)} />
        </Row>
        <Row label="When you killed them" help="Clip their POV of you killing them.">
          <Toggle label="When you killed them" checked={draft.clipYouKilled} onChange={(v) => set("clipYouKilled", v)} />
        </Row>
        <Row label="Whole rounds you both fought in" help="Bigger clips with the full round.">
          <Toggle label="Whole rounds" checked={draft.clipWholeRound} onChange={(v) => set("clipWholeRound", v)} />
        </Row>
        <Row label="Seconds before the moment" help="Lead-in before the kill.">
          <Pills label="Seconds before" value={draft.secondsBefore} onChange={(v) => set("secondsBefore", v)} options={secOpts} />
        </Row>
        <Row label="Seconds after the moment" help="Time kept after the kill.">
          <Pills label="Seconds after" value={draft.secondsAfter} onChange={(v) => set("secondsAfter", v)} options={secOpts} />
        </Row>
        <Row label="Download quality" help="Source keeps the streamer's original quality.">
          <Pills label="Download quality" value={draft.downloadQuality} onChange={(v) => set("downloadQuality", v)}
            options={[{ value: "source", label: "Source" }, { value: "1080p", label: "1080p" }, { value: "720p", label: "720p" }]} />
        </Row>
        <Row label="Also make a side-by-side video" help="Your POV and theirs in one video, synced.">
          <Toggle label="Side-by-side video" checked={draft.sideBySide} onChange={(v) => set("sideBySide", v)} />
        </Row>
        <Row label="Grab right after the match" help="Saves your fights from their VOD while they're still live, in case it's deleted later.">
          <Toggle label="Grab right after the match" checked={draft.grabAfterMatch} onChange={(v) => set("grabAfterMatch", v)} />
        </Row>
        <Row label="Search VOD archive sites" help="Only when Twitch has no VOD. Never used for sub-only VODs.">
          <Toggle label="Search VOD archive sites" checked={draft.searchArchives} onChange={(v) => set("searchArchives", v)} />
        </Row>
        <Row label="Search YouTube and Kick" help="For streamers who upload or stream there too.">
          <Toggle label="Search YouTube and Kick" checked={draft.searchYoutubeKick} onChange={(v) => set("searchYoutubeKick", v)} />
        </Row>
        <Row label="Keep checking for VODs for" help="Some streamers publish VODs late.">
          <Pills label="Keep checking for" value={draft.vodWaitHours} onChange={(v) => set("vodWaitHours", v)}
            options={[12, 24, 48].map((v) => ({ value: v, label: `${v} h` }))} />
        </Row>
      </Section>

      <Section title="Storage" sub="Where clips go and how much space they can use.">
        <Row label="Clip folder" help="Hotkey clips and streamer clips go in separate subfolders.">
          <div className="row-wrap">
            <code className="path">{draft.clipFolder || "Default (Videos\\CrossPOV)"}</code>
            <button type="button" className="btn" onClick={() => void browse()} disabled={!isDesktop}>Browse</button>
          </div>
        </Row>
        <Row label="Storage limit" help="How much space clips may use in total.">
          <Pills label="Storage limit" value={draft.storageLimitGb} onChange={(v) => set("storageLimitGb", v)}
            options={[{ value: 25, label: "25 GB" }, { value: 50, label: "50 GB" }, { value: 100, label: "100 GB" }, { value: 0, label: "No limit" }]} />
        </Row>
        <Row label="Delete oldest clips when full" help="Favourited clips are never deleted.">
          <Toggle label="Delete oldest clips when full" checked={draft.pruneOldest} onChange={(v) => set("pruneOldest", v)} />
        </Row>
      </Section>

      <Section title="App" sub="General behaviour.">
        <Row label="Start with Windows" help="Starts quietly in the tray.">
          <Toggle label="Start with Windows" checked={draft.startWithWindows} onChange={(v) => set("startWithWindows", v)} />
        </Row>
        <Row label="Keep running in the tray when closed" help="Closing the window frees its memory; recording stays ready.">
          <Toggle label="Keep running in the tray" checked={draft.minimizeToTray} onChange={(v) => set("minimizeToTray", v)} />
        </Row>
        <Row label="Notifications" help={'For example "3 streamer clips saved".'}>
          <Toggle label="Notifications" checked={draft.notifications} onChange={(v) => set("notifications", v)} />
        </Row>
      </Section>
    </div>
  );
}
