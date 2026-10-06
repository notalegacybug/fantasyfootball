"""
The live league, as the season tool sees it. Built from sources.load_season_raw();
no network and no decision math here -- that is season.py.

Kept separate from engine.py on purpose (spec 4.2): a draft pool drains, a season
roster is rearranged. Different state, different lifecycle.
"""

import time
from dataclasses import dataclass, field

import sources


# ESPN statuses that mean "not playing this week". QUESTIONABLE usually plays, so it keeps
# its projection and is flagged in Fix first instead. Mirrored in app/www/js/state.js.
WONT_PLAY_STATUSES = ("OUT", "DOUBTFUL", "INJURY_RESERVE", "SUSPENSION")


@dataclass
class Player:
    player_id: int
    name: str
    pos: str
    pro_team_id: int
    eligible: list
    proj_week: float = None
    proj_ros: float = None
    injury: str = None
    pct_started: float = None
    pct_change: float = None
    outlook: str = None
    slot: str = "BENCH"        # where the owner has him set; free agents are BENCH
    status: str = None         # free agents only: FREEAGENT / WAIVERS
    game: dict = None          # {"opp", "home", "kickoff_ms"}; None = bye
    locked: bool = False       # his game has kicked off -- ESPN won't let him move

    @property
    def espn_pts(self) -> float:
        """ESPN's projection as-is. Only the 'status and projection disagree' checks use it."""
        return self.proj_week or 0.0

    @property
    def week_pts(self) -> float:
        """Points we expect: 0 when ESPN's status says he won't play, whatever it projects
        (ESPN can leave a projection up after ruling a player out)."""
        return 0.0 if self.injury in WONT_PLAY_STATUSES else self.espn_pts

    @property
    def is_starter(self) -> bool:
        return self.slot not in ("BENCH", "IR")


@dataclass
class Team:
    id: int
    name: str
    abbrev: str
    owners: list
    wins: int
    losses: int
    ties: int
    points_for: float
    points_against: float
    roster: list = field(default_factory=list)


@dataclass
class SeasonState:
    season: int
    week: int
    slots: dict                # {"QB": 1, ..., "BENCH": 6, "IR": 2}
    teams: list
    schedule: list
    pro: dict                  # parse_pro_schedule output
    free_agents: list
    my_team_id: int
    info: dict                 # cache provenance per source

    def team(self, team_id: int) -> Team:
        return next(t for t in self.teams if t.id == team_id)

    @property
    def me(self) -> Team:
        return self.team(self.my_team_id)

    def opponent(self):
        for m in self.schedule:
            if m["period"] == self.week and self.my_team_id in (m["home"], m["away"]):
                other = m["away"] if m["home"] == self.my_team_id else m["home"]
                return self.team(other) if other is not None else None
        return None

    def pro_abbrev(self, pro_team_id) -> str:
        return (self.pro.get(pro_team_id) or {}).get("abbrev") or "FA"


def find_my_team_id(teams: list, swid: str):
    """ESPN stores owners as the same braced GUID as the SWID cookie (confirmed in the
    week-3 fixture). Case-insensitive in case ESPN ever changes the casing."""
    want = (swid or "").strip().lower()
    for t in teams:
        if want and want in (o.lower() for o in t["owners"]):
            return t["id"]
    return None


def build_state(raw: dict, swid: str, now_ms: float = None) -> SeasonState:
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    lg = sources.parse_league(raw["league"])
    pro = sources.parse_pro_schedule(raw["pro_schedule"])
    week = lg["week"]

    def player(row: dict) -> Player:
        game = (pro.get(row["pro_team_id"]) or {}).get("games", {}).get(week)
        locked = bool(game and game.get("kickoff_ms") and game["kickoff_ms"] <= now_ms)
        return Player(**{k: row.get(k) for k in (
            "player_id", "name", "pos", "pro_team_id", "eligible", "proj_week", "proj_ros",
            "injury", "pct_started", "pct_change", "outlook")},
            slot=row.get("slot", "BENCH"), status=row.get("status"),
            game=game, locked=locked)

    teams = [Team(**{k: t[k] for k in ("id", "name", "abbrev", "owners", "wins", "losses",
                                       "ties", "points_for", "points_against")},
                  roster=[player(r) for r in t["roster"]])
             for t in lg["teams"]]
    fas = [player(r) for r in sources.parse_free_agents(raw["free_agents"], lg["season"], week)
           if r["pos"]]
    my_id = find_my_team_id(lg["teams"], swid)
    if my_id is None:
        raise ValueError("None of this league's teams is owned by the SWID in config.json.")
    return SeasonState(season=lg["season"], week=week, slots=lg["slots"], teams=teams,
                       schedule=lg["schedule"], pro=pro, free_agents=fas,
                       my_team_id=my_id, info=raw.get("info", {}))
