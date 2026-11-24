//! The single-exe build (`--features single-exe`): FFmpeg and yt-dlp travel
//! inside CrossPOV.exe and are unpacked once per app version into
//! `%LOCALAPPDATA%\app.crosspov.desktop\tools\<version>`. Nothing is hidden
//! or compressed: they are the same files the installer puts next to the app.
//!
//! The installer build embeds nothing and finds the tools next to the exe.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[cfg(feature = "single-exe")]
const FILES: &[(&str, &[u8])] = &[
    ("ffmpeg.exe", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/binaries/ffmpeg-x86_64-pc-windows-msvc.exe"))),
    ("yt-dlp.exe", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/binaries/yt-dlp-x86_64-pc-windows-msvc.exe"))),
];
#[cfg(not(feature = "single-exe"))]
const FILES: &[(&str, &[u8])] = &[];

/// True in the single-exe build.
pub const EMBEDDED: bool = cfg!(feature = "single-exe");

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Unpacks the bundled tools if this version hasn't yet, and removes the
/// tools of older versions. `base` is the app's local data folder.
pub fn unpack(base: &Path) -> Result<(), String> {
    if FILES.is_empty() {
        return Ok(());
    }
    let root = base.join("tools");
    let dir = root.join(env!("CARGO_PKG_VERSION"));
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    for (name, bytes) in FILES {
        let path = dir.join(name);
        let current = fs::metadata(&path).map(|m| m.len() == bytes.len() as u64).unwrap_or(false);
        if !current {
            // Write beside it and rename, so a crash never leaves half a file.
            let tmp = dir.join(format!("{name}.part"));
            fs::write(&tmp, bytes).map_err(|e| format!("Could not unpack {name}: {e}"))?;
            fs::rename(&tmp, &path).map_err(|e| format!("Could not unpack {name}: {e}"))?;
        }
    }
    if let Ok(entries) = fs::read_dir(&root) {
        for e in entries.flatten() {
            if e.path() != dir {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    let _ = DIR.set(dir);
    Ok(())
}

/// Path of an unpacked tool, e.g. "ffmpeg.exe". None in the installer build.
pub fn get(name: &str) -> Option<PathBuf> {
    DIR.get().map(|d| d.join(name)).filter(|p| p.is_file())
}

/// Folder the unpacked tools live in (single-exe build only).
pub fn dir() -> Option<&'static Path> {
    DIR.get().map(PathBuf::as_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacks_tools_only_in_the_single_exe_build() {
        let base = std::env::temp_dir().join(format!("crosspov-tools-{}", std::process::id()));
        assert!(unpack(&base).is_ok());
        if EMBEDDED {
            let p = get("ffmpeg.exe").expect("unpacked");
            assert_eq!(fs::read(&p).unwrap(), FILES[0].1);
            assert!(get("yt-dlp.exe").is_some());
            let stale = base.join("tools").join("0.0.0-old");
            fs::create_dir_all(&stale).unwrap();
            assert!(unpack(&base).is_ok(), "second run is a no-op");
            assert!(!stale.exists(), "other versions' tools are removed");
        } else {
            assert!(get("ffmpeg.exe").is_none());
            assert!(!base.join("tools").exists(), "nothing written");
        }
        let _ = fs::remove_dir_all(base);
    }
}
