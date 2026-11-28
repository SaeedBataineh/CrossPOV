// CrossPOV Recorder: records games with OBS Studio's libobs.
// Copyright (C) 2026 CrossPOV
//
// This program is free software; you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation; either version 2 of the License, or (at your option)
// any later version. See LICENSE.

//! A recorder with no windows: OBS Studio's engine (libobs) and its own
//! plugins, set up the way CrossPOV records (a replay buffer of the game),
//! taking orders from CrossPOV over 127.0.0.1. Runs from OBS's bin/64bit.

#![cfg_attr(windows, windows_subsystem = "windows")]

mod libobs;
mod rec;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;

use serde_json::{json, Value};

/// `--selftest <dir>`: records the screen for 8 s with the CPU encoder,
/// saves the replay into `dir` and checks the file (for the build machine,
/// which has no game and maybe no graphics card).
fn selftest(dir: &str) -> i32 {
    let mut rec = match rec::Recorder::start(&format!("{dir}/config")) {
        Ok(r) => r,
        Err(e) => {
            println!("selftest: couldn't start: {e}");
            return 1;
        }
    };
    let steps = [
        json!({ "op": "setup", "profile": { "encoder": "obs_x264", "kbps": 4000, "buffer_seconds": 20, "format": "mp4", "separate_tracks": true, "replay_dir": dir, "session_dir": format!("{dir}/session") } }),
        json!({ "op": "apply", "title": "", "capture": {
            "source": { "Screen": { "origin": [0, 0], "game": null } }, "size": [1280, 720], "out_size": [1280, 720], "fps": 30,
            "game_audio": 1.0, "desktop_audio": true, "apps": [], "mic": 1.0, "mic_device": "default", "denoise_mic": true, "separate_tracks": true
        } }),
    ];
    for step in &steps {
        if let Err(e) = rec.handle(step) {
            println!("selftest: {} failed: {e}", step["op"]);
            rec.stop();
            return 1;
        }
    }
    std::thread::sleep(std::time::Duration::from_secs(8));
    let stats = rec.handle(&json!({ "op": "stats" })).map(|v| v["text"].to_string()).unwrap_or_default();
    let saved = rec.handle(&json!({ "op": "save" }));
    let code = match saved {
        Ok(v) => {
            let path = v["path"].as_str().unwrap_or("").to_string();
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            println!("selftest: saved {path} ({size} bytes), {stats}");
            if size > 10_000 { 0 } else { 1 }
        }
        Err(e) => {
            println!("selftest: save failed: {e} ({stats})");
            1
        }
    };
    // Shutting down cleanly is part of the test (CrossPOV quits it this way).
    rec.stop();
    println!("selftest: stopped cleanly");
    // The session recording wrote its piece.
    let pieces: Vec<u64> = std::fs::read_dir(format!("{dir}/session")).map(|it| it.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).collect()).unwrap_or_default();
    println!("selftest: session pieces {pieces:?}");
    if pieces.iter().any(|n| *n > 10_000) { code } else { 1 }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    if let Some(dir) = arg("--selftest") {
        std::process::exit(selftest(&dir));
    }
    let (Some(port), Some(key)) = (arg("--port"), arg("--key")) else {
        eprintln!("usage: crosspov-recorder --port <port> --key <key> [--config <dir>]");
        std::process::exit(2);
    };
    let config = arg("--config").unwrap_or_else(|| "../../config/crosspov".into());

    let conn = match TcpStream::connect(format!("127.0.0.1:{port}")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("recorder: can't reach CrossPOV: {e}");
            std::process::exit(1);
        }
    };
    let _ = conn.set_nodelay(true);
    let mut out = conn.try_clone().expect("socket clone");
    let send = |out: &mut TcpStream, v: Value| -> bool { writeln!(out, "{v}").and_then(|_| out.flush()).is_ok() };
    if !send(&mut out, json!({ "hello": key })) {
        std::process::exit(1);
    }

    let mut rec = match rec::Recorder::start(&config) {
        Ok(r) => {
            send(&mut out, json!({ "ok": true, "ready": true }));
            r
        }
        Err(e) => {
            println!("recorder: couldn't start: {e}");
            send(&mut out, json!({ "ok": false, "error": e }));
            std::process::exit(1);
        }
    };

    // One request per line, one answer per request. CrossPOV closing the
    // connection (or quitting) ends the recorder.
    for line in BufReader::new(conn).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) if req["op"] == "quit" => break,
            Ok(req) => match rec.handle(&req) {
                Ok(mut v) => {
                    v["ok"] = json!(true);
                    v
                }
                Err(e) => json!({ "ok": false, "error": e }),
            },
            Err(e) => json!({ "ok": false, "error": format!("bad request: {e}") }),
        };
        if !send(&mut out, reply) {
            break;
        }
    }
    rec.stop();
}
