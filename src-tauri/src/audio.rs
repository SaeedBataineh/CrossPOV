//! Captures game audio (WASAPI loopback of the default speakers) and the
//! microphone, and writes them to FFmpeg as one steady 4-channel stream:
//! channels 0-1 game, 2-3 mic, 48 kHz float.
//!
//! The output is clocked by wall time, not by the devices: Windows sends no
//! loopback data while nothing is playing, so gaps are filled with silence.
//! That keeps the audio exactly in step with the video.

use std::{
    collections::VecDeque,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, SampleFormat, SizedSample, Stream,
};

use crate::{
    ffmpeg::AUDIO_RATE,
    procs,
    settings::{AudioMode, Settings},
};

/// At most this much audio is queued per source before old samples are
/// dropped, which bounds latency if a device delivers in bursts.
const MAX_QUEUE_SECONDS: f64 = 0.3;
/// How often the mixer wakes. Each wake writes all audio due since the last
/// one, so a longer tick only means fewer, larger writes (latency is bounded
/// by MAX_QUEUE_SECONDS anyway).
const TICK: Duration = Duration::from_millis(20);
/// How often to look for apps that opened or closed.
const RESCAN: Duration = Duration::from_secs(3);

/// Converts any device rate to 48 kHz stereo using linear interpolation.
/// Plenty for game audio and voice, and cheap.
#[derive(Debug)]
pub struct Resampler {
    step: f64,
    pos: f64,
    prev: [f32; 2],
}

impl Resampler {
    pub fn new(in_rate: u32) -> Self {
        Self { step: f64::from(in_rate) / f64::from(AUDIO_RATE), pos: 0.0, prev: [0.0; 2] }
    }

    /// Feeds one stereo input frame; appends any output frames to `out`.
    pub fn push(&mut self, frame: [f32; 2], out: &mut VecDeque<f32>) {
        if (self.step - 1.0).abs() < f64::EPSILON {
            out.extend(frame);
            return;
        }
        while self.pos <= 1.0 {
            let t = self.pos as f32;
            out.push_back(self.prev[0] + (frame[0] - self.prev[0]) * t);
            out.push_back(self.prev[1] + (frame[1] - self.prev[1]) * t);
            self.pos += self.step;
        }
        self.pos -= 1.0;
        self.prev = frame;
    }
}

struct Source {
    queue: VecDeque<f32>,
    resampler: Resampler,
}

type Shared = Arc<Mutex<Source>>;

fn new_source(rate: u32) -> Shared {
    Arc::new(Mutex::new(Source { queue: VecDeque::with_capacity(AUDIO_RATE as usize), resampler: Resampler::new(rate) }))
}

fn push_samples<T>(data: &[T], channels: usize, src: &Shared)
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let Ok(mut s) = src.lock() else { return };
    let Source { queue, resampler } = &mut *s;
    for frame in data.chunks_exact(channels.max(1)) {
        let l: f32 = frame[0].to_sample();
        let r: f32 = if channels > 1 { frame[1].to_sample() } else { l };
        resampler.push([l, r], queue);
    }
    let max = (MAX_QUEUE_SECONDS * f64::from(AUDIO_RATE)) as usize * 2;
    if queue.len() > max {
        let extra = queue.len() - max;
        queue.drain(..extra);
    }
}

fn build_stream(device: &cpal::Device, loopback: bool, src: Shared) -> Result<Stream, String> {
    let supported = if loopback { device.default_output_config() } else { device.default_input_config() }
        .map_err(|e| e.to_string())?;
    let channels = usize::from(supported.channels());
    let format = supported.sample_format();
    let config = supported.config();
    if let Ok(mut s) = src.lock() {
        s.resampler = Resampler::new(config.sample_rate);
    }
    let on_err = |e| eprintln!("audio stream error: {e}");
    macro_rules! stream {
        ($t:ty) => {{
            let src = src.clone();
            device.build_input_stream::<$t, _, _>(config.clone(), move |d, _| push_samples(d, channels, &src), on_err, None)
        }};
    }
    let stream = match format {
        SampleFormat::F32 => stream!(f32),
        SampleFormat::I16 => stream!(i16),
        SampleFormat::I32 => stream!(i32),
        SampleFormat::U16 => stream!(u16),
        other => return Err(format!("unsupported sample format {other}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn find_mic(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    if name != "default" {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(d) = devices.find(|d| d.to_string() == name) {
                return Some(d);
            }
        }
    }
    host.default_input_device()
}

/// Names of the microphones Windows knows about, for the Settings screen.
pub fn input_device_names() -> Vec<String> {
    cpal::default_host()
        .input_devices()
        .map(|ds| ds.map(|d| d.to_string()).collect())
        .unwrap_or_default()
}

/// Adds `frames` stereo frames from a source into `mix`, scaled by `volume`.
fn mix_in(src: &Shared, frames: usize, volume: f32, mix: &mut [f32]) {
    if let Ok(mut s) = src.lock() {
        let n = (frames * 2).min(s.queue.len());
        for (out, v) in mix.iter_mut().zip(s.queue.drain(..n)) {
            *out += v * volume;
        }
    }
}

fn volume(percent: u32) -> f32 {
    percent as f32 / 100.0
}

/// One app being recorded through per-app capture.
struct AppCapture {
    pid: u32,
    volume: f32,
    src: Shared,
    stop: Arc<AtomicBool>,
}

impl Drop for AppCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(windows)]
fn start_app(pid: u32, src: &Shared, stop: &Arc<AtomicBool>) -> Result<(), String> {
    let sink = src.clone();
    crate::trail(&format!("app audio: starting capture of process {pid}"));
    let r = crate::win_audio::start_app_capture(pid, move |samples| push_stereo_48k(samples, &sink), stop.clone()).map(|_| ());
    crate::trail(&format!("app audio: process {pid}: {}", match &r { Ok(()) => "capturing".to_string(), Err(e) => format!("failed ({e})") }));
    r
}

#[cfg(not(windows))]
fn start_app(_pid: u32, _src: &Shared, _stop: &Arc<AtomicBool>) -> Result<(), String> {
    Err("per-app audio needs Windows".into())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn push_stereo_48k(samples: &[f32], src: &Shared) {
    let Ok(mut s) = src.lock() else { return };
    s.queue.extend(samples.iter().copied());
    let max = (MAX_QUEUE_SECONDS * f64::from(AUDIO_RATE)) as usize * 2;
    if s.queue.len() > max {
        let extra = s.queue.len() - max;
        s.queue.drain(..extra);
    }
}

/// What to record, taken from settings when recording starts.
#[derive(Debug, Clone)]
struct Plan {
    mode: AudioMode,
    game: Option<f32>,
    game_exe: String,
    apps: Vec<(String, f32)>,
    mic: Option<(String, f32)>,
}

impl Plan {
    fn from(s: &Settings) -> Self {
        Self {
            mode: s.audio_mode,
            game: s.game_audio.then(|| volume(s.game_volume)),
            game_exe: procs::game_exe(),
            apps: s.apps.iter().filter(|a| a.enabled).map(|a| (a.exe.clone(), volume(a.volume))).collect(),
            mic: s.microphone.then(|| (s.mic_device.clone(), volume(s.mic_volume))),
        }
    }

    /// Apps to capture one by one: the game (in game-only mode) plus extras.
    fn per_app(&self) -> Vec<(String, f32)> {
        if self.mode == AudioMode::Desktop {
            return Vec::new(); // Desktop sound already includes every app.
        }
        let mut v: Vec<(String, f32)> = self.game.map(|g| (self.game_exe.clone(), g)).into_iter().collect();
        v.extend(self.apps.iter().cloned());
        v
    }
}

pub struct AudioPipe {
    stop: Arc<AtomicBool>,
    warning: Arc<Mutex<Option<String>>>,
    thread: Option<JoinHandle<()>>,
}

impl AudioPipe {
    /// Starts capture and the mixer, writing PCM to `sink` (FFmpeg's stdin)
    /// until stopped or until the sink closes.
    pub fn start<W: Write + Send + 'static>(settings: &Settings, mut sink: W) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let warning = Arc::new(Mutex::new(None));
        let plan = Plan::from(settings);
        let (stop_flag, warn) = (stop.clone(), warning.clone());

        let thread = thread::Builder::new()
            .name("audio-mixer".into())
            .spawn(move || {
                let host = cpal::default_host();
                let mut streams: Vec<Stream> = Vec::new();
                let mut open = |device: Option<cpal::Device>, loopback: bool, what: &str| -> Option<Shared> {
                    let device = device?;
                    let src = new_source(AUDIO_RATE);
                    match build_stream(&device, loopback, src.clone()) {
                        Ok(s) => {
                            streams.push(s);
                            Some(src)
                        }
                        Err(e) => {
                            eprintln!("could not capture {what}: {e}");
                            None
                        }
                    }
                };

                // Track 1 (game) inputs that aren't per-app captures.
                let mut game_inputs: Vec<(Shared, f32)> = Vec::new();
                if plan.mode == AudioMode::Desktop {
                    if let Some(vol) = plan.game {
                        // On Windows, opening the speakers for input gives loopback capture.
                        if let Some(src) = open(host.default_output_device(), true, "desktop audio") {
                            game_inputs.push((src, vol));
                        }
                    }
                }
                let mic = plan.mic.as_ref().and_then(|(name, vol)| {
                    open(find_mic(&host, name), false, "microphone").map(|src| (src, *vol))
                });

                let per_app = plan.per_app();
                let mut apps: Vec<AppCapture> = Vec::new();
                let mut failed: Vec<u32> = Vec::new();
                let mut fell_back = false;
                let mut last_scan: Option<Instant> = None;

                let started = Instant::now();
                let mut written: u64 = 0;
                let (mut track1, mut track2) = (Vec::new(), Vec::new());
                let mut bytes: Vec<u8> = Vec::new();
                while !stop_flag.load(Ordering::Relaxed) {
                    // Every few seconds, pick up apps that started or stopped.
                    if !per_app.is_empty() && last_scan.is_none_or(|t| t.elapsed() >= RESCAN) {
                        last_scan = Some(Instant::now());
                        let mut live: Vec<u32> = Vec::new();
                        for (exe, vol) in &per_app {
                            for pid in procs::shared(|p| p.root_pids(exe)) {
                                live.push(pid);
                                if apps.iter().any(|a| a.pid == pid) || failed.contains(&pid) {
                                    continue;
                                }
                                let src = new_source(AUDIO_RATE);
                                let stop = Arc::new(AtomicBool::new(false));
                                match start_app(pid, &src, &stop) {
                                    Ok(()) => apps.push(AppCapture { pid, volume: *vol, src, stop }),
                                    Err(e) => {
                                        eprintln!("could not capture {exe} ({pid}): {e}");
                                        failed.push(pid);
                                        // Per-app capture unsupported (older Windows): record
                                        // everything instead of recording no game sound.
                                        if *exe == plan.game_exe && !fell_back {
                                            fell_back = true;
                                            if let Some(src) = open(host.default_output_device(), true, "desktop audio") {
                                                game_inputs.push((src, *vol));
                                            }
                                            if let Ok(mut w) = warn.lock() {
                                                *w = Some("Per-app audio isn't available on this version of Windows, so all desktop sound is recorded.".into());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        apps.retain(|a| live.contains(&a.pid));
                        failed.retain(|pid| live.contains(pid));
                    }

                    thread::sleep(TICK);
                    let due = (started.elapsed().as_secs_f64() * f64::from(AUDIO_RATE)) as u64;
                    let frames = due.saturating_sub(written) as usize;
                    if frames == 0 {
                        continue;
                    }
                    track1.clear();
                    track1.resize(frames * 2, 0.0f32);
                    track2.clear();
                    track2.resize(frames * 2, 0.0f32);
                    for (src, vol) in &game_inputs {
                        mix_in(src, frames, *vol, &mut track1);
                    }
                    for app in &apps {
                        mix_in(&app.src, frames, app.volume, &mut track1);
                    }
                    if let Some((src, vol)) = &mic {
                        mix_in(src, frames, *vol, &mut track2);
                    }
                    bytes.clear();
                    for i in 0..frames {
                        for v in [track1[i * 2], track1[i * 2 + 1], track2[i * 2], track2[i * 2 + 1]] {
                            bytes.extend_from_slice(&v.clamp(-1.0, 1.0).to_le_bytes());
                        }
                    }
                    if sink.write_all(&bytes).is_err() {
                        break; // FFmpeg stopped.
                    }
                    written += frames as u64;
                }
                drop(apps);
                drop(streams);
            })
            .expect("spawn audio thread");

        Self { stop, warning, thread: Some(thread) }
    }

    /// Set when audio had to fall back to something other than what was asked.
    pub fn warning(&self) -> Option<String> {
        self.warning.lock().ok().and_then(|w| w.clone())
    }
}

impl Drop for AudioPipe {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_passes_48k_through() {
        let mut r = Resampler::new(48_000);
        let mut out = VecDeque::new();
        for i in 0..100 {
            r.push([i as f32, -(i as f32)], &mut out);
        }
        assert_eq!(out.len(), 200);
    }

    #[test]
    fn resampler_converts_44k1_to_48k() {
        let mut r = Resampler::new(44_100);
        let mut out = VecDeque::new();
        for _ in 0..44_100 {
            r.push([0.5, 0.5], &mut out);
        }
        let frames = out.len() / 2;
        assert!((47_990..=48_010).contains(&frames), "{frames}");
        assert!(out.iter().skip(4).all(|&v| (v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn mixer_writes_steady_silence_without_devices() {
        #[derive(Clone)]
        struct Counter(Arc<Mutex<usize>>);
        impl Write for Counter {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                *self.0.lock().unwrap() += b.len();
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let count = Counter(Arc::new(Mutex::new(0)));
        let s = Settings { game_audio: false, microphone: false, ..Settings::default() };
        let pipe = AudioPipe::start(&s, count.clone());
        thread::sleep(Duration::from_millis(500));
        drop(pipe);
        // 0.5 s * 48000 frames * 4 channels * 4 bytes = 384000, give or take a tick.
        let bytes = *count.0.lock().unwrap();
        assert!((300_000..=420_000).contains(&bytes), "{bytes}");
        assert_eq!(bytes % 16, 0, "whole frames only");
    }
}
