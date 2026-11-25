import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from api import Matcher, check_signature, make_handler, signature, _duration_s
from store import Store
from test_matcher import LENGTH, ROUNDS, START, TEAMS, reading

KEY = b"k" * 40


def signed(method, path, body=b"", key=KEY, ts=None):
    ts = str(int(ts if ts is not None else time.time()))
    return {"X-CrossPOV-Time": ts, "X-CrossPOV-Signature": signature(key, ts, method, path, body)}


MATCH = {
    "id": "m1", "startedAt": START, "lengthMs": LENGTH, "teams": list(TEAMS),
    "rounds": [{"startMs": r.start_ms, "winner": r.winner} for r in ROUNDS],
}


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(os.path.join(self.tmp, "r.db"))
        rows = [reading("streamer", i, "Red") for i in (2, 5, 8, 11)] + [reading("other", i, "Blue", into=5_000) for i in (0,)]
        self.store.add([(r.login, "uid-" + r.login, r.taken_ms, r.uncertain_ms, r.left, r.right, None, 1.5) for r in rows])
        self.verified = []

        def fake_verify(login, user_id, start, rounds, teams, team):
            self.verified.append(login)
            return {"login": login, "userId": user_id, "team": team, "delaySec": 15} if login == "streamer" else None

        self.matcher = Matcher(self.store, fake_verify)

    def test_signatures(self):
        body = b'{"a":1}'
        self.assertTrue(check_signature(KEY, signed("POST", "/match", body), "POST", "/match", body))
        self.assertFalse(check_signature(KEY, signed("POST", "/match", body, key=b"x" * 40), "POST", "/match", body), "wrong key")
        self.assertFalse(check_signature(KEY, signed("POST", "/match", body), "POST", "/match", b'{"a":2}'), "changed body")
        self.assertFalse(check_signature(KEY, signed("POST", "/match", body, ts=time.time() - 3600), "POST", "/match", body), "replayed later")
        self.assertFalse(check_signature(KEY, {}, "POST", "/match", body), "unsigned")

    def test_background_job_finds_and_confirms(self):
        self.assertEqual(self.matcher.request(MATCH), {"status": "pending"})
        for _ in range(100):
            res = self.matcher.request(MATCH)
            if res["status"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual([s["login"] for s in res["streams"]], ["streamer"])
        self.assertEqual(res["streams"][0]["team"], "Red")
        self.assertEqual(self.verified, ["streamer"], "only real candidates are checked against VODs")

    def test_http_server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(KEY, self.matcher, self.store))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            body = json.dumps(MATCH).encode()
            req = urllib.request.Request(base + "/match", data=body, headers=signed("POST", "/match", body), method="POST")
            self.assertEqual(json.load(urllib.request.urlopen(req))["status"], "pending")
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(urllib.request.Request(base + "/match", data=body, method="POST"))
            self.assertEqual(e.exception.code, 401)
            health = json.load(urllib.request.urlopen(urllib.request.Request(base + "/health", headers=signed("GET", "/health"))))
            self.assertEqual(health["streams"], 2)
        finally:
            server.shutdown()

    def test_twitch_durations(self):
        self.assertEqual(_duration_s("1h2m3s"), 3723)
        self.assertEqual(_duration_s("45m"), 2700)


if __name__ == "__main__":
    unittest.main()
