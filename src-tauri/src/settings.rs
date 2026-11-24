//! User settings, stored as JSON in the app's config folder
//! (`%APPDATA%\app.crosspov.desktop\settings.json` on Windows).
//!
//! The shape must match `Settings` in `src/lib/settings.ts`.

use std::{fs, io, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Resolution {
    #[serde(rename = "native")]
    Native,
    #[serde(rename = "1440p")]
    P1440,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "720p")]
    P720,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Low,
    Medium,
    High,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoder {
    Auto,
    Nvenc,
    Amf,
    Qsv,
    X264,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Mp4,
    Mkv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadQuality {
    #[serde(rename = "source")]
    Source,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "720p")]
    P720,
}

/// Missing fields (e.g. after an update adds a setting) fall back to defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // Recording
    pub fps: u32,
    pub resolution: Resolution,
    pub quality: Quality,
    pub encoder: Encoder,
    pub format: Container,
    // Hotkey and replay buffer
    pub hotkey: String,
    pub buffer_seconds: u32,
    pub clip_sound: bool,
    // Audio
    pub game_audio: bool,
    pub microphone: bool,
    pub mic_device: String,
    pub separate_tracks: bool,
    // Streamer clips
    pub streamer_auto: bool,
    pub clip_killed_you: bool,
    pub clip_you_killed: bool,
    pub clip_whole_round: bool,
    pub seconds_before: u32,
    pub seconds_after: u32,
    pub download_quality: DownloadQuality,
    pub side_by_side: bool,
    pub grab_after_match: bool,
    pub search_archives: bool,
    pub search_youtube_kick: bool,
    pub vod_wait_hours: u32,
    // Storage
    pub clip_folder: String,
    /// 0 means no limit.
    pub storage_limit_gb: u32,
    pub prune_oldest: bool,
    // App
    pub start_with_windows: bool,
    pub minimize_to_tray: bool,
    pub notifications: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            fps: 60,
            resolution: Resolution::P1080,
            quality: Quality::High,
            encoder: Encoder::Auto,
            format: Container::Mp4,
            hotkey: "F9".into(),
            buffer_seconds: 60,
            clip_sound: true,
            game_audio: true,
            microphone: false,
            mic_device: "default".into(),
            separate_tracks: true,
            streamer_auto: true,
            clip_killed_you: true,
            clip_you_killed: true,
            clip_whole_round: false,
            seconds_before: 5,
            seconds_after: 5,
            download_quality: DownloadQuality::Source,
            side_by_side: true,
            grab_after_match: true,
            search_archives: true,
            search_youtube_kick: true,
            vod_wait_hours: 48,
            clip_folder: String::new(),
            storage_limit_gb: 50,
            prune_oldest: true,
            start_with_windows: true,
            minimize_to_tray: true,
            notifications: true,
        }
    }
}

impl Settings {
    /// Keeps numbers in the ranges the recorder supports, whatever the UI sent.
    pub fn sanitize(&mut self) {
        self.fps = self.fps.clamp(24, 240);
        self.buffer_seconds = self.buffer_seconds.clamp(5, 300);
        self.seconds_before = self.seconds_before.min(60);
        self.seconds_after = self.seconds_after.min(60);
        self.vod_wait_hours = self.vod_wait_hours.clamp(1, 168);
        self.hotkey = self.hotkey.trim().to_string();
        if self.hotkey.is_empty() {
            self.hotkey = Settings::default().hotkey;
        }
        self.clip_folder = self.clip_folder.trim().to_string();
    }

    /// Reads settings; a missing or unreadable file gives defaults rather than failing startup.
    pub fn load(path: &Path) -> Self {
        let mut s = fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .unwrap_or_default();
        s.sanitize();
        s
    }

    /// Writes to a temp file and renames it, so a crash mid-write can't corrupt settings.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        fs::write(&tmp, json)?;
        fs::rename(&tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_camel_case_and_ui_values() {
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["bufferSeconds"], 60);
        assert_eq!(json["resolution"], "1080p");
        assert_eq!(json["downloadQuality"], "source");
        assert_eq!(json["encoder"], "auto");
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: Settings = serde_json::from_str(r#"{"fps":144}"#).unwrap();
        assert_eq!(s.fps, 144);
        assert_eq!(s.hotkey, "F9");
    }

    #[test]
    fn sanitize_clamps_numbers() {
        let mut s = Settings { fps: 5000, buffer_seconds: 0, hotkey: "  ".into(), ..Settings::default() };
        s.sanitize();
        assert_eq!(s.fps, 240);
        assert_eq!(s.buffer_seconds, 5);
        assert_eq!(s.hotkey, "F9");
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!("crosspov-test-{}", std::process::id()));
        let path = dir.join("settings.json");
        let s = Settings { fps: 120, clip_folder: "D:\\Clips".into(), ..Settings::default() };
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);
        let _ = fs::remove_dir_all(dir);
    }
}
