//! Recording through the CrossPOV Recorder (recorder/ in this repository,
//! GPL, published as its own open-source project): a small program with no
//! windows that records with OBS Studio's engine (libobs) and the OBS
//! plugins CrossPOV uses, unchanged. Game Capture is OBS's own: its signed
//! hook gets VALORANT's picture where Windows' capture APIs don't.
//!
//! CrossPOV starts the recorder (from the downloaded package's bin\64bit),
//! listens on 127.0.0.1 for it with a random key, and sends it one JSON
//! request per line: setup (encoder, replay buffer), apply (what to record),
//! save, stats, show_game. The recorder writes libobs' log to recorder.log.

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};

use crate::ffmpeg::{NoWindow, VideoEncoder};

const RECORDER_EXE: &str = "crosspov-recorder.exe";

/// Encoder and replay buffer settings. A change sets the recorder up again.
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
    /// Where saved replays go before CrossPOV moves them.
    pub replay_dir: PathBuf,
    /// Also record everything here in 5-minute pieces, for auto-clips (see autoclip.rs).
    pub session_dir: Option<PathBuf>,
}

/// What the recorder records.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Source {
    /// A game, by its .exe and window class (Game Capture).
    Game { exe: String, class: String },
    /// The monitor whose top-left corner is at this desktop position
    /// (Display Capture), with the game (exe, window class) on top through
    /// Game Capture while it's in front (see `show_game`): Windows can hand a
    /// full-screen game straight to the monitor, past what screen capture sees.
    Screen { origin: (i32, i32), game: Option<(String, String)> },
}

/// What to record right now. A change is applied to the running recorder.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Capture {
    pub source: Source,
    /// The canvas (the picture's size) and the recorded size.
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
    /// The mic on track 2, everything else on track 1.
    pub separate_tracks: bool,
}

pub struct Obs {
    child: Child,
    conn: BufReader<TcpStream>,
    log: PathBuf,
    pub profile: Profile,
    pub capture: Option<Capture>,
    /// Whole screen: whether the game layer shows (sent only on a change).
    game_shown: bool,
}

/// OBS's encoder id for an encoder and codec.
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

/// The profile as the recorder reads it.
fn profile_json(p: &Profile) -> Value {
    json!({
        "encoder": encoder_id(p.encoder, p.hevc), "kbps": p.kbps, "buffer_seconds": p.buffer_seconds,
        "format": p.format, "separate_tracks": p.separate_tracks, "replay_dir": p.replay_dir,
        "session_dir": p.session_dir
    })
}

impl Obs {
    /// Starts the recorder from the package folder and sets it up with
    /// `profile` (nothing recorded yet).
    pub fn launch(obs_dir: &Path, profile: Profile) -> Result<Obs, String> {
        let bin = obs_dir.join("bin").join("64bit");
        let log = obs_dir.join("recorder.log");
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("no local port for the recorder: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let key = random_hex(16);
        let out = fs::File::create(&log).map_err(|e| format!("Couldn't write the recorder's log: {e}"))?;
        let err = out.try_clone().map_err(|e| e.to_string())?;
        fs::create_dir_all(&profile.replay_dir).map_err(|e| e.to_string())?;
        let config = obs_dir.join("config").join("crosspov");
        let mut child = std::process::Command::new(bin.join(RECORDER_EXE))
            .current_dir(&bin)
            .args(["--port", &port.to_string(), "--key", &key, "--config"])
            .arg(&config)
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .no_window()
            .spawn()
            .map_err(|e| format!("Couldn't start the recorder: {e}"))?;
        crate::procs::tie_to_app(&child);

        // It connects back within a few seconds: accept only it (the key).
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let conn = loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_nodelay(true);
                    let mut reader = BufReader::new(stream);
                    let _ = reader.get_ref().set_read_timeout(Some(Duration::from_secs(5)));
                    let mut hello = String::new();
                    let _ = reader.read_line(&mut hello);
                    if serde_json::from_str::<Value>(&hello).ok().is_some_and(|v| v["hello"] == key.as_str()) {
                        break reader;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if let Ok(Some(code)) = child.try_wait() {
                        return Err(format!("the recorder stopped ({code}): {}", last_lines(&log, 3).join(" | ")));
                    }
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        return Err("the recorder didn't answer".into());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(format!("the recorder couldn't connect: {e}")),
            }
        };
        let mut obs = Obs { child, conn, log, profile, capture: None, game_shown: true };
        // libobs loading its plugins takes a moment; then it says it's ready.
        obs.read_reply(Duration::from_secs(60))?;
        let p = profile_json(&obs.profile);
        obs.request(json!({ "op": "setup", "profile": p }), Duration::from_secs(10))?;
        Ok(obs)
    }

    fn read_reply(&mut self, wait: Duration) -> Result<Value, String> {
        let _ = self.conn.get_ref().set_read_timeout(Some(wait));
        let mut line = String::new();
        match self.conn.read_line(&mut line) {
            Ok(0) => Err("the recorder stopped".into()),
            Ok(_) => {
                let v: Value = serde_json::from_str(&line).map_err(|e| format!("the recorder said something odd: {e}"))?;
                if v["ok"] == true {
                    Ok(v)
                } else {
                    Err(v["error"].as_str().unwrap_or("the recorder failed").to_string())
                }
            }
            Err(e) => Err(format!("the recorder didn't answer ({e})")),
        }
    }

    /// One request and its answer.
    fn request(&mut self, req: Value, wait: Duration) -> Result<Value, String> {
        let stream = self.conn.get_mut();
        writeln!(stream, "{req}").and_then(|_| stream.flush()).map_err(|e| format!("the recorder stopped ({e})"))?;
        self.read_reply(wait)
    }

    /// New encoder or replay buffer settings; recording (if any) goes on with them.
    pub fn set_profile(&mut self, profile: Profile, title: &str) -> Result<(), String> {
        let p = profile_json(&profile);
        self.request(json!({ "op": "setup", "profile": p, "title": title }), Duration::from_secs(30))?;
        self.profile = profile;
        Ok(())
    }

    /// Records `capture` from now on (`title`: the game window's title, for
    /// finding it), or nothing (None). The replay buffer starts afresh.
    pub fn apply(&mut self, capture: Option<Capture>, title: &str) -> Result<(), String> {
        self.capture = None;
        self.game_shown = true;
        let cap = serde_json::to_value(&capture).map_err(|e| e.to_string())?;
        self.request(json!({ "op": "apply", "capture": cap, "title": title }), Duration::from_secs(30))?;
        self.capture = capture;
        Ok(())
    }

    /// Whole screen: the game layer while the game is in front, the screen
    /// below while you're tabbed out.
    pub fn show_game(&mut self, on: bool) {
        let screen = matches!(self.capture.as_ref().map(|c| &c.source), Some(Source::Screen { game: Some(_), .. }));
        if screen && on != self.game_shown && self.request(json!({ "op": "show_game", "on": on }), Duration::from_secs(5)).is_ok() {
            self.game_shown = on;
        }
    }

    /// While recording: the replay buffer still runs (started again if not).
    pub fn keep_replay_buffer_running(&mut self) {
        if self.capture.is_none() {
            return;
        }
        let running = self.request(json!({ "op": "running" }), Duration::from_secs(5)).is_ok_and(|v| v["running"] == true);
        if !running {
            crate::trail("recorder: the replay buffer had stopped; starting it again");
            if let Err(e) = self.request(json!({ "op": "restart_buffer" }), Duration::from_secs(15)) {
                crate::trail(&format!("recorder: {e}"));
            }
        }
    }

    /// Saves the replay buffer; returns the saved file once it's written.
    pub fn save_replay(&mut self) -> Result<PathBuf, String> {
        if self.capture.is_none() {
            return Err("Not recording right now. Clips are saved while a game is open.".into());
        }
        match self.request(json!({ "op": "save" }), Duration::from_secs(30)) {
            Ok(v) => v["path"].as_str().map(PathBuf::from).ok_or_else(|| "The recorder didn't say where it saved the clip".into()),
            Err(e) => {
                // Not running: start it again for the next clip.
                self.keep_replay_buffer_running();
                Err(if e.contains("not recording") { "The recording was restarting. Try again in a few seconds.".into() } else { e })
            }
        }
    }

    /// "fps=143.9 render skipped 3/9000 encode skipped 0/9000", for Diagnostics.
    pub fn health(&mut self) -> Option<String> {
        self.request(json!({ "op": "stats" }), Duration::from_secs(5)).ok().and_then(|v| v["text"].as_str().map(String::from))
    }

    /// Whether the recorder is still running.
    pub fn alive(&mut self) -> bool {
        let alive = matches!(self.child.try_wait(), Ok(None));
        if alive {
            self.keep_replay_buffer_running();
        }
        alive
    }

    /// The last lines of libobs' log about capture, encoding or errors.
    pub fn log_lines(&self) -> Vec<String> {
        let wanted = |l: &str| ["game-capture", "game_capture", "monitor_capture", "error", "failed", "encoder", "Replay Buffer", "skipped", "recorder"].iter().any(|k| l.contains(k));
        let text = fs::read_to_string(&self.log).unwrap_or_default();
        let lines: Vec<String> = text.lines().filter(|l| wanted(l)).map(|l| l.chars().take(200).collect()).collect();
        lines.into_iter().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect()
    }
}

impl Drop for Obs {
    fn drop(&mut self) {
        // Ask it to stop (it shuts libobs down), then make sure.
        let _ = writeln!(self.conn.get_mut(), "{}", json!({ "op": "quit" }));
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until && matches!(self.child.try_wait(), Ok(None)) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn last_lines(path: &Path, n: usize) -> Vec<String> {
    let text = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(|l| l.chars().take(200).collect()).collect();
    lines[lines.len().saturating_sub(n)..].to_vec()
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
    fn capture_is_sent_as_the_recorder_reads_it() {
        let cap = Capture {
            source: Source::Screen { origin: (0, 0), game: Some(("VALORANT-Win64-Shipping.exe".into(), "UnrealWindow".into())) },
            size: (1920, 1080),
            out_size: (1920, 1080),
            fps: 144,
            game_audio: Some(1.0),
            desktop_audio: false,
            apps: vec![("Discord.exe".into(), 0.5)],
            mic: None,
            mic_device: "default".into(),
            denoise_mic: false,
            separate_tracks: false,
        };
        let v = serde_json::to_value(&cap).unwrap();
        assert_eq!(v["source"], json!({ "Screen": { "origin": [0, 0], "game": ["VALORANT-Win64-Shipping.exe", "UnrealWindow"] } }));
        assert_eq!(v["apps"], json!([["Discord.exe", 0.5]]));
        assert_eq!(v["size"], json!([1920, 1080]));
        let game = serde_json::to_value(Source::Game { exe: "a.exe".into(), class: "C".into() }).unwrap();
        assert_eq!(game, json!({ "Game": { "exe": "a.exe", "class": "C" } }));
    }

    #[test]
    fn profile_names_obs_encoders() {
        let p = Profile { encoder: VideoEncoder::Nvenc, hevc: true, kbps: 50_000, buffer_seconds: 60, format: "mp4", separate_tracks: false, replay_dir: PathBuf::from("x"), session_dir: None };
        let v = profile_json(&p);
        assert_eq!(v["encoder"], "obs_nvenc_hevc_tex");
        assert_eq!(v["kbps"], 50_000);
        assert_eq!(encoder_id(VideoEncoder::Cpu, true), "obs_x264");
    }

    /// The whole conversation with a stand-in recorder on 127.0.0.1.
    #[test]
    fn talks_to_the_recorder() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let c = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let mut w = c.try_clone().unwrap();
            writeln!(w, "{}", json!({ "ok": true, "ready": true })).unwrap();
            for line in BufReader::new(c).lines() {
                let req: Value = serde_json::from_str(&line.unwrap()).unwrap();
                let reply = match req["op"].as_str().unwrap() {
                    "save" => json!({ "ok": true, "path": "C:/r/Replay.mp4" }),
                    "quit" => break,
                    _ => json!({ "ok": true }),
                };
                writeln!(w, "{reply}").unwrap();
            }
        });
        let (stream, _) = listener.accept().unwrap();
        let profile = Profile { encoder: VideoEncoder::Cpu, hevc: false, kbps: 1000, buffer_seconds: 30, format: "mp4", separate_tracks: false, replay_dir: PathBuf::from("x"), session_dir: None };
        let child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" }).args(if cfg!(windows) { vec!["/c", "exit"] } else { vec![] }).spawn().unwrap();
        let mut obs = Obs { child, conn: BufReader::new(stream), log: PathBuf::from("none"), profile, capture: None, game_shown: true };
        obs.read_reply(Duration::from_secs(5)).unwrap();
        assert!(obs.save_replay().is_err(), "nothing recorded yet");
        let cap = Capture {
            source: Source::Game { exe: "a.exe".into(), class: "C".into() },
            size: (1280, 720),
            out_size: (1280, 720),
            fps: 60,
            game_audio: None,
            desktop_audio: false,
            apps: vec![],
            mic: None,
            mic_device: "default".into(),
            denoise_mic: false,
            separate_tracks: false,
        };
        obs.apply(Some(cap), "Game").unwrap();
        assert_eq!(obs.save_replay().unwrap(), PathBuf::from("C:/r/Replay.mp4"));
        drop(obs);
        server.join().unwrap();
    }
}
