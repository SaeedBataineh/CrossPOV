// Shape must match `Settings` in src-tauri/src/settings.rs (camelCase JSON).
export type Resolution = "native" | "1440p" | "1080p" | "720p";
export type Quality = "low" | "medium" | "high" | "max";
export type Encoder = "auto" | "nvenc" | "amf" | "qsv" | "x264";
export type Container = "mp4" | "mkv";
export type DownloadQuality = "source" | "1080p" | "720p";

export interface Settings {
  // Recording
  fps: number;
  resolution: Resolution;
  quality: Quality;
  encoder: Encoder;
  format: Container;
  // Hotkey and replay buffer
  hotkey: string;
  bufferSeconds: number;
  clipSound: boolean;
  // Audio
  gameAudio: boolean;
  microphone: boolean;
  micDevice: string;
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
  fps: 60,
  resolution: "1080p",
  quality: "high",
  encoder: "auto",
  format: "mp4",
  hotkey: "F9",
  bufferSeconds: 60,
  clipSound: true,
  gameAudio: true,
  microphone: false,
  micDevice: "default",
  separateTracks: true,
  streamerAuto: true,
  clipKilledYou: true,
  clipYouKilled: true,
  clipWholeRound: false,
  secondsBefore: 5,
  secondsAfter: 5,
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
