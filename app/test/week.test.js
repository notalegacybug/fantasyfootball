// The This-week page must give the recorded answers on the recorded ESPN fixtures.
// Answer key: app/test/expected_week.json, written by `node test/make_expected.mjs`.
// A failure means a rule's answer changed: if you meant it, regenerate and read the diff.
//
//     cd app && node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildState } from "../www/js/state.js";
import { pageJson } from "../www/js/report.js";

const fix = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const raw = {
  league: fix("espn_league.json"),
  free_agents: fix("espn_free_agents.json"),
  pro_schedule: fix("espn_pro_schedule.json"),
};
const expected = JSON.parse(readFileSync(new URL("./expected_week.json", import.meta.url)));
const MY_SWID = "{00000000-0000-0000-0000-000000000001}";

// Deep equality, numbers within 0.05 (float noise). Reports the path.
function same(a, b, path = "page") {
  if (typeof a === "number" && typeof b === "number") {
    assert.ok(Math.abs(a - b) < 0.05, `${path}: got ${a}, answer key ${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    assert.equal(a, b, `${path}: got ${JSON.stringify(a)}, answer key ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${path}: array vs object`);
    assert.equal(a.length, b.length, `${path}: length ${a.length}, answer key ${b.length}`);
    a.forEach((x, i) => same(x, b[i], `${path}[${i}]`));
    return;
  }
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys differ`);
  for (const k of Object.keys(a)) same(a[k], b[k], `${path}.${k}`);
}

for (const [name, { now_ms, page }] of Object.entries(expected)) {
  test(`same answers as the answer key: ${name}`, () => {
    const st = buildState(raw, { swid: MY_SWID, nowMs: now_ms });
    const { constants, ...js } = pageJson(st);
    assert.equal(constants.close_call_margin, 2.5);
    same(js, page);
  });
}

test("picking a team by id gives the same page as signing in", () => {
  const bySwid = buildState(raw, { swid: MY_SWID, nowMs: 0 });
  const byPick = buildState(raw, { teamId: bySwid.myTeamId, nowMs: 0 });
  same(pageJson(byPick), pageJson(bySwid));
});

test("no SWID and no pick asks the user to pick a team", () => {
  assert.throws(() => buildState(raw, { nowMs: 0 }), /Pick your team/);
});

// Week 5: "Your best lineup" said "BENCH Lamar Jackson" -- the player's current slot
// was overwriting the slot the lineup puts him in.
test("best lineup labels each player with the slot he should play", () => {
  for (const { now_ms } of Object.values(expected)) {
    const page = pageJson(buildState(raw, { swid: MY_SWID, nowMs: now_ms }));
    for (const p of page.starters) {
      assert.ok(!["BENCH", "IR"].includes(p.slot), `${p.name} labelled ${p.slot} in the best lineup`);
    }
    for (const s of ["BENCH", "IR"]) assert.ok(!page.starters.some(p => p.slot === s));
  }
});
