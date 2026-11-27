//! Finding FFmpeg and picking a video encoder. OBS records (see obs.rs);
//! FFmpeg makes thumbnails and cuts and shrinks clips.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::Serialize;

use crate::settings::{Encoder, Quality, Resolution, Settings};


#[cfg(windows)]
const FFMPEG_EXE: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_EXE: &str = "ffmpeg";

/// Looks for FFmpeg: `CROSSPOV_FFMPEG`, then next to the app's own exe
/// (where the installer and the portable zip put it), then on PATH.
pub fn locate() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CROSSPOV_FFMPEG").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = crate::tools::get(FFMPEG_EXE) {
        return Some(p);
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let p = dir.join(FFMPEG_EXE);
        if p.is_file() {
            return Some(p);
        }
    }
    which(FFMPEG_EXE)
}

/// Full path of a program on PATH (other tools need a real path, not a bare name).
pub fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// Stops a console window flashing up for every FFmpeg run on Windows.
pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
    /// No window, and "below normal" priority, so background work (streamer
    /// downloads, thumbnails) never takes CPU from the game. Programs it starts
    /// (yt-dlp's FFmpeg) inherit it.
    fn background(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }
    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
    #[cfg(windows)]
    fn background(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        self.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS)
    }
    #[cfg(not(windows))]
    fn background(&mut self) -> &mut Self {
        self
    }
}

/// A concrete encoder FFmpeg will use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoEncoder {
    Nvenc,
    Amf,
    /// Intel (and other) GPUs through Windows' Media Foundation encoder in
    /// hardware mode. Serialised as "qsv" for older settings and logs.
    Qsv,
    Cpu,
}

impl VideoEncoder {
    pub fn codec(self) -> &'static str {
        match self {
            VideoEncoder::Nvenc => "h264_nvenc",
            VideoEncoder::Amf => "h264_amf",
            #[cfg(windows)]
            VideoEncoder::Qsv => "h264_mf",
            #[cfg(not(windows))]
            VideoEncoder::Qsv => "h264_qsv",
            #[cfg(windows)]
            VideoEncoder::Cpu => "h264_mf",
            #[cfg(not(windows))]
            VideoEncoder::Cpu => "libx264",
        }
    }

    /// The H.265 encoder on the same hardware.
    pub fn hevc_codec(self) -> &'static str {
        match self {
            VideoEncoder::Nvenc => "hevc_nvenc",
            VideoEncoder::Amf => "hevc_amf",
            #[cfg(windows)]
            VideoEncoder::Qsv | VideoEncoder::Cpu => "hevc_mf",
            #[cfg(not(windows))]
            VideoEncoder::Qsv => "hevc_qsv",
            #[cfg(not(windows))]
            VideoEncoder::Cpu => "libx265",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            VideoEncoder::Nvenc => "NVIDIA NVENC",
            VideoEncoder::Amf => "AMD AMF",
            VideoEncoder::Qsv => "Intel / Windows hardware",
            VideoEncoder::Cpu => "CPU",
        }
    }

    /// Extra options needed for a quick "does this work" test encode.
    fn probe_args(self) -> &'static [&'static str] {
        if cfg!(windows) && self == VideoEncoder::Qsv {
            &["-hw_encoding", "1"]
        } else {
            &[]
        }
    }
}

/// Tries a one-frame encode to see whether this machine's GPU supports an encoder.
fn encoder_works(ffmpeg: &Path, enc: VideoEncoder) -> bool {
    Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=640x360:r=30", "-frames:v", "3"])
        .args(["-pix_fmt", "nv12", "-c:v", enc.codec()])
        .args(enc.probe_args())
        .args(["-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_window()
        .status()
        .is_ok_and(|s| s.success())
}

/// GPU encoders in order of preference; falls back to the CPU.
pub fn detect_encoder(ffmpeg: &Path) -> VideoEncoder {
    [VideoEncoder::Nvenc, VideoEncoder::Amf, VideoEncoder::Qsv]
        .into_iter()
        .find(|&e| encoder_works(ffmpeg, e))
        .unwrap_or(VideoEncoder::Cpu)
}

/// The encoder to use: the user's choice, or the detected one for Auto.
pub fn resolve_encoder(choice: Encoder, detected: VideoEncoder) -> VideoEncoder {
    match choice {
        Encoder::Auto => detected,
        Encoder::Nvenc => VideoEncoder::Nvenc,
        Encoder::Amf => VideoEncoder::Amf,
        Encoder::Qsv => VideoEncoder::Qsv,
        Encoder::Cpu => VideoEncoder::Cpu,
    }
}

/// Video bitrate in kbit/s. Mirrors `targetMbps` in src/lib/settings.ts.
pub fn bitrate_kbps(s: &Settings) -> u32 {
    if s.bitrate_mbps > 0 {
        return s.bitrate_mbps * 1000;
    }
    let base = match s.quality {
        Quality::Low => 8.0,
        Quality::Medium => 15.0,
        Quality::High => 25.0,
        Quality::Max => 50.0,
    };
    let res = match s.resolution {
        Resolution::Native => 1.3,
        Resolution::P1440 => 1.5,
        Resolution::P1080 => 1.0,
        Resolution::P720 => 0.6,
    };
    let fps = (f64::from(s.fps) / 60.0).sqrt().max(0.6);
    (base * res * fps * 1000.0).round() as u32
}

/// The picture height for a chosen resolution (None: the game's own).
pub(crate) fn target_height(r: Resolution) -> Option<u32> {
    match r {
        Resolution::Native => None,
        Resolution::P1440 => Some(1440),
        Resolution::P1080 => Some(1080),
        Resolution::P720 => Some(720),
    }
}

/// Arguments that copy an MP4 with its index (moov) at the start, every
/// stream as it is (no re-encoding).
pub fn faststart_args(input: &Path, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-i"].iter().map(|s| s.to_string()).collect();
    a.push(input.to_string_lossy().into_owned());
    a.extend(["-map", "0", "-c", "copy", "-movflags", "+faststart"].iter().map(|s| s.to_string()));
    a.push(out.to_string_lossy().into_owned());
    a
}

/// Arguments that grab one small frame from a clip as its thumbnail.
pub fn thumbnail_args(clip: &Path, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.push(clip.to_string_lossy().into_owned());
    // By the shape it's shown in (`dar`), so a stretched clip's thumbnail is 16:9 too.
    a.extend(["-frames:v", "1", "-vf", "scale=w=480:h='trunc(480/dar/2)*2',setsar=1", "-q:v", "4"].iter().map(|s| s.to_string()));
    a.push(out.to_string_lossy().into_owned());
    a
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picked_bitrate_is_used_as_is() {
        let s = Settings { bitrate_mbps: 50, fps: 120, resolution: Resolution::P1440, ..Settings::default() };
        assert_eq!(bitrate_kbps(&s), 50_000);
        assert_eq!(bitrate_kbps(&Settings::default()), 25_000, "Auto as before");
    }

    #[test]
    fn bitrate_scales_with_quality() {
        let high = bitrate_kbps(&Settings::default());
        let low = bitrate_kbps(&Settings { quality: Quality::Low, ..Settings::default() });
        assert_eq!(high, 25_000);
        assert!(low < high);
    }
}
