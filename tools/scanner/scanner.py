"""Runs forever on the VPS: reads the HUD score of every live VALORANT stream
on Twitch, over and over, and keeps the readings (last few hours) in SQLite.

Twitch refreshes preview images about every 5 minutes, so a sweep every few
minutes sees every stream at most rounds apart. The matcher (api.py) uses
these readings to find which streams were in a given match.

Env: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET; CROSSPOV_DB (default readings.db)
"""

from __future__ import annotations

import io
import os
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from email.utils import parsedate_to_datetime

os.environ.setdefault("OMP_THREAD_LIMIT", "1")

import requests
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "scoreboard_poc"))

import hud  # noqa: E402
from poc import helix, live_valorant_streams, token  # noqa: E402
from store import Store  # noqa: E402

W, H = 1280, 720
SWEEP_EVERY_S = 240
PREVIEW_CYCLE_MS = 5 * 60_000
_local = threading.local()


def capture_time(headers, fetched_ms: int) -> tuple[int, int]:
    """(best guess of when the preview was captured, how much older it might be), in ms.

    Last-Modified, when Twitch sends it, is the capture time. Otherwise the
    picture is somewhere in the last refresh cycle, minus how long the CDN
    already held it (Age)."""
    lm = headers.get("last-modified")
    if lm:
        try:
            return int(parsedate_to_datetime(lm).timestamp() * 1000), 30_000
        except (TypeError, ValueError):
            pass
    age = headers.get("age")
    held = int(age) * 1000 if age and age.isdigit() else 0
    return fetched_ms - held, max(30_000, PREVIEW_CYCLE_MS - held)


def hud_strip(data: bytes) -> Image.Image:
    """Just the scoreboard band of a preview (keeps memory small during a sweep)."""
    img = Image.open(io.BytesIO(data)).convert("RGB").resize((W, H))
    x0, y0, x1, y1 = (int(hud.BAND[0] * W), int(hud.BAND[1] * H), int(hud.BAND[2] * W), int(hud.BAND[3] * H))
    return img.crop((x0, y0, x1, y1))


def fetch(stream: dict):
    session = getattr(_local, "session", None)
    if session is None:
        session = _local.session = requests.Session()
    url = stream["thumbnail_url"].replace("{width}", str(W)).replace("{height}", str(H))
    try:
        r = session.get(url, timeout=15)
        if not r.ok or len(r.content) < 2000:
            return stream, None, 0, 0
        taken, uncertain = capture_time(r.headers, int(time.time() * 1000))
        return stream, hud_strip(r.content), taken, uncertain
    except Exception:  # network trouble or a broken image: skip this stream
        return stream, None, 0, 0


def read(args):
    stream, strip, taken, uncertain = args
    if strip is None:
        return None
    try:
        got = hud.read_scores(strip)
    except Exception:  # one odd image must never stop the sweep
        return None
    if not got or got[2] < hud.MIN_CONFIDENCE:
        return None
    left, right, conf, _, _ = got
    return (stream["user_login"].lower(), stream["user_id"], taken, uncertain, int(left), int(right), None, float(conf))


def sweep(session: requests.Session, store: Store, pool: ProcessPoolExecutor) -> tuple[int, int]:
    streams = live_valorant_streams(session)
    with ThreadPoolExecutor(max_workers=32) as downloads:
        images = list(downloads.map(fetch, streams))
    rows = [r for r in pool.map(read, images, chunksize=16) if r]
    store.add(rows)
    store.prune()
    return len(streams), len(rows)


def main() -> int:
    cid, secret = os.environ["TWITCH_CLIENT_ID"], os.environ["TWITCH_CLIENT_SECRET"]
    store = Store(os.environ.get("CROSSPOV_DB", os.path.join(HERE, "readings.db")))
    session = requests.Session()
    token_at = 0.0
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 1)) as pool:
        while True:
            started = time.time()
            try:
                if started - token_at > 12 * 3600:
                    session.headers.update({"Client-Id": cid, "Authorization": f"Bearer {token(cid, secret)}"})
                    token_at = started
                n, read_ok = sweep(session, store, pool)
                print(f"{time.strftime('%H:%M:%S')} sweep: {n} live streams, {read_ok} scores read, {time.time() - started:.0f}s", flush=True)
            except Exception as e:  # network trouble etc.: wait and try again
                print(f"{time.strftime('%H:%M:%S')} sweep failed: {e}", flush=True)
                token_at = 0
            time.sleep(max(10, SWEEP_EVERY_S - (time.time() - started)))


if __name__ == "__main__":
    sys.exit(main())
