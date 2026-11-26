//! Windows-only audio helpers:
//! - per-app capture with the process-loopback API (Windows 10 2004+),
//!   which records one app and its child processes and nothing else
//! - listing the apps that currently have an audio session (like the
//!   volume mixer)
//! - a short "clip saved" beep

use std::{
    mem::{size_of, ManuallyDrop},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, OnceLock,
    },
    thread::{self, JoinHandle},
};

use windows::{
    core::{implement, Interface, Ref, Result as WinResult, HRESULT, PCWSTR},
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
        Media::Audio::{
            eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
            IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient,
            IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, PlaySoundW,
            AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
            AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, SND_MEMORY, SND_NODEFAULT, SND_SYNC,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
        },
        Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0},
                BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
            },
            Threading::{CreateEventW, WaitForSingleObject},
            Variant::VT_BLOB,
        },
    },
};

use crate::ffmpeg::AUDIO_RATE;

/// Called by Windows when activation finishes: only signals the waiting
/// thread, which then reads the result itself (the pattern the wasapi crate
/// uses). Objects from `#[implement]` are agile already.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated {
    done: mpsc::SyncSender<()>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
        let _ = self.done.try_send(());
        Ok(())
    }
}

fn activate_process_loopback(pid: u32) -> WinResult<IAudioClient> {
    let step = |s: &str| crate::trail(&format!("app audio {pid}: {s}"));
    // Everything Windows reads lives in memory from Windows' own allocator and
    // is never freed here: if Windows frees (or keeps using) it, nothing breaks.
    // That's two small blocks per capture start.
    // SAFETY: CoTaskMemAlloc returns writable memory of the requested size (or null).
    let params = unsafe { CoTaskMemAlloc(size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>()) } as *mut AUDIOCLIENT_ACTIVATION_PARAMS;
    let prop = unsafe { CoTaskMemAlloc(size_of::<PROPVARIANT>()) } as *mut PROPVARIANT;
    if params.is_null() || prop.is_null() {
        return Err(windows::core::Error::from(windows::Win32::Foundation::E_OUTOFMEMORY));
    }
    // SAFETY: both pointers are valid, suitably aligned allocations of the right size.
    unsafe {
        params.write(AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        });
        prop.write(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB { cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: params as *mut u8 },
                    },
                }),
            },
        });
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let handler: IActivateAudioInterfaceCompletionHandler = Activated { done: tx }.into();
    let op = unsafe { ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(prop as *const PROPVARIANT), &handler)? };
    step("activation requested");
    if rx.recv_timeout(std::time::Duration::from_secs(10)).is_err() {
        // Windows may still finish later and call the handler: keep it and
        // the operation alive for good (a few bytes, only on this rare path).
        std::mem::forget(op);
        std::mem::forget(handler);
        return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
    }
    step("windows answered");
    let mut hr = HRESULT(0);
    let mut unknown: Option<windows::core::IUnknown> = None;
    unsafe { op.GetActivateResult(&mut hr, &mut unknown)? };
    hr.ok()?;
    let client: IAudioClient = unknown.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_NOINTERFACE))?.cast()?;
    step("got the audio client");
    Ok(client)
}

/// Format we ask Windows for: 48 kHz stereo float, so no conversion is
/// needed on our side.
fn float_stereo_48k() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
        nChannels: 2,
        nSamplesPerSec: AUDIO_RATE,
        nAvgBytesPerSec: AUDIO_RATE * 8,
        nBlockAlign: 8,
        wBitsPerSample: 32,
        cbSize: 0,
    }
}

struct EventHandle(HANDLE);
impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn capture_loop(pid: u32, on_audio: &mut dyn FnMut(&[f32]), stop: &AtomicBool, ready: &mpsc::SyncSender<Result<(), String>>) -> WinResult<()> {
    // Each step goes in the activity log: if Windows crashes the capture,
    // the last line says where.
    let step = |s: &str| crate::trail(&format!("app audio {pid}: {s}"));
    step("activating");
    let client = activate_process_loopback(pid).inspect_err(|e| step(&format!("activate failed: {e}")))?;
    step("activated");
    let format = float_stereo_48k();
    let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
    unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &format, None) }.inspect_err(|e| step(&format!("initialize failed: {e}")))?;
    step("initialized");
    let event = EventHandle(unsafe { CreateEventW(None, false, false, PCWSTR::null())? });
    unsafe { client.SetEventHandle(event.0)? };
    let capture: IAudioCaptureClient = unsafe { client.GetService()? };
    unsafe { client.Start()? };
    step("started");
    let _ = ready.send(Ok(()));

    let mut silence: Vec<f32> = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        if unsafe { WaitForSingleObject(event.0, 100) } != WAIT_OBJECT_0 {
            continue;
        }
        loop {
            let packet = unsafe { capture.GetNextPacketSize()? };
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut buf_flags = 0u32;
            unsafe { capture.GetBuffer(&mut data, &mut frames, &mut buf_flags, None, None)? };
            let n = frames as usize * 2;
            if buf_flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                silence.clear();
                silence.resize(n, 0.0);
                on_audio(&silence);
            } else {
                let samples = unsafe { std::slice::from_raw_parts(data as *const f32, n) };
                on_audio(samples);
            }
            unsafe { capture.ReleaseBuffer(frames)? };
        }
    }
    unsafe {
        let _ = client.Stop();
    }
    Ok(())
}

/// Records one app (and its child processes). `on_audio` receives
/// interleaved 48 kHz stereo floats. Returns once capture has started, or
/// with the reason it couldn't (e.g. Windows older than 10 version 2004).
pub fn start_app_capture<F>(pid: u32, mut on_audio: F, stop: Arc<AtomicBool>) -> Result<JoinHandle<()>, String>
where
    F: FnMut(&[f32]) + Send + 'static,
{
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let handle = thread::Builder::new()
        .name(format!("app-audio-{pid}"))
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            if let Err(e) = capture_loop(pid, &mut on_audio, &stop, &ready_tx) {
                let _ = ready_tx.send(Err(e.message()));
            }
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(std::time::Duration::from_secs(6)) {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("audio capture did not start".into()),
    }
}

/// Process IDs that currently have an audio session on the default speakers.
pub fn audio_session_pids() -> Vec<u32> {
    let run = || -> WinResult<Vec<u32>> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let sessions = manager.GetSessionEnumerator()?;
            let mut pids = Vec::new();
            for i in 0..sessions.GetCount()? {
                let control = sessions.GetSession(i)?;
                if let Ok(c2) = control.cast::<IAudioSessionControl2>() {
                    if let Ok(pid) = c2.GetProcessId() {
                        if pid != 0 && !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
            }
            Ok(pids)
        }
    };
    // COM calls run on a fresh thread so they never clash with the UI thread's COM mode.
    thread::spawn(run).join().ok().and_then(Result::ok).unwrap_or_default()
}

/// A 70 ms, 880 Hz beep as an in-memory WAV file.
fn beep_wav() -> &'static [u8] {
    static WAV: OnceLock<Vec<u8>> = OnceLock::new();
    WAV.get_or_init(|| {
        let rate = 44_100u32;
        let n = rate * 70 / 1000;
        let mut pcm = Vec::with_capacity(n as usize * 2);
        for i in 0..n {
            let t = i as f32 / rate as f32;
            let fade = (1.0 - i as f32 / n as f32).min(1.0);
            let v = (t * 880.0 * std::f32::consts::TAU).sin() * 0.25 * fade;
            pcm.extend_from_slice(&((v * i16::MAX as f32) as i16).to_le_bytes());
        }
        let mut w = Vec::with_capacity(44 + pcm.len());
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes()); // PCM
        w.extend_from_slice(&1u16.to_le_bytes()); // mono
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * 2).to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        w.extend_from_slice(&pcm);
        w
    })
}

/// Plays the clip beep. Never blocks: the sound plays on its own long-lived
/// thread, so it isn't cut off when the thread that asked for it ends, and
/// presses close together each get their beep.
pub fn beep() {
    static PLAYER: OnceLock<std::sync::mpsc::Sender<()>> = OnceLock::new();
    let tx = PLAYER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let _ = std::thread::Builder::new().name("clip-beep".into()).spawn(move || {
            let wav = beep_wav();
            while rx.recv().is_ok() {
                unsafe {
                    let _ = PlaySoundW(PCWSTR(wav.as_ptr() as *const u16), None, SND_MEMORY | SND_SYNC | SND_NODEFAULT);
                }
            }
        });
        tx
    });
    let _ = tx.send(());
}
