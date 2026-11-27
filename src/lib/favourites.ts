import { useSyncExternalStore } from "react";

/** Starred clips, by file path. Kept on this PC (localStorage), like the rest of the app's local state. */
const KEY = "crosspov.favourites";
const listeners = new Set<() => void>();
let cache: Set<string> | null = null;

function read(): Set<string> {
  if (cache) return cache;
  try {
    cache = new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]);
  } catch {
    cache = new Set();
  }
  return cache;
}

export function toggleFavourite(path: string) {
  const next = new Set(read());
  if (next.has(path)) next.delete(path);
  else next.add(path);
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    /* storage blocked: the star still works until the app closes */
  }
  for (const l of listeners) l();
}

/** The set of starred clip paths; re-renders when it changes. */
export function useFavourites(): Set<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    read,
  );
}
