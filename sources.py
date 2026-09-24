"""
Data acquisition. Runs BEFORE the draft, never during it.

One source, ESPN, for everything:
  - your league's actual roster slots and scoring rules (mSettings)
  - the full player pool: ADP/rank, ownership, and season projections already
    computed under YOUR league's scoring settings (kona_player_info)
  - bye weeks (proTeamSchedules, no auth needed)

ESPN doesn't publish expert "tiers" the way FantasyPros does, so `tier` is left
None rather than faked. Everything else lands in a SQLite snapshot on disk. Draft
night reads only the snapshot, so the tool works with the network unplugged.
"""

import json
import sqlite3
import statistics
import time
from dataclasses import dataclass, asdict, field

import httpx

ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons"

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]

# A player's actual position (kona_player_info -> player.defaultPositionId). This is
# a DIFFERENT enumeration from ESPN_SLOTS below -- confirmed empirically against a real
# league snapshot (McBride/Bowers are TEs with defaultPositionId 4, not WR).
ESPN_POSITION_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}

# ESPN lineupSlotCounts keys (league roster settings, mSettings view -- NOT the same
# numbering as ESPN_POSITION_ID above). Verify against your own league with
# `python app.py check-espn` before draft day -- ESPN has changed slot IDs before.
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


def espn_rank_type(fmt: LeagueFormat) -> str:
    """ESPN's draft-rank buckets. Only STANDARD and PPR exist; half-PPR snaps to PPR."""
    return "PPR" if fmt.ppr >= 0.5 else "STANDARD"


# --------------------------------------------------------------------------
# ESPN player pool
# --------------------------------------------------------------------------

def fetch_espn_players(league_id: str, season: int, espn_s2: str = "", swid: str = "",
                       timeout: float = 25.0, limit: int = 3000) -> list:
    """The full player pool for this league: ADP, ownership, expert rank spread, and
    season projections ESPN already computed under this league's own scoring rules."""
    url = f"{ESPN_BASE}/{season}/segments/0/leagues/{league_id}"
    cookies = {}
    if espn_s2 and swid:
        cookies = {"espn_s2": espn_s2, "SWID": swid}
    headers = {"x-fantasy-filter": json.dumps({
        "players": {"limit": limit,
                   "sortDraftRanks": {"sortPriority": 1, "sortAsc": True, "value": "STANDARD"}},
    })}
    r = httpx.get(url, params={"view": "kona_player_info"}, cookies=cookies,
                  headers=headers, timeout=timeout, follow_redirects=True)
    r.raise_for_status()
    return r.json().get("players", [])


def fetch_espn_pro_teams(season: int, timeout: float = 15.0) -> dict:
    """proTeamId -> {abbrev, bye}. Public endpoint, no league auth needed."""
    r = httpx.get(f"{ESPN_BASE}/{season}", params={"view": "proTeamSchedules"},
                  timeout=timeout, follow_redirects=True)
    r.raise_for_status()
    teams = r.json().get("settings", {}).get("proTeams", [])
    return {t["id"]: {"abbrev": t.get("abbrev"), "bye": t.get("byeWeek")} for t in teams}


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
    proj_pts    REAL,
    injury_status TEXT
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


def build_snapshot(db_path: str, season: int, fmt: LeagueFormat, league_id: str,
                   espn_s2: str = "", swid: str = "", log=print) -> dict:
    """Pull ESPN's player pool once, resolve each player's season projection and
    bye week, and write it all to disk."""
    rank_type = espn_rank_type(fmt)
    log(f"Rank type: {rank_type} (league PPR value {fmt.ppr})")

    log("  pro team schedule (bye weeks)")
    pro_teams = fetch_espn_pro_teams(season)

    log("  player pool (this can take a few seconds)")
    raw_players = fetch_espn_players(league_id, season, espn_s2, swid)

    by_id = {}
    for entry in raw_players:
        p = entry.get("player", entry)
        pos = ESPN_POSITION_ID.get(p.get("defaultPositionId"))
        if pos not in POSITIONS:
            continue
        fpid = p.get("id")
        if fpid is None:
            continue

        proj_pts = None
        for s in p.get("stats", []):
            if (s.get("seasonId") == season and s.get("scoringPeriodId") == 0
                    and s.get("statSourceId") == 1):
                proj_pts = _float_or_none(s.get("appliedTotal"))
                break

        team_info = pro_teams.get(p.get("proTeamId"), {})
        ownership = p.get("ownership", {})
        ecr = _float_or_none(ownership.get("averageDraftPosition"))
        if not ecr:
            ecr = _float_or_none(
                p.get("draftRanksByRankType", {}).get(rank_type, {}).get("rank"))

        ranks = [r.get("rank") for r in p.get("rankings", {}).get("0", [])
                 if r.get("rankType") == rank_type and r.get("rank")]

        name = p.get("fullName") or ""
        by_id[int(fpid)] = {
            "fpid": int(fpid),
            "name": name,
            "norm": normalize_name(name),
            "pos": pos,
            "team": team_info.get("abbrev"),
            "bye": _int_or_none(team_info.get("bye")),
            "ecr": ecr,
            "pos_rank": None,   # filled below, once every player's proj_pts is known
            "tier": None,       # ESPN doesn't publish expert tiers -- not faking one
            "rank_min": min(ranks) if ranks else None,
            "rank_max": max(ranks) if ranks else None,
            "rank_std": round(statistics.pstdev(ranks), 2) if len(ranks) > 1 else None,
            "proj_pts": proj_pts,
            "injury_status": p.get("injuryStatus"),
        }

    for pos in POSITIONS:
        ranked = sorted(
            (r for r in by_id.values() if r["pos"] == pos and r["proj_pts"] is not None),
            key=lambda r: -r["proj_pts"])
        for i, r in enumerate(ranked, start=1):
            r["pos_rank"] = i

    matched = sum(1 for r in by_id.values() if r["proj_pts"] is not None)
    unmatched_top = [
        r["name"] for r in sorted(by_id.values(), key=lambda r: r["ecr"] or 9999)[:200]
        if r["proj_pts"] is None
    ]

    con = sqlite3.connect(db_path)
    con.execute("DROP TABLE IF EXISTS players")  # schema evolves; never trust a stale one
    con.executescript(SCHEMA)
    con.executemany(
        "INSERT OR REPLACE INTO players "
        "(fpid,name,norm,pos,team,bye,ecr,pos_rank,tier,rank_min,rank_max,rank_std,proj_pts,injury_status) "
        "VALUES (:fpid,:name,:norm,:pos,:team,:bye,:ecr,:pos_rank,:tier,"
        ":rank_min,:rank_max,:rank_std,:proj_pts,:injury_status)",
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
