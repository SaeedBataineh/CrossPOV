//! CrossPOV desktop shell: tray icon, window lifecycle and settings.
//!
//! Memory: closing the window destroys the webview (the React UI) entirely
//! while the app keeps running in the tray, so it costs almost nothing
//! while you play. Opening it from the tray builds a fresh window.

mod settings;

use std::{path::PathBuf, sync::Mutex};

use settings::Settings;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_opener::OpenerExt as _;

const MAIN_WINDOW: &str = "main";
/// Passed by the "Start with Windows" entry so the app starts in the tray.
const MINIMIZED_ARG: &str = "--minimized";

struct AppState {
    settings: Mutex<Settings>,
    path: PathBuf,
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

fn show_main_window(app: &AppHandle) {
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
    settings.save(&state.path).map_err(|e| format!("Could not write settings: {e}"))?;
    apply_autostart(&app, settings.start_with_windows);
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

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open CrossPOV", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Open clip folder", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CrossPOV", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &folder, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("CrossPOV")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be first: a second launch just brings the running app forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_ARG])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let path = handle.path().app_config_dir()?.join("settings.json");
            let mut settings = Settings::load(&path);
            if settings.clip_folder.is_empty() {
                settings.clip_folder = default_clip_folder_path(&handle).to_string_lossy().into_owned();
            }
            apply_autostart(&handle, settings.start_with_windows);
            app.manage(AppState { settings: Mutex::new(settings), path });

            build_tray(&handle)?;
            if !std::env::args().any(|a| a == MINIMIZED_ARG) {
                show_main_window(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_settings, save_settings, default_clip_folder, open_clip_folder])
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
