"""Reads the two round scores from VALORANT's top HUD on a stream preview.

The HUD is [left score] [round timer or spike] [right score], centred at the
top of the screen. Instead of general OCR this matches the HUD's own digit
shapes (templates in digits.npz, cut from real stream previews) with
normalised cross-correlation, which copes with bright maps, faded digits and
JPEG blur far better than Tesseract on 14-pixel-tall text.

How a scoreboard is recognised: two numbers at the same height, placed
symmetrically around the middle of the strip. Lobbies, menus and overlays
don't have that, so they give None. Stretched resolutions and cropped or
letterboxed layouts change the HUD's size, so a few sizes are tried.

Measured on 80 hand-labelled previews (58 with a scoreboard), keeping
readings at MIN_CONFIDENCE or above: 53 of 58 scoreboards read, 52 of them
exactly right, and no non-scoreboard misread. Templates built from half the
previews and tested on the other half did somewhat worse (one half lacked a
"3" to learn from), so expect roughly 80-85% on new streams until the
templates are rebuilt from more previews.
"""

from __future__ import annotations

import os

import numpy as np
from PIL import Image

_HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES: dict[str, np.ndarray] = dict(np.load(os.path.join(_HERE, "digits.npz")))

# The part of a 1280x720 frame the HUD lives in (fractions of width/height).
BAND = (0.30, 0.0, 0.70, 0.085)

# (horizontal, vertical) resize factors that bring other HUD sizes to the
# template size: normal, stretched resolutions (wider digits), and cropped
# or letterboxed layouts (smaller or bigger HUD).
SCALES = [(1.0, 1.0), (0.82, 1.0), (1.0, 1.25), (0.85, 1.25), (1.1, 1.5), (0.9, 1.5), (0.8, 0.85), (1.0, 0.85)]

MARGIN = 2  # templates include 2 px of background around each digit

# Readings below this are dropped: on the labelled previews it removes 4 of
# the 5 wrong readings and only 1 of 53 right ones. A wrong score would match
# the wrong game, so missing a reading is the better mistake.
MIN_CONFIDENCE = 1.25


def whiteness(img: Image.Image) -> np.ndarray:
    """HUD digits are white: the darkest of R, G, B is high only for white-ish pixels."""
    return np.asarray(img.convert("RGB")).min(axis=2).astype(np.float64)


def _box_sums(ii: np.ndarray, th: int, tw: int) -> np.ndarray:
    return ii[th:, tw:] - ii[:-th, tw:] - ii[th:, :-tw] + ii[:-th, :-tw]


def _max_filter(a: np.ndarray, k: int, axis: int) -> np.ndarray:
    out = a.copy()
    for i in range(1, k):
        src = [slice(None)] * 2
        dst = [slice(None)] * 2
        src[axis] = slice(i, None)
        dst[axis] = slice(None, -i)
        out[tuple(dst)] = np.maximum(out[tuple(dst)], a[tuple(src)])
    return out


def detect(w: np.ndarray, thr: float = 0.4) -> list[tuple[float, int, int, int, str]]:
    """Places a digit template matches: (match score, x0, y0, x1, digit).

    Normalised cross-correlation via FFT plus running sums, a few ms per strip."""
    H, W = w.shape
    ii = np.zeros((H + 1, W + 1))
    ii[1:, 1:] = w.cumsum(0).cumsum(1)
    ii2 = np.zeros((H + 1, W + 1))
    ii2[1:, 1:] = (w * w).cumsum(0).cumsum(1)
    spectrum = np.fft.rfft2(w)
    hits = []
    for digit, t in TEMPLATES.items():
        th, tw = t.shape
        if th > H or tw > W:
            continue
        n = th * tw
        kernel = np.zeros((H, W))
        kernel[:th, :tw] = t[::-1, ::-1]
        corr = np.fft.irfft2(spectrum * np.fft.rfft2(kernel), s=(H, W))[th - 1 :, tw - 1 :]
        mean = _box_sums(ii, th, tw) / n
        sd = np.sqrt(np.maximum(_box_sums(ii2, th, tw) / n - mean * mean, 0)) + 1e-6
        ncc = corr / (n * sd)  # templates are zero-mean, unit-variance
        # The digit must be brighter than its surroundings (white text), not just the right shape.
        core = _max_filter(_max_filter(w[MARGIN:, MARGIN:], th - 2 * MARGIN, 0), tw - 2 * MARGIN, 1)
        ok = (ncc >= thr) & (core[: ncc.shape[0], : ncc.shape[1]] - mean > 18)
        # Only local peaks, so one digit gives one hit.
        padded = np.pad(ncc, 2, constant_values=-1)
        neighbours = np.max(
            np.stack([padded[2 + dy : 2 + dy + ncc.shape[0], 2 + dx : 2 + dx + ncc.shape[1]] for dy in range(-2, 3) for dx in range(-2, 3)]),
            axis=0,
        )
        ok &= ncc >= neighbours
        for y, x in zip(*np.nonzero(ok)):
            hits.append((float(ncc[y, x]), int(x) + MARGIN, int(y) + MARGIN, int(x) + tw - MARGIN, digit))
    hits.sort(reverse=True)
    keep: list[tuple[float, int, int, int, str]] = []
    for d in hits:  # best first; drop weaker hits overlapping a better one
        if all(min(d[3], k[3]) - max(d[1], k[1]) < 0.35 * min(d[3] - d[1], k[3] - k[1]) or abs(d[2] - k[2]) > 8 for k in keep):
            keep.append(d)
    return keep


def numbers(hits):
    """Digits side by side become numbers: (value, x centre, y, mean match score)."""
    hits = sorted(hits, key=lambda d: d[1])
    groups = []
    for i, d in enumerate(hits):
        groups.append([d])
        for e in hits[i + 1 :]:
            # Digits of one number sit 9-14 px apart centre to centre (a "1" is thin but has a full-width cell).
            if 9 <= (e[1] + e[3]) / 2 - (d[1] + d[3]) / 2 <= 14 and abs(e[2] - d[2]) <= 2:
                groups.append([d, e])
    # A digit that is part of a confident two-digit number isn't also a number on its own.
    pairs = [g for g in groups if len(g) == 2 and min(x[0] for x in g) >= 0.55 and g[0][4] != "0"]
    in_pair = {id(x) for g in pairs for x in g}
    groups = [g for g in groups if len(g) == 2 or id(g[0]) not in in_pair]
    out = []
    for g in groups:
        if len(g) == 2 and g[0][4] == "0":
            continue
        out.append((int("".join(x[4] for x in g)), (g[0][1] + g[-1][3]) / 2, g[0][2], sum(x[0] for x in g) / len(g)))
    return out


def _scores_at(w: np.ndarray):
    width = w.shape[1]
    mid = width / 2
    best = None
    nums = numbers(detect(w))
    for L in nums:
        for R in nums:
            if not L[1] < R[1] or abs(L[2] - R[2]) > 2:
                continue
            if not 0.25 * width <= R[1] - L[1] <= 0.62 * width:
                continue
            centre = (L[1] + R[1]) / 2
            if abs(centre - mid) > 0.09 * width:
                continue
            # A lone "1" is just a vertical bar, which text and edges also are: ask more of it.
            if any(set(str(N[0])) == {"1"} and N[3] < 0.75 for N in (L, R)):
                continue
            if max(L[3], R[3]) < 0.62 or min(L[3], R[3]) < 0.42:
                continue
            score = L[3] + R[3] - abs(centre - mid) / width
            if best is None or score > best[0]:
                best = (score, L, R)
    if not best:
        return None
    score, L, R = best
    return L[0], R[0], score, L[1], R[1]


def read_scores(strip: Image.Image):
    """Reads the HUD strip (the BAND crop of a 1280x720 frame).

    Returns (left score, right score, confidence, left x, right x) with x as
    fractions of the strip width, or None when no scoreboard is visible."""
    w = whiteness(strip)
    h, wd = w.shape
    best = None
    for fx, fy in SCALES:
        img = w
        if (fx, fy) != (1.0, 1.0):
            img = np.asarray(Image.fromarray(w.astype(np.uint8)).resize((round(wd * fx), round(h * fy)), Image.BILINEAR)).astype(np.float64)
        got = _scores_at(img)
        if not got:
            continue
        left, right, score, lx, rx = got
        if (fx, fy) != (1.0, 1.0):
            score -= 0.08  # the usual HUD size wins a close call
        sw = img.shape[1]
        if best is None or score > best[2]:
            best = (left, right, round(score, 3), lx / sw, rx / sw)
    return best
