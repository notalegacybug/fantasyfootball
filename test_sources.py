"""
In-season data layer tests. No network: fetchers are fakes, ESPN data is a recorded fixture.

    python test_sources.py
"""

import json
import os
import pathlib
import sqlite3
import tempfile

import httpx

import sources

HERE = pathlib.Path(__file__).parent
FIXTURES = HERE / "fixtures"


def check(label, cond):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    return cond


def temp_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return path


class FakeFetch:
    """Stands in for an ESPN call. Counts calls; can be told to fail like wifi-off."""
    def __init__(self, body):
        self.body, self.calls, self.fail = body, 0, False

    def __call__(self):
        self.calls += 1
        if self.fail:
            raise httpx.ConnectError("offline")
        return self.body


def test_cache():
    ok = True
    print("\n[1] Cache: TTL, force, offline fallback")
    db, f = temp_db(), FakeFetch({"v": 1})
    t0 = 1_000_000.0

    body, info = sources.cached_fetch(db, "k", f, ttl_minutes=30, now=t0)
    ok &= check("miss fetches from network", f.calls == 1 and info["source"] == "network")
    ok &= check("body round-trips", body == {"v": 1})

    body, info = sources.cached_fetch(db, "k", f, ttl_minutes=30, now=t0 + 29 * 60)
    ok &= check("within TTL serves cache", f.calls == 1 and info["source"] == "cache")

    f.body = {"v": 2}
    body, info = sources.cached_fetch(db, "k", f, ttl_minutes=30, now=t0 + 31 * 60)
    ok &= check("past TTL refetches", f.calls == 2 and body == {"v": 2})

    body, info = sources.cached_fetch(db, "k", f, ttl_minutes=30, force=True, now=t0 + 32 * 60)
    ok &= check("force refetches inside TTL", f.calls == 3 and info["source"] == "network")

    f.fail = True
    body, info = sources.cached_fetch(db, "k", f, ttl_minutes=30, now=t0 + 999 * 60)
    ok &= check("offline + stale cache serves stale", info["source"] == "stale" and body == {"v": 2})
    ok &= check("stale result carries the error", "offline" in info.get("error", ""))

    try:
        sources.cached_fetch(db, "never-cached", f)
        ok &= check("offline + no cache raises", False)
    except httpx.ConnectError:
        ok &= check("offline + no cache raises", True)

    print("\n[2] Cache survives a draft prefetch rebuilding the players table")
    con = sqlite3.connect(db)
    con.execute("DROP TABLE IF EXISTS players")   # exactly what build_snapshot does
    con.executescript(sources.SCHEMA)
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM espn_cache").fetchone()[0]
    con.close()
    ok &= check("espn_cache rows intact", n == 1)
    os.remove(db)
    return ok


def main():
    ok = True
    ok &= test_cache()
    print("\n" + ("ALL CHECKS PASSED" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
