"""Talks to the AquaCast edge API (/api/edge/v1/...) with the edge key. Standard library only."""
from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from . import VERSION


class Offline(Exception):
    """No internet / server unreachable / server error: keep the data and try again later."""


class Refused(Exception):
    """The server answered with a clear 'no' (wrong key, simulator still on, bad request)."""

    def __init__(self, status, code, message):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


class EdgeApi:
    def __init__(self, cfg, timeout=25):
        self.base = cfg.server_url + "/api/edge/v1"
        self.key = cfg.edge_key
        self.timeout = timeout
        self.last_ok = 0.0  # time.time() of the last successful call (internet_reachable)

    def _call(self, method, path, body=None, query=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"aquacast-edge/{VERSION}",
            "X-AquaCast-Edge-Version": VERSION,
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                payload = json.loads(res.read().decode() or "{}")
                self.last_ok = time.time()
                return payload.get("data", payload)
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode()).get("error", {})
            except Exception:  # noqa: BLE001 - HTML error page etc.
                err = {}
            self.last_ok = time.time()  # the server answered, so the internet works
            if e.code >= 500 and err.get("code") not in ("EDGE_NOT_CONFIGURED", "EDGE_KEY_TOO_SHORT"):
                raise Offline(f"server error {e.code} {err.get('code', '')}") from None
            if e.code == 429:
                raise Offline("rate limited") from None
            raise Refused(e.code, err.get("code", "HTTP_ERROR"), err.get("message", str(e))) from None
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
            raise Offline(str(getattr(e, "reason", e))) from None

    def hello(self, host=""):
        return self._call("GET", "/hello", query={"host": host, "pi_time_ms": int(time.time() * 1000)})

    def register_models(self, models):
        return self._call("POST", "/models", {"models": models})

    def upload_cycles(self, cycles, backlog):
        return self._call("POST", "/cycles", {"cycles": cycles, "outbox_backlog": backlog})

    def control(self, body):
        return self._call("POST", "/control", body)

    def internet_reachable(self, within_s=300) -> bool:
        return time.time() - self.last_ok < within_s
