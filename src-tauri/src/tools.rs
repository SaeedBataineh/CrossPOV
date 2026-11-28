//! FFmpeg and yt-dlp for the single CrossPOV.exe (`--features single-exe`).
//!
//! They are not packed inside the exe (that made every update ~38 MB). The
//! app downloads them once from the "tools" release on GitHub, checks each
//! file against the SHA-256 fingerprint compiled into the app (build.rs), and
//! keeps them in `%LOCALAPPDATA%\app.crosspov.desktop\tools\<tool>\<hash>\`
//! between app versions. A file that doesn't match its fingerprint is never
//! run. A new app version that ships the same tools downloads nothing.
//!
//! Builds without the feature (development, the installer) use nothing here
//! and find the tools next to the exe or on PATH.

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use sha2::{Digest, Sha256};

/// Where the tools are downloaded from: `<BASE_URL>/<stem>-<first 16 of hash>.exe`.
pub const BASE_URL: &str = "https://github.com/SaeedBataineh/CrossPOV/releases/download/tools";
/// The same files through crosspov.com, which keeps a copy near each user
/// (usually much faster than GitHub). Every file is checked against its
/// hash, so where it came from doesn't matter; GitHub is the backup.
pub const MIRROR_URL: &str = "https://crosspov.com/files/tools";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tool {
    /// File name the rest of the app asks for, e.g. "ffmpeg.exe".
    pub name: &'static str,
    /// Lower-case hex SHA-256 of the exact file this app version expects.
    pub sha256: &'static str,
}

impl Tool {
    /// "ffmpeg" of "ffmpeg.exe", "obs-slim" of "obs-slim.zip".
    fn stem(&self) -> &'static str {
        self.name.rsplit_once('.').map_or(self.name, |(stem, _)| stem)
    }

    /// ".exe", ".zip".
    fn ext(&self) -> &'static str {
        self.name.rfind('.').map_or("", |i| &self.name[i..])
    }

    fn short(&self) -> &'static str {
        &self.sha256[..16]
    }

    /// Release asset name, e.g. "ffmpeg-0123456789abcdef.exe".
    pub fn asset(&self) -> String {
        format!("{}-{}{}", self.stem(), self.short(), self.ext())
    }

    fn path(&self, root: &Path) -> PathBuf {
        root.join(self.stem()).join(self.short()).join(self.name)
    }
}

#[cfg(feature = "single-exe")]
const TOOLS: &[Tool] = &[
    Tool { name: "ffmpeg.exe", sha256: env!("CROSSPOV_FFMPEG_SHA256") },
    Tool { name: "yt-dlp.exe", sha256: env!("CROSSPOV_YTDLP_SHA256") },
];
#[cfg(not(feature = "single-exe"))]
const TOOLS: &[Tool] = &[];

/// The slim OBS Studio that records games (scripts/make-slim-obs.py): a zip,
/// unpacked next to itself once checked. Downloaded on its own, after the
/// tools above, so recording never waits for it.
#[cfg(feature = "single-exe")]
const OBS: Option<Tool> = Some(Tool { name: "obs-slim.zip", sha256: env!("CROSSPOV_OBS_SHA256") });
#[cfg(not(feature = "single-exe"))]
const OBS: Option<Tool> = None;

/// True in the single-exe build (the tools are downloaded, and the exe updates itself).
pub const EMBEDDED: bool = cfg!(feature = "single-exe");

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// `base` is the app's local data folder. Call once at startup.
pub fn init(base: &Path) {
    let _ = ROOT.set(base.join("tools"));
}

fn root() -> Option<&'static Path> {
    ROOT.get().map(PathBuf::as_path)
}

/// Path of a ready tool, e.g. "ffmpeg.exe". None until it's downloaded, and always None without the feature.
pub fn get(name: &str) -> Option<PathBuf> {
    let root = root()?;
    TOOLS.iter().find(|t| t.name == name).map(|t| t.path(root)).filter(|p| p.is_file())
}

/// The recorder's folder (holding bin\64bit\crosspov-recorder.exe and OBS's
/// engine), once downloaded,
/// checked and unpacked. None until then, and always without the feature.
pub fn obs_dir() -> Option<PathBuf> {
    let (tool, root) = (OBS?, root()?);
    let dir = obs_unpacked(&tool, root);
    (dir.join(UNPACKED).is_file() && dir.join("bin").join("64bit").join("crosspov-recorder.exe").is_file()).then_some(dir)
}

/// Marks a complete unpack (an interrupted one is unpacked again).
const UNPACKED: &str = "crosspov-unpacked";

fn obs_unpacked(tool: &Tool, root: &Path) -> PathBuf {
    tool.path(root).with_file_name("obs")
}

/// Gets the slim OBS ready: downloads and checks it if needed (from
/// crosspov.com, else GitHub), then unpacks it. Ok(true) if it's ready.
pub fn prepare_obs() -> Result<bool, String> {
    let (Some(tool), Some(root)) = (OBS, root()) else { return Ok(false) };
    if obs_dir().is_some() {
        return Ok(true);
    }
    let agent = agent();
    let list = [tool];
    if !missing_in(&list, Some(root)).is_empty() {
        download_in(&list, root, MIRROR_URL, &agent, &mut |_, _| {}).or_else(|e| {
            eprintln!("OBS from crosspov.com failed ({e}), trying GitHub");
            download_in(&list, root, BASE_URL, &agent, &mut |_, _| {})
        })?;
    }
    unpack(&tool.path(root), &obs_unpacked(&tool, root))?;
    Ok(obs_dir().is_some())
}

/// Unpacks `zip` into `dir` with Windows' own tar (Windows 10 1803 and later).
fn unpack(zip: &Path, dir: &Path) -> Result<(), String> {
    use crate::ffmpeg::NoWindow;
    let _ = fs::remove_dir_all(dir);
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let out = std::process::Command::new("tar")
        .arg("-xf")
        .arg(zip)
        .arg("-C")
        .arg(dir)
        .no_window()
        .output()
        .map_err(|e| format!("Couldn't unpack OBS: {e}"))?;
    if !out.status.success() {
        return Err(format!("Couldn't unpack OBS: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    fs::write(dir.join(UNPACKED), b"").map_err(|e| e.to_string())
}

/// Folders the tools run from (so an update can stop them first).
/// Where every downloaded slim OBS lives (one folder per version), if known.
pub fn obs_root() -> Option<PathBuf> {
    root().map(|r| r.join("obs-slim"))
}

/// Where every downloaded FFmpeg lives (one folder per version), if known.
pub fn ffmpeg_root() -> Option<PathBuf> {
    root().map(|r| r.join("ffmpeg"))
}

pub fn dirs() -> Vec<PathBuf> {
    let Some(root) = root() else { return Vec::new() };
    TOOLS.iter().filter_map(|t| t.path(root).parent().map(Path::to_path_buf)).collect()
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Tools not on disk yet, or whose file doesn't match its fingerprint.
pub fn missing() -> Vec<Tool> {
    missing_in(TOOLS, root())
}

fn missing_in(tools: &[Tool], root: Option<&Path>) -> Vec<Tool> {
    let Some(root) = root else { return tools.to_vec() };
    tools.iter().copied().filter(|t| !verified(t, root)).collect()
}

/// "size modified-time" of a file, to notice if it changed since it was checked.
fn stamp(path: &Path) -> Option<String> {
    let m = fs::metadata(path).ok()?;
    let modified = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{} {modified}", m.len()))
}

/// Is the tool on disk and the exact expected file? The full fingerprint (reading
/// ~30 MB) is checked once; after that a small note of the file's size and
/// modified time stands in for it until the file changes.
fn verified(t: &Tool, root: &Path) -> bool {
    let path = t.path(root);
    let note = path.with_file_name(format!("{}.checked", t.name));
    let Some(now) = stamp(&path) else { return false };
    if fs::read_to_string(&note).ok().as_deref() == Some(now.as_str()) {
        return true;
    }
    if sha256_file(&path).as_deref() == Some(t.sha256) {
        let _ = fs::write(&note, &now);
        return true;
    }
    let _ = fs::remove_file(&note);
    false
}

/// Download progress, in bytes over all missing tools.
pub type Progress<'a> = &'a mut dyn FnMut(u64, u64);

/// Downloads every missing tool from `base_url`, checks it, and only then puts it in place.
/// Then removes other versions of the tools.
pub fn download(progress: Progress) -> Result<(), String> {
    let root = root().ok_or("tools folder not set")?;
    let agent = agent();
    download_in(TOOLS, root, MIRROR_URL, &agent, progress).or_else(|e| {
        eprintln!("tools from crosspov.com failed ({e}), trying GitHub");
        download_in(TOOLS, root, BASE_URL, &agent, progress)
    })
}

fn download_in(tools: &[Tool], root: &Path, base_url: &str, agent: &ureq::Agent, progress: Progress) -> Result<(), String> {
    let todo = missing_in(tools, Some(root));
    // Sizes first, for one progress bar over everything.
    let mut total = 0u64;
    let mut done = 0u64;
    for tool in &todo {
        let url = format!("{base_url}/{}", tool.asset());
        let res = agent.get(&url).call().map_err(|e| format!("Couldn't download {}. Check your internet connection. ({e})", tool.name))?;
        if res.status() != 200 {
            return Err(format!("Couldn't download {} (the server answered {}).", tool.name, res.status()));
        }
        total += res.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
        let path = tool.path(root);
        let dir = path.parent().ok_or("bad tool path")?;
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        let part = dir.join(format!("{}.part", tool.name));
        let mut out = fs::File::create(&part).map_err(|e| format!("Couldn't save {}: {e}", tool.name))?;
        let mut body = res.into_body().into_reader();
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = body.read(&mut buf).map_err(|e| format!("Download of {} was interrupted: {e}", tool.name))?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| format!("Couldn't save {}: {e}", tool.name))?;
            done += n as u64;
            progress(done, total.max(done));
        }
        drop(out);
        if hex(&h.finalize()) != tool.sha256 {
            let _ = fs::remove_file(&part);
            return Err(format!("The downloaded {} didn't match the expected file, so it wasn't used.", tool.name));
        }
        // Rename into place only once it's complete and checked.
        let _ = fs::remove_file(&path);
        fs::rename(&part, &path).map_err(|e| format!("Couldn't save {}: {e}", tool.name))?;
        if let Some(now) = stamp(&path) {
            let _ = fs::write(path.with_file_name(format!("{}.checked", tool.name)), now);
        }
    }
    remove_old(tools, root);
    Ok(())
}

/// Deletes other versions of each tool (best effort: one may still be running).
fn remove_old(tools: &[Tool], root: &Path) {
    for tool in tools {
        let Ok(entries) = fs::read_dir(root.join(tool.stem())) else { continue };
        for e in entries.flatten() {
            if e.file_name().to_string_lossy() != tool.short() {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    // Folders of the old builds that packed the tools inside the exe (tools\0.1.x).
    if let Ok(entries) = fs::read_dir(root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(|c: char| c.is_ascii_digit()) {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
}

/// Like the app's other HTTPS clients (Windows' own TLS), with time for a slow connection.
fn agent() -> ureq::Agent {
    crate::net::agent(
        ureq::Agent::config_builder()
            .tls_config(crate::net::tls())
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_body(Some(Duration::from_secs(60)))
            .http_status_as_error(false)
            .user_agent(crate::USER_AGENT)
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// A tiny HTTP server that serves `files` (path -> body) for `n` requests.
    fn serve(files: Vec<(String, Vec<u8>)>, n: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(n) {
                let mut s = stream.unwrap();
                let mut req = [0u8; 2048];
                let got = s.read(&mut req).unwrap();
                let line = String::from_utf8_lossy(&req[..got]);
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                match files.iter().find(|(p, _)| *p == path) {
                    Some((_, body)) => {
                        let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = s.write_all(head.as_bytes());
                        let _ = s.write_all(body);
                    }
                    None => {
                        let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
            }
        });
        format!("http://{addr}")
    }

    fn plain_agent() -> ureq::Agent {
        ureq::Agent::config_builder().http_status_as_error(false).build().into()
    }

    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("crosspov-tools-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn downloads_checks_and_keeps_tools_between_versions() {
        let body = b"pretend ffmpeg".repeat(5000);
        let hash: &'static str = Box::leak(sha(&body).into_boxed_str());
        let tool = Tool { name: "ffmpeg.exe", sha256: hash };
        let root = temp_root("ok");
        // Leftovers of an older version and of the old packed-in tools.
        fs::create_dir_all(root.join("ffmpeg").join("0000000000000000")).unwrap();
        fs::create_dir_all(root.join("0.1.4")).unwrap();
        let base = serve(vec![(format!("/{}", tool.asset()), body.clone())], 1);
        let mut seen = (0, 0);
        download_in(&[tool], &root, &base, &plain_agent(), &mut |d, t| seen = (d, t)).unwrap();
        assert_eq!(fs::read(tool.path(&root)).unwrap(), body);
        assert_eq!(seen, (body.len() as u64, body.len() as u64), "progress reaches the end");
        assert!(missing_in(&[tool], Some(&root)).is_empty());
        assert!(tool.path(&root).with_file_name("ffmpeg.exe.checked").exists(), "checked once, noted");
        // Changing the file (another size) is noticed despite the note.
        fs::write(tool.path(&root), b"swapped").unwrap();
        assert_eq!(missing_in(&[tool], Some(&root)), vec![tool]);
        fs::write(tool.path(&root), &body).unwrap();
        assert!(missing_in(&[tool], Some(&root)).is_empty(), "the right file again: fine");
        assert!(!root.join("ffmpeg").join("0000000000000000").exists(), "old version removed");
        assert!(!root.join("0.1.4").exists(), "old packed-in tools removed");
        // Already there: nothing is downloaded (the server would refuse a second request).
        download_in(&[tool], &root, "http://127.0.0.1:9", &plain_agent(), &mut |_, _| {}).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_file_that_doesnt_match_is_never_used() {
        let tool = Tool { name: "yt-dlp.exe", sha256: "00000000000000000000000000000000000000000000000000000000000000ff" };
        let root = temp_root("bad");
        let base = serve(vec![(format!("/{}", tool.asset()), b"something else".to_vec())], 1);
        let err = download_in(&[tool], &root, &base, &plain_agent(), &mut |_, _| {}).unwrap_err();
        assert!(err.contains("didn't match"), "{err}");
        assert!(!tool.path(&root).exists());
        assert!(!tool.path(&root).with_file_name("yt-dlp.exe.part").exists(), "partial file cleaned up");
        // A tampered file on disk counts as missing.
        fs::create_dir_all(tool.path(&root).parent().unwrap()).unwrap();
        fs::write(tool.path(&root), b"tampered").unwrap();
        assert_eq!(missing_in(&[tool], Some(&root)), vec![tool]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_file_on_the_server_is_a_clear_error() {
        let tool = Tool { name: "ffmpeg.exe", sha256: "1111111111111111111111111111111111111111111111111111111111111111" };
        let root = temp_root("404");
        let base = serve(vec![], 1);
        let err = download_in(&[tool], &root, &base, &plain_agent(), &mut |_, _| {}).unwrap_err();
        assert!(err.contains("404"), "{err}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn asset_names_carry_the_fingerprint() {
        let t = Tool { name: "yt-dlp.exe", sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" };
        assert_eq!(t.asset(), "yt-dlp-abcdef0123456789.exe");
        assert_eq!(t.path(Path::new("R")), Path::new("R").join("yt-dlp").join("abcdef0123456789").join("yt-dlp.exe"));
        let obs = Tool { name: "obs-slim.zip", ..t };
        assert_eq!(obs.asset(), "obs-slim-abcdef0123456789.zip");
        assert_eq!(obs.path(Path::new("R")), Path::new("R").join("obs-slim").join("abcdef0123456789").join("obs-slim.zip"));
    }
}
