//! All recording goes through OBS Studio (the slim, unmodified copy tools.rs
//! downloads). OBS's Game Capture takes a game's frames from the game itself
//! (its own signed hook, which Vanguard allows), so it records games that
//! Windows shows straight on the screen, where Windows' capture APIs saw
//! what's behind the game instead. Whole-screen mode uses OBS's Display
//! Capture.
//!
//! OBS starts hidden as soon as CrossPOV does and stays running (ready in an
//! instant when a game starts), in portable mode (its settings in its own
//! folder, apart from any OBS the user has), tied to CrossPOV (closes with
//! it), with no window and no tray icon. CrossPOV drives it through
//! obs-websocket on 127.0.0.1 with a random password: what to capture, the
//! sound, and a replay buffer; F9 saves the replay.

use std::{
    fs,
    io::{self, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::Child,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ffmpeg::VideoEncoder;

/// Settings OBS starts with (its profile). A change restarts OBS.
#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub encoder: VideoEncoder,
    pub hevc: bool,
    pub kbps: u32,
    pub buffer_seconds: u32,
    /// "mp4" or "mkv".
    pub format: &'static str,
    /// The mic on its own track (track 2).
    pub separate_tracks: bool,
    /// Where OBS writes saved replays before CrossPOV moves them.
    pub replay_dir: PathBuf,
}

/// What OBS records.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// A game, by its .exe and window class (Game Capture).
    Game { exe: String, class: String },
    /// The monitor whose top-left corner is at this desktop position
    /// (Display Capture), with the game (exe, window class) on top through
    /// Game Capture while it's in front (see `show_game`): Windows can hand a
    /// full-screen game straight to the monitor, past what screen capture sees.
    Screen { origin: (i32, i32), game: Option<(String, String)> },
}

/// What to record right now. A change is applied to the running OBS.
#[derive(Debug, Clone, PartialEq)]
pub struct Capture {
    pub source: Source,
    /// OBS's canvas (the picture's size) and the recorded size.
    pub size: (u32, u32),
    pub out_size: (u32, u32),
    pub fps: u32,
    /// The game's sound, or all desktop sound (volume 0..1).
    pub game_audio: Option<f32>,
    pub desktop_audio: bool,
    /// Extra apps' sound: (.exe, volume 0..1).
    pub apps: Vec<(String, f32)>,
    /// The mic (volume 0..1), which one ("default", or its name as Windows
    /// shows it, as in Settings), and its noise suppression.
    pub mic: Option<f32>,
    pub mic_device: String,
    pub denoise_mic: bool,
    pub separate_tracks: bool,
}

const VIDEO: &str = "CrossPOV Video";
const GAME_AUDIO: &str = "CrossPOV Game Audio";
const DESKTOP_AUDIO: &str = "CrossPOV Desktop Audio";
const MIC: &str = "CrossPOV Mic";
const APP_AUDIO: &str = "CrossPOV App";
const PROFILE: &str = "CrossPOV";

/// The running OBS.
pub struct Obs {
    child: Child,
    ws: Ws,
    next_id: u64,
    /// Events that came in while waiting for a request's answer.
    events: Vec<Value>,
    config: PathBuf,
    pub profile: Profile,
    /// What it records now (None: idle).
    pub capture: Option<Capture>,
    /// Inputs CrossPOV made, to remove when the capture changes.
    inputs: Vec<String>,
    /// The Game Capture layer over the screen (scene, item id), and whether it shows.
    game_layer: Option<(String, i64, bool)>,
    /// Counts `apply` calls: each gives its sources new names (see `apply`).
    round: u32,
}

impl Drop for Obs {
    fn drop(&mut self) {
        let _ = self.request("StopReplayBuffer", json!({}));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Obs {
    /// Starts OBS from `obs_dir` (holding bin\64bit\obs64.exe), hidden and
    /// idle, and connects to it.
    pub fn launch(obs_dir: &Path, profile: Profile) -> Result<Obs, String> {
        let config = obs_dir.join("config").join("obs-studio");
        let port = free_port().ok_or("no free local port for OBS")?;
        let password = random_hex(16);
        write_config(&config, &profile, port, &password).map_err(|e| format!("Couldn't write OBS's settings: {e}"))?;
        fs::create_dir_all(&profile.replay_dir).map_err(|e| e.to_string())?;

        let bin = obs_dir.join("bin").join("64bit");
        let mut cmd = std::process::Command::new(bin.join("obs64.exe"));
        cmd.current_dir(&bin).args([
            "--portable",
            "--minimize-to-tray",
            "--disable-updater",
            "--disable-shutdown-check",
            "--disable-missing-files-check",
            "--multi",
            "--profile",
            PROFILE,
            "--collection",
            PROFILE,
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window; OBS's own window starts in the tray.
            cmd.creation_flags(0x0800_0000);
        }
        let child = cmd.spawn().map_err(|e| format!("Couldn't start OBS: {e}"))?;
        crate::procs::tie_to_app(&child);

        // OBS takes a few seconds to load; its websocket comes up with it
        // (and answers "not ready" until it has: see request).
        let deadline = Instant::now() + Duration::from_secs(60);
        let ws = loop {
            match Ws::connect(port).and_then(|mut ws| identify(&mut ws, &password).map(|_| ws)) {
                Ok(ws) => break ws,
                Err(e) if Instant::now() > deadline => {
                    let mut child = child;
                    let _ = child.kill();
                    return Err(format!("OBS didn't answer ({e})"));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(500)),
            }
        };
        let mut obs = Obs { child, ws, next_id: 1, events: Vec::new(), config, profile, capture: None, inputs: Vec::new(), game_layer: None, round: 0 };
        // Ready: the first request waits until OBS has finished loading.
        obs.request("GetVersion", json!({}))?;
        hide_tray_icon(obs.child.id());
        hide_windows(obs.child.id());
        Ok(obs)
    }

    /// Records `capture` from now on (`title`: the game window's title, for
    /// finding it), or nothing (None). The replay buffer restarts.
    pub fn apply(&mut self, capture: Option<Capture>, title: &str) -> Result<(), String> {
        let _ = self.request("StopReplayBuffer", json!({}));
        self.wait_replay_buffer_stopped();
        for name in std::mem::take(&mut self.inputs) {
            let _ = self.request("RemoveInput", json!({ "inputName": name }));
        }
        self.capture = None;
        self.game_layer = None;
        let Some(c) = capture else {
            // No game: a tiny, slow canvas, so OBS waiting in the background
            // costs next to nothing (it draws its canvas all the time).
            let _ = self.request(
                "SetVideoSettings",
                json!({ "baseWidth": 320, "baseHeight": 180, "outputWidth": 320, "outputHeight": 180, "fpsNumerator": 5, "fpsDenominator": 1 }),
            );
            return Ok(());
        };
        // New names every time: OBS keeps a removed source's name taken for
        // as long as anything still holds the source (seconds, or longer),
        // and creating one under the old name then fails ("already exists").
        self.round += 1;
        let r = self.round;
        let (video, game_audio, desktop_audio, mic) = (format!("{VIDEO} {r}"), format!("{GAME_AUDIO} {r}"), format!("{DESKTOP_AUDIO} {r}"), format!("{MIC} {r}"));

        self.request(
            "SetVideoSettings",
            json!({ "baseWidth": c.size.0, "baseHeight": c.size.1, "outputWidth": c.out_size.0, "outputHeight": c.out_size.1, "fpsNumerator": c.fps, "fpsDenominator": 1 }),
        )?;
        let scene = self.request("GetCurrentProgramScene", json!({}))?;
        let scene = scene.get("currentProgramSceneName").or_else(|| scene.get("sceneName")).and_then(Value::as_str).unwrap_or("Scene").to_string();

        let game_capture = |exe: &str, class: &str| {
            json!({
                "capture_mode": "window", "window": window_spec(title, class, exe), "priority": 2,
                "anti_cheat_hook": true, "capture_cursor": false, "capture_overlays": false,
                "allow_transparency": false, "limit_framerate": false, "hook_rate": 1
            })
        };
        match &c.source {
            Source::Game { exe, class } => {
                self.create(&scene, &video, "game_capture", game_capture(exe, class))?;
            }
            Source::Screen { origin, game } => {
                // Display Capture, Windows 10 method; the monitor is picked by
                // its position among those OBS lists ("... @ 0,0 ...").
                self.create(&scene, &video, "monitor_capture", json!({ "method": 2, "capture_cursor": false }))?;
                let at = format!("@ {},{}", origin.0, origin.1);
                if let Ok(list) = self.request("GetInputPropertiesListPropertyItems", json!({ "inputName": video, "propertyName": "monitor_id" })) {
                    let items = list["propertyItems"].as_array().cloned().unwrap_or_default();
                    if let Some(item) = items.iter().find(|i| i["itemName"].as_str().is_some_and(|n| n.contains(&at))) {
                        let _ = self.request("SetInputSettings", json!({ "inputName": video, "inputSettings": { "monitor_id": item["itemValue"] } }));
                    }
                }
                // The game on top, filling the screen (until it's hooked it
                // shows nothing, so the screen below shows through).
                if let Some((exe, class)) = game {
                    let layer = format!("{VIDEO} game {r}");
                    if let Some(id) = self.create(&scene, &layer, "game_capture", game_capture(exe, class))? {
                        let _ = self.request(
                            "SetSceneItemTransform",
                            json!({ "sceneName": scene, "sceneItemId": id, "sceneItemTransform": {
                                "boundsType": "OBS_BOUNDS_SCALE_INNER", "boundsWidth": c.size.0 as f64, "boundsHeight": c.size.1 as f64,
                                "boundsAlignment": 0, "alignment": 5, "positionX": 0.0, "positionY": 0.0
                            } }),
                        );
                        self.game_layer = Some((scene.clone(), id, true));
                    }
                }
            }
        }

        // Track 1: everything, or all but the mic (on track 2).
        let tracks = |one: bool, two: bool| json!({ "1": one, "2": two, "3": false, "4": false, "5": false, "6": false });
        let window_of = |exe: &str, class: &str, title: &str| window_spec(title, class, exe);
        if let Some(vol) = c.game_audio {
            if c.desktop_audio {
                self.create(&scene, &desktop_audio, "wasapi_output_capture", json!({ "device_id": "default" }))?;
                self.audio(&desktop_audio, vol, tracks(true, false));
            } else if let Some((exe, class)) = match &c.source {
                Source::Game { exe, class } => Some((exe, class)),
                Source::Screen { game, .. } => game.as_ref().map(|(e, c)| (e, c)),
            } {
                self.create(&scene, &game_audio, "wasapi_process_output_capture", json!({ "window": window_of(exe, class, title), "priority": 2 }))?;
                self.audio(&game_audio, vol, tracks(true, false));
            }
        }
        if !c.desktop_audio {
            for (i, (exe, vol)) in c.apps.iter().enumerate() {
                let name = format!("{APP_AUDIO} {r}.{}", i + 1);
                if self.create(&scene, &name, "wasapi_process_output_capture", json!({ "window": window_of(exe, "", ""), "priority": 2 })).is_ok() {
                    self.audio(&name, *vol, tracks(true, false));
                }
            }
        }
        if let Some(vol) = c.mic {
            self.create(&scene, &mic, "wasapi_input_capture", json!({ "device_id": "default" }))?;
            self.pick_mic(&mic, &c.mic_device);
            self.audio(&mic, vol, tracks(!c.separate_tracks, c.separate_tracks));
            if c.denoise_mic {
                let _ = self.request(
                    "CreateSourceFilter",
                    json!({ "sourceName": mic, "filterName": "Noise suppression", "filterKind": "noise_suppress_filter_v2", "filterSettings": { "method": "rnnoise" } }),
                );
            }
        }
        self.start_replay_buffer()?;
        self.capture = Some(c);
        Ok(())
    }

    /// Points the mic input at the chosen microphone, like OBS's own device
    /// list: by its name among the devices OBS lists. "default" (or a mic
    /// that isn't connected) follows Windows' default mic.
    fn pick_mic(&mut self, input: &str, wanted: &str) {
        if wanted.is_empty() || wanted.eq_ignore_ascii_case("default") {
            return;
        }
        let Ok(list) = self.request("GetInputPropertiesListPropertyItems", json!({ "inputName": input, "propertyName": "device_id" })) else { return };
        let items = list["propertyItems"].as_array().cloned().unwrap_or_default();
        match pick_device(&items, wanted) {
            Some(id) => {
                let _ = self.request("SetInputSettings", json!({ "inputName": input, "inputSettings": { "device_id": id } }));
            }
            None => crate::trail(&format!("obs: mic \"{wanted}\" isn't connected; using the default mic")),
        }
    }

    /// Whole screen: shows the game layer while the game is in front, the
    /// screen below while you're tabbed out.
    pub fn show_game(&mut self, on: bool) {
        let Some((scene, id, shown)) = self.game_layer.clone() else { return };
        if shown != on && self.request_once("SetSceneItemEnabled", json!({ "sceneName": scene, "sceneItemId": id, "sceneItemEnabled": on })).is_ok() {
            self.game_layer = Some((scene, id, on));
        }
    }

    /// Adds a source to the scene; its scene item id, if OBS says.
    fn create(&mut self, scene: &str, name: &str, kind: &str, settings: Value) -> Result<Option<i64>, String> {
        let _ = self.request("RemoveInput", json!({ "inputName": name }));
        // OBS frees a removed source's name only once it's really gone, a
        // moment later: until then "already exists" (601). Wait for it.
        let data = json!({ "sceneName": scene, "inputName": name, "inputKind": kind, "sceneItemEnabled": true, "inputSettings": settings });
        let until = Instant::now() + Duration::from_secs(10);
        let made = loop {
            match self.request_once("CreateInput", data.clone()) {
                Ok(v) => break v,
                Err((601 | 207, _)) if Instant::now() < until => {
                    std::thread::sleep(Duration::from_millis(250));
                    let _ = self.request_once("RemoveInput", json!({ "inputName": name }));
                }
                Err((_, e)) => return Err(e),
            }
        };
        self.inputs.push(name.to_string());
        Ok(made["sceneItemId"].as_i64())
    }

    fn audio(&mut self, name: &str, volume: f32, tracks: Value) {
        let _ = self.request("SetInputVolume", json!({ "inputName": name, "inputVolumeMul": volume }));
        let _ = self.request("SetInputAudioTracks", json!({ "inputName": name, "inputAudioTracks": tracks }));
    }

    /// Stopping the replay buffer takes a moment; video settings can only
    /// change once it has.
    fn wait_replay_buffer_stopped(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match self.request("GetReplayBufferStatus", json!({})) {
                Ok(s) if s["outputActive"].as_bool() == Some(true) => std::thread::sleep(Duration::from_millis(100)),
                _ => return,
            }
        }
    }

    /// Starts the replay buffer and waits until it really runs. Right after a
    /// stop, OBS can answer "started" while the old one is still finishing
    /// and then not start at all (F9 then failed: "501", not running).
    fn start_replay_buffer(&mut self) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let _ = self.request_once("StartReplayBuffer", json!({}));
            let tried = Instant::now();
            while tried.elapsed() < Duration::from_millis(1500) {
                if self.replay_buffer_running() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if Instant::now() > until {
                return Err("the replay buffer didn't start".into());
            }
        }
    }

    fn replay_buffer_running(&mut self) -> bool {
        self.request_once("GetReplayBufferStatus", json!({})).is_ok_and(|s| s["outputActive"].as_bool() == Some(true))
    }

    /// While recording: the replay buffer still runs (started again if not).
    pub fn keep_replay_buffer_running(&mut self) {
        if self.capture.is_some() && !self.replay_buffer_running() {
            crate::trail("obs: the replay buffer had stopped; starting it again");
            if let Err(e) = self.start_replay_buffer() {
                crate::trail(&format!("obs: {e}"));
            }
        }
    }

    /// Saves the replay buffer; returns the saved file once OBS has written it.
    pub fn save_replay(&mut self) -> Result<PathBuf, String> {
        if self.capture.is_none() {
            return Err("Not recording right now. Clips are saved while a game is open.".into());
        }
        self.events.clear();
        if let Err(e) = self.request("SaveReplayBuffer", json!({})) {
            // Not running (501): start it again for the next clip.
            self.keep_replay_buffer_running();
            return Err(if e.contains("501") { "The recording was restarting. Try again in a few seconds.".into() } else { e });
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Some(path) = self.events.iter().find(|e| e["eventType"] == "ReplayBufferSaved").and_then(|e| e["eventData"]["savedReplayPath"].as_str()) {
                return Ok(PathBuf::from(path));
            }
            match self.ws.recv(Duration::from_millis(500)) {
                Ok(Some(text)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        if v["op"] == 5 {
                            self.events.push(v["d"].clone());
                        }
                    }
                }
                Ok(None) => {}
                Err(e) => return Err(format!("OBS stopped answering ({e})")),
            }
        }
        // No event: ask for the last saved replay instead.
        let last = self.request("GetLastReplayBufferReplay", json!({}))?;
        last.get("savedReplayPath").and_then(Value::as_str).map(PathBuf::from).ok_or_else(|| "OBS didn't save the replay".into())
    }

    /// "fps=143.9 render skipped 3/9000 encode skipped 0/9000", for Diagnostics.
    pub fn health(&mut self) -> Option<String> {
        let s = self.request("GetStats", json!({})).ok()?;
        let n = |k: &str| s.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        Some(format!(
            "fps={:.1} render skipped {}/{} encode skipped {}/{}",
            n("activeFps"),
            n("renderSkippedFrames"),
            n("renderTotalFrames"),
            n("outputSkippedFrames"),
            n("outputTotalFrames")
        ))
    }

    /// Whether OBS is still running. Also keeps its tray icon away (Qt adds
    /// it back when Explorer restarts).
    pub fn alive(&mut self) -> bool {
        let alive = matches!(self.child.try_wait(), Ok(None));
        if alive {
            hide_tray_icon(self.child.id());
            hide_windows(self.child.id());
            self.keep_replay_buffer_running();
        }
        alive
    }

    /// Keeps OBS's windows hidden and off the taskbar (see `hide_windows`).
    pub fn hide_own_windows(&self) {
        hide_windows(self.child.id());
    }

    /// The last lines of OBS's own log about capture, encoding or errors.
    pub fn log_lines(&self) -> Vec<String> {
        let dir = self.config.join("logs");
        let newest = fs::read_dir(&dir).ok().and_then(|it| it.flatten().max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok()));
        let Some(text) = newest.and_then(|e| fs::read_to_string(e.path()).ok()) else { return Vec::new() };
        let wanted = |l: &str| ["game-capture", "game_capture", "monitor_capture", "error", "failed", "encoder", "Replay Buffer", "skipped"].iter().any(|k| l.contains(k));
        let lines: Vec<String> = text.lines().filter(|l| wanted(l)).map(|l| l.chars().take(200).collect()).collect();
        lines.into_iter().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect()
    }

    /// One obs-websocket request. "Not ready" (207: OBS still loading, its
    /// websocket comes up first) is retried for up to 30 s.
    fn request(&mut self, kind: &str, data: Value) -> Result<Value, String> {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            match self.request_once(kind, data.clone()) {
                Err((207, _)) if Instant::now() < until => std::thread::sleep(Duration::from_millis(500)),
                Err((_, e)) => return Err(e),
                Ok(v) => return Ok(v),
            }
        }
    }

    /// Err((status code, message)); code 0 when there's no answer at all.
    fn request_once(&mut self, kind: &str, data: Value) -> Result<Value, (u64, String)> {
        let id = self.next_id.to_string();
        self.next_id += 1;
        let msg = json!({ "op": 6, "d": { "requestType": kind, "requestId": id, "requestData": data } });
        self.ws.send(&msg.to_string()).map_err(|e| (0, format!("OBS: {kind}: {e}")))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let Some(text) = self.ws.recv(Duration::from_millis(500)).map_err(|e| (0, format!("OBS: {kind}: {e}")))? else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            match v["op"].as_u64() {
                Some(5) => self.events.push(v["d"].clone()),
                Some(7) if v["d"]["requestId"] == id.as_str() => {
                    let status = &v["d"]["requestStatus"];
                    if status["result"].as_bool() == Some(true) {
                        return Ok(v["d"]["responseData"].clone());
                    }
                    return Err((status["code"].as_u64().unwrap_or(0), format!("OBS: {kind}: {} {}", status["code"], status["comment"].as_str().unwrap_or(""))));
                }
                _ => {}
            }
        }
        Err((0, format!("OBS: {kind}: no answer")))
    }
}

/// The device id of the mic named `wanted` among OBS's list ({itemName,
/// itemValue}): the same name, else one name containing the other.
fn pick_device(items: &[Value], wanted: &str) -> Option<Value> {
    let named = |i: &&Value| i["itemName"].as_str().map(str::to_lowercase);
    let w = wanted.to_lowercase();
    items
        .iter()
        .find(|i| named(i).as_deref() == Some(w.as_str()))
        .or_else(|| items.iter().find(|i| named(i).is_some_and(|n| !n.is_empty() && (n.contains(&w) || w.contains(&n)))))
        .map(|i| i["itemValue"].clone())
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty() && s != "default"))
}

/// Game Capture's window string: "title:class:exe", each with ':' as "#3A".
fn window_spec(title: &str, class: &str, exe: &str) -> String {
    let esc = |s: &str| s.replace(':', "#3A");
    format!("{}:{}:{}", esc(title), esc(class), esc(exe))
}

fn encoder_id(enc: VideoEncoder, hevc: bool) -> &'static str {
    match (enc, hevc) {
        (VideoEncoder::Nvenc, false) => "obs_nvenc_h264_tex",
        (VideoEncoder::Nvenc, true) => "obs_nvenc_hevc_tex",
        (VideoEncoder::Amf, false) => "h264_texture_amf",
        (VideoEncoder::Amf, true) => "h265_texture_amf",
        (VideoEncoder::Qsv, false) => "obs_qsv11_v2",
        (VideoEncoder::Qsv, true) => "obs_qsv11_hevc",
        (VideoEncoder::Cpu, _) => "obs_x264",
    }
}

/// OBS's settings before it starts: no first-run wizard, starts in the tray,
/// our profile (no desktop/mic devices of its own, replay buffer, the
/// encoder) and obs-websocket with our port and password.
fn write_config(config: &Path, p: &Profile, port: u16, password: &str) -> io::Result<()> {
    let app = format!(
        "[General]\r\nFirstRun=true\r\nEnableAutoUpdates=false\r\nConfirmOnExit=false\r\n\r\n[BasicWindow]\r\nSysTrayEnabled=true\r\nSysTrayWhenStarted=true\r\nSysTrayMinimizeToTray=true\r\n\r\n[Basic]\r\nProfile={PROFILE}\r\nProfileDir={PROFILE}\r\nSceneCollection={PROFILE}\r\nSceneCollectionFile={PROFILE}\r\n"
    );
    fs::create_dir_all(config)?;
    // Start with an empty scene: CrossPOV adds its sources itself (the ones
    // OBS saved last time would clash with them).
    let scenes = config.join("basic").join("scenes");
    for f in [format!("{PROFILE}.json"), format!("{PROFILE}.json.bak")] {
        let _ = fs::remove_file(scenes.join(f));
    }
    fs::write(config.join("global.ini"), &app)?;
    fs::write(config.join("user.ini"), &app)?;

    let profile = config.join("basic").join("profiles").join(PROFILE);
    fs::create_dir_all(&profile)?;
    let tracks = if p.separate_tracks { 3 } else { 1 };
    let ini = format!(
        "[General]\r\nName={PROFILE}\r\n\r\n[Video]\r\nBaseCX=320\r\nBaseCY=180\r\nOutputCX=320\r\nOutputCY=180\r\nFPSType=1\r\nFPSInt=5\r\n\r\n\
         [Audio]\r\nSampleRate=48000\r\nChannelSetup=Stereo\r\nDesktopDevice1=disabled\r\nDesktopDevice2=disabled\r\nAuxDevice1=disabled\r\nAuxDevice2=disabled\r\nAuxDevice3=disabled\r\nAuxDevice4=disabled\r\n\r\n\
         [Output]\r\nMode=Advanced\r\n\r\n\
         [AdvOut]\r\nRecType=Standard\r\nRecFilePath={dir}\r\nRecFormat2={fmt}\r\nRecEncoder={enc}\r\nRecTracks={tracks}\r\nRecRB=true\r\nRecRBTime={secs}\r\nRecRBSize=8192\r\nRecRBPrefix=Replay\r\n",
        dir = p.replay_dir.display(),
        fmt = p.format,
        enc = encoder_id(p.encoder, p.hevc),
        secs = p.buffer_seconds,
    );
    fs::write(profile.join("basic.ini"), ini)?;
    let encoder = json!({ "rate_control": "VBR", "bitrate": p.kbps, "max_bitrate": p.kbps * 3 / 2, "keyint_sec": 2, "preset2": "p5", "tune": "hq", "multipass": "disabled", "bf": 2 });
    fs::write(profile.join("recordEncoder.json"), encoder.to_string())?;

    let ws = config.join("plugin_config").join("obs-websocket");
    fs::create_dir_all(&ws)?;
    let cfg = json!({ "alerts_enabled": false, "auth_required": true, "first_load": false, "server_enabled": true, "server_password": password, "server_port": port });
    fs::write(ws.join("config.json"), cfg.to_string())
}

/// obs-websocket v5 handshake: Hello, Identify (with the password), Identified.
fn identify(ws: &mut Ws, password: &str) -> io::Result<()> {
    let hello: Value = serde_json::from_str(&ws.recv(Duration::from_secs(5))?.ok_or_else(|| io::Error::other("no Hello"))?).map_err(io::Error::other)?;
    let mut d = json!({ "rpcVersion": 1, "eventSubscriptions": 64 });
    if let Some(auth) = hello["d"].get("authentication") {
        let (challenge, salt) = (auth["challenge"].as_str().unwrap_or(""), auth["salt"].as_str().unwrap_or(""));
        let secret = base64(&Sha256::digest(format!("{password}{salt}").as_bytes()));
        d["authentication"] = json!(base64(&Sha256::digest(format!("{secret}{challenge}").as_bytes())));
    }
    ws.send(&json!({ "op": 1, "d": d }).to_string())?;
    let reply: Value = serde_json::from_str(&ws.recv(Duration::from_secs(5))?.ok_or_else(|| io::Error::other("no Identified"))?).map_err(io::Error::other)?;
    if reply["op"] == 2 {
        Ok(())
    } else {
        Err(io::Error::other("OBS refused the connection"))
    }
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0").ok()?.local_addr().ok().map(|a| a.port())
}

/// Random bytes from the standard library's randomly seeded hasher.
fn random_bytes(n: usize) -> Vec<u8> {
    use std::hash::{BuildHasher, Hasher};
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_usize(out.len());
        h.write_u128(Instant::now().elapsed().as_nanos());
        out.extend_from_slice(&h.finish().to_le_bytes());
    }
    out.truncate(n);
    out
}

pub(crate) fn random_hex(n: usize) -> String {
    random_bytes(n).iter().map(|b| format!("{b:02x}")).collect()
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= c.len() {
                s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// A minimal WebSocket client (text messages) for obs-websocket on 127.0.0.1.
struct Ws {
    s: TcpStream,
    buf: Vec<u8>,
}

impl Ws {
    fn connect(port: u16) -> io::Result<Ws> {
        let mut s = TcpStream::connect(("127.0.0.1", port))?;
        s.set_nodelay(true)?;
        let key = base64(&random_bytes(16));
        write!(
            s,
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: obswebsocket.json\r\n\r\n"
        )?;
        s.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if s.read(&mut byte)? == 0 || head.len() > 8192 {
                return Err(io::Error::other("no WebSocket handshake"));
            }
            head.push(byte[0]);
        }
        if !head.starts_with(b"HTTP/1.1 101") {
            return Err(io::Error::other("WebSocket refused"));
        }
        Ok(Ws { s, buf: Vec::new() })
    }

    fn send(&mut self, text: &str) -> io::Result<()> {
        self.frame(0x1, text.as_bytes())
    }

    fn frame(&mut self, opcode: u8, payload: &[u8]) -> io::Result<()> {
        let mut f = vec![0x80 | opcode];
        let len = payload.len();
        if len < 126 {
            f.push(0x80 | len as u8);
        } else if len <= 0xFFFF {
            f.push(0x80 | 126);
            f.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            f.push(0x80 | 127);
            f.extend_from_slice(&(len as u64).to_be_bytes());
        }
        let mask = random_bytes(4);
        f.extend_from_slice(&mask);
        f.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.s.write_all(&f)
    }

    /// The next text message, or None if none came within `wait`.
    fn recv(&mut self, wait: Duration) -> io::Result<Option<String>> {
        let deadline = Instant::now() + wait;
        let mut message: Vec<u8> = Vec::new();
        loop {
            if let Some((fin, opcode, payload, used)) = parse_frame(&self.buf) {
                self.buf.drain(..used);
                match opcode {
                    0x8 => return Err(io::Error::other("OBS closed the connection")),
                    0x9 => self.frame(0xA, &payload)?,
                    0xA => {}
                    _ => {
                        message.extend_from_slice(&payload);
                        if fin {
                            return Ok(Some(String::from_utf8_lossy(&message).into_owned()));
                        }
                    }
                }
                continue;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() && message.is_empty() {
                return Ok(None);
            }
            self.s.set_read_timeout(Some(left.max(Duration::from_millis(50))))?;
            let mut chunk = [0u8; 16384];
            match self.s.read(&mut chunk) {
                Ok(0) => return Err(io::Error::other("OBS closed the connection")),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                    if message.is_empty() {
                        return Ok(None);
                    }
                }
                Err(e) => return Err(e),
            }
        }
    }
}

/// One server frame from the start of `buf`: (fin, opcode, payload, bytes used).
fn parse_frame(buf: &[u8]) -> Option<(bool, u8, Vec<u8>, usize)> {
    if buf.len() < 2 {
        return None;
    }
    let (fin, opcode, masked) = (buf[0] & 0x80 != 0, buf[0] & 0x0F, buf[1] & 0x80 != 0);
    let mut len = u64::from(buf[1] & 0x7F);
    let mut at = 2;
    if len == 126 {
        len = u64::from(u16::from_be_bytes(buf.get(2..4)?.try_into().ok()?));
        at = 4;
    } else if len == 127 {
        len = u64::from_be_bytes(buf.get(2..10)?.try_into().ok()?);
        at = 10;
    }
    let mask = if masked {
        let m = buf.get(at..at + 4)?.to_vec();
        at += 4;
        Some(m)
    } else {
        None
    };
    let end = at.checked_add(usize::try_from(len).ok()?)?;
    let mut payload = buf.get(at..end)?.to_vec();
    if let Some(m) = mask {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= m[i % 4];
        }
    }
    Some((fin, opcode, payload, end))
}

/// Removes OBS's tray icon. OBS starts hidden in the tray (no window ever
/// shows); its icon is the only thing left, and players shouldn't see OBS.
/// Qt's tray icon belongs to a message-only window of class
/// "QTrayIconMessageWindowClass" with icon id 0.
#[cfg(windows)]
fn hide_tray_icon(pid: u32) {
    use windows::core::w;
    use windows::Win32::UI::Shell::{Shell_NotifyIconW, NIM_DELETE, NOTIFYICONDATAW};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetWindowThreadProcessId, HWND_MESSAGE};
    // SAFETY: window lookups and a tray-icon removal with a properly sized struct.
    unsafe {
        for parent in [Some(HWND_MESSAGE), None] {
            let mut after = None;
            while let Ok(hwnd) = FindWindowExW(parent, after, w!("QTrayIconMessageWindowClass"), None) {
                after = Some(hwnd);
                let mut owner = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut owner));
                if owner == pid {
                    for id in 0..4 {
                        let data = NOTIFYICONDATAW { cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: hwnd, uID: id, ..Default::default() };
                        let _ = Shell_NotifyIconW(NIM_DELETE, &data);
                    }
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn hide_tray_icon(_pid: u32) {}

/// Keeps OBS's own windows (its main window, dialogs, pop-ups) off the
/// taskbar and out of sight: each is made a "tool window", which Windows
/// never gives a taskbar button even when OBS shows it again (Qt re-showed a
/// hidden pop-up every few seconds), and hidden. Says which, once each.
#[cfg(windows)]
fn hide_windows(pid: u32) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongPtrW, GetWindowThreadProcessId, IsWindowVisible, SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, SW_HIDE,
        WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the &mut (pid, found) passed below, alive for the whole EnumWindows call.
        let (pid, found) = unsafe { &mut *(data.0 as *mut (u32, Vec<HWND>)) };
        let mut owner = 0u32;
        // SAFETY: a plain query on a window Windows handed us.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) };
        if owner == *pid {
            found.push(hwnd);
        }
        true.into()
    }
    static SEEN: OnceLock<Mutex<HashSet<isize>>> = OnceLock::new();
    let mut data = (pid, Vec::<HWND>::new());
    // SAFETY: the callback only uses `data`, which outlives the call.
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut data as *mut _ as isize));
    }
    for hwnd in data.1 {
        // SAFETY: style changes and hiding on windows of OBS, which CrossPOV runs hidden.
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let want = (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
            if want != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
            }
            if IsWindowVisible(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_HIDE);
                let first = SEEN.get_or_init(Default::default).lock().map(|mut s| s.insert(hwnd.0 as isize)).unwrap_or(false);
                if first {
                    let (title, class) = window_names(hwnd.0 as usize as u64);
                    crate::trail(&format!("obs: hid its window \"{title}\" ({class})"));
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn hide_windows(_pid: u32) {}

/// A window's title and class (Game Capture matches the window by them, and the .exe).
#[cfg(windows)]
pub fn window_names(hwnd: u64) -> (String, String) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindowTextW};
    let h = HWND(hwnd as usize as *mut core::ffi::c_void);
    let mut buf = [0u16; 512];
    // SAFETY: plain queries into a local buffer of the given size.
    let title = unsafe { GetWindowTextW(h, &mut buf) };
    let title = String::from_utf16_lossy(&buf[..title.max(0) as usize]);
    let class = unsafe { GetClassNameW(h, &mut buf) };
    let class = String::from_utf16_lossy(&buf[..class.max(0) as usize]);
    (title, class)
}

#[cfg(not(windows))]
pub fn window_names(_hwnd: u64) -> (String, String) {
    (String::new(), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn obs_websocket_auth_string() {
        // obs-websocket v5: base64(sha256(base64(sha256(password + salt)) + challenge)).
        let secret = base64(&Sha256::digest(b"supersecretpasswordlpcQWbNQPyAAAp6ckU9RJ2JvMVz9t6c/6fvnZtPJAEM="));
        let auth = base64(&Sha256::digest(format!("{secret}+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=").as_bytes()));
        assert_eq!(auth.len(), 44);
    }

    #[test]
    fn picks_the_mic_by_name() {
        let items = vec![
            json!({ "itemName": "Default", "itemValue": "default" }),
            json!({ "itemName": "Microphone (Realtek(R) Audio)", "itemValue": "{0.0.1.00000000}.{aaa}" }),
            json!({ "itemName": "Headset Microphone (HyperX Cloud II)", "itemValue": "{0.0.1.00000000}.{bbb}" }),
        ];
        assert_eq!(pick_device(&items, "Headset Microphone (HyperX Cloud II)"), Some(json!("{0.0.1.00000000}.{bbb}")));
        assert_eq!(pick_device(&items, "microphone (realtek(r) audio)"), Some(json!("{0.0.1.00000000}.{aaa}")), "any case");
        assert_eq!(pick_device(&items, "HyperX Cloud II"), Some(json!("{0.0.1.00000000}.{bbb}")), "part of the name");
        assert_eq!(pick_device(&items, "Blue Yeti"), None, "not connected");
    }

    #[test]
    fn window_strings_escape_colons() {
        assert_eq!(window_spec("VALORANT  ", "UnrealWindow", "VALORANT-Win64-Shipping.exe"), "VALORANT  :UnrealWindow:VALORANT-Win64-Shipping.exe");
        assert_eq!(window_spec("a:b", "c", "d.exe"), "a#3Ab:c:d.exe");
    }

    #[test]
    fn reads_server_frames() {
        let mut f = vec![0x81, 5];
        f.extend_from_slice(b"hello");
        assert_eq!(parse_frame(&f), Some((true, 1, b"hello".to_vec(), 7)));
        assert_eq!(parse_frame(&f[..4]), None, "incomplete");
        let mut long = vec![0x81, 126, 0x01, 0x00];
        long.extend(std::iter::repeat_n(b'x', 256));
        assert_eq!(parse_frame(&long).map(|f| f.2.len()), Some(256));
    }

    /// The client against a tiny local WebSocket server speaking obs-websocket.
    #[test]
    fn talks_to_a_websocket_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                s.read_exact(&mut b).unwrap();
                head.push(b[0]);
            }
            s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n").unwrap();
            let send = |s: &mut TcpStream, t: &str| {
                let mut f = vec![0x81, t.len() as u8];
                f.extend_from_slice(t.as_bytes());
                s.write_all(&f).unwrap();
            };
            send(&mut s, r#"{"op":0,"d":{"rpcVersion":1}}"#);
            // Read the client's (masked) Identify, then answer.
            let mut h = [0u8; 2];
            s.read_exact(&mut h).unwrap();
            let len = (h[1] & 0x7F) as usize;
            let mut rest = vec![0u8; 4 + len];
            s.read_exact(&mut rest).unwrap();
            send(&mut s, r#"{"op":2,"d":{"negotiatedRpcVersion":1}}"#);
        });
        let mut ws = Ws::connect(port).unwrap();
        identify(&mut ws, "pw").unwrap();
    }
}
