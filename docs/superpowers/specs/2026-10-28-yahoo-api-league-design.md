# Yahoo leagues through the Yahoo API — design

Status: approved 2026-10-28 ("first build it"). Replaces hand entry
(`2026-10-15-yahoo-manual-roster-design.md`) as the main Yahoo path; hand entry stays as a
fallback. Access history and the live tests are in `docs/yahoo-api-access.md`.

## 1. Intent

The younger kid (Yahoo-only league **1314371**, iPhone, website saved to the Home Screen)
currently types their whole roster into the app by hand and re-edits it after every
add/drop. Instead: they **sign in to Yahoo once, tap their league**, and get **the same
week page and the same math an ESPN league gets**: best lineup, lineup changes against
what's actually set in Yahoo, close calls, questionable backups, IR, byes, drops,
pickups, stash, and this week's opponent.

Why now: Yahoo switched API access on for app `E3dGN7Cx` on 2026-10-28 (confirmed live:
`game/nfl` and the user's league list return 200).

Success: from a fresh iPhone Home Screen app, the kid gets from "Yahoo league" to their
week page in under a minute. After that, opening the app goes straight to the week page,
with no sign-in for the rest of the season.

## 2. Goals, non-goals, anti-goals

**Goals**
- Sign in with Yahoo, see the user's Yahoo NFL leagues, tap one (auto-open if only one).
- Build the **same `SeasonState`** the ESPN path builds, so `season.js`, `report.js`
  and the week page run **unchanged**.
- Stay signed in for the season (refresh the token silently).

**Non-goals (this project)**
- Android app support for Yahoo API sign-in (Android keeps hand entry for Yahoo for now).
- ESPN private leagues on iPhone (separate project; it could reuse the server helper later).
- Making moves in Yahoo (read-only scope `fspt-r`; the kid sets the lineup in Yahoo).
- Custom scoring beyond points per reception (same limit as hand entry).

**Anti-goals (a failure even if it "works")**
- A Yahoo page that looks or behaves differently from the ESPN page.
- Separate decision math for Yahoo. There is exactly one copy of the rules (`season.js`).
- Storing anyone's league data or tokens on the server.
- A player silently missing from the roster because he couldn't be matched.
- The Client Secret anywhere but Cloudflare's secret store (never in git, never in the page).

## 3. Decided (with the rejected alternative)

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Predictions | **ESPN public predictions** (`leaguedefaults/3` PPR, `/1` standard, half = average), the same pool hand entry uses | Yahoo predictions: **not available**. Live test 2026-10-28: `stats;type=projected_week`, `projected_season`, `projected` → 400 "Invalid type"; `projected_stats` → 400 "Invalid player resource"; next week's `type=week` is all zeros. Past stats alone are a weak predictor and would fork the math |
| Rosters, lineup slots, matchup, records, roster settings | **Yahoo API** | Hand entry (the problem this solves) |
| Injury status for rostered players | **Yahoo's** (what the kid sees in the Yahoo app), mapped to ESPN's words | ESPN's status (could disagree with Yahoo) |
| Choosing the league | Sign in → list of the user's Yahoo NFL leagues → tap; auto-open if exactly one | Typing the league ID (signing in already tells us the leagues; the user agreed) |
| Which team is "mine" | The team Yahoo marks as owned by the signed-in user | Pick-your-team screen (not needed: Yahoo knows) |
| Where Yahoo plugs in | New adapter `yahoo.js` that builds a `SeasonState`, like `manual.js` does | Teaching `buildState` a second input (mixes sources into the core) |
| Talking to Yahoo | A small **Cloudflare Pages Function** under `/api/yahoo/*` on the same site | Calling Yahoo from the page: Yahoo sends no CORS headers, and the token swap needs the Client Secret |
| Keeping the sign-in | Refresh token in a **cookie on the phone** (HttpOnly, Secure, SameSite=Lax, Path=/api/yahoo); the server stores nothing | Server-side session store (adds a database and holds kids' tokens) |

## 4. How it works

### 4.1 Flow (web)

1. Start screen gains **"Yahoo league"** (hand entry moves behind a smaller "enter roster
   by hand" link).
2. Tap → `/api/yahoo/login` → Yahoo sign-in → "I agree" → Yahoo returns to
   `/api/yahoo/callback` → the function swaps the code, sets the cookie, and redirects
   to the site.
3. The app asks for the user's NFL leagues for the current season. If there's one, it opens.
   If there are several, it shows a list. If there are none, it says so and offers hand entry.
4. Saved setting: `{source: "yahoo", leagueKey}`. The next launch goes straight to the week page.
5. If the cookie is gone or Yahoo refuses the refresh, the app shows "Sign in to Yahoo
   again" (one tap), not an error page.

### 4.2 Server helper (Cloudflare Pages Function)

- `GET /api/yahoo/login`: redirect to Yahoo `request_auth` with a random `state`
  (also set as a short-lived cookie). Scope `fspt-r`.
- `GET /api/yahoo/callback`: check `state`, swap the code (Basic auth with
  `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` from Pages environment variables), set the
  refresh-token cookie (and the 1-hour access token, so most requests skip a refresh),
  then redirect to `/`.
- `GET /api/yahoo/v2/<path>`: relay to `https://fantasysports.yahooapis.com/fantasy/v2/<path>?format=json`
  with the user's access token. Refresh first if needed, and update the cookies. **GET only, and
  only to that host and prefix**, so it can't be used as an open proxy.
- `POST /api/yahoo/logout`: clear the cookies.
- Redirect URI registered with Yahoo is already
  `https://fantasyfootball-af1.pages.dev/api/yahoo/callback`.

### 4.3 What `yahoo.js` fetches and builds

From Yahoo (through the helper): the user's leagues; the chosen league's settings (roster
positions, the points-per-reception stat modifier), current week, standings (records),
every team's roster for the current week (player name, NFL team, position, eligible
positions, selected position, injury status), and this week's scoreboard (opponent).

From ESPN (public, as today): the current-week prediction pool for the league's scoring,
and the NFL schedule (`pro`), both through the existing cached loaders in `main.js`.

Built: `new SeasonState({season, week, slots, teams, schedule, pro, freeAgents, myTeamId})`,
exactly the fields `state.js` produces for ESPN, with players run through `statePlayer`.

- **Scoring:** reception modifier 1 → `ppr`, 0.5 → `half`, missing/0 → `standard`.
- **Slots:** Yahoo `QB RB WR TE K` as-is, `W/R/T` → `FLEX`, `Q/W/R/T` → `OP`, `DEF` →
  `DST`, `BN` → `BENCH`, `IR` → `IR`. Any other slot: a clear "this league has a roster
  spot the app doesn't handle yet" message, the same as ESPN's unknown-slot handling in `season.js`.
- **Player matching** (Yahoo → ESPN pool row): normalized full name + NFL team, position
  as a tiebreak. Defenses are matched by NFL team. A rostered player with no match still
  appears on his team, with no prediction (like hand entry's `missing`), and is never dropped.
- **Injury mapping:** Yahoo `Q` → `QUESTIONABLE`, `D` → `DOUBTFUL`, `O` → `OUT`,
  `IR`/`IR-R`/`PUP*`/`NFI*` → `INJURY_RESERVE`, `SUSP` → `SUSPENSION`, `NA` → `OUT`.
  Free agents keep ESPN's status (we don't fetch Yahoo data for them).
- **Free agents:** ESPN pool minus every player on any Yahoo roster in the league (by matched id).
- **Opponent:** from the scoreboard, as `schedule` entries `{period, home, away}`.

### 4.4 First thing to build: a spike on iPhone Home Screen sign-in

Home Screen web apps on iPhone keep storage separate from Safari. The risk: the Yahoo
round trip ends up in Safari, or the cookie lands in Safari's storage instead of the app's.
Build the bare login → callback → "signed in as …" page first and test it on a real iPhone
from the Home Screen. If the cookie doesn't land in the app, the fallback is to pass a
one-time code back the way league transfer links already work (paste into the app). That
choice is made from what the spike shows, before the rest is built.

### 4.5 Settled after review (designer's calls, not discussed with the user)

- **Spike fallback stays server-free.** If the cookie doesn't reach the Home Screen app,
  the callback page shows the refresh token **encrypted with a server-held key** as a
  paste-in link (like transfer links). The app keeps that blob in `localStorage` and sends
  it in a request header; the helper decrypts it per request. Still nothing is stored on the server.
- **Trying it before kids see it:** Yahoo only accepts the production callback, so the
  helper ships to the live site early but the **"Yahoo league" button stays hidden**
  behind a flag (e.g. opening `/#yahoo-beta` once) until the whole flow works.
- **Week:** Yahoo's current week wins (roster, slots and opponent all come from it), and
  the ESPN predictions are fetched **for that week**.
- **Existing hand-entered league:** left in place, no migration. The Yahoo league is a new
  saved league (`{source: "yahoo", leagueKey}`). `CONFIG_VERSION` is untouched. A Yahoo
  league keeps an offline last-good page like ESPN does.
- **Scoring the app can't model** (e.g. 6-pt passing TDs, bonuses): proceed using the
  nearest of PPR/half/standard, and show a one-line note on the page saying so. Don't refuse.

## 5. Constraints

- Hand entry (`manual.js`, saved configs, transfer links) keeps working unchanged for
  existing users and for Android.
- One copy of the rules: no Yahoo-specific branches in `season.js` / `report.js`.
- Deploy is `git push` to `in-season-m1` (web on Cloudflare Pages, Android APK build).
  Preview the page before every push.
- `game_key` changes every season: look it up, never hard-code `470`.
- Cloudflare Pages Functions free tier is enough (a handful of requests per page load).
- The user sets the Cloudflare secret themselves; nobody pastes it into chat.

## 6. Left to the builder

- Exact Yahoo request batching (one combined `league/…;out=…` call vs several).
- Name-normalization details and the Yahoo↔ESPN NFL team abbreviation table.
- Cookie names and lifetimes, and the error wording (in the app's plain style).
- Test fixtures (user's call, 2026-10-28): **build first** from Yahoo's documented
  response shapes (plus the real `game`/`player` responses already seen), with hand-made
  fixtures in `fixtures/`. Then, when the kid is available, sign in with their account,
  capture real league responses, and fix `yahoo.js` against them. Unit-test the way
  `espn.test.js` / `manual.test.js` do.
- Where the `functions/` folder must sit for this Pages project (check the project's
  root-directory setting in Cloudflare before building).
