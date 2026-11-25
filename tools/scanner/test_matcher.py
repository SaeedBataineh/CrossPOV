import unittest

from matcher import MAX_DELAY_MS, Reading, Round, match_streams, score_timeline

START = 1_700_000_000_000
TEAMS = ("Blue", "Red")
# 13 rounds of 100 s each; Blue wins rounds 1,2,4,5,6,8,... the score goes 0-0, 1-0, 2-0, 2-1, ...
WINNERS = ["Blue", "Blue", "Red", "Blue", "Blue", "Red", "Blue", "Red", "Red", "Blue", "Blue", "Blue", "Blue"]
ROUNDS = [Round(55_000 + i * 100_000, w) for i, w in enumerate(WINNERS)]
LENGTH = 55_000 + len(ROUNDS) * 100_000


def score_before(i):
    _, before, _ = score_timeline(ROUNDS, TEAMS)[i]
    return before


def reading(login, round_i, side="Blue", into=40_000, delay=0, uncertain=30_000):
    """What a stream on `side` shows `into` ms into round i, read `delay` ms later."""
    b = score_before(round_i)
    other = "Red" if side == "Blue" else "Blue"
    t = START + ROUNDS[round_i].start_ms + into + delay
    return Reading(login, t, b[side], b[other], uncertain)


class MatcherTest(unittest.TestCase):
    def test_finds_a_stream_in_the_match_and_its_team(self):
        rs = [reading("streamer", i, "Red") for i in (2, 5, 8, 11)]
        hits = match_streams(rs, START, LENGTH, ROUNDS, TEAMS)
        self.assertEqual([(h.login, h.team) for h in hits], [("streamer", "Red")])

    def test_stream_delay_and_old_previews_are_tolerated(self):
        rs = [reading("delayed", i, "Blue", delay=MAX_DELAY_MS - 5_000, uncertain=60_000) for i in (3, 6, 9)]
        self.assertEqual([h.login for h in match_streams(rs, START, LENGTH, ROUNDS, TEAMS)], ["delayed"])

    def test_another_game_is_rejected(self):
        # Plausible scores, but not this match's at those times.
        rs = [Reading("other", START + ROUNDS[i].start_ms + 40_000, s[0], s[1], 30_000) for i, s in ((2, (0, 2)), (5, (1, 4)), (8, (6, 2)))]
        self.assertEqual(match_streams(rs, START, LENGTH, ROUNDS, TEAMS), [])

    def test_one_contradiction_rules_a_stream_out(self):
        rs = [reading("mixed", i, "Blue") for i in (2, 5, 8)]
        rs.append(Reading("mixed", START + ROUNDS[10].start_ms + 40_000, 0, 9, 30_000))
        self.assertEqual(match_streams(rs, START, LENGTH, ROUNDS, TEAMS), [])

    def test_needs_several_different_scores(self):
        # Three readings of the same early 0-0 could be any game.
        rs = [reading("early", 0, "Blue", into=x) for x in (10_000, 20_000, 30_000)]
        self.assertEqual(match_streams(rs, START, LENGTH, ROUNDS, TEAMS), [])
        # And two readings aren't enough.
        self.assertEqual(match_streams([reading("two", i) for i in (3, 7)], START, LENGTH, ROUNDS, TEAMS), [])

    def test_readings_outside_the_match_are_ignored(self):
        rs = [reading("s", i) for i in (2, 5, 8)]
        rs.append(Reading("s", START - 600_000, 7, 3, 30_000))  # their previous game
        rs.append(Reading("s", START + LENGTH + 900_000, 1, 1, 30_000))  # their next game
        self.assertEqual([h.login for h in match_streams(rs, START, LENGTH, ROUNDS, TEAMS)], ["s"])

    def test_score_shown_after_a_round_is_decided_counts(self):
        # Late in round 3 the HUD may already show the score after it.
        i = 3
        _, _, after = score_timeline(ROUNDS, TEAMS)[i]
        t = START + ROUNDS[i].start_ms + 95_000
        rs = [reading("s", 1), reading("s", 6), Reading("s", t, after["Blue"], after["Red"], 30_000)]
        self.assertEqual(len(match_streams(rs, START, LENGTH, ROUNDS, TEAMS)), 1)


if __name__ == "__main__":
    unittest.main()
