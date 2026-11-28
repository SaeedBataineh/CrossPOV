//! Clips on disk: where they go, listing them, deleting them and keeping
//! the folder under the storage limit.
//!
//! Layout inside the clip folder:
//!   My Clips/<name>.mp4         hotkey clips
//!   Streamer POV/<name>.mp4     streamer clips (step 4)
//!   .thumbs/<name>.jpg|.json    thumbnail and details for each clip

use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};

pub const MY_CLIPS: &str = "My Clips";
pub const STREAMER_CLIPS: &str = "Streamer POV";
pub const THUMBS: &str = ".thumbs";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    Mine,
    Theirs,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMeta {
    pub duration_sec: Option<f64>,
    /// Streamer clips only: whose POV, which round, what happened, which map.
    #[serde(default)]
    pub streamer: Option<String>,
    #[serde(default)]
    pub round: Option<u32>,
    #[serde(default)]
    pub moment: Option<String>,
    #[serde(default)]
    pub map: Option<String>,
    /// Streamer clips only: the match, and where the clip starts in the match
    /// and in their VOD (seconds), so the app can line it up with your clip.
    #[serde(default)]
    pub match_id: Option<String>,
    #[serde(default)]
    pub match_start_sec: Option<f64>,
    #[serde(default)]
    pub vod_url: Option<String>,
    #[serde(default)]
    pub vod_start_sec: Option<f64>,
    /// Your clips: which game it was recorded in.
    #[serde(default)]
    pub game: Option<String>,
    /// A cut: when it was made (ms since 1970). Its file date stays where
    /// the cut part happened, so it still lines up with its match.
    #[serde(default)]
    pub made_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub path: String,
    pub name: String,
    pub kind: ClipKind,
    pub size_bytes: u64,
    /// Milliseconds since 1970, for sorting and "2 min ago".
    pub created_ms: u64,
    pub duration_sec: Option<f64>,
    pub thumb: Option<String>,
    pub streamer: Option<String>,
    pub round: Option<u32>,
    pub moment: Option<String>,
    pub map: Option<String>,
    pub match_id: Option<String>,
    pub match_start_sec: Option<f64>,
    pub vod_url: Option<String>,
    pub vod_start_sec: Option<f64>,
    pub game: Option<String>,
    /// A cut: when it was made, shown on its card and used for "newest".
    pub made_ms: Option<u64>,
}

fn is_video(p: &Path) -> bool {
    matches!(p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("mp4" | "mkv"))
}

pub fn thumb_path(root: &Path, clip: &Path) -> PathBuf {
    let stem = clip.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    root.join(THUMBS).join(format!("{stem}.jpg"))
}

pub fn meta_path(root: &Path, clip: &Path) -> PathBuf {
    thumb_path(root, clip).with_extension("json")
}

pub fn write_meta(root: &Path, clip: &Path, meta: &ClipMeta) {
    let path = meta_path(root, clip);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec(meta) {
        let _ = fs::write(path, json);
    }
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// All clips, newest first.
pub fn list(root: &Path) -> Vec<ClipInfo> {
    let mut out = Vec::new();
    for (dir, kind) in [(MY_CLIPS, ClipKind::Mine), (STREAMER_CLIPS, ClipKind::Theirs)] {
        let Ok(entries) = fs::read_dir(root.join(dir)) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if let Some(c) = build(root, entry.path(), kind, &meta) {
                out.push(c);
            }
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.created_ms));
    out
}

/// One clip's details, without reading the rest of the folder.
pub fn info(root: &Path, clip: &Path, kind: ClipKind) -> Option<ClipInfo> {
    let meta = fs::metadata(clip).ok()?;
    build(root, clip.to_path_buf(), kind, &meta)
}

fn build(root: &Path, path: PathBuf, kind: ClipKind, meta: &fs::Metadata) -> Option<ClipInfo> {
    if !meta.is_file() || !is_video(&path) {
        return None;
    }
    let thumb = thumb_path(root, &path);
    let details: ClipMeta = fs::read(meta_path(root, &path))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    Some(ClipInfo {
        name: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        kind,
        size_bytes: meta.len(),
        created_ms: modified_ms(meta),
        duration_sec: details.duration_sec,
        thumb: thumb.is_file().then(|| thumb.to_string_lossy().into_owned()),
        streamer: details.streamer,
        round: details.round,
        moment: details.moment,
        map: details.map,
        match_id: details.match_id,
        match_start_sec: details.match_start_sec,
        vod_url: details.vod_url,
        vod_start_sec: details.vod_start_sec,
        game: details.game,
        made_ms: details.made_ms,
    })
}

/// Only paths of clips inside the clip folder may be deleted or opened.
pub fn validate(root: &Path, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let canon = p.canonicalize().map_err(|_| "Clip not found".to_string())?;
    let root = root.canonicalize().map_err(|_| "Clip folder not found".to_string())?;
    let parent_ok = [MY_CLIPS, STREAMER_CLIPS].iter().any(|d| canon.parent() == Some(root.join(d).as_path()));
    if parent_ok && is_video(&canon) {
        Ok(canon)
    } else {
        Err("Not a CrossPOV clip".into())
    }
}

pub fn delete(root: &Path, clip: &Path) -> Result<(), String> {
    fs::remove_file(clip).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(thumb_path(root, clip));
    let _ = fs::remove_file(meta_path(root, clip));
    Ok(())
}

/// Ending a clip's files get while they wait for Undo. `list` skips them
/// (it's not a video extension).
const HELD: &str = "crosspov-deleted";

fn held(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".");
    s.push(HELD);
    PathBuf::from(s)
}

/// Deleting from the app: hides the clip (and its thumbnail and details) so
/// Undo can bring it back. `recycle` finishes the job.
pub fn hide(root: &Path, clip: &Path) -> Result<(), String> {
    fs::rename(clip, held(clip)).map_err(|e| e.to_string())?;
    for side in [thumb_path(root, clip), meta_path(root, clip)] {
        let _ = fs::rename(&side, held(&side));
    }
    Ok(())
}

/// Undo: puts a hidden clip back.
pub fn unhide(root: &Path, clip: &Path) -> Result<(), String> {
    fs::rename(held(clip), clip).map_err(|_| "That clip can't be brought back any more.".to_string())?;
    for side in [thumb_path(root, clip), meta_path(root, clip)] {
        let _ = fs::rename(held(&side), &side);
    }
    Ok(())
}

/// A hidden clip, checked like `validate`. Returns the clip's own (visible) path.
pub fn validate_hidden(root: &Path, path: &str) -> Result<PathBuf, String> {
    let canon = held(Path::new(path)).canonicalize().map_err(|_| "That clip can't be brought back any more.".to_string())?;
    let root = root.canonicalize().map_err(|_| "Clip folder not found".to_string())?;
    let parent_ok = [MY_CLIPS, STREAMER_CLIPS].iter().any(|d| canon.parent() == Some(root.join(d).as_path()));
    let clip = canon.with_extension("");
    if parent_ok && is_video(&clip) {
        Ok(clip)
    } else {
        Err("Not a CrossPOV clip".into())
    }
}

/// After Undo has run out: the video goes to the Windows Recycle Bin (under its
/// own name, so restoring it from there works); thumbnail and details are removed.
pub fn recycle(root: &Path, clip: &Path) -> Result<(), String> {
    let video = held(clip);
    if video.exists() {
        fs::rename(&video, clip).map_err(|e| e.to_string())?;
    }
    if clip.exists() {
        send_to_recycle_bin(clip)?;
    }
    for side in [thumb_path(root, clip), meta_path(root, clip)] {
        let _ = fs::remove_file(held(&side));
        let _ = fs::remove_file(&side);
    }
    Ok(())
}

/// Clips deleted just before the app closed (Undo never ran out): recycle them now.
pub fn recycle_leftovers(root: &Path) {
    for dir in [MY_CLIPS, STREAMER_CLIPS] {
        let Ok(entries) = fs::read_dir(root.join(dir)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some(HELD) {
                let _ = recycle(root, &path.with_extension(""));
            }
        }
    }
}

/// `\\?\C:\x` (what `canonicalize` gives on Windows) as `C:\x`, and
/// `\\?\UNC\server\share` as `\\server\share`: many Windows functions, the
/// Recycle Bin's among them, don't accept the `\\?\` form.
#[cfg_attr(not(windows), allow(dead_code))]
fn plain_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Moves a file to the Recycle Bin with Windows' own file operation (no
/// PowerShell, which can be blocked, slow or restricted).
#[cfg(windows)]
fn send_to_recycle_bin(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    let plain = plain_path(path);
    // A list of names, each ending in a 0, the whole list ending in another 0.
    let from: Vec<u16> = plain.as_os_str().encode_wide().chain([0, 0]).collect();
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0) as u16,
        ..Default::default()
    };
    // SAFETY: `op` and the name list it points to live through the call.
    let code = unsafe { SHFileOperationW(&mut op) };
    if code == 0 && !op.fAnyOperationsAborted.as_bool() && !path.exists() {
        Ok(())
    } else {
        let why = format!("Windows said {code:#x}{}", if path.exists() { ", and the file is still there (is it open in another program?)" } else { "" });
        crate::trail(&format!("recycle bin: couldn't move {} ({why})", plain.display()));
        Err(format!("Couldn't move the clip to the Recycle Bin ({why})."))
    }
}

#[cfg(not(windows))]
fn send_to_recycle_bin(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| e.to_string())
}

/// Deletes the oldest clips until the folder is under `limit_gb` (0 = no limit).
/// Returns how many were deleted.
pub fn prune(root: &Path, limit_gb: u32) -> usize {
    if limit_gb == 0 {
        return 0;
    }
    let limit = u64::from(limit_gb) * 1024 * 1024 * 1024;
    let mut clips = list(root);
    let mut total: u64 = clips.iter().map(|c| c.size_bytes).sum();
    let mut deleted = 0;
    // Newest first, so pop() gives the oldest. Always keep the newest clip.
    while total > limit && clips.len() > 1 {
        let Some(oldest) = clips.pop() else { break };
        if delete(root, Path::new(&oldest.path)).is_ok() {
            total -= oldest.size_bytes;
            deleted += 1;
        }
    }
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crosspov-clips-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(MY_CLIPS)).unwrap();
        fs::create_dir_all(dir.join(STREAMER_CLIPS)).unwrap();
        dir
    }

    #[test]
    fn recycle_bin_gets_plain_paths() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\Videos\Clip.mp4")), PathBuf::from(r"C:\Videos\Clip.mp4"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\nas\clips\a.mp4")), PathBuf::from(r"\\nas\clips\a.mp4"));
        assert_eq!(plain_path(Path::new("/home/a.mp4")), PathBuf::from("/home/a.mp4"));
    }

    #[test]
    fn one_clip_matches_the_full_list() {
        let root = temp_root("info");
        let clip = root.join(STREAMER_CLIPS).join("st_R3_kill_ab.mp4");
        fs::write(&clip, b"x").unwrap();
        write_meta(&root, &clip, &ClipMeta { streamer: Some("St".into()), round: Some(3), ..Default::default() });
        fs::write(root.join(STREAMER_CLIPS).join("notes.txt"), b"x").unwrap();
        let one = info(&root, &clip, ClipKind::Theirs).unwrap();
        let all = list(&root);
        assert_eq!(all.len(), 1);
        assert_eq!((&all[0].path, all[0].size_bytes, all[0].round), (&one.path, one.size_bytes, one.round));
        assert_eq!(one.streamer.as_deref(), Some("St"));
        assert!(info(&root, &root.join(STREAMER_CLIPS).join("notes.txt"), ClipKind::Theirs).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn hidden_clips_leave_the_list_and_come_back() {
        let root = temp_root("hide");
        let clip = root.join(MY_CLIPS).join("c.mp4");
        fs::write(&clip, b"x").unwrap();
        write_meta(&root, &clip, &ClipMeta { round: Some(5), ..Default::default() });
        let path = list(&root)[0].path.clone();

        hide(&root, &validate(&root, &path).unwrap()).unwrap();
        assert!(list(&root).is_empty());
        assert!(validate(&root, &path).is_err());

        unhide(&root, &validate_hidden(&root, &path).unwrap()).unwrap();
        let back = list(&root);
        assert_eq!((back.len(), back[0].round), (1, Some(5)));
        assert!(validate_hidden(&root, &path).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn lists_videos_only_and_validates_paths() {
        let root = temp_root("list");
        fs::write(root.join(MY_CLIPS).join("a.mp4"), b"x").unwrap();
        fs::write(root.join(MY_CLIPS).join("notes.txt"), b"x").unwrap();
        fs::write(root.join(STREAMER_CLIPS).join("b.mkv"), b"xy").unwrap();
        let clips = list(&root);
        assert_eq!(clips.len(), 2);
        assert!(clips.iter().any(|c| c.kind == ClipKind::Theirs && c.size_bytes == 2));

        assert!(validate(&root, &clips[0].path).is_ok());
        assert!(validate(&root, root.join(MY_CLIPS).join("notes.txt").to_str().unwrap()).is_err());
        let outside = std::env::temp_dir().join(format!("crosspov-outside-{}.mp4", std::process::id()));
        fs::write(&outside, b"x").unwrap();
        assert!(validate(&root, outside.to_str().unwrap()).is_err());
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn no_limit_never_deletes() {
        let root = temp_root("prune");
        fs::write(root.join(MY_CLIPS).join("a.mp4"), b"x").unwrap();
        assert_eq!(prune(&root, 0), 0);
        assert_eq!(list(&root).len(), 1);
        let _ = fs::remove_dir_all(root);
    }
}
