# Yahoo Fantasy API access: status and notes

Last updated 2026-10-28. No secrets in this file: the Client Secret lives only on
the Yahoo developer page (and, when built, in a Cloudflare secret).

## Where it stands

**Live in the website** (2026-10-28). "Sign in to Yahoo" on the start screen reads the
league through `/api/yahoo/*` (`functions/`) and `yahoo.js`. Tested on the kid's iPhone Home
Screen app: the sign-in round trip comes back into the app. Hand entry (`manual.js`) stays
as the fallback and is the only Yahoo path in the Android app. Cloudflare holds
`YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET` (Production).

| Step (from Yahoo's approval email) | Status |
|---|---|
| 1. Sign the API Access and Use Agreement (DocuSign, 2026-10-23) | Done |
| 2. Create a **new** app with Fantasy Sports permission | Done 2026-10-26 |
| 3. Submit the new Client ID on the Developer Application Confirmation Form | Done 2026-10-26 |
| Yahoo turns access on | Done 2026-10-28 |

Yahoo's email: *"Existing apps won't pick up the permission, so it has to be a new
one."* Only the app below can ever work.

## The app

- Name: **RosterOptimizer Web**, App ID **E3dGN7Cx**, Yahoo account scriptseed.sr@gmail.com
- Client ID (public, safe to share):
  `dj0yJmk9N2JhNjNRblJSVDU0JmQ9WVdrOVJUTmtSMDQzUTNnbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PTQy`
- Type: Confidential Client. API permission: Fantasy Sports, Read.
- Homepage: `https://fantasyfootball-af1.pages.dev`
- Redirect URI: `https://fantasyfootball-af1.pages.dev/api/yahoo/callback`

Old apps from October, which will never get access and can be deleted:
`G6Echvbq` (confidential) and `RKHcHyUV` (public).

## What was tested on 2026-10-26

1. Sign-in: `api.login.yahoo.com/oauth2/request_auth?client_id=…&redirect_uri=<above>&response_type=code&scope=fspt-r`
   → user ticks "I agree" → Yahoo returns to the site with `?code=…`. **Works.**
   (The site has no handler at that path yet, so it shows the home page; the code is
   still readable from `performance.getEntriesByType('navigation')[0].name`.)
2. Token swap: POST `api.login.yahoo.com/oauth2/get_token`, Basic auth
   `client_id:secret`, `grant_type=authorization_code`, same `redirect_uri`.
   **Works**: 1-hour access token plus refresh token.
3. API call: `fantasysports.yahooapis.com/fantasy/v2/game/nfl?format=json` →
   **403 "This application is not authorized to perform this action."** That's the same
   as before approval, so access isn't switched on yet.

## What was tested on 2026-10-28 (after the "access is live" email)

Same sign-in and token swap as above, both worked. Then:

| Call | Result |
|---|---|
| `game/nfl` | **200**: game_key `470`, season 2026 |
| `users;use_login=1/games;game_keys=nfl/leagues` | **200**, empty `leagues` (the signed-in account is in no league) |
| `league/470.l.1314371` | 403 *"you are not in this league"* |

The last 403 is about the **person**, not the app: Yahoo only shows a league to its
members. So each kid must sign in with their own Yahoo account, which matches the
plan below. League keys are `<game_key>.l.<league_id>`, and `game_key` changes each season.

## How to retry (about 1 minute)

1. Put the Client Secret in `Desktop\yahoo_secret.txt` (one line, never in chat or git).
2. Open the sign-in URL above; user clicks "I agree", then Next.
3. Swap the code for a token, then call `game/nfl` and
   `users;use_login=1/games;game_keys=nfl/leagues`.
4. 200 with data = access is on. Delete `yahoo_secret.txt` afterwards.

## Once access works: the plan (still being designed)

Goal: a kid types their Yahoo league ID (younger kid's league: **1314371**), signs in
to Yahoo once, and sees the same weekly advice as an ESPN league.

- Both kids use the **website on iPhone** (Home Screen), so the web path matters most.
- Yahoo's API sends no CORS headers and the token swap needs the secret, so a
  small **Cloudflare Pages Function at `/api/yahoo/*`** does the swap and relays calls.
  The user's Yahoo pass stays on their phone (cookie); nothing is stored server-side.
- A `yahoo.js` adapter (same shape as `manual.js`) replaces hand entry; hand entry
  stays as a fallback. Yahoo has no projections, so ESPN public projections are still used.
- Risk to spike first: the sign-in round trip from an iPhone **Home Screen** app,
  which keeps storage separate from Safari.

## Separate issue: ESPN private leagues on iPhone

The website can only read **public** ESPN leagues, because browsers won't send espn.com's
sign-in to our site. In-app ESPN sign-in exists only in the Android app. So the
older kid's private ESPN league can't open on his iPhone today. The same Cloudflare
helper idea could fix that later; it's a separate project, after Yahoo.
