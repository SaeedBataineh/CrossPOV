//! Automatic updates. Every launch checks for a newer version and installs
//! it before the app can be used; while the app sits in the tray it checks
//! again every few hours and updates once VALORANT is closed, so nobody stays
//! on an old version.
//!
//! Releases are signed: the app only installs an update whose signature
//! matches the public key in `tauri.conf.json`.
//!
//! The installer build updates by running the new installer. The single-exe
//! build downloads the new CrossPOV.exe, swaps it for its own file (Windows
//! lets a running program rename itself) and starts it.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::procs::{self, Procs};

/// The exe this process started from, remembered before any update renames it.
static START_EXE: OnceLock<Option<PathBuf>> = OnceLock::new();
/// Passed to the new copy after a single-exe update: "--after-update=<old pid>".
const AFTER_UPDATE: &str = "--after-update=";
/// latest.json entry for the single exe (the installer uses "windows-x86_64").
const SINGLE_EXE_TARGET: &str = "windows-x86_64-single";

fn start_exe() -> Option<PathBuf> {
    START_EXE.get_or_init(|| std::env::current_exe().ok()).clone()
}

/// Runs first thing in `run()`. After a single-exe update, waits for the old
/// copy to close and deletes its file.
pub fn finish_self_update() {
    let exe = start_exe();
    let old_pid = std::env::args().find_map(|a| a.strip_prefix(AFTER_UPDATE).and_then(|p| p.parse::<u32>().ok()));
    if let Some(pid) = old_pid {
        for _ in 0..150 {
            if !Procs::new().pid_running(pid) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    if let Some(old) = exe.map(|e| old_path(&e)) {
        let _ = std::fs::remove_file(old);
    }
}

fn old_path(exe: &std::path::Path) -> PathBuf {
    let mut name = exe.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".old");
    exe.with_file_name(name)
}

/// Replaces the running exe with `bytes`, keeping the old one aside until the new one runs.
fn swap_exe(bytes: &[u8]) -> Result<PathBuf, String> {
    let exe = start_exe().ok_or("Can't find CrossPOV.exe")?;
    let old = old_path(&exe);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("Couldn't replace CrossPOV.exe: {e}"))?;
    if let Err(e) = std::fs::write(&exe, bytes) {
        let _ = std::fs::rename(&old, &exe); // put the working copy back
        return Err(format!("Couldn't write the new CrossPOV.exe: {e}"));
    }
    Ok(exe)
}

/// How often a running app looks for a new version.
const RECHECK: Duration = Duration::from_secs(3 * 60 * 60);
/// While VALORANT is open, how often to see whether it has closed.
const GAME_POLL: Duration = Duration::from_secs(60);
/// A launch check that takes longer than this lets the user in (e.g. no internet).
const CHECK_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum UpdateStatus {
    /// Launch check in progress; the UI waits.
    Checking,
    /// On the newest version (or the check couldn't run).
    UpToDate { offline: bool },
    /// Found a newer version that waits for VALORANT to close.
    Waiting { version: String },
    /// Downloading; the UI is locked.
    Downloading { version: String, downloaded: u64, total: Option<u64> },
    /// Running the installer; the app restarts by itself.
    Installing { version: String },
    /// A newer version exists but couldn't be installed. The UI stays locked with a Retry button.
    Failed { version: String, message: String },
}

#[derive(Clone)]
pub struct Updates {
    status: Arc<Mutex<UpdateStatus>>,
}

impl Updates {
    pub fn new() -> Self {
        Self { status: Arc::new(Mutex::new(UpdateStatus::Checking)) }
    }

    pub fn status(&self) -> UpdateStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, app: &AppHandle, status: UpdateStatus) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
        let _ = app.emit("update-status", status);
    }

    /// Starts the launch check and the background re-checks.
    pub fn spawn(&self, app: &AppHandle) {
        let me = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Launch: install right away, even if the game is open, so an old version never runs.
            match me.find(&app).await {
                Ok(Some(update)) => me.install(&app, update).await,
                Ok(None) => me.set(&app, UpdateStatus::UpToDate { offline: false }),
                Err(err) => {
                    eprintln!("update check failed: {err}");
                    me.set(&app, UpdateStatus::UpToDate { offline: true });
                }
            }
            loop {
                tokio_sleep(RECHECK).await;
                if let Ok(Some(update)) = me.find(&app).await {
                    me.set(&app, UpdateStatus::Waiting { version: update.version.clone() });
                    while game_running() {
                        tokio_sleep(GAME_POLL).await;
                    }
                    me.install(&app, update).await;
                }
            }
        });
    }

    /// Retry button after a failed install.
    pub fn retry(&self, app: &AppHandle) {
        let me = self.clone();
        let app = app.clone();
        me.set(&app, UpdateStatus::Checking);
        tauri::async_runtime::spawn(async move {
            match me.find(&app).await {
                Ok(Some(update)) => me.install(&app, update).await,
                Ok(None) => me.set(&app, UpdateStatus::UpToDate { offline: false }),
                Err(err) => {
                    let version = String::new();
                    me.set(&app, UpdateStatus::Failed { version, message: format!("Couldn't reach the update server: {err}") });
                }
            }
        });
    }

    async fn find(&self, app: &AppHandle) -> Result<Option<Update>, String> {
        let recorder = app.state::<crate::AppState>().recorder.clone();
        let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
        if crate::tools::EMBEDDED {
            builder = builder.target(SINGLE_EXE_TARGET);
        }
        let updater = builder
            .on_before_exit(move || {
                // The new version may replace or delete ffmpeg.exe and yt-dlp.exe, so nothing may still be using them.
                recorder.halt();
                kill_helpers();
            })
            .build()
            .map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }

    async fn install(&self, app: &AppHandle, update: Update) {
        let version = update.version.clone();
        crate::trail(&format!("update: installing {version}"));
        crate::show_main_window(app);
        self.set(app, UpdateStatus::Downloading { version: version.clone(), downloaded: 0, total: None });
        let mut downloaded = 0u64;
        let mut last_emit = 0u64;
        let progress = |chunk: usize, total: Option<u64>| {
            downloaded += chunk as u64;
            // About every 2 MB, so the progress bar moves without flooding the UI.
            if downloaded - last_emit > 2_000_000 || Some(downloaded) == total {
                last_emit = downloaded;
                self.set(app, UpdateStatus::Downloading { version: version.clone(), downloaded, total });
            }
        };
        let finished = || self.set(app, UpdateStatus::Installing { version: version.clone() });

        if crate::tools::EMBEDDED {
            let result = async {
                let bytes = update.download(progress, finished).await.map_err(|e| e.to_string())?;
                update.verify(&bytes).map_err(|e| e.to_string())?; // signed by us, or nothing happens
                let recorder = app.state::<crate::AppState>().recorder.clone();
                recorder.halt();
                kill_helpers();
                let exe = swap_exe(&bytes)?;
                let mut cmd = std::process::Command::new(&exe);
                cmd.arg(format!("{AFTER_UPDATE}{}", std::process::id()));
                if app.get_webview_window(crate::MAIN_WINDOW).is_none() {
                    cmd.arg(crate::MINIMIZED_ARG); // it was in the tray, keep it there
                }
                cmd.spawn().map_err(|e| format!("Couldn't start the new version: {e}"))?;
                Ok::<(), String>(())
            }
            .await;
            match result {
                Ok(()) => app.exit(0),
                Err(message) => self.set(app, UpdateStatus::Failed { version, message }),
            }
            return;
        }

        let result = update.download_and_install(progress, finished).await;
        match result {
            // Windows exits inside download_and_install and the installer starts the new version.
            Ok(()) => app.restart(),
            Err(err) => self.set(app, UpdateStatus::Failed { version, message: err.to_string() }),
        }
    }
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

fn game_running() -> bool {
    // VALORANT, or any other game being recorded: don't restart mid-game.
    procs::game_running() || crate::games::last_seen().is_some()
}

/// Stops FFmpeg / yt-dlp copies started from the app's own folder (or, in
/// the single-exe build, from the folders they were downloaded to).
fn kill_helpers() {
    let procs = Procs::new();
    if let Some(dir) = start_exe().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        procs.kill_in_dir(&dir, std::process::id());
    }
    for dir in crate::tools::dirs() {
        procs.kill_in_dir(&dir, std::process::id());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_copy_sits_next_to_the_exe() {
        assert_eq!(old_path(std::path::Path::new("C:/Games/CrossPOV.exe")), PathBuf::from("C:/Games/CrossPOV.exe.old"));
    }
}
