//! The replay buffer: starts FFmpeg when the game opens, stops it when the
//! game closes, and turns the last N seconds into a clip on demand.

use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};

use serde::Serialize;

use crate::{
    audio::AudioPipe,
    clips::{self, ClipInfo, ClipMeta, MY_CLIPS},
    ffmpeg::{self, NoWindow, RecordPlan, VideoEncoder, VideoSource, SEGMENT_SECONDS},
    games::{self, Game},
    settings::{Container, Settings},
};

const POLL: Duration = Duration::from_secs(2);
/// While VALORANT is closed, look for it less often: it takes longer than
/// this to load, so recording still starts before you're in a match.
const POLL_IDLE: Duration = Duration::from_secs(5);
/// A recorder that dies sooner than this is treated as a startup failure.
const EARLY_EXIT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecState {
    /// Looking for FFmpeg and testing encoders.
    Starting,
    /// FFmpeg is missing.
    NoFfmpeg,
    /// Ready; waiting for the game to open.
    Waiting,
    Recording,
    Error,
}

#[derive(Debug, Clone, Serialize)]
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

/// Settings that require restarting FFmpeg when they change.
fn recording_key(s: &Settings) -> String {
    serde_json::json!([
        s.fps, s.resolution, s.quality, s.bitrate_mbps, s.encoder, s.codec, s.capture, s.stretched, s.buffer_seconds, s.audio_mode, s.game_audio, s.game_volume,
        s.apps, s.microphone, s.mic_device, s.mic_volume, s.separate_tracks
    ])
    .to_string()
}

struct Running {
    child: Child,
    audio: Option<AudioPipe>,
    plan: RecordPlan,
    started: Instant,
    key: String,
    /// Shown on clips saved from this recording.
    game: String,
    /// The game window's size when recording started (to notice it changing).
    window_size_at_start: Option<(u32, u32)>,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.audio.take(); // Stops audio capture.
    }
}

struct Inner {
    settings: Settings,
    running: Option<Running>,
    status: RecorderStatus,
    /// 0 = direct GPU path, 1 = compatibility mode, 2 = CPU encoder.
    fallback: u8,
    /// The game's real picture size, as window capture reported it, when it
    /// differs from its window (a smaller resolution in a full-size window):
    /// (window handle, size). Recording uses it instead of the window's size.
    content_size: Option<(u64, (u32, u32))>,
    /// Recording just the game's window failed on this PC (or for this game):
    /// record its screen instead until the game closes.
    window_failed: bool,
    /// A game window found filling its whole screen: recorded from the
    /// screen instead (see `fills_screen`), until the game closes.
    screen_for: Option<u64>,
    /// Screen capture stopped getting this game window's pictures: window
    /// capture from then on, until the game closes.
    no_screen_for: Option<u64>,
    /// Logged that the game's window isn't known yet (once per wait).
    waiting_for_window: bool,
    /// A full-screen game recorded by OBS's Game Capture (see obs.rs), and
    /// the recording key it was set up for.
    obs: Option<(String, Arc<Mutex<crate::obs::Session>>)>,
    /// When OBS last couldn't record: FFmpeg meanwhile, OBS tried again a minute later.
    obs_failed: Option<Instant>,
    /// Set before an update installs: stop recording and don't start again.
    halted: bool,
}

pub type StatusListener = Box<dyn Fn(&RecorderStatus) + Send + Sync>;

/// When another window covered the game's screen (you tabbed out), in ms
/// since 1970: those parts are blacked out of saved clips.
#[derive(Default)]
struct CoveredLog {
    since: Option<u64>,
    spans: std::collections::VecDeque<(u64, u64)>,
}

impl CoveredLog {
    fn note(&mut self, covered: bool, now: u64) {
        match (covered, self.since) {
            (true, None) => self.since = Some(now),
            (false, Some(start)) => {
                self.since = None;
                self.spans.push_back((start, now));
            }
            _ => {}
        }
        // Older than any clip can reach: forget.
        while self.spans.front().is_some_and(|&(_, end)| now.saturating_sub(end) > 15 * 60 * 1000) {
            self.spans.pop_front();
        }
    }

    /// All spans, the current one (still tabbed out) running until `now`.
    fn spans(&self, now: u64) -> Vec<(u64, u64)> {
        self.spans.iter().copied().chain(self.since.map(|s| (s, now))).collect()
    }
}

#[derive(Clone)]
pub struct Recorder {
    covered: Arc<Mutex<CoveredLog>>,
    inner: Arc<Mutex<Inner>>,
    work_dir: PathBuf,
    listener: Arc<StatusListener>,
    ffmpeg: Arc<Mutex<Option<(PathBuf, VideoEncoder)>>>,
}

/// The game's picture size from window capture's "Capture size changed to
/// 1568x1080" (the last one in FFmpeg's log), if it said so.
fn captured_size_from_log(log: &str) -> Option<(u32, u32)> {
    let line = log.lines().rev().find(|l| l.contains("Capture size changed to "))?;
    let (w, h) = line.split("Capture size changed to ").nth(1)?.trim().split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// Whether a window's size changed for real: more than 8 pixels either way.
/// Unknown sizes (a minimised window) never count.
/// Whether a game's window covers its whole screen at the screen's usual
/// widescreen shape (1920x1080 on a 1920x1080 screen; a line or two short
/// counts). Such a game is recorded from the screen: window capture handed
/// VALORANT's frames over in bursts at ~70 fps once its picture went a line
/// short after alt-tabbing, while screen capture stays a steady 144. Not a
/// stretched resolution (1568x1080, narrower than 16:10) or a smaller picture
/// inside the window: window capture records those exactly as drawn.
fn fills_screen(window: Option<(u32, u32)>, screen: Option<(u32, u32)>, content: Option<(u32, u32)>) -> bool {
    let (Some((w, h)), Some((sw, sh))) = (window, screen) else { return false };
    let near = |(a, b): (u32, u32), (c, d): (u32, u32)| a.abs_diff(c) <= 2 && b.abs_diff(d) <= 2;
    sh > 0 && near((w, h), (sw, sh)) && content.is_none_or(|c| near(c, (w, h))) && u64::from(sw) * 10 >= u64::from(sh) * 16
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

fn size_changed(before: Option<(u32, u32)>, now: Option<(u32, u32)>) -> bool {
    match (before, now) {
        (Some((w1, h1)), Some((w2, h2))) => w1.abs_diff(w2) > 8 || h1.abs_diff(h2) > 8,
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

/// Re-encodes `joined` into `out` with `hide` (seconds) blacked out: first
/// decoding on the graphics card where it can, then all on the CPU.
fn blackout(ffmpeg: &Path, joined: &Path, out: &Path, hide: &[(f64, f64)], encoder: VideoEncoder, hevc: bool, kbps: u32) -> Result<(), String> {
    run_ffmpeg(ffmpeg, &ffmpeg::blackout_args(joined, out, hide, encoder, hevc, kbps, true)).or_else(|gpu| {
        run_ffmpeg(ffmpeg, &ffmpeg::blackout_args(joined, out, hide, encoder, hevc, kbps, false))
            .map_err(|cpu| format!("with GPU decoding: {gpu} | on the CPU: {cpu}"))
    })
}

/// Segment file names from FFmpeg's list, oldest first, as full paths.
/// The main screen's real height in pixels (not scaled by Windows' display
/// zoom), which is what the recorder captures.
#[cfg(windows)]
fn primary_screen_height() -> Option<u32> {
    use windows::Win32::Graphics::Gdi::{EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS};
    let mut mode = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
    // SAFETY: `mode` is a valid DEVMODEW with dmSize set; a null device name means the main screen.
    let ok = unsafe { EnumDisplaySettingsW(windows::core::PCWSTR::null(), ENUM_CURRENT_SETTINGS, &mut mode) };
    (ok.as_bool() && mode.dmPelsHeight > 0).then_some(mode.dmPelsHeight)
}

#[cfg(not(windows))]
fn primary_screen_height() -> Option<u32> {
    None
}

fn read_segment_list(plan: &RecordPlan) -> Vec<PathBuf> {
    fs::read_to_string(plan.list_file())
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            let p = PathBuf::from(l);
            if p.is_absolute() { p } else { plan.segment_dir.join(p) }
        })
        .collect()
}

fn concat_list_line(p: &Path) -> String {
    // The concat format quotes paths with ' and escapes ' as '\''.
    format!("file '{}'\n", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"))
}

impl Recorder {
    /// `work_dir` holds the replay buffer files (a temp/cache folder).
    pub fn new(settings: Settings, work_dir: PathBuf, listener: StatusListener) -> Self {
        Self {
            covered: Arc::new(Mutex::new(CoveredLog::default())),
            inner: Arc::new(Mutex::new(Inner {
                settings,
                running: None,
                status: RecorderStatus::new(RecState::Starting),
                fallback: 0,
                content_size: None,
                window_failed: false,
                screen_for: None,
                no_screen_for: None,
                waiting_for_window: false,
                obs: None,
                obs_failed: None,
                halted: false,
            })),
            work_dir,
            listener: Arc::new(listener),
            ffmpeg: Arc::new(Mutex::new(None)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> RecorderStatus {
        self.lock().status.clone()
    }

    fn set_status(&self, f: impl FnOnce(&mut RecorderStatus)) {
        let status = {
            let mut inner = self.lock();
            f(&mut inner.status);
            inner.status.clone()
        };
        (self.listener)(&status);
    }

    /// True while a game is being recorded (a clip can be saved).
    pub fn is_recording(&self) -> bool {
        self.lock().running.is_some()
    }

    pub fn set_hotkey_error(&self, err: Option<String>) {
        self.set_status(|s| s.hotkey_error = err);
    }

    /// New settings; the buffer restarts on its next check if recording options changed.
    pub fn update_settings(&self, settings: Settings) {
        let mut inner = self.lock();
        if recording_key(&inner.settings) != recording_key(&settings) {
            inner.fallback = 0;
        }
        inner.settings = settings;
    }

    /// Shown while the single exe downloads FFmpeg (`failed`: it couldn't, and will retry).
    pub fn show_tools_status(&self, message: String, failed: bool) {
        self.set_status(|s| {
            s.state = if failed { RecState::NoFfmpeg } else { RecState::Starting };
            s.message = Some(message);
        });
    }

    /// Stops FFmpeg for good (until the app restarts), e.g. so an update can replace its files.
    pub fn halt(&self) {
        let mut inner = self.lock();
        inner.halted = true;
        inner.running = None;
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
        *self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()) = Some((path.clone(), detected));
        self.set_status(|s| {
            s.state = RecState::Waiting;
            s.message = None;
        });

        // Four times a second, while recording the whole screen: is another
        // window covering the game (you tabbed out)? Those parts get blacked
        // out of saved clips, like ShadowPlay.
        {
            let (inner, covered) = (self.inner.clone(), self.covered.clone());
            let _ = thread::Builder::new().name("tab-watch".into()).spawn(move || loop {
                thread::sleep(Duration::from_millis(250));
                let game = {
                    let i = inner.lock().unwrap_or_else(|e| e.into_inner());
                    let screen = i.running.as_ref().is_some_and(|r| r.plan.window.is_none());
                    i.status.game.clone().filter(|_| screen)
                };
                let is_covered = game.as_ref().is_some_and(games::covered);
                let mut log = covered.lock().unwrap_or_else(|e| e.into_inner());
                let was = log.since.is_some();
                log.note(is_covered, now_ms());
                if was != is_covered {
                    crate::trail(if is_covered { "tabbed out: hiding the screen in clips" } else { "back in the game" });
                }
            });
        }

        let always = std::env::var("CROSSPOV_ALWAYS_RECORD").is_ok_and(|v| v == "1");
        let source = if cfg!(windows) && std::env::var("CROSSPOV_TEST_PATTERN").is_err() {
            VideoSource::Desktop
        } else {
            VideoSource::TestPattern
        };
        // Let the launch update check finish (or give up) first: a newer
        // version then installs before anything is recorded.
        crate::updater::wait_for_launch_check(Duration::from_secs(20));
        loop {
            let settings = self.lock().settings.clone();
            let game = games::detect(&settings).or_else(|| {
                always.then(Game::desktop)
            });
            let playing = game.is_some();
            self.tick(game, &path, detected, source);
            thread::sleep(if playing { POLL } else { POLL_IDLE });
        }
    }

    fn tick(&self, game: Option<Game>, ffmpeg_path: &Path, detected: VideoEncoder, source: VideoSource) {
        let mut inner = self.lock();
        // Game window mode records only the game: while its window isn't known
        // (minimised or behind other windows when CrossPOV starts), record
        // nothing rather than the desktop.
        let game_only = inner.settings.capture == crate::settings::Capture::Window;
        let no_window = game_only && game.as_ref().is_some_and(|g| g.hwnd == 0);
        if no_window && !inner.waiting_for_window {
            crate::trail("recording: waiting for the game's window (Game window mode never records the desktop)");
        }
        inner.waiting_for_window = no_window;
        let want = game.is_some() && !inner.halted && !no_window;
        // Another game, or the game moved to another screen: start afresh.
        // Just the game's window when known (a new window, e.g. the game
        // restarting, starts afresh); its screen if window capture failed.
        // Screen capture said the game is in front but sends it no pictures
        // (Windows can draw a windowed game past the desktop): window
        // capture instead, which always gets them.
        if let Some(h) = inner.running.as_ref().and_then(|r| r.plan.only_window) {
            let log = fs::read_to_string(self.work_dir.join("ffmpeg.log")).unwrap_or_default();
            if log.contains("Game in front but no new pictures") {
                crate::trail("recording: screen capture isn't getting the game's picture; switching to window capture");
                inner.no_screen_for = Some(h);
                inner.screen_for = None;
            }
        }
        if let Some(g) = game.as_ref().filter(|g| g.hwnd != 0 && inner.screen_for != Some(g.hwnd) && inner.no_screen_for != Some(g.hwnd)) {
            let content = inner.content_size.filter(|(h, _)| *h == g.hwnd).map(|(_, s)| s);
            if inner.settings.capture == crate::settings::Capture::Window && fills_screen(g.window_size, g.screen_size, content) {
                crate::trail("recording: the game fills its screen; recording the screen (steadier than window capture), only while the game is in front");
                inner.screen_for = Some(g.hwnd);
            }
        }
        let window = game
            .as_ref()
            .map(|g| g.hwnd)
            .filter(|&h| h != 0 && !inner.window_failed && inner.settings.capture == crate::settings::Capture::Window);
        let key = format!(
            "{}|{}|{}|{}",
            recording_key(&inner.settings),
            game.as_ref().map_or("", |g| g.exe.as_str()).to_lowercase(),
            game.as_ref().map_or(0, |g| g.output_idx),
            // Not the window's size: it wobbles (VALORANT reports 1080, then
            // 1079), and a restart empties the replay buffer. Window capture
            // resizes every frame to the size it started with anyway.
            match (window, game.as_ref().map(|g| g.hwnd).filter(|h| *h != 0 && game_only && inner.window_failed)) {
                (Some(h), _) => format!("w{h}"),
                (None, Some(h)) => format!("s{h}"),
                _ => "0".into(),
            }
        );
        inner.status.game = game.clone();

        // A full-screen game in Game window mode, with OBS ready: OBS's Game
        // Capture records it (frames from the game itself; Windows' capture
        // APIs can see what's behind such a game instead). See obs.rs.
        let use_obs = want
            && game_only
            && inner.obs_failed.is_none_or(|t| t.elapsed() > Duration::from_secs(60))
            && crate::tools::obs_dir().is_some()
            && game.as_ref().is_some_and(|g| g.hwnd != 0 && inner.screen_for == Some(g.hwnd));
        // OBS's canvas is the game's size: a new size (switching to a stretched
        // resolution mid-game) restarts it, or the picture sits off-centre.
        let obs_key = format!("{key}|{:?}", game.as_ref().and_then(|g| g.screen_size.or(g.window_size)));
        if let Some((running_key, session)) = inner.obs.clone() {
            let alive = session.lock().unwrap_or_else(|e| e.into_inner()).alive();
            if !alive {
                crate::trail("recording: OBS stopped; recording with FFmpeg, OBS again in a minute");
                inner.obs_failed = Some(Instant::now());
            }
            if !alive || !use_obs || running_key != obs_key {
                if alive && use_obs {
                    crate::trail("recording: the game's size changed, starting OBS afresh at the new size");
                }
                inner.obs = None;
            }
        }
        if use_obs {
            inner.running = None; // never both
            if inner.obs.is_none() {
                let g = game.clone().unwrap_or_default();
                let settings = inner.settings.clone();
                let encoder = ffmpeg::resolve_encoder(settings.encoder, detected);
                let size = g.screen_size.or(g.window_size).unwrap_or((1920, 1080));
                let (title, class) = crate::obs::window_names(g.hwnd);
                let setup = crate::obs::Setup {
                    exe: g.exe.clone(),
                    title,
                    class,
                    size,
                    out_size: obs_output_size(size, settings.resolution),
                    fps: settings.fps,
                    encoder,
                    hevc: settings.codec == crate::settings::Codec::H265,
                    kbps: ffmpeg::bitrate_kbps(&settings),
                    buffer_seconds: settings.buffer_seconds,
                    format: container_ext(settings.format),
                    game_audio: settings.game_audio.then(|| settings.game_volume as f32 / 100.0),
                    mic: settings.microphone.then(|| settings.mic_volume as f32 / 100.0),
                    denoise_mic: settings.microphone && settings.mic_noise_suppression,
                    separate_tracks: settings.separate_tracks,
                    replay_dir: self.work_dir.join("obs-replays"),
                };
                crate::trail(&format!(
                    "recording: {} with OBS Game Capture ({}) {}x{} -> {}x{}, {} fps, {} Mbps",
                    g.exe,
                    encoder.label(),
                    setup.size.0,
                    setup.size.1,
                    setup.out_size.0,
                    setup.out_size.1,
                    setup.fps,
                    setup.kbps / 1000
                ));
                inner.status.state = RecState::Starting;
                let status = inner.status.clone();
                drop(inner);
                (self.listener)(&status);
                // OBS takes a few seconds to start: not while holding the lock.
                let started = crate::tools::obs_dir().ok_or_else(|| "OBS isn't ready".to_string()).and_then(|dir| crate::obs::Session::start(&dir, setup));
                let mut inner = self.lock();
                match started {
                    Ok(session) => {
                        crate::trail("recording: started (OBS)");
                        inner.obs = Some((obs_key, Arc::new(Mutex::new(session))));
                        inner.status.state = RecState::Recording;
                        inner.status.encoder = Some(format!("OBS Game Capture ({})", encoder.label()));
                        inner.status.message = None;
                    }
                    Err(e) => {
                        crate::trail(&format!("recording: OBS couldn't record ({e}); recording with FFmpeg, OBS again in a minute"));
                        inner.obs_failed = Some(Instant::now());
                    }
                }
                let status = inner.status.clone();
                drop(inner);
                (self.listener)(&status);
                return;
            }
            let status = inner.status.clone();
            drop(inner);
            (self.listener)(&status);
            return;
        }

        // Stop if the game closed or recording settings changed, or the game's
        // picture really changed size (e.g. switching to a stretched
        // resolution): window capture would leave it off-centre with black
        // beside it. A line or two of wobble (1080/1079) doesn't count.
        let mut resized = inner.running.as_ref().is_some_and(|r| {
            r.plan.window.is_some() && size_changed(r.window_size_at_start, game.as_ref().and_then(|g| g.window_size))
        });
        if resized {
            crate::trail("recording: the game's picture changed size, starting afresh");
            inner.content_size = None;
        }
        // Window capture says the game draws a different size than its window
        // (VALORANT at 1568x1080 in a 1920x1080 window): record at that size.
        if !resized {
            if let Some(r) = inner.running.as_ref().filter(|r| r.plan.window.is_some()) {
                let log = fs::read_to_string(self.work_dir.join("ffmpeg.log")).unwrap_or_default();
                if let Some(size) = captured_size_from_log(&log).filter(|&s| size_changed(r.plan.source_size, Some(s))) {
                    crate::trail(&format!("recording: the game draws at {}x{} inside its window; recording at that size", size.0, size.1));
                    inner.content_size = r.plan.window.map(|h| (h, size));
                    resized = true;
                }
            }
        }
        let stale = inner.running.as_ref().is_some_and(|r| r.key != key) || resized;
        if (!want || stale) && inner.running.is_some() {
            inner.running = None;
        }

        // Notice FFmpeg exiting on its own.
        let mut died_early = None;
        if let Some(r) = inner.running.as_mut() {
            if let Ok(Some(code)) = r.child.try_wait() {
                let log = fs::read_to_string(self.work_dir.join("ffmpeg.log")).unwrap_or_default();
                // FFmpeg's own errors (it only logs errors): the first few say why.
                let lines: Vec<&str> = log.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
                let reason = lines.iter().take(4).chain(lines.last().filter(|_| lines.len() > 4)).copied().collect::<Vec<_>>().join(" | ");
                died_early = Some((r.started.elapsed() < EARLY_EXIT, format!("Recorder stopped ({code}). {reason}"), r.plan.window.is_some()));
                inner.running = None;
            }
        }
        if let Some((early, msg, was_window)) = died_early {
            eprintln!("{msg}");
            if early && was_window {
                // Window capture didn't work here: record the screen instead.
                crate::trail(&format!("recording: window capture failed, recording the screen ({msg})"));
                inner.window_failed = true;
            } else if early {
                inner.fallback += 1; // Try a safer setup next time.
            }
            if inner.fallback > 2 {
                inner.status.state = RecState::Error;
                inner.status.message = Some(msg);
                let status = inner.status.clone();
                drop(inner);
                (self.listener)(&status);
                return;
            }
        }

        if want && inner.running.is_none() && inner.status.state != RecState::Error {
            let settings = inner.settings.clone();
            let mut encoder = ffmpeg::resolve_encoder(settings.encoder, detected);
            if inner.fallback >= 2 {
                encoder = VideoEncoder::Cpu;
            }
            let compat = inner.fallback >= 1;
            crate::trail(&format!(
                "recording: starting ({}{}) {:?}, {} fps, {} Mbps, {:?}",
                encoder.label(),
                if compat { ", compatibility mode" } else { "" },
                settings.resolution,
                settings.fps,
                ffmpeg::bitrate_kbps(&settings) / 1000,
                settings.codec,
            ));
            let mut g = game.clone().unwrap_or_default();
            // Screen capture in Game window mode (a full-screen game, or window
            // capture failed on this PC): only while the game is in front.
            // Window capture failed on this PC: screen capture, only while the game is what's seen.
            let only_window = Some(g.hwnd).filter(|h| *h != 0 && game_only && inner.window_failed);
            // Whole screen: the screen the game is on, found by FFmpeg from its window.
            let monitor_window = Some(g.hwnd).filter(|h| *h != 0 && window.is_none() && only_window.is_none());
            // A full-screen game: Windows Graphics Capture of its monitor (sees
            // the game even when Windows shows it past the desktop, which window
            // capture and Desktop Duplication missed), only while it's the game.
            // Not used: OBS records full-screen games, and its fallback is window
            // capture, which can never show another window (monitor capture let
            // a full-screen Discord on top through).
            let wgc_monitor = Some(g.hmonitor).filter(|_| false);
            g.hwnd = window.unwrap_or(0);
            let window_size_at_start = g.window_size;
            // The game's real picture size, if window capture reported one for this window.
            if let Some((_, size)) = inner.content_size.filter(|(h, _)| *h == g.hwnd && g.hwnd != 0) {
                g.window_size = Some(size);
            }
            let size = if window.is_some() { g.window_size } else { g.screen_size };
            crate::trail(&format!(
                "recording: {} {}{}{}",
                if window.is_some() { "the game's window" } else { "the whole screen" },
                g.refresh_hz.map(|hz| format!("(monitor {hz} Hz) ")).unwrap_or_default(),
                size.map(|(w, h)| format!("{w}x{h}")).unwrap_or_else(|| "(size unknown)".into()),
                if window.is_some() {
                    ffmpeg::window_output_size(size, settings.resolution, settings.stretched == crate::settings::Stretched::Stretch).map(|(w, h)| format!(", recorded at {w}x{h}")).unwrap_or_default()
                } else {
                    String::new()
                }
            ));
            match self.start(ffmpeg_path, &settings, encoder, compat, source, key, &g, only_window, monitor_window, wgc_monitor) {
                Ok(running) => {
                    crate::trail("recording: started");
                    inner.status.state = RecState::Recording;
                    inner.status.encoder = Some(format!("{}{}", encoder.label(), if compat { " (compatibility mode)" } else { "" }));
                    inner.status.message = None;
                    inner.status.audio_warning = None;
                    let mut running = running;
                    running.window_size_at_start = window_size_at_start;
                    inner.running = Some(running);
                }
                Err(e) => {
                    inner.status.state = RecState::Error;
                    inner.status.message = Some(e);
                }
            }
        } else if !want && inner.status.state == RecState::Recording {
            crate::trail("recording: stopped (game closed)");
            inner.status.state = RecState::Waiting;
            inner.status.encoder = None;
        }
        if !want && inner.status.state == RecState::Error {
            // Game closed: give it a fresh try next time.
            inner.status.state = RecState::Waiting;
            inner.status.message = None;
            inner.fallback = 0;
        }
        if !want {
            inner.window_failed = false;
            inner.obs_failed = None;
            inner.obs = None;
            inner.content_size = None;
            inner.screen_for = None;
            inner.no_screen_for = None;
        }

        // Surface audio fallbacks (e.g. older Windows) once they're known.
        let warning = inner.running.as_ref().and_then(|r| r.audio.as_ref()).and_then(AudioPipe::warning);
        if warning.is_some() {
            inner.status.audio_warning = warning;
        }
        let status = inner.status.clone();
        drop(inner);
        (self.listener)(&status);
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        &self,
        ffmpeg_path: &Path,
        settings: &Settings,
        encoder: VideoEncoder,
        compat: bool,
        source: VideoSource,
        key: String,
        game: &Game,
        only_window: Option<u64>,
        monitor_window: Option<u64>,
        wgc_monitor: Option<u64>,
    ) -> Result<Running, String> {
        let segment_dir = self.work_dir.join("buffer");
        let _ = fs::remove_dir_all(&segment_dir);
        fs::create_dir_all(&segment_dir).map_err(|e| format!("Could not create buffer folder: {e}"))?;
        let audio = settings.game_audio || settings.microphone;
        let plan = RecordPlan {
            source,
            encoder,
            audio,
            compat,
            segment_dir,
            segment_count: ffmpeg::segment_count(settings.buffer_seconds),
            screen_height: game.screen_height.or_else(primary_screen_height),
            output_idx: game.output_idx,
            hevc: settings.codec == crate::settings::Codec::H265,
            window: (game.hwnd != 0).then_some(game.hwnd),
            source_size: if game.hwnd != 0 { game.window_size } else { game.screen_size },
            only_window,
            monitor_window,
            wgc_monitor,
        };
        let log = File::create(self.work_dir.join("ffmpeg.log")).map_err(|e| e.to_string())?;
        let mut child = Command::new(ffmpeg_path)
            .args(ffmpeg::record_args(settings, &plan))
            .stdin(if audio { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::null())
            .stderr(log)
            .no_window()
            .spawn()
            .map_err(|e| format!("Could not start FFmpeg: {e}"))?;
        crate::procs::tie_to_app(&child);
        let audio = child.stdin.take().map(|stdin| AudioPipe::start(settings, &game.exe, stdin));
        Ok(Running { child, audio, plan, started: Instant::now(), key, game: game.name.clone(), window_size_at_start: game.window_size })
    }

    /// FFmpeg and the encoder it found, once known (used to cut clips too).
    pub fn ffmpeg_tools(&self) -> Option<(PathBuf, VideoEncoder)> {
        self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Saves the last `buffer_seconds` as a clip. Waits for the segment being
    /// written right now to finish, so the clip includes the moment the
    /// hotkey was pressed.
    pub fn save_clip(&self, clip_root: &Path) -> Result<ClipInfo, String> {
        let obs = {
            let inner = self.lock();
            inner.obs.as_ref().map(|(_, s)| (s.clone(), inner.settings.clone(), inner.status.game.as_ref().map(|g| g.name.clone())))
        };
        if let Some((session, settings, game)) = obs {
            return self.save_obs_clip(clip_root, &session, &settings, game.filter(|g| !g.is_empty()));
        }
        let (plan, settings, game) = {
            let inner = self.lock();
            let r = inner.running.as_ref().ok_or("Not recording right now. Clips are saved while a game is open.")?;
            (r.plan.clone(), inner.settings.clone(), r.game.clone())
        };
        let game = Some(game).filter(|g| !g.is_empty());
        let ffmpeg_path = self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(p, _)| p.clone()).ok_or("FFmpeg not ready")?;

        if let Some(h) = fs::read_to_string(plan.progress_file()).ok().as_deref().and_then(ffmpeg::recording_health) {
            // Window capture: frames as captured, so this is how many real
            // frames per second Windows delivered.
            crate::trail(&format!("clip: recording {h}{}", if plan.window.is_some() { " (window capture: real frames)" } else { "" }));
        }
        // FFmpeg's own warnings about this recording (e.g. a frame rate cap), once each.
        if let Ok(log) = fs::read_to_string(self.work_dir.join("ffmpeg.log")) {
            let changes = log.matches("Capture size changed to ").count();
            if changes > 2 {
                crate::trail(&format!("clip: the game's picture changed size {changes} times while recording"));
            }
            let mut seen: Vec<&str> = Vec::new();
            for line in log.lines().map(str::trim).filter(|l| !l.is_empty()) {
                if seen.len() < 3 && !seen.contains(&line) {
                    seen.push(line);
                }
            }
            for line in seen {
                crate::trail(&format!("ffmpeg: {}", line.chars().take(200).collect::<String>()));
            }
        }
        let before = read_segment_list(&plan);
        let deadline = Instant::now() + Duration::from_secs(u64::from(SEGMENT_SECONDS) + 2);
        let mut segments = before.clone();
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(150));
            segments = read_segment_list(&plan);
            if !before.is_empty() && segments.last() != before.last() {
                break;
            }
            if before.is_empty() && !segments.is_empty() {
                break;
            }
        }
        if segments.is_empty() {
            return Err("The buffer is still filling up. Try again in a few seconds.".into());
        }
        let wanted = settings.buffer_seconds.div_ceil(SEGMENT_SECONDS) as usize;
        let take = &segments[segments.len().saturating_sub(wanted)..];

        let ext = container_ext(settings.format);
        let out = new_clip_path(clip_root, ext)?;

        // The last segment's file time is when the clip ends.
        let clip_end = take
            .last()
            .and_then(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map_or_else(now_ms, |d| d.as_millis() as u64);
        // Parts where you'd tabbed out (whole-screen recording only), for the
        // clip made of `used`.
        let hide_for = |used: &[PathBuf]| -> Vec<(f64, f64)> {
            // Only the game was recorded: nothing to hide.
            if plan.window.is_some() || plan.only_window.is_some() {
                return Vec::new();
            }
            let clip_start = clip_end.saturating_sub(u64::from(used.len() as u32 * SEGMENT_SECONDS) * 1000);
            let spans = self.covered.lock().unwrap_or_else(|e| e.into_inner()).spans(now_ms());
            ffmpeg::blackout_ranges(&spans, clip_start, clip_end, 300)
        };

        // Join the segments. FFmpeg takes the sound's format from the first
        // one; right after recording (re)started, that one can have no sound
        // yet ("sample rate not set"). Then leave out the first one or two;
        // as a last resort, save the picture without sound rather than nothing.
        let list = plan.segment_dir.join(format!("concat-{}.txt", now_ms()));
        let mut joined_ok: Option<(&[PathBuf], Vec<(f64, f64)>, PathBuf)> = None;
        let mut last_err = String::new();
        for skip in 0..=2usize.min(take.len().saturating_sub(1)) {
            let used = &take[skip..];
            let hide = hide_for(used);
            let joined = if hide.is_empty() { out.clone() } else { plan.segment_dir.join(format!("joined-{}.{ext}", now_ms())) };
            fs::write(&list, used.iter().map(|p| concat_list_line(p)).collect::<String>()).map_err(|e| e.to_string())?;
            match run_ffmpeg(&ffmpeg_path, &ffmpeg::concat_args(&list, &joined, settings.format, plan.hevc, true)) {
                Ok(()) => {
                    if skip > 0 {
                        crate::trail(&format!("clip: left out the first {skip} segment(s), which had no sound yet"));
                    }
                    joined_ok = Some((used, hide, joined));
                    break;
                }
                Err(e) => last_err = e,
            }
        }
        if joined_ok.is_none() {
            let hide = hide_for(take);
            let joined = if hide.is_empty() { out.clone() } else { plan.segment_dir.join(format!("joined-{}.{ext}", now_ms())) };
            fs::write(&list, take.iter().map(|p| concat_list_line(p)).collect::<String>()).map_err(|e| e.to_string())?;
            run_ffmpeg(&ffmpeg_path, &ffmpeg::concat_args(&list, &joined, settings.format, plan.hevc, false))
                .map_err(|e| format!("Could not save clip: {last_err} | without sound: {e}"))?;
            crate::trail(&format!("clip: saved without sound ({last_err})"));
            joined_ok = Some((take, hide, joined));
        }
        let _ = fs::remove_file(&list);
        let (take, hide, joined) = joined_ok.expect("joined above");
        if !hide.is_empty() {
            let encoder = self.ffmpeg_tools().map_or(VideoEncoder::Cpu, |(_, e)| e);
            let secs: f64 = hide.iter().map(|(a, b)| b - a).sum();
            crate::trail(&format!("clip: hiding {secs:.1} s where you'd tabbed out"));
            if let Err(e) = blackout(&ffmpeg_path, &joined, &out, &hide, encoder, plan.hevc, ffmpeg::bitrate_kbps(&settings)) {
                // Keep the clip rather than lose it.
                crate::trail(&format!("clip: couldn't hide the tabbed-out parts ({e}); saved as recorded"));
                let _ = fs::remove_file(&out);
                fs::rename(&joined, &out).or_else(|_| fs::copy(&joined, &out).map(|_| ())).map_err(|e| format!("Could not save clip: {e}"))?;
            }
            let _ = fs::remove_file(&joined);
        }

        let duration = (take.len() as u32 * SEGMENT_SECONDS) as f64;
        Ok(Self::finish_clip(clip_root, &out, &ffmpeg_path, &settings, game, duration))
    }

    /// F9 while OBS records: OBS saves its replay buffer, which becomes the clip.
    fn save_obs_clip(&self, clip_root: &Path, session: &Mutex<crate::obs::Session>, settings: &Settings, game: Option<String>) -> Result<ClipInfo, String> {
        let ffmpeg_path = self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(p, _)| p.clone()).ok_or("FFmpeg not ready")?;
        let saved = {
            let mut s = session.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(h) = s.health() {
                crate::trail(&format!("clip: OBS {h}"));
            }
            for line in s.log_lines() {
                crate::trail(&format!("obs: {line}"));
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_games_real_picture_size() {
        let log = "[Parsed_gfxcapture_0 @ 000001] Capture size changed to 1920x1080\n[Parsed_gfxcapture_0 @ 000001] Capture size changed to 1568x1080\nother line\n";
        assert_eq!(captured_size_from_log(log), Some((1568, 1080)));
        assert_eq!(captured_size_from_log("nothing"), None);
    }

    #[test]
    fn only_real_size_changes_restart_window_recording() {
        assert!(size_changed(Some((1920, 1080)), Some((1568, 1080))), "switched to a stretched resolution");
        assert!(!size_changed(Some((1920, 1080)), Some((1920, 1079))), "a line of wobble");
        assert!(!size_changed(Some((1920, 1080)), None), "minimised: size unknown");
    }

    #[test]
    fn full_screen_games_are_recorded_from_the_screen() {
        let fhd = Some((1920, 1080));
        assert!(fills_screen(fhd, fhd, None));
        assert!(fills_screen(Some((1920, 1079)), fhd, Some((1920, 1079))), "a line short");
        assert!(fills_screen(Some((2560, 1440)), Some((2560, 1440)), None));
        assert!(!fills_screen(Some((1568, 1080)), Some((1568, 1080)), None), "true stretch");
        assert!(!fills_screen(fhd, fhd, Some((1568, 1080))), "smaller picture inside the window");
        assert!(!fills_screen(Some((1280, 720)), fhd, None), "windowed");
        assert!(!fills_screen(None, fhd, None), "size unknown");
    }

    #[test]
    fn tabbed_out_times_are_logged_as_spans() {
        let mut log = CoveredLog::default();
        log.note(false, 1_000);
        log.note(true, 2_000);
        log.note(true, 2_250);
        log.note(false, 5_000);
        log.note(true, 9_000);
        assert_eq!(log.spans(10_000), vec![(2_000, 5_000), (9_000, 10_000)], "the open one runs until now");
        log.note(false, 20 * 60 * 1000);
        assert_eq!(log.spans(20 * 60 * 1000).len(), 1, "older than any clip: forgotten");
    }

    /// Blacks out part of a real clip with real FFmpeg, and checks the
    /// picture there is black while the rest isn't. Uses only what the small
    /// FFmpeg has (testsrc2, the CPU encoder, image2). Skipped without FFmpeg.
    #[test]
    fn blacks_out_the_tabbed_out_part_of_a_clip() {
        let Some(ff) = ffmpeg::locate() else {
            eprintln!("ffmpeg not found; skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("crosspov-black-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (src, out) = (dir.join("in.mp4"), dir.join("out.mp4"));
        let made = Command::new(&ff)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30"])
            .args(["-t", "4", "-vf", "format=nv12", "-c:v", VideoEncoder::Cpu.codec(), "-b:v", "1M"])
            .arg(&src)
            .output()
            .unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        // As the app does it: graphics-card decoding when available (this
        // machine may have none: it must still work).
        blackout(&ff, &src, &out, &[(1.0, 2.0)], VideoEncoder::Cpu, false, 1_000).expect("blackout");
        // Average brightness of one frame, as an 8x8 grey picture.
        let brightness = |at: &str| -> f64 {
            let raw = dir.join(format!("frame-{at}.gray"));
            let o = Command::new(&ff)
                .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", at, "-i"])
                .arg(&out)
                .args(["-frames:v", "1", "-vf", "scale=8:8,format=gray", "-c:v", "rawvideo", "-f", "image2", "-update", "1"])
                .arg(&raw)
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let px = fs::read(&raw).unwrap();
            px.iter().map(|&b| f64::from(b)).sum::<f64>() / px.len().max(1) as f64
        };
        assert!(brightness("1.5") < 20.0, "tabbed-out part is black");
        assert!(brightness("3.0") > 40.0, "the rest is the game");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concat_lines_escape_quotes() {
        assert_eq!(concat_list_line(Path::new("/a/it's.ts")), "file '/a/it'\\''s.ts'\n");
        assert_eq!(concat_list_line(Path::new("C:\\b\\c.ts")), "file 'C:/b/c.ts'\n");
    }

    /// Full pipeline with real FFmpeg (test pattern + silent audio): record,
    /// save a clip, check it is a playable video of the expected length.
    /// Skipped when FFmpeg isn't installed.
    #[test]
    fn records_and_saves_a_clip() {
        let Some(ff) = ffmpeg::locate() else {
            eprintln!("ffmpeg not found; skipping");
            return;
        };
        let base = std::env::temp_dir().join(format!("crosspov-rec-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let clip_root = base.join("clips");
        let settings = Settings {
            buffer_seconds: 6,
            fps: 30,
            game_audio: true,
            microphone: false,
            audio_mode: crate::settings::AudioMode::Desktop,
            ..Settings::default()
        };
        let rec = Recorder::new(settings.clone(), base.join("work"), Box::new(|_| {}));
        *rec.ffmpeg.lock().unwrap() = Some((ff.clone(), VideoEncoder::Cpu));
        let key = recording_key(&settings);
        let running = rec
            .start(&ff, &settings, VideoEncoder::Cpu, false, VideoSource::TestPattern, key, &Game::default(), None, None, None)
            .expect("start recording");
        rec.lock().running = Some(running);

        thread::sleep(Duration::from_secs(9));
        let clip = rec.save_clip(&clip_root).expect("save clip");
        rec.lock().running = None;

        assert!(Path::new(&clip.path).is_file());
        assert!(clip.size_bytes > 10_000, "clip too small: {}", clip.size_bytes);
        assert!(clip.thumb.is_some(), "thumbnail missing");
        // Ask FFmpeg itself how long the clip is.
        let out = Command::new(&ff).args(["-hide_banner", "-i", &clip.path]).output().unwrap();
        let info = String::from_utf8_lossy(&out.stderr);
        let dur = info.lines().find(|l| l.contains("Duration:")).expect("duration line").to_string();
        assert!(dur.contains("00:00:05") || dur.contains("00:00:06") || dur.contains("00:00:07"), "{dur}");
        assert!(info.contains("Audio: aac"), "no audio track: {info}");
        assert_eq!(clips::list(&clip_root).len(), 1);
        let _ = fs::remove_dir_all(base);
    }
}
