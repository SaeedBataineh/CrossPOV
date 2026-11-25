import io
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from PIL import Image

import scanner
from store import Store

HERE = os.path.dirname(os.path.abspath(__file__))


def preview(path: str) -> bytes:
    """A 1280x720 preview JPEG with a real HUD strip (from a stream) where the HUD sits."""
    frame = Image.new("RGB", (scanner.W, scanner.H), (40, 60, 50))
    frame.paste(Image.open(path).convert("RGB"), (int(scanner.hud.BAND[0] * scanner.W), 0))
    out = io.BytesIO()
    frame.save(out, "JPEG", quality=95)
    return out.getvalue()


class FakeResponse:
    def __init__(self, content):
        self.content, self.ok, self.headers = content, True, {}


class FakeSession:
    def __init__(self, pictures):
        self.pictures = pictures

    def get(self, url, timeout=0):
        return FakeResponse(self.pictures[url.split("/")[-1]])


class SweepTest(unittest.TestCase):
    def test_reads_new_pictures_once(self):
        pic = preview(os.path.join(HERE, "testdata", "hud_10_11.png"))
        streams = [{"user_login": "Streamer", "user_id": "1", "thumbnail_url": "https://x.test/a-{width}x{height}"}]
        fake = FakeSession({"a-1280x720": pic})
        with tempfile.TemporaryDirectory() as d, ThreadPoolExecutor(2) as pool, \
                mock.patch.object(scanner, "live_valorant_streams", return_value=streams), \
                mock.patch.object(scanner.requests, "Session", return_value=fake):
            scanner._local.__dict__.clear()
            store, seen = Store(os.path.join(d, "r.db")), {}
            first = scanner.sweep(None, store, pool, seen)
            self.assertEqual((first["new"], first["read"]), (1, 1))
            rows = store.between(0, 2**62)
            self.assertEqual([(r[0], r[4], r[5]) for r in rows], [("streamer", 10, 11)])
            # Same picture next sweep: not read or stored again.
            again = scanner.sweep(None, store, pool, seen)
            self.assertEqual((again["new"], again["read"]), (0, 0))
            self.assertEqual(len(store.between(0, 2**62)), 1)
            # Stream gone offline: forgotten.
            with mock.patch.object(scanner, "live_valorant_streams", return_value=[]):
                scanner.sweep(None, store, pool, seen)
            self.assertEqual(seen, {})


if __name__ == "__main__":
    unittest.main()
