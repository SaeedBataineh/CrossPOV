//! Plays clips in the app's player from a small web server on this PC
//! (127.0.0.1 only, behind a random key). Tauri's asset links hand the
//! player a file in small pieces, each copied whole through the webview:
//! too slow for 50 Mbps clips, which stuttered while VLC played them fine.
//! Here the player gets the file straight from disk, any part it asks for.

use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

struct Server {
    port: u16,
    key: String,
    /// Files the player may load, by number (only clips the app chose to play).
    files: Mutex<HashMap<u64, PathBuf>>,
}

fn server() -> Option<&'static Server> {
    static S: OnceLock<Option<Server>> = OnceLock::new();
    S.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").ok()?;
        let port = listener.local_addr().ok()?.port();
        let key = crate::obs::random_hex(16);
        thread::Builder::new()
            .name("clip-server".into())
            .spawn(move || {
                for conn in listener.incoming().flatten() {
                    let _ = thread::Builder::new().name("clip-serve".into()).spawn(move || serve(conn));
                }
            })
            .ok()?;
        Some(Server { port, key, files: Mutex::new(HashMap::new()) })
    })
    .as_ref()
}

/// A link the app's player can load `path` from, or None if the server
/// couldn't start (then the asset link is used).
pub fn url_for(path: PathBuf) -> Option<String> {
    let s = server()?;
    let mut files = s.files.lock().unwrap_or_else(|e| e.into_inner());
    let id = match files.iter().find(|(_, p)| **p == path) {
        Some((id, _)) => *id,
        None => {
            let id = files.len() as u64 + 1;
            files.insert(id, path);
            id
        }
    };
    Some(format!("http://127.0.0.1:{}/{}/{id}.mp4", s.port, s.key))
}

/// One connection: requests one after another (the player reuses it).
fn serve(conn: TcpStream) {
    if let Ok(out) = conn.try_clone() {
        serve_requests(conn);
        // Close gently (Windows otherwise cuts the connection, losing what's unsent).
        let _ = out.shutdown(std::net::Shutdown::Write);
    }
}

fn serve_requests(conn: TcpStream) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(60)));
    let Ok(mut out) = conn.try_clone() else { return };
    let mut reader = BufReader::new(conn);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut range = None;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).unwrap_or(0) == 0 {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((name, value)) = h.split_once(':') {
                if name.eq_ignore_ascii_case("range") {
                    range = Some(value.trim().to_string());
                }
            }
        }
        let mut parts = line.split_whitespace();
        let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if respond(&mut out, method, target, range.as_deref()).is_err() {
            return;
        }
    }
}

fn respond(out: &mut TcpStream, method: &str, target: &str, range: Option<&str>) -> std::io::Result<()> {
    let file = file_for(target).filter(|_| method == "GET" || method == "HEAD");
    let Some(mut f) = file.and_then(|p| File::open(p).ok()) else {
        return out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    };
    let len = f.metadata()?.len();
    let Some((start, end)) = byte_range(range, len) else {
        return out.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\n\r\n").as_bytes());
    };
    let count = end + 1 - start;
    let status = if range.is_some() { "206 Partial Content" } else { "200 OK" };
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: {count}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\n"
    );
    if range.is_some() {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())?;
    if method == "HEAD" {
        return Ok(());
    }
    f.seek(SeekFrom::Start(start))?;
    std::io::copy(&mut f.take(count), out)?;
    out.flush()
}

/// The clip a request is for: "/<key>/<n>.mp4", only files handed out by `url_for`.
fn file_for(target: &str) -> Option<PathBuf> {
    let s = server()?;
    let path = target.split('?').next()?;
    let rest = path.strip_prefix('/')?.strip_prefix(s.key.as_str())?.strip_prefix('/')?;
    let id: u64 = rest.strip_suffix(".mp4")?.parse().ok()?;
    s.files.lock().unwrap_or_else(|e| e.into_inner()).get(&id).cloned()
}

/// First and last byte for a "Range: bytes=a-b" header (the whole file without one).
fn byte_range(range: Option<&str>, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let Some(r) = range else { return Some((0, len - 1)) };
    let spec = r.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (a, "") => (a.parse().ok()?, len - 1),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_byte_ranges() {
        assert_eq!(byte_range(None, 100), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=0-"), 100), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(byte_range(Some("bytes=90-500"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=200-"), 100), None);
    }

    #[test]
    fn serves_a_clip_by_its_link_only() {
        let dir = std::env::temp_dir().join(format!("crosspov-serve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("a.mp4");
        std::fs::write(&clip, b"0123456789").unwrap();
        let url = url_for(clip).unwrap();
        let get = |path: &str, range: &str| -> String {
            let addr = url.trim_start_matches("http://").split('/').next().unwrap().to_string();
            let mut c = TcpStream::connect(addr).unwrap();
            write!(c, "GET {path} HTTP/1.1\r\nHost: x\r\n{range}Connection: close\r\n\r\n").unwrap();
            c.shutdown(std::net::Shutdown::Write).unwrap();
            // Everything until the server closes (an abrupt close at the end is fine).
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match c.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => got.extend_from_slice(&buf[..n]),
                    Err(e) if !got.is_empty() => {
                        let _ = e;
                        break;
                    }
                    Err(e) => panic!("{e}"),
                }
            }
            String::from_utf8_lossy(&got).into_owned()
        };
        let path = format!("/{}", url.splitn(4, '/').nth(3).unwrap());
        let part = get(&path, "Range: bytes=2-4\r\n");
        assert!(part.starts_with("HTTP/1.1 206"), "{part}");
        assert!(part.contains("Content-Range: bytes 2-4/10") && part.ends_with("234"), "{part}");
        assert!(get("/wrong-key/1.mp4", "").starts_with("HTTP/1.1 404"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
