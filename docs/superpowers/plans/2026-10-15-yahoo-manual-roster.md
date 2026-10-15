# Yahoo Hand-Entered Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Yahoo player enters their own roster once in the web app and gets the same weekly answers as an ESPN player, using ESPN's public predictions.

**Architecture:** A new adapter `manual.js` turns a saved roster + ESPN's public player pool into the same `SeasonState` that the ESPN adapter builds, so `season.js`, `report.js` and the week page run unchanged. `espn.js` gains two fetches (current week, player pool), `state.js` exports its row→player mapper, `ui.js` gains three screens and a Yahoo mode for the week page, `main.js` wires the flow.

**Tech Stack:** Plain ES modules, no bundler (`app/www/js`), `node --test` (Node's built-in runner, no packages), Cloudflare Pages deploys `app/www` on push.

**Spec:** `docs/superpowers/specs/2026-10-15-yahoo-manual-roster-design.md`

## Global Constraints

- No server, no Yahoo API, no sign-in: everything runs on the device; storage via `app/www/js/store.js` only.
- `season.js` and `report.js` must not change. `state.js` changes only by extracting the existing row mapper (`statePlayer`); `app/test/week.test.js` (answer-key parity) must pass unchanged.
- ESPN projections: `leaguedefaults/3` = PPR, `leaguedefaults/1` = standard; half PPR = average of both, per player.
- Player pool: top **600** by percent owned, slots `[0, 2, 4, 6, 16, 17]`.
- Saved config carries `"v": 1` from day one.
- Slot names: Yahoo W/R/T = `FLEX`, DEF = `DST`. Yahoo defaults: QB 1, WR 3, RB 2, TE 1, W/R/T 1, K 1, DEF 1, Bench 6, IR 1.
- Copy rule (existing app): plain language, sentence case, no "please".
- Run tests from `app/`: `cd app && node --test`.

**One spec refinement, decided here:** each saved roster entry stores `{id, name, pos, eligible, pro_team_id, ir}` (spec §4.3 showed only `{id, ir}`). The extra fields are what lets a player who falls out of ESPN's top 600 still show and be placed (spec §4.2 "kept and flagged, never silently dropped"). Not shipped yet, so no migration.

## Review Focus

1. **Thursday-night lock.** After a Thursday game starts, that player is `locked`. If placement respected locks he could never enter the lineup (nobody is a "starter" yet) and the app would bench a stud. Expected: he's placed by projection like everyone else → Task 4 test "locked player still placed".
2. **Storage growth.** Caching the pool per week would add ~300 KB to localStorage every week and hit the 5 MB quota by mid-season, after which nothing saves. Expected: one cache key per scoring type, overwritten → Task 6 uses `pool.<scoring>` only.
3. **Search box loses focus.** Re-rendering the whole roster screen on every keystroke resets the input. Expected: typing only updates `#results` → Task 6 Step 3 binds `input` to `#results` only.
4. **Player names with punctuation/accents.** "smith njigba", "jamarr", "St. Brown" must find the player. Expected: normalised search → Task 3 test.
5. **Injured roster player in a sample/real roster triggers IR moves**, which would make "Lineup changes" non-empty and confuse the Yahoo page. Expected: Yahoo mode never shows "Lineup changes"; IR moves still show → Task 5 test asserts the card is absent regardless of data.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `app/www/js/espn.js` | Modify | + `fetchCurrentWeek`, `fetchPlayerPool`, `POOL_LIMIT` |
| `app/www/js/state.js` | Modify | export `statePlayer` (extracted from `buildState`, same behaviour) |
| `app/www/js/manual.js` | Create | config, half-PPR averaging, search, `buildManualState` |
| `app/www/js/store.js` | Modify | + `available()` |
| `app/www/js/ui.js` | Modify | setup page Yahoo card, `manualSetupPage`, `rosterPage`, `searchResults`, `weekPage(d, manual)` |
| `app/www/js/main.js` | Modify | Yahoo flow: setup → roster → week, Taken / Show, Edit roster |
| `app/www/app.css` | Modify | stepper + radio row styles |
| `app/test/capture_pool.mjs` | Create | records trimmed pool fixtures |
| `fixtures/espn_pool_ppr.json`, `fixtures/espn_pool_std.json` | Create (generated) | test fixtures |
| `app/test/pool.test.js` | Create | pool parse tests |
| `app/test/manual.test.js` | Create | manual.js + Yahoo week page tests |

---

### Task 1: ESPN player pool fetch + fixtures

**Files:**
- Modify: `app/www/js/espn.js` (after `fetchProSchedule`, ~line 77)
- Create: `app/test/capture_pool.mjs`
- Create (generated): `fixtures/espn_pool_ppr.json`, `fixtures/espn_pool_std.json`
- Test: `app/test/pool.test.js`

**Interfaces:**
- Produces: `POOL_LIMIT = 600`; `fetchCurrentWeek(get, season) -> Promise<number>`; `fetchPlayerPool(get, season, week, leagueDefaultsId, limit = POOL_LIMIT) -> Promise<raw>` where `raw.players[]` parses with the existing `parseFreeAgents(raw, season, week)`.
- Fixture shape: `{ season: number, week: number, raw: { players: [...] } }`.

- [ ] **Step 1: Add the fetches to `espn.js`** (below `fetchProSchedule`)

```js
// Current NFL week without a league (Yahoo-by-hand has no ESPN league to ask).
export async function fetchCurrentWeek(get, season) {
  return (await getJson(get, `${ESPN_BASE}/${season}`)).currentScoringPeriod.id;
}

export const POOL_LIMIT = 600;

// ESPN's public player list with its default-league predictions: leaguedefaults/3 = PPR,
// /1 = standard. No league, no auth; CORS allows our site (measured 2026-10-15). Stats are
// trimmed to this week + season, ~911 KB on the wire for 600 players. Rows carry the same
// stat entries parsePlayer reads, so parseFreeAgents parses them unchanged.
export function fetchPlayerPool(get, season, week, leagueDefaultsId, limit = POOL_LIMIT) {
  const flt = { players: {
    filterSlotIds: { value: FREE_AGENT_SLOT_IDS },
    sortPercOwned: { sortPriority: 1, sortAsc: false },
    limit,
    filterStatsForTopScoringPeriodIds: {
      value: 2, additionalValue: [`10${season}`, `11${season}${week}`, `00${season}`, `02${season}`] },
  } };
  return getJson(get,
    url(`${ESPN_BASE}/${season}/segments/0/leaguedefaults/${leagueDefaultsId}`,
        [["view", "kona_player_info"], ["scoringPeriodId", week]]),
    { "x-fantasy-filter": JSON.stringify(flt) });
}
```

- [ ] **Step 2: Write the capture script** `app/test/capture_pool.mjs`

```js
// Records a small, trimmed slice of ESPN's public player pool for the pool/manual tests.
// Re-run when ESPN changes its format (the tests will fail first):
//
//     cd app && node test/capture_pool.mjs

import { writeFileSync } from "node:fs";
import { fetchCurrentSeason, fetchCurrentWeek, fetchPlayerPool } from "../www/js/espn.js";

const get = async (u, headers) => {
  const r = await fetch(u, { headers });
  return { status: r.status, data: await r.json() };
};

// Only the fields parsePlayer reads, and only ESPN's projections (statSourceId 1).
const trim = e => ({
  status: e.status,
  player: {
    id: e.player.id, fullName: e.player.fullName, defaultPositionId: e.player.defaultPositionId,
    proTeamId: e.player.proTeamId, eligibleSlots: e.player.eligibleSlots,
    injuryStatus: e.player.injuryStatus,
    ownership: { percentStarted: e.player.ownership?.percentStarted,
                 percentChange: e.player.ownership?.percentChange },
    stats: (e.player.stats || []).filter(s => s.statSourceId === 1)
      .map(({ seasonId, scoringPeriodId, statSourceId, statSplitTypeId, appliedTotal }) =>
        ({ seasonId, scoringPeriodId, statSourceId, statSplitTypeId, appliedTotal })),
  },
});

const season = await fetchCurrentSeason(get);
const week = await fetchCurrentWeek(get, season);
for (const [name, id] of [["ppr", 3], ["std", 1]]) {
  const raw = await fetchPlayerPool(get, season, week, id, 150);
  const out = { season, week, raw: { players: raw.players.map(trim) } };
  writeFileSync(new URL(`../../fixtures/espn_pool_${name}.json`, import.meta.url),
                JSON.stringify(out, null, 1) + "\n");
  console.log(`espn_pool_${name}.json: ${out.raw.players.length} players, season ${season} week ${week}`);
}
```

- [ ] **Step 3: Run it**

Run: `cd app && node test/capture_pool.mjs`
Expected: two lines, `150 players` each, the current season and week.

- [ ] **Step 4: Write the test** `app/test/pool.test.js`

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `cd app && node --test`
Expected: all pass (new pool tests + existing). If "no K in the pool" fails, raise the capture limit in Step 2 to 250 and re-run Step 3.

- [ ] **Step 6: Commit**

```bash
git add app/www/js/espn.js app/test/capture_pool.mjs app/test/pool.test.js fixtures/espn_pool_ppr.json fixtures/espn_pool_std.json
git commit -m "feat(app): fetch ESPN's public player pool (Yahoo-by-hand predictions)"
```

---

### Task 2: Export the row→player mapper from `state.js`

**Files:**
- Modify: `app/www/js/state.js:26-45` (`buildState`)
- Test: existing `app/test/week.test.js`, `app/test/bye.test.js` (unchanged — they are the test)

**Interfaces:**
- Produces: `statePlayer(pro, week, nowMs) -> (row => player)`; `row` is a parsed row (`parsePlayer` shape) plus optional `slot`, `status`; the result is exactly what `buildState` produced before.

- [ ] **Step 1: Replace the inner `player` closure** in `buildState` with an exported factory. New code, placed above `buildState`:

```js
// One parsed row -> the player shape season.js reads: adds this week's game, whether it has
// kicked off (locked) and the bye week. Shared by the ESPN path and Yahoo-by-hand (manual.js).
export function statePlayer(pro, week, nowMs) {
  return row => {
    const game = pro[row.pro_team_id]?.games?.[week] ?? null;
    const locked = Boolean(game && game.kickoff_ms && game.kickoff_ms <= nowMs);
    return {
      player_id: row.player_id, name: row.name, pos: row.pos, pro_team_id: row.pro_team_id,
      eligible: row.eligible, proj_week: row.proj_week, proj_ros: row.proj_ros,
      injury: row.injury, pct_started: row.pct_started, pct_change: row.pct_change,
      outlook: row.outlook, slot: row.slot ?? "BENCH", status: row.status ?? null,
      game, locked, bye: pro[row.pro_team_id]?.bye ?? null,
    };
  };
}
```

and inside `buildState` replace the whole `const player = row => { ... };` block with:

```js
  const player = statePlayer(pro, week, nowMs);
```

- [ ] **Step 2: Run the tests**

Run: `cd app && node --test`
Expected: all pass, `week.test.js` included (answer key unchanged = behaviour unchanged).

- [ ] **Step 3: Commit**

```bash
git add app/www/js/state.js
git commit -m "refactor(app): export statePlayer so a second adapter can build players"
```

---

### Task 3: `manual.js` — config, half PPR, search

**Files:**
- Create: `app/www/js/manual.js`
- Test: `app/test/manual.test.js`

**Interfaces:**
- Consumes: `parseFreeAgents` (espn.js), fixtures from Task 1.
- Produces:
  - `CONFIG_VERSION = 1`, `YAHOO_DEFAULT_SLOTS`, `SCORING_DEFAULTS = { ppr: 3, standard: 1 }`
  - `newConfig(name, scoring, slots) -> cfg` (`{v, name, scoring, slots, roster: [], taken: [], editedAt}`)
  - `readConfig(obj) -> cfg | null`
  - `rosterEntry(row) -> {id, name, pos, eligible, pro_team_id, ir: false}`
  - `averagePools(pprRows, stdRows) -> rows`
  - `poolFor(fetchRows, scoring) -> Promise<rows>` (`fetchRows(leagueDefaultsId) -> Promise<rows>`; result filtered to rows with a position)
  - `searchPool(rows, query, excludeIds = new Set(), n = 8) -> rows`

- [ ] **Step 1: Write the failing tests** `app/test/manual.test.js`

```js
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
```

- [ ] **Step 2: Run to see them fail**

Run: `cd app && node --test test/manual.test.js`
Expected: FAIL — `Cannot find module '.../www/js/manual.js'`.

- [ ] **Step 3: Write `app/www/js/manual.js`**

```js
// Yahoo by hand: the user's own roster + ESPN's public predictions -> the same SeasonState the
// ESPN adapter builds, so season.js, report.js and the week page don't know the difference.
// Yahoo's API needs a per-app approval we don't have yet (403, last checked 2026-10-15).
// Spec: docs/superpowers/specs/2026-10-15-yahoo-manual-roster-design.md

export const CONFIG_VERSION = 1;    // saved on users' phones: bump only with a migration
// Yahoo's standard roster. W/R/T is the app's FLEX, DEF is DST.
export const YAHOO_DEFAULT_SLOTS = { QB: 1, WR: 3, RB: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6, IR: 1 };
export const SCORING_DEFAULTS = { ppr: 3, standard: 1 };   // ESPN leaguedefaults id per scoring

export function newConfig(name, scoring, slots) {
  return { v: CONFIG_VERSION, name, scoring, slots: { ...slots }, roster: [], taken: [],
           editedAt: Date.now() };
}

// A saved config, or null if it isn't one this version understands.
export function readConfig(o) {
  if (!o || o.v !== CONFIG_VERSION || !Array.isArray(o.roster)) return null;
  return { taken: [], ...o };
}

// What's saved per player: enough to show and place him even after he drops out of ESPN's
// top 600 (then he has no predictions, but he's never silently removed).
export const rosterEntry = row => ({ id: row.player_id, name: row.name, pos: row.pos,
  eligible: row.eligible, pro_team_id: row.pro_team_id, ir: false });

// Half PPR = the average of ESPN's PPR and standard predictions, player by player.
const avg = (a, b) => (a == null ? b : b == null ? a : (a + b) / 2);
export function averagePools(ppr, std) {
  const s = new Map(std.map(r => [r.player_id, r]));
  return ppr.map(r => {
    const o = s.get(r.player_id);
    return o ? { ...r, proj_week: avg(r.proj_week, o.proj_week), proj_ros: avg(r.proj_ros, o.proj_ros) } : r;
  });
}

// fetchRows(leagueDefaultsId) -> parsed rows. Injected so tests don't touch the network.
export async function poolFor(fetchRows, scoring) {
  let rows;
  if (scoring === "half") {
    const [ppr, std] = await Promise.all([fetchRows(SCORING_DEFAULTS.ppr), fetchRows(SCORING_DEFAULTS.standard)]);
    rows = averagePools(ppr, std);
  } else {
    const id = SCORING_DEFAULTS[scoring];
    if (!id) throw new Error(`Unknown scoring "${scoring}".`);
    rows = await fetchRows(id);
  }
  return rows.filter(r => r.pos);
}

// "smith njigba" finds Smith-Njigba, "jamarr" finds Ja'Marr, "nunez" finds Núñez.
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/['.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function searchPool(rows, query, excludeIds = new Set(), n = 8) {
  const q = norm(query);
  if (q.length < 2) return [];
  return rows.filter(r => !excludeIds.has(r.player_id) && norm(r.name).includes(q)).slice(0, n);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/www/js/manual.js app/test/manual.test.js
git commit -m "feat(app): manual.js config, half-PPR averaging and player search"
```

---

### Task 4: `buildManualState` — one-team league from the saved roster

**Files:**
- Modify: `app/www/js/manual.js` (append)
- Test: `app/test/manual.test.js` (append)

**Interfaces:**
- Consumes: `statePlayer(pro, week, nowMs)` and `SeasonState` (state.js, Task 2); `bestLineup(players, slots)` (season.js); `pageJson(st)` (report.js) in tests.
- Produces: `buildManualState(cfg, pool, pro, { season, week, nowMs }) -> SeasonState` with `teams = [me]`, `myTeamId = 1`, `schedule = []`; roster players carry `missing: true` when absent from the pool.

- [ ] **Step 1: Append the failing tests** to `app/test/manual.test.js`

```js
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
```

- [ ] **Step 2: Run to see them fail**

Run: `cd app && node --test test/manual.test.js`
Expected: FAIL — `manual.buildManualState is not a function`.

- [ ] **Step 3: Append to `app/www/js/manual.js`** (and add the imports at the top of the file)

Top of file, under the header comment:

```js
import { bestLineup } from "./season.js";
import { SeasonState, statePlayer } from "./state.js";
```

Appended:

```js
const MY_TEAM = 1;

// The saved roster as a one-team league. Yahoo doesn't tell us who's starting, so every
// player is placed in his best-lineup slot: "Lineup changes" is then empty by construction
// and "Your best lineup" is the lineup to set in Yahoo.
export function buildManualState(cfg, pool, pro, { season, week, nowMs = Date.now() }) {
  const byId = new Map(pool.map(r => [r.player_id, r]));
  const toPlayer = statePlayer(pro, week, nowMs);

  const players = cfg.roster.map(e => {
    const row = byId.get(e.id);
    const base = row ?? { player_id: e.id, name: e.name, pos: e.pos, eligible: e.eligible,
                          pro_team_id: e.pro_team_id, proj_week: null, proj_ros: null, injury: null,
                          pct_started: null, pct_change: null, outlook: null };
    return { ...toPlayer({ ...base, slot: e.ir ? "IR" : "BENCH" }), missing: !row };
  });

  // Locks are ignored while placing: nobody is a "starter" yet, so a player whose game has
  // kicked off could otherwise never be placed. The report's own bestLineup then keeps him there.
  const placeable = players.filter(p => p.slot !== "IR").map(p => ({ ...p, locked: false }));
  const slotOf = new Map(bestLineup(placeable, cfg.slots).map(([s, p]) => [p.player_id, s]));
  for (const p of players) if (slotOf.has(p.player_id)) p.slot = slotOf.get(p.player_id);

  const skip = new Set([...cfg.roster.map(e => e.id), ...cfg.taken]);
  const freeAgents = pool.filter(r => !skip.has(r.player_id))
    .map(r => toPlayer({ ...r, slot: "BENCH", status: null }));

  const me = { id: MY_TEAM, name: cfg.name, abbrev: null, owners: [], wins: 0, losses: 0, ties: 0,
               points_for: 0, points_against: 0, roster: players };
  return new SeasonState({ season, week, slots: cfg.slots, teams: [me], schedule: [], pro,
                           freeAgents, myTeamId: MY_TEAM });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && node --test`
Expected: all pass, `week.test.js` still green.

- [ ] **Step 5: Commit**

```bash
git add app/www/js/manual.js app/test/manual.test.js
git commit -m "feat(app): build a one-team league from a hand-entered Yahoo roster"
```

---

### Task 5: Screens — Yahoo setup, roster, and Yahoo mode of the week page

**Files:**
- Modify: `app/www/js/ui.js` (`setupPage`, `weekPage`, + three new exports)
- Modify: `app/www/js/store.js` (+ `available`)
- Modify: `app/www/app.css` (append)
- Test: `app/test/manual.test.js` (append)

**Interfaces:**
- Consumes: page JSON from `pageJson` (report.js); cfg shape from Task 3.
- Produces:
  - `setupPage(leagueId, error, yahoo = [])` — `yahoo` is `[{id, name}]`; renders `button.yahoo-open[data-id]` and `#yahoo-new`.
  - `manualSetupPage(cfg, error)` — form `#manual-form`, `#manual-name`, radios `name="scoring"`, steppers `button[data-slot][data-step]`, counts in `#slot-<SLOT>`.
  - `rosterPage(cfg, limit, missingIds, storageOk)` — `#search`, `#results`, `button[data-ir]`, `button[data-remove]`, `#roster-done`.
  - `searchResults(rows, query, abbrev)` — `abbrev(proTeamId) -> string`; renders `button[data-add]`.
  - `weekPage(d, manual = null)` — `manual = { edited: string, hidden: [{id, name}] }`; Yahoo mode renders `#edit-roster`, `button[data-taken]`, `button[data-untake]`.
  - `store.available() -> boolean`.

- [ ] **Step 1: Append the failing test** to `app/test/manual.test.js`

```js
import { weekPage, searchResults } from "../www/js/ui.js";

test("week page, Yahoo mode: set-this-lineup card, Taken buttons, no lineup-changes card", () => {
  const cfg = sampleConfig();
  const page = pageJson(build(cfg));
  const html = weekPage(page, { edited: "today", hidden: [{ id: 7, name: "Hidden Guy" }] });
  assert.match(html, /Set this lineup in Yahoo/);
  assert.doesNotMatch(html, /Lineup changes/);
  assert.doesNotMatch(html, /No opponent/);
  assert.match(html, /id="edit-roster"/);
  assert.match(html, /data-untake="7"/);
  if (page.pickups.length) assert.match(html, new RegExp(`data-taken="${page.pickups[0].add.id}"`));
  const espnHtml = weekPage(page);
  assert.match(espnHtml, /Lineup changes/, "ESPN mode unchanged");
  assert.doesNotMatch(espnHtml, /data-taken/);
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
```

- [ ] **Step 2: Run to see them fail**

Run: `cd app && node --test test/manual.test.js`
Expected: FAIL — `searchResults` is not exported / "Set this lineup in Yahoo" not found.

- [ ] **Step 3: Add `available` to `app/www/js/store.js`** (after `remove`)

```js
// False in private windows / blocked site data: the app still runs but forgets on close.
export function available() {
  try {
    localStorage.setItem(PREFIX + "probe", "1");
    localStorage.removeItem(PREFIX + "probe");
    return true;
  } catch { return false; }
}
```

- [ ] **Step 4: Change `weekPage` in `app/www/js/ui.js`** to take `manual` (null = ESPN, unchanged output)

Replace the function signature and the stats block:

```js
// manual: null for ESPN leagues; for Yahoo-by-hand {edited: "3 days ago", hidden: [{id, name}]}.
export function weekPage(d, manual = null) {
  const gain = d.optimal_total - d.current_total;
  let h = "";
  if (manual) {
    h += `<div class="row"><span class="m">Roster edited ${esc(manual.edited)}</span><button id="edit-roster">Edit roster</button></div>
    <div class="stats">
      <div class="stat"><div class="l">Week ${d.week} · ${esc(d.me.name)}</div><div class="v">${pts(d.optimal_total)}</div></div>
    </div>`;
  } else {
    h += `<div class="stats">
    <div class="stat"><div class="l">Week ${d.week} · ${esc(d.me.name)} (${rec(d.me)})</div><div class="v">${pts(d.current_total)}</div></div>
    <div class="stat"><div class="l">${d.opponent ? esc(d.opponent.name) + " (" + rec(d.opponent) + ")" : "No opponent"}</div><div class="v">${d.opponent_total == null ? "-" : pts(d.opponent_total)}</div></div>
    <div class="stat"><div class="l">Points left on bench</div><div class="v ${gain > 0.05 ? "" : "good"}">${pts(gain)}</div></div>
  </div>`;
  }
```

Wrap the "Lineup changes" card in `if (!manual) { ... }`.

Add helpers above `weekPage` and use them in the Pickups and Stash rows (replace the existing `<span class="pill ...">waivers/free agent</span>` expression in both with `${status(w.add, manual)}`, and append `${taken(w.add, manual)}` right after it):

```js
// Yahoo-by-hand doesn't know waivers vs free agent, so no pill there.
const status = (p, manual) => (manual ? "" : `<span class="pill ${p.status === "WAIVERS" ? "warn" : "ok"}">${p.status === "WAIVERS" ? "waivers" : "free agent"}</span>`);
const taken = (p, manual) => (manual ? ` <button class="taken" data-taken="${p.id}">Taken</button>` : "");
```

After the Pickups card:

```js
  if (manual && manual.hidden.length) {
    h += `<p class="m hidden-list">Hidden as taken: ${manual.hidden.map(x =>
      `${esc(x.name)} <button data-untake="${x.id}">Show</button>`).join(" · ")}</p>`;
  }
```

Starters card title:

```js
  h += card(manual ? "Set this lineup in Yahoo" : "Your best lineup", d.starters.map(p =>
```

- [ ] **Step 5: Extend `setupPage`** — new third parameter `yahoo = []`, and append this section after the closing `</section>` of the ESPN card (return both):

```js
  <section class="card setup">
    <h2>Yahoo league</h2>
    <p class="m">Yahoo doesn't let apps read leagues yet. Enter your roster once and the app uses ESPN's predictions.</p>
    ${yahoo.map(y => `<button class="yahoo-open" data-id="${esc(y.id)}">Open ${esc(y.name)}</button>`).join("")}
    <button id="yahoo-new">My league is on Yahoo — enter my roster</button>
  </section>
```

- [ ] **Step 6: Add the three Yahoo screens** to `ui.js` (after `pickTeamPage`)

```js
const SLOT_LABELS = { QB: "QB", WR: "WR", RB: "RB", TE: "TE", FLEX: "W/R/T", K: "K", DST: "DEF", BENCH: "Bench", IR: "IR" };

export function manualSetupPage(cfg, error) {
  const scoring = [["ppr", "PPR"], ["half", "Half PPR"], ["standard", "Standard"]];
  return `<section class="card setup">
    <h2>Your Yahoo league</h2>
    <form id="manual-form">
      <label class="m" for="manual-name">League name</label>
      <input id="manual-name" autocomplete="off" placeholder="Sam's Yahoo league" value="${esc(cfg.name)}">
      <p class="m">Scoring (in Yahoo: League, then Settings)</p>
      <div class="choice">${scoring.map(([v, l]) =>
        `<label><input type="radio" name="scoring" value="${v}"${cfg.scoring === v ? " checked" : ""}> ${l}</label>`).join("")}</div>
      <p class="m">Roster spots (Yahoo's usual setup; change them to match yours)</p>
      ${Object.entries(SLOT_LABELS).map(([s, l]) => `<div class="row"><span>${l}</span><span class="stepper">
        <button type="button" data-slot="${s}" data-step="-1" aria-label="Fewer ${l}">−</button>
        <b id="slot-${s}">${cfg.slots[s] || 0}</b>
        <button type="button" data-slot="${s}" data-step="1" aria-label="More ${l}">+</button></span></div>`).join("")}
      <button class="primary" type="submit">Next: add players</button>
    </form>
    ${error ? `<p class="field-err">${esc(error)}</p>` : ""}
  </section>`;
}

export function rosterPage(cfg, limit, missingIds, storageOk) {
  const n = cfg.roster.filter(r => !r.ir).length;
  return `<section class="card setup">
    <h2>${esc(cfg.name)}: your roster</h2>
    ${storageOk ? "" : `<div class="err">This browser can't save your roster. It works until you close this tab.</div>`}
    <input id="search" type="search" autocomplete="off" placeholder="Player name, like Jaxon">
    <div id="results"></div>
    <p class="m">${n} of ${limit} spots${n > limit ? ` · <b class="warn-text">${n - limit} over</b>` : ""} (IR not counted)</p>
    ${cfg.roster.map(r => `<div class="row"><span>${esc(r.name)} <span class="m">${esc(r.pos)}</span>${missingIds.has(r.id) ? `<span class="pill warn">not in ESPN's list</span>` : ""}</span>
      <span><button data-ir="${r.id}" aria-pressed="${r.ir}">${r.ir ? "In IR" : "IR"}</button>
      <button data-remove="${r.id}" aria-label="Remove ${esc(r.name)}">×</button></span></div>`).join("")}
    <button class="primary" id="roster-done">See this week</button>
  </section>`;
}

export function searchResults(rows, query, abbrev) {
  if (query.trim().length < 2) return "";
  if (!rows.length) return `<div class="empty">Not found in ESPN's top 600.</div>`;
  return rows.map(r => `<div class="row"><span>${esc(r.name)} <span class="m">${esc(r.pos)} · ${esc(abbrev(r.pro_team_id))}</span></span>
    <button data-add="${r.player_id}">Add</button></div>`).join("");
}
```

- [ ] **Step 7: Append styles** to `app/www/app.css`

```css
/* Yahoo-by-hand screens */
.choice { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
.stepper { display: inline-flex; align-items: center; gap: 10px; }
.stepper b { min-width: 1.5em; text-align: center; }
.warn-text { color: var(--warn); }
button.taken { margin-left: 6px; }
.hidden-list button { margin-left: 4px; }
```

- [ ] **Step 8: Run the tests**

Run: `cd app && node --test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add app/www/js/ui.js app/www/js/store.js app/www/app.css app/test/manual.test.js
git commit -m "feat(app): Yahoo setup, roster and week-page screens"
```

---

### Task 6: Wire the Yahoo flow in `main.js`

**Files:**
- Modify: `app/www/js/main.js`

**Interfaces:**
- Consumes: everything above. `settings` becomes either `{leagueId, teamId}` (ESPN, unchanged) or `{source: "manual", manualId}`.
- Storage keys: `manual.<id>` (cfg), `manualIds` (array of ids), `pool.<scoring>` → `{at, value: {season, week, rows}}` (one key per scoring, overwritten — never per week), `week.<season>` (fresh 1 h).

No unit test: `main.js` is DOM wiring. Verified live in Task 7.

- [ ] **Step 1: Imports and state** — add `rosterLimit` to the existing `import { LOW_PROJECTION_FLAG, ... } from "./season.js";` line, add the import below, and the state below `let settings`:

```js
import * as manual from "./manual.js";
```

```js
// settings is ESPN {leagueId, teamId} or Yahoo-by-hand {source: "manual", manualId}.
const isManual = () => settings.source === "manual";
const manualKey = id => `manual.${id}`;
let manualCfg = null;     // the open Yahoo setup
let manualData = null;    // {season, week, rows, pro}: lets Taken/Show redraw without ESPN
const DAY = 86400e3;
```

- [ ] **Step 2: Data loading** — add under `loadWeek`:

```js
async function currentWeek(get, season) {
  const key = `week.${season}`;
  const cached = store.loadFresh(key, HOUR);
  if (cached) return cached;
  const w = await espn.fetchCurrentWeek(get, season);
  store.saveFresh(key, w);
  return w;
}

// One cache key per scoring type, overwritten each week: a key per week would fill
// localStorage (~300 KB a week) by mid-season.
async function loadManualData(cfg, force) {
  const get = makeGet(null);
  const key = `pool.${cfg.scoring}`;
  const season = await currentSeason(get);
  const [week, pro] = await Promise.all([currentWeek(get, season), proSchedule(get, season)]);
  const fresh = store.loadFresh(key, 12 * HOUR);
  if (!force && fresh && fresh.season === season && fresh.week === week) {
    return { season, week, rows: fresh.rows, pro };
  }
  const fetchRows = async id => espn.parseFreeAgents(
    await espn.fetchPlayerPool(get, season, week, id), season, week);
  const rows = await manual.poolFor(fetchRows, cfg.scoring);
  store.saveFresh(key, { season, week, rows });
  return { season, week, rows, pro };
}

function saveManual() { store.save(manualKey(settings.manualId), manualCfg); }

const editedText = at => {
  const days = Math.floor((Date.now() - at) / DAY);
  return days < 1 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
};
```

- [ ] **Step 3: Screens** — add under `pickTeam`:

```js
function yahooNew(error, draft) {
  screenGen++;
  const cfg = draft ?? manual.newConfig("", "ppr", manual.YAHOO_DEFAULT_SLOTS);
  show(ui.manualSetupPage(cfg, error));
  for (const b of document.querySelectorAll("button[data-slot]")) {
    b.addEventListener("click", () => {
      const s = b.dataset.slot;
      cfg.slots[s] = Math.max(0, Math.min(10, (cfg.slots[s] || 0) + Number(b.dataset.step)));
      $(`#slot-${s}`).textContent = cfg.slots[s];
    });
  }
  $("#manual-form").addEventListener("submit", e => {
    e.preventDefault();
    cfg.name = $("#manual-name").value.trim();
    cfg.scoring = document.querySelector("input[name=scoring]:checked")?.value || "ppr";
    if (!cfg.name) return yahooNew("Give the league a name, so you can tell it apart later.", cfg);
    cfg.slots = Object.fromEntries(Object.entries(cfg.slots).filter(([, n]) => n > 0));
    const id = Date.now().toString(36);
    store.save("manualIds", [...store.load("manualIds", []), id]);
    settings = { source: "manual", manualId: id };
    store.save("settings", settings);
    manualCfg = cfg;
    saveManual();
    rosterScreen();
  });
}

async function rosterScreen() {
  const gen = ++screenGen;
  header();
  if (!manualData) {
    show(ui.loadingPage("Loading ESPN's player list..."));
    try { manualData = await loadManualData(manualCfg, false); }
    catch (e) { if (gen === screenGen) show(ui.errorBox(`Couldn't reach ESPN: ${e.message}`)); return; }
    if (gen !== screenGen) return;
  }
  const { rows, pro } = manualData;
  const inPool = new Set(rows.map(r => r.player_id));
  const missing = new Set(manualCfg.roster.filter(e => !inPool.has(e.id)).map(e => e.id));
  show(ui.rosterPage(manualCfg, rosterLimit(manualCfg.slots), missing, store.available()));
  const abbrev = id => pro[id]?.abbrev || "FA";
  const search = $("#search");
  // Only #results redraws while typing, so the box keeps focus and what's typed.
  search.addEventListener("input", () => {
    const mine = new Set(manualCfg.roster.map(e => e.id));
    $("#results").innerHTML = ui.searchResults(manual.searchPool(rows, search.value, mine), search.value, abbrev);
  });
  const edited = () => { manualCfg.editedAt = Date.now(); saveManual(); rosterScreen(); };
  $("#results").addEventListener("click", e => {
    const id = Number(e.target.closest("button[data-add]")?.dataset.add);
    const row = rows.find(r => r.player_id === id);
    if (!row) return;
    manualCfg.roster.push(manual.rosterEntry(row));
    edited();
    $("#search")?.focus();
  });
  for (const b of document.querySelectorAll("button[data-ir]")) {
    b.addEventListener("click", () => {
      const e = manualCfg.roster.find(r => r.id === Number(b.dataset.ir));
      e.ir = !e.ir;
      edited();
    });
  }
  for (const b of document.querySelectorAll("button[data-remove]")) {
    b.addEventListener("click", () => {
      manualCfg.roster = manualCfg.roster.filter(r => r.id !== Number(b.dataset.remove));
      edited();
    });
  }
  $("#roster-done").addEventListener("click", () => {
    if (!manualCfg.roster.length) return $("#search").focus();
    start();
  });
  search.focus();
}

function showManualWeek() {
  const { season, week, rows, pro } = manualData;
  const st = manual.buildManualState(manualCfg, rows, pro, { season, week, nowMs: Date.now() });
  const name = new Map(rows.map(r => [r.player_id, r.name]));
  const hidden = manualCfg.taken.map(id => ({ id, name: name.get(id) || "Unknown player" }));
  show(ui.weekPage(pageJson(st), { edited: editedText(manualCfg.editedAt), hidden }));
  $("#age").textContent = `ESPN predictions, week ${week}`;
  $("#edit-roster").addEventListener("click", () => rosterScreen());
  for (const b of document.querySelectorAll("button[data-taken]")) {
    b.addEventListener("click", () => {
      manualCfg.taken.push(Number(b.dataset.taken));
      saveManual();
      showManualWeek();
    });
  }
  for (const b of document.querySelectorAll("button[data-untake]")) {
    b.addEventListener("click", () => {
      manualCfg.taken = manualCfg.taken.filter(id => id !== Number(b.dataset.untake));
      saveManual();
      showManualWeek();
    });
  }
}

async function startManual({ force = false } = {}) {
  const gen = ++screenGen;
  history.replaceState(null, "", "/");
  manualCfg = manual.readConfig(store.load(manualKey(settings.manualId))) ?? manualCfg;
  if (!manualCfg) {
    settings = {};
    store.save("settings", settings);
    return askLeague("That Yahoo league isn't saved on this device any more. Set it up again.");
  }
  if (!manualCfg.roster.length) return rosterScreen();
  show(ui.loadingPage("Reading ESPN's predictions..."));
  try {
    manualData = await loadManualData(manualCfg, force);
    if (gen === screenGen) showManualWeek();
  } catch (e) {
    if (gen !== screenGen) return;
    const old = store.load(`pool.${manualCfg.scoring}`)?.value;
    if (!old || !manualData) return show(ui.errorBox(`Couldn't reach ESPN: ${e.message}`));
    showManualWeek();
    $("#age").textContent = "couldn't reach ESPN, showing saved predictions";
  }
}
```

Note on the catch branch: `manualData` holds the last good load (this session); with no load this session there is no `pro` schedule, so it shows the error rather than a half page.

- [ ] **Step 4: Hook into the existing flow**

In `header()`, show Refresh and League for Yahoo setups too — replace the two `settings.leagueId ?` conditions with `(settings.leagueId || isManual()) ?`.

In `askLeague(error)`, pass saved Yahoo leagues and bind their buttons:

```js
  const yahoo = store.load("manualIds", [])
    .map(id => ({ id, name: store.load(manualKey(id))?.name })).filter(y => y.name);
  show(ui.setupPage(settings.leagueId, error, yahoo));
  header();
  $("#yahoo-new").addEventListener("click", () => yahooNew());
  for (const b of document.querySelectorAll("button.yahoo-open")) {
    b.addEventListener("click", () => {
      settings = { source: "manual", manualId: b.dataset.id };
      store.save("settings", settings);
      manualCfg = null;
      manualData = null;
      start();
    });
  }
```

(replacing the existing `show(ui.setupPage(settings.leagueId, error)); header();` lines; the `#league-form` handler stays as is.)

In `start()`, right after `header();`:

```js
  if (isManual()) return startManual({ force });
```

In the league form submit and in `openLeague`, ESPN `settings = { leagueId: id, teamId: null }` already drops `source` — no change needed.

- [ ] **Step 5: Run the tests** (catches import/syntax mistakes in shared modules)

Run: `cd app && node --test`
Expected: all pass. Then `node --check www/js/main.js` → no output.

- [ ] **Step 6: Commit**

```bash
git add app/www/js/main.js
git commit -m "feat(app): Yahoo-by-hand flow -- setup, roster, week, Taken"
```

---

### Task 7: Live check in the browser, then push

**Files:** none (verification); fixes go back to the owning task's file.

- [ ] **Step 1: Start the preview** — `preview_start` with name `weekly-web` (port 8788), then `resize_window` preset `mobile`.

- [ ] **Step 2: Walk the flow** and confirm each with `read_page` / screenshot:
  1. Start screen shows the "Yahoo league" card.
  2. "My league is on Yahoo" → setup; empty name → "Give the league a name..." message; −/+ change counts; pick Half PPR; Next.
  3. Roster: type `smith nj` → Jaxon Smith-Njigba appears while the search box keeps focus; add ~15 players covering every position; mark one IR; remove one; counter updates.
  4. See this week → "Set this lineup in Yahoo" with 10 starters, no "Lineup changes", no opponent box, "Roster edited today".
  5. Tap Taken on a pickup → it disappears, "Hidden as taken: ... Show" appears; Show brings it back. Network panel: no new ESPN pool request on Taken.
  6. Reload the page → same week page from saved setup (no re-entry).
  7. League → start screen lists "Open <name>"; an ESPN league ID still works as before (league `1446375`).
- [ ] **Step 3: Check console** — `read_console_messages` onlyErrors → none.
- [ ] **Step 4: Reset the viewport** — `resize_window` preset `desktop`.
- [ ] **Step 5: Update the graph and push**

```bash
graphify update .
git push
```

Cloudflare Pages redeploys `app/www` from `in-season-m1` on push; check https://fantasyfootball-af1.pages.dev once on a phone.

---

## Self-review notes

- Spec §4.1 → Task 1; §4.2 → Tasks 3–4; §4.3 storage → Task 6 (`manual.<id>`, `pool.<scoring>` — spec's `pool.<season>.<week>.<scoring>` replaced per Review Focus 2, season/week now stored inside the value); §4.4 slots → Tasks 3, 5; §5 screens → Tasks 5–6; §6 errors → Task 6 (`startManual` catch, `store.available`, empty roster → roster screen); §7 testing → Tasks 1–5 units, Task 7 live; §8 out of scope respected.
- Names used across tasks: `statePlayer`, `buildManualState`, `poolFor`, `searchPool`, `rosterEntry`, `readConfig`, `newConfig`, `YAHOO_DEFAULT_SLOTS`, `fetchPlayerPool`, `fetchCurrentWeek`, `searchResults`, `rosterPage`, `manualSetupPage`, `weekPage(d, manual)`, `store.available` — consistent.
