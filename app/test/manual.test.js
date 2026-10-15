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
