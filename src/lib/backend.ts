import { convertFileSrc } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

// The same UI runs inside the desktop app (Tauri) and as a plain website
// (the public demo for Riot's review). In the browser there is no Rust
// backend, so settings fall back to localStorage and desktop-only actions
// are disabled.
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const LOCAL_KEY = "crosspov.settings";

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function loadSettings(): Promise<Settings> {
  if (isDesktop) return tauriInvoke<Settings>("get_settings");
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Saves and returns the settings as stored (the backend may fill in defaults, e.g. the clip folder). */
export async function saveSettings(settings: Settings): Promise<Settings> {
  if (isDesktop) return tauriInvoke<Settings>("save_settings", { settings });
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked (private window etc.): settings just won't persist in the demo.
  }
  return settings;
}

export async function defaultClipFolder(): Promise<string> {
  if (isDesktop) return tauriInvoke<string>("default_clip_folder");
  return "C:\\Users\\you\\Videos\\CrossPOV";
}

export async function pickFolder(current: string): Promise<string | null> {
  if (!isDesktop) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, defaultPath: current || undefined });
  return typeof picked === "string" ? picked : null;
}

export async function openClipFolder(): Promise<void> {
  if (isDesktop) await tauriInvoke<void>("open_clip_folder");
}

// ---------- Recorder and clips ----------

export type RecState = "starting" | "noFfmpeg" | "waiting" | "recording" | "error";

export interface RecorderStatus {
  state: RecState;
  encoder: string | null;
  message: string | null;
  audioWarning: string | null;
  hotkeyError: string | null;
}

export interface ClipInfo {
  path: string;
  name: string;
  kind: "mine" | "theirs";
  sizeBytes: number;
  createdMs: number;
  durationSec: number | null;
  thumb: string | null;
}

export interface AudioApp {
  exe: string;
}

type Unlisten = () => void;

const DEMO_STATUS: RecorderStatus = {
  state: "waiting",
  encoder: null,
  message: "Website demo: recording only works in the desktop app.",
  audioWarning: null,
  hotkeyError: null,
};

export async function recorderStatus(): Promise<RecorderStatus> {
  return isDesktop ? tauriInvoke<RecorderStatus>("recorder_status") : DEMO_STATUS;
}

async function listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
  if (!isDesktop) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

export const onRecorderStatus = (cb: (s: RecorderStatus) => void) => listen("recorder-status", cb);
export const onClipSaved = (cb: (c: ClipInfo) => void) => listen("clip-saved", cb);
export const onClipFailed = (cb: (msg: string) => void) => listen("clip-failed", cb);

export async function saveClipNow(): Promise<void> {
  if (isDesktop) await tauriInvoke<void>("save_clip_now");
}

export async function listClips(): Promise<ClipInfo[]> {
  return isDesktop ? tauriInvoke<ClipInfo[]>("list_clips") : [];
}

export async function deleteClip(path: string): Promise<void> {
  if (isDesktop) await tauriInvoke<void>("delete_clip", { path });
}

export async function openClip(path: string): Promise<void> {
  if (isDesktop) await tauriInvoke<void>("open_clip", { path });
}

export async function revealClip(path: string): Promise<void> {
  if (isDesktop) await tauriInvoke<void>("reveal_clip", { path });
}

export async function listAudioApps(): Promise<AudioApp[]> {
  return isDesktop ? tauriInvoke<AudioApp[]>("list_audio_apps") : [{ exe: "Discord.exe" }, { exe: "Spotify.exe" }];
}

export async function listMicDevices(): Promise<string[]> {
  return isDesktop ? tauriInvoke<string[]>("list_mic_devices") : [];
}

/** URL the UI can load a local thumbnail from (desktop app only). */
export function thumbSrc(path: string | null): string | undefined {
  return isDesktop && path ? convertFileSrc(path) : undefined;
}
