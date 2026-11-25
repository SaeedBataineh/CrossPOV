use sha2::{Digest, Sha256};

/// The single-exe build downloads FFmpeg and yt-dlp on first run (tools.rs) and
/// only accepts the exact files in src-tauri/binaries: their SHA-256 is compiled in.
fn main() {
    for (var, file) in [
        ("CROSSPOV_FFMPEG_SHA256", "binaries/ffmpeg-x86_64-pc-windows-msvc.exe"),
        ("CROSSPOV_YTDLP_SHA256", "binaries/yt-dlp-x86_64-pc-windows-msvc.exe"),
    ] {
        println!("cargo:rerun-if-changed={file}");
        let hash = if std::env::var_os("CARGO_FEATURE_SINGLE_EXE").is_some() {
            let bytes = std::fs::read(file).unwrap_or_else(|e| panic!("single-exe build needs {file} ({e}); run scripts/get-ffmpeg.ps1 and scripts/get-ytdlp.ps1"));
            Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect()
        } else {
            String::new()
        };
        println!("cargo:rustc-env={var}={hash}");
    }
    tauri_build::build()
}
