// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `crosspov --audio-helper <pid>`: a short-lived copy of the app that only
    // records one program's sound for the main app (see audio.rs). Runs
    // before anything else, so it never opens a window or a second app.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--audio-helper") {
        let pid = args.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
        std::process::exit(crosspov_lib::audio_helper(pid));
    }
    // `crosspov --restore-game-settings`: run by the uninstaller.
    if args.get(1).map(String::as_str) == Some("--restore-game-settings") {
        crosspov_lib::restore_game_settings();
        return;
    }
    crosspov_lib::run()
}
