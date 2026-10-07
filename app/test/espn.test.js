// THE important parser test (spec 7.2): catches ESPN renumbering slots or moving stats,
// on the recorded fixtures. Refresh them with `python app.py capture-fixture`.
//
//     cd app && node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLeague, parseFreeAgents, parseProSchedule, pickStat } from "../www/js/espn.js";

const fix = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const rawLeague = fix("espn_league.json");
const lg = parseLeague(rawLeague);                 // throws on any unknown slot id
const rows = lg.teams.flatMap(t => t.roster);
const SPLIT_REST_OF_SEASON = 0, SPLIT_FULL_SEASON = 2;

test("recorded league: teams, slots and rosters parse", () => {
  assert.equal(lg.teams.length, 10);
  const want = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DST: 1, K: 1 };
  for (const [k, v] of Object.entries(want)) assert.equal(lg.slots[k], v, `${k} slots`);
  assert.ok(rows.every(r => r.pos), "every rostered player has a position");
  for (const t of lg.teams) {
    assert.ok(t.roster.filter(r => r.slot !== "BENCH" && r.slot !== "IR").length <= 10, `${t.name} starts > 10`);
  }
  assert.ok(rows.every(r => r.eligible.includes(r.slot)), "every player is eligible for his slot");
  const me = "{00000000-0000-0000-0000-000000000001}";
  assert.equal(lg.teams.filter(t => t.owners.includes(me)).length, 1, "exactly one team is mine");
});

test("recorded league: projections are where we read them", () => {
  assert.ok(rows.filter(r => r.proj_week !== null).length >= 0.8 * rows.length,
            "weekly projections for >= 80% of rostered players");
  const both = rows.filter(r => r.proj_week && r.proj_ros);
  assert.ok(both.filter(r => r.proj_ros > 3 * r.proj_week).length >= 0.9 * both.length,
            "rest-of-season dwarfs weekly (pair not swapped)");
  // The split bug: rest-of-season must be the SMALLER of the two period-0 projections
  // once games have been played.
  const season = lg.season;
  const pairs = rawLeague.teams.flatMap(t => t.roster.entries)
    .map(e => e.playerPoolEntry.player.stats)
    .map(s => [pickStat(s, season, 0, 1, SPLIT_REST_OF_SEASON), pickStat(s, season, 0, 1, SPLIT_FULL_SEASON)])
    .filter(([ros, full]) => ros && full);
  assert.ok(pairs.filter(([ros, full]) => ros < full).length >= 0.75 * pairs.length,
            "rest-of-season < full-season for most players");
});

test("recorded free agents", () => {
  const fa = parseFreeAgents(fix("espn_free_agents.json"), lg.season, lg.week);
  const rostered = new Set(rows.map(r => r.player_id));
  assert.ok(fa.length > 50, "free agents returned");
  assert.ok(!fa.some(p => rostered.has(p.player_id)), "no free agent is on a roster");
  assert.ok(fa.filter(p => p.proj_week !== null).length >= 0.5 * fa.length, "free agents carry weekly projections");
});

test("recorded NFL schedule", () => {
  const pro = parseProSchedule(fix("espn_pro_schedule.json"));
  const week = lg.week;
  assert.equal(Object.keys(pro).length, 32);
  assert.ok(Object.values(pro).every(t => t.bye), "every team has a bye week");
  assert.ok(Object.values(pro).filter(t => t.bye !== week).every(t => week in t.games),
            "every non-bye team has a week-N game");
  for (const [id, t] of Object.entries(pro)) {
    if (week in t.games) assert.equal(pro[t.games[week].opp].games[week].opp, Number(id), "opponents are symmetric");
  }
});
