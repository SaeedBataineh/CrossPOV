"""Which live streams were in a given match, judged by their scoreboards.

The scanner keeps reading every live VALORANT stream's HUD score (left =
the streamer's team, right = the other team). After a match, its round-by-
round score is known exactly, so a stream that was in it must have shown the
match's score at the times it was read. A different game shows a different
score sooner or later.

A reading's game time is only known roughly: Twitch preview images can be a
few minutes old and streamers often run a broadcast delay. So each reading is
checked against every score the match had during a window of time, and a
stream needs several agreeing readings and more than one distinct score.

About 2% of readings are wrong (a misread digit), so one contradicting
reading doesn't rule out a stream that otherwise fits well; it costs an extra
agreeing reading and an extra distinct score instead. A reading whose time
window reaches past the end of the match may already show the streamer's next
game, so it can agree but never contradict. Every stream found here is still checked in its VOD
before it is suggested (verify.py), which removes wrong ones.
"""

from __future__ import annotations

from dataclasses import dataclass

# How old a preview image can be, plus the stream delay we allow, in ms.
PREVIEW_AGE_MS = 5 * 60_000
MAX_DELAY_MS = 90_000

MIN_AGREE = 3
MIN_DISTINCT = 2
# Contradicting readings forgiven; each one forgiven needs one more agreeing reading and distinct score.
MAX_ODD = 1


@dataclass(frozen=True)
class Round:
    start_ms: int  # since the match started
    winner: str | None  # team id that won it, None if unknown


@dataclass(frozen=True)
class Reading:
    login: str
    taken_ms: int  # epoch ms: best estimate of when the preview was captured
    left: int
    right: int
    # How much older than taken_ms the picture might be (unknown capture time: a whole preview cycle).
    uncertain_ms: int = PREVIEW_AGE_MS


@dataclass
class Hit:
    login: str
    team: str  # the streamer's team id
    agree: int
    distinct: int
    disagree: int


def fits(agree: int, distinct: int, disagree: int) -> bool:
    return disagree <= MAX_ODD and agree >= MIN_AGREE + disagree and distinct >= MIN_DISTINCT + disagree


def score_timeline(rounds: list[Round], teams: tuple[str, str]) -> list[tuple[int, dict[str, int], dict[str, int]]]:
    """For each round: (start_ms, score before it, score after it) by team id."""
    a, b = teams
    score = {a: 0, b: 0}
    out = []
    for r in sorted(rounds, key=lambda r: r.start_ms):
        before = dict(score)
        if r.winner in score:
            score[r.winner] += 1
        out.append((r.start_ms, before, dict(score)))
    return out


def scores_between(timeline, t0: int, t1: int) -> set[tuple[int, int, str, str]]:
    """Every (score_x, score_y, x, y) the HUD could show at some game time in [t0, t1].

    During a round the HUD shows the score before it, and from the moment the
    round is decided (unknown, before the next round starts) the score after it."""
    out = set()
    for i, (start, before, after) in enumerate(timeline):
        end = timeline[i + 1][0] if i + 1 < len(timeline) else start + 180_000
        if end < t0 or start > t1:
            continue
        for s in (before, after):
            (x, sx), (y, sy) = s.items()
            out.add((sx, sy, x, y))
            out.add((sy, sx, y, x))
    return out


def match_streams(readings: list[Reading], start_ms: int, length_ms: int, rounds: list[Round], teams: tuple[str, str]) -> list[Hit]:
    """Streams whose readings fit this match, best first."""
    timeline = score_timeline(rounds, teams)
    if len(timeline) < 2:
        return []
    by_login: dict[str, list[Reading]] = {}
    for r in readings:
        by_login.setdefault(r.login, []).append(r)

    hits = []
    for login, rs in by_login.items():
        for team, other in (teams, teams[::-1]):  # which side the streamer is on
            agree, disagree, distinct = 0, 0, set()
            for r in rs:
                age = r.uncertain_ms + MAX_DELAY_MS
                # Game time the picture could show: captured at taken_ms, of a moment up to `age` earlier.
                t1 = r.taken_ms - start_ms
                t0 = t1 - age
                if t1 < 0 or t0 > length_ms:
                    continue  # not during this match
                possible = {(sx, sy) for sx, sy, x, _ in scores_between(timeline, max(t0, 0), t1) if x == team}
                if (r.left, r.right) in possible:
                    agree += 1
                    distinct.add((r.left, r.right))
                elif t1 <= length_ms:
                    disagree += 1  # not after the match ended, so it really is a different score
            if fits(agree, len(distinct), disagree):
                hits.append(Hit(login, team, agree, len(distinct), disagree))
    # A stream fits one side at most; keep its stronger side.
    best: dict[str, Hit] = {}
    for h in hits:
        if h.login not in best or h.agree > best[h.login].agree:
            best[h.login] = h
    return sorted(best.values(), key=lambda h: (h.disagree, -h.agree, h.login))
