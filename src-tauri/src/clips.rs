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
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() || !is_video(&path) {
                continue;
            }
            let thumb = thumb_path(root, &path);
            let details: ClipMeta = fs::read(meta_path(root, &path))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            out.push(ClipInfo {
                name: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
                kind,
                size_bytes: meta.len(),
                created_ms: modified_ms(&meta),
                duration_sec: details.duration_sec,
                thumb: thumb.is_file().then(|| thumb.to_string_lossy().into_owned()),
                streamer: details.streamer,
                round: details.round,
                moment: details.moment,
                map: details.map,
            });
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.created_ms));
    out
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
