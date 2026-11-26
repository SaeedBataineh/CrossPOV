//! Finding FFmpeg, picking a video encoder, and building the recorder's
//! command line.
//!
//! Recording pipeline (Windows):
//!   ddagrab (Desktop Duplication, frames stay on the GPU)
//!     -> GPU encoder (NVENC / AMF / Quick Sync) when recording at native size
//!     -> 2-second MPEG-TS segments in a ring of files (the replay buffer)
//!   Audio is captured in Rust (WASAPI) and piped in as 4-channel float PCM:
//!   channels 0-1 = game (loopback), 2-3 = microphone.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::Serialize;

use crate::settings::{Container, Encoder, Quality, Resolution, Settings};

/// Length of each buffer segment. A hotkey clip is a whole number of these,
/// and each starts with a full picture (keyframe). Shorter saves sooner but
/// spends more of the bitrate on keyframes; 2 s keeps clips sharp.
pub const SEGMENT_SECONDS: u32 = 2;
pub const AUDIO_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: u16 = 4;

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

    /// NVENC and AMF take the captured frames straight from the GPU; the
    /// Media Foundation encoders get them copied to normal memory first.
    fn takes_gpu_frames(self) -> bool {
        matches!(self, VideoEncoder::Nvenc | VideoEncoder::Amf)
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

fn target_height(r: Resolution) -> Option<u32> {
    match r {
        Resolution::Native => None,
        Resolution::P1440 => Some(1440),
        Resolution::P1080 => Some(1080),
        Resolution::P720 => Some(720),
    }
}

/// Where video frames come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoSource {
    /// Windows desktop capture on the GPU.
    Desktop,
    /// Moving test pattern, for testing the pipeline on any OS.
    TestPattern,
}

#[derive(Debug, Clone)]
pub struct RecordPlan {
    pub source: VideoSource,
    pub encoder: VideoEncoder,
    /// Whether audio PCM is fed on stdin.
    pub audio: bool,
    /// Copy frames to system memory before encoding. Slower, but works on
    /// drivers that refuse GPU frames directly. Used as a fallback.
    pub compat: bool,
    pub segment_dir: PathBuf,
    pub segment_count: u32,
    /// Height of the screen being recorded, if known. A screen no taller than
    /// the chosen resolution isn't resized at all.
    pub screen_height: Option<u32>,
    /// Which screen to capture (0 = main), as Desktop Duplication counts them.
    pub output_idx: u32,
    /// Record H.265 instead of H.264.
    pub hevc: bool,
}

impl RecordPlan {
    pub fn list_file(&self) -> PathBuf {
        self.segment_dir.join("segments.txt")
    }
}

/// Number of ring-buffer files: enough for the clip length plus spare so
/// FFmpeg never overwrites a segment while a clip is being cut from it.
pub fn segment_count(buffer_seconds: u32) -> u32 {
    buffer_seconds.div_ceil(SEGMENT_SECONDS) + 4
}

/// Builds the FFmpeg arguments for the replay buffer.
pub fn record_args(s: &Settings, plan: &RecordPlan) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    fn push(a: &mut Vec<String>, items: &[&str]) {
        a.extend(items.iter().map(|x| x.to_string()));
    }
    push(&mut a, &["-hide_banner", "-loglevel", "error", "-y"]);

    // Input 0: video.
    let fps = s.fps.to_string();
    match plan.source {
        VideoSource::Desktop => {
            // draw_mouse=0: the in-game crosshair is part of the game image; the
            // Windows cursor would only show up on menus.
            push(&mut a, &["-f", "lavfi", "-thread_queue_size", "64", "-i"]);
            a.push(format!("ddagrab=output_idx={}:framerate={fps}:draw_mouse=0", plan.output_idx));
        }
        VideoSource::TestPattern => {
            push(&mut a, &["-re", "-f", "lavfi", "-i"]);
            a.push(format!("testsrc2=size=1280x720:rate={fps}"));
        }
    }

    // Input 1: audio PCM from our mixer on stdin.
    if plan.audio {
        push(&mut a, &["-f", "f32le", "-ar"]);
        a.push(AUDIO_RATE.to_string());
        push(&mut a, &["-ac"]);
        a.push(AUDIO_CHANNELS.to_string());
        push(&mut a, &["-thread_queue_size", "1024", "-i", "pipe:0"]);
    }

    // Video filters. On a GPU encoder the frames go straight from capture to
    // encoder without touching the CPU, resized on the GPU if needed. The CPU
    // path (copy out, convert, resize) is for Media Foundation, the test
    // pattern, and compatibility mode when a driver refuses the GPU path.
    let height = target_height(s.resolution).filter(|h| plan.screen_height.is_none_or(|screen| screen > *h));
    let on_gpu = plan.source == VideoSource::Desktop;
    let gpu_path = on_gpu && plan.encoder.takes_gpu_frames() && !plan.compat;
    let mut vf: Vec<String> = Vec::new();
    if gpu_path {
        if let Some(h) = height {
            vf.push(format!("scale_d3d11=width=-2:height='min(ih,{h})':format=nv12"));
        }
    } else {
        if on_gpu {
            vf.push("hwdownload".into());
            vf.push("format=bgra".into());
        }
        if let Some(h) = height {
            vf.push(format!("scale=-2:'min(ih,{h})':flags=bilinear"));
        }
        vf.push("format=nv12".into());
    }

    let mut graph: Vec<String> = Vec::new();
    let video_label = if vf.is_empty() {
        "0:v".to_string()
    } else {
        graph.push(format!("[0:v]{}[v]", vf.join(",")));
        "[v]".to_string()
    };

    // Audio: split or mix the 4 channels into the tracks the user wants.
    let mut audio_labels: Vec<&str> = Vec::new();
    if plan.audio {
        let game = s.game_audio;
        let mic = s.microphone;
        if game && mic && s.separate_tracks {
            graph.push("[1:a]pan=stereo|c0=c0|c1=c1[game]".into());
            graph.push("[1:a]pan=stereo|c0=c2|c1=c3[mic]".into());
            audio_labels.extend(["[game]", "[mic]"]);
        } else if game && mic {
            graph.push("[1:a]pan=stereo|c0=c0+c2|c1=c1+c3,alimiter=limit=0.95[mix]".into());
            audio_labels.push("[mix]");
        } else if game {
            graph.push("[1:a]pan=stereo|c0=c0|c1=c1[game]".into());
            audio_labels.push("[game]");
        } else {
            graph.push("[1:a]pan=stereo|c0=c2|c1=c3[mic]".into());
            audio_labels.push("[mic]");
        }
    }
    if !graph.is_empty() {
        push(&mut a, &["-filter_complex"]);
        a.push(graph.join(";"));
    }
    push(&mut a, &["-map"]);
    a.push(video_label);
    for l in &audio_labels {
        push(&mut a, &["-map", l]);
    }

    // Encoder. A keyframe every segment so the buffer can be cut anywhere.
    let kbps = bitrate_kbps(s);
    let gop = (s.fps * SEGMENT_SECONDS).to_string();
    push(&mut a, &["-c:v", if plan.hevc { plan.encoder.hevc_codec() } else { plan.encoder.codec() }]);
    match plan.encoder {
        VideoEncoder::Nvenc => {
            push(&mut a, &["-preset", "p4", "-tune", "hq", "-rc", "vbr", "-forced-idr", "1"]);
            // Spend the bits where the eye looks (edges, faces, text) and on
            // what stays on screen; B-frames for more detail per bit. Left out
            // in compatibility mode, in case an older card refuses them.
            if !plan.compat {
                push(&mut a, &["-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "8", "-bf", "3"]);
            }
        }
        VideoEncoder::Amf => {
            push(&mut a, &["-usage", "transcoding", "-quality", if plan.compat { "balanced" } else { "quality" }, "-rc", "vbr_peak"]);
            if !plan.compat {
                push(&mut a, &["-vbaq", "true"]);
            }
        }
        #[cfg(windows)]
        VideoEncoder::Qsv => push(&mut a, &["-hw_encoding", "1", "-rate_control", "cbr", "-scenario", "display_remoting"]),
        #[cfg(not(windows))]
        VideoEncoder::Qsv => push(&mut a, &["-preset", "medium", "-look_ahead", "0"]),
        #[cfg(windows)]
        VideoEncoder::Cpu => push(&mut a, &["-rate_control", "cbr", "-scenario", "display_remoting"]),
        #[cfg(not(windows))]
        VideoEncoder::Cpu => push(&mut a, &["-preset", "veryfast", "-tune", "zerolatency"]),
    }
    push(&mut a, &["-b:v"]);
    a.push(format!("{kbps}k"));
    push(&mut a, &["-maxrate"]);
    a.push(format!("{}k", kbps * 3 / 2));
    push(&mut a, &["-bufsize"]);
    a.push(format!("{}k", kbps * 2));
    push(&mut a, &["-g", &gop, "-keyint_min", &gop]);
    if !audio_labels.is_empty() {
        push(&mut a, &["-c:a", "aac", "-b:a", "160k", "-ar"]);
        a.push(AUDIO_RATE.to_string());
    }

    // Ring buffer of MPEG-TS segments. The list file always names the last
    // `segment_count` finished segments, oldest first.
    let n = plan.segment_count.to_string();
    let seg = SEGMENT_SECONDS.to_string();
    push(&mut a, &["-f", "segment", "-segment_time", &seg, "-segment_wrap", &n, "-segment_list_size", &n]);
    push(&mut a, &["-segment_list_type", "flat", "-segment_format", "mpegts", "-reset_timestamps", "0", "-segment_list"]);
    a.push(plan.list_file().to_string_lossy().into_owned());
    a.push(plan.segment_dir.join("seg%03d.ts").to_string_lossy().into_owned());
    a
}

/// Arguments that join buffer segments into one clip without re-encoding.
pub fn concat_args(concat_list: &Path, out: &Path, format: Container, hevc: bool) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.push(concat_list.to_string_lossy().into_owned());
    a.extend(["-map", "0", "-c", "copy"].iter().map(|s| s.to_string()));
    if hevc && format == Container::Mp4 {
        // The tag browsers (and CrossPOV's player) expect for H.265 in MP4.
        a.extend(["-tag:v", "hvc1"].iter().map(|s| s.to_string()));
    }
    if format == Container::Mp4 {
        a.extend(["-bsf:a", "aac_adtstoasc", "-movflags", "+faststart"].iter().map(|s| s.to_string()));
    }
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
    a.extend(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4"].iter().map(|s| s.to_string()));
    a.push(out.to_string_lossy().into_owned());
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(source: VideoSource, encoder: VideoEncoder, audio: bool) -> RecordPlan {
        RecordPlan { source, encoder, audio, compat: false, segment_dir: PathBuf::from("/tmp/buf"), segment_count: 34, screen_height: None, output_idx: 0, hevc: false }
    }

    fn joined(s: &Settings, p: &RecordPlan) -> String {
        record_args(s, p).join(" ")
    }

    #[test]
    fn native_gpu_capture_never_leaves_the_gpu() {
        let s = Settings { resolution: Resolution::Native, ..Settings::default() };
        let args = joined(&s, &plan(VideoSource::Desktop, VideoEncoder::Nvenc, false));
        assert!(args.contains("ddagrab=output_idx=0:framerate=60"));
        let second = joined(&Settings::default(), &RecordPlan { output_idx: 1, ..plan(VideoSource::Desktop, VideoEncoder::Nvenc, false) });
        assert!(second.contains("ddagrab=output_idx=1:"), "records the screen the game is on");
        assert!(!args.contains("hwdownload"), "{args}");
        assert!(args.contains("-map 0:v"));
        assert!(args.contains("-c:v h264_nvenc"));
        assert!(args.contains("-g 120"), "a keyframe every segment");
    }

    #[test]
    fn gpu_encoders_resize_on_the_gpu() {
        let s = Settings { resolution: Resolution::P720, ..Settings::default() };
        let args = joined(&s, &plan(VideoSource::Desktop, VideoEncoder::Amf, false));
        assert!(args.contains("[0:v]scale_d3d11=width=-2:height='min(ih,720)':format=nv12[v]"), "{args}");
        assert!(!args.contains("hwdownload"), "{args}");
    }

    #[test]
    fn compatibility_mode_resizes_on_the_cpu() {
        let s = Settings { resolution: Resolution::P720, ..Settings::default() };
        let p = RecordPlan { compat: true, ..plan(VideoSource::Desktop, VideoEncoder::Nvenc, false) };
        let args = joined(&s, &p);
        assert!(args.contains("[0:v]hwdownload,format=bgra,scale=-2:'min(ih,720)':flags=bilinear,format=nv12[v]"), "{args}");
    }

    #[test]
    fn screen_already_small_enough_is_not_resized() {
        let s = Settings { resolution: Resolution::P1080, ..Settings::default() };
        for screen in [1080, 900] {
            let p = RecordPlan { screen_height: Some(screen), ..plan(VideoSource::Desktop, VideoEncoder::Nvenc, false) };
            let args = joined(&s, &p);
            assert!(!args.contains("scale"), "{screen}: {args}");
            assert!(args.contains("-map 0:v"), "{args}");
        }
        // Media Foundation still needs frames in normal memory, but no resize.
        let p = RecordPlan { screen_height: Some(1080), ..plan(VideoSource::Desktop, VideoEncoder::Qsv, false) };
        assert!(joined(&s, &p).contains("[0:v]hwdownload,format=bgra,format=nv12[v]"));
        // A taller screen is resized.
        let p = RecordPlan { screen_height: Some(1440), ..plan(VideoSource::Desktop, VideoEncoder::Nvenc, false) };
        assert!(joined(&s, &p).contains("scale_d3d11"));
    }

    #[test]
    fn media_foundation_gets_frames_in_normal_memory() {
        let s = Settings { resolution: Resolution::Native, ..Settings::default() };
        let args = joined(&s, &plan(VideoSource::Desktop, VideoEncoder::Qsv, false));
        assert!(args.contains("[0:v]hwdownload,format=bgra,format=nv12[v]"), "{args}");
    }

    #[test]
    fn audio_tracks_follow_settings() {
        let both_sep = Settings { microphone: true, separate_tracks: true, ..Settings::default() };
        let a = joined(&both_sep, &plan(VideoSource::Desktop, VideoEncoder::Nvenc, true));
        assert!(a.contains("-map [game] -map [mic]"), "{a}");

        let mixed = Settings { microphone: true, separate_tracks: false, ..Settings::default() };
        let a = joined(&mixed, &plan(VideoSource::Desktop, VideoEncoder::Nvenc, true));
        assert!(a.contains("c0=c0+c2"), "{a}");
        assert!(!a.contains("[mic]"));
    }

    #[test]
    fn h265_uses_the_same_card_and_plays_in_mp4() {
        let p = RecordPlan { hevc: true, ..plan(VideoSource::Desktop, VideoEncoder::Nvenc, false) };
        let a = joined(&Settings::default(), &p);
        assert!(a.contains("-c:v hevc_nvenc"), "{a}");
        assert!(a.contains("-spatial-aq 1"), "{a}");
        let compat = joined(&Settings::default(), &RecordPlan { compat: true, ..p });
        assert!(!compat.contains("-bf 3"), "compatibility mode keeps to basic options");
        let amd = joined(&Settings::default(), &RecordPlan { hevc: true, ..plan(VideoSource::Desktop, VideoEncoder::Amf, false) });
        assert!(amd.contains("-c:v hevc_amf") && amd.contains("-quality quality"), "{amd}");

        let list = PathBuf::from("l.txt");
        let mp4 = concat_args(&list, &PathBuf::from("c.mp4"), Container::Mp4, true).join(" ");
        assert!(mp4.contains("-tag:v hvc1"), "{mp4}");
        let h264 = concat_args(&list, &PathBuf::from("c.mp4"), Container::Mp4, false).join(" ");
        assert!(!h264.contains("hvc1"));
    }

    #[test]
    fn a_picked_bitrate_is_used_as_is() {
        let s = Settings { bitrate_mbps: 50, fps: 120, resolution: Resolution::P1440, ..Settings::default() };
        assert_eq!(bitrate_kbps(&s), 50_000);
        assert!(joined(&s, &plan(VideoSource::Desktop, VideoEncoder::Nvenc, false)).contains("-b:v 50000k"));
        assert_eq!(bitrate_kbps(&Settings::default()), 25_000, "Auto as before");
    }

    #[test]
    fn ring_buffer_settings() {
        assert_eq!(segment_count(60), 34);
        assert_eq!(segment_count(15), 12);
        let a = joined(&Settings::default(), &plan(VideoSource::Desktop, VideoEncoder::Nvenc, false));
        assert!(a.contains("-segment_wrap 34 -segment_list_size 34"));
    }

    #[test]
    fn bitrate_scales_with_quality() {
        let high = bitrate_kbps(&Settings::default());
        let low = bitrate_kbps(&Settings { quality: Quality::Low, ..Settings::default() });
        assert_eq!(high, 25_000);
        assert!(low < high);
    }
}
