"""
The part that produces an edge.

FantasyPros gives you consensus rank. Rank does not tell you who to draft, because
it ignores your league's replacement level. In a 10-team league RB25 still starts
somewhere; in a 12-team league it doesn't. Same player, different value.

So: compute value over replacement from the league's real roster slots, recompute
replacement level after every pick as the pool drains, and report the expected cost
of waiting until your next turn.
"""

import math
from dataclasses import dataclass, field

# How flex slots get consumed in practice. Not a law of nature -- it's an assumption,
# and it moves replacement level, so it's exposed as a knob rather than buried.
FLEX_SHARE = {"RB": 0.45, "WR": 0.45, "TE": 0.10}
SUPERFLEX_SHARE = {"QB": 0.85, "RB": 0.05, "WR": 0.05, "TE": 0.05}

STARTABLE = ["QB", "RB", "WR", "TE", "K", "DST"]


@dataclass
class DraftState:
    teams: int = 10
    my_slot: int = 1                      # 1-indexed draft position
    rounds: int = 15
    drafted: dict = field(default_factory=dict)   # fpid -> "me" | "other"

    @property
    def pick_number(self) -> int:
        return len(self.drafted) + 1       # 1-indexed overall pick on the clock

    def slot_on_clock(self, overall: int) -> int:
        rnd = (overall - 1) // self.teams
        idx = (overall - 1) % self.teams
        return idx + 1 if rnd % 2 == 0 else self.teams - idx

    def my_next_pick(self, after: int = None) -> int:
        n = after or self.pick_number
        while n <= self.teams * self.rounds:
            if self.slot_on_clock(n) == self.my_slot:
                return n
            n += 1
        return -1

    def picks_until_my_turn(self) -> int:
        nxt = self.my_next_pick()
        return max(0, nxt - self.pick_number) if nxt > 0 else 0

    def picks_between_my_turns(self) -> int:
        """Players who come off the board between my current pick and my next one.
        Pick distance minus one: from #4 to #17 is 13 apart but only 12 players go."""
        cur = self.my_next_pick()
        if cur < 0:
            return 0
        nxt = self.my_next_pick(cur + 1)
        return max(0, nxt - cur - 1) if nxt > 0 else 0

    def on_the_clock_is_me(self) -> bool:
        return self.slot_on_clock(self.pick_number) == self.my_slot

    def lookahead(self) -> int:
        """Players who get taken before my next decision. If I'm on the clock that
        means the gap to my following turn; otherwise it's the wait to get up."""
        if self.on_the_clock_is_me():
            return self.picks_between_my_turns()
        nxt = self.my_next_pick()
        return max(0, nxt - self.pick_number) if nxt > 0 else 0


def replacement_ranks(fmt) -> dict:
    """Number of players at each position the league will start. That index in the
    remaining pool is 'replacement level' -- the guy you get for free."""
    slots, teams = fmt.slots, fmt.teams
    base = {p: float(slots.get(p, 0)) for p in STARTABLE}

    flex = slots.get("FLEX", 0)
    for pos, share in FLEX_SHARE.items():
        base[pos] += flex * share

    op = slots.get("OP", 0)
    for pos, share in SUPERFLEX_SHARE.items():
        base[pos] += op * share

    out = {}
    for pos in STARTABLE:
        n = int(round(base[pos] * teams))
        # One past the last starter is the true replacement.
        out[pos] = max(1, n + 1) if n > 0 else 1
    return out


class Board:
    def __init__(self, players: list, fmt, state: DraftState):
        self.fmt = fmt
        self.state = state
        self.repl_rank = replacement_ranks(fmt)
        self.players = {}
        for p in players:
            if p.get("proj_pts") is None or p["pos"] not in STARTABLE:
                continue
            self.players[p["fpid"]] = p
        self._name_index = {}
        for p in self.players.values():
            self._name_index.setdefault(p["norm"], []).append(p["fpid"])

    # -- pool ---------------------------------------------------------------

    def available(self, pos: str = None) -> list:
        out = [p for fpid, p in self.players.items()
               if fpid not in self.state.drafted and (pos is None or p["pos"] == pos)]
        out.sort(key=lambda p: -p["proj_pts"])
        return out

    def replacement_points(self, pos: str) -> float:
        pool = self.available(pos)
        if not pool:
            return 0.0
        idx = min(self.repl_rank.get(pos, 1) - 1, len(pool) - 1)
        return pool[idx]["proj_pts"]

    def vor_board(self, pos: str = None, limit: int = 60) -> list:
        repl = {p: self.replacement_points(p) for p in STARTABLE}
        rows = []
        for p in self.available(pos):
            v = p["proj_pts"] - repl[p["pos"]]
            rows.append({**p, "vor": round(v, 1)})
        rows.sort(key=lambda r: -r["vor"])
        return rows[:limit]

    # -- the number that actually decides picks ------------------------------

    def cost_of_waiting(self) -> list:
        """If I take a different position now, what do I give up at this one by the
        time it's my turn again? This is the tier-cliff question, quantified."""
        gap = self.state.lookahead()
        out = []
        for pos in ["QB", "RB", "WR", "TE"]:
            pool = self.available(pos)
            if not pool:
                continue
            best = pool[0]
            # Assume roughly proportional attrition at this position over the gap.
            share = self._expected_taken(pos, gap)
            idx = min(share, len(pool) - 1)
            later = pool[idx]
            out.append({
                "pos": pos,
                "best_now": best["name"],
                "best_now_pts": round(best["proj_pts"], 1),
                "likely_later": later["name"],
                "likely_later_pts": round(later["proj_pts"], 1),
                "cost": round(best["proj_pts"] - later["proj_pts"], 1),
                "tier_breaks": self._tier_break_in(pool, idx),
            })
        out.sort(key=lambda r: -r["cost"])
        return out

    def _expected_taken(self, pos: str, gap: int) -> int:
        """Crude but honest: positions get taken roughly in proportion to how much of
        the top of the remaining board they occupy."""
        if gap <= 0:
            return 0
        top = self.vor_board(limit=max(gap * 2, 20))
        if not top:
            return 0
        frac = sum(1 for r in top if r["pos"] == pos) / len(top)
        return max(1, int(round(gap * frac)))

    def _tier_break_in(self, pool: list, idx: int) -> bool:
        if not pool or idx <= 0:
            return False
        t0 = pool[0].get("tier")
        t1 = pool[min(idx, len(pool) - 1)].get("tier")
        return t0 is not None and t1 is not None and t1 > t0

    # -- market signal --------------------------------------------------------

    def recent_run(self, n: int = 6) -> dict:
        """Position breakdown of the last n picks (across the whole draft, not just
        mine). A position is 'running' once it's eaten up a big share of recent
        turns -- that's the signal that a tier is about to get thin fast."""
        picks = list(self.state.drafted.items())[-n:]
        window = len(picks)
        if window == 0:
            return {"window": 0, "positions": []}
        counts = {}
        for fpid, _who in picks:
            p = self.players.get(fpid)
            if not p:
                continue
            counts[p["pos"]] = counts.get(p["pos"], 0) + 1
        rows = [{"pos": pos, "count": c, "of": window, "share": round(c / window, 2)}
                for pos, c in counts.items()]
        rows.sort(key=lambda r: -r["count"])
        for r in rows:
            r["run"] = r["share"] >= 0.4 and r["count"] >= 2
        return {"window": window, "positions": rows}

    # -- roster needs --------------------------------------------------------

    def my_roster(self) -> list:
        return [self.players[f] for f, who in self.state.drafted.items()
                if who == "me" and f in self.players]

    def needs(self) -> dict:
        have = {}
        for p in self.my_roster():
            have[p["pos"]] = have.get(p["pos"], 0) + 1
        need = {}
        for pos in STARTABLE:
            req = self.fmt.slots.get(pos, 0)
            need[pos] = max(0, req - have.get(pos, 0))
        flex_have = sum(max(0, have.get(p, 0) - self.fmt.slots.get(p, 0))
                        for p in ("RB", "WR", "TE"))
        need["FLEX"] = max(0, self.fmt.slots.get("FLEX", 0) - flex_have)
        return need

    # QUESTIONABLE/DOUBTFUL are soft, game-week designations -- checked against real
    # 2026 injury news, ESPN's snapshot of these lagged camp reports and would have
    # hidden players (e.g. Ja'Marr Chase) with no actual current injury concern. Only
    # the hard, factual statuses are worth excluding outright; the rest are surfaced
    # as a visible flag instead so you can judge for yourself.
    NOT_HEALTHY = {"OUT", "INJURY_RESERVE", "SUSPENSION"}

    def _healthy(self, p: dict) -> bool:
        """Unknown status counts as healthy -- absence of data isn't evidence of
        injury. Only a hard, factual status excludes a player from being pushed as
        a recommendation. They're still fully visible in search/board browsing."""
        return p.get("injury_status") not in self.NOT_HEALTHY

    def recommend(self, n: int = 5) -> list:
        """VOR, nudged by unfilled starting slots. Deliberately a small nudge --
        drafting for need over value is how people end up with a bad team."""
        need = self.needs()
        rows = [r for r in self.vor_board(limit=80) if self._healthy(r)]
        for r in rows:
            bonus = 0.0
            if need.get(r["pos"], 0) > 0:
                bonus += 8.0
            elif r["pos"] in ("RB", "WR", "TE") and need.get("FLEX", 0) > 0:
                bonus += 4.0
            if r["pos"] in ("K", "DST") and self.state.pick_number < self.teams_x(0.8):
                bonus -= 60.0          # never take a kicker early, whatever VOR says
            r["score"] = round(r["vor"] + bonus, 1)
        rows.sort(key=lambda r: -r["score"])
        return rows[:n]

    def best_by_category(self) -> list:
        """One line per position: who's best available right now, health-filtered
        the same way recommend() is. The thing to glance at with no time to think."""
        out = []
        for pos in STARTABLE:
            healthy = [p for p in self.vor_board(pos=pos, limit=50) if self._healthy(p)]
            if healthy:
                out.append(healthy[0])
        return out

    def sleepers(self, n: int = 5, min_gap: int = 24) -> list:
        """Players whose value rank (VOR, across all available players) beats their
        ADP rank by a wide margin -- the market is sleeping on them relative to what
        they're actually projected to produce. min_gap is in overall-rank spots;
        24 is roughly two and a half rounds in a 10-team league.

        K/DST excluded: everyone punts those positions by convention regardless of
        value, so a late ADP there isn't an inefficiency worth reaching for. vor > 0
        required: below replacement level, both ADP and rank are noise among
        throwaway players -- comparing them produces "gaps" that mean nothing.
        Injured/questionable players excluded -- see _healthy()."""
        pool = [p for p in self.vor_board(limit=10_000)
                if p.get("ecr") and p["pos"] not in ("K", "DST") and p["vor"] > 0
                and self._healthy(p)]
        rows = []
        for value_rank, p in enumerate(pool, start=1):
            adp_rank = round(p["ecr"])
            gap = adp_rank - value_rank
            if gap >= min_gap:
                rows.append({
                    **p,
                    "value_rank": value_rank,
                    "adp_rank": adp_rank,
                    "gap": gap,
                    "adp_round": math.ceil(adp_rank / self.state.teams),
                    "value_round": math.ceil(value_rank / self.state.teams),
                })
        rows.sort(key=lambda r: -r["gap"])
        return rows[:n]

    def teams_x(self, frac: float) -> int:
        return int(self.state.teams * self.state.rounds * frac)

    # -- name lookup ---------------------------------------------------------

    def search(self, q: str, limit: int = 8) -> list:
        from sources import normalize_name
        nq = normalize_name(q)
        if not nq:
            return []
        exact, prefix, contains = [], [], []
        for p in self.players.values():
            if p["fpid"] in self.state.drafted:
                continue
            n = p["norm"]
            if n == nq:
                exact.append(p)
            elif n.startswith(nq):
                prefix.append(p)
            elif nq in n:
                contains.append(p)
        pool = exact + prefix + contains
        pool.sort(key=lambda p: (p["fpid"] not in {x["fpid"] for x in exact},
                                 p.get("ecr") or 9999))
        return pool[:limit]
