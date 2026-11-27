// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `crosspov --restore-game-settings`: run by the uninstaller.
    if args.get(1).map(String::as_str) == Some("--restore-game-settings") {
        crosspov_lib::restore_game_settings();
        return;
    }
    crosspov_lib::run()
}
