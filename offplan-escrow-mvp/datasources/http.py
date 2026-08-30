"""
Cached HTTP for public data sources.

Every fetch goes through here so three things are guaranteed:

  - Responses are cached to disk. Public endpoints are free but rate limited,
    and a demo that hammers Overpass will get the project blocked.
  - Offline mode replays the cache and never touches the network. Tests run
    this way, so CI stays green on a plane.
  - Every request carries a contact User-Agent. Nominatim's usage policy
    requires it and will reject you without one. Set DATA_CONTACT before
    running live.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

CACHE_DIR = Path(os.getenv("DATA_CACHE", Path(__file__).resolve().parent.parent / "fixtures" / "cache"))
CONTACT = os.getenv("DATA_CONTACT", "escrow-mvp (set DATA_CONTACT to your email)")
OFFLINE = os.getenv("DATA_OFFLINE", "1") == "1"

# Per-host minimum seconds between requests. Nominatim's policy is one call
# per second absolute; the others are courtesy limits.
RATE_LIMITS = {
    "nominatim.openstreetmap.org": 1.1,
    "overpass-api.de": 2.0,
    "storage.googleapis.com": 0.2,
}
_last_call: dict[str, float] = {}


class OfflineMiss(RuntimeError):
    """Requested in offline mode with nothing cached for it."""


@dataclass
class Response:
    url: str
    body: bytes
    from_cache: bool

    def json(self):
        return json.loads(self.body.decode("utf-8"))

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


def _cache_key(url: str, payload: bytes | None) -> Path:
    h = hashlib.sha256(url.encode() + (payload or b"")).hexdigest()[:24]
    host = urllib.parse.urlparse(url).netloc.replace(":", "_") or "local"
    return CACHE_DIR / host / f"{h}.bin"


def _throttle(url: str) -> None:
    host = urllib.parse.urlparse(url).netloc
    gap = RATE_LIMITS.get(host)
    if not gap:
        return
    elapsed = time.time() - _last_call.get(host, 0.0)
    if elapsed < gap:
        time.sleep(gap - elapsed)
    _last_call[host] = time.time()


def fetch(url: str, payload: bytes | None = None, timeout: int = 45) -> Response:
    """GET, or POST when payload is given. Cached by URL plus body."""
    path = _cache_key(url, payload)
    if path.exists():
        return Response(url, path.read_bytes(), from_cache=True)

    if OFFLINE:
        raise OfflineMiss(
            f"No cached response for {url}\n"
            f"Run with DATA_OFFLINE=0 to fetch it, then commit {path.name} "
            f"so this stays reproducible."
        )

    _throttle(url)
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "User-Agent": CONTACT,
            "Accept": "application/json, text/plain, */*",
            **({"Content-Type": "application/x-www-form-urlencoded"} if payload else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return Response(url, body, from_cache=False)


def cache_stats() -> dict:
    files = list(CACHE_DIR.rglob("*.bin"))
    return {
        "entries": len(files),
        "bytes": sum(f.stat().st_size for f in files),
        "offline": OFFLINE,
        "path": str(CACHE_DIR),
    }
