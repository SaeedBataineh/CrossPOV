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


def _band_box() -> tuple[int, int, int, int]:
    return (int(hud.BAND[0] * W), int(hud.BAND[1] * H), int(hud.BAND[2] * W), int(hud.BAND[3] * H))


def read_band(band: Image.Image) -> tuple[int, int] | None:
    """The score in a scoreboard strip (what VodFrames hands out)."""
    got = hud.read_scores(band)
    if not got or got[2] < hud.MIN_CONFIDENCE:
        return None
    return int(got[0]), int(got[1])


# ---------- fast frames ----------

FPS = 2  # scoreboard strips kept per second of video: plenty to pin a score change to a second


@dataclass
class Segment:
    start: float
    duration: float
    url: str


def parse_playlist(text: str, base: str) -> tuple[list[Segment], str | None]:
    """The chunks of an HLS media playlist with their start times, and the init chunk (fMP4) if any."""
    from urllib.parse import urljoin

    segs: list[Segment] = []
    init = None
    t, dur = 0.0, None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXTINF:"):
            try:
                dur = float(line[8:].split(",")[0])
            except ValueError:
                dur = None
        elif line.startswith("#EXT-X-MAP:") and 'URI="' in line:
            init = urljoin(base, line.split('URI="', 1)[1].split('"', 1)[0])
        elif line and not line.startswith("#") and dur is not None:
            segs.append(Segment(t, dur, urljoin(base, line)))
            t += dur
            dur = None
    return segs, init


class VodFrames:
    """Scoreboard strips from one VOD, fast: the chunk list is read once, and
    each 10-second chunk is downloaded and decoded once (by one FFmpeg run,
    cropped to the scoreboard inside FFmpeg), keeping a strip every half
    second. Nearby moments then cost nothing. Thread-safe; if anything about
    the playlist is unexpected it falls back to one FFmpeg run per frame."""

    def __init__(self, playlist: str, ffmpeg: str, session=None):
        import threading

        import requests

        self.playlist, self.ffmpeg = playlist, ffmpeg
        self.session = session or requests.Session()
        self.lock = threading.Lock()
        self.chunks: dict[int, object] = {}  # index -> list of strips, or an Event while loading
        self.segments: list[Segment] = []
        self.init: bytes | None = None
        try:
            r = self.session.get(playlist, timeout=20)
            if r.ok:
                self.segments, init_url = parse_playlist(r.text, playlist)
                if init_url:
                    ir = self.session.get(init_url, timeout=20)
                    self.init = ir.content if ir.ok else None
                    if self.init is None:
                        self.segments = []
        except Exception:
            self.segments = []

    def grab(self, _playlist: str, seconds: float, _ffmpeg: str = "") -> Image.Image | None:
        """Same shape as frame_at, but returns just the scoreboard strip."""
        if not self.segments:
            img = frame_at(self.playlist, seconds, self.ffmpeg)
            return img.crop(_band_box()) if img is not None else None
        i = self._index(seconds)
        if i is None:
            return None
        strips = self._chunk(i)
        if not strips:
            return None
        k = int((seconds - self.segments[i].start) * FPS)
        return strips[max(0, min(k, len(strips) - 1))]

    def _index(self, seconds: float) -> int | None:
        import bisect

        if seconds < 0:
            return None
        i = bisect.bisect_right([s.start for s in self.segments], seconds) - 1
        if i < 0 or seconds >= self.segments[i].start + self.segments[i].duration:
            return None
        return i

    def _chunk(self, i: int) -> list[Image.Image]:
        import threading

        with self.lock:
            got = self.chunks.get(i)
            if got is None:
                self.chunks[i] = ev = threading.Event()
                mine = True
            else:
                mine = False
        if not mine:
            if isinstance(got, threading.Event):
                got.wait(90)
                got = self.chunks.get(i)
            return got if isinstance(got, list) else []
        strips = self._decode(i)
        with self.lock:
            self.chunks[i] = strips
        ev.set()
        return strips

    def _decode(self, i: int) -> list[Image.Image]:
        x0, y0, x1, y1 = _band_box()
        w, h = x1 - x0, y1 - y0
        try:
            r = self.session.get(self.segments[i].url, timeout=30)
            if not r.ok or not r.content:
                return []
            data = (self.init or b"") + r.content
            out = subprocess.run(
                [self.ffmpeg, "-v", "error", "-i", "pipe:0",
                 "-vf", f"fps={FPS}:round=down,scale={W}:{H},crop={w}:{h}:{x0}:{y0}",
                 "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                input=data, capture_output=True, timeout=60,
            )
        except Exception:
            return []
        size = w * h * 3
        raw = out.stdout
        return [Image.frombytes("RGB", (w, h), raw[o:o + size]) for o in range(0, len(raw) - size + 1, size)]


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
    from concurrent.futures import ThreadPoolExecutor

    def score_at(t: float):
        img = grab(playlist, t, ffmpeg)
        return read(img) if img is not None else None

    pool = ThreadPoolExecutor(max_workers=len(points))
    for delay in DELAYS:
        agreed = checked = 0
        # One delay's moments at once; the next delay only if still needed.
        scores = list(pool.map(score_at, [offset_s + game_ms / 1000 + delay for game_ms, _ in points]))
        for (_, expected), got in zip(points, scores):
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
    pool.shutdown(wait=False)
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
