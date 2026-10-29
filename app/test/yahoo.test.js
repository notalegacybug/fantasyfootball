// Yahoo's JSON (yahoo.js): parse players/leagues, and match Yahoo players to ESPN's public pool.
// Fixtures are hand-made to Yahoo's real shapes (seen 2026-10-28).
//
//     cd app && node --test test/yahoo.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFreeAgents, parseProSchedule } from "../www/js/espn.js";
import { flat, list, parseLeagues, parseYahooPlayer, matchPlayer, poolIndex, espnTeam,
  parseLeagueBundle, buildYahooState, fetchMyLeagues, fetchLeagueBundle, YahooSignInError } from "../www/js/yahoo.js";
import { weekPage } from "../www/js/ui.js";
import { pageJson } from "../www/js/report.js";
import { execFileSync } from "node:child_process";

const fix = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const P = fix("espn_pool_ppr.json");
const pool = parseFreeAgents(P.raw, P.season, P.week).filter(r => r.pos);
const pro = parseProSchedule(fix("espn_pro_schedule.json"));
const index = poolIndex(pool, pro);

const raw = fix("yahoo_league.json");
const league = flat(raw.fantasy_content.league).teams;
const gibbs = league[0].team[1].roster[0].players[0].player;

// A Yahoo player in the real shape, with just the fields the parser reads.
const yp = (full, abbr, pos, extra = {}) => [[
  { player_key: "470.p.1" }, { name: { full } }, { editorial_team_abbr: abbr },
  { display_position: pos }, { eligible_positions: (extra.eligible ?? [pos]).map(position => ({ position })) }, ...(extra.status ? [{ status: extra.status }] : []),
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

test("list: walks league teams and roster players; empty or missing collections yield nothing", () => {
  const teams = list(league).map(t => flat(t.team[0]).name);
  assert.deepEqual(teams, ["Gibbs Bunch", "Second", "Third", "Fourth"]);
  const roster = list(list(league)[0].team[1].roster[0].players).map(x => parseYahooPlayer(x.player).name);
  assert.deepEqual(roster, ["Jahmyr Gibbs", "Josh Allen", "Nobody Atall", "Seattle"]);
  assert.deepEqual(list(list(league)[3].team[1].roster[0].players), []);
  assert.deepEqual(list([]), []);
  assert.deepEqual(list(undefined), []);
});

test("matchPlayer: same name and team but different positions match by position", () => {
  const rows = [
    { player_id: 1, name: "Zay Flowers", pos: "WR", pro_team_id: 33 },
    { player_id: 2, name: "Zay Flowers", pos: "TE", pro_team_id: 33 },
  ];
  const idx = poolIndex(rows, pro);
  const id = pos => matchPlayer(parseYahooPlayer(yp("Zay Flowers", "Bal", pos)), idx).player_id;
  assert.equal(id("WR"), 1);
  assert.equal(id("TE"), 2);
  assert.equal(id("RB"), 1, "no position match falls back to the first row");
});

test("parseYahooPlayer: any PUP* or NFI* status is injury reserve", () => {
  for (const s of ["PUP-P", "NFI-A", "PUP", "NFI-R"])
    assert.equal(parseYahooPlayer(yp("X", "Was", "WR", { status: s })).status, "INJURY_RESERVE", s);
  assert.equal(parseYahooPlayer(yp("X", "Was", "WR", { status: "SUSP" })).status, "SUSPENSION");
});

// ---- Task 4: the league bundle -> SeasonState ----
const NOW = Date.UTC(2026, 9, 28);
const bundleOf = r => parseLeagueBundle(r);
const withSlots = positions => {
  const r = structuredClone(raw);
  const s = r.fantasy_content.league.find(x => x.settings).settings[0];
  s.roster_positions = positions.map(position => ({ roster_position: { position, count: 1 } }));
  return r;
};

test("parseLeagueBundle: week, scoring, slots, my team, standings and schedule", () => {
  const b = bundleOf(raw);
  assert.equal(b.week, 9);
  assert.equal(b.season, 2026);
  assert.equal(b.scoring, "ppr");
  assert.equal(b.oddScoring, false);
  assert.deepEqual(b.slots, { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6, IR: 1 });
  assert.deepEqual(b.teams.filter(t => t.mine).map(t => t.id), [1]);
  assert.deepEqual([b.teams[0].wins, b.teams[0].losses, b.teams[0].points_for, b.teams[0].points_against], [5, 3, 901.5, 880.25]);
  assert.deepEqual(b.schedule, [{ period: 9, home: 1, away: 2 }, { period: 9, home: 3, away: 4 }]);
  assert.equal(b.teams[0].roster[0].name, "Jahmyr Gibbs");
});

test("parseLeagueBundle: scoring by receptions value, odd scoring by passing TD or bonuses", () => {
  const edit = f => { const r = structuredClone(raw); f(r.fantasy_content.league.find(x => x.settings).settings[0].stat_modifiers.stats); return bundleOf(r); };
  assert.equal(edit(s => { s[1].stat.value = "0.5"; }).scoring, "half");
  assert.equal(edit(s => { s[1].stat.value = "0"; }).scoring, "standard");
  assert.equal(edit(s => { s[0].stat.value = "6"; }).oddScoring, true);
  assert.equal(edit(s => { s[0].stat.bonuses = [{ bonus: { target: 300, points: 3 } }]; }).oddScoring, true);
});

test("parseLeagueBundle: an unmapped roster position throws and names it", () => {
  assert.throws(() => bundleOf(withSlots(["QB", "DB"])), /roster spot the app doesn't handle yet: DB\./);
});

test("buildYahooState: matched keeps ESPN predictions with Yahoo's slot/injury; unmatched is missing", () => {
  const st = buildYahooState(bundleOf(raw), pool, pro, { nowMs: NOW });
  const mine = st.me.roster;
  const g = mine.find(p => p.name === "Jahmyr Gibbs");
  assert.equal(g.proj_week, pool.find(r => r.name === "Jahmyr Gibbs").proj_week);
  assert.deepEqual([g.slot, g.injury, g.missing], ["RB", "QUESTIONABLE", false]);
  const n = mine.find(p => p.name === "Nobody Atall");
  assert.deepEqual([n.missing, n.proj_week, n.slot, n.pos], [true, null, "BENCH", "WR"]);
  assert.equal(st.myTeamId, 1);
  assert.equal(st.week, 9);
  assert.equal(st.opponent().name, "Second");
});

test("buildYahooState: no rostered player is a free agent", () => {
  const st = buildYahooState(bundleOf(raw), pool, pro, { nowMs: NOW });
  const rostered = new Set(st.teams.flatMap(t => t.roster.map(p => p.player_id)));
  assert.ok(st.freeAgents.length > 0);
  assert.ok(st.freeAgents.every(p => !rostered.has(p.player_id)));
  assert.equal(st.freeAgents.length, pool.length - 5);   // Gibbs, Allen, Seattle, Nacua, Jackson
});

test("buildYahooState: no matchup for my team -> opponent() is null", () => {
  const r = structuredClone(raw);
  const sb = r.fantasy_content.league.find(x => x.scoreboard).scoreboard["0"].matchups;
  delete sb["0"]; sb["0"] = sb["1"]; delete sb["1"]; sb.count = 1;   // only teams 3 v 4 play
  const st = buildYahooState(bundleOf(r), pool, pro, { nowMs: NOW });
  assert.equal(st.opponent(), null);
});

test("buildYahooState: pageJson runs end to end; season.js and report.js are untouched", () => {
  const page = pageJson(buildYahooState(bundleOf(raw), pool, pro, { nowMs: NOW }));
  assert.equal(page.week, 9);
  assert.equal(page.opponent.name, "Second");
  execFileSync("git", ["diff", "--exit-code", "www/js/season.js", "www/js/report.js"], { cwd: new URL("..", import.meta.url) });
});

test("buildYahooState: every player's status is null (ESPN's free agent / waivers isn't this league's)", () => {
  const st = buildYahooState(bundleOf(raw), pool, pro, { nowMs: NOW });
  const all = [...st.teams.flatMap(t => t.roster), ...st.freeAgents];
  assert.ok(pool.some(r => r.status), "the ESPN pool does carry a status");
  assert.deepEqual(all.filter(p => p.status !== null).map(p => p.name), []);
});

test("parseYahooPlayer: bench and IR never count as positions he can play", () => {
  const p = parseYahooPlayer(yp("X", "Det", "WR", { eligible: ["WR", "BN", "IR", "W/R/T"] }));
  assert.deepEqual(p.eligible, ["WR", "FLEX"]);
});

test("buildYahooState: a matched player takes Yahoo's eligibility (a WR/TE here), else ESPN's", () => {
  const te = pool.find(r => r.pos === "TE" && !r.eligible.includes("WR"));
  const team = pro[te.pro_team_id].abbrev;
  const b = bundleOf(raw);
  b.teams[0].roster.push(parseYahooPlayer(yp(te.name, team, "TE", { eligible: ["WR", "TE", "W/R/T", "BN"] })));
  let p = buildYahooState(b, pool, pro, { nowMs: NOW }).me.roster.find(x => x.name === te.name);
  assert.deepEqual([p.missing, [...p.eligible].sort()], [false, ["FLEX", "TE", "WR"]]);

  b.teams[0].roster[b.teams[0].roster.length - 1].eligible = [];
  p = buildYahooState(b, pool, pro, { nowMs: NOW }).me.roster.find(x => x.name === te.name);
  assert.deepEqual(p.eligible, te.eligible);
});

test("buildYahooState: an unmatched rostered player listed by ESPN under another team is no free agent", () => {
  const r = pool.find(x => x.pos === "WR");
  const other = Object.values(pro).find(t => t.abbrev !== pro[r.pro_team_id].abbrev).abbrev;
  const b = bundleOf(raw);
  b.teams[1].roster.push(parseYahooPlayer(yp(r.name, other, "WR")));
  const st = buildYahooState(b, pool, pro, { nowMs: NOW });
  assert.equal(st.teams[1].roster.find(x => x.name === r.name).missing, true);
  assert.ok(!st.freeAgents.some(x => x.player_id === r.player_id));
  assert.ok(buildYahooState(bundleOf(raw), pool, pro, { nowMs: NOW }).freeAgents.some(x => x.player_id === r.player_id));
});

// ---- Task 5: fetchers (through the site's relay) and the week page ----
const recorder = (status, data) => {
  const urls = [];
  const get = async (url, headers) => { urls.push(url); assert.deepEqual(headers, {}); return { status, data }; };
  return { get, urls };
};

test("fetchMyLeagues / fetchLeagueBundle: relay URLs, data returned as-is", async () => {
  const a = recorder(200, { fantasy_content: 1 });
  assert.deepEqual(await fetchMyLeagues(a.get), { fantasy_content: 1 });
  await fetchLeagueBundle(a.get, "470.l.1314371");
  assert.deepEqual(a.urls, [
    "/api/yahoo/v2/users;use_login=1/games;game_keys=nfl/leagues",
    "/api/yahoo/v2/league/470.l.1314371;out=settings,standings,scoreboard/teams/roster",
  ]);
});

test("fetchers: 401 {error: signin} -> YahooSignInError; other failures are plain errors", async () => {
  await assert.rejects(fetchMyLeagues(recorder(401, { error: "signin" }).get), YahooSignInError);
  await assert.rejects(fetchLeagueBundle(recorder(401, { error: "signin" }).get, "k"), YahooSignInError);
  // No relay (local preview): a 404 page that isn't JSON.
  const e404 = await fetchMyLeagues(recorder(404, null).get).catch(e => e);
  assert.ok(!(e404 instanceof YahooSignInError));
  assert.match(e404.message, /Yahoo answered 404/);
  const e401 = await fetchMyLeagues(recorder(401, { error: "other" }).get).catch(e => e);
  assert.ok(!(e401 instanceof YahooSignInError));
  // A 200 that isn't Yahoo's JSON (an HTML page) must not read as "no leagues".
  await assert.rejects(fetchMyLeagues(recorder(200, null).get), /Yahoo/);
});

test("weekPage (Yahoo): no free agent pill or ESPN owned %, odd scoring note only when flagged", () => {
  const page = pageJson(buildYahooState(bundleOf(raw), pool, pro, { nowMs: NOW }));
  assert.ok(page.pickups.length > 0);
  const html = weekPage(page, null, { yahoo: true });
  assert.doesNotMatch(html, /free agent<\/span>|owned [+-]?\d/);
  assert.match(html, new RegExp(page.opponent.name));
  assert.doesNotMatch(html, /scores some plays differently/);
  assert.match(weekPage(page, null, { yahoo: true, oddScoring: true }), /scores some plays differently/);
  // Yahoo's API terms: credit wherever its data shows; ESPN leagues don't carry it.
  assert.match(html, /Fantasy data provided by\s+<a [^>]*>Yahoo Fantasy<\/a>/);
  assert.doesNotMatch(weekPage(page), /Fantasy data provided by/);
});
