//! CrossPOV desktop shell: tray icon, window lifecycle, settings, the
//! replay-buffer recorder and the clip hotkey.
//!
//! Memory: closing the window destroys the webview (the React UI) entirely
//! while the app keeps running in the tray, so it costs almost nothing
//! while you play. Opening it from the tray builds a fresh window.

mod audio;
mod clips;
mod clipserve;
mod edit;
mod fastvod;
mod ffmpeg;
mod games;
mod icons;
mod matches;
mod net;
mod obs;
mod procs;
mod recorder;
mod settings;
mod streamers;
mod tools;
mod updater;
#[cfg(windows)]
mod win_audio;
mod win_graphics;

use std::{path::PathBuf, str::FromStr, sync::Mutex, thread};

use clips::ClipInfo;
use matches::{MatchEvent, MatchStore, MatchSummary, MatchWatcher, MatchesStatus};
use recorder::{Recorder, RecorderStatus};
use settings::Settings;
use streamers::{Link, LinkStore, MatchStreamers, StreamerStore, StreamerWorker};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt as _, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;

pub(crate) const MAIN_WINDOW: &str = "main";
/// A network error in words people can act on.
pub(crate) fn net_error(detail: &str) -> String {
    let d = detail.to_lowercase();
    // 11001-11004: Windows' "host not found", "try again", "no recovery", "no data" DNS errors.
    let why = if d.contains("resolution")
        || d.contains("resolve")
        || d.contains("dns")
        || ["11001", "11002", "11003", "11004"]
            .iter()
            .any(|c| d.contains(c))
        || d.contains("requested name is valid")
    {
        "your PC couldn't look up crosspov.com (a DNS problem: check your internet, VPN or DNS settings)"
    } else if d.contains("timed out") || d.contains("timeout") {
        "the connection timed out"
    } else if d.contains("cert") || d.contains("tls") || d.contains("ssl") {
        "the secure connection couldn't be checked (antivirus or a network filter can cause this)"
    } else {
        "no connection"
    };
    format!("Can't reach the CrossPOV server right now: {why}. CrossPOV tries again by itself. ({detail})")
}

/// Sent to the CrossPOV server with every request.
pub(crate) const USER_AGENT: &str = concat!("CrossPOV/", env!("CARGO_PKG_VERSION"));
/// Passed by the "Start with Windows" entry so the app starts in the tray.
pub(crate) const MINIMIZED_ARG: &str = "--minimized";

/// First run of the single exe (or new tool versions): download FFmpeg and
/// yt-dlp, showing progress where the recorder status goes, then start
/// recording. Without internet it keeps trying every minute.
/// Gets the slim OBS (scripts/make-slim-obs.py) ready in the background,
/// trying again every 10 minutes until it is. Nothing waits for it.
fn prepare_obs_in_background() {
    if !tools::EMBEDDED {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("obs-download".into())
        .spawn(|| loop {
            match tools::prepare_obs() {
                Ok(true) => {
                    trail("obs: ready");
                    return;
                }
                Ok(false) => return,
                Err(e) => trail(&format!("obs: {e}; trying again in 10 minutes")),
            }
            std::thread::sleep(std::time::Duration::from_secs(600));
        });
}

fn get_tools_then_record(recorder: &Recorder) {
    loop {
        recorder.show_tools_status("Downloading recording tools (one time only)…".into(), false);
        let mut shown = u64::MAX;
        let result = tools::download(&mut |done, total| {
            let mb = done / 1_000_000;
            if mb != shown {
                shown = mb;
                let of = if total > 0 {
                    format!(" of {} MB", total / 1_000_000)
                } else {
                    String::new()
                };
                recorder.show_tools_status(
                    format!("Downloading recording tools (one time only): {mb}{of}…"),
                    false,
                );
            }
        });
        match result {
            Ok(()) => {
                prepare_obs_in_background();
                return recorder.spawn();
            }
            Err(err) => {
                recorder.show_tools_status(format!("{err} CrossPOV can't record until it has them; it tries again every minute."), true);
                std::thread::sleep(std::time::Duration::from_secs(60));
            }
        }
    }
}

pub(crate) struct AppState {
    settings: Mutex<Settings>,
    path: PathBuf,
    pub(crate) recorder: Recorder,
    matches: MatchWatcher,
    streamers: StreamerWorker,
    updates: updater::Updates,
}

impl AppState {
    fn get(&self) -> Settings {
        self.settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

fn default_clip_folder_path(app: &AppHandle) -> PathBuf {
    app.path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("CrossPOV")
}

fn clip_folder(app: &AppHandle, s: &Settings) -> PathBuf {
    if s.clip_folder.is_empty() {
        default_clip_folder_path(app)
    } else {
        PathBuf::from(&s.clip_folder)
    }
}

/// Lets the UI show thumbnails, and nothing else: only the clip folder's
/// thumbnail subfolder, not the clips or anything around them.
fn allow_clip_folder(app: &AppHandle, folder: &std::path::Path) {
    let thumbs = folder.join(clips::THUMBS);
    let _ = std::fs::create_dir_all(&thumbs);
    if let Err(err) = app.asset_protocol_scope().allow_directory(&thumbs, false) {
        eprintln!("could not allow clip folder for thumbnails: {err}");
    }
}

/// Registers or removes the "Start with Windows" entry. Skipped in dev
/// builds so the debug binary never ends up in the user's startup list.
fn apply_autostart(app: &AppHandle, enabled: bool) {
    if cfg!(debug_assertions) {
        return;
    }
    let launcher = app.autolaunch();
    let result = match (enabled, launcher.is_enabled().unwrap_or(false)) {
        (true, false) => launcher.enable(),
        (false, true) => launcher.disable(),
        _ => Ok(()),
    };
    if let Err(err) = result {
        eprintln!("autostart update failed: {err}");
    }
}

/// (Re)binds the clip hotkey. Errors (e.g. key used by another app) show on Home.
fn apply_hotkey(app: &AppHandle, hotkey: &str) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let result = Shortcut::from_str(hotkey)
        .map_err(|e| e.to_string())
        .and_then(|sc| gs.register(sc).map_err(|e| e.to_string()));
    let error = result.err().map(|e| {
        format!("Couldn't use {hotkey} as the clip hotkey ({e}). Pick another in Settings.")
    });
    app.state::<AppState>().recorder.set_hotkey_error(error);
}

/// Saves a clip in the background and tells the user how it went.
fn save_clip_async(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let settings = state.get();
        // Beep the moment the key is pressed, not once the file is written.
        #[cfg(windows)]
        if settings.clip_sound && state.recorder.is_recording() {
            win_audio::beep();
        }
        let result = state.recorder.save_clip(&clip_folder(&app, &settings));
        match &result {
            Ok(clip) => {
                let _ = app.emit("clip-saved", clip);
                if settings.notifications {
                    let _ = app
                        .notification()
                        .builder()
                        .title("Clip saved")
                        .body(&clip.name)
                        .show();
                }
            }
            Err(err) => {
                let _ = app.emit("clip-failed", err);
                if settings.notifications {
                    let _ = app
                        .notification()
                        .builder()
                        .title("Clip not saved")
                        .body(err)
                        .show();
                }
            }
        }
    });
}

/// Counts closes to the tray, so a pending "free the window" timer can tell
/// the window was reopened (and closed again) since it started.
static TRAY_CLOSES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// How long a window closed to the tray is kept asleep (instant to reopen)
/// before it's destroyed to free all its memory.
const FREE_HIDDEN_WINDOW_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Closing to the tray: hide the window and put its browser to sleep (page
/// paused, memory trimmed) so reopening is instant; after a while, destroy
/// it, and the next open builds it fresh.
fn close_to_tray(window: &tauri::WebviewWindow) {
    let _ = window.hide();
    set_asleep(window, true);
    let close = TRAY_CLOSES.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FREE_HIDDEN_WINDOW_AFTER);
        if TRAY_CLOSES.load(std::sync::atomic::Ordering::SeqCst) == close
            && !window.is_visible().unwrap_or(true)
        {
            let _ = window.destroy();
        }
    });
}

/// Suspends (or resumes) the window's WebView2 and lowers (or restores) its memory use.
#[cfg(windows)]
fn set_asleep(window: &tauri::WebviewWindow, asleep: bool) {
    let _ = window.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2TrySuspendCompletedHandler, ICoreWebView2_19, ICoreWebView2_3,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows::core::Interface;
        let controller = webview.controller();
        // SAFETY: COM calls on the window's own WebView2, on the thread that owns it (with_webview runs there).
        unsafe {
            if asleep {
                let _ = controller.SetIsVisible(false); // Suspending needs it marked hidden.
            }
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            if let Ok(c) = core.cast::<ICoreWebView2_19>() {
                let level = if asleep {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                };
                let _ = c.SetMemoryUsageTargetLevel(level);
            }
            if let Ok(c) = core.cast::<ICoreWebView2_3>() {
                let _ = if asleep {
                    c.TrySuspend(None::<&ICoreWebView2TrySuspendCompletedHandler>)
                } else {
                    c.Resume()
                };
            }
            if !asleep {
                let _ = controller.SetIsVisible(true);
            }
        }
    });
}

#[cfg(not(windows))]
fn set_asleep(_window: &tauri::WebviewWindow, _asleep: bool) {}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let was_hidden = !window.is_visible().unwrap_or(true);
        TRAY_CLOSES.fetch_add(1, std::sync::atomic::Ordering::SeqCst); // cancels a pending free
        if was_hidden {
            set_asleep(&window, false);
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if was_hidden {
            // The page was paused while hidden: it reloads its data.
            let _ = window.emit("window-awake", ());
        }
        return;
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
    else {
        eprintln!("main window config missing");
        return;
    };
    // The window starts hidden (and dark) and appears once the page has
    // loaded, so reopening from the tray never flashes an empty white window.
    let builder = WebviewWindowBuilder::from_config(app, &config).map(|b| {
        b.on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
    });
    match builder.and_then(|b| b.build()) {
        Ok(window) => {
            // Never stay invisible if the page is slow or fails to load.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
        }
        Err(err) => eprintln!("could not open window: {err}"),
    }
}

fn open_folder(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let folder = clip_folder(app, &state.get());
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Could not create {}: {e}", folder.display()))?;
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.get()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: Settings,
) -> Result<Settings, String> {
    settings.sanitize();
    if settings.clip_folder.is_empty() {
        settings.clip_folder = default_clip_folder_path(&app)
            .to_string_lossy()
            .into_owned();
    }
    settings
        .save(&state.path)
        .map_err(|e| format!("Could not write settings: {e}"))?;
    let old = state.get();
    apply_autostart(&app, settings.start_with_windows);
    if old.hotkey != settings.hotkey {
        apply_hotkey(&app, &settings.hotkey);
    }
    if old.clip_folder != settings.clip_folder {
        allow_clip_folder(&app, &PathBuf::from(&settings.clip_folder));
    }
    state.recorder.update_settings(settings.clone());
    // Switched to another Riot account: the old account's matches go.
    if !old.riot_id.trim().is_empty() && !matches::same_riot_id(&old.riot_id, &settings.riot_id) {
        state.matches.clear_history();
    }
    state.matches.update_settings(settings.clone());
    state
        .streamers
        .update(settings.clone(), clip_folder(&app, &settings));
    *state.settings.lock().unwrap_or_else(|e| e.into_inner()) = settings.clone();
    Ok(settings)
}

/// Names of the games CrossPOV knows without being told, for Settings.
#[tauri::command]
fn known_games() -> Vec<String> {
    let mut names: Vec<String> = games::KNOWN_GAMES
        .iter()
        .map(|(_, n)| n.to_string())
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

#[tauri::command]
fn default_clip_folder(app: AppHandle) -> String {
    default_clip_folder_path(&app)
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
fn open_clip_folder(app: AppHandle) -> Result<(), String> {
    open_folder(&app)
}

#[tauri::command]
fn recorder_status(state: State<'_, AppState>) -> RecorderStatus {
    state.recorder.status()
}

/// A short report the user can copy and send when something isn't working:
/// versions, what the recorder and the match checks are doing, recent
/// errors, and the settings that matter. No clips, keys or file contents.
#[tauri::command]
fn diagnostics(app: AppHandle, state: State<'_, AppState>) -> String {
    use std::fmt::Write as _;
    let s = state.get();
    let rec = state.recorder.status();
    let m = state.matches.status();
    let mut out = String::new();
    let _ = writeln!(
        out,
        "CrossPOV {} ({})",
        env!("CARGO_PKG_VERSION"),
        if tools::EMBEDDED {
            "single exe"
        } else {
            "installed"
        }
    );
    let _ = writeln!(
        out,
        "Windows: {}",
        sysinfo::System::long_os_version().unwrap_or_else(|_| "unknown".into())
    );
    let _ = writeln!(
        out,
        "Time: {}",
        time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default()
    );
    let _ = writeln!(
        out,
        "\n[Recorder]\nstate: {:?}\nencoder: {}",
        rec.state,
        rec.encoder.as_deref().unwrap_or("-")
    );
    for (k, v) in [
        ("message", &rec.message),
        ("audio", &rec.audio_warning),
        ("hotkey", &rec.hotkey_error),
    ] {
        if let Some(v) = v {
            let _ = writeln!(out, "{k}: {v}");
        }
    }
    let missing: Vec<&str> = tools::missing().iter().map(|t| t.name).collect();
    let _ = writeln!(
        out,
        "tools: {}",
        if missing.is_empty() {
            "ok".to_string()
        } else {
            format!("missing {}", missing.join(", "))
        }
    );
    if tools::EMBEDDED {
        let _ = writeln!(
            out,
            "obs: {}",
            if tools::obs_dir().is_some() {
                "ready"
            } else {
                "not downloaded yet"
            }
        );
    }
    let _ = writeln!(
        out,
        "ffmpeg: {}",
        ffmpeg::locate()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "not found".into())
    );
    let _ = writeln!(
        out,
        "\n[Matches]\nRiot ID: {} ({})",
        if s.riot_id.is_empty() {
            "not set"
        } else {
            &s.riot_id
        },
        s.region
    );
    let _ = writeln!(
        out,
        "last check: {}",
        m.last_check_ms
            .map(|t| format!("{} s ago", (now_ms_lib().saturating_sub(t)) / 1000))
            .unwrap_or_else(|| "never".into())
    );
    if let Some(e) = &m.error {
        let _ = writeln!(out, "error: {e}");
    }
    let _ = writeln!(
        out,
        "\n[Streamer clips] auto: {}, before/after: {}/{} s, quality: {:?}",
        s.streamer_auto, s.seconds_before, s.seconds_after, s.download_quality
    );
    for ms in state
        .streamers
        .all()
        .into_iter()
        .filter(|x| !x.players.is_empty() || x.error.is_some())
        .take(8)
    {
        let _ = write!(
            out,
            "match {}…:",
            ms.match_id.chars().take(8).collect::<String>()
        );
        if let Some(e) = &ms.error {
            let _ = write!(out, " error: {e};");
        }
        for p in &ms.players {
            let _ = write!(
                out,
                " {} {:?} {}/{} shift {:.0}s{}{};",
                p.channel.login,
                p.status,
                p.clips,
                p.fights,
                p.delay_sec,
                if p.checking { " checking" } else { "" },
                p.message
                    .as_deref()
                    .map(|m| format!(" ({m})"))
                    .unwrap_or_default()
            );
        }
        let _ = writeln!(out);
    }
    if let Some(c) = recent_crashes() {
        let _ = writeln!(out, "\n[Crashes]\n{c}");
    }
    if let Some(t) = recent_trail() {
        let _ = writeln!(out, "\n[Recent activity]\n{t}");
    }
    let _ = writeln!(
        out,
        "\n[Settings] {} fps, {:?}, bitrate {}, encoder {:?}, {:?}, {:?}, capture {:?}, buffer {} s, hotkey {}, clips {}",
        s.fps, s.resolution, if s.bitrate_mbps > 0 { format!("{} Mbps", s.bitrate_mbps) } else { format!("auto ({:?})", s.quality) }, s.encoder, s.codec, s.format, s.capture, s.buffer_seconds, s.hotkey,
        clip_folder(&app, &s).display()
    );
    out
}

fn now_ms_lib() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn save_clip_now(app: AppHandle) {
    save_clip_async(&app);
}

#[tauri::command]
fn list_clips(app: AppHandle, state: State<'_, AppState>) -> Vec<ClipInfo> {
    let root = clip_folder(&app, &state.get());
    // The first listing after start: clips deleted right before the app last closed go to the Recycle Bin.
    static SWEPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !SWEPT.swap(true, std::sync::atomic::Ordering::Relaxed) {
        let r = root.clone();
        thread::spawn(move || clips::recycle_leftovers(&r));
    }
    clips::list(&root)
}

/// Deleting hides the clip at once; `restore_clip` (Undo) brings it back, and
/// `recycle_clip` moves it to the Recycle Bin once Undo has run out.
#[tauri::command]
fn delete_clip(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = clip_folder(&app, &state.get());
    let clip = clips::validate(&root, &path)?;
    clips::hide(&root, &clip)
}

#[tauri::command]
fn restore_clip(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = clip_folder(&app, &state.get());
    let clip = clips::validate_hidden(&root, &path)?;
    clips::unhide(&root, &clip)
}

#[tauri::command]
async fn recycle_clip(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let root = clip_folder(&app, &state.get());
    let clip = clips::validate_hidden(&root, &path)?;
    tauri::async_runtime::spawn_blocking(move || clips::recycle(&root, &clip))
        .await
        .map_err(|e| e.to_string())?
}

/// Runs FFmpeg with `args` and waits; the error says what went wrong.
fn run_ffmpeg(ff: &std::path::Path, args: &[String]) -> Result<(), String> {
    use crate::ffmpeg::NoWindow;
    let out = std::process::Command::new(ff)
        .args(args)
        .stdin(std::process::Stdio::null())
        .no_window()
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("FFmpeg failed")
            .to_string())
    }
}

/// The clip, where it lives (and so its kind), and FFmpeg: what every edit needs.
fn edit_inputs(
    app: &AppHandle,
    state: &AppState,
    path: &str,
) -> Result<
    (
        PathBuf,
        PathBuf,
        clips::ClipInfo,
        PathBuf,
        ffmpeg::VideoEncoder,
    ),
    String,
> {
    let root = clip_folder(app, &state.get());
    let clip = clips::validate(&root, path)?;
    let kind = if clip
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == clips::STREAMER_CLIPS)
    {
        clips::ClipKind::Theirs
    } else {
        clips::ClipKind::Mine
    };
    let info = clips::info(&root, &clip, kind).ok_or("Clip not found")?;
    let (ff, enc) = state
        .recorder
        .ffmpeg_tools()
        .ok_or("FFmpeg isn't ready yet. Try again in a moment.")?;
    Ok((root, clip, info, ff, enc))
}

/// Checks a start/end pair against the clip's length.
fn check_range(start: f64, end: f64, info: &clips::ClipInfo) -> Result<(), String> {
    let len = info.duration_sec.unwrap_or(f64::MAX);
    if !(start.is_finite() && end.is_finite()) || start < 0.0 || end <= start + 0.5 || start >= len
    {
        return Err("Pick a start and end at least half a second apart.".into());
    }
    Ok(())
}

/// Saves `start`..`end` of a clip as a new clip next to it. `exact` re-encodes
/// for a frame-exact cut; otherwise it's instant but starts on a keyframe.
#[tauri::command]
async fn trim_clip(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    start: f64,
    end: f64,
    exact: bool,
) -> Result<clips::ClipInfo, String> {
    let (root, clip, info, ff, enc) = edit_inputs(&app, &state, &path)?;
    check_range(start, end, &info)?;
    let end = end.min(info.duration_sec.unwrap_or(end));
    tauri::async_runtime::spawn_blocking(move || {
        let ext = if exact {
            "mp4"
        } else {
            clip.extension().and_then(|e| e.to_str()).unwrap_or("mp4")
        };
        let stem = clip
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let dir = clip.parent().ok_or("Clip not found")?;
        let mut out = dir.join(format!("{stem}_cut.{ext}"));
        let mut n = 2;
        while out.exists() {
            out = dir.join(format!("{stem}_cut{n}.{ext}"));
            n += 1;
        }
        // Keep the clip's own video format (an H.265 clip's cut stays H.265).
        let hevc = exact && {
            use crate::ffmpeg::NoWindow as _;
            std::process::Command::new(&ff)
                .args(["-hide_banner", "-i"])
                .arg(&clip)
                .no_window()
                .output()
                .is_ok_and(|o| {
                    String::from_utf8_lossy(&o.stderr)
                        .lines()
                        .any(|l| l.contains("Video: hevc"))
                })
        };
        run_ffmpeg(
            &ff,
            &edit::trim_args(&clip, &out, start, end, exact, enc, hevc),
        )
        .map_err(|e| format!("Couldn't cut the clip: {e}"))?;
        // Your clips are matched to games and fights by when they were saved:
        // date the cut as if it had been saved at its own end.
        if info.kind == clips::ClipKind::Mine {
            if let (Some(len), Ok(f)) = (
                info.duration_sec,
                std::fs::File::options().write(true).open(&out),
            ) {
                let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(info.created_ms)
                    - std::time::Duration::from_secs_f64((len - end).max(0.0));
                let _ = f.set_modified(at);
            }
        }
        let thumb = clips::thumb_path(&root, &out);
        if let Some(d) = thumb.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = run_ffmpeg(&ff, &ffmpeg::thumbnail_args(&out, &thumb));
        clips::write_meta(
            &root,
            &out,
            &clips::ClipMeta {
                duration_sec: Some(end - start),
                streamer: info.streamer.clone(),
                round: info.round,
                moment: info.moment.clone(),
                map: info.map.clone(),
                match_id: info.match_id.clone(),
                match_start_sec: info.match_start_sec.map(|s| s + start),
                vod_url: info.vod_url.clone(),
                vod_start_sec: info.vod_start_sec.map(|s| s + start),
                game: info.game.clone(),
                made_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_millis() as u64),
            },
        );
        clips::info(&root, &out, info.kind).ok_or_else(|| "The cut clip wasn't saved.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Makes a copy of `start`..`end` small enough for Discord's free upload
/// limit and puts the file on the clipboard, ready to paste. Returns its size.
#[tauri::command]
async fn copy_for_discord(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    start: f64,
    end: f64,
) -> Result<u64, String> {
    let (root, clip, info, ff, enc) = edit_inputs(&app, &state, &path)?;
    check_range(start, end, &info)?;
    let end = end.min(info.duration_sec.unwrap_or(end));
    tauri::async_runtime::spawn_blocking(move || {
        let args_for = |out: &std::path::Path| edit::discord_args(&clip, out, start, end, enc);
        let dir = root.join("For Discord");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stem = clip
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let out = dir.join(format!("{stem}_discord.mp4"));
        let args = args_for(&out).ok_or_else(|| {
            format!(
                "That's too long for Discord's 10 MB limit. Trim it to under {} seconds first.",
                edit::discord_max_seconds()
            )
        })?;
        run_ffmpeg(&ff, &args).map_err(|e| format!("Couldn't make the Discord copy: {e}"))?;
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        edit::copy_file_to_clipboard(&out)?;
        Ok(size)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the frame at `at` seconds as a full-size PNG in "Frames" next to the
/// clips, and shows it in its folder. Pixel-exact: for comparing recordings.
#[tauri::command]
async fn save_frame(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    at: f64,
) -> Result<String, String> {
    let (root, clip, _info, ff, _enc) = edit_inputs(&app, &state, &path)?;
    let at = if at.is_finite() { at.max(0.0) } else { 0.0 };
    let out = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        // Its size, from FFmpeg's description of the file.
        use crate::ffmpeg::NoWindow as _;
        let probe = std::process::Command::new(&ff)
            .args(["-hide_banner", "-i"])
            .arg(&clip)
            .no_window()
            .output()
            .map_err(|e| e.to_string())?;
        let (w, h) = edit::video_size(&String::from_utf8_lossy(&probe.stderr))
            .ok_or("Couldn't read the video's size.")?;
        let dir = root.join("Frames");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stem = clip
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let raw = dir.join(format!(".{stem}.rgb"));
        run_ffmpeg(&ff, &edit::frame_args(&clip, &raw, at))
            .map_err(|e| format!("Couldn't save the frame: {e}"))?;
        let rgb = std::fs::read(&raw).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&raw);
        let out = dir.join(format!("{stem}_{:.2}s.png", at));
        edit::write_png(&out, w, h, &rgb?)?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.opener().reveal_item_in_dir(&out);
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_clip(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let clip = clips::validate(&clip_folder(&app, &state.get()), &path)?;
    app.opener()
        .open_path(clip.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Lets the app's own player read this one clip (and nothing else on disk).
/// Returns its path; MKV can't play in the window, so the caller opens it outside.
#[tauri::command]
fn play_clip_in_app(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let clip = clips::validate(&clip_folder(&app, &state.get()), &path)?;
    // Straight from disk through CrossPOV's own little server (smooth at any
    // bitrate); Tauri's asset link only if that couldn't start.
    if let Some(url) = clipserve::url_for(clip.clone()) {
        return Ok(url);
    }
    app.asset_protocol_scope()
        .allow_file(&clip)
        .map_err(|e| e.to_string())?;
    Ok(clip.to_string_lossy().into_owned())
}

#[tauri::command]
fn reveal_clip(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let clip = clips::validate(&clip_folder(&app, &state.get()), &path)?;
    app.opener()
        .reveal_item_in_dir(clip)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_matches(state: State<'_, AppState>) -> Vec<MatchSummary> {
    state.matches.list()
}

#[tauri::command]
fn matches_status(state: State<'_, AppState>) -> MatchesStatus {
    state.matches.status()
}

/// Asks the server for the latest match right away (the "Check now" button).
#[tauri::command]
async fn check_matches_now(state: State<'_, AppState>) -> Result<MatchSummary, String> {
    let watcher = state.matches.clone();
    tauri::async_runtime::spawn_blocking(move || watcher.check_now())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn streamer_states(state: State<'_, AppState>) -> Vec<MatchStreamers> {
    state.streamers.all()
}

/// Re-checks one match for streamers and downloads any clips that are ready.
#[tauri::command]
async fn check_streamers_now(
    state: State<'_, AppState>,
    match_id: String,
) -> Result<MatchStreamers, String> {
    let worker = state.streamers.clone();
    tauri::async_runtime::spawn_blocking(move || worker.check_now(&match_id))
        .await
        .map_err(|e| e.to_string())?
}

/// "Played against a streamer it missed?": the user names a player's channel.
#[tauri::command]
async fn add_streamer_channel(
    state: State<'_, AppState>,
    match_id: String,
    puuid: String,
    login: String,
    delay_sec: Option<f64>,
) -> Result<MatchStreamers, String> {
    let worker = state.streamers.clone();
    tauri::async_runtime::spawn_blocking(move || {
        worker.add_manual(&match_id, &puuid, &login, delay_sec)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_audio_apps() -> Vec<procs::AudioApp> {
    tauri::async_runtime::spawn_blocking(procs::audio_apps)
        .await
        .unwrap_or_default()
}

/// A program's icon as PNG bytes (empty if unknown).
#[tauri::command]
async fn app_icon(exe: String, path: Option<String>) -> tauri::ipc::Response {
    let png = tauri::async_runtime::spawn_blocking(move || {
        icons::icon_png(&exe, path.map(PathBuf::from))
    })
    .await
    .ok()
    .flatten();
    tauri::ipc::Response::new(png.unwrap_or_default())
}

#[tauri::command]
async fn list_mic_devices() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(audio::input_device_names)
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn linked_channels(state: State<'_, AppState>) -> Vec<Link> {
    state.streamers.links()
}

#[tauri::command]
fn remove_linked_channel(state: State<'_, AppState>, puuid: String) {
    state.streamers.remove_link(&puuid);
}

#[tauri::command]
fn update_status(state: State<'_, AppState>) -> updater::UpdateStatus {
    state.updates.status()
}

#[tauri::command]
fn retry_update(app: AppHandle, state: State<'_, AppState>) {
    state.updates.retry(&app);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open CrossPOV", true, None::<&str>)?;
    let save = MenuItem::with_id(app, "save", "Save clip now", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Open clip folder", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CrossPOV", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &save, &folder, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("CrossPOV")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "save" => save_clip_async(app),
            "folder" => {
                if let Err(err) = open_folder(app) {
                    eprintln!("{err}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// The window needs Microsoft Edge WebView2 (part of Windows 11 and updated
/// Windows 10). The installer adds it when missing; the single exe can't, so
/// it says what's needed instead of failing silently.
#[cfg(windows)]
fn webview_available() -> bool {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONINFORMATION, MB_YESNO,
    };
    if tauri::webview_version().is_ok() {
        return true;
    }
    let answer = unsafe {
        MessageBoxW(
            None,
            w!("CrossPOV needs Microsoft Edge WebView2, which is missing on this PC.\n\nOpen Microsoft's download page now? Install the \"Evergreen Bootstrapper\", then start CrossPOV again."),
            w!("CrossPOV"),
            MB_YESNO | MB_ICONINFORMATION,
        )
    };
    if answer == IDYES {
        let _ = std::process::Command::new("explorer")
            .arg("https://developer.microsoft.com/microsoft-edge/webview2/")
            .spawn();
    }
    false
}

#[cfg(not(windows))]
fn webview_available() -> bool {
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Runs a background task, and if it crashes, logs it and starts it again a
/// little later instead of taking the app down (one bad match must never
/// close CrossPOV).
pub(crate) fn keep_running(task: impl Fn()) {
    loop {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(&task)).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
}

/// A short trail of what the app is doing (app.log, last 200 lines), written
/// before anything that talks to Windows directly. If Windows ever closes the
/// app outright (no crash.log), the last lines show what it was doing.
pub(crate) fn trail(event: &str) {
    let Some(path) = crash_log_path().map(|p| p.with_file_name("app.log")) else {
        return;
    };
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
    let old = std::fs::read_to_string(&path).unwrap_or_default();
    let lines: Vec<&str> = old.lines().collect();
    let mut out: String = lines[lines.len().saturating_sub(199)..]
        .iter()
        .map(|l| format!("{l}\n"))
        .collect();
    let when = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    out.push_str(&format!("{when} {event}\n"));
    let _ = std::fs::write(&path, out);
}

/// The last lines of the trail, for Copy diagnostics.
pub(crate) fn recent_trail() -> Option<String> {
    let text = std::fs::read_to_string(crash_log_path()?.with_file_name("app.log")).ok()?;
    // The game-sound helper's step-by-step lines ("app audio 1234: activating")
    // are for crash reports; here they'd push the useful lines out. Its
    // outcome ("app audio: process 1234: capturing") stays.
    let steps = |l: &str| {
        l.split_once(' ').is_some_and(|(_, rest)| {
            rest.starts_with("app audio ") && !rest.starts_with("app audio: ")
        })
    };
    let tail: Vec<&str> = text.lines().rev().filter(|l| !steps(l)).take(30).collect();
    (!tail.is_empty()).then(|| tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
}

/// Where crashes are written (%LOCALAPPDATA%\app.crosspov.desktop\crash.log).
fn crash_log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| {
        PathBuf::from(d)
            .join("app.crosspov.desktop")
            .join("crash.log")
    })
}

/// The end of the crash log, for Copy diagnostics.
pub(crate) fn recent_crashes() -> Option<String> {
    let text = std::fs::read_to_string(crash_log_path()?).ok()?;
    let tail: Vec<&str> = text.lines().rev().take(12).collect();
    (!tail.is_empty()).then(|| tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
}

/// Writes every crash (which part, what, where) to crash.log, keeping the file small.
fn log_crashes() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(path) = crash_log_path() {
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
            let old = std::fs::read_to_string(&path).unwrap_or_default();
            // Keep the last 100 lines (whole lines, so no character is cut in half).
            let lines: Vec<&str> = old.lines().collect();
            let keep: String = lines[lines.len().saturating_sub(100)..]
                .iter()
                .map(|l| format!("{l}\n"))
                .collect();
            let when = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default();
            let thread = std::thread::current().name().unwrap_or("main").to_string();
            let what = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_default();
            let at = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()))
                .unwrap_or_default();
            let _ = std::fs::write(
                &path,
                format!(
                    "{keep}{when} v{} [{thread}] {what} at {at}\n",
                    env!("CARGO_PKG_VERSION")
                ),
            );
        }
        default(info);
    }));
}

/// `--restore-game-settings` (the installer's uninstall): puts back the
/// Windows graphics settings CrossPOV changed for games.
pub fn restore_game_settings() {
    win_graphics::restore();
}

pub fn run() {
    log_crashes();
    trail(&format!("started v{}", env!("CARGO_PKG_VERSION")));
    // Single-exe update: the old copy started us and is closing; wait for it
    // so the one-instance check doesn't hand control back to it.
    updater::finish_self_update();
    if !webview_available() {
        return;
    }
    let app = tauri::Builder::default()
        // Must be first: a second launch just brings the running app forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
            if let Some(state) = app.try_state::<AppState>() {
                state.updates.check_on_open(app);
            }
        }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if window.label() == MAIN_WINDOW && app.state::<AppState>().get().minimize_to_tray {
                    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                        api.prevent_close();
                        close_to_tray(&w);
                    }
                }
            }
        })
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED_ARG]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        save_clip_async(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            // Single-exe build: FFmpeg and yt-dlp are downloaded into the local data folder.
            tools::init(&handle.path().app_local_data_dir()?);
            let path = handle.path().app_config_dir()?.join("settings.json");
            let mut settings = Settings::load(&path);
            if settings.clip_folder.is_empty() {
                settings.clip_folder = default_clip_folder_path(&handle)
                    .to_string_lossy()
                    .into_owned();
            }
            apply_autostart(&handle, settings.start_with_windows);
            allow_clip_folder(&handle, &PathBuf::from(&settings.clip_folder));

            let emitter = handle.clone();
            let recorder = Recorder::new(
                settings.clone(),
                handle.path().app_cache_dir()?,
                Box::new(move |status| {
                    let _ = emitter.emit("recorder-status", status);
                }),
            );
            let match_events = handle.clone();
            let watcher = MatchWatcher::new(
                MatchStore::new(handle.path().app_data_dir()?.join("matches")),
                settings.clone(),
                Box::new(move |event| {
                    let _ = match event {
                        MatchEvent::Found(m) => match_events.emit("match-found", m),
                        MatchEvent::Status(s) => match_events.emit("matches-status", s),
                    };
                }),
            );
            // Channels you linked by hand live only here, on this PC.
            let links = LinkStore::new(handle.path().app_data_dir()?.join("linked-channels.json"));
            let data_dir = handle.path().app_data_dir()?.join("matches");
            let streamer_events = handle.clone();
            let streamer_worker = StreamerWorker::new(
                MatchStore::new(data_dir.clone()),
                StreamerStore::new(data_dir),
                links,
                settings.clone(),
                clip_folder(&handle, &settings),
                Box::new(move |state, clip| {
                    let _ = streamer_events.emit("streamers-updated", state);
                    if let Some(clip) = clip {
                        let _ = streamer_events.emit("clip-saved", clip);
                        let notify = streamer_events.state::<AppState>().get().notifications;
                        if notify {
                            let who = clip.streamer.clone().unwrap_or_default();
                            let _ = streamer_events
                                .notification()
                                .builder()
                                .title("Streamer clip saved")
                                .body(format!("Your fight with {who}, from their POV"))
                                .show();
                        }
                    }
                }),
            );
            let hotkey = settings.hotkey.clone();
            let updates = updater::Updates::new();
            app.manage(AppState {
                settings: Mutex::new(settings),
                path,
                recorder: recorder.clone(),
                matches: watcher.clone(),
                streamers: streamer_worker.clone(),
                updates: updates.clone(),
            });
            updates.spawn(&handle);
            watcher.spawn();
            streamer_worker.spawn();
            apply_hotkey(&handle, &hotkey);
            if tools::missing().is_empty() {
                prepare_obs_in_background();
                recorder.spawn();
            } else {
                let recorder = recorder.clone();
                std::thread::Builder::new()
                    .name("tools".into())
                    .spawn(move || get_tools_then_record(&recorder))?;
            }

            build_tray(&handle)?;
            if !std::env::args().any(|a| a == MINIMIZED_ARG) {
                show_main_window(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            known_games,
            trim_clip,
            copy_for_discord,
            save_frame,
            default_clip_folder,
            open_clip_folder,
            recorder_status,
            diagnostics,
            save_clip_now,
            list_clips,
            delete_clip,
            restore_clip,
            recycle_clip,
            open_clip,
            play_clip_in_app,
            reveal_clip,
            list_audio_apps,
            list_mic_devices,
            app_icon,
            list_matches,
            matches_status,
            check_matches_now,
            streamer_states,
            check_streamers_now,
            add_streamer_channel,
            update_status,
            retry_update,
            linked_channels,
            remove_linked_channel
        ])
        .build(tauri::generate_context!())
        .expect("error while building CrossPOV");

    // Put back a Windows setting 0.6.8/0.6.9 changed for VALORANT. See win_graphics.
    std::thread::spawn(win_graphics::restore);
    app.run(|app, event| {
        // `code: None` means the last window closed (not Quit from the tray).
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            if app.state::<AppState>().get().minimize_to_tray {
                api.prevent_exit();
            }
        }
    });
}

#[cfg(test)]
mod net_tests {
    use super::net_error;

    #[test]
    fn network_errors_are_readable() {
        let dns = net_error(
            "io: This is usually a temporary error during hostname resolution (os error 11002)",
        );
        assert!(dns.contains("DNS problem"), "{dns}");
        let no_data = net_error("io: The requested name is valid, but no data of the requested type was found. (os error 11004)");
        assert!(no_data.contains("DNS problem"), "{no_data}");
        let tls = net_error(
            "native-tls: unable to find any user-specified roots in the final cert chain",
        );
        assert!(tls.contains("secure connection"), "{tls}");
        assert!(dns.contains("tries again by itself"));
    }

    /// Real HTTPS request with the same TLS settings as the app (run with --ignored).
    #[test]
    #[ignore]
    fn reaches_the_live_server() {
        let m = crate::matches::fetch_latest("https://crosspov.com", "eu", "x#1");
        // Any answer from the server (even "not found") proves TLS works; only network/TLS errors fail.
        if let Err(e) = &m {
            assert!(!e.contains("Can't reach"), "{e}");
        }
    }
}
