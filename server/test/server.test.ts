import { test } from "node:test";
import assert from "node:assert/strict";
import { fromHenrikV4, type HMatch } from "../src/match.ts";
import { handleApi, validRiotId } from "../src/index.ts";

const MATCH_ID = "0b6d5e1f-1a2b-4c3d-8e9f-0123456789ab";

/** A small match in HenrikDev v4's shape (fields we don't read are left out). */
const SAMPLE: HMatch = {
  metadata: {
    match_id: MATCH_ID,
    map: { name: "Ascent" },
    queue: { id: "competitive", name: "Competitive" },
    region: "eu",
    started_at: "2026-11-24T19:00:00.000Z",
    game_length_in_ms: 2_100_000,
  },
  players: [
    { puuid: "me", name: "Me", tag: "EUW", team_id: "Blue", agent: { name: "Jett" }, stats: { kills: 20, deaths: 12, assists: 4 } },
    { puuid: "st", name: "streamer_two", tag: "TTV", team_id: "Red", agent: { name: "Omen" }, stats: { kills: 15, deaths: 18, assists: 6 } },
  ],
  teams: [
    { team_id: "Blue", won: true, rounds: { won: 13 } },
    { team_id: "Red", won: false, rounds: { won: 9 } },
  ],
  rounds: [{ id: 0, winning_team: "Blue" }, { id: 1, winning_team: "Red" }, { id: 2, winning_team: null }],
  kills: [
    { round: 1, time_in_match_in_ms: 150_000, time_in_round_in_ms: 40_000, killer: { puuid: "st" }, victim: { puuid: "me" }, weapon: { name: "Vandal" } },
    { round: 0, time_in_match_in_ms: 30_000, time_in_round_in_ms: 25_000, killer: { puuid: "me" }, victim: { puuid: "st" }, weapon: { name: null } },
    { round: 1, time_in_match_in_ms: 130_000, time_in_round_in_ms: 20_000, killer: { puuid: "me" }, victim: { puuid: "st" }, weapon: { name: "Phantom" } },
    // Malformed kill without a victim is dropped.
    { round: 1, time_in_match_in_ms: 140_000, time_in_round_in_ms: 30_000, killer: { puuid: "me" } },
  ],
};

test("converts a HenrikDev match into CrossPOV's format", () => {
  const m = fromHenrikV4(SAMPLE);
  assert.equal(m.id, MATCH_ID);
  assert.equal(m.map, "Ascent");
  assert.equal(m.mode, "Competitive");
  assert.equal(m.players.length, 2);
  assert.deepEqual(m.players[1], { puuid: "st", name: "streamer_two", tag: "TTV", team: "Red", agent: "Omen", kills: 15, deaths: 18, assists: 6 });
  assert.deepEqual(m.teams[0], { id: "Blue", won: true, roundsWon: 13 });
  // Kills sorted by time, bad one dropped.
  assert.deepEqual(m.kills.map((k) => k.atMs), [30_000, 130_000, 150_000]);
  assert.equal(m.kills[0].weapon, null);
  // Round starts derived from kills: match time minus time into the round.
  assert.deepEqual(m.rounds, [
    { index: 0, winner: "Blue", startMs: 5_000 },
    { index: 1, winner: "Red", startMs: 110_000 },
    { index: 2, winner: null, startMs: null },
  ]);
});

test("rejects a match without an id", () => {
  assert.throws(() => fromHenrikV4({ metadata: {} }));
});

test("validates Riot IDs", () => {
  assert.ok(validRiotId("Some Player", "EUW"));
  assert.ok(validRiotId("Ñandú", "1234"));
  assert.ok(!validRiotId("", "EUW"));
  assert.ok(!validRiotId("a/b", "EUW"));
  assert.ok(!validRiotId("name", "E-U"));
});

/** Calls the API with a fake upstream; returns status, body and the upstream calls made. */
async function call(path: string, upstream: (url: string, init?: RequestInit) => Response, env: Record<string, string> = { HENRIK_API_KEY: "test-key" }) {
  const calls: { url: string; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return upstream(url, init);
  }) as typeof fetch;
  try {
    const res = await handleApi(new Request("https://crosspov.test" + path), { HENRIK_BASE: "https://upstream.test", ...env });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("health reports whether match data is configured", async () => {
  const ok = await call("/api/health", () => new Response("{}"));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.matchData, true);
  const missing = await call("/api/health", () => new Response("{}"), {});
  assert.equal(missing.body.matchData, false);
});

test("latest-match calls HenrikDev with the key and returns a summary", async () => {
  const r = await call("/api/latest-match?region=EU&name=Some%20Player&tag=%23EUW", () => Response.json({ status: 200, data: [SAMPLE] }));
  assert.equal(r.status, 200);
  assert.equal((r.body.match as { id: string }).id, MATCH_ID);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "https://upstream.test/valorant/v4/matches/eu/pc/Some%20Player/EUW?size=1");
  assert.equal(r.calls[0].auth, "test-key");
});

test("latest-match explains bad input and upstream problems", async () => {
  const bad = await call("/api/latest-match?region=mars&name=a&tag=b", () => new Response("{}"));
  assert.equal(bad.status, 400);
  assert.equal(bad.calls.length, 0);

  const notFound = await call("/api/latest-match?region=eu&name=nobody&tag=000", () => new Response("{}", { status: 404 }));
  assert.equal(notFound.status, 404);

  const busy = await call("/api/latest-match?region=eu&name=a&tag=b", () => new Response("{}", { status: 429 }));
  assert.equal(busy.status, 429);

  const noKey = await call("/api/latest-match?region=eu&name=a&tag=b", () => new Response("{}"), {});
  assert.equal(noKey.status, 503);
  assert.equal(noKey.calls.length, 0);
});

test("match by id validates the id", async () => {
  const bad = await call("/api/match/eu/not-an-id", () => new Response("{}"));
  assert.equal(bad.status, 400);
  const ok = await call(`/api/match/eu/${MATCH_ID}`, () => Response.json({ status: 200, data: SAMPLE }));
  assert.equal(ok.status, 200);
  assert.equal(ok.calls[0].url, `https://upstream.test/valorant/v4/match/eu/${MATCH_ID}`);
});

test("unknown routes and methods", async () => {
  assert.equal((await call("/api/nope", () => new Response("{}"))).status, 404);
  const res = await handleApi(new Request("https://crosspov.test/api/health", { method: "POST" }), {});
  assert.equal(res.status, 405);
});

test("limits each visitor to 30 lookups a minute", async () => {
  const { rateLimited } = await import("../src/index.ts");
  const t = 1_000_000;
  for (let i = 0; i < 30; i++) assert.equal(rateLimited("9.9.9.9", t + i), false);
  assert.equal(rateLimited("9.9.9.9", t + 31), true, "31st in a minute is refused");
  assert.equal(rateLimited("8.8.8.8", t + 31), false, "other visitors unaffected");
  assert.equal(rateLimited("9.9.9.9", t + 61_000 + 40), false, "allowed again after a minute");
});

test("www goes to the main domain, keeping the path", async () => {
  const { wwwRedirect } = await import("../src/index.ts");
  assert.equal(wwwRedirect(new URL("https://www.crosspov.com/privacy?x=1")), "https://crosspov.com/privacy?x=1");
  assert.equal(wwwRedirect(new URL("https://crosspov.com/demo")), null);
  assert.equal(wwwRedirect(new URL("https://crosspov.batainehsaeed1.workers.dev/")), null);
});
