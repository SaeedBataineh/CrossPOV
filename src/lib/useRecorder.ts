import { useCallback, useEffect, useRef, useState } from "react";
import {
  listClips,
  onClipFailed,
  onClipSaved,
  onClipsChanged,
  killsLabel,
  onRecorderStatus,
  recorderStatus,
  type ClipInfo,
  type RecorderStatus,
} from "./backend";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  tone: "good" | "bad" | "info";
  /** Buttons in the toast (Undo, Open...). Clicking one closes the toast. */
  actions?: ToastAction[];
  /** How long it stays, in ms (default 4 s; a little longer with buttons). */
  ms?: number;
  /** Runs when the toast closes without one of its buttons being clicked (timed out or replaced). */
  onExpire?: () => void;
}

export type ShowToast = (t: Omit<Toast, "id">) => void;

/**
 * Live recorder status, the clip list, and toasts. `onOpenClip` is what the
 * "Open" button on a "Clip saved" toast does.
 */
export function useRecorder(onOpenClip?: (c: ClipInfo) => void) {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [clips, setClips] = useState<ClipInfo[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  /** The toast on screen, outside React state so closing it runs `onExpire` exactly once. */
  const current = useRef<Toast | null>(null);
  const openClip = useRef(onOpenClip);
  openClip.current = onOpenClip;

  const refreshClips = useCallback(() => {
    listClips().then(setClips, () => setClips([]));
  }, []);

  const show = useCallback<ShowToast>((t) => {
    const prev = current.current;
    const next = { ...t, id: Date.now() + Math.random() };
    current.current = next;
    setToast(next);
    prev?.onExpire?.();
  }, []);

  const notify = useCallback((text: string, tone: Toast["tone"]) => show({ text: text.replace(/^Error: /, ""), tone }), [show]);

  /** Closes `t`; `expired` runs its onExpire (it timed out rather than a button being clicked). */
  const close = useCallback((t: Toast, expired: boolean) => {
    if (current.current?.id !== t.id) return;
    current.current = null;
    setToast(null);
    if (expired) t.onExpire?.();
  }, []);

  const act = useCallback((t: Toast, a: ToastAction) => {
    close(t, false);
    a.run();
  }, [close]);

  useEffect(() => {
    let alive = true;
    const unlisten: Array<() => void> = [];
    recorderStatus().then((s) => alive && setStatus(s));
    refreshClips();
    onRecorderStatus((s) => setStatus(s)).then((u) => unlisten.push(u));
    onClipSaved((c) => {
      setClips((prev) => [c, ...prev.filter((p) => p.path !== c.path)]);
      show({
        text: c.kills ? `Auto-clip saved · ${killsLabel(c.kills)}${c.map ? ` on ${c.map}` : ""}` : "Clip saved",
        tone: "good",
        ms: 6000,
        actions: [
          ...(openClip.current ? [{ label: "Open", run: () => openClip.current?.(c) }] : []),
          { label: "Copy for Discord", run: () => void import("../components/ui").then((m) => m.copyClipForDiscord(c, notify)) },
        ],
      });
    }).then((u) => unlisten.push(u));
    onClipFailed((msg) => notify(msg, "bad")).then((u) => unlisten.push(u));
    onClipsChanged(() => refreshClips()).then((u) => unlisten.push(u));
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
    };
  }, [refreshClips, notify, show]);

  /** Paused while the pointer is on the toast, so there's time to reach its buttons. */
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!toast || held) return;
    const t = setTimeout(() => close(toast, true), toast.ms ?? (toast.actions?.length ? 6000 : 4000));
    return () => clearTimeout(t);
  }, [toast, held, close]);

  return { status, clips, refreshClips, toast, notify, show, act, dismiss: (t: Toast) => close(t, true), setHeld };
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
