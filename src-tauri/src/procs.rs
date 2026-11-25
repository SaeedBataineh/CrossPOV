//! Looking up running processes: is the game open, and which process
//! is an app's "main" one (whose audio tree we capture).

use std::{collections::HashMap, ffi::OsStr};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// The game's process. `CROSSPOV_GAME_EXE` overrides it for testing.
pub fn game_exe() -> String {
    std::env::var("CROSSPOV_GAME_EXE").unwrap_or_else(|_| "VALORANT-Win64-Shipping.exe".into())
}

/// Is the game open? One shared, cached look at the process list for the
/// whole app (the recorder, the match checker and the streamer downloader all
/// ask), refreshed at most every 2 s instead of each part scanning on its own.
pub fn game_running() -> bool {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static SHARED: OnceLock<Mutex<(Procs, Option<Instant>, bool)>> = OnceLock::new();
    let shared = SHARED.get_or_init(|| Mutex::new((Procs::new(), None, false)));
    let mut g = shared.lock().unwrap_or_else(|e| e.into_inner());
    if g.1.is_none_or(|t| t.elapsed() >= Duration::from_secs(2)) {
        g.0.refresh();
        g.2 = g.0.is_running(&game_exe());
        g.1 = Some(Instant::now());
    }
    g.2
}

pub struct Procs {
    /// None if the OS refused to give us a process list (very unlikely).
    sys: Option<System>,
}

impl Procs {
    pub fn new() -> Self {
        let sys = System::new().map_err(|e| eprintln!("process list unavailable: {e}")).ok();
        let mut p = Self { sys };
        p.refresh();
        p
    }

    /// Re-reads the process list (names and parents only, which is cheap).
    pub fn refresh(&mut self) {
        if let Some(sys) = self.sys.as_mut() {
            let kind = ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet);
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        }
    }

    /// Kills processes whose executable lives in `dir`, except `keep` (our own pid).
    pub fn kill_in_dir(&self, dir: &std::path::Path, keep: u32) {
        let Some(sys) = &self.sys else { return };
        for (pid, p) in sys.processes() {
            if pid.as_u32() != keep && p.exe().and_then(|e| e.parent()).is_some_and(|d| d == dir) {
                p.kill();
            }
        }
    }

    pub fn pid_running(&self, pid: u32) -> bool {
        self.sys.as_ref().is_some_and(|s| s.process(sysinfo::Pid::from_u32(pid)).is_some())
    }

    pub fn is_running(&self, exe: &str) -> bool {
        let Some(sys) = &self.sys else { return false };
        sys.processes_by_exact_name(OsStr::new(exe)).next().is_some()
            || sys.processes().values().any(|p| p.name().eq_ignore_ascii_case(exe))
    }

    /// Processes named `exe` whose parent is not also `exe`. Capturing these
    /// "roots" includes all their children, e.g. Discord's voice process.
    pub fn root_pids(&self, exe: &str) -> Vec<u32> {
        let Some(sys) = &self.sys else { return Vec::new() };
        let procs = sys.processes();
        let is_exe = |pid: &Pid| procs.get(pid).is_some_and(|p| p.name().eq_ignore_ascii_case(exe));
        let mut roots: Vec<u32> = procs
            .iter()
            .filter(|(pid, p)| is_exe(pid) && !p.parent().is_some_and(|parent| is_exe(&parent)))
            .map(|(pid, _)| pid.as_u32())
            .collect();
        roots.sort_unstable();
        roots
    }

    /// Exe names for the given process IDs.
    pub fn names(&self, pids: &[u32]) -> HashMap<u32, String> {
        let Some(sys) = &self.sys else { return HashMap::new() };
        pids.iter()
            .filter_map(|&pid| {
                sys.process(Pid::from_u32(pid)).map(|p| (pid, p.name().to_string_lossy().into_owned()))
            })
            .collect()
    }
}

/// An app that is playing (or has played) sound, for the "Add app" picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioApp {
    pub exe: String,
}

/// Apps with an audio session right now, minus the game and system sounds.
pub fn audio_apps() -> Vec<AudioApp> {
    #[cfg(windows)]
    let pids = crate::win_audio::audio_session_pids();
    #[cfg(not(windows))]
    let pids: Vec<u32> = Vec::new();

    let procs = Procs::new();
    let game = game_exe().to_lowercase();
    let mut names: Vec<String> = procs
        .names(&pids)
        .into_values()
        .filter(|n| n.to_lowercase() != game && !n.eq_ignore_ascii_case("audiodg.exe"))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    names.into_iter().map(|exe| AudioApp { exe }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_this_test_process_as_a_root() {
        let procs = Procs::new();
        let me = std::process::id();
        let name = procs.names(&[me]).remove(&me).expect("own process listed");
        assert!(procs.is_running(&name));
        assert!(procs.root_pids(&name).contains(&me) || !procs.root_pids(&name).is_empty());
    }
}
