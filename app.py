"""
Draft night server. One process, no build step, reads only from the local snapshot.

  python app.py prefetch     # run this the day before AND ~20 min before the draft
  python app.py refresh      # in-season: force-refetch ESPN league data into the cache
  python app.py check-espn   # verify your league settings parsed correctly
  python app.py capture-fixture  # record scrubbed ESPN responses for test_sources.py
  python app.py demo         # fake data, real math -- practice the keyboard flow
  python app.py reset        # clear draft state before a new draft
  python app.py serve        # draft night
"""

import json
import os
import sys
import pathlib

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import sources
from engine import Board, DraftState

HERE = pathlib.Path(__file__).parent
DB = str(HERE / "snapshot.db")
CFG = HERE / "config.json"
STATE_FILE = HERE / "draft_state.json"


def load_config() -> dict:
    if not CFG.exists():
        sys.exit(f"No config.json. Copy config.example.json to {CFG} and fill it in.")
    return json.loads(CFG.read_text())


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_check_espn():
    c = load_config()
    fmt = sources.fetch_espn_format(
        c["espn"]["league_id"], c["season"],
        c["espn"].get("espn_s2", ""), c["espn"].get("swid", ""))
    print("Parsed from your ESPN league:")
    print(f"  teams          {fmt.teams}")
    print(f"  starting slots {fmt.slots}")
    print(f"  bench          {fmt.bench}")
    print(f"  points/reception {fmt.ppr}   -> ESPN rank type {sources.espn_rank_type(fmt)}")
    print(f"  points/pass TD   {fmt.pass_td_points}")
    print(f"  total rounds   {fmt.rounds()}")
    print("\nIf any of that is wrong, fix ESPN_SLOTS in sources.py before drafting.")


def _scrub_fixture(raw: dict, my_swid: str) -> dict:
    """Strip ESPN identities before a response is committed. Member GUIDs are the same
    value as a SWID cookie, and team/member names identify real people."""
    raw = json.loads(json.dumps(raw))            # deep copy
    fake_ids = {}

    def fake(guid):
        return fake_ids.setdefault(guid, "{00000000-0000-0000-0000-%012d}" % (len(fake_ids) + 1))

    if my_swid:
        fake(my_swid)                            # always {...-000000000001}
    if "members" in raw:
        raw["members"] = [{"id": fake(m["id"])} for m in raw["members"] if "id" in m]
    for t in raw.get("teams", []):
        t["name"], t["abbrev"] = f"Team {t['id']}", f"T{t['id']}"
        for k in ("location", "nickname", "logo", "logoType"):
            t.pop(k, None)
        t["owners"] = [fake(o) for o in t.get("owners", [])]
        if "primaryOwner" in t:
            t["primaryOwner"] = fake(t["primaryOwner"])
    # Size only: drop fields nothing reads. appliedTotal and variance stay (variance
    # may drive close-call flagging in milestone 2).
    players = [e.get("playerPoolEntry", {}).get("player", {})
               for t in raw.get("teams", []) for e in (t.get("roster") or {}).get("entries", [])]
    players += [e.get("player", {}) for e in raw.get("players", [])]
    for p in players:
        for k in ("rankings", "outlooks", "draftRanksByRankType"):
            p.pop(k, None)
        for s in p.get("stats", []):
            s.pop("stats", None)
            s.pop("appliedStats", None)
    return raw


def cmd_capture_fixture():
    """Read-only: three GETs against ESPN. Writes scrubbed JSON into fixtures/."""
    c = load_config()
    e = c["espn"]
    s2, swid = e.get("espn_s2", ""), e.get("swid", "")
    league = sources.fetch_espn_league(e["league_id"], c["season"], s2, swid)
    week = league["scoringPeriodId"]
    fa = sources.fetch_espn_free_agents(e["league_id"], c["season"], week, s2, swid)
    pro = sources.fetch_espn_pro_schedule(c["season"])

    out = HERE / "fixtures"
    out.mkdir(exist_ok=True)
    for name, body in [("espn_league.json", _scrub_fixture(league, swid)),
                       ("espn_free_agents.json", _scrub_fixture(fa, swid)),
                       ("espn_pro_schedule.json", pro)]:
        path = out / name
        path.write_text(json.dumps(body, separators=(",", ":")))
        print(f"  {path.name:26s} {path.stat().st_size // 1024:6d} KB")
    print(f"Captured week {week}. Review for identities before committing:")
    print("  git diff --stat fixtures/  and search the files for your name / team name.")


def cmd_demo():
    """Synthetic snapshot so you can drill the keyboard flow before your key arrives."""
    import sqlite3, json
    from dataclasses import asdict
    from test_engine import fake_players
    fmt = sources.LeagueFormat(**load_config().get("format_override", {}))
    con = sqlite3.connect(DB)
    con.executescript(sources.SCHEMA)
    con.execute("DELETE FROM players")
    con.executemany(
        "INSERT INTO players (fpid,name,norm,pos,team,bye,ecr,pos_rank,tier,"
        "rank_min,rank_max,rank_std,proj_pts) VALUES (:fpid,:name,:norm,:pos,:team,"
        ":bye,:ecr,:pos_rank,:tier,:rank_min,:rank_max,:rank_std,:proj_pts)",
        fake_players())
    con.execute("INSERT OR REPLACE INTO meta VALUES ('format', ?)",
                (json.dumps(asdict(fmt)),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built_at','DEMO DATA')")
    con.commit(); con.close()
    if STATE_FILE.exists():
        STATE_FILE.unlink()
    print("Demo snapshot ready. Run `python app.py serve` -- names are fake, math is real.")


def cmd_reset():
    if STATE_FILE.exists():
        STATE_FILE.unlink()
        print("Draft state cleared.")
    else:
        print("No draft state to clear.")


def cmd_prefetch():
    c = load_config()
    espn_s2 = c["espn"].get("espn_s2", "")
    swid = c["espn"].get("swid", "")
    try:
        fmt = sources.fetch_espn_format(
            c["espn"]["league_id"], c["season"], espn_s2, swid)
        print(f"League format read from ESPN: {fmt.teams} teams, PPR={fmt.ppr}")
    except Exception as e:
        print(f"ESPN settings unavailable ({e}). Falling back to config override.")
        fmt = sources.LeagueFormat(**c.get("format_override", {}))

    res = sources.build_snapshot(DB, c["season"], fmt, c["espn"]["league_id"], espn_s2, swid)
    print(f"\nSnapshot written to {DB}")
    print(f"  players            {res['players']}")
    print(f"  with projections   {res['with_projections']}")
    if res["unmatched_top200"]:
        print("\n  UNMATCHED IN TOP 200 -- these will be invisible on your board:")
        for n in res["unmatched_top200"]:
            print(f"    {n}")
        print("  Fix these before draft day or you will not see them.")
    else:
        print("  Every top-200 player matched a projection.")


def cmd_refresh():
    """In-season: force-refetch ESPN league data into the snapshot.db cache."""
    c = load_config()
    e = c["espn"]
    raw = sources.load_season_raw(DB, e["league_id"], c["season"],
                                  e.get("espn_s2", ""), e.get("swid", ""), force=True)
    lg = sources.parse_league(raw["league"])
    rows = [r for t in lg["teams"] for r in t["roster"]]
    fa = raw["free_agents"].get("players", [])
    print(f"Week {lg['week']}  (matchup period {lg['matchup_period']})")
    print(f"  teams       {len(lg['teams'])}")
    print(f"  rostered    {len(rows)}  with week-{lg['week']} projection: "
          f"{sum(r['proj_week'] is not None for r in rows)}")
    print(f"  free agents {len(fa)}")
    for name, info in raw["info"].items():
        print(f"  {name:13s} {info['source']}" + (f"  ({info['error']})" if "error" in info else ""))


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

app = FastAPI(title="Draft board")

BOARD: Board = None
STATE: DraftState = None
FMT = None


def boot():
    global BOARD, STATE, FMT
    c = load_config()
    if not os.path.exists(DB):
        sys.exit("No snapshot.db. Run `python app.py prefetch` first.")
    players, FMT, meta = sources.load_snapshot(DB)
    STATE = DraftState(teams=FMT.teams, my_slot=c["my_draft_slot"], rounds=FMT.rounds())
    if STATE_FILE.exists():
        saved = json.loads(STATE_FILE.read_text())
        STATE.drafted = {int(k): v for k, v in saved.get("drafted", {}).items()}
        print(f"Resumed draft state: {len(STATE.drafted)} picks already in.")
    BOARD = Board(players, FMT, STATE)
    print(f"Snapshot built {meta.get('built_at')} | {len(BOARD.players)} usable players")
    print(f"Replacement ranks: {BOARD.repl_rank}")


def persist():
    STATE_FILE.write_text(json.dumps({"drafted": STATE.drafted}))


def snapshot_payload() -> dict:
    return {
        "pick": STATE.pick_number,
        "round": (STATE.pick_number - 1) // STATE.teams + 1,
        "on_clock_slot": STATE.slot_on_clock(STATE.pick_number),
        "my_slot": STATE.my_slot,
        "my_turn": STATE.on_the_clock_is_me(),
        "picks_until_me": STATE.picks_until_my_turn(),
        "gap": STATE.lookahead(),
        "recommend": BOARD.recommend(5),
        "by_category": BOARD.best_by_category(),
        "sleepers": BOARD.sleepers(),
        "waiting": BOARD.cost_of_waiting(),
        "recent_run": BOARD.recent_run(),
        "needs": BOARD.needs(),
        "roster": sorted(BOARD.my_roster(), key=lambda p: p["pos"]),
        "drafted_count": len(STATE.drafted),
    }


class PickIn(BaseModel):
    fpid: int
    who: str = "other"       # "me" or "other"


@app.get("/api/state")
def api_state():
    return snapshot_payload()


@app.get("/api/board")
def api_board(pos: str = None, limit: int = 60):
    return {"rows": BOARD.vor_board(pos if pos and pos != "ALL" else None, limit)}


@app.get("/api/search")
def api_search(q: str):
    return {"rows": BOARD.search(q)}


@app.post("/api/pick")
def api_pick(p: PickIn):
    if p.fpid not in BOARD.players:
        return JSONResponse({"error": "unknown player"}, status_code=400)
    STATE.drafted[p.fpid] = p.who
    persist()
    return snapshot_payload()


@app.post("/api/undo")
def api_undo():
    if STATE.drafted:
        STATE.drafted.pop(list(STATE.drafted.keys())[-1])
        persist()
    return snapshot_payload()


@app.get("/")
def index():
    return FileResponse(HERE / "static" / "index.html")


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "prefetch":
        cmd_prefetch()
    elif cmd == "refresh":
        cmd_refresh()
    elif cmd == "check-espn":
        cmd_check_espn()
    elif cmd == "capture-fixture":
        cmd_capture_fixture()
    elif cmd == "demo":
        cmd_demo()
    elif cmd == "reset":
        cmd_reset()
    elif cmd == "serve":
        import uvicorn
        boot()
        uvicorn.run(app, host="127.0.0.1", port=8777, log_level="warning")
    else:
        sys.exit(__doc__)
