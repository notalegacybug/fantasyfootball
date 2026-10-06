"""
Season decision math on hand-built rosters with known answers, plus a smoke run on the
recorded ESPN fixture. No network.

    python test_season.py
"""

import json
import pathlib

import season
from league import Player, build_state

HERE = pathlib.Path(__file__).parent
SLOTS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 2, "DST": 1, "K": 1, "BENCH": 6, "IR": 2}
_ids = iter(range(1, 10_000))


def P(name, pos, proj, slot="BENCH", ros=None, injury="ACTIVE", locked=False, eligible=None):
    if eligible is None:
        eligible = [pos, "BENCH", "IR"] + (["FLEX"] if pos in ("RB", "WR", "TE") else [])
    return Player(player_id=next(_ids), name=name, pos=pos, pro_team_id=1,
                  eligible=sorted(eligible), proj_week=proj,
                  proj_ros=proj * 14 if ros is None else ros,
                  injury=injury, slot=slot, locked=locked, game={"opp": 2})


def check(label, cond):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    return cond


def names(lineup, slot=None):
    return sorted(p.name for s, p in lineup if slot is None or s == slot)


def base_roster():
    """Shaped like the spec's week-2 evidence: a 0.0 WR starting, better players benched."""
    return [
        P("QB1", "QB", 24.7, "QB"),
        P("RB1", "RB", 19.8, "RB"), P("RB2", "RB", 14.8, "RB"),
        P("WR1", "WR", 15.9, "WR"), P("Zero WR", "WR", 0.0, "WR"),
        P("TE1", "TE", 16.7, "TE"),
        P("Dowdle", "RB", 10.2, "FLEX"), P("Likely", "TE", 11.7, "FLEX"),
        P("Lions", "DST", 3.5, "DST"), P("K1", "K", 9.5, "K"),
        P("Washington", "WR", 12.3), P("Dobbins", "RB", 11.8),
        P("Rams", "DST", 5.9), P("WR bench", "WR", 7.0),
    ]


def test_lineup():
    ok = True
    print("\n[1] Optimal lineup, known answer")
    roster = base_roster()
    lu = season.best_lineup(roster, SLOTS)
    ok &= check("fills all 10 starting slots", len(lu) == 10)
    ok &= check("zero-projection starter is benched", "Zero WR" not in names(lu))
    ok &= check("WR slots are WR1 + Washington", names(lu, "WR") == ["WR1", "Washington"])
    ok &= check("FLEX is Dobbins + Likely", names(lu, "FLEX") == ["Dobbins", "Likely"])
    ok &= check("DST is Rams", names(lu, "DST") == ["Rams"])
    cur = season.current_total(roster)
    ok &= check(f"total gain {season.lineup_total(lu) - cur:.1f} = 12.3 + 1.6 + 2.4",
                abs(season.lineup_total(lu) - cur - 16.3) < 1e-6)

    print("\n[2] FLEX contention")
    roster = [P("QB", "QB", 20), P("RB1", "RB", 20), P("RB2", "RB", 18), P("RB3", "RB", 12),
              P("WR1", "WR", 20), P("WR2", "WR", 18), P("WR3", "WR", 11), P("WR4", "WR", 9),
              P("TE1", "TE", 10), P("TE2", "TE", 10.5), P("D", "DST", 5), P("K", "K", 8)]
    lu = season.best_lineup(roster, SLOTS)
    ok &= check("TE slot takes the better TE", names(lu, "TE") == ["TE2"])
    ok &= check("FLEX takes best remaining RB + WR over TE1", names(lu, "FLEX") == ["RB3", "WR3"])

    print("\n[3] Multi-position player (greedy trap)")
    # RB-then-WR greedy puts Hybrid at RB, leaves a WR slot empty and C unused: 74.
    # Optimal puts Hybrid at WR, B at RB, C in FLEX: 79.
    slots = {"RB": 2, "WR": 2, "FLEX": 1, "BENCH": 5}
    roster = [P("A", "RB", 20), P("B", "RB", 18), P("C", "RB", 5), P("W1", "WR", 17),
              P("Hybrid", "RB", 19, eligible=["RB", "WR", "FLEX", "BENCH"])]
    lu = season.best_lineup(roster, slots)
    ok &= check("finds the 79-point lineup", abs(season.lineup_total(lu) - 79) < 1e-6)
    ok &= check("Hybrid plays WR", names(lu, "WR") == ["Hybrid", "W1"])

    print("\n[4] Locked players stay put")
    roster = base_roster()
    zero = next(p for p in roster if p.name == "Zero WR")
    wash = next(p for p in roster if p.name == "Washington")
    zero.locked = True
    lu = season.best_lineup(roster, SLOTS)
    ok &= check("locked starter keeps his slot even at 0.0", "Zero WR" in names(lu, "WR"))
    wash.locked, zero.locked = True, False
    lu = season.best_lineup(roster, SLOTS)
    ok &= check("locked bench player can't be started", "Washington" not in names(lu))

    print("\n[5] Deltas and close calls")
    roster = base_roster()
    lu = season.best_lineup(roster, SLOTS)
    d = season.lineup_deltas(roster, lu)
    pairs = {(x["out"].name, x["in"].name) for x in d}
    ok &= check("3 swaps", len(d) == 3)
    ok &= check("Zero WR -> Washington", ("Zero WR", "Washington") in pairs)
    ok &= check("Lions -> Rams", ("Lions", "Rams") in pairs)
    ok &= check("Dowdle -> Dobbins", ("Dowdle", "Dobbins") in pairs)
    cc = season.close_calls(roster, lu)
    ok &= check("Likely 11.7 vs Dowdle 10.2 flagged close (1.5 < 2.5)",
                any(c["starter"].name == "Likely" and c["alt"].name == "Dowdle" for c in cc))
    ok &= check("QB not flagged (no bench QB)", not any(c["slot"] == "QB" for c in cc))
    return ok


def test_ir_and_waivers():
    ok = True
    print("\n[6] IR moves")
    roster = base_roster()
    roster += [P("Healthy in IR", "QB", 19.4, "IR"),
               P("Brown", "WR", 0.0, "IR", injury="INJURY_RESERVE"),
               P("Out guy", "RB", 0.0, injury="OUT")]
    moves = season.ir_moves(roster, SLOTS)
    got = {(m["player"].name, m["to"]) for m in moves}
    ok &= check("healthy player leaves IR", ("Healthy in IR", "BENCH") in got)
    ok &= check("OUT player takes the freed IR spot", ("Out guy", "IR") in got)
    ok &= check("Brown stays in IR", not any(m["player"].name == "Brown" for m in moves))
    probs = season.problems(roster, season.best_lineup(roster, SLOTS))
    ok &= check("healthy-in-IR flagged as a problem",
                any(p["player"].name == "Healthy in IR" for p in probs))

    print("\n[7] Waivers")
    roster = base_roster()                         # 14 players, limit 16: open spots
    fas = [P("Dud", "WR", 3.0), P("Stud RB", "RB", 18.0), P("Kicker", "K", 12.0)]
    w = season.waiver_targets(roster, fas, SLOTS)
    ok &= check("player who wouldn't start scores zero and is left out",
                not any(x["add"].name == "Dud" for x in w))
    ok &= check("best add ranks first", w[0]["add"].name == "Stud RB")
    ok &= check("open roster spot means no drop", w[0]["drop"] is None)

    # Full roster (16). Lowest weekly bench player is the bye star (0.0 this week);
    # lowest rest-of-season is Filler. The drop must be Filler.
    roster = [p for p in base_roster() if p.name != "Zero WR"] + [
        P("Filler", "TE", 2.0, ros=10.0), P("Depth", "RB", 4.0, ros=60.0),
        P("Bye star", "WR", 0.0, ros=200.0)]
    w = season.waiver_targets(roster, fas, SLOTS)
    ok &= check("full roster drops lowest rest-of-season bench player",
                w and w[0]["drop"].name == "Filler")
    ok &= check("never drops a star on bye", all(x["drop"].name != "Bye star" for x in w))
    return ok


def test_fixture_smoke():
    ok = True
    print("\n[8] Recorded week-3 league runs end to end")
    fx = HERE / "fixtures"
    raw = {n: json.loads((fx / f"espn_{f}.json").read_text()) for n, f in
           (("league", "league"), ("free_agents", "free_agents"), ("pro_schedule", "pro_schedule"))}
    st = build_state(raw, "{00000000-0000-0000-0000-000000000001}", now_ms=0)
    me = st.me.roster
    lu = season.best_lineup(me, st.slots)
    ok &= check("my team found", st.my_team_id is not None and len(me) >= 14)
    ok &= check("optimal >= currently set", season.lineup_total(lu) >= season.current_total(me) - 1e-6)
    ok &= check("every starting slot filled",
                len(lu) == sum(v for k, v in st.slots.items() if k not in ("BENCH", "IR")))
    rep = season.weekly_report(st)
    ok &= check("report has every section", all(k in rep for k in (
        "problems", "ir_moves", "deltas", "close_calls", "pickups", "starters")))
    return ok


def test_wont_play():
    """Week 5 bug: the app said 'start Rico Dowdle' -- marked OUT, but ESPN still projected 8.0."""
    ok = True
    print("\n[7] Players who won't play count as 0")
    roster = base_roster() + [P("Out RB", "RB", 30.0, injury="OUT"),
                              P("Doubtful RB", "RB", 29.0, injury="DOUBTFUL"),
                              P("Questionable RB", "RB", 28.0, injury="QUESTIONABLE")]
    lu = season.best_lineup(roster, SLOTS)
    ok &= check("OUT player not started", "Out RB" not in names(lu))
    ok &= check("DOUBTFUL player not started", "Doubtful RB" not in names(lu))
    ok &= check("QUESTIONABLE player still started", "Questionable RB" in names(lu))
    ok &= check("OUT player not picked up", not any(
        w["add"].name == "Out FA" for w in season.waiver_targets(
            base_roster(), [P("Out FA", "RB", 40.0, injury="OUT")], SLOTS)))
    starting_out = base_roster() + [P("Out starter", "WR", 15.0, "WR", injury="OUT")]
    ok &= check("OUT starter counts 0 in current total",
                abs(season.current_total(starting_out) - season.current_total(base_roster())) < 1e-9)
    full = [p for p in base_roster() if (p.proj_ros or 0) > 0]   # the star must be the weakest
    full += [P(f"Filler {i}", "WR", 1.0, ros=50.0) for i in range(season.roster_limit(SLOTS) - len(full) - 1)]
    full.append(P("Disputed star", "RB", 19.8, "RB", ros=0.0, injury="INJURY_RESERVE"))
    picks = season.waiver_targets(full, [P("Good FA", "QB", 40.0)], SLOTS)
    ok &= check("never suggests dropping a player we ask the user to double-check",
                picks and all(w["drop"].name != "Disputed star" for w in picks))
    # ESPN's raw number still drives the 'disagree -> ask the user' rules, unchanged.
    moves = season.ir_moves(roster, SLOTS)
    ok &= check("OUT but projected 30 is NOT auto-moved to IR",
                not any(m["player"].name == "Out RB" for m in moves))
    ir_conflict = base_roster() + [P("IR but playing", "WR", 12.0, "WR", injury="INJURY_RESERVE")]
    probs = season.problems(ir_conflict, season.best_lineup(ir_conflict, SLOTS))
    ok &= check("'marked IR but projected 12.0' warning still shown", any(
        p["kind"] == "conflict" and "12.0" in p["message"] for p in probs))
    return ok


def main():
    ok = test_lineup() & test_ir_and_waivers() & test_wont_play() & test_fixture_smoke()
    print("\n" + ("ALL CHECKS PASSED" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
