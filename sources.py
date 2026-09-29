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
# In-season: raw ESPN responses, cached
# --------------------------------------------------------------------------

# How stale ESPN data may be before refetch. Short enough that Sunday-morning
# injury news lands before lock; long enough that a dev session doesn't hammer ESPN.
CACHE_TTL_MINUTES = 30

# Separate from SCHEMA on purpose: build_snapshot drops and rebuilds `players`,
# and a draft prefetch must never wipe in-season data.
CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS espn_cache (
    key        TEXT PRIMARY KEY,
    fetched_at REAL NOT NULL,
    body       TEXT NOT NULL
);
"""


def cached_fetch(db_path: str, key: str, fetch, ttl_minutes: float = CACHE_TTL_MINUTES,
                 force: bool = False, now: float = None):
    """Return (body, info). Serves the cache inside the TTL; otherwise calls fetch().
    If the network fails and ANY cached copy exists, serves it marked 'stale' -- the
    draft tool's works-with-wifi-off property, kept for the season tool. Callers must
    surface info['source'] == 'stale', because an expired cookie (401) lands here too."""
    now = time.time() if now is None else now
    con = sqlite3.connect(db_path)
    try:
        con.executescript(CACHE_SCHEMA)
        row = con.execute("SELECT fetched_at, body FROM espn_cache WHERE key = ?",
                          (key,)).fetchone()
        if row and not force and now - row[0] < ttl_minutes * 60:
            return json.loads(row[1]), {"key": key, "fetched_at": row[0], "source": "cache"}
        try:
            body = fetch()
        except (httpx.HTTPError, OSError) as e:
            if row:
                return json.loads(row[1]), {"key": key, "fetched_at": row[0],
                                            "source": "stale", "error": str(e)}
            raise
        con.execute("INSERT OR REPLACE INTO espn_cache VALUES (?, ?, ?)",
                    (key, now, json.dumps(body)))
        con.commit()
        return body, {"key": key, "fetched_at": now, "source": "network"}
    finally:
        con.close()


def _espn_get(url: str, params, espn_s2: str = "", swid: str = "",
              headers: dict = None, timeout: float = 25.0) -> dict:
    """Cookie-header auth is the only thing ESPN accepts for a private league (spec 2.2)."""
    cookies = {"espn_s2": espn_s2, "SWID": swid} if espn_s2 and swid else {}
    r = httpx.get(url, params=params, cookies=cookies, headers=headers or {},
                  timeout=timeout, follow_redirects=True)
    r.raise_for_status()
    return r.json()


def fetch_espn_league(league_id: str, season: int, espn_s2: str = "", swid: str = "",
                      week: int = None) -> dict:
    """Teams, rosters (with per-player stats), matchups and settings in one call.
    Repeated `view` params are how ESPN combines views; httpx needs a list of tuples."""
    params = [("view", v) for v in ("mTeam", "mRoster", "mMatchupScore", "mSettings")]
    if week is not None:
        params.append(("scoringPeriodId", week))
    return _espn_get(f"{ESPN_BASE}/{season}/segments/0/leagues/{league_id}",
                     params, espn_s2, swid)


# lineupSlot ids for the six real positions -- ESPN_SLOTS numbering, not ESPN_POSITION_ID.
FREE_AGENT_SLOT_IDS = [0, 2, 4, 6, 16, 17]


def fetch_espn_free_agents(league_id: str, season: int, week: int, espn_s2: str = "",
                           swid: str = "", limit: int = 150) -> dict:
    """Unrostered players in THIS league, most-owned first, with week-N stats attached."""
    flt = {"players": {
        "filterStatus": {"value": ["FREEAGENT", "WAIVERS"]},
        "filterSlotIds": {"value": FREE_AGENT_SLOT_IDS},
        "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
        "limit": limit,
    }}
    return _espn_get(f"{ESPN_BASE}/{season}/segments/0/leagues/{league_id}",
                     [("view", "kona_player_info"), ("scoringPeriodId", week)],
                     espn_s2, swid, headers={"x-fantasy-filter": json.dumps(flt)})


def fetch_espn_pro_schedule(season: int) -> dict:
    """Full NFL schedule by week. Public, no auth. Raw, unlike fetch_espn_pro_teams,
    because the season tool needs opponents and kickoffs, not just byes.
    Each finished game carries ~290 KB of `plays` (play-by-play); dropped here so a
    refresh doesn't write ~20 MB into the cache for data nothing reads."""
    raw = _espn_get(f"{ESPN_BASE}/{season}", [("view", "proTeamSchedules")], timeout=15.0)
    for t in raw.get("settings", {}).get("proTeams", []):
        for games in (t.get("proGamesByScoringPeriod") or {}).values():
            for g in games:
                g.pop("plays", None)
    return raw


# statSplitTypeId, confirmed against the week-3 2026 fixture: period 0 carries TWO
# projections -- split 0 is rest-of-season (~2 fewer games than split 2 for 133 of
# 166 rostered players after week 2) and split 2 is the full season. Order varies.
SPLIT_WEEK, SPLIT_REST_OF_SEASON, SPLIT_FULL_SEASON = 1, 0, 2


def pick_stat(stats, season: int, period: int, source: int, split: int = None):
    """The appliedTotal for one exact (season, scoringPeriodId, statSourceId[, split]).
    source: 0 = actual, 1 = projected. period: 0 = season, N = week N.
    split=None matches any split -- only safe where ESPN sends just one."""
    for s in stats or []:
        if (s.get("seasonId") == season and s.get("scoringPeriodId") == period
                and s.get("statSourceId") == source
                and (split is None or s.get("statSplitTypeId") == split)):
            return _float_or_none(s.get("appliedTotal"))
    return None


def slot_name(slot_id: int) -> str:
    """Fail loudly: a silently mis-slotted roster is how a zero-point player gets started."""
    name = ESPN_SLOTS.get(slot_id)
    if name is None:
        raise ValueError(f"Unknown ESPN lineupSlotId {slot_id}. ESPN may have renumbered "
                         f"its slots -- update ESPN_SLOTS in sources.py.")
    return name


def parse_player(p: dict, season: int, week: int) -> dict:
    own = p.get("ownership") or {}
    return {
        "player_id": p.get("id"),
        "name": p.get("fullName") or "",
        "pos": ESPN_POSITION_ID.get(p.get("defaultPositionId")),
        "pro_team_id": p.get("proTeamId"),
        # Composite ids (3 = RB/WR, 5 = WR/TE, ...) are dropped: FLEX (23) already
        # expresses the only multi-position slot this league uses.
        "eligible": sorted({ESPN_SLOTS[s] for s in p.get("eligibleSlots", [])
                            if s in ESPN_SLOTS}),
        "proj_week": pick_stat(p.get("stats"), season, week, 1, SPLIT_WEEK),
        "proj_ros": pick_stat(p.get("stats"), season, 0, 1, SPLIT_REST_OF_SEASON),
        "injury": p.get("injuryStatus"),
        "pct_started": _float_or_none(own.get("percentStarted")),
        "pct_change": _float_or_none(own.get("percentChange")),
        "outlook": p.get("seasonOutlook"),
    }


def parse_league(raw: dict, week: int = None) -> dict:
    """Flatten a fetch_espn_league response into plain dicts. No domain logic here --
    that lives in league.py, same split as build_snapshot -> engine.py."""
    season = raw["seasonId"]
    week = raw["scoringPeriodId"] if week is None else week

    slots = {}
    counts = raw.get("settings", {}).get("rosterSettings", {}).get("lineupSlotCounts", {})
    for raw_id, count in counts.items():
        if count:
            slots[slot_name(int(raw_id))] = count

    teams = []
    for t in raw.get("teams", []):
        roster = []
        for e in (t.get("roster") or {}).get("entries", []):
            p = (e.get("playerPoolEntry") or {}).get("player") or {}
            roster.append({**parse_player(p, season, week), "slot": slot_name(e["lineupSlotId"])})
        rec = (t.get("record") or {}).get("overall") or {}
        name = t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip()
        teams.append({
            "id": t["id"], "name": name, "abbrev": t.get("abbrev"),
            "owners": t.get("owners", []),
            "wins": rec.get("wins", 0), "losses": rec.get("losses", 0),
            "ties": rec.get("ties", 0),
            "points_for": rec.get("pointsFor", 0.0),
            "points_against": rec.get("pointsAgainst", 0.0),
            "roster": roster,
        })

    schedule = []
    for m in raw.get("schedule", []):
        home, away = m.get("home") or {}, m.get("away") or {}
        schedule.append({
            "period": m.get("matchupPeriodId"),
            "home": home.get("teamId"), "away": away.get("teamId"),   # away is None on a bye
            "home_pts": home.get("totalPoints"), "away_pts": away.get("totalPoints"),
        })

    return {
        "season": season, "week": week, "current_week": raw.get("scoringPeriodId"),
        "matchup_period": raw.get("status", {}).get("currentMatchupPeriod"),
        "slots": slots, "teams": teams, "schedule": schedule,
    }


def parse_free_agents(raw: dict, season: int, week: int) -> list:
    return [{**parse_player(e.get("player") or {}, season, week), "status": e.get("status")}
            for e in raw.get("players", [])]


def parse_pro_schedule(raw: dict) -> dict:
    out = {}
    for t in raw.get("settings", {}).get("proTeams", []):
        if not t.get("id"):
            continue          # id 0 is ESPN's "FA" pseudo-team
        games = {}
        for wk, gs in (t.get("proGamesByScoringPeriod") or {}).items():
            for g in gs:
                home = g.get("homeProTeamId") == t["id"]
                games[int(wk)] = {
                    "opp": g.get("awayProTeamId") if home else g.get("homeProTeamId"),
                    "home": home, "kickoff_ms": g.get("date"),
                }
        out[t["id"]] = {"abbrev": t.get("abbrev"), "bye": _int_or_none(t.get("byeWeek")),
                        "games": games}
    return out


def load_season_raw(db_path: str, league_id: str, season: int, espn_s2: str = "",
                    swid: str = "", force: bool = False) -> dict:
    """Everything the season tool reads, via the cache. The week comes from the league
    response's scoringPeriodId -- never from the calendar (spec 4.4)."""
    league, li = cached_fetch(db_path, f"league:{league_id}:{season}",
                              lambda: fetch_espn_league(league_id, season, espn_s2, swid),
                              force=force)
    week = league["scoringPeriodId"]
    fa, fi = cached_fetch(db_path, f"fa:{league_id}:{season}:wk{week}",
                          lambda: fetch_espn_free_agents(league_id, season, week, espn_s2, swid),
                          force=force)
    pro, pi = cached_fetch(db_path, f"pro:{season}",
                           lambda: fetch_espn_pro_schedule(season), force=force)
    return {"league": league, "free_agents": fa, "pro_schedule": pro,
            "info": {"league": li, "free_agents": fi, "pro_schedule": pi}}


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
