"""Runs forever on the VPS: reads the HUD score of every live VALORANT stream
on Twitch, over and over, and keeps the readings (last few hours) in SQLite.

Twitch refreshes preview images about every 5 minutes, so a sweep every few
minutes sees every stream at most rounds apart. The matcher (api.py) uses
these readings to find which streams were in a given match.

Env: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET; CROSSPOV_DB (default readings.db)
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
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
# A sweep starts every 2.5 minutes. Pictures that haven't changed since the
# last sweep are skipped (not read or stored twice), so sweeping more often
# than Twitch refreshes previews only costs the download, and catches each
# new picture sooner, which pins down when it was taken.
SWEEP_EVERY_S = 150
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


def fetch(stream: dict, seen: dict[str, str]):
    """(stream, HUD strip or None, taken_ms, uncertain_ms, picture id). The strip is None for a
    failed download and for a picture already read last sweep."""
    session = getattr(_local, "session", None)
    if session is None:
        session = _local.session = requests.Session()
    url = stream["thumbnail_url"].replace("{width}", str(W)).replace("{height}", str(H))
    login = stream["user_login"].lower()
    try:
        r = session.get(url, timeout=15)
        if not r.ok or len(r.content) < 2000:
            return stream, None, 0, 0, None
        picture = hashlib.blake2b(r.content, digest_size=12).hexdigest()
        if seen.get(login) == picture:
            return stream, None, 0, 0, picture
        taken, uncertain = capture_time(r.headers, int(time.time() * 1000))
        return stream, hud_strip(r.content), taken, uncertain, picture
    except Exception:  # network trouble or a broken image: skip this stream
        return stream, None, 0, 0, None


def read(args):
    stream, strip, taken, uncertain = args[:4]
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


def sweep(session: requests.Session, store: Store, pool: ProcessPoolExecutor, seen: dict[str, str]) -> dict:
    """One pass over every live stream. Pictures are read as soon as they arrive, while others download."""
    t0 = time.time()
    streams = live_valorant_streams(session)
    t_list = time.time() - t0
    reads, fresh = [], 0
    with ThreadPoolExecutor(max_workers=32) as downloads:
        for done in as_completed([downloads.submit(fetch, s, seen) for s in streams]):
            got = done.result()
            stream, strip, picture = got[0], got[1], got[4]
            if picture:
                seen[stream["user_login"].lower()] = picture
            if strip is not None:
                fresh += 1
                reads.append(pool.submit(read, got))
    t_download = time.time() - t0 - t_list
    rows = [r for r in (f.result() for f in reads) if r]
    store.add(rows)
    store.prune()
    live = {s["user_login"].lower() for s in streams}
    for login in [k for k in seen if k not in live]:
        del seen[login]
    return {"streams": len(streams), "new": fresh, "read": len(rows), "list_s": t_list, "download_s": t_download, "total_s": time.time() - t0}


def main() -> int:
    cid, secret = os.environ["TWITCH_CLIENT_ID"], os.environ["TWITCH_CLIENT_SECRET"]
    store = Store(os.environ.get("CROSSPOV_DB", os.path.join(HERE, "readings.db")))
    session = requests.Session()
    token_at = 0.0
    seen: dict[str, str] = {}  # login -> id of the picture read last
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 1)) as pool:
        while True:
            started = time.time()
            try:
                if started - token_at > 12 * 3600:
                    session.headers.update({"Client-Id": cid, "Authorization": f"Bearer {token(cid, secret)}"})
                    token_at = started
                st = sweep(session, store, pool, seen)
                print(
                    f"{time.strftime('%H:%M:%S')} sweep: {st['streams']} live streams, {st['new']} new pictures, "
                    f"{st['read']} scores read, {st['total_s']:.0f}s (list {st['list_s']:.0f}s, download {st['download_s']:.0f}s)",
                    flush=True,
                )
            except Exception as e:  # network trouble etc.: wait and try again
                print(f"{time.strftime('%H:%M:%S')} sweep failed: {e}", flush=True)
                token_at = 0
            time.sleep(max(10, SWEEP_EVERY_S - (time.time() - started)))


if __name__ == "__main__":
    sys.exit(main())
