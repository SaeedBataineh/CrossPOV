// CrossPOV Recorder: records games with OBS Studio's libobs.
// Copyright (C) 2026 CrossPOV
//
// This program is free software; you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation; either version 2 of the License, or (at your option)
// any later version. See LICENSE.

//! The parts of libobs (OBS Studio 32's obs.dll) the recorder uses, loaded
//! when it starts. Types and layouts follow libobs' headers (obs.h,
//! callback/calldata.h, graphics/vec2.h) at OBS Studio 32.0.4.

use std::ffi::{c_char, c_void};
use std::path::Path;

use libloading::Library;

/// An object libobs owns (a source, scene, encoder, output, settings...).
pub type Ptr = *mut c_void;

/// `struct obs_video_info`.
#[repr(C)]
pub struct VideoInfo {
    pub graphics_module: *const c_char,
    pub fps_num: u32,
    pub fps_den: u32,
    pub base_width: u32,
    pub base_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    /// `enum video_format`: VIDEO_FORMAT_NV12 = 2.
    pub output_format: i32,
    pub adapter: u32,
    pub gpu_conversion: bool,
    /// `enum video_colorspace`: VIDEO_CS_709 = 2.
    pub colorspace: i32,
    /// `enum video_range_type`: VIDEO_RANGE_PARTIAL = 1.
    pub range: i32,
    /// `enum obs_scale_type`: OBS_SCALE_BICUBIC = 2.
    pub scale_type: i32,
}

pub const VIDEO_FORMAT_NV12: i32 = 2;
pub const VIDEO_CS_709: i32 = 2;
pub const VIDEO_RANGE_PARTIAL: i32 = 1;
pub const OBS_SCALE_BICUBIC: i32 = 2;
pub const OBS_VIDEO_SUCCESS: i32 = 0;

/// `struct obs_audio_info`.
#[repr(C)]
pub struct AudioInfo {
    pub samples_per_sec: u32,
    /// `enum speaker_layout`: SPEAKERS_STEREO = 2.
    pub speakers: i32,
}

pub const SPEAKERS_STEREO: i32 = 2;

/// `struct vec2`.
#[repr(C)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

pub const OBS_BOUNDS_SCALE_INNER: i32 = 2;
pub const OBS_ALIGN_CENTER: u32 = 0;
pub const OBS_ALIGN_TOP_LEFT: u32 = (1 << 2) | (1 << 0);

/// `struct calldata`: a call's parameters, on a stack we own (`fixed`).
#[repr(C)]
pub struct CallData {
    pub stack: *mut u8,
    pub size: usize,
    pub capacity: usize,
    pub fixed: bool,
}

impl CallData {
    /// `calldata_init_fixed` on `buf`: libobs never frees or grows it.
    pub fn on(buf: &mut [u8]) -> CallData {
        CallData { stack: buf.as_mut_ptr(), size: 0, capacity: buf.len(), fixed: true }
    }
}

pub type SignalCallback = unsafe extern "C" fn(data: *mut c_void, cd: *mut CallData);

macro_rules! api {
    ($($name:ident: fn($($arg:ty),*) $(-> $ret:ty)?;)*) => {
        /// obs.dll's functions.
        #[allow(non_snake_case)]
        pub struct Obs {
            /// Never unloaded: libobs' own threads (audio devices, capture)
            /// can outlive obs_shutdown, and unloading under them crashes.
            /// Windows frees it when the recorder exits.
            _lib: std::mem::ManuallyDrop<Library>,
            $(pub $name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
        }

        impl Obs {
            /// Loads obs.dll (and, through Windows, the DLLs next to it).
            pub fn load(path: &Path) -> Result<Obs, String> {
                // SAFETY: obs.dll is OBS Studio's libobs; each function is
                // read with the signature its header declares.
                unsafe {
                    let lib = Library::new(path).map_err(|e| format!("couldn't load {}: {e}", path.display()))?;
                    $(
                        let $name = *lib
                            .get::<unsafe extern "C" fn($($arg),*) $(-> $ret)?>(concat!(stringify!($name), "\0").as_bytes())
                            .map_err(|e| format!("obs.dll has no {}: {e}", stringify!($name)))?;
                    )*
                    Ok(Obs { _lib: std::mem::ManuallyDrop::new(lib), $($name,)* })
                }
            }
        }
    };
}

api! {
    obs_startup: fn(*const c_char, *const c_char, Ptr) -> bool;
    obs_shutdown: fn();
    obs_reset_video: fn(*mut VideoInfo) -> i32;
    obs_reset_audio: fn(*const AudioInfo) -> bool;
    obs_load_all_modules: fn();
    obs_post_load_modules: fn();
    obs_set_output_source: fn(u32, Ptr);
    obs_get_video: fn() -> Ptr;
    obs_get_audio: fn() -> Ptr;
    obs_get_active_fps: fn() -> f64;
    obs_get_lagged_frames: fn() -> u32;
    obs_get_total_frames: fn() -> u32;

    obs_scene_create: fn(*const c_char) -> Ptr;
    obs_scene_get_source: fn(Ptr) -> Ptr;
    obs_scene_add: fn(Ptr, Ptr) -> Ptr;
    obs_sceneitem_remove: fn(Ptr);
    obs_sceneitem_set_visible: fn(Ptr, bool) -> bool;
    obs_sceneitem_set_bounds_type: fn(Ptr, i32);
    obs_sceneitem_set_bounds: fn(Ptr, *const Vec2);
    obs_sceneitem_set_bounds_alignment: fn(Ptr, u32);
    obs_sceneitem_set_alignment: fn(Ptr, u32);
    obs_sceneitem_set_pos: fn(Ptr, *const Vec2);

    obs_source_create: fn(*const c_char, *const c_char, Ptr, Ptr) -> Ptr;
    obs_source_release: fn(Ptr);
    obs_source_update: fn(Ptr, Ptr);
    obs_source_set_volume: fn(Ptr, f32);
    obs_source_set_audio_mixers: fn(Ptr, u32);
    obs_source_filter_add: fn(Ptr, Ptr);
    obs_source_properties: fn(Ptr) -> Ptr;
    obs_properties_get: fn(Ptr, *const c_char) -> Ptr;
    obs_properties_destroy: fn(Ptr);
    obs_property_list_item_count: fn(Ptr) -> usize;
    obs_property_list_item_name: fn(Ptr, usize) -> *const c_char;
    obs_property_list_item_string: fn(Ptr, usize) -> *const c_char;

    obs_data_create: fn() -> Ptr;
    obs_data_release: fn(Ptr);
    obs_data_set_string: fn(Ptr, *const c_char, *const c_char);
    obs_data_set_int: fn(Ptr, *const c_char, i64);
    obs_data_set_bool: fn(Ptr, *const c_char, bool);

    obs_video_encoder_create: fn(*const c_char, *const c_char, Ptr, Ptr) -> Ptr;
    obs_audio_encoder_create: fn(*const c_char, *const c_char, Ptr, usize, Ptr) -> Ptr;
    obs_encoder_set_video: fn(Ptr, Ptr);
    obs_encoder_set_audio: fn(Ptr, Ptr);
    obs_encoder_release: fn(Ptr);

    obs_output_create: fn(*const c_char, *const c_char, Ptr, Ptr) -> Ptr;
    obs_output_release: fn(Ptr);
    obs_output_set_video_encoder: fn(Ptr, Ptr);
    obs_output_set_audio_encoder: fn(Ptr, Ptr, usize);
    obs_output_start: fn(Ptr) -> bool;
    obs_output_stop: fn(Ptr);
    obs_output_active: fn(Ptr) -> bool;
    obs_output_get_last_error: fn(Ptr) -> *const c_char;
    obs_output_get_proc_handler: fn(Ptr) -> Ptr;
    obs_output_get_signal_handler: fn(Ptr) -> Ptr;
    obs_output_get_frames_dropped: fn(Ptr) -> i32;
    obs_output_get_total_frames: fn(Ptr) -> i32;

    proc_handler_call: fn(Ptr, *const c_char, *mut CallData) -> bool;
    signal_handler_connect: fn(Ptr, *const c_char, SignalCallback, *mut c_void);
    calldata_get_string: fn(*const CallData, *const c_char, *mut *const c_char) -> bool;
}
