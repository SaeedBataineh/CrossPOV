import { useCallback, useEffect, useState } from "react";
import {
  listClips,
  onClipFailed,
  onClipSaved,
  onRecorderStatus,
  recorderStatus,
  type ClipInfo,
  type RecorderStatus,
} from "./backend";

export interface Toast {
  id: number;
  text: string;
  tone: "good" | "bad" | "info";
}

/** Live recorder status, the clip list, and toasts for saved/failed clips. */
export function useRecorder() {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [clips, setClips] = useState<ClipInfo[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);

  const refreshClips = useCallback(() => {
    listClips().then(setClips, () => setClips([]));
  }, []);

  const notify = useCallback((text: string, tone: Toast["tone"]) => {
    setToast({ id: Date.now(), text, tone });
  }, []);

  useEffect(() => {
    let alive = true;
    const unlisten: Array<() => void> = [];
    recorderStatus().then((s) => alive && setStatus(s));
    refreshClips();
    onRecorderStatus((s) => setStatus(s)).then((u) => unlisten.push(u));
    onClipSaved((c) => {
      setClips((prev) => [c, ...prev.filter((p) => p.path !== c.path)]);
      notify(`Clip saved: ${c.name}`, "good");
    }).then((u) => unlisten.push(u));
    onClipFailed((msg) => notify(msg, "bad")).then((u) => unlisten.push(u));
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
    };
  }, [refreshClips, notify]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return { status, clips, refreshClips, toast, notify };
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function formatDuration(sec: number | null): string {
  if (sec == null) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
