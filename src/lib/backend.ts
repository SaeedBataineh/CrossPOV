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
