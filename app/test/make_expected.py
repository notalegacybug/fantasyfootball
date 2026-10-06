"""
The parity answer key. Runs the PYTHON pipeline on the recorded fixtures and writes the
This-week page JSON; app/test/parity.test.js must reproduce it from the same fixtures.

Regenerate after changing season.py / league.py / sources.parse_* (and port the change):

    python app/test/make_expected.py
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import app as pyapp          # noqa: E402  (the FastAPI module; importing it starts nothing)
import season                # noqa: E402
from league import build_state  # noqa: E402

FIX = ROOT / "fixtures"
MY_SWID = "{00000000-0000-0000-0000-000000000001}"   # _scrub_fixture always maps me here


def load_raw() -> dict:
    return {
        "league": json.loads((FIX / "espn_league.json").read_text()),
        "free_agents": json.loads((FIX / "espn_free_agents.json").read_text()),
        "pro_schedule": json.loads((FIX / "espn_pro_schedule.json").read_text()),
        "info": {},
    }


def page_json(now_ms: float) -> dict:
    st = build_state(load_raw(), MY_SWID, now_ms=now_ms)
    r = season.weekly_report(st)
    pj = lambda p: pyapp._player_json(st, p)
    return {
        "week": r["week"], "me": pyapp._team_json(r["me"]),
        "opponent": pyapp._team_json(r["opponent"]),
        "current_total": round(r["current_total"], 1),
        "optimal_total": round(r["optimal_total"], 1),
        "opponent_total": None if r["opponent_total"] is None else round(r["opponent_total"], 1),
        "problems": [{"player": pj(x["player"]), "kind": x["kind"], "message": x["message"]}
                     for x in r["problems"]],
        "ir_moves": [{"player": pj(m["player"]), "from": m["from"], "to": m["to"],
                      "reason": m["reason"]} for m in r["ir_moves"]],
        "deltas": [{"slot": d["slot"], "out": pj(d["out"]), "in": pj(d["in"]),
                    "gain": round(d["gain"], 1)} for d in r["deltas"]],
        "close_calls": [{"slot": c["slot"], "starter": pj(c["starter"]), "alt": pj(c["alt"]),
                         "margin": round(c["margin"], 1)} for c in r["close_calls"]],
        "pickups": [{"add": pj(w["add"]), "drop": pj(w["drop"]) if w["drop"] else None,
                     "gain": round(w["gain"], 1), "ros_delta": round(w["ros_delta"], 1)}
                    for w in r["pickups"]],
        "starters": [{**pj(p), "slot": s} for s, p in r["starters"]],   # lineup slot wins over current
    }


def main():
    pro = json.loads((FIX / "espn_pro_schedule.json").read_text())
    week = json.loads((FIX / "espn_league.json").read_text())["scoringPeriodId"]
    kicks = sorted(g["date"] for t in pro["settings"]["proTeams"]
                   for g in (t.get("proGamesByScoringPeriod") or {}).get(str(week), []))
    # Two clocks: before the week starts (nothing locked) and mid-Sunday (about half the
    # games kicked off) -- the second exercises the `locked` branches on a real roster.
    scenarios = {"before_week": 0, "mid_sunday": kicks[len(kicks) // 2] + 1}
    out = {name: {"now_ms": now, "page": page_json(now)} for name, now in scenarios.items()}
    path = pathlib.Path(__file__).parent / "expected_week.json"
    path.write_text(json.dumps(out, indent=1))
    print(f"wrote {path.relative_to(ROOT)}: {', '.join(scenarios)}")


if __name__ == "__main__":
    main()
