# Yahoo leagues by hand-entered roster — design

Status: approved in brainstorm 2026-10-15. Extends `2026-10-02-mobile-app-design.md`
(milestone 2 "Yahoo" there assumed the Yahoo API; this is the path while that is blocked).

## 1. Goal

A Yahoo player (first user: the younger kid, Yahoo-only, iPhone) gets the same weekly
answers as an ESPN player — best lineup, IR moves, byes, close calls, pickups, stash — by
entering their own roster once in the app and editing it after each add/drop. Works in
the web app today (iPhone Safari), no install, no sign-in, no server.

Success: the kid sets up their league in under 5 minutes and each week sees a lineup to
copy into Yahoo plus pickup ideas, with already-owned pickups hideable by one tap.

## 2. Why not the Yahoo API (evidence)

- 2026-10-15 retest: Yahoo sign-in and token swap work; `game/nfl` and
  `users;use_login=1/games;game_keys=nfl/leagues` both return **403 "This application is
  not authorized to perform this action."** Same as 2026-10-05. Yahoo's per-app Fantasy
  API approval (applied 2026-10-05) has not been granted.
- FantasyPros syncs Yahoo leagues, but that authorization belongs to FantasyPros' app and
  they publish no API for synced leagues; scraping would need the kid's FantasyPros
  password in our app. Rejected.

## 3. Decisions (with the rejected alternative)

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Source of the roster | User enters their own roster in the app | Yahoo API (blocked, §2); ESPN "mirror" league with all 10 teams typed in (exact pickups, zero code, but ~160 entries and every add/drop by any team must be re-entered — and unverified that ESPN allows creating a league in week 6) |
| Other teams' rosters | Not entered. Pickups carry a **Taken** tap that hides a player | Entering all 10 rosters (same upkeep problem); warning-only label (same taken players reappear weekly); no pickups (loses one of the five weekly answers) |
| Entry method | **Search and tap** one player at a time | Paste Yahoo's roster text + fuzzy match (faster first setup, but abbreviated names like "J. Gibbs Det - RB" need a confirm step per miss; untested how it pastes on a phone). Can be added later |
| Where it plugs in | New **adapter** `manual.js` producing the same shape `espn.js` produces | Teach `buildState` a second input (less code, but mixes sources in the core every recommendation runs through) |
| Projections | ESPN public player pool: `leaguedefaults/3` (PPR), `/1` (standard); half-PPR = average of both | — |
| Current starters | Not entered. The app places every player in their best-lineup slot | Ask the user to mark starters (extra work every week for no added answer) |

Evidence (2026-10-15, `kona_player_info` on `seasons/2026/segments/0/leaguedefaults/{1,3}`,
`x-fantasy-filter` slots `[0,2,4,6,16,17]`, sorted by percent owned): HTTP 200,
`Access-Control-Allow-Origin` echoes `https://fantasyfootball-af1.pages.dev`; PPR and
standard numbers differ as expected (Gibbs wk13 25.7 vs 20.6). With
`scoringPeriodId=<week>` and `filterStatsForTopScoringPeriodIds` limited to this week +
season, 600 players = **~911 KB on the wire**, and each player carries exactly the stat
rows `parsePlayer` already reads (period `week` source 1 split 1; period 0 source 1
split 0) plus `ownership`, `eligibleSlots`, `defaultPositionId`, `injuryStatus`.

## 4. Architecture

```
ESPN league ID ──► espn.js (fetchLeague + fetchFreeAgents) ──┐
                                                             ├──► buildState ─► weeklyReport ─► pageJson ─► week page
Yahoo by hand  ──► manual.js (saved roster + ESPN pool)  ────┘
```

`state.js`, `season.js`, `report.js` do not change. `espn.js` header already promises
"a Yahoo adapter only has to produce the same shape"; `manual.js` is that adapter.

### 4.1 `espn.js` — one new function

`fetchPlayerPool(get, season, week, leagueDefaultsId, limit = 600)` →
`GET {ESPN_BASE}/{season}/segments/0/leaguedefaults/{id}?view=kona_player_info&scoringPeriodId={week}`
with filter: slots `FREE_AGENT_SLOT_IDS`, `sortPercOwned` desc, `limit`,
`filterStatsForTopScoringPeriodIds` (this week + season projections). Parsed with the
existing `parseFreeAgents` / `parsePlayer`. Ownership status is ignored (no league).

### 4.2 `manual.js` — new

- `poolFor(get, season, week, scoring)` — one fetch for `ppr` / `standard`; two for
  `half`, averaging `proj_week` and `proj_ros` per `player_id` (null stays null if both null;
  one-sided → that value).
- `buildManualRaw(cfg, pool, week, season)` → the `{league, free_agents, pro_schedule}`
  input `buildState` takes, i.e. a one-team league in ESPN's parsed shape:
  - `slots` from `cfg.slots`;
  - team id 1 = the user's roster (pool rows matched by `player_id`, `slot: "IR"` when
    flagged, else placed by `bestLineup` into starter slots, rest `BENCH`);
  - free agents = pool − roster − `cfg.taken`;
  - no schedule → `opponent()` is null.
  Exact mechanics (feed `buildState` a raw-like object vs. a small `buildStateFrom(parsed)`
  split inside `state.js`) are an implementation-plan choice; whichever is used, no
  recommendation logic changes.
- Roster players missing from the pool (fell out of the top 600 after entry) are kept with
  null projections and flagged, never silently dropped.

### 4.3 Storage (device only, via `store.js`)

Key `manual.<localId>`:

```json
{ "v": 1, "name": "Sam's Yahoo league", "scoring": "ppr",
  "slots": {"QB":1,"RB":2,"WR":3,"TE":1,"FLEX":1,"K":1,"DST":1,"BENCH":6,"IR":1},
  "roster": [{"id": 4241457, "ir": false}],
  "taken": [4362628], "editedAt": 1760500000000 }
```

`v` is there from day one: this format lives on the kids' phones, so changing it later
needs a migration — the one expensive-to-reverse choice here. Optional fields may be
added without a bump when old configs load fine without them: `takenNames` (`{id: name}`,
so the hidden list can name a player who left ESPN's list) defaults to `{}`. Player pool
cached with `saveFresh` under `pool.<scoring>` (one key per scoring, overwritten weekly —
a key per week would fill localStorage), value `{season, week, rows}`, 12 h TTL; a value
whose season/week isn't the current one is refetched. `settings` gains
`{source: "manual", manualId}` beside the ESPN `{leagueId, teamId}`.

### 4.4 Slot names

Yahoo W/R/T = app `FLEX`; DEF = `DST`. Defaults shown pre-filled (Yahoo standard:
QB 1, WR 3, RB 2, TE 1, W/R/T 1, K 1, DEF 1, Bench 6, IR 1), editable with −/+.

## 5. Screens

1. **Start screen** — new second option: "My league is on Yahoo — enter my roster".
2. **Setup (once)** — league name, scoring (PPR / Half / Standard), slot counts.
3. **Roster** — search box (matches pool by name, shows pos + NFL team), tap to add; list
   of current roster with an IR toggle and remove ×; counter "N of limit". Over the limit
   → warning, not blocked. Not found → "Not found in ESPN's top 600".
4. **Week page, Yahoo mode** — same cards as ESPN, with three changes:
   - "Your best lineup" titled **"Set this lineup in Yahoo"**; "Lineup changes" is empty by
     construction (§3 current-starters decision); the header stat shows the best-lineup
     total, opponent box hidden;
   - pickups and stash rows get a **Taken** button → adds to `taken`, re-renders from the
     cached pool (no refetch); "Show N hidden as taken" lists them with Un-hide;
   - top line **"Roster edited N days ago · Edit roster"**.
5. Header: League button switches between saved ESPN and Yahoo setups the same way it
   switches ESPN leagues today.

## 6. Error handling

- ESPN pool fetch fails → show last cached page with "couldn't reach ESPN" (same as today).
- Storage unavailable (private browsing) → banner "This browser can't save your roster";
  the session still works until the tab closes.
- Empty roster → week page replaced by the roster screen.

## 7. Testing

- `node --test` units for `manual.js` against a trimmed saved pool fixture
  (`app/test/fixtures/espn_pool_ppr.json`, `..._std.json`): taken excluded from free agents;
  IR-flagged players never in the lineup; half = average; best-lineup placement yields empty
  `deltas`; missing-from-pool player kept and flagged.
- Existing ESPN tests and the answer-key parity test must still pass unchanged (proves the
  core was not touched).
- Live: preview at phone size, enter a real roster, check the week page end to end.
- Real-world: the younger kid on their iPhone (web app, nothing to install).

## 8. Out of scope

Paste-a-list entry; opponent/matchup data; any Yahoo API or relay; syncing the roster
between devices; the Android/iPhone native builds (web app first — they pick it up for free
since it is the same `www`).
