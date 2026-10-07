// In-season decision math. app/test/week.test.js pins its answers on the recorded fixtures.
// Pure functions over player objects: no network, no ESPN field names, no dates.

import { weekPts, espnPts, isStarter, WONT_PLAY_STATUSES } from "./state.js";

// Constants to argue with (spec section 6).
export const CLOSE_CALL_MARGIN = 2.5;
export const WAIVER_SHORTLIST = 5;
export const LOW_PROJECTION_FLAG = 3.0;
export const IR_ELIGIBLE_STATUSES = ["INJURY_RESERVE", "OUT"];
// Bye weeks.
export const BYE_LOOKAHEAD = 4;          // weeks ahead the bye warning checks
export const STASH_MIN_ROS_GAIN = 10.0;  // rest-of-season points a stash must beat the drop by
export const STASH_SHORTLIST = 3;
const STREAMED = new Set(["K", "DST"]);

const DEDICATED = ["QB", "RB", "WR", "TE", "DST", "K"];
// Filled after the dedicated slots, narrowest first.
const FLEX_ACCEPTS = [["FLEX", new Set(["RB", "WR", "TE"])], ["OP", new Set(["QB", "RB", "WR", "TE"])]];
const KNOWN_SLOTS = new Set([...DEDICATED, "FLEX", "OP", "BENCH", "IR"]);
const SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "OP", "DST", "K"];
const MAX_MULTI_POSITION = 6;

// Round half to even (the original Python version's round()). Kept so recorded answers
// don't shift: JS's toFixed rounds ties up, turning "projected 2.2" into "2.3" on x.x5.
export function round1(x) {
  const y = x * 10, f = Math.floor(y);
  const n = y - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(y);
  return n / 10;
}
export const fmt1 = x => round1(x).toFixed(1);

const sum = xs => xs.reduce((a, b) => a + b, 0);
// On ties these keep the FIRST of equal elements (stable answers).
const minBy = (xs, key) => xs.reduce((best, x) => (best === undefined || key(x) < key(best) ? x : best), undefined);
const maxBy = (xs, key) => xs.reduce((best, x) => (best === undefined || key(x) > key(best) ? x : best), undefined);
// Lexicographic compare of key tuples.
function cmpTuple(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}
const sortBy = (xs, key) => [...xs].sort((a, b) => cmpTuple(key(a), key(b)));   // stable

// --------------------------------------------------------------------------
// Lineup
// --------------------------------------------------------------------------

const positions = p => DEDICATED.filter(s => p.eligible.includes(s));
const rankKey = p => [-weekPts(p), -(p.proj_ros || 0), p.name];

// Top projected player per dedicated slot, then flex slots from what's left. EXACT under
// nested flex slots -- see season._greedy for the argument.
function greedy(pool, openSlots, primary) {
  const ranked = sortBy(pool, rankKey);
  const used = new Set(), lineup = [];
  for (const pos of DEDICATED) {
    for (let i = 0; i < (openSlots[pos] || 0); i++) {
      const p = ranked.find(p => !used.has(p.player_id) && primary.get(p.player_id) === pos);
      if (p) { used.add(p.player_id); lineup.push([pos, p]); }
    }
  }
  for (const [flex, accepts] of FLEX_ACCEPTS) {
    for (let i = 0; i < (openSlots[flex] || 0); i++) {
      const p = ranked.find(p => !used.has(p.player_id) && p.eligible.includes(flex)
                                 && accepts.has(primary.get(p.player_id)));
      if (p) { used.add(p.player_id); lineup.push([flex, p]); }
    }
  }
  return lineup;
}

function* product(lists) {
  if (!lists.length) { yield []; return; }
  const [head, ...rest] = lists;
  for (const h of head) for (const r of product(rest)) yield [h, ...r];
}

// Optimal legal lineup as [[slot, player]]. Locked starters keep their slot; locked
// non-starters can't come in.
export function bestLineup(players, slots) {
  const unknown = Object.keys(slots).filter(s => !KNOWN_SLOTS.has(s));
  if (unknown.length) throw new Error(`Unsupported lineup slots ${unknown.join(", ")}.`);
  const fixed = players.filter(p => p.locked && isStarter(p)).map(p => [p.slot, p]);
  const openSlots = { ...slots };
  for (const [s] of fixed) openSlots[s] = (openSlots[s] || 0) - 1;
  const pool = players.filter(p => !p.locked && positions(p).length);

  const multi = pool.filter(p => positions(p).length > 1);
  if (multi.length > MAX_MULTI_POSITION) throw new Error(`${multi.length} multi-position players.`);
  const single = new Map(pool.filter(p => positions(p).length === 1)
    .map(p => [p.player_id, positions(p)[0]]));
  let best = null;
  for (const choice of product(multi.map(positions))) {
    const primary = new Map(single);
    multi.forEach((p, i) => primary.set(p.player_id, choice[i]));
    const lu = greedy(pool, openSlots, primary);
    if (best === null || lineupTotal(lu) > lineupTotal(best)) best = lu;
  }
  return sortBy([...fixed, ...(best || [])], ([s, p]) => [SLOT_ORDER.indexOf(s), -weekPts(p)]);
}

export const lineupTotal = lineup => sum(lineup.map(([, p]) => weekPts(p)));
export const currentTotal = players => sum(players.filter(isStarter).map(weekPts));

// Swaps from what's set now to optimal: [{slot, out, in, gain}], biggest gain first.
export function lineupDeltas(players, lineup) {
  const optIds = new Set(lineup.map(([, p]) => p.player_id));
  const curIds = new Set(players.filter(isStarter).map(p => p.player_id));
  const outs = players.filter(p => isStarter(p) && !optIds.has(p.player_id));
  const deltas = [];
  for (const [slot, pin] of lineup) {
    if (curIds.has(pin.player_id) || !outs.length) continue;
    const pout = outs.find(o => o.slot === slot)
      ?? outs.find(o => pin.eligible.includes(o.slot)) ?? outs[0];
    outs.splice(outs.indexOf(pout), 1);
    deltas.push({ slot, out: pout, in: pin, gain: weekPts(pin) - weekPts(pout) });
  }
  return sortBy(deltas, d => [-d.gain]);
}

// Per slot, the weakest optimal starter vs the best benched player who could take it.
export function closeCalls(players, lineup, margin = CLOSE_CALL_MARGIN) {
  const optIds = new Set(lineup.map(([, p]) => p.player_id));
  const bench = players.filter(p => !optIds.has(p.player_id) && !p.locked && weekPts(p) > 0);
  const out = [];
  for (const slot of new Set(lineup.map(([s]) => s))) {
    const starters = lineup.filter(([s, p]) => s === slot && !p.locked).map(([, p]) => p);
    if (!starters.length) continue;
    const weakest = minBy(starters, weekPts);
    const alts = bench.filter(p => p.eligible.includes(slot));
    if (!alts.length) continue;
    const alt = maxBy(alts, weekPts);
    const m = weekPts(weakest) - weekPts(alt);
    if (m >= 0 && m < margin) out.push({ slot, starter: weakest, alt, margin: m });
  }
  return out;
}

// --------------------------------------------------------------------------
// Roster health
// --------------------------------------------------------------------------

const irEligible = p => IR_ELIGIBLE_STATUSES.includes(p.injury);
const injuryText = s => s.replaceAll("_", " ").toLowerCase();

// Healthy players leave IR first (ESPN can freeze transactions while one sits there),
// then injured players fill the free IR spots.
export function irMoves(players, slots) {
  const inIr = players.filter(p => p.slot === "IR");
  const moves = inIr.filter(p => !irEligible(p) && !p.locked).map(p => ({
    player: p, from: "IR", to: "BENCH",
    reason: "healthy -- ESPN can block adds while he's in IR" }));
  const free = (slots.IR || 0) - (inIr.length - moves.length);
  const cands = sortBy(players.filter(p => p.slot !== "IR" && irEligible(p)
                                       && espnPts(p) < LOW_PROJECTION_FLAG && !p.locked),
                       p => [p.injury !== "INJURY_RESERVE" ? 1 : 0, espnPts(p)]);
  for (const p of cands.slice(0, Math.max(free, 0))) {
    moves.push({ player: p, from: p.slot, to: "IR",
                 reason: `${injuryText(p.injury)} -- frees a roster spot` });
  }
  return moves;
}

export function applyIrMoves(players, moves) {
  const to = new Map(moves.map(m => [m.player.player_id, m.to]));
  return players.map(p => (to.has(p.player_id) ? { ...p, slot: to.get(p.player_id) } : p));
}

export function problems(players, lineup) {
  const starters = new Map(players.filter(isStarter).map(p => [p.player_id, p]));
  for (const [, p] of lineup) starters.set(p.player_id, p);
  const out = [];
  for (const p of starters.values()) {
    if (p.game === null) {
      out.push({ player: p, kind: "bye", message: "on bye this week" });
    } else if (p.injury === "INJURY_RESERVE" && espnPts(p) >= LOW_PROJECTION_FLAG) {
      out.push({ player: p, kind: "conflict",
                 message: `marked IR but projected ${fmt1(espnPts(p))} -- check he's playing` });
    } else if (p.injury !== null && p.injury !== "ACTIVE") {
      out.push({ player: p, kind: "injury", message: injuryText(p.injury) });
    } else if (weekPts(p) < LOW_PROJECTION_FLAG) {
      out.push({ player: p, kind: "low", message: `projected ${fmt1(weekPts(p))}` });
    }
  }
  for (const p of players) {
    if (p.slot === "IR" && !irEligible(p)) {
      out.push({ player: p, kind: "ir_healthy",
                 message: "healthy but in IR -- ESPN can block adds until he moves" });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Waivers
// --------------------------------------------------------------------------

export const rosterLimit = slots => sum(Object.entries(slots).filter(([k]) => k !== "IR").map(([, v]) => v));

// Value of a free agent = how much he raises this week's optimal total. The drop is the
// benched player with the lowest REST-OF-SEASON projection, never weekly.
// The player a pickup would replace: null when there's an open roster spot, undefined
// when the roster is full and nobody can be cut.
function dropFor(players, slots, baseLu) {
  const active = players.filter(p => p.slot !== "IR");
  if (active.length < rosterLimit(slots)) return null;
  const inLu = new Set(baseLu.map(([, p]) => p.player_id));
  // Never cut a player whose ESPN status and projection disagree (e.g. IR but
  // projected 19.8): problems() already asks the user to check him.
  const droppable = active.filter(p => !inLu.has(p.player_id) && !p.locked
                                       && !(weekPts(p) === 0 && espnPts(p) >= LOW_PROJECTION_FLAG));
  return droppable.reduce((best, p) => (best === undefined
    || cmpTuple([p.proj_ros || 0, weekPts(p)], [best.proj_ros || 0, weekPts(best)]) < 0 ? p : best), undefined);
}

export function waiverTargets(players, freeAgents, slots, n = WAIVER_SHORTLIST) {
  const baseLu = bestLineup(players, slots);
  const base = lineupTotal(baseLu);
  const drop = dropFor(players, slots, baseLu);
  if (drop === undefined) return [];
  const out = [];
  for (const fa of freeAgents) {
    const roster = [...players.filter(p => p !== drop), { ...fa, slot: "BENCH" }];
    const gain = lineupTotal(bestLineup(roster, slots)) - base;
    if (gain > 1e-9) {
      out.push({ add: fa, drop, gain,
                 ros_delta: (fa.proj_ros || 0) - (drop ? (drop.proj_ros || 0) : 0) });
    }
  }
  return sortBy(out, x => [-x.gain]).slice(0, n);
}

// Free agents on bye THIS week score 0 in waiverTargets, so a good one never shows there.
// Judge them on rest-of-season instead, against the same drop. Kept as a separate list
// because "+6 this week" and "+40 over the season" aren't the same scale.
export function stashTargets(players, freeAgents, slots, n = STASH_SHORTLIST) {
  const drop = dropFor(players, slots, bestLineup(players, slots));
  if (drop === undefined) return [];
  const out = [];
  for (const fa of freeAgents) {
    // K and DST are streamed week to week; holding one through his bye wastes a bench spot.
    if (fa.game !== null || WONT_PLAY_STATUSES.includes(fa.injury) || STREAMED.has(fa.pos)) continue;
    const ros_delta = (fa.proj_ros || 0) - (drop ? (drop.proj_ros || 0) : 0);
    if (ros_delta >= STASH_MIN_ROS_GAIN) out.push({ add: fa, drop, ros_delta });
  }
  return sortBy(out, x => [-x.ros_delta]).slice(0, n);
}

// --------------------------------------------------------------------------
// Bye weeks ahead
// --------------------------------------------------------------------------

// For each of the next BYE_LOOKAHEAD weeks: can the players who AREN'T on bye still fill
// every starting slot? Counted by position, dedicated slots first, then FLEX/OP from the
// leftovers -- the same order bestLineup fills them. This week is problems()' job.
export function byeCrunch(players, slots, week, horizon = BYE_LOOKAHEAD) {
  const roster = players.filter(p => p.slot !== "IR");
  const out = [];
  for (let w = week + 1; w <= week + horizon; w++) {
    const left = {};
    for (const p of roster) if (p.bye !== w) left[p.pos] = (left[p.pos] || 0) + 1;
    const short = [];
    for (const pos of DEDICATED) {
      const need = slots[pos] || 0, have = left[pos] || 0;
      if (have < need) short.push({ slot: pos, have, need });
      left[pos] = Math.max(have - need, 0);
    }
    for (const [flex, accepts] of FLEX_ACCEPTS) {
      const need = slots[flex] || 0;
      if (!need) continue;
      let have = 0;
      for (const pos of accepts) {
        const take = Math.min(left[pos] || 0, need - have);
        have += take;
        left[pos] = (left[pos] || 0) - take;
      }
      if (have < need) short.push({ slot: flex, have, need });
    }
    if (short.length) out.push({ week: w, short, on_bye: roster.filter(p => p.bye === w) });
  }
  return out;
}

// --------------------------------------------------------------------------
// The weekly answer
// --------------------------------------------------------------------------

// IR moves are applied before lineup and waivers: they change the roster limit math.
export function weeklyReport(state) {
  const roster = state.me.roster;
  const irm = irMoves(roster, state.slots);
  const afterIr = applyIrMoves(roster, irm);
  const lu = bestLineup(afterIr, state.slots);
  const opp = state.opponent();
  return {
    week: state.week, me: state.me, opponent: opp,
    current_total: currentTotal(roster),
    optimal_total: lineupTotal(lu),
    opponent_total: opp ? currentTotal(opp.roster) : null,
    problems: problems(roster, lu),
    ir_moves: irm,
    deltas: lineupDeltas(afterIr, lu),
    close_calls: closeCalls(afterIr, lu),
    pickups: waiverTargets(afterIr, state.freeAgents, state.slots),
    stash: stashTargets(afterIr, state.freeAgents, state.slots),
    bye_crunch: byeCrunch(afterIr, state.slots, state.week),
    starters: lu,
  };
}
