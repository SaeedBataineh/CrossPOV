// Keeps everyone on the newest app. The desktop app sends
// "User-Agent: CrossPOV/<version>". If a newer release has been out for a
// while (long enough for running apps to update themselves), older versions
// get 426 Upgrade Required instead of match data. Browsers (the website demo)
// are never blocked.

/** Where the newest release is described (the same file the app updates from). */
export const LATEST_JSON = "https://github.com/SaeedBataineh/CrossPOV/releases/latest/download/latest.json";
/** Running apps re-check every 3 hours, and wait for VALORANT to close before installing. */
export const GRACE_MS = 6 * 60 * 60 * 1000;

export interface Latest {
  version: string;
  publishedMs: number;
}

/**
 * The app version from a User-Agent: "1.2.3" for CrossPOV/1.2.3, "0.0.0" for
 * builds from before auto-update existed (they sent ureq's default agent),
 * and null for browsers and anything else.
 */
export function clientVersion(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const m = /^CrossPOV\/(\d+\.\d+\.\d+)/.exec(userAgent);
  if (m) return m[1];
  if (/^ureq\//.test(userAgent)) return "0.0.0";
  return null;
}

/** Negative if a < b, 0 if equal, positive if a > b. Plain x.y.z only. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Parses latest.json; null if it isn't usable. */
export function parseLatest(body: unknown): Latest | null {
  const b = body as { version?: unknown; pub_date?: unknown };
  if (typeof b?.version !== "string" || !/^v?\d+\.\d+\.\d+$/.test(b.version)) return null;
  const publishedMs = typeof b.pub_date === "string" ? Date.parse(b.pub_date) : NaN;
  return { version: b.version.replace(/^v/, ""), publishedMs: Number.isFinite(publishedMs) ? publishedMs : 0 };
}

/** The message for an out-of-date app, or null if it may continue. */
export function outdated(client: string | null, latest: Latest | null, now = Date.now()): string | null {
  if (!client || !latest) return null;
  if (compareVersions(client, latest.version) >= 0) return null;
  if (now - latest.publishedMs < GRACE_MS) return null;
  return `This version of CrossPOV is out of date. Restart CrossPOV to update to v${latest.version}.`;
}
