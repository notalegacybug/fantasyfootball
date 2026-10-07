// weeklyReport -> the JSON the This-week screen renders. week.test.js compares it, field
// for field, against the answer key in app/test/expected_week.json.

import { weeklyReport, round1, CLOSE_CALL_MARGIN, BYE_LOOKAHEAD } from "./season.js";
import { weekPts } from "./state.js";

function playerJson(st, p) {
  const g = p.game;
  return {
    id: p.player_id, name: p.name, pos: p.pos, team: st.proAbbrev(p.pro_team_id),
    slot: p.slot, proj: round1(weekPts(p)), ros: round1(p.proj_ros || 0),
    injury: p.injury, started_pct: p.pct_started, owned_change: p.pct_change,
    status: p.status, locked: p.locked, outlook: p.outlook, bye: p.bye,
    game: g === null ? null : { opp: st.proAbbrev(g.opp), home: g.home, kickoff_ms: g.kickoff_ms },
  };
}

const teamJson = t => (t ? { id: t.id, name: t.name, wins: t.wins, losses: t.losses, ties: t.ties } : null);

export function pageJson(st) {
  const r = weeklyReport(st);
  const pj = p => playerJson(st, p);
  return {
    week: r.week, me: teamJson(r.me), opponent: teamJson(r.opponent),
    current_total: round1(r.current_total),
    optimal_total: round1(r.optimal_total),
    opponent_total: r.opponent_total === null ? null : round1(r.opponent_total),
    problems: r.problems.map(x => ({ player: pj(x.player), kind: x.kind, message: x.message })),
    ir_moves: r.ir_moves.map(m => ({ player: pj(m.player), from: m.from, to: m.to, reason: m.reason })),
    deltas: r.deltas.map(d => ({ slot: d.slot, out: pj(d.out), in: pj(d.in), gain: round1(d.gain) })),
    close_calls: r.close_calls.map(c => ({ slot: c.slot, starter: pj(c.starter), alt: pj(c.alt),
                                          margin: round1(c.margin) })),
    pickups: r.pickups.map(w => ({ add: pj(w.add), drop: w.drop ? pj(w.drop) : null,
                                   gain: round1(w.gain), ros_delta: round1(w.ros_delta) })),
    stash: r.stash.map(w => ({ add: pj(w.add), drop: w.drop ? pj(w.drop) : null,
                               ros_delta: round1(w.ros_delta) })),
    bye_crunch: r.bye_crunch.map(c => ({ week: c.week, short: c.short, on_bye: c.on_bye.map(pj) })),
    starters: r.starters.map(([s, p]) => ({ ...pj(p), slot: s })),   // lineup slot wins over current
    constants: { close_call_margin: CLOSE_CALL_MARGIN, bye_lookahead: BYE_LOOKAHEAD },
  };
}
