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
    /// Software encoding. Older settings files said "x264".
    #[serde(alias = "x264")]
    Cpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Mp4,
    Mkv,
}

/// Which game sound gets recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioMode {
    /// Only the game (plus any apps the user adds). Needs Windows 10 2004+.
    Game,
    /// Everything that plays through the speakers.
    Desktop,
}

/// An extra app whose sound goes into clips, e.g. Discord.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAudio {
    /// Executable name, e.g. "Discord.exe".
    pub exe: String,
    pub enabled: bool,
    /// 0-100.
    pub volume: u32,
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

/// The CrossPOV server (Cloudflare Worker) the app gets match data from.
pub const DEFAULT_SERVER_URL: &str = "https://crosspov.com";
/// Where the server lived before crosspov.com; saved settings move over.
const OLD_SERVER_URL: &str = "https://crosspov.batainehsaeed1.workers.dev";
/// Longest lead-in / follow-through for a streamer clip, in seconds.
pub const MAX_PADDING: u32 = 120;
pub const REGIONS: [&str; 6] = ["na", "eu", "ap", "kr", "br", "latam"];

/// A game you added: its program file name, and what to call it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGame {
    pub exe: String,
    pub name: String,
}

/// Missing fields (e.g. after an update adds a setting) fall back to defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // Account
    /// "Name#TAG". Used only to look up the user's own matches.
    pub riot_id: String,
    /// Match data region: na, eu, ap, kr, br or latam.
    pub region: String,
    pub server_url: String,
    // Recording
    pub fps: u32,
    pub resolution: Resolution,
    pub quality: Quality,
    pub encoder: Encoder,
    pub format: Container,
    // Which games to record
    /// Any app running fullscreen (or borderless fullscreen) counts as a game.
    pub record_fullscreen: bool,
    /// Games you added by hand (their .exe).
    pub custom_games: Vec<CustomGame>,
    /// Programs never to record, even if fullscreen or on the built-in list (exe names).
    pub ignored_games: Vec<String>,
    // Hotkey and replay buffer
    pub hotkey: String,
    pub buffer_seconds: u32,
    pub clip_sound: bool,
    // Audio
    pub audio_mode: AudioMode,
    pub game_audio: bool,
    pub game_volume: u32,
    pub apps: Vec<AppAudio>,
    pub microphone: bool,
    pub mic_device: String,
    pub mic_volume: u32,
    /// Removes background noise (keyboard, fans, hum) from the mic.
    pub mic_noise_suppression: bool,
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
            riot_id: String::new(),
            region: "eu".into(),
            server_url: DEFAULT_SERVER_URL.into(),
            fps: 60,
            resolution: Resolution::P1080,
            quality: Quality::High,
            encoder: Encoder::Auto,
            format: Container::Mp4,
            record_fullscreen: true,
            custom_games: Vec::new(),
            ignored_games: Vec::new(),
            hotkey: "F9".into(),
            buffer_seconds: 60,
            clip_sound: true,
            audio_mode: AudioMode::Game,
            game_audio: true,
            game_volume: 100,
            apps: Vec::new(),
            microphone: false,
            mic_device: "default".into(),
            mic_volume: 100,
            mic_noise_suppression: false,
            separate_tracks: true,
            streamer_auto: true,
            clip_killed_you: true,
            clip_you_killed: true,
            clip_whole_round: false,
            seconds_before: 60,
            seconds_after: 60,
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
        self.riot_id = self.riot_id.trim().to_string();
        self.region = self.region.trim().to_lowercase();
        if !REGIONS.contains(&self.region.as_str()) {
            self.region = Settings::default().region;
        }
        self.server_url = self.server_url.trim().trim_end_matches('/').to_string();
        if self.server_url == OLD_SERVER_URL {
            self.server_url = DEFAULT_SERVER_URL.into();
        }
        if !(self.server_url.starts_with("https://") || self.server_url.starts_with("http://localhost")) {
            self.server_url = DEFAULT_SERVER_URL.into();
        }
        self.fps = self.fps.clamp(24, 240);
        self.buffer_seconds = self.buffer_seconds.clamp(5, 300);
        self.seconds_before = self.seconds_before.min(MAX_PADDING);
        self.seconds_after = self.seconds_after.min(MAX_PADDING);
        self.vod_wait_hours = self.vod_wait_hours.clamp(1, 168);
        self.hotkey = self.hotkey.trim().to_string();
        if self.hotkey.is_empty() {
            self.hotkey = Settings::default().hotkey;
        }
        self.clip_folder = self.clip_folder.trim().to_string();
        // Games: a plain "name.exe" each, no duplicates, a sane number.
        let exe_ok = |e: &str| e.to_lowercase().ends_with(".exe") && !e.contains(['/', '\\']) && e.len() <= 120;
        for g in &mut self.custom_games {
            g.exe = g.exe.trim().to_string();
            g.name = g.name.trim().chars().take(60).collect();
            if g.name.is_empty() {
                g.name = g.exe.trim_end_matches(".exe").trim_end_matches(".EXE").to_string();
            }
        }
        let mut seen = std::collections::HashSet::new();
        self.custom_games.retain(|g| exe_ok(&g.exe) && seen.insert(g.exe.to_lowercase()));
        self.custom_games.truncate(100);
        let mut seen = std::collections::HashSet::new();
        self.ignored_games = self.ignored_games.iter().map(|e| e.trim().to_string()).filter(|e| exe_ok(e) && seen.insert(e.to_lowercase())).take(100).collect();
        self.game_volume = self.game_volume.min(200);
        self.mic_volume = self.mic_volume.min(200);
        for app in &mut self.apps {
            app.volume = app.volume.min(200);
            app.exe = app.exe.trim().to_string();
        }
        // One entry per app, no blanks.
        let mut seen = Vec::new();
        self.apps.retain(|a| !a.exe.is_empty() && {
            let key = a.exe.to_lowercase();
            let new = !seen.contains(&key);
            seen.push(key);
            new
        });
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
    fn old_x264_encoder_value_still_loads() {
        let s: Settings = serde_json::from_str(r#"{"encoder":"x264"}"#).unwrap();
        assert_eq!(s.encoder, Encoder::Cpu);
    }

    #[test]
    fn default_hotkey_formats_parse() {
        use std::str::FromStr;
        use tauri_plugin_global_shortcut::Shortcut;
        for k in ["F9", "Ctrl+Shift+F8", "Alt+A", "Ctrl+1", "PageUp", "Shift+PrintScreen"] {
            assert!(Shortcut::from_str(k).is_ok(), "{k} should parse");
        }
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

    #[test]
    fn account_fields_are_cleaned() {
        let mut s = Settings { region: " EU ".into(), server_url: "ftp://x/".into(), riot_id: " Me#EUW ".into(), ..Settings::default() };
        s.sanitize();
        assert_eq!(s.region, "eu");
        assert_eq!(s.server_url, DEFAULT_SERVER_URL);
        assert_eq!(s.riot_id, "Me#EUW");
        let mut old = Settings { server_url: "https://crosspov.batainehsaeed1.workers.dev/".into(), ..Settings::default() };
        old.sanitize();
        assert_eq!(old.server_url, "https://crosspov.com", "old address moves to the domain");
        let mut bad = Settings { region: "mars".into(), ..Settings::default() };
        bad.sanitize();
        assert_eq!(bad.region, "eu");
    }
}
