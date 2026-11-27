//! Windows-only audio helpers:
//! - listing the apps that currently have an audio session (like the
//!   volume mixer)
//! - a short "clip saved" beep

use std::{sync::OnceLock, thread};

use windows::{
    core::{Interface, Result as WinResult, PCWSTR},
    Win32::{
        Media::Audio::{
            eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, PlaySoundW,
            SND_MEMORY, SND_NODEFAULT, SND_SYNC,
        },
        System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED},
    },
};

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
