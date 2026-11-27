import { useSyncExternalStore } from "react";

/** Names you gave your clips, by file path. Kept on this PC (localStorage), like favourites. */
const KEY = "crosspov.titles";
const listeners = new Set<() => void>();
let cache: Record<string, string> | null = null;

function read(): Record<string, string> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    cache = {};
  }
  return cache;
}

/** The name you gave this clip, if any. */
export function customTitle(path: string): string | undefined {
  return read()[path];
}

/** Renames a clip in the app (the file keeps its name). An empty name goes back to the automatic one. */
export function setTitle(path: string, title: string) {
  const next = { ...read() };
  if (title.trim()) next[path] = title.trim();
  else delete next[path];
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the name still shows until the app closes */
  }
  for (const l of listeners) l();
}

/** Re-renders the caller when a clip is renamed. */
export function useTitles(): Record<string, string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    read,
  );
}
