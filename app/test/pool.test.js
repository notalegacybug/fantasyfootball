// ESPN's public player pool (Yahoo-by-hand's source of predictions) parses with the same
// parser as league free agents. Fixtures: `node test/capture_pool.mjs`.
//
//     cd app && node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFreeAgents } from "../www/js/espn.js";

const fix = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const P = fix("espn_pool_ppr.json"), S = fix("espn_pool_std.json");
const ppr = parseFreeAgents(P.raw, P.season, P.week).filter(r => r.pos);
const std = parseFreeAgents(S.raw, S.season, S.week).filter(r => r.pos);

test("pool: rows carry this week's and rest-of-season predictions", () => {
  assert.ok(ppr.length >= 140, `only ${ppr.length} rows with a position`);
  assert.ok(ppr.filter(r => r.proj_week !== null).length > ppr.length * 0.6, "this week's projections missing");
  assert.ok(ppr.filter(r => r.proj_ros !== null).length > ppr.length * 0.8, "rest-of-season projections missing");
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    assert.ok(ppr.some(r => r.pos === pos), `no ${pos} in the pool`);
  }
  assert.ok(ppr.every(r => r.eligible.length > 0), "every row has eligible slots");
});

test("pool: PPR predictions beat standard for pass catchers", () => {
  const s = new Map(std.map(r => [r.player_id, r]));
  const wr = ppr.find(r => r.pos === "WR" && r.proj_ros > 0 && s.get(r.player_id)?.proj_ros > 0);
  assert.ok(wr, "a WR present in both pools");
  assert.ok(wr.proj_ros > s.get(wr.player_id).proj_ros, `${wr.name}: PPR ${wr.proj_ros} <= std`);
});
