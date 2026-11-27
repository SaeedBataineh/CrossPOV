//! Recording a full-screen game with OBS Studio (the slim, unmodified copy
//! tools.rs downloads). OBS's Game Capture takes the game's frames from the
//! game itself (its own signed hook, which Vanguard allows), so it records
//! games that Windows shows straight on the screen, where Windows' capture
//! APIs see what's behind the game instead.
//!
//! OBS runs hidden, in portable mode (its settings in its own folder, apart
//! from any OBS the user has), tied to CrossPOV (closes with it). CrossPOV
//! sets it up and drives it through obs-websocket on 127.0.0.1 with a random
//! password: Game Capture of the game's .exe, its sound, the mic, and a
//! replay buffer; F9 saves the replay.

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

/// What to record, from CrossPOV's settings and the detected game.
#[derive(Debug, Clone, PartialEq)]
pub struct Setup {
    /// The game's .exe, window title and class (Game Capture finds the window by them).
    pub exe: String,
    pub title: String,
    pub class: String,
    /// The game's picture size (OBS's canvas) and the recorded size.
    pub size: (u32, u32),
    pub out_size: (u32, u32),
    pub fps: u32,
    pub encoder: VideoEncoder,
    pub hevc: bool,
    pub kbps: u32,
    pub buffer_seconds: u32,
    /// "mp4" or "mkv".
    pub format: &'static str,
    /// The game's sound (volume 0..1), the mic (volume 0..1), noise
    /// suppression, and whether the mic gets its own track.
    pub game_audio: Option<f32>,
    pub mic: Option<f32>,
    pub denoise_mic: bool,
    pub separate_tracks: bool,
    /// Where OBS writes saved replays before CrossPOV moves them.
    pub replay_dir: PathBuf,
}

const GAME: &str = "CrossPOV Game";
const GAME_AUDIO: &str = "CrossPOV Game Audio";
const MIC: &str = "CrossPOV Mic";
const PROFILE: &str = "CrossPOV";

/// A running, recording OBS.
pub struct Session {
    child: Child,
    ws: Ws,
    next_id: u64,
    /// Events that came in while waiting for a request's answer.
    events: Vec<Value>,
    config: PathBuf,
    pub setup: Setup,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.request("StopReplayBuffer", json!({}));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Session {
    /// Starts OBS from `obs_dir` (holding bin\64bit\obs64.exe), sets it up for
    /// `setup` and starts the replay buffer.
    pub fn start(obs_dir: &Path, setup: Setup) -> Result<Session, String> {
        let config = obs_dir.join("config").join("obs-studio");
        let port = free_port().ok_or("no free local port for OBS")?;
        let password = random_hex(16);
        write_config(&config, &setup, port, &password).map_err(|e| format!("Couldn't write OBS's settings: {e}"))?;
        fs::create_dir_all(&setup.replay_dir).map_err(|e| e.to_string())?;

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

        // OBS takes a few seconds to load; its websocket comes up with it.
        let deadline = Instant::now() + Duration::from_secs(40);
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
        let mut s = Session { child, ws, next_id: 1, events: Vec::new(), config, setup };
        s.configure()?;
        hide_tray_icon(s.child.id());
        Ok(s)
    }

    fn configure(&mut self) -> Result<(), String> {
        let st = self.setup.clone();
        self.request(
            "SetVideoSettings",
            json!({ "baseWidth": st.size.0, "baseHeight": st.size.1, "outputWidth": st.out_size.0, "outputHeight": st.out_size.1, "fpsNumerator": st.fps, "fpsDenominator": 1 }),
        )?;
        let scene = self.request("GetCurrentProgramScene", json!({}))?;
        let scene = scene.get("currentProgramSceneName").or_else(|| scene.get("sceneName")).and_then(Value::as_str).unwrap_or("Scene").to_string();
        for name in [GAME, GAME_AUDIO, MIC] {
            let _ = self.request("RemoveInput", json!({ "inputName": name }));
        }
        let window = window_spec(&st.title, &st.class, &st.exe);
        self.request(
            "CreateInput",
            json!({
                "sceneName": scene, "inputName": GAME, "inputKind": "game_capture", "sceneItemEnabled": true,
                "inputSettings": {
                    "capture_mode": "window", "window": window, "priority": 2,
                    "anti_cheat_hook": true, "capture_cursor": false, "capture_overlays": false,
                    "allow_transparency": false, "limit_framerate": false, "hook_rate": 1
                }
            }),
        )?;
        // Tracks: 1 = everything, or the game on 1 and the mic on 2.
        let tracks = |one: bool, two: bool| json!({ "1": one, "2": two, "3": false, "4": false, "5": false, "6": false });
        if let Some(vol) = st.game_audio {
            self.request(
                "CreateInput",
                json!({ "sceneName": scene, "inputName": GAME_AUDIO, "inputKind": "wasapi_process_output_capture", "sceneItemEnabled": true,
                        "inputSettings": { "window": window, "priority": 2 } }),
            )?;
            let _ = self.request("SetInputVolume", json!({ "inputName": GAME_AUDIO, "inputVolumeMul": vol }));
            let _ = self.request("SetInputAudioTracks", json!({ "inputName": GAME_AUDIO, "inputAudioTracks": tracks(true, false) }));
        }
        if let Some(vol) = st.mic {
            self.request(
                "CreateInput",
                json!({ "sceneName": scene, "inputName": MIC, "inputKind": "wasapi_input_capture", "sceneItemEnabled": true,
                        "inputSettings": { "device_id": "default" } }),
            )?;
            let _ = self.request("SetInputVolume", json!({ "inputName": MIC, "inputVolumeMul": vol }));
            let _ = self.request("SetInputAudioTracks", json!({ "inputName": MIC, "inputAudioTracks": tracks(!st.separate_tracks, st.separate_tracks) }));
            if st.denoise_mic {
                let _ = self.request(
                    "CreateSourceFilter",
                    json!({ "sourceName": MIC, "filterName": "Noise suppression", "filterKind": "noise_suppress_filter_v2", "filterSettings": { "method": "rnnoise" } }),
                );
            }
        }
        self.request("StartReplayBuffer", json!({}))?;
        Ok(())
    }

    /// Saves the replay buffer; returns the saved file once OBS has written it.
    pub fn save_replay(&mut self) -> Result<PathBuf, String> {
        self.events.clear();
        self.request("SaveReplayBuffer", json!({}))?;
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
        }
        alive
    }

    /// The last lines of OBS's own log about capture, encoding or errors.
    pub fn log_lines(&self) -> Vec<String> {
        let dir = self.config.join("logs");
        let newest = fs::read_dir(&dir).ok().and_then(|it| it.flatten().max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok()));
        let Some(text) = newest.and_then(|e| fs::read_to_string(e.path()).ok()) else { return Vec::new() };
        let wanted = |l: &str| ["game-capture", "game_capture", "error", "failed", "encoder", "Replay Buffer", "skipped"].iter().any(|k| l.contains(k));
        let lines: Vec<String> = text.lines().filter(|l| wanted(l)).map(|l| l.chars().take(200).collect()).collect();
        lines.into_iter().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect()
    }

    /// One obs-websocket request. "Not ready" (207: OBS still loading, its
    /// websocket comes up first) is retried for up to 20 s.
    fn request(&mut self, kind: &str, data: Value) -> Result<Value, String> {
        let until = Instant::now() + Duration::from_secs(20);
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
/// our profile (video, no desktop/mic devices of its own, replay buffer, the
/// encoder) and obs-websocket with our port and password.
fn write_config(config: &Path, st: &Setup, port: u16, password: &str) -> io::Result<()> {
    let app = format!(
        "[General]\r\nFirstRun=true\r\nEnableAutoUpdates=false\r\nConfirmOnExit=false\r\n\r\n[BasicWindow]\r\nSysTrayEnabled=true\r\nSysTrayWhenStarted=true\r\nSysTrayMinimizeToTray=true\r\n\r\n[Basic]\r\nProfile={PROFILE}\r\nProfileDir={PROFILE}\r\nSceneCollection={PROFILE}\r\nSceneCollectionFile={PROFILE}\r\n"
    );
    fs::create_dir_all(config)?;
    fs::write(config.join("global.ini"), &app)?;
    fs::write(config.join("user.ini"), &app)?;

    let profile = config.join("basic").join("profiles").join(PROFILE);
    fs::create_dir_all(&profile)?;
    let tracks = if st.mic.is_some() && st.separate_tracks { 3 } else { 1 };
    let ini = format!(
        "[General]\r\nName={PROFILE}\r\n\r\n[Video]\r\nBaseCX={bw}\r\nBaseCY={bh}\r\nOutputCX={ow}\r\nOutputCY={oh}\r\nFPSType=1\r\nFPSInt={fps}\r\n\r\n\
         [Audio]\r\nSampleRate=48000\r\nChannelSetup=Stereo\r\nDesktopDevice1=disabled\r\nDesktopDevice2=disabled\r\nAuxDevice1=disabled\r\nAuxDevice2=disabled\r\nAuxDevice3=disabled\r\nAuxDevice4=disabled\r\n\r\n\
         [Output]\r\nMode=Advanced\r\n\r\n\
         [AdvOut]\r\nRecType=Standard\r\nRecFilePath={dir}\r\nRecFormat2={fmt}\r\nRecEncoder={enc}\r\nRecTracks={tracks}\r\nRecRB=true\r\nRecRBTime={secs}\r\nRecRBSize=8192\r\nRecRBPrefix=Replay\r\n",
        bw = st.size.0,
        bh = st.size.1,
        ow = st.out_size.0,
        oh = st.out_size.1,
        fps = st.fps,
        dir = st.replay_dir.display(),
        fmt = st.format,
        enc = encoder_id(st.encoder, st.hevc),
        secs = st.buffer_seconds,
    );
    fs::write(profile.join("basic.ini"), ini)?;
    let encoder = json!({ "rate_control": "VBR", "bitrate": st.kbps, "max_bitrate": st.kbps * 3 / 2, "keyint_sec": 2, "preset2": "p5", "tune": "hq", "multipass": "disabled", "bf": 2 });
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

fn random_hex(n: usize) -> String {
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
