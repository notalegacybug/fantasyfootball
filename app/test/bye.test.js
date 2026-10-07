// Bye weeks: the bye shown on each player, the "Bye weeks ahead" warning, and the
// Stash list of free agents who are on bye now but worth holding.
//
//     cd app && node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildState } from "../www/js/state.js";
import { pageJson } from "../www/js/report.js";
import { byeCrunch, stashTargets, STASH_MIN_ROS_GAIN, BYE_LOOKAHEAD } from "../www/js/season.js";

const fix = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const raw = {
  league: fix("espn_league.json"),
  free_agents: fix("espn_free_agents.json"),
  pro_schedule: fix("espn_pro_schedule.json"),
};
const MY_SWID = "{00000000-0000-0000-0000-000000000001}";

let nextId = 1;
const P = (pos, bye, o = {}) => ({
  player_id: nextId++, name: o.name || `${pos}${nextId}`, pos, eligible: ["RB", "WR", "TE"].includes(pos) ? [pos, "FLEX", "BENCH"] : [pos, "BENCH"],
  proj_week: o.proj_week ?? 10, proj_ros: o.proj_ros ?? 100, injury: o.injury ?? null,
  slot: o.slot || "BENCH", status: null, game: o.game === undefined ? { opp: 1 } : o.game,
  locked: false, bye,
});
const SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1, BENCH: 6, IR: 1 };
// A full roster where nobody shares a bye: no warnings expected.
function roster() {
  return [P("QB", 5), P("QB", 6), P("RB", 7), P("RB", 8),
          P("RB", 9), P("WR", 10), P("WR", 11),
          P("WR", 12), P("TE", 13), P("DST", 14), P("K", 5), P("K", 6)];
}

test("no warning when every starting spot can be filled each week", () => {
  assert.deepEqual(byeCrunch(roster(), SLOTS, 4), []);
});

test("warns when byes leave a dedicated slot short, naming who is on bye", () => {
  const r = roster();
  r.find(p => p.pos === "RB" && p.bye === 8).bye = 7;      // two RBs now share week 7
  const w = byeCrunch(r, SLOTS, 4);
  assert.equal(w.length, 1);
  assert.equal(w[0].week, 7);
  assert.deepEqual(w[0].short.map(s => [s.slot, s.have, s.need]), [["RB", 1, 2]]);
  assert.equal(w[0].on_bye.filter(p => p.pos === "RB").length, 2);
});

test("only the next BYE_LOOKAHEAD weeks are checked", () => {
  const r = roster();
  r.find(p => p.pos === "TE").bye = 4 + BYE_LOOKAHEAD + 1;  // only TE, bye past the window
  assert.deepEqual(byeCrunch(r, SLOTS, 4), []);
  r.find(p => p.pos === "TE").bye = 4 + BYE_LOOKAHEAD;      // last week inside it
  assert.equal(byeCrunch(r, SLOTS, 4)[0].week, 4 + BYE_LOOKAHEAD);
});

test("this week's bye is Fix first's job, not this warning", () => {
  const r = roster();
  r.find(p => p.pos === "TE").bye = 4;
  assert.deepEqual(byeCrunch(r, SLOTS, 4), []);
});

test("FLEX shortage: dedicated spots filled but nobody left for FLEX", () => {
  const r = roster();
  r.find(p => p.pos === "WR" && p.bye === 10).bye = 7;     // RB1 and WR1 both off in week 7
  const w = byeCrunch(r, SLOTS, 4);
  assert.equal(w.length, 1);
  assert.equal(w[0].week, 7);
  assert.deepEqual(w[0].short.map(s => [s.slot, s.have, s.need]), [["FLEX", 0, 1]]);
});

test("players in IR don't count as available", () => {
  const r = roster();
  r.find(p => p.pos === "QB" && p.bye === 6).slot = "IR";
  const w = byeCrunch(r, SLOTS, 4);                        // QB1 bye week 5, backup in IR
  assert.deepEqual(w.map(x => [x.week, x.short[0].slot]), [[5, "QB"]]);
});

test("stash: a free agent on bye now, much better rest-of-season than the drop", () => {
  const r = roster().concat([P("WR", 9, { proj_ros: 20, proj_week: 1 })]);
  r.push(P("RB", 9, { proj_ros: 30, proj_week: 1 }));
  const slots = { ...SLOTS, BENCH: r.length - 9 };                     // roster is full
  const good = P("WR", 4, { proj_ros: 20 + STASH_MIN_ROS_GAIN + 5, proj_week: 0, game: null });
  const meh = P("WR", 4, { proj_ros: 20 + STASH_MIN_ROS_GAIN - 1, proj_week: 0, game: null });
  const playing = P("WR", 9, { proj_ros: 300 });     // has a game: Pickups' job
  const out = stashTargets(r, [meh, good, playing], slots);
  assert.deepEqual(out.map(x => x.add.player_id), [good.player_id]);
  assert.equal(out[0].drop.proj_ros, 20);
});

test("stash skips free agents ESPN says won't play", () => {
  const fa = P("WR", 4, { proj_ros: 500, game: null, injury: "OUT" });
  assert.deepEqual(stashTargets(roster(), [fa], SLOTS), []);
});

test("stash never suggests a kicker or defense (they're streamed weekly)", () => {
  const k = P("K", 4, { proj_ros: 500, game: null });
  const dst = P("DST", 4, { proj_ros: 500, game: null });
  assert.deepEqual(stashTargets(roster(), [k, dst], SLOTS), []);
});

test("the page carries each player's bye week from the NFL schedule", () => {
  const page = pageJson(buildState(raw, { swid: MY_SWID, nowMs: 0 }));
  const sched = raw.pro_schedule.settings.proTeams;
  for (const p of page.starters) {
    const t = sched.find(t => t.abbrev === p.team);
    assert.equal(p.bye, t ? t.byeWeek : null, `${p.name} (${p.team})`);
  }
  assert.ok(Array.isArray(page.bye_crunch));
  assert.ok(Array.isArray(page.stash));
});
