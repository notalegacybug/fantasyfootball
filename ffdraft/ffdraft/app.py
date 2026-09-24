"""
Draft night server. One process, no build step, reads only from the local snapshot.

  python app.py prefetch     # run this the day before AND ~20 min before the draft
  python app.py check-espn   # verify your league settings parsed correctly
  python app.py demo         # fake data, real math -- practice the keyboard flow
  python app.py reset        # clear draft state before a new draft
  python app.py serve        # draft night
"""

import json
import os
import sys
import pathlib

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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
    print(f"  points/reception {fmt.ppr}   -> FantasyPros bucket {sources.fp_scoring_param(fmt)}")
    print(f"  points/pass TD   {fmt.pass_td_points}")
    print(f"  total rounds   {fmt.rounds()}")
    print("\nIf any of that is wrong, fix ESPN_SLOTS in sources.py before drafting.")


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
    try:
        fmt = sources.fetch_espn_format(
            c["espn"]["league_id"], c["season"],
            c["espn"].get("espn_s2", ""), c["espn"].get("swid", ""))
        print(f"League format read from ESPN: {fmt.teams} teams, PPR={fmt.ppr}")
    except Exception as e:
        print(f"ESPN settings unavailable ({e}). Falling back to config override.")
        fmt = sources.LeagueFormat(**c.get("format_override", {}))

    res = sources.build_snapshot(DB, c["fantasypros_api_key"], c["season"], fmt)
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


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

app = FastAPI(title="Draft board")

# The extension runs on fantasy.espn.com and posts here, so it is cross-origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://fantasy.espn.com", "chrome-extension://*"],
    allow_origin_regex=r"^(https://fantasy\.espn\.com|chrome-extension://.*)$",
    allow_methods=["*"], allow_headers=["*"],
)

RECON_LOG = HERE / "recon.jsonl"
INGEST = {"events": 0, "ws_frames": 0, "mode": "recon"}

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
        "waiting": BOARD.cost_of_waiting(),
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


class Ingest(BaseModel):
    events: list = []
    dropped: int = 0


@app.post("/api/ingest")
def api_ingest(b: Ingest):
    """Recon mode: write everything to disk, parse nothing. Once we know the frame
    shape we add a parser here that turns picks into calls to api_pick."""
    with open(RECON_LOG, "a") as f:
        for e in b.events:
            INGEST["events"] += 1
            if str(e.get("kind", "")).startswith("ws-"):
                INGEST["ws_frames"] += 1
            f.write(json.dumps(e) + "\n")
    return {"ok": True, "events": INGEST["events"]}


@app.get("/api/ingest/status")
def api_ingest_status():
    return INGEST


@app.get("/")
def index():
    return FileResponse(HERE / "static" / "index.html")


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "prefetch":
        cmd_prefetch()
    elif cmd == "check-espn":
        cmd_check_espn()
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
