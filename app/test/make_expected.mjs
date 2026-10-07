// The answer key for week.test.js: the This-week page JSON for the recorded fixtures,
// at two clocks. week.test.js fails on ANY change to it, so a rule change has to be
// deliberate: change the rule, regenerate, and read the diff of expected_week.json.
//
//     cd app && node test/make_expected.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { buildState } from "../www/js/state.js";
import { pageJson } from "../www/js/report.js";

const fix = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const raw = {
  league: fix("espn_league.json"),
  free_agents: fix("espn_free_agents.json"),
  pro_schedule: fix("espn_pro_schedule.json"),
};
const MY_SWID = "{00000000-0000-0000-0000-000000000001}";   // _scrub_fixture always maps me here

const week = raw.league.scoringPeriodId;
const kicks = raw.pro_schedule.settings.proTeams
  .flatMap(t => (t.proGamesByScoringPeriod || {})[week] || []).map(g => g.date).sort((a, b) => a - b);
// Two clocks: before the week starts (nothing locked) and mid-Sunday (about half the
// games kicked off) -- the second exercises the `locked` branches on a real roster.
const scenarios = { before_week: 0, mid_sunday: kicks[Math.floor(kicks.length / 2)] + 1 };

const out = {};
for (const [name, now_ms] of Object.entries(scenarios)) {
  const { constants, ...page } = pageJson(buildState(raw, { swid: MY_SWID, nowMs: now_ms }));
  out[name] = { now_ms, page };
}
const path = new URL("./expected_week.json", import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote app/test/expected_week.json: ${Object.keys(scenarios).join(", ")}`);
