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

import { weekPage, searchResults } from "../www/js/ui.js";

test("week page, Yahoo mode: set-this-lineup card, Taken buttons, no lineup-changes card", () => {
  const cfg = sampleConfig();
  const page = pageJson(build(cfg));
  const html = weekPage(page, { edited: "today", hidden: [{ id: 7, name: "Hidden Guy" }] });
  assert.match(html, /Set this lineup in Yahoo/);
  assert.doesNotMatch(html, /Lineup changes|Lineup: already/);
  assert.doesNotMatch(html, /No opponent/);
  assert.match(html, /id="edit-roster"/);
  assert.match(html, /data-untake="7"/);
  if (page.pickups.length) assert.match(html, new RegExp(`data-taken="${page.pickups[0].add.id}"`));
  const espnHtml = weekPage(page);
  assert.match(espnHtml, /Lineup changes|Lineup: already the best/, "ESPN mode unchanged");
  assert.doesNotMatch(espnHtml, /data-taken/);
});

test("week page: close calls sit right under the start/sit advice, before pickups", () => {
  const page = pageJson(build(sampleConfig()));
  const s = page.starters[0];   // something in every card, so none fold into a chip
  Object.assign(page, { ir_moves: [{ player: s, from: "BENCH", to: "IR", reason: "x" }],
    deltas: [{ slot: "QB", in: s, out: s, gain: 1 }], close_calls: [{ slot: "QB", starter: s, alt: s, margin: 1 }],
    pickups: [{ add: s, drop: null, gain: 1, ros_delta: 1 }] });
  const titles = html => [...html.matchAll(/<h2>([^<(]+)/g)].map(m => m[1].trim());
  const espn = titles(weekPage(page));
  assert.equal(espn[espn.indexOf("Lineup changes") + 1], "Close calls");
  const yahoo = titles(weekPage(page, { edited: "today", hidden: [] }));
  assert.equal(yahoo[yahoo.indexOf("IR moves") + 1], "Close calls", "Yahoo mode has no lineup-changes card");
  assert.ok(yahoo.indexOf("Close calls") < yahoo.indexOf("Pickups"));
});

test("week page: cards with nothing to do fold into chips; cards with work stay cards", () => {
  const page = pageJson(build(sampleConfig()));
  Object.assign(page, { problems: [], ir_moves: [], deltas: [], close_calls: [], pickups: [], bye_crunch: [], stash: [] });
  const html = weekPage(page);
  for (const chip of ["Fix first: all clear", "IR: nothing to move", "Lineup: already the best",
                      "Close calls: none", "Pickups: none worth it", "Byes: covered for 4 weeks"]) {
    assert.match(html, new RegExp(`class="chip">${chip}<`));
  }
  assert.deepEqual([...html.matchAll(/<h2>([^<]+)/g)].map(m => m[1]), ["Your best lineup", "Weekly reminder"]);
  page.problems = [{ player: page.starters[0], kind: "low", message: "projected 1.0" }];
  assert.match(weekPage(page), /<h2>Fix first/);
  assert.doesNotMatch(weekPage(page), /Fix first: all clear/);
});

test("search results: not-found message, add buttons, nothing under 2 letters", () => {
  const rows = [{ player_id: 5, name: "A <b>", pos: "WR", pro_team_id: 1 }];
  assert.equal(searchResults(rows, "a", () => "X"), "");
  assert.match(searchResults([], "zz", () => "X"), /Not found in ESPN's top 600/);
  const html = searchResults(rows, "ab", () => "SEA");
  assert.match(html, /data-add="5"/);
  assert.match(html, /SEA/);
  assert.doesNotMatch(html, /<b>/, "names are escaped");
});

// --- Final review fixes -------------------------------------------------------------------

test("search: iPhone's curly apostrophe finds the player", () => {
  const rows = [{ player_id: 2, name: "Ja'Marr Chase" }];
  assert.deepEqual(manual.searchPool(rows, "Ja’Marr").map(r => r.player_id), [2]);
});

test("saved data: rebuilt from the phone's caches when ESPN can't be reached", () => {
  const pool = { season, week, rows: ppr };
  const pro = { 1: { abbrev: "ATL", bye: 5, games: {} } };
  assert.deepEqual(manual.savedData(pool, pro), { season, week, rows: ppr, pro });
  assert.equal(manual.savedData(null, pro), null, "no saved predictions");
  assert.equal(manual.savedData(pool, null), null, "no saved NFL schedule");
});

test("week page, Yahoo mode: a 'fix first' starter is explained as having no backup", () => {
  const page = pageJson(build(sampleConfig()));
  const starter = page.starters[0];
  const bench = { ...starter, id: -5 };
  page.problems = [{ player: starter, kind: "bye", message: "on bye this week" },
                   { player: bench, kind: "bye", message: "on bye this week" }];
  const html = weekPage(page, { edited: "today", hidden: [] });
  assert.equal((html.match(/No one else on your roster can play here/g) || []).length, 1,
               "only the problem player who is still in the best lineup gets the note");
  assert.doesNotMatch(weekPage(page), /No one else on your roster/, "ESPN mode unchanged");
});

// --- Polish after the first iPhone try ----------------------------------------------------

import { rosterPage, manualSetupPage } from "../www/js/ui.js";

test("settings: changing scoring/name/slots keeps the roster and taken list", () => {
  const cfg = sampleConfig();
  cfg.taken = [42];
  const out = manual.applySettings(cfg, { name: " Half league ", scoring: "half",
                                          slots: { ...cfg.slots, BENCH: 7, IR: 0 } });
  assert.equal(out.v, 1, "saved shape unchanged");
  assert.equal(out.name, "Half league");
  assert.equal(out.scoring, "half");
  assert.equal(out.slots.BENCH, 7);
  assert.ok(!("IR" in out.slots), "empty slot types are dropped, as on first setup");
  assert.deepEqual(out.roster, cfg.roster);
  assert.deepEqual(out.taken, [42]);
  assert.ok(out.editedAt >= cfg.editedAt);
});

test("taken: the name is saved with the id, and old configs without names still load", () => {
  const cfg = manual.readConfig({ ...manual.newConfig("L", "ppr", {}), takenNames: undefined });
  manual.markTaken(cfg, { player_id: 9, name: "Gone Guy" });
  manual.markTaken(cfg, { player_id: 9, name: "Gone Guy" });
  assert.deepEqual(cfg.taken, [9], "no duplicates");
  // Not in this week's pool any more: the saved name is used, never "Unknown player".
  assert.deepEqual(manual.hiddenPlayers(cfg, []), [{ id: 9, name: "Gone Guy" }]);
  manual.unmarkTaken(cfg, 9);
  assert.deepEqual([cfg.taken, cfg.takenNames], [[], {}]);
  const old = manual.readConfig({ v: 1, name: "L", scoring: "ppr", slots: {}, roster: [], taken: [7] });
  assert.deepEqual(manual.hiddenPlayers(old, [{ player_id: 7, name: "Pool Name" }]), [{ id: 7, name: "Pool Name" }]);
});

test("search: 'St.Brown' and 'stbrown' find Amon-Ra St. Brown", () => {
  const rows = [{ player_id: 3, name: "Amon-Ra St. Brown" }];
  for (const q of ["St.Brown", "stbrown", "amonra"]) {
    assert.deepEqual(manual.searchPool(rows, q).map(r => r.player_id), [3], q);
  }
});

test("week page, Yahoo mode: IR wording says Yahoo, no owned-% figure, settings button", () => {
  const page = pageJson(build(sampleConfig()));
  const p = page.starters[0];
  page.problems = [{ player: p, kind: "ir", message: "healthy but in IR -- ESPN can block adds until he moves" }];
  page.ir_moves = [{ player: p, from: "IR", to: "BENCH", reason: "healthy -- ESPN can block adds while he's in IR" }];
  page.pickups = [{ add: { ...p, owned_change: 3 }, gain: 1, drop: null, ros_delta: 1 }];
  const html = weekPage(page, { edited: "today", hidden: [] });
  assert.doesNotMatch(html, /ESPN can block/);
  assert.match(html, /Yahoo can block adds until he moves/);
  assert.match(html, /Yahoo can block adds while he's in IR/);
  assert.doesNotMatch(html, /owned/);
  assert.match(html, /id="league-settings"/);
  const espnHtml = weekPage(page);
  assert.match(espnHtml, /ESPN can block/, "ESPN mode unchanged");
  assert.match(espnHtml, /owned \+3\.0% this week/);
});

test("roster page: no IR button when the league has no IR spots, unless he's already in IR", () => {
  const cfg = sampleConfig();
  assert.match(rosterPage(cfg, 15, new Set(), true), /data-ir=/);
  delete cfg.slots.IR;
  assert.doesNotMatch(rosterPage(cfg, 15, new Set(), true), /data-ir=/);
  cfg.roster[0].ir = true;
  assert.equal((rosterPage(cfg, 15, new Set(), true).match(/data-ir=/g) || []).length, 1,
               "a player left in IR can still be taken out");
});

test("setup page: Cancel always; Save and Delete only when editing", () => {
  const cfg = sampleConfig();
  const fresh = manualSetupPage(cfg, null, false);
  assert.match(fresh, /id="manual-cancel"/);
  assert.match(fresh, /Next: add players/);
  assert.doesNotMatch(fresh, /id="manual-delete"/);
  const edit = manualSetupPage(cfg, null, true);
  assert.match(edit, /Save/);
  assert.match(edit, /id="manual-delete"/);
});

// --- Moving a Yahoo league to another device ---------------------------------------------

import { setupPage, transferBox } from "../www/js/ui.js";

test("transfer link: round-trips the whole league, accents included", () => {
  const cfg = sampleConfig();
  cfg.name = "Sam's Núñez league";
  cfg.roster[0].ir = true;
  manual.markTaken(cfg, { player_id: 77, name: "José Taken" });
  const link = manual.exportLink(cfg, "https://fantasyfootball-af1.pages.dev");
  assert.match(link, /^https:\/\/fantasyfootball-af1\.pages\.dev\/#yahoo=[A-Za-z0-9_-]+$/,
               "data after # (never sent to the server), URL-safe characters only");
  const back = manual.importLink(link);
  for (const k of ["name", "scoring", "slots", "roster", "taken", "takenNames"]) {
    assert.deepEqual(back[k], cfg[k], k);
  }
  assert.equal(back.v, 1);
});

test("transfer link: found inside a pasted message; bad input gets a plain-language error", () => {
  const link = manual.exportLink(sampleConfig(), "https://x.dev");
  const msg = `here you go ${link} \nlove, mom`;
  assert.equal(manual.importLink(msg).name, "Test league");
  assert.throws(() => manual.importLink("hello"), /isn't a league link/);
  assert.throws(() => manual.importLink("https://x.dev/#yahoo=@@@"), /got cut off/);
  const v2 = Buffer.from(JSON.stringify({ v: 2, roster: [] })).toString("base64url");
  assert.throws(() => manual.importLink(`#yahoo=${v2}`), /newer version/);
  const junk = Buffer.from(JSON.stringify({ v: 1, name: "x", scoring: "ppr", slots: {},
                                            roster: [{ id: "nope" }] })).toString("base64url");
  assert.throws(() => manual.importLink(`#yahoo=${junk}`), /got cut off/);
});

test("transfer UI: send button only in Yahoo mode; paste box on the start screen", () => {
  const page = pageJson(build(sampleConfig()));
  assert.match(weekPage(page, { edited: "today", hidden: [] }), /id="send-league"/);
  assert.doesNotMatch(weekPage(page), /send-league/);
  const start = setupPage(null, null, [], "That link got cut off.");
  assert.match(start, /id="import-form"/);
  assert.match(start, /That link got cut off\./);
  const box = transferBox("https://x.dev/#yahoo=abc");
  assert.match(box, /https:\/\/x\.dev\/#yahoo=abc/);
  assert.match(box, /id="copy-link"/);
});

// --- Transfer links are untrusted: anyone can send one ------------------------------------

const linkOf = o => `#yahoo=${Buffer.from(JSON.stringify(o)).toString("base64url")}`;

test("transfer link: rebuilt from checked fields only; anything else is refused", () => {
  const good = manual.importLink(manual.exportLink(sampleConfig(), "https://x.dev"));
  const base = { ...good, extra: "<script>" };
  assert.ok(!("extra" in manual.importLink(linkOf(base))), "unknown fields are dropped");
  const bad = [
    { ...base, taken: ['1" onfocus=alert(1) x="'] },
    { ...base, slots: { QB: "1<img src=x onerror=alert(1)>" } },
    { ...base, slots: { "<b>": 1 } },
    { ...base, slots: { QB: 99 } },
    { ...base, takenNames: { abc: "x" } },
    { ...base, takenNames: { 5: { evil: 1 } } },
    { ...base, roster: [{ ...base.roster[0], pos: "<img>" }] },
    { ...base, roster: [{ ...base.roster[0], eligible: ["QB", "<img>"] }] },
    { ...base, roster: [{ ...base.roster[0], ir: "yes" }] },
    { ...base, roster: [{ ...base.roster[0], pro_team_id: "1<b>" }] },
    { ...base, name: "x".repeat(200) },
  ];
  for (const o of bad) assert.throws(() => manual.importLink(linkOf(o)), /got cut off/, JSON.stringify(o).slice(0, 80));
});

test("setup page and hidden list escape what they print", () => {
  const cfg = sampleConfig();
  cfg.slots.QB = '1"><img>';
  assert.doesNotMatch(manualSetupPage(cfg), /<img>/);
  const page = pageJson(build(sampleConfig()));
  assert.doesNotMatch(weekPage(page, { edited: "today", hidden: [{ id: '1"><img>', name: "x" }] }), /<img>/);
});
