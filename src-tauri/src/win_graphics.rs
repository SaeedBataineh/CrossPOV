//! Undoes a Windows graphics setting that CrossPOV 0.6.8 and 0.6.9 changed
//! for VALORANT ("Optimizations for windowed games", stored per game .exe in
//! HKCU\Software\Microsoft\DirectX\UserGpuPreferences). It turned out not to
//! be needed: the clips that showed Discord or the desktop came from
//! recording the wrong monitor. The original value, kept in a small file
//! when it was changed, is put back once at start (and by the installer's
//! uninstall, `--restore-game-settings`).

use std::path::PathBuf;

/// The games it was changed for.
const GAMES: &[&str] = &["VALORANT-Win64-Shipping.exe"];

#[cfg_attr(not(windows), allow(dead_code))]
const KEY: &str = r"HKCU\Software\Microsoft\DirectX\UserGpuPreferences";
/// In a saved original: there was no value for the game at all.
#[cfg_attr(not(windows), allow(dead_code))]
const NONE: &str = "<none>";

/// Where 0.6.8/0.6.9 kept the game's original value: the .exe path, then the value.
fn saved_original(exe: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(dir)
            .join("app.crosspov.desktop")
            .join(format!("windowed-optimizations-{}.txt", exe.to_lowercase())),
    )
}

/// Puts back every game's original setting, if CrossPOV changed it.
pub fn restore() {
    for exe in GAMES {
        let Some(saved) = saved_original(exe) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(&saved) else {
            continue;
        };
        let mut lines = text.lines();
        let (Some(path), Some(original)) = (lines.next(), lines.next()) else {
            let _ = std::fs::remove_file(&saved);
            continue;
        };
        match put_back(path, original) {
            Ok(()) => {
                let _ = std::fs::remove_file(&saved);
                crate::trail(&format!(
                    "{exe}: put back Windows' \"Optimizations for windowed games\" as it was"
                ));
            }
            Err(e) => crate::trail(&format!(
                "{exe}: couldn't put back \"Optimizations for windowed games\" ({e})"
            )),
        }
    }
}

#[cfg(windows)]
fn put_back(path: &str, original: &str) -> Result<(), String> {
    use crate::ffmpeg::NoWindow;
    let args: Vec<&str> = if original == NONE {
        vec!["delete", KEY, "/v", path, "/f"]
    } else {
        vec!["add", KEY, "/v", path, "/t", "REG_SZ", "/d", original, "/f"]
    };
    let out = std::process::Command::new("reg")
        .args(&args)
        .no_window()
        .output()
        .map_err(|e| e.to_string())?;
    out.status
        .success()
        .then_some(())
        .ok_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string())
}

#[cfg(not(windows))]
fn put_back(_path: &str, _original: &str) -> Result<(), String> {
    Ok(())
}
