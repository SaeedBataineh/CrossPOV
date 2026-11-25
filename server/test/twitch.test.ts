import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { findStreamers, isMainAccount, loginCandidates, parseTwitchDuration, resetTwitchToken, vodCovers } from "../src/twitch.ts";
import type { MatchSummary } from "../src/match.ts";

const START = "2026-11-24T19:00:00.000Z";
const startMs = Date.parse(START);

const MATCH: MatchSummary = {
  id: "0b6d5e1f-1a2b-4c3d-8e9f-0123456789ab",
  map: "Ascent",
  mode: "Competitive",
  region: "eu",
  startedAt: START,
  lengthMs: 30 * 60_000,
  teams: [],
  rounds: [],
  kills: [],
  players: [
    { puuid: "me", name: "Me Myself", tag: "EUW", team: "Blue", agent: "Jett", kills: 0, deaths: 0, assists: 0 },
    { puuid: "p1", name: "TTV Salt_Boran", tag: "sad", team: "Red", agent: "Omen", kills: 0, deaths: 0, assists: 0 },
    { puuid: "p2", name: "random guy", tag: "123", team: "Red", agent: "Sage", kills: 0, deaths: 0, assists: 0 },
    { puuid: "p3", name: "livenovod", tag: "1", team: "Red", agent: "Neon", kills: 0, deaths: 0, assists: 0 },
    { puuid: "p4", name: "ab", tag: "1", team: "Red", agent: "Neon", kills: 0, deaths: 0, assists: 0 },
  ],
};

const ENV = {
  TWITCH_CLIENT_ID: "cid",
  TWITCH_CLIENT_SECRET: "secret",
  TWITCH_API_BASE: "https://api.test",
  TWITCH_AUTH_BASE: "https://id.test",
};

beforeEach(() => resetTwitchToken());

test("turns Riot names into likely Twitch logins", () => {
  assert.deepEqual(loginCandidates("TTV Salt_Boran"), ["ttvsalt_boran", "salt_boran", "saltboran"]);
  assert.deepEqual(loginCandidates("Sir Doohickey"), ["sirdoohickey"]);
  assert.deepEqual(loginCandidates("Brütüs"), ["brutus"]);
  assert.deepEqual(loginCandidates("ab"), [], "too short for a Twitch login");
});

test("parses Twitch durations", () => {
  assert.equal(parseTwitchDuration("3h2m1s"), 10921);
  assert.equal(parseTwitchDuration("45m"), 2700);
  assert.equal(parseTwitchDuration("12s"), 12);
  assert.equal(parseTwitchDuration("bad"), 0);
});

test("a VOD counts only if it was recording when the match started", () => {
  assert.ok(vodCovers({ startMs: startMs - 3_600_000, durationSec: 7200 }, startMs));
  assert.ok(vodCovers({ startMs: startMs + 30_000, durationSec: 7200 }, startMs), "a minute of slack");
  assert.ok(!vodCovers({ startMs: startMs + 5 * 60_000, durationSec: 7200 }, startMs), "started after the match");
  assert.ok(!vodCovers({ startMs: startMs - 7_200_000, durationSec: 3600 }, startMs), "ended before the match");
});

test("finds players who were streaming during the match", async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    const reply = (data: unknown) => Response.json({ data });
    if (url.host === "id.test") return Response.json({ access_token: "tok", expires_in: 3600 });
    if (url.pathname === "/helix/users") {
      const logins = url.searchParams.getAll("login");
      assert.ok(!logins.includes("memyself"), "the requester is never looked up");
      return reply(
        [
          { id: "1", login: "salt_boran", display_name: "Salt_Boran" },
          { id: "2", login: "randomguy", display_name: "randomguy" },
          { id: "3", login: "livenovod", display_name: "LiveNoVod" },
        ].filter((u) => logins.includes(u.login)),
      );
    }
    if (url.pathname === "/helix/streams") {
      return reply([
        { id: "s1", user_id: "1", game_name: "VALORANT", started_at: new Date(startMs - 3_600_000).toISOString() },
        { id: "s3", user_id: "3", game_name: "VALORANT", started_at: new Date(startMs - 600_000).toISOString() },
      ]);
    }
    if (url.pathname === "/helix/videos") {
      const user = url.searchParams.get("user_id");
      if (user === "1")
        return reply([{ id: "v1", url: "https://www.twitch.tv/videos/v1", created_at: new Date(startMs - 3_600_000).toISOString(), duration: "1h45m", type: "archive", stream_id: "s1" }]);
      if (user === "2")
        // Same-named account, but streamed yesterday: not our match.
        return reply([{ id: "v2", url: "u", created_at: new Date(startMs - 86_400_000).toISOString(), duration: "2h", type: "archive", stream_id: "x" }]);
      return reply([]);
    }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    const found = await findStreamers(ENV, MATCH, "me");
    assert.equal(found.length, 2, JSON.stringify(found));
    const salt = found.find((f) => f.puuid === "p1")!;
    assert.equal(salt.channel.login, "salt_boran", "the TTV prefix is stripped");
    assert.deepEqual(salt.vod, {
      id: "v1",
      url: "https://www.twitch.tv/videos/v1",
      startedAt: new Date(startMs - 3_600_000).toISOString(),
      durationSec: 6300,
      offsetSec: 3600,
      live: true,
    });
    assert.equal(salt.liveGame, "VALORANT");
    const noVod = found.find((f) => f.puuid === "p3")!;
    assert.equal(noVod.vod, null, "live during the match but VODs are off");
    assert.ok(!found.some((f) => f.puuid === "p2"), "same name, wrong time: ignored");
    assert.equal(seen.filter((s) => s.startsWith("/helix/users")).length, 1, "one users call for the whole lobby");
  } finally {
    globalThis.fetch = real;
  }
});

test("explains missing credentials", async () => {
  await assert.rejects(findStreamers({}, MATCH), /missing its Twitch credentials/);
});

test("checks a channel the user names for a player", async () => {
  const { checkChannel } = await import("../src/twitch.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const reply = (data: unknown) => Response.json({ data });
    if (url.host === "id.test") return Response.json({ access_token: "tok", expires_in: 3600 });
    if (url.pathname === "/helix/users") return reply(url.searchParams.get("login") === "hiddenname" ? [{ id: "7", login: "hiddenname", display_name: "HiddenName" }] : []);
    if (url.pathname === "/helix/streams") return reply([]);
    if (url.pathname === "/helix/videos")
      return reply([{ id: "v7", url: "https://www.twitch.tv/videos/v7", created_at: new Date(startMs - 600_000).toISOString(), duration: "3h", type: "archive", stream_id: "s7" }]);
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    const found = await checkChannel(ENV, MATCH, "p2", "HiddenName");
    assert.equal(found.length, 1);
    assert.equal(found[0].puuid, "p2", "linked to the player the user picked");
    assert.equal(found[0].vod?.offsetSec, 600);
    assert.equal(found[0].vod?.live, false);
    await assert.rejects(checkChannel(ENV, MATCH, "p2", "nobodyhere"), /no Twitch channel/);
    assert.deepEqual(await checkChannel(ENV, MATCH, "not-in-match", "hiddenname"), []);
  } finally {
    globalThis.fetch = real;
  }
});

test("a smurf saved before is found though its name matches nothing", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const reply = (data: unknown) => Response.json({ data });
    if (url.host === "id.test") return Response.json({ access_token: "tok", expires_in: 3600 });
    if (url.pathname === "/helix/users") {
      const logins = url.searchParams.getAll("login");
      return reply([{ id: "9", login: "nature", display_name: "NaturE" }].filter((u) => logins.includes(u.login)));
    }
    if (url.pathname === "/helix/streams") return reply([]);
    if (url.pathname === "/helix/videos") {
      if (url.searchParams.get("user_id") === "9")
        return reply([{ id: "v9", url: "https://www.twitch.tv/videos/v9", created_at: new Date(startMs - 3_600_000).toISOString(), duration: "3h", type: "archive", stream_id: "z" }]);
      return reply([]);
    }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    // "random guy" (p2) is NaturE's smurf, saved earlier.
    const found = await findStreamers(ENV, MATCH, "me", new Map([["p2", "nature"]]));
    assert.deepEqual(found.map((f) => [f.puuid, f.channel.login]), [["p2", "nature"]]);
    assert.equal(found[0].vod?.offsetSec, 3600);
  } finally {
    globalThis.fetch = real;
  }
});

test("a main account is one whose name is the channel", () => {
  assert.ok(isMainAccount("TTV Salt_Boran", "salt_boran"));
  assert.ok(isMainAccount("NaturE", "nature"));
  assert.ok(!isMainAccount("random guy", "nature"), "a smurf");
});
