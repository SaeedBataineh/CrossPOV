//! Automatic updates. Every launch checks for a newer version and installs
//! it before the app can be used; while the app sits in the tray it checks
//! again every few hours and updates once VALORANT is closed, so nobody stays
//! on an old version.
//!
//! Releases are signed: the app only installs an update whose signature
//! matches the public key in `tauri.conf.json`.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::procs::{self, Procs};

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
        let updater = app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .on_before_exit(move || {
                // The installer replaces ffmpeg.exe and yt-dlp.exe, so nothing may still be using them.
                recorder.halt();
                kill_helpers();
            })
            .build()
            .map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }

    async fn install(&self, app: &AppHandle, update: Update) {
        let version = update.version.clone();
        crate::show_main_window(app);
        self.set(app, UpdateStatus::Downloading { version: version.clone(), downloaded: 0, total: None });
        let mut downloaded = 0u64;
        let mut last_emit = 0u64;
        let result = update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    // About every 2 MB, so the progress bar moves without flooding the UI.
                    if downloaded - last_emit > 2_000_000 || Some(downloaded) == total {
                        last_emit = downloaded;
                        self.set(app, UpdateStatus::Downloading { version: version.clone(), downloaded, total });
                    }
                },
                || self.set(app, UpdateStatus::Installing { version: version.clone() }),
            )
            .await;
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
    let mut p = Procs::new();
    p.refresh();
    p.is_running(&procs::game_exe())
}

/// Stops FFmpeg / yt-dlp copies started from the app's own folder.
fn kill_helpers() {
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        Procs::new().kill_in_dir(&dir, std::process::id());
    }
}
