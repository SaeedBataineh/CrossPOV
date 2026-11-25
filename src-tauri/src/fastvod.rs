//! Faster streamer clips.
//!
//! A VOD is an HLS playlist of short chunks (about 10 s each on Twitch).
//! yt-dlp is asked once per VOD for the playlist address; then only the
//! chunks a clip needs are downloaded, several at a time, joined, and cut to
//! the exact seconds with FFmpeg (no re-encoding). If anything here fails the
//! caller falls back to yt-dlp's own (slower, one chunk at a time) download.

use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    thread,
};

use crate::ffmpeg::NoWindow as _;

/// Chunks downloaded at the same time.
const PARALLEL: usize = 6;
/// Largest chunk accepted (a 10 s source-quality chunk is a few MB).
const MAX_CHUNK: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// Seconds from the start of the VOD.
    pub start: f64,
    pub duration: f64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Playlist {
    /// fMP4 playlists start every chunk with this header (EXT-X-MAP).
    pub init: Option<String>,
    pub segments: Vec<Segment>,
}

/// `base` is the playlist's own address; chunk names in it are relative to it.
pub fn resolve(base: &str, uri: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return uri.to_string();
    }
    let no_query = base.split(['?', '#']).next().unwrap_or(base);
    if let Some(rest) = uri.strip_prefix('/') {
        // Root-relative: keep scheme and host.
        let host_end = no_query.find("://").map(|i| i + 3).and_then(|i| no_query[i..].find('/').map(|j| i + j)).unwrap_or(no_query.len());
        return format!("{}/{}", &no_query[..host_end], rest);
    }
    let dir = &no_query[..no_query.rfind('/').map(|i| i + 1).unwrap_or(0)];
    format!("{dir}{uri}")
}

/// Reads an HLS media playlist.
pub fn parse(text: &str, base: &str) -> Playlist {
    let mut out = Playlist::default();
    let mut t = 0.0;
    let mut next_duration: Option<f64> = None;
    for line in text.lines().map(str::trim) {
        if let Some(v) = line.strip_prefix("#EXTINF:") {
            next_duration = v.split(',').next().and_then(|d| d.trim().parse().ok());
        } else if let Some(v) = line.strip_prefix("#EXT-X-MAP:") {
            if let Some(uri) = v.split("URI=\"").nth(1).and_then(|r| r.split('"').next()) {
                out.init = Some(resolve(base, uri));
            }
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some(d) = next_duration.take() {
                out.segments.push(Segment { start: t, duration: d, url: resolve(base, line) });
                t += d;
            }
        }
    }
    out
}

/// The chunks that cover [from, to] seconds of the VOD.
pub fn covering(p: &Playlist, from: f64, to: f64) -> &[Segment] {
    let first = p.segments.iter().position(|s| s.start + s.duration > from).unwrap_or(p.segments.len());
    let last = p.segments.iter().rposition(|s| s.start < to).map(|i| i + 1).unwrap_or(0);
    if first >= last {
        &[]
    } else {
        &p.segments[first..last]
    }
}

/// The address of the VOD's chunk playlist at the chosen quality, from yt-dlp.
pub fn playlist_url(ytdlp: &Path, vod_url: &str, format: &str) -> Result<String, String> {
    let out = Command::new(ytdlp)
        .args(["--no-warnings", "-q", "--no-playlist", "-g", "-f", format, "--", vod_url])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .output()
        .map_err(|e| format!("couldn't run yt-dlp: {e}"))?;
    let url = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
    if out.status.success() && url.starts_with("https://") {
        Ok(url)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(400).collect())
    }
}

fn get(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, String> {
    let mut res = agent.get(url).call().map_err(|e| e.to_string())?;
    if res.status().as_u16() != 200 {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.body_mut().with_config().limit(MAX_CHUNK).read_to_vec().map_err(|e| e.to_string())
}

type Download = Result<Vec<u8>, String>;

/// Downloads `urls` several at a time; results in the same order.
fn get_all(agent: &ureq::Agent, urls: &[String]) -> Result<Vec<Vec<u8>>, String> {
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Download>>> = Mutex::new(vec![None; urls.len()]);
    thread::scope(|scope| {
        for _ in 0..PARALLEL.min(urls.len()) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= urls.len() {
                    break;
                }
                // One retry: a chunk now and then times out on a busy CDN.
                let r = get(agent, &urls[i]).or_else(|_| get(agent, &urls[i]));
                results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
            });
        }
    });
    results.into_inner().unwrap_or_else(|e| e.into_inner()).into_iter().map(|r| r.unwrap_or_else(|| Err("not downloaded".into()))).collect()
}

/// Downloads seconds [from, to] of the stream whose chunk playlist is at
/// `playlist` into `out` (an .mp4), cut exactly with FFmpeg.
pub fn fetch_clip(agent: &ureq::Agent, playlist: &str, from: f64, to: f64, ffmpeg: &Path, out: &Path) -> Result<(), String> {
    let text = String::from_utf8(get(agent, playlist)?).map_err(|_| "playlist isn't text".to_string())?;
    let p = parse(&text, playlist);
    let chunks = covering(&p, from, to);
    if chunks.is_empty() {
        return Err("those seconds aren't in the VOD yet".into());
    }
    let first_start = chunks[0].start;
    let mut urls: Vec<String> = p.init.iter().cloned().collect();
    urls.extend(chunks.iter().map(|s| s.url.clone()));
    let parts = get_all(agent, &urls)?;

    // MPEG-TS chunks (and fMP4 chunks after their header) can simply be joined.
    let joined = out.with_extension(if p.init.is_some() { "part.mp4" } else { "part.ts" });
    fs::write(&joined, parts.concat()).map_err(|e| format!("couldn't write the download: {e}"))?;
    let result = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss"])
        .arg(format!("{:.3}", (from - first_start).max(0.0)))
        .arg("-i")
        .arg(&joined)
        .arg("-t")
        .arg(format!("{:.3}", to - from))
        .args(["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart"])
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .no_window()
        .output();
    let _ = fs::remove_file(&joined);
    let result = result.map_err(|e| format!("couldn't run FFmpeg: {e}"))?;
    if result.status.success() && fs::metadata(out).is_ok_and(|m| m.len() > 0) {
        Ok(())
    } else {
        let _ = fs::remove_file(out);
        Err(String::from_utf8_lossy(&result.stderr).trim().chars().take(300).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PL: &str = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.000,\n0.ts\n#EXTINF:10.000,\n1-muted.ts\n#EXTINF:10.000,\n2.ts\n#EXTINF:4.5,\n3.ts\n#EXT-X-ENDLIST\n";

    #[test]
    fn reads_a_twitch_style_playlist() {
        let p = parse(PL, "https://cdn.example/abc/chunked/index-dvr.m3u8?token=1");
        assert_eq!(p.segments.len(), 4);
        assert_eq!(p.segments[1].url, "https://cdn.example/abc/chunked/1-muted.ts");
        assert_eq!(p.segments[3].start, 30.0);
        assert!(p.init.is_none());
    }

    #[test]
    fn picks_only_the_chunks_a_clip_needs() {
        let p = parse(PL, "https://cdn.example/x/index.m3u8");
        let c = covering(&p, 12.0, 25.0);
        assert_eq!(c.iter().map(|s| s.start).collect::<Vec<_>>(), vec![10.0, 20.0]);
        assert_eq!(covering(&p, 0.0, 10.0).len(), 1, "exactly the first chunk");
        assert!(covering(&p, 40.0, 50.0).is_empty(), "past the end");
    }

    /// Tiny grey picture of the frame at `t` seconds, for comparing two videos.
    fn frame(ff: &Path, input: &str, t: f64) -> Vec<u8> {
        let out = Command::new(ff)
            .args(["-v", "error", "-ss", &format!("{t:.2}"), "-i", input, "-frames:v", "1", "-s", "64x36", "-pix_fmt", "gray", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        out.stdout
    }

    /// Real download with yt-dlp + FFmpeg from the HLS stream in CROSSPOV_TEST_HLS:
    /// the clip must be the requested 10 s and start at the requested second.
    #[test]
    fn fast_download_cuts_the_right_seconds() {
        let Ok(url) = std::env::var("CROSSPOV_TEST_HLS") else { return };
        let (ytdlp, ff) = (crate::streamers::locate_ytdlp().expect("yt-dlp"), crate::ffmpeg::locate().expect("ffmpeg"));
        let pl = playlist_url(&ytdlp, &url, "best").expect("playlist");
        let out = std::env::temp_dir().join(format!("crosspov-fast-{}.mp4", std::process::id()));
        let started = std::time::Instant::now();
        fetch_clip(&crate::streamers::test_agent(), &pl, 20.0, 30.0, &ff, &out).expect("download");
        eprintln!("fast download took {:?}", started.elapsed());
        let probe = Command::new(&ff).args(["-hide_banner", "-i"]).arg(&out).output().unwrap();
        let info = String::from_utf8_lossy(&probe.stderr);
        let dur = info.lines().find(|l| l.contains("Duration:")).unwrap_or("").to_string();
        assert!(dur.contains("00:00:10") || dur.contains("00:00:09") || dur.contains("00:00:11"), "{dur}");
        // The clip's frame 2 s in should be the stream's frame at 22 s, not some other moment.
        let a = frame(&ff, &out.to_string_lossy(), 2.0);
        let near = frame(&ff, &pl, 22.0);
        let far = frame(&ff, &pl, 12.0);
        let diff = |x: &[u8], y: &[u8]| x.iter().zip(y).map(|(p, q)| (i32::from(*p) - i32::from(*q)).abs()).sum::<i32>() / x.len().max(1) as i32;
        assert!(!a.is_empty() && a.len() == near.len());
        assert!(diff(&a, &near) < diff(&a, &far).max(1), "clip starts at the requested second ({} vs {})", diff(&a, &near), diff(&a, &far));
        let _ = fs::remove_file(out);
    }

    #[test]
    fn resolves_chunk_addresses() {
        assert_eq!(resolve("https://h.test/a/b/p.m3u8", "c.ts"), "https://h.test/a/b/c.ts");
        assert_eq!(resolve("https://h.test/a/b/p.m3u8", "/root/c.ts"), "https://h.test/root/c.ts");
        assert_eq!(resolve("https://h.test/a/p.m3u8", "https://o.test/c.ts"), "https://o.test/c.ts");
        let p = parse("#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\nseg1.m4s\n", "https://h.test/v/p.m3u8");
        assert_eq!(p.init.as_deref(), Some("https://h.test/v/init.mp4"));
    }
}
