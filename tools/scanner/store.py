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

    def stats(self) -> dict:
        with self.connect() as db:
            n, lo, hi, streams = db.execute("SELECT COUNT(*), MIN(taken_ms), MAX(taken_ms), COUNT(DISTINCT login) FROM readings").fetchone()
        return {"readings": n, "streams": streams, "oldest_ms": lo, "newest_ms": hi}
