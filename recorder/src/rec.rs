// CrossPOV Recorder: records games with OBS Studio's libobs.
// Copyright (C) 2026 CrossPOV
//
// This program is free software; you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation; either version 2 of the License, or (at your option)
// any later version. See LICENSE.

//! What the recorder does with libobs: one scene with the game (or the
//! screen, with the game on top), its sound, other apps' sound and the mic;
//! one video encoder, AAC per audio track, and the replay buffer.

use std::ffi::{c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::libobs::{self as lo, CallData, Obs, Ptr};

/// Encoder and replay buffer settings.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Profile {
    /// OBS's encoder id, e.g. "obs_nvenc_hevc_tex".
    pub encoder: String,
    pub kbps: u32,
    pub buffer_seconds: u32,
    /// "mp4" or "mkv".
    pub format: String,
    /// The mic on its own track (track 2).
    pub separate_tracks: bool,
    /// Where saved replays go.
    pub replay_dir: PathBuf,
    /// Also record everything into this folder, in 5-minute pieces (CrossPOV
    /// cuts auto-clips out of them once a match's data is in, then deletes
    /// them). Shares the encoders: no extra work for the graphics card.
    #[serde(default)]
    pub session_dir: Option<PathBuf>,
}

/// What to record (CrossPOV's `obs::Capture`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub enum Source {
    Game { exe: String, class: String },
    Screen { origin: (i32, i32), game: Option<(String, String)> },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Capture {
    pub source: Source,
    pub size: (u32, u32),
    pub out_size: (u32, u32),
    pub fps: u32,
    pub game_audio: Option<f32>,
    pub desktop_audio: bool,
    pub apps: Vec<(String, f32)>,
    pub mic: Option<f32>,
    pub mic_device: String,
    pub denoise_mic: bool,
    pub separate_tracks: bool,
}

/// Set by libobs (on its own thread) when a saved replay is written.
static SAVED: AtomicBool = AtomicBool::new(false);

unsafe extern "C" fn on_saved(_data: *mut c_void, _cd: *mut CallData) {
    SAVED.store(true, Ordering::SeqCst);
}

pub struct Recorder {
    o: Obs,
    scene: Ptr,
    /// Sources in the scene: (scene item, source).
    items: Vec<(Ptr, Ptr)>,
    /// Filters to release with their sources.
    filters: Vec<Ptr>,
    /// Whole screen: the game layer's scene item.
    game_item: Option<Ptr>,
    video_enc: Ptr,
    audio_encs: Vec<Ptr>,
    replay: Ptr,
    /// The pieces recording (`Profile::session_dir`), if any.
    session: Ptr,
    profile: Option<Profile>,
    capture: Option<Capture>,
}

fn c(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

fn text(p: *const std::ffi::c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        // SAFETY: libobs hands out NUL-terminated strings.
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

/// Game Capture's window string: "title:class:exe", each with ':' as "#3A".
pub fn window_spec(title: &str, class: &str, exe: &str) -> String {
    let esc = |s: &str| s.replace(':', "#3A");
    format!("{}:{}:{}", esc(title), esc(class), esc(exe))
}

/// The item whose name matches `wanted`: the same name (any case), else one
/// name containing the other. Items are (name, value).
pub fn pick_item(items: &[(String, String)], wanted: &str) -> Option<String> {
    let w = wanted.to_lowercase();
    let named = |n: &str| n.to_lowercase();
    items
        .iter()
        .find(|(n, _)| named(n) == w)
        .or_else(|| items.iter().find(|(n, _)| !n.is_empty() && (named(n).contains(&w) || w.contains(&named(n)))))
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty() && v != "default")
}

/// Track mask: track 1 is bit 0.
fn tracks(one: bool, two: bool) -> u32 {
    u32::from(one) | (u32::from(two) << 1)
}

impl Recorder {
    /// Starts libobs: graphics, sound, OBS's plugins, an empty scene, on a
    /// tiny slow canvas until there's something to record.
    pub fn start(config: &str) -> Result<Recorder, String> {
        let o = Obs::load(&PathBuf::from("obs.dll"))?;
        // SAFETY: libobs calls in the order OBS itself makes them.
        unsafe {
            let cfg = c(config);
            if !(o.obs_startup)(c("en-US").as_ptr(), cfg.as_ptr(), std::ptr::null_mut()) {
                return Err("libobs didn't start".into());
            }
            let audio = lo::AudioInfo { samples_per_sec: 48_000, speakers: lo::SPEAKERS_STEREO };
            if !(o.obs_reset_audio)(&audio) {
                return Err("libobs couldn't set up sound".into());
            }
            let mut me = Recorder {
                o,
                scene: std::ptr::null_mut(),
                items: Vec::new(),
                filters: Vec::new(),
                game_item: None,
                video_enc: std::ptr::null_mut(),
                audio_encs: Vec::new(),
                replay: std::ptr::null_mut(),
                session: std::ptr::null_mut(),
                profile: None,
                capture: None,
            };
            me.reset_video(320, 180, 320, 180, 5)?;
            (me.o.obs_load_all_modules)();
            (me.o.obs_post_load_modules)();
            me.scene = (me.o.obs_scene_create)(c("CrossPOV").as_ptr());
            (me.o.obs_set_output_source)(0, (me.o.obs_scene_get_source)(me.scene));
            Ok(me)
        }
    }

    pub fn handle(&mut self, req: &Value) -> Result<Value, String> {
        match req["op"].as_str().unwrap_or("") {
            "setup" => {
                let p: Profile = serde_json::from_value(req["profile"].clone()).map_err(|e| e.to_string())?;
                if self.profile.as_ref() != Some(&p) {
                    self.profile = Some(p);
                    // New encoder settings: record again with them.
                    if let Some(cap) = self.capture.clone() {
                        let title = req["title"].as_str().unwrap_or("").to_string();
                        self.apply(Some(cap), &title)?;
                    }
                }
                Ok(json!({}))
            }
            "apply" => {
                let cap: Option<Capture> = serde_json::from_value(req["capture"].clone()).map_err(|e| e.to_string())?;
                self.apply(cap, req["title"].as_str().unwrap_or(""))?;
                Ok(json!({}))
            }
            "save" => self.save().map(|p| json!({ "path": p })),
            "stats" => Ok(json!({ "text": self.stats() })),
            "running" => Ok(json!({ "running": self.running() })),
            "restart_buffer" => self.start_replay().map(|_| json!({})),
            "show_game" => {
                if let Some(item) = self.game_item {
                    // SAFETY: a scene item of our scene.
                    unsafe { (self.o.obs_sceneitem_set_visible)(item, req["on"].as_bool().unwrap_or(true)) };
                }
                Ok(json!({}))
            }
            other => Err(format!("unknown request {other:?}")),
        }
    }

    fn running(&self) -> bool {
        // SAFETY: our replay output, if any.
        !self.replay.is_null() && unsafe { (self.o.obs_output_active)(self.replay) }
    }

    fn reset_video(&mut self, bw: u32, bh: u32, ow: u32, oh: u32, fps: u32) -> Result<(), String> {
        let module = c("libobs-d3d11");
        let mut vi = lo::VideoInfo {
            graphics_module: module.as_ptr(),
            fps_num: fps.max(1),
            fps_den: 1,
            base_width: bw.max(2),
            base_height: bh.max(2),
            output_width: ow.max(2),
            output_height: oh.max(2),
            output_format: lo::VIDEO_FORMAT_NV12,
            adapter: 0,
            gpu_conversion: true,
            colorspace: lo::VIDEO_CS_709,
            range: lo::VIDEO_RANGE_PARTIAL,
            scale_type: lo::OBS_SCALE_BICUBIC,
        };
        // SAFETY: a filled-in obs_video_info; nothing is recording.
        let r = unsafe { (self.o.obs_reset_video)(&mut vi) };
        if r == lo::OBS_VIDEO_SUCCESS {
            Ok(())
        } else {
            Err(format!("libobs couldn't set up video ({r})"))
        }
    }

    /// Stops the replay buffer and waits until it has.
    fn stop_replay(&mut self) {
        if self.replay.is_null() {
            return;
        }
        // SAFETY: our replay output.
        unsafe { (self.o.obs_output_stop)(self.replay) };
        let until = Instant::now() + Duration::from_secs(5);
        while self.running() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Releases the encoders and the replay buffer (video settings can only
    /// change without them).
    fn drop_outputs(&mut self) {
        self.stop_replay();
        // SAFETY: stopping and releasing our own outputs and encoders.
        unsafe {
            if !self.session.is_null() {
                (self.o.obs_output_stop)(self.session);
                let until = Instant::now() + Duration::from_secs(5);
                while (self.o.obs_output_active)(self.session) && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(50));
                }
                (self.o.obs_output_release)(self.session);
                self.session = std::ptr::null_mut();
            }
            if !self.replay.is_null() {
                (self.o.obs_output_release)(self.replay);
            }
            if !self.video_enc.is_null() {
                (self.o.obs_encoder_release)(self.video_enc);
            }
            for e in self.audio_encs.drain(..) {
                (self.o.obs_encoder_release)(e);
            }
        }
        self.replay = std::ptr::null_mut();
        self.video_enc = std::ptr::null_mut();
    }

    fn drop_sources(&mut self) {
        // SAFETY: our scene items and our references to their sources and filters.
        unsafe {
            for (item, src) in self.items.drain(..) {
                (self.o.obs_sceneitem_remove)(item);
                (self.o.obs_source_release)(src);
            }
            for f in self.filters.drain(..) {
                (self.o.obs_source_release)(f);
            }
        }
        self.game_item = None;
    }

    /// Settings from JSON (strings, whole numbers, true/false).
    fn data(&self, v: &Value) -> Ptr {
        // SAFETY: a new obs_data, filled in; the caller releases it.
        unsafe {
            let d = (self.o.obs_data_create)();
            if let Some(map) = v.as_object() {
                for (k, val) in map {
                    let key = c(k);
                    match val {
                        Value::String(s) => (self.o.obs_data_set_string)(d, key.as_ptr(), c(s).as_ptr()),
                        Value::Bool(b) => (self.o.obs_data_set_bool)(d, key.as_ptr(), *b),
                        Value::Number(n) => (self.o.obs_data_set_int)(d, key.as_ptr(), n.as_i64().unwrap_or(0)),
                        _ => {}
                    }
                }
            }
            d
        }
    }

    /// Adds a source to the scene. Returns (scene item, source).
    fn add(&mut self, kind: &str, name: &str, settings: Value) -> Result<(Ptr, Ptr), String> {
        let d = self.data(&settings);
        // SAFETY: creating a source of a kind OBS's plugins provide, and adding it to our scene.
        unsafe {
            let src = (self.o.obs_source_create)(c(kind).as_ptr(), c(name).as_ptr(), d, std::ptr::null_mut());
            (self.o.obs_data_release)(d);
            if src.is_null() {
                return Err(format!("OBS couldn't make a {kind} source"));
            }
            let item = (self.o.obs_scene_add)(self.scene, src);
            self.items.push((item, src));
            Ok((item, src))
        }
    }

    fn sound(&self, src: Ptr, volume: f32, mask: u32) {
        // SAFETY: our source.
        unsafe {
            (self.o.obs_source_set_volume)(src, volume);
            (self.o.obs_source_set_audio_mixers)(src, mask);
        }
    }

    /// A list property's items (name, value), e.g. the mics or monitors.
    fn list(&self, src: Ptr, property: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        // SAFETY: the source's properties, read and destroyed here.
        unsafe {
            let props = (self.o.obs_source_properties)(src);
            if props.is_null() {
                return out;
            }
            let p = (self.o.obs_properties_get)(props, c(property).as_ptr());
            if !p.is_null() {
                for i in 0..(self.o.obs_property_list_item_count)(p) {
                    out.push((text((self.o.obs_property_list_item_name)(p, i)), text((self.o.obs_property_list_item_string)(p, i))));
                }
            }
            (self.o.obs_properties_destroy)(props);
        }
        out
    }

    fn set(&self, src: Ptr, settings: Value) {
        let d = self.data(&settings);
        // SAFETY: our source and a settings object released right after.
        unsafe {
            (self.o.obs_source_update)(src, d);
            (self.o.obs_data_release)(d);
        }
    }

    /// Records `capture` from now on, or nothing (None).
    fn apply(&mut self, capture: Option<Capture>, title: &str) -> Result<(), String> {
        self.drop_outputs();
        self.drop_sources();
        self.capture = None;
        let Some(cap) = capture else {
            // Nothing to record: a tiny slow canvas costs next to nothing.
            return self.reset_video(320, 180, 320, 180, 5);
        };
        self.reset_video(cap.size.0, cap.size.1, cap.out_size.0, cap.out_size.1, cap.fps)?;

        let game_capture = |exe: &str, class: &str| {
            json!({
                "capture_mode": "window", "window": window_spec(title, class, exe), "priority": 2,
                "anti_cheat_hook": true, "capture_cursor": false, "capture_overlays": false,
                "allow_transparency": false, "limit_framerate": false, "hook_rate": 1
            })
        };
        let game = match &cap.source {
            Source::Game { exe, class } => {
                self.add("game_capture", "Game", game_capture(exe, class))?;
                Some((exe.clone(), class.clone()))
            }
            Source::Screen { origin, game } => {
                // Display Capture (Windows 10 method) of the monitor at `origin`.
                let (_, screen) = self.add("monitor_capture", "Screen", json!({ "method": 2, "capture_cursor": false }))?;
                let at = format!("@ {},{}", origin.0, origin.1);
                if let Some((_, id)) = self.list(screen, "monitor_id").into_iter().find(|(n, _)| n.contains(&at)) {
                    self.set(screen, json!({ "method": 2, "capture_cursor": false, "monitor_id": id }));
                }
                // The game on top, filling the screen, while it's in front
                // (`show_game`): Windows can hand a full-screen game straight
                // to the monitor, past what screen capture sees.
                if let Some((exe, class)) = game {
                    let (item, _) = self.add("game_capture", "Game", game_capture(exe, class))?;
                    let bounds = lo::Vec2 { x: cap.size.0 as f32, y: cap.size.1 as f32 };
                    // SAFETY: our scene item.
                    unsafe {
                        (self.o.obs_sceneitem_set_alignment)(item, lo::OBS_ALIGN_TOP_LEFT);
                        (self.o.obs_sceneitem_set_pos)(item, &lo::Vec2 { x: 0.0, y: 0.0 });
                        (self.o.obs_sceneitem_set_bounds_type)(item, lo::OBS_BOUNDS_SCALE_INNER);
                        (self.o.obs_sceneitem_set_bounds_alignment)(item, lo::OBS_ALIGN_CENTER);
                        (self.o.obs_sceneitem_set_bounds)(item, &bounds);
                    }
                    self.game_item = Some(item);
                }
                game.clone()
            }
        };

        // Track 1: everything, or all but the mic (on track 2).
        if let Some(vol) = cap.game_audio {
            if cap.desktop_audio {
                let (_, s) = self.add("wasapi_output_capture", "Desktop sound", json!({ "device_id": "default" }))?;
                self.sound(s, vol, tracks(true, false));
            } else if let Some((exe, class)) = &game {
                let (_, s) = self.add("wasapi_process_output_capture", "Game sound", json!({ "window": window_spec(title, class, exe), "priority": 2 }))?;
                self.sound(s, vol, tracks(true, false));
            }
        }
        if !cap.desktop_audio {
            for (i, (exe, vol)) in cap.apps.iter().enumerate() {
                if let Ok((_, s)) = self.add("wasapi_process_output_capture", &format!("App sound {}", i + 1), json!({ "window": window_spec("", "", exe), "priority": 2 })) {
                    self.sound(s, *vol, tracks(true, false));
                }
            }
        }
        if let Some(vol) = cap.mic {
            let (_, mic) = self.add("wasapi_input_capture", "Mic", json!({ "device_id": "default" }))?;
            // The chosen mic by its name among those OBS lists; "default" (or
            // one that isn't connected) follows Windows' default mic.
            let wanted = cap.mic_device.trim();
            if !wanted.is_empty() && !wanted.eq_ignore_ascii_case("default") {
                match pick_item(&self.list(mic, "device_id"), wanted) {
                    Some(id) => self.set(mic, json!({ "device_id": id })),
                    None => println!("recorder: mic \"{wanted}\" isn't connected; using the default mic"),
                }
            }
            self.sound(mic, vol, tracks(!cap.separate_tracks, cap.separate_tracks));
            if cap.denoise_mic {
                let d = self.data(&json!({ "method": "rnnoise" }));
                // SAFETY: a new filter on our mic source.
                unsafe {
                    let f = (self.o.obs_source_create)(c("noise_suppress_filter_v2").as_ptr(), c("Noise suppression").as_ptr(), d, std::ptr::null_mut());
                    (self.o.obs_data_release)(d);
                    if !f.is_null() {
                        (self.o.obs_source_filter_add)(mic, f);
                        self.filters.push(f);
                    }
                }
            }
        }

        self.make_outputs()?;
        self.start_replay()?;
        self.capture = Some(cap);
        Ok(())
    }

    /// The video encoder, AAC for each track, and the replay buffer.
    fn make_outputs(&mut self) -> Result<(), String> {
        let p = self.profile.clone().ok_or("no encoder settings yet")?;
        let enc = self.data(&json!({
            "rate_control": "VBR", "bitrate": p.kbps, "max_bitrate": p.kbps * 3 / 2, "keyint_sec": 2,
            "preset2": "p5", "tune": "hq", "multipass": "disabled", "bf": 2
        }));
        let aac = self.data(&json!({ "bitrate": 160 }));
        let rb = self.data(&json!({
            "directory": p.replay_dir.to_string_lossy(), "format": "Replay %CCYY-%MM-%DD %hh-%mm-%ss",
            "extension": p.format, "allow_spaces": false, "max_time_sec": p.buffer_seconds, "max_size_mb": 0
        }));
        let _ = std::fs::create_dir_all(&p.replay_dir);
        // SAFETY: creating encoders and an output from OBS's plugins, wiring them as OBS's own output code does.
        let made = unsafe {
            let video = (self.o.obs_video_encoder_create)(c(&p.encoder).as_ptr(), c("Video").as_ptr(), enc, std::ptr::null_mut());
            let replay = (self.o.obs_output_create)(c("replay_buffer").as_ptr(), c("Replay").as_ptr(), rb, std::ptr::null_mut());
            (self.o.obs_data_release)(enc);
            (self.o.obs_data_release)(rb);
            if video.is_null() || replay.is_null() {
                (self.o.obs_data_release)(aac);
                if !video.is_null() {
                    (self.o.obs_encoder_release)(video);
                }
                if !replay.is_null() {
                    (self.o.obs_output_release)(replay);
                }
                Err(format!("OBS couldn't make the encoder {} or the replay buffer", p.encoder))
            } else {
                (self.o.obs_encoder_set_video)(video, (self.o.obs_get_video)());
                (self.o.obs_output_set_video_encoder)(replay, video);
                let n = if p.separate_tracks { 2 } else { 1 };
                for i in 0..n {
                    let a = (self.o.obs_audio_encoder_create)(c("ffmpeg_aac").as_ptr(), c(&format!("Track {}", i + 1)).as_ptr(), aac, i, std::ptr::null_mut());
                    if !a.is_null() {
                        (self.o.obs_encoder_set_audio)(a, (self.o.obs_get_audio)());
                        (self.o.obs_output_set_audio_encoder)(replay, a, i);
                        self.audio_encs.push(a);
                    }
                }
                (self.o.obs_data_release)(aac);
                if let Some(dir) = &p.session_dir {
                    let _ = std::fs::create_dir_all(dir);
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                    let first = dir.join(format!("Session {now}.mkv"));
                    let st = self.data(&json!({
                        "path": first.to_string_lossy(), "directory": dir.to_string_lossy(), "format": "Session %CCYY-%MM-%DD %hh-%mm-%ss",
                        "extension": "mkv", "allow_spaces": true, "split_file": true, "max_time_sec": 300, "max_size_mb": 0
                    }));
                    let session = (self.o.obs_output_create)(c("ffmpeg_muxer").as_ptr(), c("Session").as_ptr(), st, std::ptr::null_mut());
                    (self.o.obs_data_release)(st);
                    if session.is_null() {
                        println!("recorder: couldn't make the session recording");
                    } else {
                        (self.o.obs_output_set_video_encoder)(session, video);
                        for (i, a) in self.audio_encs.iter().enumerate() {
                            (self.o.obs_output_set_audio_encoder)(session, *a, i);
                        }
                        self.session = session;
                    }
                }
                (self.o.signal_handler_connect)((self.o.obs_output_get_signal_handler)(replay), c("saved").as_ptr(), on_saved, std::ptr::null_mut());
                self.video_enc = video;
                self.replay = replay;
                Ok(())
            }
        };
        made
    }

    /// Starts the replay buffer and waits until it really runs.
    fn start_replay(&mut self) -> Result<(), String> {
        if self.replay.is_null() {
            return Err("nothing to record".into());
        }
        if self.running() {
            return Ok(());
        }
        // SAFETY: our replay output.
        if !unsafe { (self.o.obs_output_start)(self.replay) } {
            let why = text(unsafe { (self.o.obs_output_get_last_error)(self.replay) });
            return Err(format!("the replay buffer didn't start{}", if why.is_empty() { String::new() } else { format!(": {why}") }));
        }
        let until = Instant::now() + Duration::from_secs(5);
        while !self.running() {
            if Instant::now() > until {
                return Err("the replay buffer didn't start".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // The pieces recording, if wanted: not being able to doesn't stop clips.
        // SAFETY: our session output.
        if !self.session.is_null() && !unsafe { (self.o.obs_output_active)(self.session) } && !unsafe { (self.o.obs_output_start)(self.session) } {
            println!("recorder: the session recording didn't start: {}", text(unsafe { (self.o.obs_output_get_last_error)(self.session) }));
        }
        Ok(())
    }

    /// Saves the replay buffer; returns the file once it's written.
    fn save(&mut self) -> Result<String, String> {
        if !self.running() {
            return Err("not recording right now".into());
        }
        SAVED.store(false, Ordering::SeqCst);
        let mut buf = [0u8; 64];
        let mut cd = CallData::on(&mut buf);
        // SAFETY: the replay buffer's own "save" procedure.
        unsafe {
            let ph = (self.o.obs_output_get_proc_handler)(self.replay);
            if !(self.o.proc_handler_call)(ph, c("save").as_ptr(), &mut cd) {
                return Err("OBS couldn't save the replay".into());
            }
        }
        let until = Instant::now() + Duration::from_secs(20);
        while !SAVED.load(Ordering::SeqCst) {
            if Instant::now() > until {
                return Err("OBS took too long to save the replay".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut buf = [0u8; 4096];
        let mut cd = CallData::on(&mut buf);
        let mut path: *const std::ffi::c_char = std::ptr::null();
        // SAFETY: "get_last_replay" writes the path into our call data.
        unsafe {
            let ph = (self.o.obs_output_get_proc_handler)(self.replay);
            (self.o.proc_handler_call)(ph, c("get_last_replay").as_ptr(), &mut cd);
            (self.o.calldata_get_string)(&cd, c("path").as_ptr(), &mut path);
        }
        let path = text(path);
        if path.is_empty() {
            Err("OBS didn't say where it saved the replay".into())
        } else {
            Ok(path)
        }
    }

    /// "fps=143.9 render skipped 3/9000 encode skipped 0/9000".
    fn stats(&self) -> String {
        // SAFETY: plain counters.
        unsafe {
            let (dropped, total) = if self.replay.is_null() {
                (0, 0)
            } else {
                ((self.o.obs_output_get_frames_dropped)(self.replay), (self.o.obs_output_get_total_frames)(self.replay))
            };
            format!(
                "fps={:.1} render skipped {}/{} encode skipped {dropped}/{total}",
                (self.o.obs_get_active_fps)(),
                (self.o.obs_get_lagged_frames)(),
                (self.o.obs_get_total_frames)()
            )
        }
    }

    /// Stops recording and shuts libobs down.
    pub fn stop(&mut self) {
        self.drop_outputs();
        self.drop_sources();
        // SAFETY: nothing of ours is left in libobs.
        unsafe {
            (self.o.obs_set_output_source)(0, std::ptr::null_mut());
            if !self.scene.is_null() {
                (self.o.obs_source_release)((self.o.obs_scene_get_source)(self.scene));
            }
            (self.o.obs_shutdown)();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_mic_by_name() {
        let items = vec![
            ("Default".to_string(), "default".to_string()),
            ("Microphone (Realtek(R) Audio)".to_string(), "{0.0.1.00000000}.{aaa}".to_string()),
            ("Headset Microphone (HyperX Cloud II)".to_string(), "{0.0.1.00000000}.{bbb}".to_string()),
        ];
        assert_eq!(pick_item(&items, "Headset Microphone (HyperX Cloud II)").as_deref(), Some("{0.0.1.00000000}.{bbb}"));
        assert_eq!(pick_item(&items, "microphone (realtek(r) audio)").as_deref(), Some("{0.0.1.00000000}.{aaa}"));
        assert_eq!(pick_item(&items, "HyperX Cloud II").as_deref(), Some("{0.0.1.00000000}.{bbb}"));
        assert_eq!(pick_item(&items, "Blue Yeti"), None);
    }

    #[test]
    fn window_strings_escape_colons() {
        assert_eq!(window_spec("A: B", "Cls", "game.exe"), "A#3A B:Cls:game.exe");
    }

    #[test]
    fn reads_capture_as_crosspov_sends_it() {
        let v = json!({
            "source": { "Screen": { "origin": [0, 0], "game": ["VALORANT-Win64-Shipping.exe", "UnrealWindow"] } },
            "size": [1920, 1080], "out_size": [1920, 1080], "fps": 144, "game_audio": 1.0, "desktop_audio": false,
            "apps": [["Discord.exe", 0.5]], "mic": null, "mic_device": "default", "denoise_mic": false, "separate_tracks": false
        });
        let cap: Capture = serde_json::from_value(v).unwrap();
        assert_eq!(cap.source, Source::Screen { origin: (0, 0), game: Some(("VALORANT-Win64-Shipping.exe".into(), "UnrealWindow".into())) });
        assert_eq!(cap.apps, vec![("Discord.exe".to_string(), 0.5)]);
    }

    #[test]
    fn calldata_starts_as_an_empty_list() {
        let mut buf = [0xffu8; 64];
        let cd = CallData::on(&mut buf);
        assert_eq!(cd.size, std::mem::size_of::<usize>());
        assert!(cd.fixed && cd.capacity == 64);
        assert!(buf[..std::mem::size_of::<usize>()].iter().all(|b| *b == 0));
    }

    #[test]
    fn calldata_layout_matches_libobs() {
        assert_eq!(std::mem::size_of::<CallData>(), 4 * std::mem::size_of::<usize>());
        assert_eq!(std::mem::size_of::<lo::VideoInfo>(), 56);
    }
}
