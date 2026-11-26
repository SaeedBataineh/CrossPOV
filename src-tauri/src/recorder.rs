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
        s.fps, s.resolution, s.quality, s.bitrate_mbps, s.encoder, s.codec, s.buffer_seconds, s.audio_mode, s.game_audio, s.game_volume,
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
    /// Recording just the game's window failed on this PC (or for this game):
    /// record its screen instead until the game closes.
    window_failed: bool,
    /// Set before an update installs: stop recording and don't start again.
    halted: bool,
}

pub type StatusListener = Box<dyn Fn(&RecorderStatus) + Send + Sync>;

#[derive(Clone)]
pub struct Recorder {
    inner: Arc<Mutex<Inner>>,
    work_dir: PathBuf,
    listener: Arc<StatusListener>,
    ffmpeg: Arc<Mutex<Option<(PathBuf, VideoEncoder)>>>,
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
        Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(400).collect())
    }
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
            inner: Arc::new(Mutex::new(Inner {
                settings,
                running: None,
                status: RecorderStatus::new(RecState::Starting),
                fallback: 0,
                window_failed: false,
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
        let want = game.is_some() && !inner.halted;
        // Another game, or the game moved to another screen: start afresh.
        // Just the game's window when known (a new window, e.g. the game
        // restarting, starts afresh); its screen if window capture failed.
        let window = game.as_ref().map(|g| g.hwnd).filter(|&h| h != 0 && !inner.window_failed);
        let key = format!(
            "{}|{}|{}|{}|{:?}",
            recording_key(&inner.settings),
            game.as_ref().map_or("", |g| g.exe.as_str()).to_lowercase(),
            game.as_ref().map_or(0, |g| g.output_idx),
            window.unwrap_or(0),
            // A new game resolution (or stretched one) starts afresh at the right size.
            game.as_ref().and_then(|g| if window.is_some() { g.window_size } else { g.screen_size })
        );
        inner.status.game = game.clone();

        // Stop if the game closed or recording settings changed.
        let stale = inner.running.as_ref().is_some_and(|r| r.key != key);
        if (!want || stale) && inner.running.is_some() {
            inner.running = None;
        }

        // Notice FFmpeg exiting on its own.
        let mut died_early = None;
        if let Some(r) = inner.running.as_mut() {
            if let Ok(Some(code)) = r.child.try_wait() {
                let log = fs::read_to_string(self.work_dir.join("ffmpeg.log")).unwrap_or_default();
                let reason = log.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
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
            g.hwnd = window.unwrap_or(0);
            let size = if window.is_some() { g.window_size } else { g.screen_size };
            crate::trail(&format!(
                "recording: {} {}{}",
                if window.is_some() { "the game's window" } else { "the whole screen" },
                size.map(|(w, h)| format!("{w}x{h}")).unwrap_or_else(|| "(size unknown)".into()),
                ffmpeg::stretched_size(size, settings.resolution).map(|(w, h)| format!(", stretched to {w}x{h}")).unwrap_or_default()
            ));
            match self.start(ffmpeg_path, &settings, encoder, compat, source, key, &g) {
                Ok(running) => {
                    crate::trail("recording: started");
                    inner.status.state = RecState::Recording;
                    inner.status.encoder = Some(format!("{}{}", encoder.label(), if compat { " (compatibility mode)" } else { "" }));
                    inner.status.message = None;
                    inner.status.audio_warning = None;
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

    fn start(
        &self,
        ffmpeg_path: &Path,
        settings: &Settings,
        encoder: VideoEncoder,
        compat: bool,
        source: VideoSource,
        key: String,
        game: &Game,
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
        let audio = child.stdin.take().map(|stdin| AudioPipe::start(settings, &game.exe, stdin));
        Ok(Running { child, audio, plan, started: Instant::now(), key, game: game.name.clone() })
    }

    /// FFmpeg and the encoder it found, once known (used to cut clips too).
    pub fn ffmpeg_tools(&self) -> Option<(PathBuf, VideoEncoder)> {
        self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Saves the last `buffer_seconds` as a clip. Waits for the segment being
    /// written right now to finish, so the clip includes the moment the
    /// hotkey was pressed.
    pub fn save_clip(&self, clip_root: &Path) -> Result<ClipInfo, String> {
        let (plan, settings, game) = {
            let inner = self.lock();
            let r = inner.running.as_ref().ok_or("Not recording right now. Clips are saved while a game is open.")?;
            (r.plan.clone(), inner.settings.clone(), r.game.clone())
        };
        let game = Some(game).filter(|g| !g.is_empty());
        let ffmpeg_path = self.ffmpeg.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(p, _)| p.clone()).ok_or("FFmpeg not ready")?;

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

        let out_dir = clip_root.join(MY_CLIPS);
        fs::create_dir_all(&out_dir).map_err(|e| format!("Could not create {}: {e}", out_dir.display()))?;
        let ext = match settings.format {
            Container::Mp4 => "mp4",
            Container::Mkv => "mkv",
        };
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

        let list = plan.segment_dir.join(format!("concat-{}.txt", now_ms()));
        fs::write(&list, take.iter().map(|p| concat_list_line(p)).collect::<String>()).map_err(|e| e.to_string())?;
        let result = run_ffmpeg(&ffmpeg_path, &ffmpeg::concat_args(&list, &out, settings.format, plan.hevc));
        let _ = fs::remove_file(&list);
        result.map_err(|e| format!("Could not save clip: {e}"))?;

        let thumb = clips::thumb_path(clip_root, &out);
        if let Some(dir) = thumb.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = run_ffmpeg(&ffmpeg_path, &ffmpeg::thumbnail_args(&out, &thumb));
        let duration = (take.len() as u32 * SEGMENT_SECONDS) as f64;
        clips::write_meta(clip_root, &out, &ClipMeta { duration_sec: Some(duration), game: game.clone(), ..ClipMeta::default() });
        if settings.prune_oldest {
            clips::prune(clip_root, settings.storage_limit_gb);
        }

        let size = fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        Ok(ClipInfo {
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            .start(&ff, &settings, VideoEncoder::Cpu, false, VideoSource::TestPattern, key, &Game::default())
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
