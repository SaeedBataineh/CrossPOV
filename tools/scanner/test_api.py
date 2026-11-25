import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from api import Matcher, check_signature, judge, make_handler, signature, _duration_s
from verify import Verdict
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

        def fake_verify(login, user_id, start, rounds, teams, team, events=()):
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

    def test_judging_a_linked_channel(self):
        def runner(results):
            return lambda side: results[side]
        ok = Verdict(True, 30, 4, 4)
        miss = Verdict(False, 0, 4, 0, "scores don't match")
        hidden = Verdict(False, None, 1, 0)
        some = Verdict(False, 15, 4, 3, "only some scores matched")
        self.assertEqual(judge(runner({"Blue": ok, "Red": miss}), TEAMS, "Blue")["verdict"], "match")
        self.assertEqual(judge(runner({"Blue": ok, "Red": miss}), TEAMS, "Blue")["delaySec"], 30)
        self.assertEqual(judge(runner({"Blue": miss, "Red": ok}), TEAMS, "Blue")["verdict"], "otherTeam", "picked a player on the wrong side")
        self.assertEqual(judge(runner({"Blue": miss, "Red": miss}), TEAMS, "Blue")["verdict"], "different", "another game")
        self.assertEqual(judge(runner({"Blue": hidden, "Red": miss}), TEAMS, "Blue")["verdict"], "unknown", "HUD hidden: can't tell")
        self.assertEqual(judge(runner({"Blue": some, "Red": miss}), TEAMS, "Blue")["verdict"], "unknown", "mostly agrees: don't call it different")

    def test_verify_request_runs_in_the_background(self):
        calls = []

        def examine(login, start, rounds, teams, team, events=(), mode="check"):
            calls.append((login, team) if mode == "check" else (login, team, mode, list(events)))
            return {"verdict": "different", "checked": 4, "agreed": 0}

        m = Matcher(self.store, lambda *a: None, examine)
        body = {**MATCH, "login": "WTFslump", "team": "Blue"}
        self.assertEqual(m.verify_request(body), {"status": "pending"})
        for _ in range(100):
            res = m.verify_request(body)
            if res["status"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual(res["verdict"], "different")
        self.assertEqual(calls, [("wtfslump", "Blue")], "one check per match, channel and side")
        with self.assertRaises(ValueError):
            m.verify_request({**MATCH, "login": "x", "team": "Blue"})
        with self.assertRaises(ValueError):
            m.verify_request({**MATCH, "login": "someone", "team": "Green"})
        self.assertEqual(Matcher(self.store, lambda *a: None).verify_request(body)["verdict"], "unknown", "no VOD reader: never a wrong no")
        # Found by name: only the shift is measured, with the rounds that ended by elimination.
        shift = {**body, "mode": "shift", "events": [{"decidedMs": 130620, "round": 0}]}
        for _ in range(100):
            if m.verify_request(shift)["status"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual(calls[-1], ("wtfslump", "Blue", "shift", [(130620, 0)]))

    def test_streamer_accounts_over_http(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(KEY, self.matcher, self.store))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"

        def post(path, payload, sign=True):
            body = json.dumps(payload).encode()
            req = urllib.request.Request(base + path, data=body, headers=signed("POST", path, body) if sign else {}, method="POST")
            return json.load(urllib.request.urlopen(req))

        try:
            self.assertEqual(post("/links/save", {"links": [{"puuid": "p-main", "login": "NaturE", "kind": "main", "source": "name"},
                                                             {"puuid": "p-smurf", "login": "nature", "kind": "smurf", "source": "submitted"}]})["saved"], 2)
            found = post("/links/lookup", {"puuids": ["p-main", "p-smurf", "someone-else"]})["links"]
            self.assertEqual(sorted((l["puuid"], l["login"], l["kind"]) for l in found), [("p-main", "nature", "main"), ("p-smurf", "nature", "smurf")])
            with self.assertRaises(urllib.error.HTTPError) as e:
                post("/links/lookup", {"puuids": ["p-main"]}, sign=False)
            self.assertEqual(e.exception.code, 401, "only the CrossPOV server may ask")
            self.store.opt_out("nature")
            self.assertEqual(post("/links/lookup", {"puuids": ["p-main", "p-smurf"]})["links"], [], "a removed streamer is gone")
        finally:
            server.shutdown()

    def test_twitch_durations(self):
        self.assertEqual(_duration_s("1h2m3s"), 3723)
        self.assertEqual(_duration_s("45m"), 2700)


if __name__ == "__main__":
    unittest.main()
