"""The saved streamer accounts on the VPS.

    python links_admin.py remove <twitch login>   forget a streamer, never save them again
    python links_admin.py export                  all saved accounts as JSON (for the backup)
    python links_admin.py import <file.json>      restore a backup (adds to what's there)

Run on the VPS by the 'Remove a streamer' and 'Back up streamer accounts' workflows.
"""

import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from store import Store  # noqa: E402


def export(db_path: str) -> dict:
    with sqlite3.connect(db_path) as db:
        cols = ["puuid", "login", "user_id", "kind", "source", "confirmations", "first_ms", "last_ms"]
        links = [dict(zip(cols, r)) for r in db.execute(f"SELECT {', '.join(cols)} FROM links ORDER BY login")]
        optout = [{"login": r[0], "added_ms": r[1]} for r in db.execute("SELECT login, added_ms FROM optout")]
    return {"version": 1, "links": links, "optout": optout}


def restore(db_path: str, data: dict) -> tuple[int, int]:
    store = Store(db_path)  # creates the tables if needed
    with sqlite3.connect(db_path) as db:
        out = 0
        for o in data.get("optout", []):
            out += db.execute("INSERT OR IGNORE INTO optout VALUES (?, ?)", (o["login"], o["added_ms"])).rowcount
        added = 0
        for l in data.get("links", []):
            added += db.execute(
                "INSERT OR IGNORE INTO links (puuid, login, user_id, kind, source, confirmations, first_ms, last_ms) VALUES (?,?,?,?,?,?,?,?) ",
                (l["puuid"], l["login"], l["user_id"], l["kind"], l["source"], l["confirmations"], l["first_ms"], l["last_ms"]),
            ).rowcount
        db.execute("DELETE FROM links WHERE login IN (SELECT login FROM optout)")
    del store
    return added, out


def main(argv: list[str]) -> int:
    db_path = os.environ.get("CROSSPOV_DB", os.path.join(HERE, "readings.db"))
    if len(argv) == 2 and argv[1] == "export":
        Store(db_path)
        print(json.dumps(export(db_path)))
        return 0
    if len(argv) == 3 and argv[1] == "import":
        with open(argv[2]) as f:
            added, out = restore(db_path, json.load(f))
        print(f"restored {added} account(s) and {out} removal(s)")
        return 0
    if len(argv) != 3 or argv[1] != "remove":
        print(__doc__)
        return 2
    login = argv[2].strip().lower().removeprefix("https://www.twitch.tv/").removeprefix("twitch.tv/").strip("/")
    if not (3 <= len(login) <= 25 and login.replace("_", "").isalnum()):
        print(f"'{login}' isn't a Twitch channel name")
        return 2
    removed = Store(db_path).opt_out(login)
    print(f"{login}: removed {removed} saved account(s); it will not be saved again.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
