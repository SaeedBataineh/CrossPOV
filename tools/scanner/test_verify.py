import unittest

from matcher import Round, score_timeline
from verify import check_points, verify

TEAMS = ("Blue", "Red")
WINNERS = ["Blue", "Red", "Red", "Blue", "Blue", "Blue", "Red", "Blue", "Blue", "Red", "Blue", "Blue"]
ROUNDS = [Round(55_000 + i * 100_000, w) for i, w in enumerate(WINNERS)]
OFFSET = 3_600.0  # the match started an hour into their stream


def fake_vod(team, delay_s, hidden=()):
    """A VOD of a streamer on `team` with a broadcast delay: grab(t) gives the HUD score shown at VOD time t."""
    other = "Red" if team == "Blue" else "Blue"
    timeline = score_timeline(ROUNDS, TEAMS)

    def grab(_playlist, t, _ffmpeg):
        game_ms = (t - OFFSET - delay_s) * 1000
        cur = [x for x in timeline if x[0] <= game_ms]
        if not cur or any(abs(game_ms - h) < 5_000 for h in hidden):
            return None
        _, before, _ = cur[-1]
        return (before[team], before[other])

    return grab


def read(img):
    return img


class VerifyTest(unittest.TestCase):
    def test_confirms_the_right_stream_and_measures_its_delay(self):
        v = verify("pl", OFFSET, ROUNDS, TEAMS, "Red", "ff", grab=fake_vod("Red", 45), read=read)
        self.assertTrue(v.ok)
        self.assertLessEqual(abs(v.delay_s - 45), 30, "close enough to place a clip with 60 s padding")
        v0 = verify("pl", OFFSET, ROUNDS, TEAMS, "Red", "ff", grab=fake_vod("Red", 0), read=read)
        self.assertTrue(v0.ok)
        self.assertLessEqual(v0.delay_s, 30)

    def test_rejects_a_stream_from_another_game(self):
        def other_game(_p, t, _f):
            return (int(t) % 7, int(t) % 5)
        v = verify("pl", OFFSET, ROUNDS, TEAMS, "Red", "ff", grab=other_game, read=read)
        self.assertFalse(v.ok)
        self.assertGreaterEqual(v.checked, 3, "readable but wrong scores still count as checked, so it's 'different', not 'unknown'")
        self.assertLess(v.agreed * 2, v.checked)

    def test_wrong_team_is_rejected(self):
        self.assertFalse(verify("pl", OFFSET, ROUNDS, TEAMS, "Blue", "ff", grab=fake_vod("Red", 0), read=read).ok)

    def test_hidden_scoreboards_are_skipped_not_counted_against(self):
        hidden = [p[0] for p in check_points(ROUNDS, TEAMS, "Blue")[:1]]
        v = verify("pl", OFFSET, ROUNDS, TEAMS, "Blue", "ff", grab=fake_vod("Blue", 0, hidden), read=read)
        self.assertTrue(v.ok)

    def test_check_points_use_different_scores(self):
        pts = check_points(ROUNDS, TEAMS, "Blue")
        self.assertGreaterEqual(len(pts), 3)
        self.assertEqual(len({s for _, s in pts}), len(pts))


if __name__ == "__main__":
    unittest.main()
