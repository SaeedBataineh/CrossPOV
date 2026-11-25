"""Small HTTP service on the VPS that the CrossPOV server asks:
"which live streams were in this match?"

POST /match   body: {"id", "startedAt" (ms), "lengthMs", "teams": [a, b],
                     "rounds": [{"startMs", "winner"}]}
              -> {"status": "pending"} while it checks, then
                 {"status": "done", "streams": [{login, userId, team, delaySec, vod...}]}
POST /verify  body: the match as for /match plus {"login", "team"}: was this
              channel's stream in this match? (A channel the user linked by hand.)
              -> {"status": "pending"} while it reads their VOD, then
                 {"status": "done", "verdict": "match" | "otherTeam" | "different" | "unknown",
                  "delaySec"?, "checked", "agreed"}
GET  /health  -> reading counts (also signed)

Requests must be signed: header X-CrossPOV-Time (unix seconds) and
X-CrossPOV-Signature = hex HMAC-SHA256(key, "<time>.<method> <path>.<body>").
Old or wrong signatures get 401. Only the CrossPOV server knows the key.

Env: SCANNER_KEY, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, CROSSPOV_DB,
     SCANNER_PORT (default 8787)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "scoreboard_poc"))

import requests  # noqa: E402

from matcher import MAX_DELAY_MS, PREVIEW_AGE_MS, Reading, Round, match_streams  # noqa: E402
from store import Store  # noqa: E402

MAX_BODY = 64 * 1024
MAX_SKEW_S = 300
MAX_CANDIDATES = 6
RESULT_TTL_S = 6 * 3600


def signature(key: bytes, ts: str, method: str, path: str, body: bytes) -> str:
    return hmac.new(key, f"{ts}.{method} {path}.".encode() + body, hashlib.sha256).hexdigest()


def check_signature(key: bytes, headers, method: str, path: str, body: bytes, now: float | None = None) -> bool:
    ts = headers.get("X-CrossPOV-Time", "")
    sig = headers.get("X-CrossPOV-Signature", "")
    if not ts.isdigit() or abs((now or time.time()) - int(ts)) > MAX_SKEW_S:
        return False
    return hmac.compare_digest(signature(key, ts, method, path, body), sig)


def parse_match(body: dict) -> tuple[str, int, int, tuple[str, str], list[Round]]:
    mid = str(body["id"])[:64]
    start = int(body["startedAt"])
    length = int(body["lengthMs"])
    teams = tuple(str(t)[:32] for t in body["teams"][:2])
    rounds = [Round(int(r["startMs"]), (str(r["winner"]) if r.get("winner") else None)) for r in body["rounds"][:40]]
    if len(teams) != 2 or length <= 0 or length > 4 * 3600_000:
        raise ValueError("bad match")
    return mid, start, length, teams, rounds  # type: ignore[return-value]


class Matcher:
    """Finds and confirms streams for a match, one background job per match id."""

    def __init__(self, store: Store, verify_stream, examine=None):
        self.store = store
        self.verify_stream = verify_stream  # (login, user_id, start, rounds, teams, team) -> dict | None
        self.examine = examine  # (login, start, rounds, teams, team) -> {"verdict", ...}
        self.results: dict[str, tuple[float, dict]] = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=2)

    def request(self, match: dict) -> dict:
        mid, start, length, teams, rounds = parse_match(match)
        with self.lock:
            now = time.time()
            self.results = {k: v for k, v in self.results.items() if now - v[0] < RESULT_TTL_S}
            if mid in self.results:
                return self.results[mid][1]
            self.results[mid] = (now, {"status": "pending"})
        self.pool.submit(self._run, mid, start, length, teams, rounds)
        return {"status": "pending"}

    def verify_request(self, body: dict) -> dict:
        """Is `login`'s stream this match, on `team`? Answered in the background like /match."""
        mid, start, length, teams, rounds = parse_match(body)
        login = str(body.get("login", "")).lower()
        team = str(body.get("team", ""))
        if not (3 <= len(login) <= 25 and login.replace("_", "").isalnum()) or team not in teams:
            raise ValueError("bad login or team")
        if self.examine is None:
            return {"status": "done", "verdict": "unknown", "reason": "no VOD reader"}
        key = f"verify:{mid}:{login}:{team}"
        with self.lock:
            now = time.time()
            if key in self.results:
                return self.results[key][1]
            self.results[key] = (now, {"status": "pending"})
        self.pool.submit(self._run_verify, key, login, start, rounds, teams, team)
        return {"status": "pending"}

    def _run_verify(self, key, login, start, rounds, teams, team):
        try:
            result = {"status": "done", **self.examine(login, start, rounds, teams, team)}
        except Exception as e:  # unknown, never a wrong "no"
            result = {"status": "done", "verdict": "unknown", "reason": str(e)[:200]}
        with self.lock:
            self.results[key] = (time.time(), result)

    def _run(self, mid, start, length, teams, rounds):
        try:
            rows = self.store.between(start - 60_000, start + length + PREVIEW_AGE_MS + MAX_DELAY_MS)
            readings = [Reading(r[0], r[2], r[4], r[5], r[3]) for r in rows]
            user_ids = {r[0]: r[1] for r in rows}
            candidates = match_streams(readings, start, length, rounds, teams)[:MAX_CANDIDATES]
            streams = []
            for c in candidates:
                found = self.verify_stream(c.login, user_ids.get(c.login, ""), start, rounds, teams, c.team)
                if found:
                    streams.append(found)
            result = {"status": "done", "streams": streams, "candidates": len(candidates)}
        except Exception as e:  # keep the service up; the server just gets no matches
            result = {"status": "done", "streams": [], "error": str(e)[:200]}
        with self.lock:
            self.results[mid] = (time.time(), result)


def twitch_vod_checker(client_id: str, secret: str, ytdlp: str):
    """verify_stream for real: find the streamer's VOD that covers the match and read it."""
    from poc import token
    from verify import ffmpeg_path, playlist_url, verify

    ffmpeg = ffmpeg_path()
    session = requests.Session()
    state = {"token_at": 0.0}

    def auth():
        if time.time() - state["token_at"] > 12 * 3600:
            session.headers.update({"Client-Id": client_id, "Authorization": f"Bearer {token(client_id, secret)}"})
            state["token_at"] = time.time()

    def vod_for(user_id, start):
        """(VOD info, seconds into it where the match starts), or None."""
        r = session.get("https://api.twitch.tv/helix/videos", params={"user_id": user_id, "type": "archive", "first": 10}, timeout=20)
        if not r.ok:
            return None
        for v in r.json().get("data", []):
            offset = (start - _iso_ms(v["created_at"])) / 1000
            if 0 <= offset <= _duration_s(v["duration"]):
                return v, offset
        return None

    def check(login, user_id, start, rounds, teams, team):
        auth()
        found = vod_for(user_id, start)
        if not found:
            return None
        v, offset = found
        playlist = playlist_url(v["url"], ytdlp)
        if not playlist:
            return None
        verdict = verify(playlist, offset, rounds, teams, team, ffmpeg)
        if not verdict.ok:
            return None
        return {
            "login": login,
            "userId": user_id,
            "displayName": v.get("user_name") or login,
            "team": team,
            "delaySec": verdict.delay_s,
            "vod": {"id": v["id"], "url": v["url"], "offsetSec": round(offset)},
            "checked": verdict.checked,
        }

    def examine(login, start, rounds, teams, team):
        """For a channel linked by hand: does their VOD show this match's score at its moments?"""
        auth()
        r = session.get("https://api.twitch.tv/helix/users", params={"login": login}, timeout=20)
        users = r.json().get("data", []) if r.ok else []
        if not users:
            return {"verdict": "unknown", "reason": "channel not found"}
        found = vod_for(users[0]["id"], start)
        if not found:
            return {"verdict": "unknown", "reason": "no VOD covering the match"}
        v, offset = found
        playlist = playlist_url(v["url"], ytdlp)
        if not playlist:
            return {"verdict": "unknown", "reason": "VOD not readable"}
        return judge(lambda side: verify(playlist, offset, rounds, teams, side, ffmpeg), teams, team)

    return check, examine


def judge(run, teams, team) -> dict:
    """Verdict on a linked channel from VOD checks (`run(side)` -> verify.Verdict).

    "match": their scoreboard showed this match from `team`'s side.
    "otherTeam": it did, but from the other side (the wrong player was picked).
    "different": the scoreboard was readable and mostly showed other scores.
    "unknown": too little of it could be read to tell (hidden HUD, overlays)."""
    other = teams[1] if team == teams[0] else teams[0]
    mine = run(team)
    if mine.ok:
        return {"verdict": "match", "delaySec": mine.delay_s, "checked": mine.checked, "agreed": mine.agreed}
    if mine.checked < 3:
        return {"verdict": "unknown", "checked": mine.checked, "agreed": mine.agreed, "reason": "scoreboard mostly hidden"}
    theirs = run(other)
    if theirs.ok:
        return {"verdict": "otherTeam", "delaySec": theirs.delay_s, "checked": theirs.checked, "agreed": theirs.agreed}
    if mine.agreed * 2 < mine.checked:
        return {"verdict": "different", "checked": mine.checked, "agreed": mine.agreed}
    return {"verdict": "unknown", "checked": mine.checked, "agreed": mine.agreed, "reason": "only some scores matched"}



def _iso_ms(s: str) -> int:
    from datetime import datetime

    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def _duration_s(d: str) -> int:
    """Twitch's '1h2m3s' format."""
    total, num = 0, ""
    for ch in d:
        if ch.isdigit():
            num += ch
        else:
            total += int(num or 0) * {"h": 3600, "m": 60, "s": 1}.get(ch, 0)
            num = ""
    return total


def make_handler(key: bytes, matcher: Matcher, store: Store):
    class Handler(BaseHTTPRequestHandler):
        server_version = "crosspov-scanner"

        def _send(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authed(self, body: bytes) -> bool:
            if check_signature(key, self.headers, self.command, self.path, body):
                return True
            self._send(401, {"error": "unauthorized"})
            return False

        def do_GET(self):
            if not self._authed(b""):
                return
            if self.path == "/health":
                return self._send(200, {"ok": True, **store.stats()})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._send(413, {"error": "too big"})
            body = self.rfile.read(length)
            if not self._authed(body):
                return
            if self.path not in ("/match", "/verify"):
                return self._send(404, {"error": "not found"})
            try:
                data = json.loads(body)
                self._send(200, matcher.request(data) if self.path == "/match" else matcher.verify_request(data))
            except (ValueError, KeyError, TypeError) as e:
                self._send(400, {"error": f"bad request: {e}"[:200]})

        def log_message(self, fmt, *args):  # one short line per request
            print(f"{time.strftime('%H:%M:%S')} {self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)

    return Handler


def main() -> int:
    key = os.environ["SCANNER_KEY"].encode()
    if len(key) < 32:
        sys.exit("SCANNER_KEY must be at least 32 characters")
    store = Store(os.environ.get("CROSSPOV_DB", os.path.join(HERE, "readings.db")))
    ytdlp = os.environ.get("YTDLP", os.path.join(os.path.dirname(sys.executable), "yt-dlp"))
    checker, examine = twitch_vod_checker(os.environ["TWITCH_CLIENT_ID"], os.environ["TWITCH_CLIENT_SECRET"], ytdlp)
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("SCANNER_PORT", "8787"))), make_handler(key, Matcher(store, checker, examine), store))
    print(f"listening on {server.server_address}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
