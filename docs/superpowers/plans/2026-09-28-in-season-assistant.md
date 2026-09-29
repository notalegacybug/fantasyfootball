# In-Season Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the local draft app into a weekly in-season assistant (start/sit, waivers, standings, trades) that reads the private ESPN league read-only.

**Architecture:** `sources.py` gains raw ESPN reads, a TTL cache table in `snapshot.db`, and parsers that flatten ESPN JSON into plain dicts (same pattern `build_snapshot` already uses). New `league.py` / `season.py` hold the in-season model and decision math. `engine.py` is untouched.

**Tech Stack:** Python 3.14, httpx, sqlite3 (stdlib), FastAPI + uvicorn (existing). Tests are plain scripts in the `test_engine.py` style (`check()` + PASS/FAIL, no pytest).

**Spec:** `docs/superpowers/specs/2026-09-16-in-season-assistant-design.md`

## Global Constraints

- `engine.py` is **unchanged**. Its 15 tests must still pass after every task: `python test_engine.py`.
- Existing draft code paths in `sources.py` (`fetch_espn_format`, `fetch_espn_players`, `fetch_espn_pro_teams`, `build_snapshot`, `load_snapshot`) are **not modified**.
- ESPN is the only data source. No LLM, no scraping (spec §2.3).
- Read-only against ESPN. Never write lineups, claims, or trades (spec §3).
- Auth is the `Cookie` header only (`espn_s2` + `SWID`), as httpx `cookies=` (spec §2.2).
- Current week comes from ESPN `scoringPeriodId`, never computed from a date (spec §4.4).
- `statSourceId`: 0 = actual, 1 = projected. `scoringPeriodId`: 0 = full season, N = week N (spec §4.5).
- `CACHE_TTL_MINUTES = 30` (spec §6).
- **No test hits the live ESPN API** (spec §7.3). Tests run with `python test_sources.py`, no network.
- Committed fixtures must not contain ESPN member identities (names, SWIDs) — scrubbed at capture time.

---

## Roadmap (spec §10)

Each milestone gets its own detailed task list when it is reached. Milestones 2+ are
deliberately **not** detailed yet: their parsing details depend on what the real fixture
captured in Milestone 1 shows, and writing their code now would bake in guesses.

| # | milestone | detail | ships |
| --- | --- | --- | --- |
| 1 | `sources.py` fetches + cache table + fixture test | **this document, Tasks 1–4** | `python app.py refresh` |
| 2 | `league.py` + `season.py::best_lineup()` + `test_season.py` | planned after M1 | CLI lineup check |
| 3 | Home screen: lineup deltas only, `/` → season, `/draft` → old board | planned after M2 | **ship point (+15.7 pts)** |
| 4 | Waivers on Home | later | |
| 5 | Standings tab | later | |
| 6 | Trade finder tab | later | |

**Open questions M1 answers for M2+** (record answers in Task 3 Step 6):
1. Does `mRoster` without a `scoringPeriodId` param include week-N projected stats?
2. Is `statSourceId=1, scoringPeriodId=0` a *rest-of-season* or *full-season* projection mid-season? (Matters for the trade finder, M6.)
3. Does `teams[].owners[]` contain the same braced GUID string as the `SWID` cookie? (Needed to find "my team" from nothing but a league ID + cookie.)

**Answers (week-3 capture, 2026-09-28):**
1. **Yes.** No `scoringPeriodId` param needed; rosters carry week-N (and week N-1) projections.
2. **Both exist, split by `statSplitTypeId`:** 0 = rest-of-season, 2 = full season, order varies. `pick_stat` now takes a `split` argument. The original plan code would have silently returned full-season.
3. **Yes.** Exact match; exactly one team owned by the config SWID.
4. **Spec correction (not asked):** ESPN *does* publish `variance` and `appliedTotalCeiling` per projection. Spec §5.1 says it doesn't. Discuss using it for close calls when planning M2.

**Deviations from Task 3 as written:** `fetch_espn_pro_schedule` strips `plays` (~290 KB/game); the scrubber also drops `rankings`, `outlooks`, `draftRanksByRankType`, `appliedStats`; fixtures are written compact. Result: 1070 / 372 / 249 KB, down from 4.3 / 1.7 / 39 MB.

---

## File structure for Milestone 1

| file | change | responsibility |
| --- | --- | --- |
| `sources.py` | modify (append only) | cache table, `cached_fetch`, 3 fetchers, 4 parsers, `load_season_raw` |
| `app.py` | modify | `capture-fixture` and `refresh` CLI commands + fixture scrubber |
| `test_sources.py` | create | cache tests, synthetic parser tests, fixture tests |
| `fixtures/espn_league.json` | create (captured) | scrubbed `mTeam+mRoster+mMatchupScore+mSettings` response |
| `fixtures/espn_free_agents.json` | create (captured) | scrubbed `kona_player_info` free-agent response |
| `fixtures/espn_pro_schedule.json` | create (captured) | public `proTeamSchedules` response |

**Schema change (flagged):** one new table `espn_cache` in `snapshot.db`. Additive only;
`snapshot.db` is gitignored and regenerable. `build_snapshot` drops and recreates only
the `players` table, so the cache survives `prefetch` — Task 1 tests this.

---

### Task 1: Cache table and `cached_fetch`

**Files:**
- Modify: `sources.py` (append a new section after `load_snapshot`, before the `_float_or_none` helpers)
- Create: `test_sources.py`

**Interfaces:**
- Produces: `CACHE_TTL_MINUTES: int`, `CACHE_SCHEMA: str`,
  `cached_fetch(db_path: str, key: str, fetch: Callable[[], dict], ttl_minutes: float = CACHE_TTL_MINUTES, force: bool = False, now: float | None = None) -> tuple[dict, dict]`
  — second element is `info = {"key", "fetched_at": float, "source": "cache"|"network"|"stale", "error"?: str}`.

- [ ] **Step 1: Write the failing test** — create `test_sources.py`:

```python
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


def main():
    ok = True
    ok &= test_cache()
    print("\n" + ("ALL CHECKS PASSED" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Run to verify it fails**

Run: `python test_sources.py`
Expected: `AttributeError: module 'sources' has no attribute 'cached_fetch'`

- [ ] **Step 3: Implement** — append to `sources.py` after `load_snapshot` (before the `# ----` line that precedes `_float_or_none`):

```python
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
```

- [ ] **Step 4: Run tests**

Run: `python test_sources.py` → Expected: `ALL CHECKS PASSED`
Run: `python test_engine.py` → Expected: `ALL CHECKS PASSED` (draft untouched)

- [ ] **Step 5: Commit**

```bash
git add sources.py test_sources.py
git commit -m "feat(sources): TTL cache table for raw ESPN responses"
```

---

### Task 2: Fetchers and parsers (synthetic tests)

**Files:**
- Modify: `sources.py` (append below `cached_fetch`)
- Modify: `test_sources.py` (add `test_parsers`, call it from `main`)

**Interfaces:**
- Consumes: `ESPN_BASE`, `ESPN_SLOTS`, `ESPN_POSITION_ID`, `_float_or_none`, `_int_or_none` (existing).
- Produces:
  - `fetch_espn_league(league_id: str, season: int, espn_s2: str = "", swid: str = "", week: int | None = None) -> dict`
  - `fetch_espn_free_agents(league_id: str, season: int, week: int, espn_s2: str = "", swid: str = "", limit: int = 150) -> dict`
  - `fetch_espn_pro_schedule(season: int) -> dict`
  - `pick_stat(stats: list, season: int, period: int, source: int) -> float | None`
  - `slot_name(slot_id: int) -> str` — raises `ValueError` on unknown id
  - `parse_player(p: dict, season: int, week: int) -> dict` with keys
    `player_id, name, pos, pro_team_id, eligible (sorted list[str]), proj_week, proj_ros, injury, pct_started, pct_change, outlook`
  - `parse_league(raw: dict, week: int | None = None) -> dict` with keys
    `season, week, current_week, matchup_period, slots (dict[str,int]), teams, schedule`;
    each team: `id, name, abbrev, owners, wins, losses, ties, points_for, points_against, roster` (roster rows = `parse_player` + `slot`)
  - `parse_free_agents(raw: dict, season: int, week: int) -> list[dict]` (rows = `parse_player` + `status`)
  - `parse_pro_schedule(raw: dict) -> dict[int, dict]` — `{pro_team_id: {"abbrev", "bye", "games": {week: {"opp", "home", "kickoff_ms"}}}}`, pseudo-team id 0 excluded

- [ ] **Step 1: Write the failing test** — add to `test_sources.py` above `main()`, and add `ok &= test_parsers()` inside `main()` after `test_cache()`:

```python
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `python test_sources.py`
Expected: section [1]–[2] PASS, then `AttributeError: module 'sources' has no attribute 'parse_player'`

- [ ] **Step 3: Implement** — append to `sources.py` below `cached_fetch`:

```python
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
    because the season tool needs opponents and kickoffs, not just byes."""
    return _espn_get(f"{ESPN_BASE}/{season}", [("view", "proTeamSchedules")], timeout=15.0)


def pick_stat(stats, season: int, period: int, source: int):
    """The appliedTotal for one exact (season, scoringPeriodId, statSourceId) triple.
    source: 0 = actual, 1 = projected. period: 0 = full season, N = week N."""
    for s in stats or []:
        if (s.get("seasonId") == season and s.get("scoringPeriodId") == period
                and s.get("statSourceId") == source):
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
        "proj_week": pick_stat(p.get("stats"), season, week, 1),
        "proj_ros": pick_stat(p.get("stats"), season, 0, 1),
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
```

- [ ] **Step 4: Run tests**

Run: `python test_sources.py` → Expected: `ALL CHECKS PASSED`
Run: `python test_engine.py` → Expected: `ALL CHECKS PASSED`

- [ ] **Step 5: Commit**

```bash
git add sources.py test_sources.py
git commit -m "feat(sources): in-season ESPN fetchers and flat parsers"
```

---

### Task 3: Capture the real fixture and assert on it

> **Gate:** Step 3 makes three live, read-only GETs to ESPN using the cookie in
> `config.json`. Confirm with the user before running it.

**Files:**
- Modify: `app.py` (add `_scrub_fixture`, `cmd_capture_fixture`, dispatch entry, docstring line)
- Create: `fixtures/espn_league.json`, `fixtures/espn_free_agents.json`, `fixtures/espn_pro_schedule.json`
- Modify: `test_sources.py` (add `test_fixture`, call from `main`)

**Interfaces:**
- Consumes: `fetch_espn_league`, `fetch_espn_free_agents`, `fetch_espn_pro_schedule`, `parse_league`, `parse_free_agents`, `parse_pro_schedule` (Task 2).
- Produces: committed fixtures. **Scrub contract** later milestones rely on: team names become `"Team {id}"`, abbrevs `"T{id}"`; member GUIDs are replaced by `"{00000000-0000-0000-0000-00000000000N}"`, assigned in order with **the config SWID always first (N=1)**, so "my team" is findable in tests.

- [ ] **Step 1: Add the capture command** — in `app.py`, add to the module docstring after the `check-espn` line:

```
  python app.py capture-fixture  # record scrubbed ESPN responses for test_sources.py
```

Add after `cmd_check_espn`:

```python
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
    # Per-stat breakdowns are ~90% of the payload and nothing reads them; appliedTotal stays.
    players = [e.get("playerPoolEntry", {}).get("player", {})
               for t in raw.get("teams", []) for e in (t.get("roster") or {}).get("entries", [])]
    players += [e.get("player", {}) for e in raw.get("players", [])]
    for p in players:
        for s in p.get("stats", []):
            s.pop("stats", None)
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
        path.write_text(json.dumps(body, indent=1))
        print(f"  {path.name:26s} {path.stat().st_size // 1024:6d} KB")
    print(f"Captured week {week}. Review for identities before committing:")
    print("  git diff --stat fixtures/  and search the files for your name / team name.")
```

Add to the `__main__` dispatch, after the `check-espn` branch:

```python
    elif cmd == "capture-fixture":
        cmd_capture_fixture()
```

- [ ] **Step 2: Confirm the gate with the user** (live ESPN read). Do not proceed without a yes.

- [ ] **Step 3: Capture**

Run: `python app.py capture-fixture`
Expected: three files listed, a `Captured week N` line. If you see `401`, the cookie in `config.json` expired — the user must copy fresh `espn_s2`/`SWID` from their browser.

- [ ] **Step 4: Scrub audit** (cheap, do not skip)

Run: `grep -il "avengers\|subha" fixtures/*.json; grep -o '"displayName"\|"firstName"\|"lastName"' fixtures/*.json | sort | uniq -c`
Expected: no output from either. Any output → fix `_scrub_fixture` and recapture.

- [ ] **Step 5: Write the fixture tests** — add to `test_sources.py` above `main()`, and `ok &= test_fixture()` in `main()`:

```python
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
    for t in lg["teams"]:
        starters = [r for r in t["roster"] if r["slot"] not in ("BENCH", "IR")]
        if len(starters) > 10:
            ok &= check(f"team {t['id']} has at most 10 starters", False)
    ok &= check("every player is eligible for the slot they sit in",
                all(r["slot"] in r["eligible"] for r in rows))

    with_week = [r for r in rows if r["proj_week"] is not None]
    ok &= check("weekly projections found for >=80% of rostered players",
                len(with_week) >= 0.8 * len(rows))
    both = [r for r in rows if r["proj_week"] and r["proj_ros"]]
    ok &= check("season projection dwarfs weekly (pair not swapped)",
                sum(r["proj_ros"] > 3 * r["proj_week"] for r in both) >= 0.9 * len(both))
    ok &= check("exactly one team is mine (owner matches scrubbed SWID)",
                sum("{00000000-0000-0000-0000-000000000001}" in t["owners"]
                    for t in lg["teams"]) == 1)

    print("\n[7] Recorded free agents")
    fa = sources.parse_free_agents(load_fixture("espn_free_agents.json"), lg["season"], week)
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
```

- [ ] **Step 6: Run and record answers to the Roadmap's open questions**

Run: `python test_sources.py`
Expected: `ALL CHECKS PASSED`.

Decision points:
- **"weekly projections found" FAILS** → open question 1 is "no". Fix: in `cmd_capture_fixture`, fetch twice — first call as-is to read `scoringPeriodId`, second with `week=week` — recapture, rerun. (`load_season_raw` in Task 4 must then do the same.)
- **"exactly one team is mine" FAILS** → open question 3 is "format differs". Print `raw["teams"][0]["owners"]` vs the config SWID, note the difference in this plan, and relax to a case-insensitive match in Milestone 2.
- **Open question 2:** pick one healthy starter from week ≥ 3 and compare `proj_ros` to their ESPN player card's season projection. Write the answer under "Open questions" above.

- [ ] **Step 7: Commit** (fixture is ~few hundred KB after stat stripping; if any file is >2 MB, stop and discuss trimming before committing)

```bash
git add app.py test_sources.py fixtures/
git commit -m "test(sources): recorded ESPN fixture guards slot ids and stat selection"
```

---

### Task 4: `load_season_raw` and `python app.py refresh`

**Files:**
- Modify: `sources.py` (append below `parse_pro_schedule`)
- Modify: `app.py` (add `cmd_refresh`, dispatch, docstring)
- Modify: `test_sources.py` (add `test_load_season_raw`, call from `main`)

**Interfaces:**
- Consumes: `cached_fetch` (Task 1), the three fetchers (Task 2), fixtures (Task 3).
- Produces: `load_season_raw(db_path: str, league_id: str, season: int, espn_s2: str = "", swid: str = "", force: bool = False) -> dict` returning `{"league": dict, "free_agents": dict, "pro_schedule": dict, "info": {"league": info, "free_agents": info, "pro_schedule": info}}`. Milestone 3's server boot calls this with `force=False`.

- [ ] **Step 1: Write the failing test** — add above `main()`, and `ok &= test_load_season_raw()` in `main()`:

```python
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `python test_sources.py`
Expected: `AttributeError: module 'sources' has no attribute 'load_season_raw'`

- [ ] **Step 3: Implement** — append to `sources.py`:

```python
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
```

(If Task 3 Step 6 found weekly projections missing without `scoringPeriodId`, change the
league lambda to fetch once for the week, then `fetch_espn_league(..., week=week)`.)

- [ ] **Step 4: Add the CLI** — docstring line after `prefetch`:

```
  python app.py refresh      # in-season: force-refetch ESPN league data into the cache
```

Add after `cmd_prefetch`:

```python
def cmd_refresh():
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
        print(f"  {name:13s} {info['source']}" + (f"  ({info['error']})" if 'error' in info else ""))
```

Dispatch, after `prefetch`:

```python
    elif cmd == "refresh":
        cmd_refresh()
```

- [ ] **Step 5: Run tests**

Run: `python test_sources.py` → Expected: `ALL CHECKS PASSED`
Run: `python test_engine.py` → Expected: `ALL CHECKS PASSED`

- [ ] **Step 6: Manual check** (live, read-only — confirm with the user first)

Run: `python app.py refresh`
Expected: `Week N`, 10 teams, ~160 rostered, all three sources `network`. Run again: still `network` (force). Then `python -c "import sources,app; print({k:v['source'] for k,v in sources.load_season_raw(app.DB, '<league_id>', 2026)['info'].items()})"` → all `cache`.

- [ ] **Step 7: Commit**

```bash
git add sources.py app.py test_sources.py
git commit -m "feat: python app.py refresh pulls in-season ESPN data through the cache"
```

Milestone 1 done. Push only after the user confirms. Then write the Milestone 2 plan,
using the recorded answers to the open questions.

---

## Milestones 2–4 (built together, 2026-09-28, "page only")

The user asked for one weekly answer: games, start/sit, IR, drops, pickups. Built as
`league.py` + `season.py` + `test_season.py` + `/api/season/week` + `static/season.html`.

**Deviations from the spec, all small:**
- One route `/api/season/week` instead of `/state` + `/lineup` + `/waivers`: the page always needs all three.
- **IR moves are new** (not in the spec). ESPN lists IR in `eligibleSlots` for every player, so eligibility comes from `injuryStatus` (`IR_ELIGIBLE_STATUSES`). A healthy player in IR is flagged "Fix first".
- **Drops use rest-of-season projection**, not weekly, so a star on bye is never cut.
- **Multi-position players** are enumerated (try each position) because plain greedy is not exact for them. No 2026 player has two positions today.
- **Locked players** (kickoff passed) keep their slots / can't come in.
- Standings and Trades tabs not built yet (M5, M6).
