import { convertFileSrc } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

// The same UI runs inside the desktop app (Tauri) and as a plain website
// (the public demo for Riot's review). In the browser there is no Rust
// backend, so settings fall back to localStorage and desktop-only actions
// are disabled.
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const LOCAL_KEY = "crosspov.settings";

/** Website demo: sample clips, matches and streamers, loaded only in the browser. */
const demo = () => import("./demoData");
const NEEDS_APP = (what: string) => new Error(`${what} needs the CrossPOV desktop app. This is the website demo.`);

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function loadSettings(): Promise<Settings> {
  if (isDesktop) return tauriInvoke<Settings>("get_settings");
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const base = { ...DEFAULT_SETTINGS, riotId: (await demo()).DEMO_RIOT_ID, clipFolder: "C:\\Users\\you\\Videos\\CrossPOV" };
    return raw ? { ...base, ...JSON.parse(raw) } : base;
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

/** Asks for a game's program (.exe) and returns its file name, e.g. "Game.exe". */
export async function pickGameExe(): Promise<string | null> {
  if (!isDesktop) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, filters: [{ name: "Games and programs", extensions: ["exe"] }] });
  if (typeof picked !== "string") return null;
  const exe = picked.split(/[\\/]/).pop() ?? null;
  // Keep its icon now, while we know where the program is.
  if (exe) void appIcon(exe, picked);
  return exe;
}

const icons = new Map<string, Promise<string | null>>();

/** A program's own icon (from its .exe) as an image URL, or null if unknown. */
export function appIcon(exe: string, path?: string): Promise<string | null> {
  if (!isDesktop) return Promise.resolve(null);
  const key = exe.toLowerCase();
  const cached = icons.get(key);
  if (cached && !path) return cached;
  const p = tauriInvoke<ArrayBuffer>("app_icon", { exe, path: path ?? null })
    .then((buf) => (buf.byteLength ? URL.createObjectURL(new Blob([buf], { type: "image/png" })) : null))
    .catch(() => null)
    .then((url) => {
      // Not found yet: ask again next time (the program may be open by then).
      if (!url) icons.delete(key);
      return url;
    });
  icons.set(key, p);
  return p;
}

/** Names of the games CrossPOV knows without being told. */
export async function knownGames(): Promise<string[]> {
  if (isDesktop) return tauriInvoke<string[]>("known_games");
  return ["VALORANT", "Counter-Strike 2", "Fortnite", "Apex Legends", "League of Legends", "Overwatch 2", "Rainbow Six Siege", "Call of Duty", "Rocket League", "Minecraft"];
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
  /** The game being recorded, and how it was found. */
  game?: { exe: string; name: string; found: "known" | "yours" | "fullscreen" } | null;
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
  /** Your clips (newer ones): the game it was recorded in. */
  game?: string | null;
  /** Streamer clips only (newer clips): which match, and where the clip starts in the match and in their VOD, in seconds. */
  matchId?: string | null;
  matchStartSec?: number | null;
  vodUrl?: string | null;
  vodStartSec?: number | null;
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
/** The window was reopened from the tray after its page slept: anything may have changed meanwhile. */
export const onWindowAwake = (cb: () => void) => listen<null>("window-awake", () => cb());

export async function saveClipNow(): Promise<void> {
  if (isDesktop) await tauriInvoke<void>("save_clip_now");
}

export async function listClips(): Promise<ClipInfo[]> {
  return isDesktop ? tauriInvoke<ClipInfo[]>("list_clips") : (await demo()).demoClips();
}

export async function deleteClip(path: string): Promise<void> {
  if (!isDesktop) throw NEEDS_APP("Deleting clips");
  await tauriInvoke<void>("delete_clip", { path });
}

/** A URL the app's own player can play, or null when the clip must open outside (MKV, website demo). */
export async function clipVideoSrc(path: string): Promise<string | null> {
  if (!isDesktop || !/\.mp4$/i.test(path)) return null;
  return convertFileSrc(await tauriInvoke<string>("play_clip_in_app", { path }));
}

/** A short report about what the app is doing, for problem reports. */
export async function diagnostics(): Promise<string> {
  if (!isDesktop) return `CrossPOV website demo\n${navigator.userAgent}`;
  return tauriInvoke<string>("diagnostics");
}

export async function openClip(path: string): Promise<void> {
  if (!isDesktop) throw NEEDS_APP("Playing clips");
  await tauriInvoke<void>("open_clip", { path });
}

/** Saves `start`..`end` (seconds) as a new clip next to the original. `exact`: frame-exact (re-encodes, a few seconds). */
export async function trimClip(path: string, start: number, end: number, exact: boolean): Promise<ClipInfo> {
  if (!isDesktop) throw NEEDS_APP("Cutting clips");
  return tauriInvoke<ClipInfo>("trim_clip", { path, start, end, exact });
}

/** Makes a copy that fits Discord's free upload limit and puts it on the clipboard. Returns its size in bytes. */
export async function copyForDiscord(path: string, start: number, end: number): Promise<number> {
  if (!isDesktop) throw NEEDS_APP("Copy for Discord");
  return tauriInvoke<number>("copy_for_discord", { path, start, end });
}

export async function revealClip(path: string): Promise<void> {
  if (!isDesktop) throw NEEDS_APP("Opening the clip folder");
  await tauriInvoke<void>("reveal_clip", { path });
}

export async function listAudioApps(): Promise<AudioApp[]> {
  return isDesktop ? tauriInvoke<AudioApp[]>("list_audio_apps") : [{ exe: "Discord.exe" }, { exe: "Spotify.exe" }, { exe: "chrome.exe" }];
}

export async function listMicDevices(): Promise<string[]> {
  return isDesktop ? tauriInvoke<string[]>("list_mic_devices") : ["Headset Microphone", "USB Microphone"];
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
  /** Your matches' real region, when it isn't the one in Settings, e.g. "na". */
  regionHint?: string | null;
}

export async function listMatches(): Promise<MatchSummary[]> {
  return isDesktop ? tauriInvoke<MatchSummary[]>("list_matches") : (await demo()).demoMatches();
}

export async function matchesStatus(): Promise<MatchesStatus> {
  return isDesktop ? tauriInvoke<MatchesStatus>("matches_status") : { lastCheckMs: Date.now() - 120_000, error: null, configured: true };
}

export async function checkMatchesNow(): Promise<MatchSummary> {
  if (!isDesktop) return (await demo()).demoMatches()[0];
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
  channel: { id: string; login: string; displayName: string; avatar?: string | null };
  vod: { id: string; url: string; startedAt: string; durationSec: number; offsetSec: number; live: boolean } | null;
  status: StreamerStatus;
  clips: number;
  fights: number;
  message: string | null;
  manual: boolean;
  /** A linked channel whose VOD is still being compared with this match. */
  checking?: boolean;
  /** Rough seconds until all their clips are saved. */
  etaSec?: number | null;
}

/** A stream the scoreboard scanner saw in this match; the user says which player it was. */
export interface SuggestedStreamer {
  login: string;
  displayName?: string | null;
  /** Team id of the streamer in the match. */
  team: string;
  /** Their measured broadcast delay, used to place clips. */
  delaySec?: number | null;
}

export interface MatchStreamers {
  matchId: string;
  checkedMs: number | null;
  error: string | null;
  players: StreamerPlayer[];
  finished: boolean;
  suggested?: SuggestedStreamer[];
}

export async function streamerStates(): Promise<MatchStreamers[]> {
  return isDesktop ? tauriInvoke<MatchStreamers[]>("streamer_states") : (await demo()).demoStreamers();
}

export async function checkStreamersNow(matchId: string): Promise<MatchStreamers> {
  if (!isDesktop) {
    const found = (await demo()).demoStreamers().find((s) => s.matchId === matchId);
    if (found) return { ...found, checkedMs: Date.now() };
    throw NEEDS_APP("Checking this match");
  }
  return tauriInvoke<MatchStreamers>("check_streamers_now", { matchId });
}

export async function addStreamerChannel(matchId: string, puuid: string, login: string, delaySec?: number | null): Promise<MatchStreamers> {
  if (!isDesktop) throw NEEDS_APP("Adding a channel");
  return tauriInvoke<MatchStreamers>("add_streamer_channel", { matchId, puuid, login, delaySec: delaySec ?? null });
}

export const onStreamersUpdated = (cb: (s: MatchStreamers) => void) => listen("streamers-updated", cb);

/** A streamer found in a match, as the server reports it (website demo). */
export interface WebStreamer {
  puuid: string;
  channel: { login: string; displayName: string; avatar?: string | null };
  vod: { url: string; offsetSec: number; durationSec: number; live: boolean } | null;
}

/** Website demo only: which players in a match were live on Twitch. */
export async function lookupStreamers(match: MatchSummary, mePuuid?: string): Promise<WebStreamer[]> {
  const q = mePuuid ? `?${new URLSearchParams({ me: mePuuid })}` : "";
  const res = await fetch(`/api/match/${match.region || "eu"}/${match.id}/streamers${q}`);
  const body = (await res.json().catch(() => ({}))) as { streamers?: WebStreamer[]; error?: string };
  if (!res.ok || !body.streamers) throw new Error(body.error ?? `Server error (${res.status})`);
  return body.streamers;
}

/** How many times two players killed each other in a match. */
export function fightsBetween(m: MatchSummary, a: string, b: string): number {
  return m.kills.filter((k) => (k.killer === a && k.victim === b) || (k.killer === b && k.victim === a)).length;
}

// ---------- Auto-update ----------

export type UpdateStatus =
  | { state: "checking" }
  | { state: "upToDate"; offline: boolean }
  | { state: "waiting"; version: string }
  | { state: "downloading"; version: string; downloaded: number; total: number | null }
  | { state: "installing"; version: string }
  | { state: "failed"; version: string; message: string };

export async function updateStatus(): Promise<UpdateStatus> {
  return isDesktop ? tauriInvoke<UpdateStatus>("update_status") : { state: "upToDate", offline: false };
}

export async function retryUpdate(): Promise<void> {
  if (isDesktop) await tauriInvoke<void>("retry_update");
}

export const onUpdateStatus = (cb: (s: UpdateStatus) => void) => listen("update-status", cb);

// ---------- Channels you linked (kept on this PC only) ----------

export interface LinkedChannel {
  puuid: string;
  login: string;
  /** e.g. "Enemy · Raze": the player when you linked them. Riot names are never stored. */
  label: string;
  addedMs: number;
  /** Later matches where the link found them live. */
  seen: number;
}

export async function linkedChannels(): Promise<LinkedChannel[]> {
  if (isDesktop) return tauriInvoke<LinkedChannel[]>("linked_channels");
  return [{ puuid: "demo", login: "nightowl_val", label: "Enemy · Clove", addedMs: Date.now() - 2 * 86_400_000, seen: 1 }];
}

export async function removeLinkedChannel(puuid: string): Promise<void> {
  if (!isDesktop) throw new Error("Removing links needs the CrossPOV desktop app. This is the website demo.");
  await tauriInvoke<void>("remove_linked_channel", { puuid });
}
