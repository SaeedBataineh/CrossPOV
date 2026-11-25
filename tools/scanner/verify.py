"""Confirms a candidate stream really was in the match, using its VOD.

Preview readings only say a stream showed similar scores at roughly the same
time. A VOD frame has an exact timestamp, so reading the scoreboard in a few
frames at known moments of the match settles it, and also measures the
streamer's broadcast delay (which the app uses to place clips exactly).
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scoreboard_poc"))
import hud  # noqa: E402
from matcher import Round, score_timeline  # noqa: E402

W, H = 1280, 720
# Broadcast delays tried, in seconds (most streamers use none or under a minute).
DELAYS = [0, 15, 30, 45, 60, 90, 120]
CHECK_INTO_ROUND_MS = 25_000  # 25 s into a round: buy phase over, score settled


@dataclass
class Verdict:
    ok: bool
    delay_s: int | None = None
    checked: int = 0
    agreed: int = 0
    reason: str = ""


def ffmpeg_path() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg  # pip package with a static FFmpeg, so no root install is needed

    return imageio_ffmpeg.get_ffmpeg_exe()


def playlist_url(vod_url: str, ytdlp: str) -> str | None:
    """The HLS address of a VOD, via yt-dlp (720p is plenty to read the HUD)."""
    try:
        out = subprocess.run(
            [ytdlp, "--no-warnings", "-q", "-g", "-f", "best[height<=720]/best", "--", vod_url],
            capture_output=True, text=True, timeout=60,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    url = out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else ""
    return url or None


def frame_at(playlist: str, seconds: float, ffmpeg: str) -> Image.Image | None:
    try:
        out = subprocess.run(
            [ffmpeg, "-v", "error", "-ss", f"{seconds:.2f}", "-i", playlist, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
            capture_output=True, timeout=60,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if out.returncode != 0 or not out.stdout:
        return None
    return Image.open(io.BytesIO(out.stdout)).convert("RGB").resize((W, H))


def read_frame(img: Image.Image) -> tuple[int, int] | None:
    x0, y0, x1, y1 = (int(hud.BAND[0] * W), int(hud.BAND[1] * H), int(hud.BAND[2] * W), int(hud.BAND[3] * H))
    got = hud.read_scores(img.crop((x0, y0, x1, y1)))
    if not got or got[2] < hud.MIN_CONFIDENCE:
        return None
    return int(got[0]), int(got[1])


def check_points(rounds: list[Round], teams: tuple[str, str], team: str, want: int = 4) -> list[tuple[int, tuple[int, int]]]:
    """(game time ms, expected (left, right)) at a few rounds with different scores, spread over the match."""
    other = teams[1] if team == teams[0] else teams[0]
    timeline = score_timeline(rounds, teams)
    points, seen = [], set()
    step = max(1, len(timeline) // (want + 1))
    for start, before, _ in timeline[step::step]:
        score = (before[team], before[other])
        if score not in seen:
            seen.add(score)
            points.append((start + CHECK_INTO_ROUND_MS, score))
    return points[:want]


def verify(playlist: str, offset_s: float, rounds: list[Round], teams: tuple[str, str], team: str, ffmpeg: str, grab=frame_at, read=read_frame) -> Verdict:
    """Reads the HUD in the VOD at a few known moments, trying common stream delays."""
    points = check_points(rounds, teams, team)
    if len(points) < 2:
        return Verdict(False, reason="match too short to check")
    best = Verdict(False, reason="scores in the VOD don't match")
    fits: list[Verdict] = []
    for delay in DELAYS:
        agreed = checked = 0
        for game_ms, expected in points:
            img = grab(playlist, offset_s + game_ms / 1000 + delay, ffmpeg)
            got = read(img) if img is not None else None
            if got is None:
                continue  # scoreboard hidden at that moment (menu, overlay): no evidence either way
            checked += 1
            agreed += got == expected
        if checked >= 2 and agreed == checked and agreed >= min(3, len(points)):
            fits.append(Verdict(True, delay, checked, agreed))
        elif fits:
            break  # past the delays that fit
        elif (agreed, checked) > (best.agreed, best.checked):
            # Kept even when nothing agreed: "4 read, 0 matched" means another game, not "couldn't read".
            best = Verdict(False, delay, checked, agreed, "only some scores matched" if agreed else "scores don't match")
    if fits:
        # A score holds for a whole round, so a range of delays fits: the true one is near its middle.
        mid = fits[len(fits) // 2]
        mid.delay_s = (fits[0].delay_s + fits[-1].delay_s) // 2
        return mid
    return best


# ---------- exact shift ----------

SHIFT_STEP_S = 8
MAX_SHIFT_S = 240  # stream delay plus agent select and loading


def measure_shift(playlist: str, offset_s: float, rounds: list[Round], teams: tuple[str, str], team: str,
                  events: list[tuple[int, int]], ffmpeg: str, grab=frame_at, read=read_frame, want: int = 5,
                  budget_s: float = 150, max_rounds: int = 10, workers: int = 6) -> float | None:
    """How many seconds later than `offset + match time` things happen in this VOD.

    The match's start time is roughly when agent select began, and every
    streamer has their own broadcast delay, so a VOD runs 1-2 minutes "late"
    and by a different amount per streamer. `events` are (match ms, round
    position) of rounds that ended by elimination: the HUD score changes at
    exactly that moment. For each, frames across the possible range are read
    in parallel to find where the score changes, then the gap is halved to
    about a second. Once one round is found, the next only look near it.
    Gives up after `budget_s` seconds or `max_rounds` rounds (an unreadable
    scoreboard must not hold clips up), returning the median of the rounds
    found (one odd round can't skew it), or None."""
    import time
    from concurrent.futures import ThreadPoolExecutor

    deadline = time.monotonic() + budget_s
    other = teams[1] if team == teams[0] else teams[0]
    timeline = score_timeline(rounds, teams)
    found: list[float] = []

    def score_at(t: float):
        img = grab(playlist, t, ffmpeg)
        return read(img) if img is not None else None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for decided_ms, pos in events[:max_rounds]:
            if time.monotonic() > deadline or len(found) >= want:
                break
            if pos >= len(timeline):
                continue
            _, before, after = timeline[pos]
            b, a = (before[team], before[other]), (after[team], after[other])
            base = offset_s + decided_ms / 1000
            if found:  # streams don't drift: look near the shift already found
                centre = sorted(found)[len(found) // 2]
                times = [base + centre + d for d in range(-16, 17, 4)]
            else:
                times = [base + d for d in range(-4, MAX_SHIFT_S + 1, SHIFT_STEP_S)]
            got = list(pool.map(score_at, times))
            lo = hi = None
            for t, g in zip(times, got):
                if g == b:
                    lo, hi = t, None
                elif g == a and lo is not None:
                    hi = t
                    break
            if lo is None or hi is None:
                continue  # score hidden, or it changed outside the range: can't pin it down
            while hi - lo > 1.0 and time.monotonic() < deadline:
                mid = (lo + hi) / 2
                g = score_at(mid)
                if g == b:
                    lo = mid
                elif g == a:
                    hi = mid
                else:
                    break
            found.append(hi - base)
    if not found:
        return None
    found.sort()
    return round(found[len(found) // 2], 1)
