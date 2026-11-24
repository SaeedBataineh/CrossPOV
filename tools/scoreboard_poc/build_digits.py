"""Rebuilds digits.npz (the HUD digit templates hud.py matches against).

Needs a folder of HUD strips (the BAND crop of 1280x720 previews, e.g. the
images in a scanner run's sample.html) and a labels file with one line per
strip: "<name> <left score> <timer> <right score>", using "-" for strips
without a scoreboard and "?" for scores you can't see. More labelled strips,
especially of rarer digits, make the reader more accurate.

    python build_digits.py STRIPS_DIR LABELS_FILE
"""

import collections
import os
import sys

import numpy as np
from PIL import Image

H, MARGIN = 14, 2  # digit height in a 1280x720 frame, and background kept around it


def _min_filter(a, k, axis):
    pad = k // 2
    b = np.pad(a, [(pad, pad) if i == axis else (0, 0) for i in range(2)], mode="edge")
    out = b.take(range(0, a.shape[axis]), axis=axis)
    for i in range(1, k):
        out = np.minimum(out, b.take(range(i, i + a.shape[axis]), axis=axis))
    return out


def tophat(w, k=9):
    """Thin bright strokes: the image minus its morphological opening."""
    opened = -_min_filter(-_min_filter(_min_filter(_min_filter(w, k, 1), k, 0), k, 1), k, 0)
    return w - opened


def components(mask):
    """4-connected blobs as (x0, y0, x1, y1)."""
    h, w = mask.shape
    seen = np.zeros_like(mask, bool)
    out = []
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        stack = [(y, x)]
        seen[y, x] = True
        x0 = x1 = x
        y0 = y1 = y
        while stack:
            cy, cx = stack.pop()
            x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        out.append((int(x0), int(y0), int(x1), int(y1)))
    return out


def main(strips, labels_file):
    samples = collections.defaultdict(list)
    for line in open(labels_file):
        if line.startswith("#") or not line.strip():
            continue
        name, left, _, right = line.split()
        path = next((os.path.join(strips, name + e) for e in (".png", ".jpg", ".jpeg") if os.path.exists(os.path.join(strips, name + e))), None)
        if not path or left in "-?":
            continue
        w = np.asarray(Image.open(path).convert("RGB")).min(axis=2).astype(np.int16)
        if w.shape[1] != 512:
            continue  # only strips at the standard size: digits must be 14 px tall
        mask = (tophat(w) > 40) & (w > 150)
        boxes = sorted(b for b in components(mask) if 12 <= b[3] - b[1] + 1 <= 16 and 3 <= b[2] - b[0] + 1 <= 12 and 22 <= b[1] <= 31)
        for side, text in (("L", left), ("R", right)):
            if not text.isdigit():
                continue
            near = [b for b in boxes if (100 <= (b[0] + b[2]) / 2 <= 215 if side == "L" else 297 <= (b[0] + b[2]) / 2 <= 412)]
            run = near[-len(text):] if side == "L" else near[: len(text)]  # the score is the run nearest the timer
            if len(run) != len(text):
                continue
            for ch, (x0, y0, x1, y1) in zip(text, run):
                if y1 - y0 + 1 >= 13:
                    samples[ch].append(w[y0 - MARGIN : y0 + H + MARGIN, x0 - MARGIN : x1 + 1 + MARGIN].astype(float))
    templates = {}
    for ch, crops in sorted(samples.items()):
        width = int(round(np.median([c.shape[1] for c in crops])))
        resized = [np.asarray(Image.fromarray(c.astype(np.uint8)).resize((width, H + 2 * MARGIN), Image.BILINEAR)).astype(float) for c in crops]
        templates[ch] = np.mean([(r - r.mean()) / (r.std() + 1e-6) for r in resized], axis=0)
        print(f"{ch}: {len(crops)} samples")
    missing = sorted(set("0123456789") - set(templates))
    if missing:
        sys.exit(f"No samples of {', '.join(missing)}: label more strips. digits.npz was not changed.")
    np.savez(os.path.join(os.path.dirname(os.path.abspath(__file__)), "digits.npz"), **templates)
    print("wrote digits.npz")


if __name__ == "__main__":
    main(*sys.argv[1:3])
