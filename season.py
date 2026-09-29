"""
In-season decision math. Pure functions over league.Player lists: no network, no ESPN
field names, no dates. Everything here is checkable by hand.
"""

import itertools
from dataclasses import replace

# --------------------------------------------------------------------------
# Constants to argue with (spec section 6)
# --------------------------------------------------------------------------

# Below this projected margin, a start/sit decision is flagged as close. ESPN's
# projections carry a `variance` field this doesn't use yet -- see plan M2 notes.
CLOSE_CALL_MARGIN = 2.5
# How many free agents the page shows.
WAIVER_SHORTLIST = 5
# Below this, a starter is flagged as a problem.
LOW_PROJECTION_FLAG = 3.0
# Injury designations that may occupy an IR slot. ESPN's default league setting allows
# OUT and IR; a league can tighten it to IR only. Arguable -- change here if so.
IR_ELIGIBLE_STATUSES = ("INJURY_RESERVE", "OUT")

DEDICATED = ["QB", "RB", "WR", "TE", "DST", "K"]
# Filled after the dedicated slots, narrowest first.
FLEX_ACCEPTS = {"FLEX": {"RB", "WR", "TE"}, "OP": {"QB", "RB", "WR", "TE"}}
KNOWN_SLOTS = set(DEDICATED) | set(FLEX_ACCEPTS) | {"BENCH", "IR"}
MAX_MULTI_POSITION = 6      # 2^6 = 64 greedy passes; beyond that, stop and rethink


# --------------------------------------------------------------------------
# Lineup
# --------------------------------------------------------------------------

def _positions(p) -> list:
    return [s for s in DEDICATED if s in p.eligible]


def _rank_key(p):
    return (-p.week_pts, -(p.proj_ros or 0.0), p.name)


def _greedy(pool, open_slots, primary):
    """Top projected player per dedicated slot, then the flex slots from what's left.

    EXACT, not a heuristic, under one assumption: every flex slot accepts a superset
    of the positions competing for it, and each player counts for ONE dedicated
    position. Then moving a player from a dedicated slot into FLEX can never free more
    value than it costs, so sorting gives the optimum. Holds for this league
    (QB1 RB2 WR2 TE1 FLEX2 DST1 K1) and would still hold with a superflex/OP slot.
    A slot accepting an arbitrary subset ("RB or TE only") breaks it and needs real
    bipartite matching -- best_lineup() refuses unknown slot names for that reason.
    Multi-position players are handled by the caller trying each position."""
    ranked = sorted(pool, key=_rank_key)
    used, lineup = set(), []
    for pos in DEDICATED:
        for _ in range(open_slots.get(pos, 0)):
            p = next((p for p in ranked if p.player_id not in used
                      and primary.get(p.player_id) == pos), None)
            if p:
                used.add(p.player_id)
                lineup.append((pos, p))
    for flex, accepts in FLEX_ACCEPTS.items():
        for _ in range(open_slots.get(flex, 0)):
            p = next((p for p in ranked if p.player_id not in used and flex in p.eligible
                      and primary.get(p.player_id) in accepts), None)
            if p:
                used.add(p.player_id)
                lineup.append((flex, p))
    return lineup


def best_lineup(players, slots) -> list:
    """Optimal legal lineup as [(slot, Player)]. Locked starters keep their slot; locked
    non-starters can't come in (their game has started)."""
    unknown = set(slots) - KNOWN_SLOTS
    if unknown:
        raise ValueError(f"Unsupported lineup slots {unknown}: the sort-based optimizer is "
                         f"only exact for nested slots. See season._greedy.")
    fixed = [(p.slot, p) for p in players if p.locked and p.is_starter]
    open_slots = dict(slots)
    for s, _ in fixed:
        open_slots[s] = open_slots.get(s, 0) - 1
    pool = [p for p in players if not p.locked and _positions(p)]

    multi = [p for p in pool if len(_positions(p)) > 1]
    if len(multi) > MAX_MULTI_POSITION:
        raise ValueError(f"{len(multi)} multi-position players; enumeration would explode.")
    single = {p.player_id: _positions(p)[0] for p in pool if len(_positions(p)) == 1}
    best = None
    for choice in itertools.product(*[_positions(p) for p in multi]):
        primary = {**single, **{p.player_id: c for p, c in zip(multi, choice)}}
        lu = _greedy(pool, open_slots, primary)
        if best is None or lineup_total(lu) > lineup_total(best):
            best = lu
    return fixed + (best or [])


def lineup_total(lineup) -> float:
    return sum(p.week_pts for _, p in lineup)


def current_total(players) -> float:
    return sum(p.week_pts for p in players if p.is_starter)


def lineup_deltas(players, lineup) -> list:
    """Swaps from what's set now to optimal: [{slot, out, in, gain}], biggest gain first.
    Each incoming player is paired with the outgoing one from the same slot if any."""
    opt_ids = {p.player_id for _, p in lineup}
    cur_ids = {p.player_id for p in players if p.is_starter}
    outs = [p for p in players if p.is_starter and p.player_id not in opt_ids]
    deltas = []
    for slot, pin in lineup:
        if pin.player_id in cur_ids or not outs:
            continue
        pout = next((o for o in outs if o.slot == slot),
                    next((o for o in outs if o.slot in pin.eligible), outs[0]))
        outs.remove(pout)
        deltas.append({"slot": slot, "out": pout, "in": pin,
                       "gain": pin.week_pts - pout.week_pts})
    return sorted(deltas, key=lambda d: -d["gain"])


def close_calls(players, lineup, margin: float = CLOSE_CALL_MARGIN) -> list:
    """Per slot, the weakest optimal starter vs the best benched player who could take
    his slot. percentStarted is shown beside it, deliberately not folded in (spec 5.1)."""
    opt_ids = {p.player_id for _, p in lineup}
    bench = [p for p in players if p.player_id not in opt_ids and not p.locked
             and p.week_pts > 0]
    out = []
    for slot in dict.fromkeys(s for s, _ in lineup):
        starters = [p for s, p in lineup if s == slot and not p.locked]
        if not starters:
            continue
        weakest = min(starters, key=lambda p: p.week_pts)
        alts = [p for p in bench if slot in p.eligible]
        if not alts:
            continue
        alt = max(alts, key=lambda p: p.week_pts)
        m = weakest.week_pts - alt.week_pts
        if 0 <= m < margin:
            out.append({"slot": slot, "starter": weakest, "alt": alt, "margin": m})
    return out


# --------------------------------------------------------------------------
# Roster health
# --------------------------------------------------------------------------

def _ir_eligible(p) -> bool:
    return p.injury in IR_ELIGIBLE_STATUSES


def ir_moves(players, slots) -> list:
    """[{player, from, to, reason}]. Healthy players leave IR first (ESPN can freeze
    transactions while one sits there), then injured players fill the free IR spots.
    A player marked IR/OUT but still projected above LOW_PROJECTION_FLAG is NOT moved:
    ESPN's status and projection disagree, so problems() asks the user to check."""
    in_ir = [p for p in players if p.slot == "IR"]
    moves = [{"player": p, "from": "IR", "to": "BENCH",
              "reason": "healthy -- ESPN can block adds while he's in IR"}
             for p in in_ir if not _ir_eligible(p) and not p.locked]
    free = slots.get("IR", 0) - (len(in_ir) - len(moves))
    cands = sorted((p for p in players if p.slot != "IR" and _ir_eligible(p)
                    and p.week_pts < LOW_PROJECTION_FLAG and not p.locked),
                   key=lambda p: (p.injury != "INJURY_RESERVE", p.week_pts))
    for p in cands[:max(free, 0)]:
        moves.append({"player": p, "from": p.slot, "to": "IR",
                      "reason": f"{p.injury.replace('_', ' ').lower()} -- frees a roster spot"})
    return moves


def apply_ir_moves(players, moves) -> list:
    to = {m["player"].player_id: m["to"] for m in moves}
    return [replace(p, slot=to[p.player_id]) if p.player_id in to else p for p in players]


def problems(players, lineup) -> list:
    """[{player, kind, message}] for anyone starting now or in the optimal lineup,
    plus healthy players parked in IR."""
    starters = {p.player_id: p for p in players if p.is_starter}
    starters.update({p.player_id: p for _, p in lineup})
    out = []
    for p in starters.values():
        if p.game is None:
            out.append({"player": p, "kind": "bye", "message": "on bye this week"})
        elif p.injury == "INJURY_RESERVE" and p.week_pts >= LOW_PROJECTION_FLAG:
            out.append({"player": p, "kind": "conflict",
                        "message": f"marked IR but projected {p.week_pts:.1f} -- check he's playing"})
        elif p.injury not in (None, "ACTIVE"):
            out.append({"player": p, "kind": "injury",
                        "message": p.injury.replace("_", " ").lower()})
        elif p.week_pts < LOW_PROJECTION_FLAG:
            out.append({"player": p, "kind": "low", "message": f"projected {p.week_pts:.1f}"})
    for p in players:
        if p.slot == "IR" and not _ir_eligible(p):
            out.append({"player": p, "kind": "ir_healthy",
                        "message": "healthy but in IR -- ESPN can block adds until he moves"})
    return out


# --------------------------------------------------------------------------
# Waivers
# --------------------------------------------------------------------------

def roster_limit(slots) -> int:
    return sum(v for k, v in slots.items() if k != "IR")


def waiver_targets(players, free_agents, slots, n: int = WAIVER_SHORTLIST) -> list:
    """Value of a free agent = how much he raises this week's optimal total (spec 5.2).
    The drop is the benched player with the lowest REST-OF-SEASON projection -- never
    weekly, or a star on bye (0 this week) would be the first one cut."""
    base_lu = best_lineup(players, slots)
    base = lineup_total(base_lu)
    active = [p for p in players if p.slot != "IR"]
    drop = None
    if len(active) >= roster_limit(slots):
        in_lu = {p.player_id for _, p in base_lu}
        droppable = [p for p in active if p.player_id not in in_lu and not p.locked]
        drop = min(droppable, key=lambda p: (p.proj_ros or 0.0, p.week_pts), default=None)
        if drop is None:
            return []
    out = []
    for fa in free_agents:
        roster = [p for p in players if p is not drop] + [replace(fa, slot="BENCH")]
        gain = lineup_total(best_lineup(roster, slots)) - base
        if gain > 1e-9:
            out.append({"add": fa, "drop": drop, "gain": gain,
                        "ros_delta": (fa.proj_ros or 0.0) - ((drop.proj_ros or 0.0) if drop else 0.0)})
    return sorted(out, key=lambda x: -x["gain"])[:n]


# --------------------------------------------------------------------------
# The weekly answer
# --------------------------------------------------------------------------

def weekly_report(state) -> dict:
    """Everything the This-week page shows, in page order. IR moves are applied before
    lineup and waivers, because they change who counts against the roster limit."""
    roster = state.me.roster
    irm = ir_moves(roster, state.slots)
    after_ir = apply_ir_moves(roster, irm)
    lu = best_lineup(after_ir, state.slots)
    opp = state.opponent()
    return {
        "week": state.week,
        "me": state.me,
        "opponent": opp,
        "current_total": current_total(roster),
        "optimal_total": lineup_total(lu),
        "opponent_total": current_total(opp.roster) if opp else None,
        "problems": problems(roster, lu),
        "ir_moves": irm,
        "deltas": lineup_deltas(after_ir, lu),
        "close_calls": close_calls(after_ir, lu),
        "pickups": waiver_targets(after_ir, state.free_agents, state.slots),
        "starters": lu,
    }
