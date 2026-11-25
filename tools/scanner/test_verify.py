import unittest

from matcher import Round, score_timeline
from verify import check_points, measure_shift, verify

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


class ShiftTest(unittest.TestCase):
    """measure_shift on a fake VOD whose HUD runs `late` seconds behind the match clock."""

    def vod(self, team, late, hidden=()):
        other = "Red" if team == "Blue" else "Blue"
        timeline = score_timeline(ROUNDS, TEAMS)
        # Score changes the moment each round is decided (here: 80 s into the round).
        ends = [start + 80_000 for start, _, _ in timeline]

        def grab(_p, t, _f):
            game_ms = (t - OFFSET - late) * 1000
            if any(abs(game_ms - h) < 3_000 for h in hidden):
                return None
            done = sum(1 for e in ends if e <= game_ms)
            if done == 0:
                return (0, 0)
            _, _, after = timeline[done - 1]
            return (after[team], after[other])

        return grab, [(e, i) for i, e in enumerate(ends)]

    def test_finds_the_shift_to_about_a_second(self):
        for late in (0.0, 37.5, 74.0, 131.0):
            grab, events = self.vod("Red", late)
            got = measure_shift("pl", OFFSET, ROUNDS, TEAMS, "Red", events[2:6], "ff", grab=grab, read=read)
            self.assertIsNotNone(got)
            self.assertLess(abs(got - late), 1.5, f"late {late}: got {got}")

    def test_hidden_scoreboard_gives_none_not_a_guess(self):
        grab, events = self.vod("Blue", 60, hidden=[e for e, _ in self.vod("Blue", 60)[1]])
        self.assertIsNone(measure_shift("pl", OFFSET, ROUNDS, TEAMS, "Blue", [(e, i) for e, i in events][:1], "ff",
                                        grab=lambda *a: None, read=read))


class ShiftBudgetTest(unittest.TestCase):
    def test_an_unreadable_scoreboard_gives_up_quickly(self):
        calls = []

        def grab(_p, t, _f):
            calls.append(t)
            return None  # HUD always hidden

        events = [(55_000 + i * 100_000 + 80_000, i) for i in range(len(ROUNDS))]
        self.assertIsNone(measure_shift("pl", OFFSET, ROUNDS, TEAMS, "Blue", events, "ff", grab=grab, read=read, max_rounds=3))
        self.assertLessEqual(len(calls), 3 * 32, "stops after max_rounds, not every round")


class FastFramesTest(unittest.TestCase):
    def test_reads_the_chunk_list(self):
        from verify import parse_playlist

        text = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.000,\n0.ts\n#EXTINF:10.000,\n1-muted.ts\n#EXTINF:4.5,\nhttps://cdn.example/2.ts\n#EXT-X-ENDLIST\n"
        segs, init = parse_playlist(text, "https://vod.example/abc/720p/index-dvr.m3u8")
        self.assertIsNone(init)
        self.assertEqual([s.start for s in segs], [0.0, 10.0, 20.0])
        self.assertEqual(segs[1].url, "https://vod.example/abc/720p/1-muted.ts")
        self.assertEqual(segs[2].url, "https://cdn.example/2.ts")
        _, init = parse_playlist('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\n0.mp4\n', "https://v.example/a/i.m3u8")
        self.assertEqual(init, "https://v.example/a/init.mp4")

    def test_strips_come_from_the_right_second_and_each_chunk_is_read_once(self):
        """A real little HLS stream whose brightness rises with time, served over HTTP."""
        import functools
        import shutil
        import subprocess
        import tempfile
        import threading
        from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

        from PIL import ImageStat

        from verify import VodFrames

        ff = shutil.which("ffmpeg")
        if not ff:
            self.skipTest("no ffmpeg")
        d = tempfile.mkdtemp()
        subprocess.run(
            [ff, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=24,format=yuv420p,geq=lum='40+T*8':cb=128:cr=128",
             "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", "-f", "hls", "-hls_time", "6", "-hls_list_size", "0",
             f"{d}/index.m3u8"], check=True)
        asked: list[str] = []

        class Handler(SimpleHTTPRequestHandler):
            def log_message(self, *a):
                asked.append(self.path)

        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=d))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            frames = VodFrames(f"http://127.0.0.1:{server.server_port}/index.m3u8", ff)
            self.assertGreaterEqual(len(frames.segments), 4)
            for t in [1.0, 3.2, 7.5, 13.0, 20.6]:
                strip = frames.grab("ignored", t)
                self.assertEqual(strip.size, (512, 61))
                lum = ImageStat.Stat(strip.convert("L")).mean[0]
                self.assertAlmostEqual(lum, (24 + t * 8) * 255 / 219, delta=5, msg=f"t={t}")  # within about half a second
            self.assertIsNone(frames.grab("ignored", 999))
            before = len(asked)
            for t in [7.0, 7.6, 8.1, 11.9]:  # all inside chunks already read
                frames.grab("ignored", t)
            self.assertEqual(len(asked), before, "no chunk downloaded twice")
        finally:
            server.shutdown()
            server.server_close()
            shutil.rmtree(d, ignore_errors=True)
