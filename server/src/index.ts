// CrossPOV server (Cloudflare Worker).
//
// GET /api/health
// GET /api/version         newest app release, for the website
// GET /api/latest-match?region=eu&name=<name>&tag=<tag>
// GET /api/match/<region>/<matchId>
// GET /api/match/<region>/<matchId>/streamers?me=<puuid>
//
// The HenrikDev API key lives only here, as the HENRIK_API_KEY secret.
// Responses are cached at Cloudflare's edge so each match is fetched from
// upstream once, which keeps us inside the free rate limit.

import { fromHenrikV4, type HMatch, type MatchSummary } from "./match.ts";
import { clientVersion, LATEST_JSON, outdated, parseLatest, type Latest } from "./appVersion.ts";
import { checkChannel, findStreamers, TwitchError, type TwitchEnv } from "./twitch.ts";

export interface Env extends TwitchEnv {
  HENRIK_API_KEY?: string;
  /** Optional override, used by tests. */
  HENRIK_BASE?: string;
  /** Optional override of the release feed, used by tests. */
  LATEST_JSON_URL?: string;
  ASSETS?: Fetcher;
}

const VERSION = "1";
const REGIONS = new Set(["na", "eu", "ap", "kr", "br", "latam"]);
const LATEST_TTL = 60; // seconds: a new match can appear at any time
const MATCH_TTL = 60 * 60 * 24 * 7; // finished matches never change
const STREAMERS_TTL = 5 * 60; // VODs appear and grow, so re-check every few minutes

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

/** Riot names are 3-16 characters, tags 3-5; we allow a little slack but no path tricks. */
export function validRiotId(name: string, tag: string): boolean {
  return /^[^/\\?#%]{1,32}$/u.test(name) && /^[\p{L}\p{N}]{1,8}$/u.test(tag);
}

const MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * When HenrikDev says "too many requests", every request waits out the
 * cooldown here instead of piling on (which would only extend the limit).
 * Per server instance; apps back off on their own too.
 */
let henrikPausedUntil = 0;
const BUSY = "Match data is busy right now. CrossPOV will try again in a few minutes.";

export function resetHenrikPause(): void {
  henrikPausedUntil = 0;
}

async function henrik(env: Env, path: string): Promise<unknown> {
  if (!env.HENRIK_API_KEY) throw new HttpError(503, "Server is missing its HenrikDev API key.");
  if (Date.now() < henrikPausedUntil) throw new HttpError(429, BUSY);
  const base = env.HENRIK_BASE ?? "https://api.henrikdev.xyz";
  const res = await fetch(base + path, { headers: { Authorization: env.HENRIK_API_KEY, Accept: "application/json" } });
  if (res.ok) return res.json();
  if (res.status === 404) throw new HttpError(404, "No matches found for that Riot ID in that region.");
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || 30;
    henrikPausedUntil = Date.now() + Math.min(Math.max(wait, 5), 120) * 1000;
    throw new HttpError(429, BUSY);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(503, "The server's HenrikDev API key was rejected.");
  throw new HttpError(502, `Match data service error (${res.status}).`);
}

/** Runs `load` once per cache key per TTL, using Cloudflare's edge cache. */
/** Loads already running in this server instance, so the same thing is never fetched twice at once. */
const inFlight = new Map<string, Promise<unknown>>();
/** How long a last-known answer may stand in when match data is busy. */
const STALE_TTL = 30 * 60;

/**
 * Edge-cached data. Concurrent requests for the same key share one load,
 * and if the load fails because match data is busy, the last answer from
 * the past half hour is served instead of an error.
 */
async function cachedData<T>(key: string, ttl: number, ctx: ExecutionContext | undefined, load: () => Promise<T>): Promise<T> {
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const cacheKey = new Request(`https://cache.crosspov.internal/${VERSION}/${key}`);
  const staleKey = new Request(`https://cache.crosspov.internal/${VERSION}/stale/${key}`);
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) return (await hit.json()) as T;
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const job = (async () => {
    try {
      const data = await load();
      if (cache) {
        const puts = Promise.all([
          cache.put(cacheKey, json(data, 200, ttl)),
          ttl < STALE_TTL ? cache.put(staleKey, json(data, 200, STALE_TTL)) : Promise.resolve(),
        ]);
        if (ctx) ctx.waitUntil(puts);
        else await puts;
      }
      return data;
    } catch (err) {
      if (err instanceof HttpError && err.status === 429 && cache) {
        const stale = await cache.match(staleKey);
        if (stale) return (await stale.json()) as T;
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

async function latestMatch(url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const region = (url.searchParams.get("region") ?? "").toLowerCase();
  const name = (url.searchParams.get("name") ?? "").trim();
  const tag = (url.searchParams.get("tag") ?? "").trim().replace(/^#/, "");
  if (!REGIONS.has(region)) throw new HttpError(400, "Region must be one of: na, eu, ap, kr, br, latam.");
  if (!validRiotId(name, tag)) throw new HttpError(400, "Enter a Riot ID like Name#TAG.");

  const key = `latest/${region}/${encodeURIComponent(name.toLowerCase())}/${encodeURIComponent(tag.toLowerCase())}`;
  const body = await cachedData(key, LATEST_TTL, ctx, async () => {
    const path = `/valorant/v4/matches/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=1`;
    const res = (await henrik(env, path)) as { data?: HMatch[] };
    const first = res.data?.[0];
    if (!first) throw new HttpError(404, "No recent matches found.");
    const match: MatchSummary = fromHenrikV4(first);
    return { match };
  });
  return json(body, 200, LATEST_TTL);
}

async function loadMatch(region: string, id: string, env: Env, ctx?: ExecutionContext): Promise<MatchSummary> {
  if (!REGIONS.has(region)) throw new HttpError(400, "Unknown region.");
  if (!MATCH_ID.test(id)) throw new HttpError(400, "That isn't a match id.");
  return cachedData(`match/${id.toLowerCase()}`, MATCH_TTL, ctx, async () => {
    const res = (await henrik(env, `/valorant/v4/match/${region}/${id}`)) as { data?: HMatch };
    if (!res.data) throw new HttpError(404, "Match not found.");
    return fromHenrikV4(res.data);
  });
}

async function streamers(region: string, id: string, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const me = url.searchParams.get("me") ?? undefined;
  if (me !== undefined && !/^[\w-]{1,100}$/.test(me)) throw new HttpError(400, "Bad player id.");
  const match = await loadMatch(region, id, env, ctx);
  // One Twitch check per match for everyone: the result covers all ten
  // players and is cached; each caller just has themselves filtered out.
  // Recent matches are re-checked every few minutes (VODs appear and grow);
  // older ones hardly change, so they're kept longer.
  const ageMs = Date.now() - Date.parse(match.startedAt) - match.lengthMs;
  const ttl = ageMs > 6 * 3_600_000 ? 6 * 3600 : STREAMERS_TTL;
  const all = await cachedData(`streamers/${id.toLowerCase()}`, ttl, ctx, async () => {
    try {
      return { matchId: match.id, checkedAt: new Date().toISOString(), streamers: await findStreamers(env, match) };
    } catch (err) {
      if (err instanceof TwitchError) throw new HttpError(503, err.message);
      throw err;
    }
  });
  return json({ ...all, streamers: all.streamers.filter((s) => s.puuid !== me) }, 200, ttl);
}

async function channel(region: string, id: string, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const login = (url.searchParams.get("login") ?? "").trim().toLowerCase();
  const puuid = url.searchParams.get("puuid") ?? "";
  if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new HttpError(400, "That isn't a Twitch channel name.");
  if (!/^[\w-]{1,100}$/.test(puuid)) throw new HttpError(400, "Bad player id.");
  const match = await loadMatch(region, id, env, ctx);
  try {
    return json({ matchId: match.id, checkedAt: new Date().toISOString(), streamers: await checkChannel(env, match, puuid, login) });
  } catch (err) {
    if (err instanceof TwitchError) throw new HttpError(err.message.startsWith("There's no") ? 404 : 503, err.message);
    throw err;
  }
}

// Best-effort limit per visitor IP (per server instance): keeps a public
// demo from using up the HenrikDev and Twitch quotas. Health is exempt.
const LIMIT_PER_MINUTE = 30;
const hits = new Map<string, number[]>();

export function rateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // never grow without bound
  return recent.length > LIMIT_PER_MINUTE;
}

const LATEST_TTL_S = 10 * 60;

/** The newest app release, cached for a few minutes. Null if GitHub can't be reached. */
async function latestRelease(env: Env, ctx?: ExecutionContext): Promise<Latest | null> {
  try {
    return await cachedData("latest-release", LATEST_TTL_S, ctx, async () => {
      const res = await fetch(env.LATEST_JSON_URL ?? LATEST_JSON, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`release feed ${res.status}`);
      const latest = parseLatest(await res.json());
      if (!latest) throw new Error("release feed unreadable");
      return latest;
    });
  } catch {
    return null; // Never lock people out because GitHub is down.
  }
}

export async function handleApi(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip && url.pathname !== "/api/health" && rateLimited(ip)) {
    return json({ error: "Too many requests. Wait a minute and try again." }, 429);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-max-age": "86400" },
    });
  }
  if (request.method !== "GET") return json({ error: "Only GET is supported." }, 405);
  const client = clientVersion(request.headers.get("user-agent"));
  if (client && url.pathname !== "/api/health") {
    const message = outdated(client, await latestRelease(env, ctx));
    if (message) return json({ error: message, updateRequired: true }, 426);
  }
  try {
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        version: VERSION,
        matchData: Boolean(env.HENRIK_API_KEY),
        twitch: Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
      });
    }
    if (url.pathname === "/api/version") {
      // For the website's download button: the newest release, from the update feed.
      const latest = await latestRelease(env, ctx);
      if (!latest) return json({ error: "Release info isn't available right now." }, 503);
      return json({ version: latest.version, releasedAt: new Date(latest.publishedMs).toISOString() }, 200, 300);
    }
    if (url.pathname === "/api/latest-match") return await latestMatch(url, env, ctx);
    const c = url.pathname.match(/^\/api\/match\/([a-z]+)\/([^/]+)\/channel$/);
    if (c) return await channel(c[1], c[2], url, env, ctx);
    const s = url.pathname.match(/^\/api\/match\/([a-z]+)\/([^/]+)\/streamers$/);
    if (s) return await streamers(s[1], s[2], url, env, ctx);
    const m = url.pathname.match(/^\/api\/match\/([a-z]+)\/([^/]+)$/);
    if (m) return json({ match: await loadMatch(m[1], m[2], env, ctx) }, 200, MATCH_TTL);
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("unhandled", err);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}

const RELEASES = "https://github.com/SaeedBataineh/CrossPOV/releases/latest";

/**
 * Short, permanent download links for the website:
 *   /download            -> the newest single CrossPOV.exe
 *   /download/installer  -> the newest installer (its file name has the version in it)
 */
export async function downloadRedirect(pathname: string, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const path = pathname.replace(/\/+$/, "");
  if (path === "/download") return Response.redirect(`${RELEASES}/download/CrossPOV.exe`, 302);
  if (path !== "/download/installer") return null;
  try {
    const url = await cachedData("installer-url", LATEST_TTL_S, ctx, async () => {
      const res = await fetch(env.LATEST_JSON_URL ?? LATEST_JSON, { headers: { accept: "application/json" } });
      const body = (await res.json()) as { platforms?: Record<string, { url?: string }> };
      const u = body.platforms?.["windows-x86_64"]?.url;
      if (!u || !u.startsWith("https://github.com/SaeedBataineh/CrossPOV/releases/download/")) throw new Error("no installer");
      return u;
    });
    return Response.redirect(url, 302);
  } catch {
    return Response.redirect(RELEASES, 302); // the release page lists it
  }
}

/** Browser protections for the website: only our own code runs, nobody can frame it. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

/** "https://crosspov.com//riot.txt" -> "https://crosspov.com/riot.txt"; null if nothing to change. */
export function collapseSlashes(url: URL): string | null {
  const path = url.pathname.replace(/\/{2,}/g, "/");
  if (path === url.pathname) return null;
  const to = new URL(url.toString());
  to.pathname = path;
  return to.toString();
}

/** www.crosspov.com/anything -> crosspov.com/anything */
export function wwwRedirect(url: URL): string | null {
  if (!url.hostname.startsWith("www.")) return null;
  const to = new URL(url.toString());
  to.hostname = url.hostname.slice(4);
  return to.toString();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const www = wwwRedirect(url);
    if (www) return Response.redirect(www, 301);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    const dl = await downloadRedirect(url.pathname, env, ctx);
    if (dl) return dl;
    // Everything else is the demo website. "//riot.txt" (as Riot's verifier asks for) serves "/riot.txt".
    if (env.ASSETS) {
      const clean = collapseSlashes(url);
      return withSecurityHeaders(await env.ASSETS.fetch(clean ? new Request(clean, request) : request));
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
