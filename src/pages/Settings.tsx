import { lazy, Suspense, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Broadcast, CheckCircle, GameController, Keyboard, SpeakerHigh, UserCircle, VideoCamera, type Icon } from "@phosphor-icons/react";
import { confirmDialog } from "../components/Dialog";
import { Keycap } from "../components/TopBar";
import { Select } from "../components/Select";
import { AppIcon, Panel, Row, SaveState, Seg, Toggle } from "../components/ui";
import { diagnostics, isDesktop, knownGames, pickFolder, pickGameExe } from "../lib/backend";
import { estimateClipMb, REGIONS, targetMbps, type Quality, type Resolution, type Settings as S } from "../lib/settings";
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
const PADS = opts([15, 30, 60, 90, 120], (v) => `${v} seconds`);

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

type Section = "games" | "recording" | "hotkey" | "streamers" | "audio" | "account";
// In the order other clipping apps use: recording first, then hotkeys and audio.
const SECTIONS: { id: Section; label: string; Icon: Icon; about: string }[] = [
  { id: "recording", label: "Recording", Icon: VideoCamera, about: "How your clips look: quality, resolution, frame rate and file type." },
  { id: "hotkey", label: "Hotkeys", Icon: Keyboard, about: "Save the last moments of your game with one key, in any game." },
  { id: "audio", label: "Audio", Icon: SpeakerHigh, about: "Which sounds go into your clips, how loud, and your microphone." },
  { id: "games", label: "Games", Icon: GameController, about: "Which games and programs CrossPOV records." },
  { id: "streamers", label: "Streamer clips", Icon: Broadcast, about: "Download the streamer's side of your fights from their Twitch VOD." },
  { id: "account", label: "Account", Icon: UserCircle, about: "Your Riot ID, where clips are kept, and how the app starts." },
];

/** Category header: the title and one line on what's inside. Type does the work, no icon tile. */
function CategoryHead({ section, right }: { section: Section; right?: ReactNode }) {
  const s = SECTIONS.find((x) => x.id === section)!;
  return (
    <header className="settings-head">
      <span className="settings-title">
        <h2>{s.label}</h2>
        <p>{s.about}</p>
      </span>
      {right}
    </header>
  );
}

/** One-click quality, like Medal; Custom opens every option. */
const PRESETS: { id: string; label: string; about: string; v: { resolution: Resolution; fps: number; quality: Quality; bitrateMbps: number } }[] = [
  { id: "low", label: "Low", about: "720p · 30 FPS · for older PCs, small files", v: { resolution: "720p", fps: 30, quality: "low", bitrateMbps: 0 } },
  { id: "standard", label: "Standard", about: "1080p · 60 FPS · the best balance", v: { resolution: "1080p", fps: 60, quality: "medium", bitrateMbps: 0 } },
  { id: "high", label: "High", about: "1440p · 60 FPS · sharper, bigger files", v: { resolution: "1440p", fps: 60, quality: "high", bitrateMbps: 0 } },
];
const presetOf = (d: S) => PRESETS.find((p) => p.v.resolution === d.resolution && p.v.fps === d.fps && p.v.quality === d.quality && p.v.bitrateMbps === d.bitrateMbps)?.id ?? "custom";

/** Settings: the topics in a list on the left, the chosen one on the right. Changes save by themselves. */
const BITRATES = [10, 15, 20, 30, 40, 50, 75, 100, 150];

/** Bitrate in Mbps: Auto, a common value, or any number you type. */
function BitratePicker({ value, auto, onChange }: { value: number; auto: number; onChange: (v: number) => void }) {
  const [custom, setCustom] = useState(value > 0 && !BITRATES.includes(value));
  const [text, setText] = useState(value > 0 ? String(value) : "");
  const commit = () => {
    const n = Math.round(Number(text));
    if (Number.isFinite(n) && n > 0) onChange(Math.min(300, Math.max(2, n)));
  };
  return (
    <span className="row" style={{ gap: 8 }}>
      <Select
        label="Bitrate"
        value={custom ? "custom" : String(value)}
        onChange={(v) => {
          if (v === "custom") {
            setCustom(true);
            setText(String(value || Math.round(auto)));
            return;
          }
          setCustom(false);
          onChange(Number(v));
        }}
        options={[{ value: "0", label: `Auto (${Math.round(auto)} Mbps)` }, ...BITRATES.map((b) => ({ value: String(b), label: `${b} Mbps` })), { value: "custom", label: "Custom…" }]}
      />
      {custom && (
        <input
          className="input"
          style={{ width: 90 }}
          type="number"
          min={2}
          max={300}
          aria-label="Custom bitrate in Mbps"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      )}
      {custom && <span className="muted">Mbps</span>}
    </span>
  );
}

/** Whether CrossPOV's own player can play H.265 on this PC (needs the
 * graphics card's decoder, and on some PCs Windows' HEVC extension). */
const h265Plays = (() => {
  try {
    return document.createElement("video").canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"') !== "";
  } catch {
    return false;
  }
})();

export default function SettingsPage({ settings, onSaved }: { settings: S; onSaved: (s: S) => void }) {
  const [tab, setTab] = useState<Section>("recording");
  return (
    <section className="settings-layout" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? "true" : undefined} onClick={() => setTab(t.id)}>
            <t.Icon size={18} weight={tab === t.id ? "fill" : "regular"} aria-hidden />
            {t.label}
          </button>
        ))}
      </nav>
      <div key={tab} className="settings-body">
        {tab === "audio" ? (
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <CategoryHead section="audio" />
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

  async function commit() {
    const id = text.trim();
    if (same(id, value) || !ok) return;
    if (
      value.trim() &&
      !(await confirmDialog({ title: `Switch to ${id || "no account"}?`, body: `Your match history for ${value.trim()} will be cleared. Your clips stay.`, confirm: "Switch account", danger: true }))
    ) {
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
      onBlur={() => void commit()}
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
  const preset = presetOf(draft);
  const [customOpen, setCustomOpen] = useState(preset === "custom");

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
      <CategoryHead section={section} right={<SaveState d={d} />} />

      {section === "games" && <Games draft={draft} set={set} />}

      {section === "recording" && (
        <>
        <Panel title="Quality">
          <div className="presets" role="radiogroup" aria-label="Quality preset">
            {[...PRESETS, { id: "custom", label: "Custom", about: "Pick every setting yourself" }].map((p) => {
              const on = (customOpen ? "custom" : preset) === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className="preset"
                  onClick={() => {
                    if (p.id === "custom") return setCustomOpen(true);
                    setCustomOpen(false);
                    const v = PRESETS.find((x) => x.id === p.id)!.v;
                    for (const k of Object.keys(v) as (keyof typeof v)[]) set(k, v[k] as never);
                  }}
                >
                  <b>{p.label}{on && <CheckCircle size={16} weight="fill" aria-hidden className="preset-check" />}</b>
                  <span>{p.about}</span>
                </button>
              );
            })}
          </div>
          {(customOpen || preset === "custom") && (
            <div className="custom-grid">
              <label><span>Resolution</span><Select label="Resolution" value={draft.resolution} onChange={(v) => set("resolution", v)} options={[{ value: "native", label: "Native (your monitor)" }, { value: "1440p", label: "1440p" }, { value: "1080p", label: "1080p" }, { value: "720p", label: "720p" }]} /></label>
              <label><span>Frame rate</span><Select label="Frame rate" value={draft.fps} onChange={(v) => set("fps", v)} options={opts([30, 60, 120, 144, 240], (v) => `${v} FPS`)} /></label>
              <label><span>Quality</span><Select<Quality> label="Quality" value={draft.quality} onChange={(v) => set("quality", v)} options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "max", label: "Max" }]} /></label>
              <label><span>Bitrate</span><BitratePicker value={draft.bitrateMbps} auto={targetMbps({ ...draft, bitrateMbps: 0 })} onChange={(v) => set("bitrateMbps", v)} /></label>
              <label><span>Encoder</span><Select label="Encoder" value={draft.encoder} onChange={(v) => set("encoder", v)} options={[{ value: "auto", label: "Auto (GPU when possible)" }, { value: "nvenc", label: "NVIDIA (NVENC)" }, { value: "amf", label: "AMD (AMF)" }, { value: "qsv", label: "Intel (Quick Sync)" }, { value: "cpu", label: "CPU" }]} /></label>
            </div>
          )}
          <p className="note">About {Math.round(targetMbps(draft))} Mbps, so a {draft.bufferSeconds} s clip is about {Math.round(estimateClipMb(draft))} MB.</p>
        </Panel>
        <Panel title="Video file">
          <Row
            label="Capture"
            help={
              draft.captureMode === "window"
                ? "Game window: other windows never show up, but Windows hands over game frames unevenly, so clips can look choppy"
                : "Whole screen: smooth, every frame your monitor shows"
            }
          >
            <Seg label="Capture" value={draft.captureMode} onChange={(v) => set("captureMode", v)} options={[{ value: "screen", label: "Whole screen" }, { value: "window", label: "Game window" }]} />
          </Row>
          <Row
            label="Stretched resolutions"
            help={
              draft.stretched === "keep"
                ? "Keep the game's pixels: recorded exactly as drawn (e.g. 1568×1080), the sharpest"
                : "Stretch like in-game: enlarged and shown at 16:9, as on your monitor"
            }
          >
            <Seg label="Stretched resolutions" value={draft.stretched} onChange={(v) => set("stretched", v)} options={[{ value: "keep", label: "Keep pixels" }, { value: "stretch", label: "Stretch" }]} />
          </Row>
          <Row
            label="Video format"
            help={
              h265Plays
                ? "H.265 is sharper at the same size · Copy for Discord still makes H.264"
                : "H.265 isn't available: this PC can't play it back"
            }
          >
            <Seg
              label="Video format"
              value={draft.codec}
              onChange={(v) => set("codec", v)}
              options={[{ value: "h264", label: "H.264" }, ...(h265Plays || draft.codec === "h265" ? [{ value: "h265" as const, label: "H.265" }] : [])]}
            />
          </Row>
          <Row label="File type" help="MKV survives crashes">
            <Seg label="File type" value={draft.format} onChange={(v) => set("format", v)} options={[{ value: "mp4", label: "MP4" }, { value: "mkv", label: "MKV" }]} />
          </Row>
        </Panel>
        </>
      )}

      {section === "hotkey" && (
        <>
        <Panel title="Hotkeys">
          <div className="hotkey-row">
            <span className="hotkey-name"><b>Save clip</b><small>{listening ? "Press the new key or combo · Esc cancels" : "Saves what just happened"}</small></span>
            <button type="button" className={listening ? "keybox listening" : "keybox"} onClick={() => setListening((l) => !l)} onKeyDown={captureHotkey} onBlur={() => setListening(false)} title="Click, then press a key">
              {listening ? "Press a key…" : draft.hotkey.split("+").map((k) => <Keycap key={k}>{k}</Keycap>)}
            </button>
            <Select label="Clip length" value={draft.bufferSeconds} onChange={(v) => set("bufferSeconds", v)} options={opts([15, 30, 60, 120, 300], (v) => (v > 60 ? `${v / 60} minutes` : `${v} seconds`))} />
          </div>
          <Row label="Clip sound" help="a beep so you know it worked"><Toggle label="Clip sound" checked={draft.clipSound} onChange={(v) => set("clipSound", v)} /></Row>
          <p className="note">A {draft.bufferSeconds} s clip is about {Math.round(estimateClipMb(draft))} MB at your quality setting.</p>
        </Panel>
        </>
      )}

      {section === "streamers" && (
        <>
        <Panel title="What to clip">
          <Row label="Auto-clip streamers" help="in your matches"><Toggle label="Auto-clip streamers" checked={draft.streamerAuto} onChange={(v) => set("streamerAuto", v)} /></Row>
          <Row label="When they killed you" help="turn off to skip every clip where the streamer killed you"><Toggle label="When they killed you" checked={draft.clipKilledYou} onChange={(v) => set("clipKilledYou", v)} /></Row>
          <Row label="When you killed them" help="their POV of your kill"><Toggle label="When you killed them" checked={draft.clipYouKilled} onChange={(v) => set("clipYouKilled", v)} /></Row>
          <Row label="Whole rounds" help="the full round instead of the fight"><Toggle label="Whole rounds" checked={draft.clipWholeRound} onChange={(v) => set("clipWholeRound", v)} /></Row>
          {nothingToClip && <p className="note warn">Everything above is off, so no streamer clips will be downloaded.</p>}
        </Panel>
        <Panel title="Timing and quality">
          <Row label="Seconds before" help="up to 2 minutes"><Seg label="Seconds before" value={draft.secondsBefore} onChange={(v) => set("secondsBefore", v)} options={PADS} /></Row>
          <Row label="Seconds after" help="up to 2 minutes"><Seg label="Seconds after" value={draft.secondsAfter} onChange={(v) => set("secondsAfter", v)} options={PADS} /></Row>
          <Row label="Download quality">
            <Seg label="Download quality" value={draft.downloadQuality} onChange={(v) => set("downloadQuality", v)} options={[{ value: "source", label: "Source" }, { value: "1080p", label: "1080p" }, { value: "720p", label: "720p" }]} />
          </Row>
          <Row label="Grab right after the match" help="saves fights while they're still live"><Toggle label="Grab right after the match" checked={draft.grabAfterMatch} onChange={(v) => set("grabAfterMatch", v)} /></Row>
          <Row label="Wait for a VOD" help="some streamers publish late"><Seg label="Wait for a VOD" value={draft.vodWaitHours} onChange={(v) => set("vodWaitHours", v)} options={opts([12, 24, 48], (v) => `${v} h`)} /></Row>
        </Panel>
        </>
      )}

      {section === "account" && (
        <>
        <Panel title="Riot account">
          <Row label="Riot ID" help="only used to find your matches · switching accounts clears your match history">
            <RiotIdField value={draft.riotId} onCommit={(id) => set("riotId", id)} />
          </Row>
          <Row label="Region">
            <Select label="Region" value={draft.region} onChange={(v) => set("region", v)} options={REGIONS.map((r) => ({ value: r.value, label: r.label }))} />
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
            void confirmDialog({ title: "Reset all settings?", body: "Everything goes back to its default. Your Riot ID, region and clips stay.", confirm: "Reset settings", danger: true }).then((yes) => yes && void d.reset());
          }}
        >
          Reset all settings to defaults
        </button>
        </>
      )}
    </>
  );
}

/** Which games are recorded: fullscreen apps, the built-in list, and yours. */
function Games({ draft, set }: { draft: S; set: <K extends keyof S>(key: K, value: S[K]) => void }) {
  const [known, setKnown] = useState<string[]>([]);
  const [showKnown, setShowKnown] = useState(false);
  useEffect(() => {
    knownGames().then(setKnown, () => setKnown([]));
  }, []);

  async function add() {
    const exe = await pickGameExe();
    if (!exe || draft.customGames.some((g) => g.exe.toLowerCase() === exe.toLowerCase())) return;
    const name = exe.replace(/\.exe$/i, "");
    set("customGames", [...draft.customGames, { exe, name }]);
    // Adding a game you'd told CrossPOV to skip means you want it after all.
    set("ignoredGames", draft.ignoredGames.filter((e) => e.toLowerCase() !== exe.toLowerCase()));
  }

  return (
    <>
      <Panel title="What counts as a game">
        <Row label="Fullscreen apps" help="anything running fullscreen or borderless fullscreen is recorded, except browsers, video players and launchers">
          <Toggle label="Record fullscreen apps" checked={draft.recordFullscreen} onChange={(v) => set("recordFullscreen", v)} />
        </Row>
        <Row label="Games CrossPOV knows" help={`${known.length || "70+"} popular games, recorded even in a window`}>
          <button type="button" className="b sm" onClick={() => setShowKnown((v) => !v)} aria-expanded={showKnown}>{showKnown ? "Hide list" : "Show list"}</button>
        </Row>
        {showKnown && <p className="note">{known.join(" · ")}</p>}
        <p className="note">Streamer clips (their side of your fights) are for VALORANT only. Your own clips work in every game.</p>
      </Panel>

      <Panel title="Your games" right={<button type="button" className="b sm" onClick={() => void add()} disabled={!isDesktop}>Add a game</button>}>
        {draft.customGames.length ? (
          draft.customGames.map((g) => (
            <Row key={g.exe} label={g.name} help={<span className="path">{g.exe}</span>} icon={<AppIcon exe={g.exe} name={g.name} />}>
              <button type="button" className="b sm" onClick={() => set("customGames", draft.customGames.filter((x) => x.exe !== g.exe))}>Remove</button>
            </Row>
          ))
        ) : (
          <p className="note">A game that isn't recorded? Add its program (.exe) and it's recorded whenever it's open, fullscreen or not.</p>
        )}
      </Panel>

      {draft.ignoredGames.length > 0 && (
        <Panel title="Never recorded">
          {draft.ignoredGames.map((exe) => (
            <Row key={exe} label={exe.replace(/\.exe$/i, "")} help={<span className="path">{exe}</span>} icon={<AppIcon exe={exe} name={exe} />}>
              <button type="button" className="b sm" onClick={() => set("ignoredGames", draft.ignoredGames.filter((e) => e !== exe))}>Record it again</button>
            </Row>
          ))}
        </Panel>
      )}
    </>
  );
}
