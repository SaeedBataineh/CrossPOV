// Shape must match `Settings` in src-tauri/src/settings.rs (camelCase JSON).
export type Resolution = "native" | "1440p" | "1080p" | "720p";
export type Quality = "low" | "medium" | "high" | "max";
export type Encoder = "auto" | "nvenc" | "amf" | "qsv" | "cpu";
export type Container = "mp4" | "mkv";
export type DownloadQuality = "source" | "1080p" | "720p";
export type AudioMode = "game" | "desktop";

/** An extra app whose sound goes into clips, e.g. Discord. */
export interface AppAudio {
  exe: string;
  enabled: boolean;
  volume: number; // 0-200
}

export const REGIONS = [
  { value: "eu", label: "Europe" },
  { value: "na", label: "North America" },
  { value: "ap", label: "Asia Pacific" },
  { value: "kr", label: "Korea" },
  { value: "br", label: "Brazil" },
  { value: "latam", label: "Latin America" },
] as const;

/** A game you added: its program file name and what to call it. */
export interface CustomGame {
  exe: string;
  name: string;
}

export interface Settings {
  // Account
  /** "Name#TAG", used only to look up your own matches. */
  riotId: string;
  region: string;
  serverUrl: string;
  // Recording
  fps: number;
  resolution: Resolution;
  quality: Quality;
  encoder: Encoder;
  format: Container;
  // Which games to record
  /** Any app running fullscreen counts as a game. */
  recordFullscreen: boolean;
  customGames: CustomGame[];
  /** Programs never recorded (exe names). */
  ignoredGames: string[];
  // Hotkey and replay buffer
  hotkey: string;
  bufferSeconds: number;
  clipSound: boolean;
  // Audio
  audioMode: AudioMode;
  gameAudio: boolean;
  gameVolume: number;
  apps: AppAudio[];
  microphone: boolean;
  micDevice: string;
  micVolume: number;
  micNoiseSuppression: boolean;
  separateTracks: boolean;
  // Streamer clips
  streamerAuto: boolean;
  clipKilledYou: boolean;
  clipYouKilled: boolean;
  clipWholeRound: boolean;
  secondsBefore: number;
  secondsAfter: number;
  downloadQuality: DownloadQuality;
  sideBySide: boolean;
  grabAfterMatch: boolean;
  searchArchives: boolean;
  searchYoutubeKick: boolean;
  vodWaitHours: number;
  // Storage
  clipFolder: string;
  storageLimitGb: number; // 0 = no limit
  pruneOldest: boolean;
  // App
  startWithWindows: boolean;
  minimizeToTray: boolean;
  notifications: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  riotId: "",
  region: "eu",
  serverUrl: "https://crosspov.com",
  fps: 60,
  resolution: "1080p",
  quality: "high",
  encoder: "auto",
  format: "mp4",
  recordFullscreen: true,
  customGames: [],
  ignoredGames: [],
  hotkey: "F9",
  bufferSeconds: 60,
  clipSound: true,
  audioMode: "game",
  gameAudio: true,
  gameVolume: 100,
  apps: [],
  microphone: false,
  micDevice: "default",
  micVolume: 100,
  micNoiseSuppression: false,
  separateTracks: true,
  streamerAuto: true,
  clipKilledYou: true,
  clipYouKilled: true,
  clipWholeRound: false,
  secondsBefore: 60,
  secondsAfter: 60,
  downloadQuality: "source",
  sideBySide: true,
  grabAfterMatch: true,
  searchArchives: true,
  searchYoutubeKick: true,
  vodWaitHours: 48,
  clipFolder: "",
  storageLimitGb: 50,
  pruneOldest: true,
  startWithWindows: true,
  minimizeToTray: true,
  notifications: true,
};

const BASE_MBPS: Record<Quality, number> = { low: 8, medium: 15, high: 25, max: 50 };
const RES_FACTOR: Record<Resolution, number> = { native: 1.3, "1440p": 1.5, "1080p": 1, "720p": 0.6 };

/** Rough bitrate the recorder will target; also used for the size estimate in Settings. */
export function targetMbps(s: Pick<Settings, "quality" | "resolution" | "fps">): number {
  const fpsFactor = Math.max(0.6, Math.sqrt(s.fps / 60));
  return BASE_MBPS[s.quality] * RES_FACTOR[s.resolution] * fpsFactor;
}

export function estimateClipMb(s: Settings): number {
  return (targetMbps(s) * s.bufferSeconds) / 8;
}
