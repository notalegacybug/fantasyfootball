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
        # Shaped like the real 2026 payload. statSplitTypeId: 1 = one week,
        # 0 = rest of season, 2 = full season (incl. weeks already played).
        "stats": [
            # distractors first, so a first-match bug picks the wrong one
            {"seasonId": season, "scoringPeriodId": week, "statSourceId": 0,
             "statSplitTypeId": 1, "appliedTotal": 99.0},
            {"seasonId": season - 1, "scoringPeriodId": week, "statSourceId": 1,
             "statSplitTypeId": 1, "appliedTotal": 88.0},
            {"seasonId": season, "scoringPeriodId": week - 1, "statSourceId": 1,
             "statSplitTypeId": 1, "appliedTotal": 77.0},
            {"seasonId": season, "scoringPeriodId": week, "statSourceId": 1,
             "statSplitTypeId": 1, "appliedTotal": 12.3},
            {"seasonId": season, "scoringPeriodId": 0, "statSourceId": 1,
             "statSplitTypeId": 2, "appliedTotal": 215.0},
            {"seasonId": season, "scoringPeriodId": 0, "statSourceId": 1,
             "statSplitTypeId": 0, "appliedTotal": 180.4},
        ],
    }


def test_parsers():
    ok = True
    print("\n[3] Stat selection picks the exact (season, period, source) triple")
    p = sources.parse_player(synthetic_player(), season=2026, week=3)
    ok &= check("weekly projection is (1, week N)", p["proj_week"] == 12.3)
    ok &= check("rest-of-season is split 0, not full-season split 2", p["proj_ros"] == 180.4)
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


def load_fixture(name):
    path = FIXTURES / name
    if not path.exists():
        raise SystemExit(f"Missing {path}. Run `python app.py capture-fixture` (live ESPN read).")
    return json.loads(path.read_text())


def test_fixture():
    """THE important test (spec 7.2): catches ESPN renumbering slots or moving stats."""
    ok = True
    raw = load_fixture("espn_league.json")
    lg = sources.parse_league(raw)                 # raises on any unknown slot id
    week = lg["week"]

    print(f"\n[6] Recorded league, week {week}")
    ok &= check("all 10 teams parse", len(lg["teams"]) == 10)
    ok &= check("league slot counts match spec (QB1 RB2 WR2 TE1 FLEX2 DST1 K1)",
                {k: lg["slots"].get(k) for k in ("QB", "RB", "WR", "TE", "FLEX", "DST", "K")}
                == {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 2, "DST": 1, "K": 1})
    rows = [r for t in lg["teams"] for r in t["roster"]]
    ok &= check("every rostered player has a position", all(r["pos"] for r in rows))
    ok &= check("no team starts more than 10",
                all(sum(r["slot"] not in ("BENCH", "IR") for r in t["roster"]) <= 10
                    for t in lg["teams"]))
    ok &= check("every player is eligible for the slot they sit in",
                all(r["slot"] in r["eligible"] for r in rows))

    with_week = [r for r in rows if r["proj_week"] is not None]
    ok &= check("weekly projections found for >=80% of rostered players",
                len(with_week) >= 0.8 * len(rows))
    both = [r for r in rows if r["proj_week"] and r["proj_ros"]]
    ok &= check("rest-of-season dwarfs weekly (pair not swapped)",
                sum(r["proj_ros"] > 3 * r["proj_week"] for r in both) >= 0.9 * len(both))

    # Real-data guard for the split bug: rest-of-season must be the SMALLER of the two
    # period-0 projections once games have been played.
    season = lg["season"]
    players = [e["playerPoolEntry"]["player"] for t in raw["teams"]
               for e in t["roster"]["entries"]]
    pairs = [(sources.pick_stat(p["stats"], season, 0, 1, sources.SPLIT_REST_OF_SEASON),
              sources.pick_stat(p["stats"], season, 0, 1, sources.SPLIT_FULL_SEASON))
             for p in players]
    pairs = [(ros, full) for ros, full in pairs if ros and full]
    ok &= check("rest-of-season < full-season for most players",
                sum(ros < full for ros, full in pairs) >= 0.75 * len(pairs))
    ok &= check("exactly one team is mine (owner matches scrubbed SWID)",
                sum("{00000000-0000-0000-0000-000000000001}" in t["owners"]
                    for t in lg["teams"]) == 1)

    print("\n[7] Recorded free agents")
    fa = sources.parse_free_agents(load_fixture("espn_free_agents.json"), season, week)
    rostered = {r["player_id"] for r in rows}
    ok &= check("free agents returned", len(fa) > 50)
    ok &= check("no free agent is on a roster", not any(p["player_id"] in rostered for p in fa))
    ok &= check("free agents carry weekly projections",
                sum(p["proj_week"] is not None for p in fa) >= 0.5 * len(fa))

    print("\n[8] Recorded NFL schedule")
    pro = sources.parse_pro_schedule(load_fixture("espn_pro_schedule.json"))
    ok &= check("32 NFL teams", len(pro) == 32)
    ok &= check("every team has a bye week", all(t["bye"] for t in pro.values()))
    playing = [t for t in pro.values() if t["bye"] != week]
    ok &= check("every non-bye team has a week-N game",
                all(week in t["games"] for t in playing))
    ok &= check("opponents are symmetric",
                all(pro[t["games"][week]["opp"]]["games"][week]["opp"] == tid
                    for tid, t in pro.items() if week in t["games"]))
    return ok


def test_load_season_raw():
    ok = True
    print("\n[9] load_season_raw: one refresh, then cache")
    league = load_fixture("espn_league.json")
    fakes = {
        "fetch_espn_league": FakeFetch(league),
        "fetch_espn_free_agents": FakeFetch(load_fixture("espn_free_agents.json")),
        "fetch_espn_pro_schedule": FakeFetch(load_fixture("espn_pro_schedule.json")),
    }
    real = {n: getattr(sources, n) for n in fakes}
    for n, f in fakes.items():
        setattr(sources, n, lambda *a, _f=f, **k: _f())    # ignore args, count calls
    db = temp_db()
    try:
        out = sources.load_season_raw(db, "123", 2026)
        ok &= check("first load hits every source once",
                    all(f.calls == 1 for f in fakes.values()))
        ok &= check("returns the league payload", out["league"]["seasonId"] == league["seasonId"])
        sources.load_season_raw(db, "123", 2026)
        ok &= check("second load is all cache", all(f.calls == 1 for f in fakes.values()))
        out = sources.load_season_raw(db, "123", 2026, force=True)
        ok &= check("force refetches everything", all(f.calls == 2 for f in fakes.values()))
        ok &= check("info reports network on force",
                    all(i["source"] == "network" for i in out["info"].values()))
    finally:
        for n, fn in real.items():
            setattr(sources, n, fn)
        os.remove(db)
    return ok


def main():
    ok = True
    ok &= test_cache()
    ok &= test_parsers()
    ok &= test_fixture()
    ok &= test_load_season_raw()
    print("\n" + ("ALL CHECKS PASSED" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
