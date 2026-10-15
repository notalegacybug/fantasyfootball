// Yahoo-by-hand (manual.js): the saved roster + ESPN's public pool must give the same kind
// of week page as an ESPN league. Fixtures: `node test/capture_pool.mjs`.
//
//     cd app && node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFreeAgents } from "../www/js/espn.js";
import * as manual from "../www/js/manual.js";

const fix = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const P = fix("espn_pool_ppr.json"), S = fix("espn_pool_std.json");
const { season, week } = P;
const ppr = parseFreeAgents(P.raw, season, week).filter(r => r.pos);
const std = parseFreeAgents(S.raw, season, week).filter(r => r.pos);

test("config: new configs are version 1; other versions are refused", () => {
  const cfg = manual.newConfig("L", "ppr", manual.YAHOO_DEFAULT_SLOTS);
  assert.equal(cfg.v, 1);
  assert.deepEqual(cfg.roster, []);
  assert.deepEqual(manual.readConfig(cfg), cfg);
  assert.equal(manual.readConfig({ ...cfg, v: 2 }), null);
  assert.equal(manual.readConfig(null), null);
  cfg.slots.QB = 9;
  assert.equal(manual.YAHOO_DEFAULT_SLOTS.QB, 1, "defaults are copied, not shared");
});

test("half PPR: average of PPR and standard, per player", () => {
  const half = manual.averagePools(ppr, std);
  const s = new Map(std.map(r => [r.player_id, r]));
  const r = half.find(x => s.get(x.player_id)?.proj_ros != null && x.proj_ros != null);
  const p = ppr.find(x => x.player_id === r.player_id);
  assert.ok(Math.abs(r.proj_ros - (p.proj_ros + s.get(r.player_id).proj_ros) / 2) < 1e-9);
  const oneSided = manual.averagePools([{ player_id: 1, proj_week: 4, proj_ros: null }],
                                       [{ player_id: 1, proj_week: null, proj_ros: 10 }]);
  assert.deepEqual([oneSided[0].proj_week, oneSided[0].proj_ros], [4, 10]);
});

test("poolFor: one download for PPR, two for half, rows without a position dropped", async () => {
  const asked = [];
  const fetchRows = async id => { asked.push(id); return [...(id === 3 ? ppr : std), { player_id: -1, pos: null }]; };
  const rows = await manual.poolFor(fetchRows, "ppr");
  assert.deepEqual(asked, [3]);
  assert.ok(rows.every(r => r.pos));
  asked.length = 0;
  await manual.poolFor(fetchRows, "half");
  assert.deepEqual(asked.sort(), [1, 3]);
  await assert.rejects(manual.poolFor(fetchRows, "points"), /Unknown scoring/);
});

test("search: ignores case, hyphens, dots, apostrophes and accents; skips owned players", () => {
  const rows = [
    { player_id: 1, name: "Jaxon Smith-Njigba" }, { player_id: 2, name: "Ja'Marr Chase" },
    { player_id: 3, name: "Amon-Ra St. Brown" }, { player_id: 4, name: "José Núñez" },
  ];
  const ids = q => manual.searchPool(rows, q).map(r => r.player_id);
  assert.deepEqual(ids("smith njigba"), [1]);
  assert.deepEqual(ids("JAMARR"), [2]);
  assert.deepEqual(ids("st brown"), [3]);
  assert.deepEqual(ids("nunez"), [4]);
  assert.deepEqual(ids("j"), [], "one letter is too short to search");
  assert.deepEqual(manual.searchPool(rows, "ja", new Set([1])).map(r => r.player_id), [2]);
});

import { pageJson } from "../www/js/report.js";

const healthy = r => !r.injury || r.injury === "ACTIVE";
const byPos = pos => ppr.filter(r => r.pos === pos && healthy(r));

// A legal, healthy Yahoo roster from the fixture: 15 players for 16 spots.
function sampleConfig() {
  const cfg = manual.newConfig("Test league", "ppr", manual.YAHOO_DEFAULT_SLOTS);
  cfg.roster = [...byPos("QB").slice(0, 2), ...byPos("RB").slice(0, 4), ...byPos("WR").slice(0, 5),
                ...byPos("TE").slice(0, 2), ...byPos("K").slice(0, 1), ...byPos("DST").slice(0, 1)]
    .map(manual.rosterEntry);
  return cfg;
}
const build = (cfg, pro = {}, nowMs = Date.now()) =>
  manual.buildManualState(cfg, ppr, pro, { season, week, nowMs });

test("manual state: everyone placed in the best lineup, so no lineup changes", () => {
  const page = pageJson(build(sampleConfig()));
  assert.deepEqual(page.deltas, []);
  assert.equal(page.starters.length, 10, "QB, 3 WR, 2 RB, TE, W/R/T, K, DEF all filled");
  assert.equal(page.current_total, page.optimal_total);
  assert.equal(page.opponent, null);
});

test("manual state: free agents exclude my roster and players marked taken", () => {
  const cfg = sampleConfig();
  const mine = new Set(cfg.roster.map(e => e.id));
  const other = ppr.find(r => !mine.has(r.player_id));
  cfg.taken = [other.player_id];
  const st = build(cfg);
  const fa = new Set(st.freeAgents.map(p => p.player_id));
  assert.ok(![...mine].some(id => fa.has(id)), "a rostered player is listed as a free agent");
  assert.ok(!fa.has(other.player_id), "a taken player is listed as a free agent");
  assert.equal(st.freeAgents.length, ppr.length - mine.size - 1);
});

test("manual state: a player marked IR is not placed; a healthy one is told to come out", () => {
  const cfg = sampleConfig();
  const rb = cfg.roster.find(e => e.pos === "RB");
  rb.ir = true;
  const st = build(cfg);
  assert.equal(st.me.roster.find(p => p.player_id === rb.id).slot, "IR", "placement moved an IR player");
  // The sample is healthy, so the existing IR rule (healthy players leave IR first) applies --
  // the same advice an ESPN league gets.
  assert.ok(pageJson(st).ir_moves.some(m => m.player.id === rb.id && m.from === "IR"));
});

test("manual state: a player whose game already kicked off is still placed", () => {
  const cfg = sampleConfig();
  const qb = ppr.find(r => r.player_id === cfg.roster[0].id);    // the top QB
  const pro = { [qb.pro_team_id]: { abbrev: "XX", bye: null,
                                    games: { [week]: { opp: 0, home: true, kickoff_ms: 1 } } } };
  const st = build(cfg, pro);
  const p = st.me.roster.find(x => x.player_id === qb.player_id);
  assert.equal(p.locked, true);
  assert.equal(p.slot, "QB", "locked QB benched: he could never be placed");
});

test("manual state: a player missing from ESPN's list is kept, flagged, with no prediction", () => {
  const cfg = sampleConfig();
  cfg.roster.push({ id: 999999999, name: "Gone Player", pos: "RB", eligible: ["RB", "FLEX", "BENCH", "IR"],
                    pro_team_id: 0, ir: false });
  const p = build(cfg).me.roster.find(x => x.player_id === 999999999);
  assert.ok(p, "dropped silently");
  assert.equal(p.missing, true);
  assert.equal(p.proj_week, null);
});
