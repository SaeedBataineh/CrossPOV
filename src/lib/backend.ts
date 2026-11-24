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
  /** Streamer clips only. */
  streamer: string | null;
  round: number | null;
  moment: string | null;
  map: string | null;
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

// ---------- Matches (from the CrossPOV server) ----------

export interface MatchPlayer {
  puuid: string;
  name: string;
  tag: string;
  team: string;
  agent: string;
  kills: number;
  deaths: number;
  assists: number;
}

export interface MatchSummary {
  id: string;
  map: string;
  mode: string;
  region: string;
  startedAt: string;
  lengthMs: number;
  teams: { id: string; won: boolean; roundsWon: number }[];
  players: MatchPlayer[];
  rounds: { index: number; winner: string | null; startMs: number | null }[];
  kills: { round: number; atMs: number; inRoundMs: number; killer: string; victim: string; weapon: string | null }[];
}

export interface MatchesStatus {
  lastCheckMs: number | null;
  error: string | null;
  configured: boolean;
}

export async function listMatches(): Promise<MatchSummary[]> {
  return isDesktop ? tauriInvoke<MatchSummary[]>("list_matches") : [];
}

export async function matchesStatus(): Promise<MatchesStatus> {
  return isDesktop ? tauriInvoke<MatchesStatus>("matches_status") : { lastCheckMs: null, error: null, configured: false };
}

export async function checkMatchesNow(): Promise<MatchSummary> {
  return tauriInvoke<MatchSummary>("check_matches_now");
}

export const onMatchFound = (cb: (m: MatchSummary) => void) => listen("match-found", cb);
export const onMatchesStatus = (cb: (s: MatchesStatus) => void) => listen("matches-status", cb);

/**
 * Website demo only: looks up a Riot ID's latest match through this site's
 * own server (same origin), so reviewers can try it without the app.
 */
export async function lookupLatestMatch(riotId: string, region: string): Promise<MatchSummary> {
  const i = riotId.lastIndexOf("#");
  if (i < 1 || i === riotId.length - 1) throw new Error("Enter a Riot ID like Name#TAG.");
  const q = new URLSearchParams({ region, name: riotId.slice(0, i).trim(), tag: riotId.slice(i + 1).trim() });
  const res = await fetch(`/api/latest-match?${q}`);
  const body = (await res.json().catch(() => ({}))) as { match?: MatchSummary; error?: string };
  if (!res.ok || !body.match) throw new Error(body.error ?? `Server error (${res.status})`);
  return body.match;
}

/** Finds the user's own entry in a match from their "Name#TAG". */
export function findMe(m: MatchSummary, riotId: string): MatchPlayer | undefined {
  const i = riotId.lastIndexOf("#");
  if (i < 1) return undefined;
  const name = riotId.slice(0, i).trim().toLowerCase();
  const tag = riotId.slice(i + 1).trim().toLowerCase();
  return m.players.find((p) => p.name.toLowerCase() === name && p.tag.toLowerCase() === tag);
}

// ---------- Streamers (step 4) ----------

export type StreamerStatus = "working" | "clipped" | "noFights" | "noVod" | "subOnly" | "failed";

export interface StreamerPlayer {
  puuid: string;
  name: string;
  channel: { id: string; login: string; displayName: string };
  vod: { id: string; url: string; startedAt: string; durationSec: number; offsetSec: number; live: boolean } | null;
  status: StreamerStatus;
  clips: number;
  fights: number;
  message: string | null;
  manual: boolean;
}

export interface MatchStreamers {
  matchId: string;
  checkedMs: number | null;
  error: string | null;
  players: StreamerPlayer[];
  finished: boolean;
}

export async function streamerStates(): Promise<MatchStreamers[]> {
  return isDesktop ? tauriInvoke<MatchStreamers[]>("streamer_states") : [];
}

export async function checkStreamersNow(matchId: string): Promise<MatchStreamers> {
  return tauriInvoke<MatchStreamers>("check_streamers_now", { matchId });
}

export async function addStreamerChannel(matchId: string, puuid: string, login: string): Promise<MatchStreamers> {
  return tauriInvoke<MatchStreamers>("add_streamer_channel", { matchId, puuid, login });
}

export const onStreamersUpdated = (cb: (s: MatchStreamers) => void) => listen("streamers-updated", cb);
