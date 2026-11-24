// CrossPOV server (Cloudflare Worker).
//
// GET /api/health
// GET /api/latest-match?region=eu&name=<name>&tag=<tag>
// GET /api/match/<region>/<matchId>
//
// The HenrikDev API key lives only here, as the HENRIK_API_KEY secret.
// Responses are cached at Cloudflare's edge so each match is fetched from
// upstream once, which keeps us inside the free rate limit.

import { fromHenrikV4, type HMatch, type MatchSummary } from "./match.ts";

export interface Env {
  HENRIK_API_KEY?: string;
  /** Optional override, used by tests. */
  HENRIK_BASE?: string;
  ASSETS?: Fetcher;
}

const VERSION = "1";
const REGIONS = new Set(["na", "eu", "ap", "kr", "br", "latam"]);
const LATEST_TTL = 60; // seconds: a new match can appear at any time
const MATCH_TTL = 60 * 60 * 24 * 7; // finished matches never change

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

async function henrik(env: Env, path: string): Promise<unknown> {
  if (!env.HENRIK_API_KEY) throw new HttpError(503, "Server is missing its HenrikDev API key.");
  const base = env.HENRIK_BASE ?? "https://api.henrikdev.xyz";
  const res = await fetch(base + path, { headers: { Authorization: env.HENRIK_API_KEY, Accept: "application/json" } });
  if (res.ok) return res.json();
  if (res.status === 404) throw new HttpError(404, "No matches found for that Riot ID in that region.");
  if (res.status === 429) throw new HttpError(429, "Match data is busy right now. Try again in a minute.");
  if (res.status === 401 || res.status === 403) throw new HttpError(503, "The server's HenrikDev API key was rejected.");
  throw new HttpError(502, `Match data service error (${res.status}).`);
}

/** Runs `load` once per cache key per TTL, using Cloudflare's edge cache. */
async function cached(key: string, ttl: number, ctx: ExecutionContext | undefined, load: () => Promise<unknown>): Promise<Response> {
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const cacheKey = new Request(`https://cache.crosspov.internal/${VERSION}/${key}`);
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) return hit;
  const res = json(await load(), 200, ttl);
  if (cache) {
    const put = cache.put(cacheKey, res.clone());
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

async function latestMatch(url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const region = (url.searchParams.get("region") ?? "").toLowerCase();
  const name = (url.searchParams.get("name") ?? "").trim();
  const tag = (url.searchParams.get("tag") ?? "").trim().replace(/^#/, "");
  if (!REGIONS.has(region)) throw new HttpError(400, "Region must be one of: na, eu, ap, kr, br, latam.");
  if (!validRiotId(name, tag)) throw new HttpError(400, "Enter a Riot ID like Name#TAG.");

  const key = `latest/${region}/${encodeURIComponent(name.toLowerCase())}/${encodeURIComponent(tag.toLowerCase())}`;
  return cached(key, LATEST_TTL, ctx, async () => {
    const path = `/valorant/v4/matches/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=1`;
    const body = (await henrik(env, path)) as { data?: HMatch[] };
    const first = body.data?.[0];
    if (!first) throw new HttpError(404, "No recent matches found.");
    const match: MatchSummary = fromHenrikV4(first);
    return { match };
  });
}

async function matchById(region: string, id: string, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!REGIONS.has(region)) throw new HttpError(400, "Unknown region.");
  if (!MATCH_ID.test(id)) throw new HttpError(400, "That isn't a match id.");
  return cached(`match/${id.toLowerCase()}`, MATCH_TTL, ctx, async () => {
    const body = (await henrik(env, `/valorant/v4/match/${region}/${id}`)) as { data?: HMatch };
    if (!body.data) throw new HttpError(404, "Match not found.");
    return { match: fromHenrikV4(body.data) };
  });
}

export async function handleApi(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-max-age": "86400" },
    });
  }
  if (request.method !== "GET") return json({ error: "Only GET is supported." }, 405);
  try {
    if (url.pathname === "/api/health") {
      return json({ ok: true, version: VERSION, matchData: Boolean(env.HENRIK_API_KEY) });
    }
    if (url.pathname === "/api/latest-match") return await latestMatch(url, env, ctx);
    const m = url.pathname.match(/^\/api\/match\/([a-z]+)\/([^/]+)$/);
    if (m) return await matchById(m[1], m[2], env, ctx);
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("unhandled", err);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    // Everything else is the demo website.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
