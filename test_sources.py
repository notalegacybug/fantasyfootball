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


def synthetic_player(pid=1, pos_id=2, slots=(2, 3, 23, 20, 21), week=3, season=2026):
    return {
        "id": pid, "fullName": f"Player {pid}", "defaultPositionId": pos_id,
        "proTeamId": 12, "eligibleSlots": list(slots), "injuryStatus": "ACTIVE",
        "ownership": {"percentStarted": 55.5, "percentChange": 1.2},
        "seasonOutlook": "note",
        "stats": [
            # distractors first, so a first-match bug picks the wrong one
            {"seasonId": season, "scoringPeriodId": week, "statSourceId": 0, "appliedTotal": 99.0},
            {"seasonId": season - 1, "scoringPeriodId": week, "statSourceId": 1, "appliedTotal": 88.0},
            {"seasonId": season, "scoringPeriodId": week - 1, "statSourceId": 1, "appliedTotal": 77.0},
            {"seasonId": season, "scoringPeriodId": week, "statSourceId": 1, "appliedTotal": 12.3},
            {"seasonId": season, "scoringPeriodId": 0, "statSourceId": 1, "appliedTotal": 180.4},
        ],
    }


def test_parsers():
    ok = True
    print("\n[3] Stat selection picks the exact (season, period, source) triple")
    p = sources.parse_player(synthetic_player(), season=2026, week=3)
    ok &= check("weekly projection is (1, week N)", p["proj_week"] == 12.3)
    ok &= check("season projection is (1, period 0)", p["proj_ros"] == 180.4)
    ok &= check("missing stat is None, not 0", sources.pick_stat([], 2026, 3, 1) is None)

    print("\n[4] Slot mapping")
    ok &= check("position from defaultPositionId", p["pos"] == "RB")
    ok &= check("eligible keeps known slots, drops composite id 3",
                p["eligible"] == ["BENCH", "FLEX", "IR", "RB"])
    ok &= check("known lineupSlotId maps", sources.slot_name(23) == "FLEX")
    try:
        sources.slot_name(99)
        ok &= check("unknown lineupSlotId fails loudly", False)
    except ValueError as e:
        ok &= check("unknown lineupSlotId fails loudly", "99" in str(e))

    print("\n[5] League parse on a minimal synthetic payload")
    raw = {
        "seasonId": 2026, "scoringPeriodId": 3, "status": {"currentMatchupPeriod": 3},
        "settings": {"rosterSettings": {"lineupSlotCounts": {"2": 2, "23": 2, "20": 7, "3": 0}}},
        "teams": [{"id": 3, "name": "Mine", "abbrev": "ME", "owners": ["{A}"],
                   "record": {"overall": {"wins": 2, "losses": 0, "ties": 0,
                                          "pointsFor": 250.5, "pointsAgainst": 200.0}},
                   "roster": {"entries": [{"lineupSlotId": 2,
                                           "playerPoolEntry": {"player": synthetic_player()}}]}}],
        "schedule": [{"matchupPeriodId": 3, "home": {"teamId": 3, "totalPoints": 0},
                      "away": {"teamId": 5, "totalPoints": 0}}],
    }
    lg = sources.parse_league(raw)
    ok &= check("week defaults to scoringPeriodId", lg["week"] == 3)
    ok &= check("slot counts mapped, zero-count unknowns ignored",
                lg["slots"] == {"RB": 2, "FLEX": 2, "BENCH": 7})
    ok &= check("roster row carries slot + projection",
                lg["teams"][0]["roster"][0]["slot"] == "RB"
                and lg["teams"][0]["roster"][0]["proj_week"] == 12.3)
    ok &= check("record parsed", lg["teams"][0]["wins"] == 2)
    ok &= check("schedule parsed", lg["schedule"][0]["away"] == 5)

    raw["settings"]["rosterSettings"]["lineupSlotCounts"]["98"] = 1
    try:
        sources.parse_league(raw)
        ok &= check("unknown slot with nonzero count fails loudly", False)
    except ValueError:
        ok &= check("unknown slot with nonzero count fails loudly", True)
    return ok


def main():
    ok = True
    ok &= test_cache()
    ok &= test_parsers()
    print("\n" + ("ALL CHECKS PASSED" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
