// Yahoo's JSON (yahoo.js): parse players/leagues, and match Yahoo players to ESPN's public pool.
// Fixtures are hand-made to Yahoo's real shapes (seen 2026-10-28).
//
//     cd app && node --test test/yahoo.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFreeAgents, parseProSchedule } from "../www/js/espn.js";
import { flat, parseLeagues, parseYahooPlayer, matchPlayer, poolIndex, espnTeam } from "../www/js/yahoo.js";

const fix = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const P = fix("espn_pool_ppr.json");
const pool = parseFreeAgents(P.raw, P.season, P.week).filter(r => r.pos);
const pro = parseProSchedule(fix("espn_pro_schedule.json"));
const index = poolIndex(pool, pro);

const league = fix("yahoo_league.json").fantasy_content.league[1].teams;
const gibbs = league[0].team[1].roster[0].players[0].player;

// A Yahoo player in the real shape, with just the fields the parser reads.
const yp = (full, abbr, pos, extra = {}) => [[
  { player_key: "470.p.1" }, { name: { full } }, { editorial_team_abbr: abbr },
  { display_position: pos }, { eligible_positions: [{ position: pos }] }, ...(extra.status ? [{ status: extra.status }] : []),
], { selected_position: [{ coverage_type: "week", week: "9" }, { position: extra.slot ?? "BN" }] }];

test("flat: one-key objects, empty arrays and numbered maps merge into one object", () => {
  assert.deepEqual(flat([{ a: 1 }, [], { b: 2 }]), { a: 1, b: 2 });
  assert.deepEqual(flat({ 0: { x: 1 }, count: 1 }), { x: 1 });
  assert.deepEqual(flat(undefined), {});
});

test("parseLeagues: key, name, season, team count", () => {
  assert.deepEqual(parseLeagues(fix("yahoo_leagues.json")),
    [{ key: "470.l.1314371", name: "Test League", season: 2026, numTeams: 4 }]);
});

test("parseYahooPlayer: Gibbs in app names", () => {
  assert.deepEqual(parseYahooPlayer(gibbs), { name: "Jahmyr Gibbs", team: "DET", pos: "RB", slot: "RB",
    status: "QUESTIONABLE", eligible: ["RB", "FLEX"] });
});

test("parseYahooPlayer: defense, bench, IR slot and unknown/empty status", () => {
  const d = parseYahooPlayer(yp("Detroit", "Det", "DEF", { slot: "BN" }));
  assert.deepEqual([d.pos, d.slot, d.status, d.eligible], ["DST", "BENCH", null, ["DST"]]);
  assert.equal(parseYahooPlayer(yp("X", "Was", "WR", { slot: "IR", status: "IR" })).status, "INJURY_RESERVE");
  assert.equal(parseYahooPlayer(yp("X", "Was", "WR", { slot: "IR" })).slot, "IR");
  assert.equal(parseYahooPlayer(yp("X", "Was", "WR", { status: "XYZ" })).status, null);
  assert.equal(parseYahooPlayer(yp("X", "Was", "WR", { status: "NA" })).status, "OUT");
});

test("matchPlayer: real ESPN pool rows", () => {
  const m = (...a) => matchPlayer(parseYahooPlayer(yp(...a)), index);
  assert.equal(matchPlayer(parseYahooPlayer(gibbs), index).name, "Jahmyr Gibbs");
  assert.equal(m("Kenneth Walker", "KC", "RB").name, "Kenneth Walker III");   // suffix is ignored
  assert.equal(m("Kenneth Walker III", "KC", "RB").name, "Kenneth Walker III");
  assert.equal(m("D.J. Moore", "Buf", "WR").name, "DJ Moore");                // dots are ignored
  assert.equal(m("Seattle", "Sea", "DEF").name, "Seahawks D/ST");             // defenses match on team alone
  assert.equal(m("Nobody Atall", "Det", "WR"), null);
});

test("matchPlayer: Yahoo's own abbreviations (Was, Jax, LAR) reach ESPN's teams", () => {
  const rows = [
    { player_id: 1, name: "A Back", pos: "RB", pro_team_id: 28 },     // WSH
    { player_id: 2, name: "Jax Guy", pos: "WR", pro_team_id: 30 },    // JAX
  ];
  const idx = poolIndex(rows, pro);
  assert.equal(matchPlayer(parseYahooPlayer(yp("A Back", "Was", "RB")), idx).player_id, 1);
  assert.equal(matchPlayer(parseYahooPlayer(yp("Jax Guy", "Jax", "WR")), idx).player_id, 2);
});

test("matchPlayer: the same name on two teams matches each team's own row; a defense by team", () => {
  const rows = [
    { player_id: 1, name: "Chris Moore", pos: "WR", pro_team_id: 8 },    // DET
    { player_id: 2, name: "Chris Moore Jr.", pos: "WR", pro_team_id: 12 }, // KC
    { player_id: 3, name: "Lions D/ST", pos: "DST", pro_team_id: 8 },
  ];
  const idx = poolIndex(rows, pro);
  const id = (...a) => matchPlayer(parseYahooPlayer(yp(...a)), idx)?.player_id;
  assert.equal(id("Chris Moore", "Det", "WR"), 1);
  assert.equal(id("Chris Moore", "KC", "WR"), 2);
  assert.equal(id("Detroit", "Det", "DEF"), 3);
  assert.equal(id("Chris Moore", "Sea", "WR"), undefined);
});

test("espnTeam: all 32 Yahoo abbrevs map to a distinct ESPN abbrev", () => {
  const espn = Object.values(pro).map(t => t.abbrev);
  assert.equal(espn.length, 32);
  const yahoo = ["Ari", "Atl", "Bal", "Buf", "Car", "Chi", "Cin", "Cle", "Dal", "Den", "Det", "GB", "Hou", "Ind",
    "Jax", "KC", "LAC", "LAR", "LV", "Mia", "Min", "NE", "NO", "NYG", "NYJ", "Phi", "Pit", "Sea", "SF", "TB", "Ten", "Was"];
  const mapped = yahoo.map(a => espnTeam(a.toUpperCase()));
  assert.deepEqual([...mapped].sort(), [...espn].sort());
});
