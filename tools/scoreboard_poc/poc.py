"""Scoreboard proof of concept.

One sweep of every live VALORANT stream on Twitch: download each stream's
preview image, read the HUD scoreboard at the top (score, round timer,
score) with OCR, and report how many are readable. Answers one question:
is matching streams to matches by scoreboard worth building?

Uses Twitch's official API (Helix) for the stream list; preview images are
the public thumbnails Twitch serves for every live stream.

Env: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET
Args: --limit N (streams to read, most-watched first; default 1500), --out DIR
"""

from __future__ import annotations

import os

# Tesseract starts several threads per run by default; with one OCR process
# per core that oversubscribes the CPU badly. One thread each is far faster.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")

import argparse
import base64
import io
import json
import os
import re
import statistics
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import asdict, dataclass, field

import pytesseract
import requests
from PIL import Image, ImageChops, ImageOps

HELIX = "https://api.twitch.tv/helix"
W, H = 1280, 720

# Where the scoreboard sits on a 16:9 frame, as fractions of width/height.
# The HUD is: [your score] [round timer] [enemy score], centred at the top.
BAND = (0.30, 0.0, 0.70, 0.085)  # wide enough for stretched-res HUDs
TIMER = (0.465, 0.0, 0.535, 0.075)
SCORE_L = (0.415, 0.0, 0.468, 0.075)
SCORE_R = (0.532, 0.0, 0.585, 0.075)

TIMER_RE = re.compile(r"^([0-1]?\d):([0-5]\d)$")


def token(client_id: str, secret: str) -> str:
    r = requests.post(
        "https://id.twitch.tv/oauth2/token",
        data={"client_id": client_id, "client_secret": secret, "grant_type": "client_credentials"},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def helix(session: requests.Session, path: str, params) -> dict:
    for attempt in range(5):
        r = session.get(f"{HELIX}/{path}", params=params, timeout=20)
        if r.status_code == 429:
            time.sleep(2 + attempt * 2)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("rate limited")


def live_valorant_streams(session: requests.Session) -> list[dict]:
    game = helix(session, "games", {"name": "VALORANT"})["data"][0]["id"]
    streams, cursor = [], None
    while True:
        params = {"game_id": game, "first": 100, "type": "live"}
        if cursor:
            params["after"] = cursor
        page = helix(session, "streams", params)
        streams += page["data"]
        cursor = page.get("pagination", {}).get("cursor")
        if not cursor or not page["data"]:
            return streams


_local = threading.local()


def fetch_image(url: str) -> bytes | None:
    """Downloads one preview. Each download thread keeps one open connection
    (a Session), so DNS is looked up once per thread, not once per image."""
    session = getattr(_local, "session", None)
    if session is None:
        session = _local.session = requests.Session()
    try:
        r = session.get(url.replace("{width}", str(W)).replace("{height}", str(H)), timeout=15)
        return r.content if r.ok and len(r.content) > 2000 else None
    except requests.RequestException:
        return None


def crop(img: Image.Image, box: tuple[float, float, float, float]) -> Image.Image:
    w, h = img.size
    return img.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))


def prepare(img: Image.Image) -> Image.Image:
    """The HUD digits are white: keep pixels bright in all three colours
    (the green/red score boxes behind them are not), upscale, black on white."""
    r, g, b = img.convert("RGB").split()
    white = ImageChops.darker(ImageChops.darker(r, g), b)
    white = white.resize((img.width * 4, img.height * 4), Image.LANCZOS)
    bw = white.point(lambda v: 255 if v > 200 else 0)
    return ImageOps.expand(ImageOps.invert(bw), border=40, fill=255)


def column_tint(img: Image.Image) -> list[tuple[int, int]]:
    """For each column of the top strip: (green minus red, red minus green),
    averaged over the middle rows where the score boxes are."""
    w, h = img.size
    mid = img.crop((0, int(0.3 * h), w, int(0.7 * h))).resize((w, 1), Image.BOX)
    out = []
    for x in range(w):
        r, g, _ = mid.getpixel((x, 0))
        out.append((g - r, r - g))
    return out


def locate_scoreboard(frame: Image.Image) -> tuple[float, float] | None:
    """Finds the scoreboard on this frame: the green box (left) and red box
    (right) of the HUD. Returns their outer edges as fractions of the frame
    width, which adapts to normal, stretched and black-bar resolutions.
    None means no HUD: the streamer isn't in a round (menu, lobby, other)."""
    w, h = frame.size
    x0, x1 = int(BAND[0] * w), int(BAND[2] * w)
    strip = frame.crop((x0, 0, x1, int(BAND[3] * h)))
    tint = column_tint(strip)
    n = len(tint)
    green = [i for i, (gr, _) in enumerate(tint[: n // 2]) if gr >= 12]
    red = [i for i, (_, rg) in enumerate(tint[n // 2 :], n // 2) if rg >= 12]
    if len(green) < n * 0.02 or len(red) < n * 0.02:
        return None
    left, right = (x0 + min(green)) / w, (x0 + max(red)) / w
    width = right - left
    centre = (left + right) / 2
    # A real scoreboard is roughly centred and a sensible width.
    if not (0.12 <= width <= 0.38) or abs(centre - 0.5) > 0.03:
        return None
    return left, right


def hud_boxes(left: float, right: float) -> dict[str, tuple[float, float, float, float]]:
    """Score / timer / score boxes, placed relative to the located scoreboard
    (proportions measured on a standard 16:9 HUD)."""
    w = right - left
    at = lambda a, b: (left + a * w, 0.0, left + b * w, 0.075)
    # Measured on real 16:9 frames (scoreboard ~0.385-0.618 of the width).
    return {"L": at(0.13, 0.36), "T": at(0.345, 0.655), "R": at(0.64, 0.87)}


def ocr(img: Image.Image, chars: str, psm: int = 7) -> str:
    """One Tesseract pass on one piece of the HUD (7 = a line, 8 = one word)."""
    cfg = f"--psm {psm} -c tessedit_char_whitelist={chars}"
    return pytesseract.image_to_string(prepare(img), config=cfg).strip().replace(" ", "")


def read_strip(img: Image.Image, boxes) -> tuple[str | None, str | None, str | None, str]:
    """Returns (left score, timer, right score, raw text)."""
    left = ocr(crop(img, boxes["L"]), "0123456789")
    timer = ocr(crop(img, boxes["T"]), "0123456789:")
    right = ocr(crop(img, boxes["R"]), "0123456789")
    return left or None, timer or None, right or None, f"{left or '?'} | {timer or '?'} | {right or '?'}"


@dataclass
class Reading:
    login: str
    language: str
    viewers: int
    ok_image: bool = False
    in_round: bool = False
    timer: str | None = None
    score_left: int | None = None
    score_right: int | None = None
    raw: dict = field(default_factory=dict)

    @property
    def readable(self) -> bool:
        """Timer plus both scores: enough to match against a match timeline."""
        return self.timer is not None and self.score_left is not None and self.score_right is not None


def as_score(text: str) -> int | None:
    digits = re.sub(r"\D", "", text)
    return int(digits) if digits and int(digits) <= 25 else None


def read_one(args: tuple[dict, bytes | None]) -> tuple[Reading, bytes | None]:
    s, data = args
    r = Reading(login=s["user_login"], language=s.get("language", ""), viewers=s.get("viewer_count", 0))
    if not data:
        return r, None
    r.ok_image = True
    img = Image.open(io.BytesIO(data)).convert("RGB")
    found = locate_scoreboard(img)
    r.in_round = found is not None
    if found:
        left, t, right, raw = read_strip(img, hud_boxes(*found))
        r.raw = {"text": raw, "scoreboard": [round(found[0], 3), round(found[1], 3)]}
        m = re.search(r"([0-1]?\d):([0-5]\d)", t or "")
        r.timer = f"{int(m.group(1))}:{m.group(2)}" if m else None
        r.score_left, r.score_right = as_score(left or ""), as_score(right or "")
    else:
        r.raw = {"text": "no HUD: not in a round"}
    band = crop(img, BAND)
    buf = io.BytesIO()
    band.save(buf, "JPEG", quality=80)
    return r, buf.getvalue()


def contact_sheet(rows: list[tuple[Reading, bytes]], path: str) -> None:
    items = []
    for r, jpg in rows:
        b64 = base64.b64encode(jpg).decode()
        verdict = "readable" if r.readable else ("in a round, not read" if r.in_round else "not in a round")
        read = f"{r.score_left if r.score_left is not None else '?'} | {r.timer or '?'} | {r.score_right if r.score_right is not None else '?'}"
        items.append(
            f'<figure><img src="data:image/jpeg;base64,{b64}" alt="Scoreboard crop from {r.login}">'
            f"<figcaption><b>{verdict}</b> · read: <code>{read}</code> · raw <code>{json.dumps(r.raw)}</code> · {r.login} ({r.language})</figcaption></figure>"
        )
    html = (
        "<!doctype html><meta charset=utf-8><title>Scoreboard OCR sample</title>"
        "<style>body{font:14px system-ui;background:#111;color:#eee;margin:24px}"
        "figure{display:inline-block;margin:8px;width:420px;vertical-align:top}"
        "img{width:420px;image-rendering:pixelated;border:1px solid #333}code{color:#9cf}</style>"
        "<h1>Scoreboard OCR: random sample</h1><p>Check each crop by eye against what was read.</p>" + "".join(items)
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=1500)
    ap.add_argument("--out", default="poc-out")
    ap.add_argument("--sample", type=int, default=80)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    cid, secret = os.environ.get("TWITCH_CLIENT_ID"), os.environ.get("TWITCH_CLIENT_SECRET")
    if not cid or not secret:
        print("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET", file=sys.stderr)
        return 2

    t0 = time.time()
    session = requests.Session()
    session.headers.update({"Client-Id": cid, "Authorization": f"Bearer {token(cid, secret)}"})
    streams = live_valorant_streams(session)
    t_list = time.time() - t0
    total_live = len(streams)
    streams = sorted(streams, key=lambda s: -s.get("viewer_count", 0))[: args.limit]

    t1 = time.time()
    with ThreadPoolExecutor(max_workers=48) as pool:
        images = list(pool.map(lambda s: fetch_image(s["thumbnail_url"]), streams))
    t_fetch = time.time() - t1

    print(f"Listed {total_live} live streams in {t_list:.1f}s; downloaded {len(streams)} previews in {t_fetch:.1f}s", flush=True)
    t2 = time.time()
    results = []
    with ProcessPoolExecutor() as pool:
        for i, res in enumerate(pool.map(read_one, zip(streams, images), chunksize=8), 1):
            results.append(res)
            if i % 100 == 0 or i == len(streams):
                rate = i / max(0.001, time.time() - t2)
                print(f"  read {i}/{len(streams)} ({rate:.1f}/s), readable so far: {sum(r.readable for r, _ in results)}", flush=True)
    t_ocr = time.time() - t2

    readings = [r for r, _ in results]
    have = [r for r in readings if r.ok_image]
    readable = [r for r in have if r.readable]
    timer_only = [r for r in have if r.timer and not r.readable]
    in_round = [r for r in have if r.in_round]
    hud = [r for r in in_round if r.timer]

    by_lang: dict[str, list[Reading]] = {}
    for r in have:
        by_lang.setdefault(r.language or "?", []).append(r)
    lang_rows = sorted(by_lang.items(), key=lambda kv: -len(kv[1]))[:12]

    per_stream_ms = 1000 * (t_fetch + t_ocr) / max(1, len(streams))
    est_full_sweep_s = per_stream_ms * total_live / 1000

    import random

    random.seed(7)
    sample = random.sample([x for x in results if x[1]], min(args.sample, len([x for x in results if x[1]])))
    contact_sheet(sample, os.path.join(args.out, "sample.html"))

    summary = {
        "live_valorant_streams": total_live,
        "streams_read": len(streams),
        "images_downloaded": len(have),
        "in_round": len(in_round),
        "in_round_pct": round(100 * len(in_round) / max(1, len(have)), 1),
        "timer_read_of_in_round_pct": round(100 * len(hud) / max(1, len(in_round)), 1),
        "readable_score_and_timer": len(readable),
        "readable_of_in_round_pct": round(100 * len(readable) / max(1, len(in_round)), 1),
        "timer_only": len(timer_only),
        "seconds": {"list": round(t_list, 1), "download": round(t_fetch, 1), "ocr": round(t_ocr, 1)},
        "est_full_sweep_seconds_on_this_machine": round(est_full_sweep_s),
        "cpu_count": os.cpu_count(),
        "median_viewers_read": statistics.median([r.viewers for r in readings]) if readings else 0,
        "by_language": {k: {"streams": len(v), "readable": sum(r.readable for r in v)} for k, v in lang_rows},
    }
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump({"summary": summary, "readings": [asdict(r) for r in readings]}, f, indent=1)

    md = [
        "## Scoreboard proof of concept",
        f"- Live VALORANT streams right now: **{total_live}**",
        f"- Read (most-watched first): **{len(streams)}**, images downloaded: {len(have)}",
        f"- In a round right now (scoreboard on screen): **{len(in_round)} ({summary['in_round_pct']}%)**; the rest are in menus, lobby or other content",
        f"- Of those in a round: **timer read {summary['timer_read_of_in_round_pct']}%**, timer + both scores {summary['readable_of_in_round_pct']}% (Tesseract; digit matching would do better)",
        f"- Time: list {t_list:.1f}s, download {t_fetch:.1f}s, OCR {t_ocr:.1f}s on {os.cpu_count()} CPUs",
        f"- Estimated full sweep of all {total_live} streams on this machine: **~{est_full_sweep_s:.0f}s**",
        "",
        "| Language | Streams | Score + timer read |",
        "|---|---|---|",
        *[f"| {k} | {len(v)} | {sum(r.readable for r in v)} |" for k, v in lang_rows],
        "",
        "Accuracy: open `sample.html` from the run's artifacts and compare crops with what was read.",
    ]
    text = "\n".join(md)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
