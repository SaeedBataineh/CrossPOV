"""SQLite store for scoreboard readings: the last few hours only."""

from __future__ import annotations

import sqlite3
import threading
import time

KEEP_MS = 6 * 3_600_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
  login TEXT NOT NULL,
  user_id TEXT NOT NULL,
  taken_ms INTEGER NOT NULL,
  uncertain_ms INTEGER NOT NULL,
  score_left INTEGER NOT NULL,
  score_right INTEGER NOT NULL,
  timer TEXT,
  confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS readings_time ON readings (taken_ms);
-- Riot accounts (puuid) known to belong to a Twitch channel: mains and smurfs.
-- Saved only after a check (name match while live, or a VOD whose scoreboard
-- showed the match); kept permanently. Never listed or searched: the server
-- only asks about the ten players of one match.
CREATE TABLE IF NOT EXISTS links (
  puuid TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,           -- 'main' (name matches the channel) or 'smurf'
  source TEXT NOT NULL,         -- 'name', 'scoreboard' or 'submitted'
  confirmations INTEGER NOT NULL DEFAULT 1,
  first_ms INTEGER NOT NULL,
  last_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_login ON links (login);
-- Channels that asked not to be kept: never saved or returned.
CREATE TABLE IF NOT EXISTS optout (login TEXT PRIMARY KEY, added_ms INTEGER NOT NULL);
"""


class Store:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        with self.connect() as db:
            db.executescript(SCHEMA)

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=30)
        db.execute("PRAGMA journal_mode=WAL")
        return db

    def add(self, rows: list[tuple]) -> None:
        """rows: (login, user_id, taken_ms, uncertain_ms, left, right, timer, confidence)"""
        if not rows:
            return
        with self.lock, self.connect() as db:
            db.executemany("INSERT INTO readings VALUES (?,?,?,?,?,?,?,?)", rows)

    def prune(self, now_ms: int | None = None) -> int:
        cutoff = (now_ms or int(time.time() * 1000)) - KEEP_MS
        with self.lock, self.connect() as db:
            return db.execute("DELETE FROM readings WHERE taken_ms < ?", (cutoff,)).rowcount

    def between(self, t0_ms: int, t1_ms: int) -> list[tuple]:
        with self.connect() as db:
            return db.execute(
                "SELECT login, user_id, taken_ms, uncertain_ms, score_left, score_right, timer, confidence "
                "FROM readings WHERE taken_ms BETWEEN ? AND ?",
                (t0_ms, t1_ms),
            ).fetchall()

    # ---- streamer accounts ----

    def links_for(self, puuids: list[str]) -> list[dict]:
        """Known channels for these players (at most ten per match)."""
        puuids = [p for p in puuids if isinstance(p, str) and 0 < len(p) <= 100][:20]
        if not puuids:
            return []
        marks = ",".join("?" * len(puuids))
        with self.connect() as db:
            rows = db.execute(
                f"SELECT puuid, login, user_id, kind FROM links WHERE puuid IN ({marks}) "
                "AND login NOT IN (SELECT login FROM optout)",
                puuids,
            ).fetchall()
        return [{"puuid": r[0], "login": r[1], "userId": r[2], "kind": r[3]} for r in rows]

    def save_links(self, links: list[dict], now_ms: int | None = None) -> int:
        """Adds or confirms links. A main stays a main; an opted-out channel is never saved."""
        now = now_ms or int(time.time() * 1000)
        saved = 0
        with self.lock, self.connect() as db:
            out = {r[0] for r in db.execute("SELECT login FROM optout")}
            for l in links[:20]:
                puuid, login = str(l.get("puuid", "")), str(l.get("login", "")).lower()
                kind = "main" if l.get("kind") == "main" else "smurf"
                source = str(l.get("source", ""))[:20] or "name"
                if not (0 < len(puuid) <= 100 and 3 <= len(login) <= 25 and login.replace("_", "").isalnum()) or login in out:
                    continue
                db.execute(
                    "INSERT INTO links (puuid, login, user_id, kind, source, confirmations, first_ms, last_ms) VALUES (?,?,?,?,?,1,?,?) "
                    "ON CONFLICT(puuid) DO UPDATE SET "
                    "  confirmations = CASE WHEN links.login = excluded.login THEN links.confirmations + 1 ELSE 1 END, "
                    "  kind = CASE WHEN links.login = excluded.login AND links.kind = 'main' THEN 'main' ELSE excluded.kind END, "
                    "  source = CASE WHEN links.login = excluded.login THEN links.source ELSE excluded.source END, "
                    "  first_ms = CASE WHEN links.login = excluded.login THEN links.first_ms ELSE excluded.first_ms END, "
                    "  login = excluded.login, user_id = excluded.user_id, last_ms = excluded.last_ms",
                    (puuid, login, str(l.get("userId", ""))[:20], kind, source, now, now),
                )
                saved += 1
        return saved

    def opt_out(self, login: str) -> int:
        """Forgets every account of a channel and never saves it again. Returns rows removed."""
        login = login.lower().strip()
        with self.lock, self.connect() as db:
            db.execute("INSERT OR IGNORE INTO optout VALUES (?, ?)", (login, int(time.time() * 1000)))
            return db.execute("DELETE FROM links WHERE login = ?", (login,)).rowcount

    def stats(self) -> dict:
        with self.connect() as db:
            n, lo, hi, streams = db.execute("SELECT COUNT(*), MIN(taken_ms), MAX(taken_ms), COUNT(DISTINCT login) FROM readings").fetchone()
            accounts, channels = db.execute("SELECT COUNT(*), COUNT(DISTINCT login) FROM links").fetchone()
        return {"readings": n, "streams": streams, "oldest_ms": lo, "newest_ms": hi, "streamerAccounts": accounts, "streamerChannels": channels}
