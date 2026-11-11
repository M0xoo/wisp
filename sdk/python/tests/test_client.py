"""The Python SDK against a tiny local server: commands over /api/cmd, the sync stream for wait(), stubs from the
catalogue. No network beyond 127.0.0.1, no real wisp."""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import wisp  # noqa: E402

SEEN = []
STATE = {"state": "running", "stream": None}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, status, value):
        b = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        SEEN.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}})
        if self.path == "/api/health":
            return self._json(200, {"ok": True})
        if self.path.startswith("/api/events?"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'event: sync\nid: 1\ndata: [{"t":"welcome"},')
            self.wfile.flush()
            self.wfile.write(b'{"t":"snapshot","topic":"session:t1","seq":1,"rows":[]}]\n\n')
            self.wfile.flush()
            time.sleep(0.1)
            STATE["state"] = "review"
            self.wfile.write(b'event: sync\nid: 2\ndata: [{"t":"patch","seq":2,"ops":[]}]\n\n')
            self.wfile.flush()
            time.sleep(0.3)
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"null")
        SEEN.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
        cmd, args = body["cmd"], body["args"]
        if cmd == "runtime.get":
            return self._json(200, {"ok": True, "result": {"id": args["id"], "state": STATE["state"]}})
        if cmd == "runtime.create":
            return self._json(200, {"ok": True, "result": {"id": "t1", "echo": args}})
        if cmd == "cli.catalogue":
            return self._json(200, {"ok": True, "result": [{"id": "runtime.stop", "title": "Stop a task", "readOnly": False}, {"id": "x.ui", "uiOnly": "a page"}]})
        return self._json(409, {"ok": False, "error": {"code": "conflict", "message": "It is busy.", "retry": True}})


class SdkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_a_command_goes_to_api_cmd_with_a_key_and_a_refusal_comes_back_in_wisps_words(self):
        w = wisp.WispClient(self.url, token="tok")
        t = w.run("fix it", cwd="/w")
        self.assertEqual(t["id"], "t1")
        sent = SEEN[-1]
        self.assertEqual(sent["body"], {"cmd": "runtime.create", "args": {"prompt": "fix it", "cwd": "/w"}})
        self.assertRegex(sent["headers"]["idempotency-key"], r"^sdk-[0-9a-f]{24}$")
        self.assertEqual(sent["headers"]["x-wisp-token"], "tok")
        with self.assertRaises(wisp.WispError) as e:
            w.call.runtime.nope(id="t1")
        self.assertEqual((e.exception.code, e.exception.status, e.exception.retry, str(e.exception)), ("conflict", 409, True, "It is busy."))
        self.assertEqual(SEEN[-1]["body"]["cmd"], "runtime.nope", "any command, by its id")
        try:
            w.cmd("runtime.nope", key="k1")
        except wisp.WispError:
            pass
        self.assertEqual(SEEN[-1]["headers"]["idempotency-key"], "k1", "the same key makes a retry one command")

    def test_wait_looks_again_on_each_change_of_its_topic_never_on_a_timer(self):
        STATE["state"] = "running"
        w = wisp.WispClient(self.url)
        before = len([s for s in SEEN if s.get("body", {}) and s["body"].get("cmd") == "runtime.get"])
        s = w.wait("t1", timeout=5)
        self.assertEqual(s["state"], "review")
        ev = [x for x in SEEN if x["path"].startswith("/api/events?")][-1]
        self.assertIn("fresh=session%3At1", ev["path"])
        self.assertIn("proto_min=2", ev["path"])
        gets = len([x for x in SEEN if x.get("body", {}) and x["body"].get("cmd") == "runtime.get"]) - before
        self.assertEqual(gets, 3, "one look first, one per frame")

    def test_stubs_come_from_the_catalogue_and_sse_parses_across_chunks(self):
        stubs = wisp.WispClient(self.url).generate_stubs()
        self.assertIn('def cmd(self, command: Literal["runtime.stop"]', stubs)
        self.assertNotIn("x.ui", stubs)
        p = wisp.SseParser()
        self.assertEqual(p.push('event: sync\r\ndata: [{"t":"we'), [])
        (ev,) = p.push('lcome"}]\r\n\r\n: ping\n\n')
        self.assertEqual(wisp.decode_frame(ev), [{"t": "welcome"}])
        self.assertIsNone(wisp.decode_frame({"event": "notice", "data": "[]"}))
        home = tempfile.mkdtemp()
        self.assertIsNone(wisp.discover(home))
        with open(os.path.join(home, "server.json"), "w") as f:
            json.dump({"port": 4500}, f)
        self.assertEqual(wisp.discover(home), 4500)
        with self.assertRaises(wisp.WispError):
            wisp.connect(url="http://127.0.0.1:9")


if __name__ == "__main__":
    unittest.main()
