//! The replay buffer: OBS (see obs.rs) starts with CrossPOV and stays
//! ready, records the game while it's open, and saves the last N seconds as
//! a clip on demand. FFmpeg only makes thumbnails and edits clips.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};

use serde::Serialize;

use crate::{
    clips::{self, ClipInfo, ClipMeta, MY_CLIPS},
    ffmpeg::{self, NoWindow, VideoEncoder},
    games::{self, Game},
    settings::{Container, Settings},
};

const POLL: Duration = Duration::from_secs(2);
/// While VALORANT is closed, look for it less often: it takes longer than
/// this to load, so recording still starts before you're in a match.
const POLL_IDLE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecState {
    /// Looking for FFmpeg and testing encoders, or getting OBS ready.
    Starting,
    /// FFmpeg is missing.
    NoFfmpeg,
    /// Ready; waiting for the game to open.
    Waiting,
    Recording,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub state: RecState,
    /// Encoder in use, e.g. "NVIDIA NVENC".
    pub encoder: Option<String>,
    pub message: Option<String>,
    pub audio_warning: Option<String>,
    pub hotkey_error: Option<String>,
    /// The game being recorded (or about to be).
    pub game: Option<Game>,
}

impl RecorderStatus {
    fn new(state: RecState) -> Self {
        Self { state, encoder: None, message: None, audio_warning: None, hotkey_error: None, game: None }
    }
}

struct Inner {
    settings: Settings,
    status: RecorderStatus,
    /// Logged that the game's window isn't known yet (once per wait).
    waiting_for_window: bool,
    /// OBS, which records everything (see obs.rs): started with CrossPOV and
    /// kept running, pointed at the game when there is one.
    obs: Option<Arc<Mutex<crate::obs::Obs>>>,
    /// When OBS last failed to start or record: tried again 30 s later.
    obs_failed: Option<Instant>,
    /// Set before an update installs: stop recording and don't start again.
    halted: bool,
}

pub type StatusListener = Box<dyn Fn(&RecorderStatus) + Send + Sync>;

#[derive(Clone)]
pub struct Recorder {
    inner: Arc<Mutex<Inner>>,
    work_dir: PathBuf,
    listener: Arc<StatusListener>,
    /// The status last sent to the app's window: only changes are sent.
    sent: Arc<Mutex<Option<RecorderStatus>>>,
    ffmpeg: Arc<Mutex<Option<(PathBuf, VideoEncoder)>>>,
}

fn container_ext(c: Container) -> &'static str {
    match c {
        Container::Mp4 => "mp4",
        Container::Mkv => "mkv",
    }
}

/// A new clip's file: "Clip_2026-11-27_21-03-15.mp4" in the clip folder.
fn new_clip_path(clip_root: &Path, ext: &str) -> Result<PathBuf, String> {
    let out_dir = clip_root.join(MY_CLIPS);
    fs::create_dir_all(&out_dir).map_err(|e| format!("Could not create {}: {e}", out_dir.display()))?;
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    let stamp = now
        .format(time::macros::format_description!("[year]-[month]-[day]_[hour]-[minute]-[second]"))
        .unwrap_or_else(|_| now_ms().to_string());
    let mut out = out_dir.join(format!("Clip_{stamp}.{ext}"));
    let mut n = 2;
    while out.exists() {
        out = out_dir.join(format!("Clip_{stamp}_{n}.{ext}"));
        n += 1;
    }
    Ok(out)
}

/// The recorded size for a `screen`-sized picture at the chosen resolution:
/// shrunk to its height (keeping the shape, even numbers), never enlarged.
fn obs_output_size(screen: (u32, u32), r: crate::settings::Resolution) -> (u32, u32) {
    let even = |v: u32| v & !1;
    match ffmpeg::target_height(r).filter(|h| *h < screen.1) {
        Some(h) => (even((u64::from(screen.0) * u64::from(h) / u64::from(screen.1)) as u32), even(h)),
        None => (even(screen.0), even(screen.1)),
    }
}

/// The same recording apart from a few pixels of size.
fn same_capture(a: Option<&crate::obs::Capture>, b: Option<&crate::obs::Capture>) -> bool {
    let near = |x: (u32, u32), y: (u32, u32)| x.0.abs_diff(y.0) <= 8 && x.1.abs_diff(y.1) <= 8;
    match (a, b) {
        (Some(a), Some(b)) => near(a.size, b.size) && near(a.out_size, b.out_size) && crate::obs::Capture { size: b.size, out_size: b.out_size, ..a.clone() } == *b,
        (None, None) => true,
        _ => false,
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let out = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .no_window()
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let text: String = String::from_utf8_lossy(&out.stderr).trim().chars().take(400).collect();
        Err(if text.is_empty() { format!("FFmpeg stopped ({}) without saying why", out.status) } else { text })
    }
}

impl Recorder {
    /// `work_dir` holds OBS's replay files until they become clips.
    pub fn new(settings: Settings, work_dir: PathBuf, listener: StatusListener) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                settings,
                status: RecorderStatus::new(RecState::Starting),
                waiting_for_window: false,
                obs: None,
                obs_failed: None,
                halted: false,
            })),
            work_dir,
            listener: Arc::new(listener),
            sent: Arc::new(Mutex::new(None)),
            ffmpeg: Arc::new(Mutex::new(None)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> RecorderStatus {
        self.lock().status.clone()
    }

    /// Tells the app's window, only when something changed (the recorder
    /// checks every 2 s; the window then doesn't redraw for nothing).
    fn send(&self, status: &RecorderStatus) {
        let mut sent = self.sent.lock().unwrap_or_else(|e| e.into_inner());
        if sent.as_ref() != Some(status) {
            *sent = Some(status.clone());
            drop(sent);
            (self.listener)(status);
        }
    }

    fn set_status(&self, f: impl FnOnce(&mut RecorderStatus)) {
        let status = {
            let mut inner = self.lock();
            f(&mut inner.status);
            inner.status.clone()
        };
        self.send(&status);
    }

    /// True while a game is being recorded (a clip can be saved).
    pub fn is_recording(&self) -> bool {
        self.lock().status.state == RecState::Recording
    }

    pub fn set_hotkey_error(&self, err: Option<String>) {
        self.set_status(|s| s.hotkey_error = err);
    }

    /// New settings; OBS picks them up on its next check.
    pub fn update_settings(&self, settings: Settings) {
        self.lock().settings = settings;
    }

    /// Shown while the single exe downloads FFmpeg (`failed`: it couldn't, and will retry).
    pub fn show_tools_status(&self, message: String, failed: bool) {
        self.set_status(|s| {
            s.state = if failed { RecState::NoFfmpeg } else { RecState::Starting };
            s.message = Some(message);
        });
    }

    /// Stops recording for good (until the app restarts), e.g. so an update can replace its files.
    pub fn halt(&self) {
        let mut inner = self.lock();
        inner.halted = true;
        inner.obs = None;
    }

    /// Runs the supervisor loop on a background thread.
    pub fn spawn(&self) {
        let me = self.clone();
        thread::Builder::new()
            .name("recorder".into())
            .spawn(move || crate::keep_running(|| me.supervise()))
            .expect("spawn recorder thread");
    }

    fn supervise(&self) {
        crate::procs::end_leftover_ffmpeg();
        let Some(path) = ffmpeg::locate() else {
            self.set_status(|s| {
                *s = RecorderStatus { message: Some("FFmpeg is missing. Reinstall CrossPOV.".into()), ..RecorderStatus::new(RecState::NoFfmpeg) };
            });
            return;
        };
        let detected = ffmpeg::detect_encoder(&path);
        *self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()) = Some((path, detected));
        self.set_status(|s| {
            s.state = RecState::Waiting;
            s.message = None;
        });

        // Whole screen: four times a second, is the game in front? Then the
        // game (Game Capture) shows, else the screen below it.
        {
            let inner = self.inner.clone();
            let _ = thread::Builder::new().name("game-in-front".into()).spawn(move || loop {
                thread::sleep(Duration::from_millis(250));
                let (obs, game) = {
                    let i = inner.lock().unwrap_or_else(|e| e.into_inner());
                    (i.obs.clone(), i.status.game.clone())
                };
                let Some(obs) = obs else { continue };
                let in_front = game.as_ref().map(|g| !games::covered(g));
                // Busy (OBS is being set up): next time.
                let locked = obs.try_lock();
                if let Ok(mut o) = locked {
                    if let Some(in_front) = in_front {
                        o.show_game(in_front);
                    }
                }
            });
        }

        let always = std::env::var("CROSSPOV_ALWAYS_RECORD").is_ok_and(|v| v == "1");
        // Let the launch update check finish (or give up) first: a newer
        // version then installs before anything is recorded.
        crate::updater::wait_for_launch_check(Duration::from_secs(20));
        loop {
            let settings = self.lock().settings.clone();
            let game = games::detect(&settings).or_else(|| always.then(Game::desktop));
            let playing = game.is_some();
            self.tick_obs(game, detected);
            thread::sleep(if playing { POLL } else { POLL_IDLE });
        }
    }

    /// One step of recording with OBS: keep OBS running (started with
    /// CrossPOV, restarted if it stops or the encoder settings change) and
    /// pointed at the game, or idle when there's none.
    fn tick_obs(&self, game: Option<Game>, detected: VideoEncoder) {
        let mut inner = self.lock();
        let settings = inner.settings.clone();
        let game_only = settings.capture == crate::settings::Capture::Window;
        let no_window = game_only && game.as_ref().is_some_and(|g| g.hwnd == 0);
        if no_window && !inner.waiting_for_window {
            crate::trail("recording: waiting for the game's window (Game window mode never records the desktop)");
        }
        inner.waiting_for_window = no_window;
        let want = game.is_some() && !inner.halted && !no_window;
        inner.status.game = game.clone();
        if inner.halted {
            return;
        }

        let encoder = ffmpeg::resolve_encoder(settings.encoder, detected);
        let profile = crate::obs::Profile {
            encoder,
            hevc: settings.codec == crate::settings::Codec::H265,
            kbps: ffmpeg::bitrate_kbps(&settings),
            buffer_seconds: settings.buffer_seconds,
            format: container_ext(settings.format),
            separate_tracks: settings.microphone && settings.separate_tracks,
            replay_dir: self.work_dir.join("obs-replays"),
            session_dir: crate::autoclip::wanted_session(&self.work_dir, &settings, game.as_ref()),
        };
        // The recorder running, with these encoder settings?
        if let Some(obs) = inner.obs.clone() {
            let mut o = obs.lock().unwrap_or_else(|e| e.into_inner());
            if !o.alive() {
                crate::trail(&format!("recording: the recorder stopped; starting it again ({})", o.log_lines().last().cloned().unwrap_or_default()));
                drop(o);
                inner.obs = None;
            } else if o.profile != profile {
                crate::trail("recording: encoder settings changed");
                let title = game.as_ref().map(|g| crate::obs::window_names(g.hwnd).0).unwrap_or_default();
                if let Err(e) = o.set_profile(profile.clone(), &title) {
                    crate::trail(&format!("recording: the recorder couldn't change settings ({e}); restarting it"));
                    drop(o);
                    inner.obs = None;
                }
            }
        }
        if inner.obs.is_none() {
            if inner.obs_failed.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
                return;
            }
            let Some(dir) = crate::tools::obs_dir() else {
                inner.status.state = RecState::Starting;
                inner.status.message = Some("Getting the recorder ready (one-time download)…".into());
                let status = inner.status.clone();
                drop(inner);
                self.send(&status);
                return;
            };
            crate::trail(&format!("recording: starting the recorder ({})", encoder.label()));
            drop(inner);
            // OBS takes a few seconds to load: not while holding the lock.
            let launched = crate::obs::Obs::launch(&dir, profile);
            inner = self.lock();
            match launched {
                Ok(obs) => {
                    crate::trail("recording: the recorder is ready");
                    inner.obs = Some(Arc::new(Mutex::new(obs)));
                    inner.obs_failed = None;
                }
                Err(e) => {
                    crate::trail(&format!("recording: the recorder couldn't start ({e}); trying again in 30 s"));
                    inner.obs_failed = Some(Instant::now());
                    inner.status.state = RecState::Error;
                    inner.status.message = Some(format!("The recorder couldn't start: {e}"));
                    let status = inner.status.clone();
                    drop(inner);
                    self.send(&status);
                    return;
                }
            }
        }

        // What it should record now.
        let desired = game.as_ref().filter(|_| want).map(|g| {
            let size = if game_only { g.window_size.or(g.screen_size) } else { g.screen_size }.unwrap_or((1920, 1080));
            crate::obs::Capture {
                source: if game_only {
                    crate::obs::Source::Game { exe: g.exe.clone(), class: crate::obs::window_names(g.hwnd).1 }
                } else {
                    crate::obs::Source::Screen { origin: g.screen_origin, game: (g.hwnd != 0).then(|| (g.exe.clone(), crate::obs::window_names(g.hwnd).1)) }
                },
                size,
                out_size: obs_output_size(size, settings.resolution),
                fps: settings.fps,
                game_audio: settings.game_audio.then(|| settings.game_volume as f32 / 100.0),
                desktop_audio: settings.audio_mode == crate::settings::AudioMode::Desktop,
                apps: settings.apps.iter().filter(|a| a.enabled).map(|a| (a.exe.clone(), a.volume as f32 / 100.0)).collect(),
                mic: settings.microphone.then(|| settings.mic_volume as f32 / 100.0),
                mic_device: settings.mic_device.clone(),
                denoise_mic: settings.microphone && settings.mic_noise_suppression,
                separate_tracks: settings.microphone && settings.separate_tracks,
            }
        });
        let Some(obs) = inner.obs.clone() else { return };
        let current = obs.lock().unwrap_or_else(|e| e.into_inner()).capture.clone();
        // A line or two of size wobble (VALORANT reports 1080, then 1079)
        // isn't worth starting over: that would empty the replay buffer.
        if !same_capture(desired.as_ref(), current.as_ref()) {
            match &desired {
                Some(c) => crate::trail(&format!(
                    "recording: {} with {} ({}) {}x{} -> {}x{}, {} fps, {} Mbps",
                    game.as_ref().map_or("", |g| g.exe.as_str()),
                    if game_only { "Game Capture" } else { "Display Capture" },
                    encoder.label(),
                    c.size.0,
                    c.size.1,
                    c.out_size.0,
                    c.out_size.1,
                    c.fps,
                    ffmpeg::bitrate_kbps(&settings) / 1000
                )),
                None => crate::trail("recording: stopped (game closed)"),
            }
            let title = game.as_ref().map(|g| crate::obs::window_names(g.hwnd).0).unwrap_or_default();
            drop(inner);
            let applied = obs.lock().unwrap_or_else(|e| e.into_inner()).apply(desired.clone(), &title);
            inner = self.lock();
            if let Err(e) = applied {
                crate::trail(&format!("recording: the recorder couldn't record ({e}); restarting it"));
                inner.obs = None;
                inner.obs_failed = Some(Instant::now());
            }
        }
        let recording = inner.obs.is_some() && desired.is_some();
        inner.status.state = if recording { RecState::Recording } else { RecState::Waiting };
        inner.status.encoder = recording.then(|| format!("{} ({})", if game_only { "Game Capture" } else { "Display Capture" }, encoder.label()));
        inner.status.message = None;
        let status = inner.status.clone();
        drop(inner);
        self.send(&status);
    }

    /// FFmpeg and the encoder it found, once known (used to cut clips too).
    pub fn ffmpeg_tools(&self) -> Option<(PathBuf, VideoEncoder)> {
        self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Saves the last `buffer_seconds` as a clip.
    pub fn save_clip(&self, clip_root: &Path) -> Result<ClipInfo, String> {
        let (obs, settings, game) = {
            let inner = self.lock();
            let obs = inner.obs.clone().filter(|_| inner.status.state == RecState::Recording);
            (obs, inner.settings.clone(), inner.status.game.as_ref().map(|g| g.name.clone()))
        };
        let obs = obs.ok_or("Not recording right now. Clips are saved while a game is open.")?;
        self.save_obs_clip(clip_root, &obs, &settings, game.filter(|g| !g.is_empty()))
    }

    /// F9 while OBS records: OBS saves its replay buffer, which becomes the clip.
    fn save_obs_clip(&self, clip_root: &Path, session: &Mutex<crate::obs::Obs>, settings: &Settings, game: Option<String>) -> Result<ClipInfo, String> {
        let ffmpeg_path = self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(p, _)| p.clone()).ok_or("FFmpeg not ready")?;
        let saved = {
            let mut s = session.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(h) = s.health() {
                crate::trail(&format!("clip: recorder {h}"));
            }
            for line in s.log_lines() {
                crate::trail(&format!("recorder: {line}"));
            }
            s.save_replay()?
        };
        let ext = saved.extension().and_then(|e| e.to_str()).unwrap_or(container_ext(settings.format)).to_string();
        let out = new_clip_path(clip_root, &ext)?;
        // OBS writes an MP4's index at the end; the app's player loads clips in
        // pieces and stutters on that (VLC doesn't mind). Copy it into the
        // clip folder with the index first: no re-encoding, same picture.
        let moved = ext == "mp4"
            && run_ffmpeg(&ffmpeg_path, &ffmpeg::faststart_args(&saved, &out)).is_ok()
            && fs::metadata(&out).is_ok_and(|m| m.len() > 0);
        if moved {
            let _ = fs::remove_file(&saved);
        } else if fs::rename(&saved, &out).is_err() {
            // The replay is in CrossPOV's own folder; the clip folder may be on another drive.
            fs::copy(&saved, &out).map_err(|e| format!("Could not save clip: {e}"))?;
            let _ = fs::remove_file(&saved);
        }
        Ok(Self::finish_clip(clip_root, &out, &ffmpeg_path, settings, game, f64::from(settings.buffer_seconds)))
    }

    /// Thumbnail, details and storage limit for a saved clip.
    fn finish_clip(clip_root: &Path, out: &Path, ffmpeg_path: &Path, settings: &Settings, game: Option<String>, duration: f64) -> ClipInfo {
        let thumb = clips::thumb_path(clip_root, out);
        if let Some(dir) = thumb.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = run_ffmpeg(ffmpeg_path, &ffmpeg::thumbnail_args(out, &thumb));
        clips::write_meta(clip_root, out, &ClipMeta { duration_sec: Some(duration), game: game.clone(), ..ClipMeta::default() });
        if settings.prune_oldest {
            clips::prune(clip_root, settings.storage_limit_gb);
        }

        let size = fs::metadata(out).map(|m| m.len()).unwrap_or(0);
        ClipInfo {
            name: out.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            path: out.to_string_lossy().into_owned(),
            kind: clips::ClipKind::Mine,
            size_bytes: size,
            created_ms: now_ms(),
            duration_sec: Some(duration),
            thumb: thumb.is_file().then(|| thumb.to_string_lossy().into_owned()),
            streamer: None,
            round: None,
            moment: None,
            map: None,
            match_id: None,
            match_start_sec: None,
            vod_url: None,
            vod_start_sec: None,
            game,
            made_ms: None,
            agent: None,
            kills: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Resolution;

    #[test]
    fn output_size_shrinks_to_the_chosen_height() {
        assert_eq!(obs_output_size((2560, 1440), Resolution::P1080), (1920, 1080));
        assert_eq!(obs_output_size((1568, 1080), Resolution::P1080), (1568, 1080), "never enlarged");
        assert_eq!(obs_output_size((1920, 1080), Resolution::Native), (1920, 1080));
    }
}
