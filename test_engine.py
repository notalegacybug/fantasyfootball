"""
Runs the whole engine on synthetic data. No API key needed.
Point of this: prove the math is right days before it matters.

    python test_engine.py
"""

import random
from sources import LeagueFormat, normalize_name
from engine import Board, DraftState, replacement_ranks

random.seed(7)

# Rough real-world shapes: QBs flat and deep, RBs steep and shallow, TEs cliff early.
CURVES = {
    "QB":  (380, 4.5, 32),
    "RB":  (330, 7.5, 70),
    "WR":  (320, 5.2, 90),
    "TE":  (250, 9.0, 30),
    "K":   (140, 1.2, 32),
    "DST": (140, 1.6, 32),
}


def fake_players():
    out, fpid = [], 1
    for pos, (top, decay, n) in CURVES.items():
        for i in range(n):
            pts = top - decay * i + random.uniform(-6, 6)
            name = f"{pos} Player {i+1:02d}"
            out.append({
                "fpid": fpid, "name": name, "norm": normalize_name(name),
                "pos": pos, "team": "XXX", "bye": 7,
                "ecr": None, "pos_rank": i + 1, "tier": i // 6 + 1,
                "rank_min": None, "rank_max": None, "rank_std": None,
                "proj_pts": round(pts, 1),
            })
            fpid += 1
    # ECR by raw points, which is roughly what consensus does in a PPR league
    for r, p in enumerate(sorted(out, key=lambda p: -p["proj_pts"]), 1):
        p["ecr"] = float(r)
    return out


def check(label, cond):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    return cond


def main():
    players = fake_players()
    ok = True

    print("\n[1] Replacement level responds to league size")
    f10 = LeagueFormat(teams=10)
    f12 = LeagueFormat(teams=12)
    r10, r12 = replacement_ranks(f10), replacement_ranks(f12)
    print(f"     10-team: {r10}")
    print(f"     12-team: {r12}")
    ok &= check("12-team replacement is deeper at RB", r12["RB"] > r10["RB"])
    ok &= check("RB replacement sits past the RB2 count", r10["RB"] > 10 * 2)

    print("\n[2] Same player is worth less in a 10-team league")
    s10 = DraftState(teams=10, my_slot=4, rounds=f10.rounds())
    s12 = DraftState(teams=12, my_slot=4, rounds=f12.rounds())
    b10, b12 = Board(players, f10, s10), Board(players, f12, s12)
    rb1_10 = [r for r in b10.vor_board("RB") if r["pos_rank"] == 1][0]["vor"]
    rb1_12 = [r for r in b12.vor_board("RB") if r["pos_rank"] == 1][0]["vor"]
    print(f"     RB1 value over replacement: 10-team {rb1_10}  |  12-team {rb1_12}")
    ok &= check("RB1 is worth more in the 12-team league", rb1_12 > rb1_10)

    print("\n[3] Snake pick math")
    s = DraftState(teams=10, my_slot=4, rounds=15)
    seq = [s.slot_on_clock(n) for n in range(1, 21)]
    print(f"     slots on clock, picks 1-20: {seq}")
    ok &= check("round 1 ascends 1..10", seq[:10] == list(range(1, 11)))
    ok &= check("round 2 reverses", seq[10:] == list(range(10, 0, -1)))
    ok &= check("my first pick is #4", s.my_next_pick() == 4)
    s.drafted = {i: "other" for i in range(1, 4)}
    ok &= check("on the clock at pick 4", s.on_the_clock_is_me())
    ok &= check("12 players go between pick 4 and pick 17",
                s.picks_between_my_turns() == 12)
    ok &= check("my next pick after #4 is #17", s.my_next_pick(5) == 17)
    s2 = DraftState(teams=10, my_slot=4, rounds=15)
    ok &= check("at pick 1, three players go before I'm up", s2.lookahead() == 3)

    print("\n[4] Cost of waiting reacts to a draining position")
    st = DraftState(teams=10, my_slot=4, rounds=f10.rounds())
    b = Board(players, f10, st)
    before = {w["pos"]: w["cost"] for w in b.cost_of_waiting()}
    rbs = [p["fpid"] for p in b.available("RB")[:14]]
    for fid in rbs:
        st.drafted[fid] = "other"
    after = {w["pos"]: w["cost"] for w in b.cost_of_waiting()}
    print(f"     RB cost of waiting  before {before.get('RB')}  after 14 RBs gone {after.get('RB')}")
    ok &= check("RB pool is 14 shallower", len(b.available("RB")) == 70 - 14)
    ok &= check("board still returns recommendations", len(b.recommend()) == 5)

    print("\n[5] Kickers do not get recommended in round 1")
    st2 = DraftState(teams=10, my_slot=1, rounds=f10.rounds())
    b2 = Board(players, f10, st2)
    ok &= check("no K or DST in top 5", not any(
        r["pos"] in ("K", "DST") for r in b2.recommend(5)))

    print("\n[6] Name search survives real-world messiness")
    st3 = DraftState(teams=10, my_slot=1, rounds=f10.rounds())
    b3 = Board(players, f10, st3)
    ok &= check("partial match works", len(b3.search("RB Player 03")) >= 1)
    ok &= check("drafted players disappear from search",
                (lambda: (st3.drafted.update({b3.search("RB Player 03")[0]["fpid"]: "other"}),
                          not any(p["name"] == "RB Player 03"
                                  for p in b3.search("RB Player 03")))[1])())
    ok &= check("suffixes normalize", normalize_name("Marvin Harrison Jr.")
                == normalize_name("Marvin Harrison"))
    ok &= check("punctuation normalizes", normalize_name("Ja'Marr Chase")
                == normalize_name("JaMarr Chase"))

    print("\n" + ("ALL CHECKS PASSED" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
