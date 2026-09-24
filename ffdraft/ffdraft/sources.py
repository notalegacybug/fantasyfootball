"""
Data acquisition. Runs BEFORE the draft, never during it.

Two sources:
  FantasyPros  -> consensus rankings (ECR, tier, expert spread) + season projections
  ESPN         -> your league's actual roster slots and scoring rules

Everything lands in a SQLite snapshot on disk. Draft night reads only the snapshot,
so the tool works with the network unplugged.
"""

import json
import sqlite3
import time
from dataclasses import dataclass, asdict, field

import httpx

FP_BASE = "https://api.fantasypros.com/public/v2/json"
ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons"

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]

# ESPN lineupSlotCounts keys. Verify these against your own league with
# `python -m sources check-espn` before draft day -- ESPN has changed slot IDs before.
ESPN_SLOTS = {
    0: "QB", 2: "RB", 4: "WR", 6: "TE",
    16: "DST", 17: "K",
    23: "FLEX",          # RB/WR/TE
    7: "OP",             # superflex / offensive player
    20: "BENCH", 21: "IR",
}

ESPN_STAT_RECEPTIONS = 53
ESPN_STAT_PASS_TD = 4


# --------------------------------------------------------------------------
# League format
# --------------------------------------------------------------------------

@dataclass
class LeagueFormat:
    teams: int = 10
    slots: dict = field(default_factory=lambda: {
        "QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1, "DST": 1, "K": 1, "OP": 0
    })
    bench: int = 7
    ppr: float = 1.0
    pass_td_points: float = 4.0
    source: str = "default"

    def rounds(self) -> int:
        starters = sum(v for k, v in self.slots.items() if k != "BENCH")
        return starters + self.bench


def fetch_espn_format(league_id: str, season: int,
                      espn_s2: str = "", swid: str = "",
                      timeout: float = 15.0) -> LeagueFormat:
    """Read the league's real settings so you don't have to guess PPR vs half vs standard."""
    url = f"{ESPN_BASE}/{season}/segments/0/leagues/{league_id}"
    cookies = {}
    if espn_s2 and swid:
        cookies = {"espn_s2": espn_s2, "SWID": swid}

    r = httpx.get(url, params={"view": "mSettings"}, cookies=cookies,
                  timeout=timeout, follow_redirects=True)
    r.raise_for_status()
    data = r.json()
    s = data.get("settings", {})

    roster = s.get("rosterSettings", {}).get("lineupSlotCounts", {})
    slots, bench = {}, 0
    for raw_id, count in roster.items():
        name = ESPN_SLOTS.get(int(raw_id))
        if name is None or count == 0:
            continue
        if name == "BENCH":
            bench = count
        elif name == "IR":
            continue
        else:
            slots[name] = count

    ppr, pass_td = 0.0, 4.0
    for item in s.get("scoringSettings", {}).get("scoringItems", []):
        if item.get("statId") == ESPN_STAT_RECEPTIONS:
            ppr = float(item.get("points", 0.0))
        if item.get("statId") == ESPN_STAT_PASS_TD:
            pass_td = float(item.get("points", 4.0))

    return LeagueFormat(
        teams=int(s.get("size", 10)),
        slots={**LeagueFormat().slots, **slots},
        bench=bench or 7,
        ppr=ppr,
        pass_td_points=pass_td,
        source=f"espn:{league_id}",
    )


def fp_scoring_param(fmt: LeagueFormat) -> str:
    """FantasyPros only accepts three scoring buckets. Map onto the nearest."""
    if fmt.ppr >= 0.75:
        return "PPR"
    if fmt.ppr >= 0.25:
        return "HALF"
    return "STD"


# --------------------------------------------------------------------------
# FantasyPros
# --------------------------------------------------------------------------

def _fp_get(path: str, api_key: str, params: dict, timeout: float = 20.0) -> dict:
    r = httpx.get(f"{FP_BASE}{path}", params=params,
                  headers={"x-api-key": api_key}, timeout=timeout)
    if r.status_code == 429:
        raise RuntimeError("FantasyPros rate limited you (429). Slow the prefetch down.")
    if r.status_code in (401, 403):
        raise RuntimeError(
            f"FantasyPros rejected the key ({r.status_code}). Free keys are "
            "non-production only; premium needs an active HOF subscription."
        )
    r.raise_for_status()
    return r.json()


def fetch_fp_rankings(api_key: str, season: int, scoring: str, position: str) -> list:
    d = _fp_get(f"/nfl/{season}/consensus-rankings", api_key,
                {"position": position, "scoring": scoring, "type": "draft"})
    return d.get("players", [])


def fetch_fp_projections(api_key: str, season: int, scoring: str, position: str) -> list:
    d = _fp_get(f"/nfl/{season}/projections", api_key,
                {"position": position, "scoring": scoring, "week": "draft"})
    return d.get("players", d.get("player", []))


# --------------------------------------------------------------------------
# Snapshot
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    fpid        INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    norm        TEXT NOT NULL,
    pos         TEXT NOT NULL,
    team        TEXT,
    bye         INTEGER,
    ecr         REAL,
    pos_rank    INTEGER,
    tier        INTEGER,
    rank_min    REAL,
    rank_max    REAL,
    rank_std    REAL,
    proj_pts    REAL
);
CREATE INDEX IF NOT EXISTS idx_players_norm ON players(norm);
CREATE INDEX IF NOT EXISTS idx_players_pos  ON players(pos);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""


def normalize_name(s: str) -> str:
    """Collapse the things that break name joins: suffixes, punctuation, case."""
    s = (s or "").lower()
    for junk in [" jr.", " jr", " sr.", " sr", " iii", " ii", " iv", " v."]:
        if s.endswith(junk):
            s = s[: -len(junk)]
    return "".join(c for c in s if c.isalnum())


def _norm_pos(p: str) -> str:
    p = (p or "").upper().strip()
    return {"D/ST": "DST", "DEF": "DST", "PK": "K"}.get(p, p)


def build_snapshot(db_path: str, api_key: str, season: int, fmt: LeagueFormat,
                   pause: float = 0.4, log=print) -> dict:
    """Pull everything once, join rankings to projections, write to disk."""
    scoring = fp_scoring_param(fmt)
    log(f"Scoring bucket: {scoring} (league PPR value {fmt.ppr})")

    by_id, proj_by_id, proj_by_norm = {}, {}, {}

    for pos in POSITIONS:
        log(f"  rankings  {pos}")
        for p in fetch_fp_rankings(api_key, season, scoring, pos):
            fpid = p.get("player_id") or p.get("fpid")
            if fpid is None:
                continue
            name = p.get("player_name") or p.get("name") or ""
            by_id[int(fpid)] = {
                "fpid": int(fpid),
                "name": name,
                "norm": normalize_name(name),
                "pos": _norm_pos(p.get("player_position_id") or pos),
                "team": p.get("player_team_id"),
                "bye": _int_or_none(p.get("player_bye_week")),
                "ecr": _float_or_none(p.get("rank_ecr")),
                "pos_rank": _int_or_none(_digits(p.get("pos_rank"))),
                "tier": _int_or_none(p.get("tier")),
                "rank_min": _float_or_none(p.get("rank_min")),
                "rank_max": _float_or_none(p.get("rank_max")),
                "rank_std": _float_or_none(p.get("rank_std")),
                "proj_pts": None,
            }
        time.sleep(pause)

    for pos in POSITIONS:
        log(f"  projections {pos}")
        for p in fetch_fp_projections(api_key, season, scoring, pos):
            fpid = p.get("player_id") or p.get("fpid")
            pts = _float_or_none(p.get("points") or p.get("fpts"))
            if pts is None:
                continue
            if fpid is not None:
                proj_by_id[int(fpid)] = pts
            nm = normalize_name(p.get("player_name") or p.get("name") or "")
            if nm:
                proj_by_norm[nm] = pts
        time.sleep(pause)

    matched = 0
    for fpid, row in by_id.items():
        pts = proj_by_id.get(fpid)
        if pts is None:
            pts = proj_by_norm.get(row["norm"])
        if pts is not None:
            row["proj_pts"] = pts
            matched += 1

    unmatched_top = [
        r["name"] for r in sorted(by_id.values(), key=lambda r: r["ecr"] or 9999)[:200]
        if r["proj_pts"] is None
    ]

    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)
    con.execute("DELETE FROM players")
    con.executemany(
        "INSERT OR REPLACE INTO players "
        "(fpid,name,norm,pos,team,bye,ecr,pos_rank,tier,rank_min,rank_max,rank_std,proj_pts) "
        "VALUES (:fpid,:name,:norm,:pos,:team,:bye,:ecr,:pos_rank,:tier,"
        ":rank_min,:rank_max,:rank_std,:proj_pts)",
        list(by_id.values()),
    )
    con.execute("INSERT OR REPLACE INTO meta VALUES ('format', ?)",
                (json.dumps(asdict(fmt)),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built_at', ?)",
                (time.strftime("%Y-%m-%d %H:%M:%S"),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('season', ?)", (str(season),))
    con.commit()
    con.close()

    return {
        "players": len(by_id),
        "with_projections": matched,
        "unmatched_top200": unmatched_top,
    }


def load_snapshot(db_path: str):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute("SELECT * FROM players")]
    meta = {k: v for k, v in con.execute("SELECT k, v FROM meta")}
    con.close()
    fmt = LeagueFormat(**json.loads(meta["format"])) if "format" in meta else LeagueFormat()
    return rows, fmt, meta


# --------------------------------------------------------------------------

def _float_or_none(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int_or_none(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _digits(v):
    if v is None:
        return None
    return "".join(c for c in str(v) if c.isdigit()) or None
