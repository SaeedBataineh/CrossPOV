//! CrossPOV desktop shell: tray icon, window lifecycle, settings, the
//! replay-buffer recorder and the clip hotkey.
//!
//! Memory: closing the window destroys the webview (the React UI) entirely
//! while the app keeps running in the tray, so it costs almost nothing
//! while you play. Opening it from the tray builds a fresh window.

mod audio;
mod clips;
mod ffmpeg;
mod matches;
mod procs;
mod recorder;
mod settings;
mod streamers;
mod tools;
mod updater;
#[cfg(windows)]
mod win_audio;

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
    let why = if d.contains("resolution") || d.contains("resolve") || d.contains("dns") || d.contains("11001") || d.contains("11002") {
        "your internet or DNS didn't answer"
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
        self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
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
    let error = result.err().map(|e| format!("Couldn't use {hotkey} as the clip hotkey ({e}). Pick another in Settings."));
    app.state::<AppState>().recorder.set_hotkey_error(error);
}

/// Saves a clip in the background and tells the user how it went.
fn save_clip_async(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let settings = state.get();
        let result = state.recorder.save_clip(&clip_folder(&app, &settings));
        match &result {
            Ok(clip) => {
                #[cfg(windows)]
                if settings.clip_sound {
                    win_audio::beep();
                }
                let _ = app.emit("clip-saved", clip);
                if settings.notifications {
                    let _ = app.notification().builder().title("Clip saved").body(&clip.name).show();
                }
            }
            Err(err) => {
                let _ = app.emit("clip-failed", err);
                if settings.notifications {
                    let _ = app.notification().builder().title("Clip not saved").body(err).show();
                }
            }
        }
    });
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == MAIN_WINDOW).cloned() else {
        eprintln!("main window config missing");
        return;
    };
    match WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("could not open window: {err}"),
    }
}

fn open_folder(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let folder = clip_folder(app, &state.get());
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not create {}: {e}", folder.display()))?;
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.get()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, mut settings: Settings) -> Result<Settings, String> {
    settings.sanitize();
    if settings.clip_folder.is_empty() {
        settings.clip_folder = default_clip_folder_path(&app).to_string_lossy().into_owned();
    }
    settings.save(&state.path).map_err(|e| format!("Could not write settings: {e}"))?;
    let old = state.get();
    apply_autostart(&app, settings.start_with_windows);
    if old.hotkey != settings.hotkey {
        apply_hotkey(&app, &settings.hotkey);
    }
    if old.clip_folder != settings.clip_folder {
        allow_clip_folder(&app, &PathBuf::from(&settings.clip_folder));
    }
    state.recorder.update_settings(settings.clone());
    state.matches.update_settings(settings.clone());
    state.streamers.update(settings.clone(), clip_folder(&app, &settings));
    *state.settings.lock().unwrap_or_else(|e| e.into_inner()) = settings.clone();
    Ok(settings)
}

#[tauri::command]
fn default_clip_folder(app: AppHandle) -> String {
    default_clip_folder_path(&app).to_string_lossy().into_owned()
}

#[tauri::command]
fn open_clip_folder(app: AppHandle) -> Result<(), String> {
    open_folder(&app)
}

#[tauri::command]
fn recorder_status(state: State<'_, AppState>) -> RecorderStatus {
    state.recorder.status()
}

#[tauri::command]
fn save_clip_now(app: AppHandle) {
    save_clip_async(&app);
}

#[tauri::command]
fn list_clips(app: AppHandle, state: State<'_, AppState>) -> Vec<ClipInfo> {
    clips::list(&clip_folder(&app, &state.get()))
}

#[tauri::command]
fn delete_clip(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = clip_folder(&app, &state.get());
    let clip = clips::validate(&root, &path)?;
    clips::delete(&root, &clip)
}

#[tauri::command]
fn open_clip(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let clip = clips::validate(&clip_folder(&app, &state.get()), &path)?;
    app.opener().open_path(clip.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_clip(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let clip = clips::validate(&clip_folder(&app, &state.get()), &path)?;
    app.opener().reveal_item_in_dir(clip).map_err(|e| e.to_string())
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
    tauri::async_runtime::spawn_blocking(move || watcher.check_now()).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn streamer_states(state: State<'_, AppState>) -> Vec<MatchStreamers> {
    state.streamers.all()
}

/// Re-checks one match for streamers and downloads any clips that are ready.
#[tauri::command]
async fn check_streamers_now(state: State<'_, AppState>, match_id: String) -> Result<MatchStreamers, String> {
    let worker = state.streamers.clone();
    tauri::async_runtime::spawn_blocking(move || worker.check_now(&match_id)).await.map_err(|e| e.to_string())?
}

/// "Played against a streamer it missed?": the user names a player's channel.
#[tauri::command]
async fn add_streamer_channel(state: State<'_, AppState>, match_id: String, puuid: String, login: String, delay_sec: Option<f64>) -> Result<MatchStreamers, String> {
    let worker = state.streamers.clone();
    tauri::async_runtime::spawn_blocking(move || worker.add_manual(&match_id, &puuid, &login, delay_sec)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_audio_apps() -> Vec<procs::AudioApp> {
    tauri::async_runtime::spawn_blocking(procs::audio_apps).await.unwrap_or_default()
}

#[tauri::command]
async fn list_mic_devices() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(audio::input_device_names).await.unwrap_or_default()
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
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
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
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONINFORMATION, MB_YESNO};
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
        let _ = std::process::Command::new("explorer").arg("https://developer.microsoft.com/microsoft-edge/webview2/").spawn();
    }
    false
}

#[cfg(not(windows))]
fn webview_available() -> bool {
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single-exe update: the old copy started us and is closing; wait for it
    // so the one-instance check doesn't hand control back to it.
    updater::finish_self_update();
    if !webview_available() {
        return;
    }
    let app = tauri::Builder::default()
        // Must be first: a second launch just brings the running app forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_ARG])))
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
            // Single-exe build: put FFmpeg and yt-dlp where the app can run them (once per version).
            if let Err(err) = handle.path().app_local_data_dir().map_err(|e| e.to_string()).and_then(|d| tools::unpack(&d)) {
                eprintln!("{err}");
            }
            let path = handle.path().app_config_dir()?.join("settings.json");
            let mut settings = Settings::load(&path);
            if settings.clip_folder.is_empty() {
                settings.clip_folder = default_clip_folder_path(&handle).to_string_lossy().into_owned();
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
            recorder.spawn();

            build_tray(&handle)?;
            if !std::env::args().any(|a| a == MINIMIZED_ARG) {
                show_main_window(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            default_clip_folder,
            open_clip_folder,
            recorder_status,
            save_clip_now,
            list_clips,
            delete_clip,
            open_clip,
            reveal_clip,
            list_audio_apps,
            list_mic_devices,
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

    app.run(|app, event| {
        // `code: None` means the last window closed (not Quit from the tray).
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
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
        let dns = net_error("io: This is usually a temporary error during hostname resolution (os error 11002)");
        assert!(dns.contains("internet or DNS"), "{dns}");
        let tls = net_error("native-tls: unable to find any user-specified roots in the final cert chain");
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
