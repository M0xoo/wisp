"""wisp's Python SDK (ADR-0028): commands over ``POST /api/cmd`` (with an idempotency key) and topics over the
sync stream (``GET /api/events``), as the app uses them. Standard library only.

    import wisp
    w = wisp.connect()
    t = w.run(prompt="fix the flaky auth test", cwd=".")
    done = w.wait(t["id"])
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional

__all__ = ["DEFAULT_PORT", "PROTO", "WispClient", "WispError", "connect", "discover", "SseParser", "decode_frame"]

DEFAULT_PORT = 4477
#: the sync protocol this SDK speaks (wisp-protocol PROTO_MIN..PROTO)
PROTO = 2


def wisp_home() -> str:
    return os.environ.get("WISP_HOME") or os.path.join(os.path.expanduser("~"), ".wisp")


def discover(home: Optional[str] = None) -> Optional[int]:
    """The port the running wisp advertises in ``<home>/server.json``, or None."""
    try:
        with open(os.path.join(home or wisp_home(), "server.json"), encoding="utf-8") as f:
            port = json.load(f).get("port")
        return port if isinstance(port, int) else None
    except (OSError, ValueError):
        return None


class WispError(Exception):
    """A refusal in wisp's own words: ``code`` (``invalid``, ``forbidden``, ``not_found``, ``conflict``, …), and
    whether a retry may help."""

    def __init__(self, message: str, code: str = "internal", status: int = 0, retry: bool = False, body: Any = None):
        super().__init__(message)
        self.code, self.status, self.retry, self.body = code, status, retry, body


class SseParser:
    """SSE, chunk by chunk (a frame may split anywhere): ``push(text)`` → ``[{event, id, data}]``."""

    def __init__(self) -> None:
        self._buf = ""
        self._event, self._id, self._data = "", None, []  # type: str, Optional[str], List[str]

    def push(self, text: str) -> List[Dict[str, Any]]:
        self._buf += text
        out = []
        while True:
            i = self._buf.find("\n")
            if i < 0:
                return out
            line = self._buf[:i].rstrip("\r")
            self._buf = self._buf[i + 1 :]
            if line == "":
                if self._data:
                    out.append({"event": self._event or "message", "id": self._id, "data": "\n".join(self._data)})
                self._event, self._data = "", []
            elif not line.startswith(":"):
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "data":
                    self._data.append(value)
                elif field == "event":
                    self._event = value
                elif field == "id":
                    self._id = value


def decode_frame(ev: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
    """A sync frame's server messages (``welcome``, ``snapshot``, ``patch``, …), or None for anything else."""
    if ev.get("event") != "sync":
        return None
    try:
        messages = json.loads(ev["data"])
    except ValueError:
        return None
    return messages if isinstance(messages, list) else None


class _Calls:
    """``client.call.runtime.followUp(id=..., text=...)``: any command, by its id."""

    def __init__(self, client: "WispClient", prefix: str = "") -> None:
        self._client, self._prefix = client, prefix

    def __getattr__(self, name: str) -> "_Calls":
        if name.startswith("_"):
            raise AttributeError(name)
        return _Calls(self._client, f"{self._prefix}.{name}" if self._prefix else name)

    def __call__(self, **args: Any) -> Any:
        return self._client.cmd(self._prefix, **args)


class WispClient:
    def __init__(self, url: str = f"http://127.0.0.1:{DEFAULT_PORT}", token: Optional[str] = None) -> None:
        self.url = url.rstrip("/")
        self.token = token if token is not None else os.environ.get("WISP_TOKEN", "")
        self.client_id = "sdk-" + secrets.token_hex(8)
        self.call = _Calls(self)

    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h = {"x-wisp-token": self.token} if self.token else {}
        h.update(extra or {})
        return h

    def alive(self) -> bool:
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{self.url}/api/health", headers=self._headers()), timeout=2) as r:
                return 200 <= r.status < 300
        except (OSError, urllib.error.URLError):
            return False

    def cmd(self, command: str, args: Optional[Dict[str, Any]] = None, /, *, key: Optional[str] = None, timeout: float = 300, **kw: Any) -> Any:
        """One command: its result, or a WispError in wisp's words. Its args as a dict, or as keywords
        (``cmd("runtime.get", id="t1")``). The same ``key`` makes a retry one command."""
        body = json.dumps({"cmd": command, "args": {**(args or {}), **kw}}).encode()
        req = urllib.request.Request(f"{self.url}/api/cmd", data=body, method="POST", headers=self._headers({"content-type": "application/json", "idempotency-key": key or "sdk-" + secrets.token_hex(12)}))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except (OSError, urllib.error.URLError) as e:
            raise WispError(f"wisp at {self.url}: {e}", code="unavailable", retry=True) from e
        try:
            v = json.loads(raw or b"null")
        except ValueError:
            v = None
        if isinstance(v, dict) and v.get("ok") is True:
            return v.get("result")
        err = v.get("error") if isinstance(v, dict) and isinstance(v.get("error"), dict) else {}
        raise WispError(err.get("message") or f"{command}: HTTP {status}", code=err.get("code", "internal"), status=status, retry=bool(err.get("retry")), body=v)

    def catalogue(self) -> List[Dict[str, Any]]:
        """Every command this caller may run, with its title and its args' type."""
        return self.cmd("cli.catalogue")

    # ---- tasks (runtime.*), the calls scripts use most ----

    def run(self, prompt: str, cwd: Optional[str] = None, **spec: Any) -> Dict[str, Any]:
        """Start a task (runtime.create): ``agent``, ``model``, ``effort``, ``mode``, ``worktree``, ``confirmLimit``, …"""
        return self.cmd("runtime.create", {"prompt": prompt, "cwd": os.path.abspath(cwd or os.getcwd()), **spec})

    def get(self, id: str) -> Dict[str, Any]:
        return self.cmd("runtime.get", id=id)

    def list(self, **args: Any) -> List[Dict[str, Any]]:
        return self.cmd("runtime.list", args)

    def turns(self, id: str, **args: Any) -> List[Dict[str, Any]]:
        return self.cmd("runtime.turns", {"id": id, **args})

    def presentation(self, id: str, turn: Optional[int] = None) -> Optional[Dict[str, Any]]:
        return self.cmd("runtime.presentation", {"id": id, **({"turn": turn} if turn is not None else {})})

    def follow_up(self, id: str, text: str, **opts: Any) -> Any:
        return self.cmd("runtime.followUp", {"id": id, "text": text, "attachments": [], **opts})

    def stop(self, id: str) -> Any:
        return self.cmd("runtime.stop", id=id)

    def apply(self, resources: List[Dict[str, Any]], dry_run: bool = False) -> Any:
        """Declare resources, as ``wisp apply`` does: the plan, applied unless ``dry_run``."""
        return self.cmd("resources.plan" if dry_run else "resources.apply", resources=resources)

    def events(self, topics: Iterable[str], timeout: Optional[float] = None) -> Iterator[Dict[str, Any]]:
        """The sync stream's server messages for ``topics`` (``list``, ``session:<id>``, …), read only."""
        q = urllib.parse.urlencode({"proto_min": PROTO, "proto_max": PROTO, "client_id": self.client_id, "build": "wisp-python-sdk", "fresh": ",".join(topics)})
        req = urllib.request.Request(f"{self.url}/api/events?{q}", headers=self._headers({"accept": "text/event-stream"}))
        try:
            r = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            raise WispError(f"the sync stream said {e.code}", code="unavailable", status=e.code, retry=True) from e
        except (OSError, urllib.error.URLError) as e:
            raise WispError(f"wisp at {self.url}: {e}", code="unavailable", retry=True) from e
        parser = SseParser()
        with r:
            while True:
                try:
                    chunk = r.read1(65536) if hasattr(r, "read1") else r.read(1)
                except (socket.timeout, TimeoutError) as e:
                    raise WispError("the sync stream went quiet", code="timeout") from e
                if not chunk:
                    return
                for ev in parser.push(chunk.decode("utf-8", "replace")):
                    for m in decode_frame(ev) or []:
                        yield m

    def wait(self, id: str, until: Optional[Callable[[Dict[str, Any]], bool]] = None, timeout: float = 1800) -> Dict[str, Any]:
        """Until the task stops working (``until(task)``; by default its state isn't ``running``), or ``timeout``
        seconds. Live: each change on its topic is a look, never a timer."""
        done = until or (lambda s: s.get("state") != "running")
        s = self.get(id)
        if done(s):
            return s
        end = time.monotonic() + timeout
        stream = self.events([f"session:{id}"], timeout=timeout)
        try:
            for m in stream:
                if m.get("t") in ("snapshot", "patch"):
                    s = self.get(id)
                    if done(s):
                        return s
                if time.monotonic() > end:
                    break
        finally:
            stream.close()
        raise WispError(f"{id} still works after {int(timeout)} s", code="timeout")

    def generate_stubs(self) -> str:
        """Typed stubs (``.pyi``) for the commands this wisp lists: ``cmd``'s ids as ``Literal`` overloads."""
        lines = ["# Generated by wisp.WispClient.generate_stubs() from a running wisp's catalogue. Do not edit.", "from typing import Any, Literal, overload", "", "class WispClient:"]
        for c in sorted(self.catalogue(), key=lambda c: c["id"]):
            if c.get("uiOnly"):
                continue
            title = (c.get("title") or "").replace('"""', "'''")
            lines.append("    @overload")
            lines.append(f"    def cmd(self, command: Literal[{json.dumps(c['id'])}], args: dict[str, Any] | None = ..., /, **kw: Any) -> Any: ...")
            if title:
                lines.append(f'    # {title}')
        lines.append("    def cmd(self, command: str, args: dict[str, Any] | None = ..., /, **kw: Any) -> Any: ...")
        return "\n".join(lines) + "\n"


def connect(url: Optional[str] = None, port: Optional[int] = None, home: Optional[str] = None, token: Optional[str] = None) -> WispClient:
    """The running wisp (``server.json``), or a WispError saying how to start one."""
    found = url or f"http://127.0.0.1:{port or discover(home) or DEFAULT_PORT}"
    c = WispClient(found, token)
    if not c.alive():
        raise WispError(f"No wisp answers at {found}. Start one with: wisp serve", code="unavailable", retry=True)
    return c
