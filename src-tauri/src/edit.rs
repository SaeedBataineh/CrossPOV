//! Cutting clips: a trimmed copy (quick, without re-encoding, or exact),
//! and a small copy that fits Discord's free upload limit. All with the
//! FFmpeg CrossPOV already has, on this PC.

use std::path::Path;

use crate::ffmpeg::VideoEncoder;

/// Discord's upload limit without Nitro is 10 MB; aim a little under it.
pub const DISCORD_LIMIT_BYTES: u64 = 10 * 1024 * 1024;
const DISCORD_TARGET_BYTES: f64 = 9.3 * 1024.0 * 1024.0;
const DISCORD_AUDIO_KBPS: u32 = 96;

/// "12.345" for FFmpeg's time options.
fn secs(t: f64) -> String {
    format!("{:.3}", t.max(0.0))
}

fn push(a: &mut Vec<String>, items: &[&str]) {
    a.extend(items.iter().map(|s| s.to_string()));
}

/// Encoder settings for frames that come from a file (not the GPU capture).
/// `kbps`: a target bitrate (for a size limit); otherwise high quality.
pub fn encode_args(enc: VideoEncoder, kbps: Option<u32>) -> Vec<String> {
    let mut a = vec!["-c:v".to_string(), enc.codec().to_string()];
    match (enc, kbps) {
        (VideoEncoder::Nvenc, None) => push(&mut a, &["-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0"]),
        (VideoEncoder::Amf, None) => push(&mut a, &["-quality", "quality", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"]),
        (_, None) => push(&mut a, &["-b:v", "14M"]),
        (enc, Some(k)) => {
            let (b, max, buf) = (format!("{k}k"), format!("{}k", k * 3 / 2), format!("{}k", k * 2));
            if enc == VideoEncoder::Nvenc {
                push(&mut a, &["-preset", "p5", "-rc", "vbr"]);
            }
            push(&mut a, &["-b:v", &b, "-maxrate", &max, "-bufsize", &buf]);
        }
    }
    // Plain 8-bit 4:2:0: plays everywhere (Discord, phones, browsers).
    push(&mut a, &["-pix_fmt", "yuv420p"]);
    a
}

/// A trimmed copy from `start` to `end` seconds. `exact` re-encodes so the
/// cut lands on the very frame; otherwise it copies (instant, but starts at
/// the keyframe before `start`).
pub fn trim_args(input: &Path, out: &Path, start: f64, end: f64, exact: bool, enc: VideoEncoder) -> Vec<String> {
    let mut a = Vec::new();
    push(&mut a, &["-hide_banner", "-loglevel", "error", "-y", "-ss", &secs(start), "-i"]);
    a.push(input.to_string_lossy().into_owned());
    push(&mut a, &["-t", &secs(end - start)]);
    if exact {
        push(&mut a, &["-map", "0:v:0", "-map", "0:a?"]);
        a.extend(encode_args(enc, None));
        push(&mut a, &["-c:a", "aac", "-b:a", "192k"]);
    } else {
        push(&mut a, &["-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero"]);
    }
    if out.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4")) {
        push(&mut a, &["-movflags", "+faststart"]);
    }
    a.push(out.to_string_lossy().into_owned());
    a
}

/// Video bitrate (kbit/s) and height for a Discord copy of `duration` seconds,
/// or None when it's too long to look decent under the limit.
pub fn discord_plan(duration: f64) -> Option<(u32, u32)> {
    let total = DISCORD_TARGET_BYTES * 8.0 / 1000.0 / duration.max(1.0);
    let video = (total * 0.95 - f64::from(DISCORD_AUDIO_KBPS)) as i64;
    match video {
        v if v >= 2500 => Some((v.min(8000) as u32, 1080)),
        v if v >= 1200 => Some((v as u32, 720)),
        v if v >= 450 => Some((v as u32, 480)),
        _ => None,
    }
}

/// The longest clip that still fits under Discord's limit (at 480p), in whole seconds.
pub fn discord_max_seconds() -> u32 {
    (1..=3600).rev().find(|&s| discord_plan(f64::from(s)).is_some()).unwrap_or(0)
}

/// A copy of `start`..`end` that fits Discord's free upload limit: one sound
/// track, smaller picture for longer clips.
pub fn discord_args(input: &Path, out: &Path, start: f64, end: f64, enc: VideoEncoder) -> Option<Vec<String>> {
    let (kbps, height) = discord_plan(end - start)?;
    let mut a = Vec::new();
    push(&mut a, &["-hide_banner", "-loglevel", "error", "-y", "-ss", &secs(start), "-i"]);
    a.push(input.to_string_lossy().into_owned());
    push(&mut a, &["-t", &secs(end - start), "-map", "0:v:0", "-map", "0:a:0?"]);
    push(&mut a, &["-vf", &format!("scale=-2:'min({height},ih)'")]);
    a.extend(encode_args(enc, Some(kbps)));
    push(&mut a, &["-c:a", "aac", "-b:a", &format!("{DISCORD_AUDIO_KBPS}k"), "-ac", "2", "-movflags", "+faststart"]);
    a.push(out.to_string_lossy().into_owned());
    Some(a)
}

/// Puts a file on the Windows clipboard, so Ctrl+V in Discord (or Explorer) pastes it.
#[cfg(windows)]
pub fn copy_file_to_clipboard(path: &Path) -> Result<(), String> {
    use crate::ffmpeg::NoWindow;
    let literal = path.to_string_lossy().replace('\'', "''");
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &format!("Set-Clipboard -LiteralPath '{literal}'")])
        .no_window()
        .status()
        .map_err(|e| format!("Couldn't copy to the clipboard: {e}"))?;
    if status.success() { Ok(()) } else { Err("Couldn't copy to the clipboard.".into()) }
}

#[cfg(not(windows))]
pub fn copy_file_to_clipboard(_path: &Path) -> Result<(), String> {
    Err("Copying files needs Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn joined(a: &[String]) -> String {
        a.join(" ")
    }

    #[test]
    fn quick_trim_copies_and_exact_trim_encodes() {
        let (i, o) = (PathBuf::from("in.mp4"), PathBuf::from("out.mp4"));
        let quick = joined(&trim_args(&i, &o, 55.0, 70.5, false, VideoEncoder::Nvenc));
        assert!(quick.contains("-ss 55.000 -i in.mp4 -t 15.500"));
        assert!(quick.contains("-c copy"));
        assert!(quick.contains("+faststart"));
        let exact = joined(&trim_args(&i, &o, 55.0, 70.5, true, VideoEncoder::Nvenc));
        assert!(exact.contains("-c:v h264_nvenc"));
        assert!(exact.contains("-c:a aac"));
        assert!(!exact.contains("-c copy"));
    }

    #[test]
    fn discord_copies_shrink_with_length_and_refuse_when_too_long() {
        let (short_kbps, short_h) = discord_plan(15.0).unwrap();
        let (long_kbps, long_h) = discord_plan(90.0).unwrap();
        assert!(short_h >= long_h && short_kbps > long_kbps);
        // Whatever it picks fits: video + sound over the clip stays under the limit.
        for d in [5.0, 15.0, 30.0, 60.0, 90.0] {
            let (k, _) = discord_plan(d).unwrap();
            let bytes = f64::from(k + DISCORD_AUDIO_KBPS) * 1000.0 / 8.0 * d;
            assert!(bytes < DISCORD_LIMIT_BYTES as f64, "{d} s -> {bytes} bytes");
        }
        assert!(discord_plan(600.0).is_none());
        assert!(discord_max_seconds() >= 120, "two minutes fit at 480p");
    }
}
