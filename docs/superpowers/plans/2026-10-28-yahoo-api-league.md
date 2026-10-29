# Yahoo API Leagues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Yahoo player signs in to Yahoo once, taps their league, and gets the same week page (same `season.js` math) an ESPN league gets.

**Architecture:** A Cloudflare Pages Function under `/api/yahoo/*` does the OAuth swap and relays read-only GETs to Yahoo with the user's token, which is kept in cookies on the phone. A new adapter `yahoo.js` turns Yahoo's league JSON plus ESPN's public predictions into the same `SeasonState` that `state.js` builds for ESPN. `main.js`/`ui.js` gain a hidden-until-ready "Yahoo league" path.

**Tech Stack:** Vanilla ES modules (no bundler), `node --test` (Node 26), Cloudflare Pages Functions (Workers runtime: `fetch`, `Request`, `Response`, `crypto`).

**Spec:** `docs/superpowers/specs/2026-10-28-yahoo-api-league-design.md`

## Global Constraints

- No Yahoo-specific branches in `season.js` or `report.js`; `yahoo.js` must output the exact `SeasonState` fields `state.js` produces.
- Never store tokens or league data on the server. Tokens live in cookies: `HttpOnly; Secure; SameSite=Lax; Path=/api/yahoo`.
- Client Secret only in Cloudflare env var `YAHOO_CLIENT_SECRET` (plus `YAHOO_CLIENT_ID`). Never in git, the page, or chat. The user sets both in the Cloudflare dashboard.
- Scope `fspt-r`. Redirect URI exactly `https://fantasyfootball-af1.pages.dev/api/yahoo/callback`.
- The relay forwards **GET only**, to `https://fantasysports.yahooapis.com/fantasy/v2/` only, always with `format=json`.
- `game_key` is looked up every season, never hard-coded (`470` is 2026's).
- The "Yahoo league" button is hidden until the flag `yahooBeta` is set by opening `/#yahoo-beta` once.
- Hand entry (`manual.js`, saved configs, transfer links, `CONFIG_VERSION`) is unchanged.
- Deploy = `git push` to `in-season-m1`. Preview locally (`.claude/launch.json`) before every push. Ask the user before each push.
- Copy is plain language, no jargon, matching the existing `ui.js` tone.

## Review Focus

1. **A rostered Yahoo player who isn't in ESPN's top 600** (deep-bench rookie, backup K): he must still appear on the roster with no prediction (`missing: true`), never dropped. Test in Task 3.
2. **Name variants:** "Kenneth Walker III" vs "Kenneth Walker", "D.J. Moore" vs "DJ Moore", "Amon-Ra St. Brown", and two players with the same name on different NFL teams. Tests in Task 3.
3. **Token expired or revoked mid-season:** the week page offers "Sign in to Yahoo again" (one tap), never a raw error. Tests in Tasks 1 and 5.
4. **No opponent this week** (playoffs, or a league with an odd number of teams): `opponent()` returns null and the page still renders. Test in Task 4.
5. **A league slot the app can't place** (IDP `DB`, `W/R`, …): a clear message, not a crash or silently ignored starters. Test in Task 4.

---

### Task 1: Server helper — sign-in, token swap, relay

**Files:**
- First check: in the Cloudflare dashboard, the Pages project's **root directory** setting. Pages Functions live in `<root>/functions/`. If the root is the repo root, use `functions/`. If it's `app/www`, use `app/www/functions/` and keep that folder out of the Android copy step. **Ask the user to read this setting; don't guess.**
- Create: `functions/_lib/yahoo.js` (pure helpers)
- Create: `functions/api/yahoo/[[path]].js` (router: `export const onRequest`)
- Test: `app/test/yahoo_fn.test.js`

**Interfaces:**
- Produces (HTTP):
  - `GET /api/yahoo/login` → 302 to `https://api.login.yahoo.com/oauth2/request_auth?client_id=…&redirect_uri=…&response_type=code&scope=fspt-r&state=<random>`, and sets cookie `yh_state` (10 min).
  - `GET /api/yahoo/callback?code&state` → state must equal `yh_state`, else 400. Swaps at `https://api.login.yahoo.com/oauth2/get_token` (Basic `id:secret`, `grant_type=authorization_code`). Sets `yh_rt` (refresh token, 400 days) and `yh_at` (access token, `Max-Age` = `expires_in` − 60), then 302 to `/#yahoo-signed-in`.
  - `GET /api/yahoo/v2/<path>[?query]` → relays to `…/fantasy/v2/<path>` with `format=json` forced. If there's no `yh_at` but there is a `yh_rt`, it refreshes first (`grant_type=refresh_token`) and re-sets both cookies. With no tokens, or a failed refresh, it returns **401** `{"error":"signin"}`. Otherwise it passes Yahoo's status and JSON body through.
  - `POST /api/yahoo/logout` → clears all three cookies, 204.
  - Any other method or path → 405 / 404.
- Produces (JS, `functions/_lib/yahoo.js`): `authUrl(env, state) -> string`, `parseCookies(header) -> object`, `setCookie(name, value, maxAgeSec) -> string`, `relayTarget(pathAfterV2, search) -> string | null` (null if invalid), `swapToken(env, params, fetchFn) -> {access_token, refresh_token, expires_in}`.

- [ ] **Step 1: Write failing tests** in `app/test/yahoo_fn.test.js` (import the router's `onRequest` and pass a stubbed `fetch` through `context.env`/a module-level injection point of your choice):
  - `login` → 302, the `Location` host is `api.login.yahoo.com`, `scope=fspt-r`, and the `state` in the URL equals the `yh_state` cookie.
  - `callback` with a mismatched state → 400. Nothing is fetched.
  - `callback` OK → `Set-Cookie` has `yh_rt` and `yh_at`, each with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/yahoo`. `Location` is `/#yahoo-signed-in`.
  - `relayTarget("league/470.l.1/teams", "")` → `https://fantasysports.yahooapis.com/fantasy/v2/league/470.l.1/teams?format=json`.
  - `relayTarget` returns null for `"../x"`, `"//evil.com/x"`, `"https://evil.com"`, `"a\\b"`, and paths containing `%2e%2e`.
  - Relay with only `yh_rt` → exactly one refresh, then one Yahoo GET carrying `Authorization: Bearer <new>`, and new cookies set.
  - Relay with no cookies, or a refresh that returns 400 → 401 `{"error":"signin"}`.
  - `POST` to `/api/yahoo/v2/...` → 405.
- [ ] **Step 2:** `cd app && node --test test/yahoo_fn.test.js`. Expect FAIL (module not found).
- [ ] **Step 3:** Implement `functions/_lib/yahoo.js` and the router. Use `crypto.randomUUID()` for `state`. Use the `fetch` you're given (global in Workers, stubbed in tests).
- [ ] **Step 4:** `cd app && node --test`. Expect all PASS (the existing tests included).
- [ ] **Step 5:** Commit: `feat(yahoo): Pages Function for Yahoo sign-in and read-only relay`.

### Task 2: iPhone Home Screen sign-in spike (decides the cookie path)

**Files:**
- Modify: `app/www/js/main.js` (on load: `#yahoo-beta` → `store.save("yahooBeta", true)`; `#yahoo-signed-in` → temporary screen that calls `/api/yahoo/v2/users;use_login=1/games;game_keys=nfl/leagues` and shows "Signed in. Leagues found: N")

- [ ] **Step 1:** Add the two hash handlers next to the existing `#yahoo=` handler. Keep the `#yahoo=` (transfer link) check first so `#yahoo-beta` and `#yahoo-signed-in` don't collide with it (`startsWith("#yahoo=")` already requires the `=`).
- [ ] **Step 2:** Preview locally. The temporary screen should show the 401 message cleanly, since there's no function locally.
- [ ] **Step 3:** Ask the user to set `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET` in Cloudflare Pages (Production). Then ask before pushing. Push, and wait for the deploy.
- [ ] **Step 4:** The user tests on a real iPhone, **from the Home Screen icon**: open `/#yahoo-beta`, then visit `/api/yahoo/login`, sign in, and see whether the app shows "Signed in. Leagues found: N". Close the app fully, reopen it, and check that reloading `#yahoo-signed-in` still works (the cookie persisted).
- [ ] **Step 5: Decision point.** If it works, the cookie path stays and Task 2b is skipped. If the round trip ends in Safari, or the cookie isn't visible in the Home Screen app, do Task 2b. Record the result in `docs/yahoo-api-access.md`.
- [ ] **Step 6:** Commit: `feat(yahoo): hidden beta flag and sign-in check screen`.

### Task 2b (only if the spike fails): encrypted paste-in pass

- Callback returns a page showing a link `https://fantasyfootball-af1.pages.dev/#yahoopass=<blob>` with a Copy button. `blob` is AES-GCM (Web Crypto) of the refresh token, using a key derived from env `YAHOO_PASS_KEY` (the user adds this secret).
- The app stores the blob (`store.save("yahooPass", blob)`) when the link is pasted into the existing import box, and sends it as the header `X-Yahoo-Pass` on every relay call. The relay decrypts it, refreshes the token on every call (there's no access-token cookie in this mode), and still stores nothing.
- Tests: an encrypt/decrypt round trip; a tampered blob → 401 `{"error":"signin"}`; the relay takes the header when there are no cookies.
- Commit: `feat(yahoo): paste-in sign-in for Home Screen apps`.

### Task 3: `yahoo.js` — parse Yahoo JSON and match players to ESPN

**Files:**
- Create: `app/www/js/yahoo.js`
- Create: `fixtures/yahoo_leagues.json`, `fixtures/yahoo_league.json` (hand-made from Yahoo's documented shapes, with real values where known: game_key 470, player key `470.p.40059` Jahmyr Gibbs, Det, RB, status `Q`; a 4-team league is enough)
- Test: `app/test/yahoo.test.js`

**Interfaces:**
- Produces:
  - `flat(arr) -> object`. This merges Yahoo's "array of one-key objects" and numbered-key maps into one plain object. Every parser below uses it.
  - `parseLeagues(raw) -> [{key, name, season, numTeams}]` from `users;use_login=1/games;game_keys=nfl/leagues`.
  - `parseYahooPlayer(p) -> {name, team, pos, eligible[], slot, status}`. `team` is the uppercased Yahoo `editorial_team_abbr`; `pos` and `slot` use app names.
  - `YAHOO_SLOTS = {QB:"QB", RB:"RB", WR:"WR", TE:"TE", K:"K", DEF:"DST", "W/R/T":"FLEX", "Q/W/R/T":"OP", BN:"BENCH", IR:"IR"}`.
  - `YAHOO_STATUS = {Q:"QUESTIONABLE", D:"DOUBTFUL", O:"OUT", IR:"INJURY_RESERVE", "IR-R":"INJURY_RESERVE", PUP:"INJURY_RESERVE", "PUP-R":"INJURY_RESERVE", NFI:"INJURY_RESERVE", "NFI-R":"INJURY_RESERVE", SUSP:"SUSPENSION", NA:"OUT"}` (anything else, or empty → `null`).
  - `matchPlayer(yp, index) -> poolRow | null` and `poolIndex(rows, pro) -> index`. The index is keyed by normalized name + ESPN pro-team abbrev (via `pro[id].abbrev`). Reuse `manual.js`'s `norm` (export it) and also strip the suffixes `jr|sr|ii|iii|iv|v`. DST matches on team alone. Keep a Yahoo→ESPN team-abbrev table for the few that differ (e.g. `WAS`→`WSH`) and test every NFL team.

- [ ] **Step 1: Write failing tests:**
  - `parseLeagues(fixture)` → `[{key:"470.l.1314371", …}]`.
  - `parseYahooPlayer(gibbs)` → `{name:"Jahmyr Gibbs", team:"DET", pos:"RB", slot:"RB", status:"QUESTIONABLE", eligible:["RB", "FLEX"]}`. W/R/T eligibility maps to FLEX.
  - Matching against the real ESPN pool fixture (`fixtures/espn_pool_ppr.json`): Gibbs → his ESPN row. "Kenneth Walker III" matches ESPN's "Kenneth Walker III" or "Kenneth Walker". "DJ Moore" matches "D.J. Moore". A defense ("Detroit", `DEF`, DET) → the DET D/ST row.
  - Same name on two NFL teams → each matches its own team's row.
  - An unknown player → `null`.
  - Yahoo→ESPN team table: all 32 Yahoo abbrevs map to an abbrev present in `parseProSchedule` output (use a pro-schedule fixture if one exists; otherwise hard-code ESPN's 32 in the test).
- [ ] **Step 2:** `cd app && node --test test/yahoo.test.js`. Expect FAIL.
- [ ] **Step 3:** Implement. `export` `norm` from `manual.js` without changing its behavior; `manual.test.js` must still pass.
- [ ] **Step 4:** `cd app && node --test`. Expect all PASS.
- [ ] **Step 5:** Commit: `feat(yahoo): parse Yahoo players and match them to ESPN predictions`.

### Task 4: `yahoo.js` — build the `SeasonState`

**Files:**
- Modify: `app/www/js/yahoo.js`
- Modify: `fixtures/yahoo_league.json` (settings, standings, scoreboard, teams with rosters)
- Test: `app/test/yahoo.test.js`

**Interfaces:**
- Consumes: Task 3's exports, `statePlayer` and `SeasonState` from `state.js`, `bestLineup` is NOT needed (Yahoo gives real slots).
- Produces:
  - `parseLeagueBundle(raw) -> {season, week, scoring, slots, oddScoring, teams:[{id, name, mine, wins, losses, ties, points_for, points_against, roster:[yahooPlayer]}], schedule:[{period, home, away}]}`. `raw` is the response of one combined call: `league/<key>;out=settings,standings,scoreboard/teams/roster`. If that combination isn't allowed, use separate calls and an object `{settings, standings, scoreboard, teams}`; record the choice in the file header.
  - `scoring`: the receptions stat modifier (stat_id 11) of 1 → `"ppr"`, 0.5 → `"half"`, otherwise `"standard"`.
  - `oddScoring`: true when passing TD (stat_id 4) points ≠ 4, or the league has any bonus rules.
  - `slots`: built from `roster_positions` via `YAHOO_SLOTS`. It **throws** `Error("This league has a roster spot the app doesn't handle yet: <name>.")` for any unmapped position.
  - `buildYahooState(bundle, poolRows, pro, {nowMs}) -> SeasonState`. Rostered players: the ESPN row when matched (with Yahoo's `status` → `injury` via `YAHOO_STATUS` and Yahoo's `slot`), otherwise the same `missing: true` fallback shape `buildManualState` uses. `freeAgents` = pool rows whose `player_id` isn't matched to any roster in the league, run through `statePlayer`. `myTeamId` = the team with `mine`. Team ids are Yahoo's `team_id` numbers.
- [ ] **Step 1: Write failing tests:**
  - `parseLeagueBundle(fixture)`: the week comes from Yahoo `current_week`, `scoring:"ppr"`, slots `{QB:1, RB:2, WR:2, TE:1, FLEX:1, K:1, DST:1, BENCH:6, IR:1}` (match your fixture), and the team with `is_owned_by_current_login` has `mine:true`.
  - A roster position `DB` → throws a message containing `DB`.
  - `buildYahooState`: a matched player has his ESPN `proj_week` and Yahoo slot. An unmatched rostered player is present with `missing:true` and `proj_week:null`. No rostered player appears in `freeAgents`. `st.opponent()` is the scoreboard opponent.
  - A scoreboard with no matchup for my team → `st.opponent()` is `null`.
  - End to end: `pageJson(buildYahooState(...))` from `report.js` returns a page without throwing, and `report.js`/`season.js` are unmodified (`git diff --exit-code app/www/js/season.js app/www/js/report.js`).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd app && node --test`. Expect all PASS.
- [ ] **Step 5:** Commit: `feat(yahoo): build the week's SeasonState from a Yahoo league`.

### Task 5: App flow and screens

**Files:**
- Modify: `app/www/js/yahoo.js` (fetchers with injected `get`, like `espn.js`)
- Modify: `app/www/js/main.js` (`settings.source === "yahoo"`, `startYahoo`, league picker, sign-in-again; refactor `loadManualData` into `loadPool(scoring, week, force)` used by both paths)
- Modify: `app/www/js/ui.js` (`setupPage` gains a Yahoo-sign-in button when `yahooBeta`; `yahooLeaguesPage(leagues)`; `yahooSignInPage(message)`; the week page shows the one-line `oddScoring` note)
- Test: `app/test/yahoo.test.js` (fetchers), manual preview

**Interfaces:**
- Produces: `fetchMyLeagues(get) -> raw`, `fetchLeagueBundle(get, leagueKey) -> raw`. URLs are `/api/yahoo/v2/...`. Throws `YahooSignInError` on HTTP 401 `{"error":"signin"}`.
- Saved settings: `{source: "yahoo", leagueKey}`. The page cache key is `page.yahoo.<leagueKey>`, with the same last-good-page behavior as ESPN's `start()`.
- Flow: `#yahoo-signed-in` → `fetchMyLeagues`. With 0 leagues: "No Yahoo football leagues on this account" + the hand-entry button. With 1: save it and open it. With 2 or more: `yahooLeaguesPage`. On `YahooSignInError` anywhere: `yahooSignInPage`, with one button linking to `/api/yahoo/login`.
- Remove the Task 2 temporary screen.

- [ ] **Step 1: Write failing tests** for the fetchers: the URLs built for a key, and a 401 `{"error":"signin"}` → `YahooSignInError`.
- [ ] **Step 2:** Run → FAIL. Implement the fetchers. Run → PASS.
- [ ] **Step 3:** Wire up `main.js`/`ui.js`. The ESPN predictions are fetched for **Yahoo's week** (`loadPool(bundle.scoring, bundle.week)`).
- [ ] **Step 4:** Preview locally with a stubbed `get` that serves the fixtures (a dev-only `?yahoofixture` switch, removed before commit, or a temporary local file). Check: one league auto-opens, the picker shows for two, the sign-in-again screen appears on 401, the week page renders with the opponent, and the ESPN path and hand-entry path are still unchanged. Take a screenshot as proof.
- [ ] **Step 5:** `cd app && node --test`. Expect all PASS.
- [ ] **Step 6:** Commit: `feat(yahoo): sign in and open a Yahoo league in the app (hidden beta)`.

### Task 6: Check against the real league, then switch it on

- [ ] **Step 1:** When the kid is available: sign in with their account (on the live site, beta flag on) and capture the real `leagues` and league-bundle responses into `fixtures/yahoo_*_real.json`. Remove personal names if the user wants.
- [ ] **Step 2:** Re-run Tasks 3–4 tests against the real fixtures. Fix the parsers wherever the documented shape was wrong.
- [ ] **Step 3:** Compare the app's Yahoo week page with the kid's Yahoo app: same roster, same current slots, same opponent.
- [ ] **Step 4:** Remove the `yahooBeta` gate. In `setupPage`, "Yahoo league" becomes the main Yahoo button, and hand entry becomes a smaller link. Update the stale header comment in `manual.js` and the status in `docs/yahoo-api-access.md`.
- [ ] **Step 5:** `cd app && node --test`, preview, then ask the user before pushing.
- [ ] **Step 6:** Commit: `feat(yahoo): Yahoo sign-in is the main way to add a Yahoo league`.
