//! Windows 11's "Optimizations for windowed games", turned off for VALORANT
//! while CrossPOV is open. With it on, Windows can put a windowed-fullscreen
//! game's picture straight on the screen, past the desktop: window capture
//! then gets its frames in bursts (~70 fps), and screen capture sees what's
//! behind the game (a Discord stream, the desktop). Off, every frame goes the
//! usual way and recording gets each one.
//!
//! It's Windows' own per-game setting (Settings > System > Display >
//! Graphics), stored for the game's .exe, and Windows reads it when the game
//! starts: so it's set while CrossPOV runs (a game started then gets it), and
//! put back exactly as it was when CrossPOV quits. Anything else stored there
//! (which graphics card to use) is kept.

use std::path::{Path, PathBuf};

/// The games this is done for.
const GAMES: &[&str] = &["VALORANT-Win64-Shipping.exe"];

#[cfg_attr(not(windows), allow(dead_code))]
const KEY: &str = r"HKCU\Software\Microsoft\DirectX\UserGpuPreferences";
#[cfg_attr(not(windows), allow(dead_code))]
const SETTING: &str = "SwapEffectUpgradeEnable";
/// In a saved original: there was no value for the game at all.
#[cfg_attr(not(windows), allow(dead_code))]
const NONE: &str = "<none>";

/// `current` (e.g. "GpuPreference=2;") with the optimization off, or None if
/// it already is.
#[cfg_attr(not(windows), allow(dead_code))]
fn with_optimization_off(current: &str) -> Option<String> {
    let mut parts: Vec<(String, String)> = current
        .split(';')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (k.trim().to_string(), v.trim().to_string()),
            None => (p.to_string(), String::new()),
        })
        .collect();
    if parts.iter().any(|(k, v)| k.eq_ignore_ascii_case(SETTING) && v == "0") {
        return None;
    }
    parts.retain(|(k, _)| !k.eq_ignore_ascii_case(SETTING));
    parts.push((SETTING.to_string(), "0".to_string()));
    Some(parts.iter().map(|(k, v)| format!("{k}={v};")).collect())
}

/// "    C:\...\game.exe    REG_SZ    GpuPreference=2;" -> "GpuPreference=2;"
#[cfg_attr(not(windows), allow(dead_code))]
fn value_from_query(output: &str) -> Option<String> {
    output.lines().find_map(|l| l.split_once("REG_SZ").map(|(_, v)| v.trim().to_string()))
}

/// Where the game's original value is kept until CrossPOV puts it back:
/// the .exe path, then the value (or NONE).
#[cfg_attr(not(windows), allow(dead_code))]
fn saved_original(exe: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(dir).join("app.crosspov.desktop").join(format!("windowed-optimizations-{}.txt", exe.to_lowercase())))
}

/// Turns the optimization off for the listed games that can be found
/// (running, or installed where their launcher says), in the background.
/// Call at start and whenever a game is seen: each game is done once a run.
pub fn turn_off_for_games() {
    if !cfg!(windows) {
        return;
    }
    std::thread::spawn(|| {
        for exe in GAMES {
            turn_off_for(exe);
        }
    });
}

fn turn_off_for(exe: &str) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static DONE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let done = DONE.get_or_init(Default::default);
    if done.lock().unwrap_or_else(|e| e.into_inner()).contains(&exe.to_lowercase()) {
        return;
    }
    let Some(path) = crate::icons::running_path(exe).or_else(|| crate::icons::installed_path(exe)) else { return };
    done.lock().unwrap_or_else(|e| e.into_inner()).insert(exe.to_lowercase());
    match set_off(exe, &path) {
        Ok(true) => crate::trail(&format!("{exe}: \"Optimizations for windowed games\" off while CrossPOV runs (steady recording)")),
        Ok(false) => {}
        Err(e) => crate::trail(&format!("{exe}: couldn't turn off \"Optimizations for windowed games\" ({e})")),
    }
}

/// Puts back every game's original setting. Call as CrossPOV quits.
pub fn restore() {
    if !cfg!(windows) {
        return;
    }
    for exe in GAMES {
        let Some(saved) = saved_original(exe) else { continue };
        let Ok(text) = std::fs::read_to_string(&saved) else { continue };
        let mut lines = text.lines();
        let (Some(path), Some(original)) = (lines.next(), lines.next()) else {
            let _ = std::fs::remove_file(&saved);
            continue;
        };
        if put_back(path, original).is_ok() {
            let _ = std::fs::remove_file(&saved);
        }
    }
}

#[cfg(windows)]
fn reg(args: &[&str]) -> Result<std::process::Output, String> {
    use crate::ffmpeg::NoWindow;
    std::process::Command::new("reg").args(args).no_window().output().map_err(|e| e.to_string())
}

/// Ok(true) if it was changed now.
#[cfg(windows)]
fn set_off(exe: &str, path: &Path) -> Result<bool, String> {
    let name = path.to_string_lossy().into_owned();
    let query = reg(&["query", KEY, "/v", &name])?;
    let current = query.status.success().then(|| value_from_query(&String::from_utf8_lossy(&query.stdout))).flatten();
    let Some(wanted) = with_optimization_off(current.as_deref().unwrap_or("")) else { return Ok(false) };
    // Keep the original first (an earlier run that didn't get to put it back
    // already kept it: that one is the real original).
    let saved = saved_original(exe).ok_or("no local app folder")?;
    if !saved.exists() {
        if let Some(dir) = saved.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&saved, format!("{name}\n{}\n", current.as_deref().unwrap_or(NONE))).map_err(|e| e.to_string())?;
    }
    let set = reg(&["add", KEY, "/v", &name, "/t", "REG_SZ", "/d", &wanted, "/f"])?;
    if set.status.success() {
        Ok(true)
    } else {
        Err(String::from_utf8_lossy(&set.stderr).trim().to_string())
    }
}

#[cfg(windows)]
fn put_back(path: &str, original: &str) -> Result<(), String> {
    let out = if original == NONE {
        reg(&["delete", KEY, "/v", path, "/f"])?
    } else {
        reg(&["add", KEY, "/v", path, "/t", "REG_SZ", "/d", original, "/f"])?
    };
    out.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string())
}

#[cfg(not(windows))]
fn set_off(_exe: &str, _path: &Path) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
fn put_back(_path: &str, _original: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_it_off_and_keeps_other_settings() {
        assert_eq!(with_optimization_off("").as_deref(), Some("SwapEffectUpgradeEnable=0;"));
        assert_eq!(with_optimization_off("GpuPreference=2;").as_deref(), Some("GpuPreference=2;SwapEffectUpgradeEnable=0;"));
        assert_eq!(with_optimization_off("GpuPreference=2;SwapEffectUpgradeEnable=1;").as_deref(), Some("GpuPreference=2;SwapEffectUpgradeEnable=0;"));
        assert_eq!(with_optimization_off("SwapEffectUpgradeEnable=0;GpuPreference=1;"), None, "already off");
    }

    #[test]
    fn reads_the_value_reg_prints() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\DirectX\\UserGpuPreferences\r\n    C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe    REG_SZ    GpuPreference=2;\r\n\r\n";
        assert_eq!(value_from_query(out).as_deref(), Some("GpuPreference=2;"));
        assert_eq!(value_from_query("ERROR: not found"), None);
    }
}
