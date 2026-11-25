import { test } from "node:test";
import assert from "node:assert/strict";
import { fromHenrikV4, type HMatch } from "../src/match.ts";
import { handleApi, resetHenrikPause, validRiotId } from "../src/index.ts";

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
  assert.ok(validRiotId("CLOUDEY", "X 3"), "tags can contain spaces");
  assert.ok(!validRiotId("name", " X3"), "but not start or end with one");
  assert.ok(!validRiotId("name", "X3 "));
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
  resetHenrikPause();

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

import { clientVersion, compareVersions, outdated, parseLatest } from "../src/appVersion.ts";

test("reads the app version from the user agent", () => {
  assert.equal(clientVersion("CrossPOV/1.4.2"), "1.4.2");
  assert.equal(clientVersion("ureq/3.5.2"), "0.0.0", "builds from before auto-update count as oldest");
  assert.equal(clientVersion("Mozilla/5.0 (Windows NT 10.0)"), null, "browsers are never blocked");
  assert.equal(clientVersion(null), null);
});

test("blocks old app versions once the newest release has been out for a while", () => {
  const now = Date.parse("2026-11-24T20:00:00Z");
  const latest = parseLatest({ version: "0.2.0", pub_date: "2026-11-24T08:00:00Z" });
  assert.deepEqual(latest, { version: "0.2.0", publishedMs: Date.parse("2026-11-24T08:00:00Z") });
  assert.match(outdated("0.1.0", latest, now) ?? "", /update to v0\.2\.0/);
  assert.equal(outdated("0.2.0", latest, now), null);
  assert.equal(outdated("0.3.0", latest, now), null);
  assert.equal(outdated(null, latest, now), null);
  assert.equal(outdated("0.1.0", null, now), null, "no release info: let everyone in");
  const fresh = parseLatest({ version: "0.2.0", pub_date: "2026-11-24T19:00:00Z" });
  assert.equal(outdated("0.1.0", fresh, now), null, "grace period while running apps update");
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(parseLatest({ version: "nope" }), null);
});

test("an out-of-date app gets 426 instead of match data", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ version: "9.0.0", pub_date: "2020-01-01T00:00:00Z" }))) as typeof fetch;
  try {
    const req = new Request("https://crosspov.com/api/latest-match?region=eu&name=A&tag=B", { headers: { "user-agent": "CrossPOV/0.1.0" } });
    const res = await handleApi(req, {});
    assert.equal(res.status, 426);
    const body = (await res.json()) as { updateRequired?: boolean };
    assert.equal(body.updateRequired, true);
    const health = await handleApi(new Request("https://crosspov.com/api/health", { headers: { "user-agent": "CrossPOV/0.1.0" } }), {});
    assert.equal(health.status, 200, "health stays open");
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { collapseSlashes } from "../src/index.ts";

test("double slashes in a path serve the normal file", () => {
  assert.equal(collapseSlashes(new URL("https://crosspov.com//riot.txt")), "https://crosspov.com/riot.txt");
  assert.equal(collapseSlashes(new URL("https://crosspov.com/riot.txt")), null);
});

import { withSecurityHeaders } from "../src/index.ts";

test("website responses carry security headers", () => {
  const res = withSecurityHeaders(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-type"), "text/html", "keeps the original headers");
});


test("a 'too many requests' from match data pauses calls instead of piling on", async () => {
  resetHenrikPause();
  const busy = await call("/api/latest-match?region=eu&name=A&tag=B", () => new Response("{}", { status: 429, headers: { "retry-after": "20" } }));
  assert.equal(busy.status, 429);
  assert.match(String(busy.body.error), /try again/);
  const after = await call("/api/latest-match?region=eu&name=C&tag=D", () => Response.json({ status: 200, data: [SAMPLE] }));
  assert.equal(after.status, 429, "still cooling down");
  assert.equal(after.calls.length, 0, "no request sent to match data during the pause");
  resetHenrikPause();
  const ok = await call("/api/latest-match?region=eu&name=C&tag=D", () => Response.json({ status: 200, data: [SAMPLE] }));
  assert.equal(ok.status, 200);
});

test("the same match asked for twice at once is fetched once", async () => {
  resetHenrikPause();
  let upstream = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    upstream++;
    await new Promise((r) => setTimeout(r, 20));
    return Response.json({ status: 200, data: SAMPLE });
  }) as typeof fetch;
  try {
    const env = { HENRIK_API_KEY: "k", HENRIK_BASE: "https://upstream.test" };
    const path = `https://crosspov.test/api/match/eu/${MATCH_ID}`;
    const [a, b] = await Promise.all([handleApi(new Request(path), env), handleApi(new Request(path), env)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(upstream, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { downloadRedirect } from "../src/index.ts";

test("downloads come from crosspov.com itself, never a link to where they're hosted", async () => {
  assert.equal(await downloadRedirect("/demo", {}), null);
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  const setup = "https://github.com/SaeedBataineh/CrossPOV/releases/download/v9.9.9/CrossPOV_9.9.9_x64-setup.exe";
  globalThis.fetch = (async (u: RequestInfo | URL) => {
    asked.push(String(u));
    if (String(u).endsWith("latest.json")) return Response.json({ version: "9.9.9", platforms: { "windows-x86_64": { url: setup } } });
    return new Response("MZ fake exe", { headers: { "content-length": "11" } });
  }) as typeof fetch;
  try {
    const exe = (await downloadRedirect("/download", {}))!;
    assert.equal(exe.status, 200);
    assert.equal(exe.headers.get("location"), null, "no redirect to GitHub");
    assert.equal(exe.headers.get("content-disposition"), 'attachment; filename="CrossPOV.exe"');
    assert.equal(await exe.text(), "MZ fake exe");
    assert.equal(asked[0], "https://github.com/SaeedBataineh/CrossPOV/releases/latest/download/CrossPOV.exe");
    const inst = (await downloadRedirect("/download/installer/", {}))!;
    assert.equal(inst.headers.get("content-disposition"), 'attachment; filename="CrossPOV_9.9.9_x64-setup.exe"');
  } finally {
    globalThis.fetch = realFetch;
  }
  globalThis.fetch = (async () => Response.json({ platforms: { "windows-x86_64": { url: "https://evil.example/x.exe" } } })) as typeof fetch;
  try {
    const safe = (await downloadRedirect("/download/installer", {}))!;
    assert.equal(safe.status, 503, "only our own release files are ever handed out");
  } finally {
    globalThis.fetch = realFetch;
  }
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  try {
    assert.equal((await downloadRedirect("/download", {}))!.status, 503, "a missing file is an error page, not a GitHub link");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("version endpoint reports the newest release", async () => {
  const r = await call("/api/version", () => Response.json({ version: "0.4.2", pub_date: "2026-11-24T20:41:51Z", platforms: {} }), { LATEST_JSON_URL: "https://feed.test/latest.json" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { version: "0.4.2", releasedAt: "2026-11-24T20:41:51.000Z" });
});

test("recent matches lists ids from HenrikDev's stored matches", async () => {
  resetHenrikPause();
  const r = await call("/api/recent-matches?region=eu&name=A&tag=B", () =>
    Response.json({ status: 200, data: [{ meta: { id: MATCH_ID, map: { name: "Ascent" }, mode: "Competitive", started_at: "2026-11-24T19:00:00.000Z" } }, { meta: { id: "bad" } }] }),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.matches, [{ id: MATCH_ID, map: "Ascent", mode: "Competitive", startedAt: "2026-11-24T19:00:00.000Z" }]);
  assert.match(r.calls[0].url, /\/valorant\/v1\/stored-matches\/eu\/A\/B\?size=10$/);
});

import { eliminations, scannerMatch, scannerStreams, scannerVerify, sign } from "../src/scanner.ts";

test("scanner requests are signed exactly like the VPS checks them", async () => {
  // Value computed by tools/scanner/api.py signature() for the same inputs.
  assert.equal(await sign("k".repeat(40), "1700000000", "POST", "/match", '{"a":1}'), "fe3a6c3e5075baa69bf7cfd09bea71a3d7e53bf7404debe10e4cad3fec78b58a");
});

test("scanner gets the score timeline only, and is skipped when not set up", async () => {
  const m = fromHenrikV4(SAMPLE);
  assert.equal(scannerMatch(m), null, "too few rounds to match on");
  const full = { ...m, rounds: [0, 1, 2, 3, 4].map((i) => ({ index: i, winner: "Blue", startMs: i * 100_000 })) };
  const body = scannerMatch(full)!;
  assert.deepEqual(body.teams, ["Blue", "Red"]);
  assert.equal(body.rounds.length, 5);
  assert.ok(!("players" in body), "no player data leaves the server");
  assert.deepEqual(await scannerStreams({}, full), { status: "off", streams: [] });
  const realFetch = globalThis.fetch;
  let sent: RequestInit | undefined;
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    sent = init;
    return Response.json({ status: "done", streams: [{ login: "streamer_x", team: "Red", delaySec: 30 }, { login: "bad login!", team: "Red" }] });
  }) as typeof fetch;
  try {
    const r = await scannerStreams({ SCANNER_URL: "http://vps.test:8787", SCANNER_KEY: "k".repeat(40) }, full);
    assert.deepEqual(r.streams.map((s) => s.login), ["streamer_x"], "odd logins are dropped");
    assert.ok(new Headers(sent?.headers).get("x-crosspov-signature"));
  } finally {
    globalThis.fetch = realFetch;
  }
  globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
  try {
    assert.equal((await scannerStreams({ SCANNER_URL: "http://vps.test:8787", SCANNER_KEY: "k".repeat(40) }, full)).status, "error", "a down scanner never breaks streamer checks");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a hand-linked channel is checked against its VOD's scoreboard", async () => {
  const m = fromHenrikV4(SAMPLE);
  const full = { ...m, rounds: [0, 1, 2, 3, 4].map((i) => ({ index: i, winner: "Blue", startMs: i * 100_000 })) };
  const env = { SCANNER_URL: "http://vps.test:8787", SCANNER_KEY: "k".repeat(40) };
  assert.deepEqual(await scannerVerify({}, full, "someone", "Blue"), { verdict: "off" });
  assert.deepEqual(await scannerVerify(env, m, "someone", "Blue"), { verdict: "unknown" }, "no round score to read");
  const realFetch = globalThis.fetch;
  let sentBody = "";
  let path = "";
  const answer = (body: unknown) => {
    globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      path = new URL(String(u)).pathname;
      sentBody = String(init?.body);
      return Response.json(body);
    }) as typeof fetch;
  };
  try {
    answer({ status: "pending" });
    assert.deepEqual(await scannerVerify(env, full, "wtfslump", "Blue"), { verdict: "pending" });
    assert.equal(path, "/verify");
    assert.deepEqual([JSON.parse(sentBody).login, JSON.parse(sentBody).team], ["wtfslump", "Blue"]);
    answer({ status: "done", verdict: "different", checked: 4, agreed: 0 });
    assert.deepEqual(await scannerVerify(env, full, "wtfslump", "Blue"), { verdict: "different", delaySec: null });
    answer({ status: "done", verdict: "match", shiftSec: 74 });
    assert.deepEqual(await scannerVerify(env, full, "x_streamer", "Blue"), { verdict: "match", delaySec: 74 });
    await scannerVerify(env, full, "x_streamer", "Blue", "shift");
    assert.equal(JSON.parse(sentBody).mode, "shift");
    answer({ status: "done", verdict: "match", shiftSec: 9999 });
    assert.equal((await scannerVerify(env, full, "x_streamer", "Blue")).delaySec, null, "silly shifts are ignored");
    answer({ status: "done", verdict: "something new" });
    assert.equal((await scannerVerify(env, full, "x_streamer", "Blue")).verdict, "unknown");
    globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    assert.equal((await scannerVerify(env, full, "x_streamer", "Blue")).verdict, "unknown", "a down scanner never blocks a link");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rounds that ended by elimination are sent with the time they were decided", () => {
  const players = ["a1", "a2", "b1", "b2"].map((p) => ({ puuid: p, name: p, tag: "x", team: p[0] === "a" ? "A" : "B", agent: "Jett", kills: 0, deaths: 0, assists: 0 }));
  const kill = (round: number, atMs: number, killer: string, victim: string) => ({ round, atMs, inRoundMs: 0, killer, victim, weapon: null });
  const m = {
    id: "m", map: "Summit", mode: "Competitive", region: "na", startedAt: "2026-11-24T15:25:04Z", lengthMs: 600_000,
    teams: [{ id: "A", won: true, roundsWon: 2 }, { id: "B", won: false, roundsWon: 1 }],
    players,
    rounds: [
      { index: 0, winner: "A", startMs: 0 },
      { index: 1, winner: "B", startMs: 100_000 },
      { index: 2, winner: "A", startMs: 200_000 },
    ],
    kills: [
      kill(0, 30_000, "a1", "b1"), kill(0, 41_000, "a2", "b2"), // round 1: both of B dead at 41 s
      kill(1, 130_000, "b1", "a1"), // round 2: only one of A died (spike): not an elimination
      kill(2, 230_000, "b1", "a1"), kill(2, 240_000, "a2", "b1"), kill(2, 252_000, "a2", "b2"),
    ],
  };
  assert.deepEqual(eliminations(m, [0, 1, 2]), [{ decidedMs: 41_000, round: 0 }, { decidedMs: 252_000, round: 2 }]);
  assert.equal(scannerMatch(m), null, "fewer than 4 rounds: nothing sent");
});
