# Mobile + web app (milestone 1) — design

Status: approved in brainstorm 2026-09-30 → 2026-10-02. Supersedes nothing; extends
`2026-09-16-in-season-assistant-design.md` (the Python app stays as-is).

## 1. Goal

Anyone with an ESPN league opens a link, enters a league ID, picks their team, and sees
the same "This week" answers the Python page gives: fix first, IR moves, lineup changes,
pickups, close calls, best lineup. First users: the owner and their two kids.

## 2. Decisions (with the rejected alternative)

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Where the math runs | Ported to plain JS, runs on the device | Pyodide (~10 MB, slow phone start); server (one IP hits ESPN for everyone, ops cost) |
| Private ESPN leagues | Android app (Capacitor) shows ESPN's real login in an in-app browser and reads `espn_s2`/`SWID` after sign-in; kept on the phone only | Cookie paste (too technical); server-stored cookies (full ESPN account access = liability); riding the browser's login cross-site (browsers withhold third-party cookies — measured 401) |
| Web app | Same code, **public leagues only**, Cloudflare Pages | Vercel (free tier is non-commercial) |
| iPhone | Later; code stays cross-platform | Needs a Mac/cloud build, $99/yr, stricter review |
| Scope | Weekly moves only | Draft board (unused until next August) |
| Accounts / server | None. League + team + cookies live on the device | — |
| Yahoo | Milestone 2: second adapter + small key-holding relay (Cloudflare Worker) | — |
| Builds | GitHub Actions builds the APK (work PC can't install JDK/Android SDK); Cloudflare Pages deploys the web app from git | Local builds |

Evidence (2026-10-02): ESPN preflight returns `Access-Control-Allow-Origin` echoed and
`Allow-Credentials: true`; signed-in fetch from an espn.com page → 200 (10 teams) with
`espn_s2`/`SWID` readable by page JS; same fetch from example.com → 401. A private league
and a nonexistent league ID both return 401 — UI copy must cover both.

## 3. Architecture

```
app/www/              web root (Cloudflare Pages output + Capacitor webDir), no bundler
  js/espn.js          ESPN adapter: fetch + parse -> platform-neutral shape (port of sources.parse_*)
  js/state.js         build state, find my team (port of league.py)
  js/season.js        decision math (port of season.py, same constants)
  js/report.js        report -> page JSON (port of app.api_season_week serializer)
  js/transport.js     web: fetch(); Android: CapacitorHttp with Cookie header
  js/login.js         Android only: in-app ESPN login, cookie capture
  js/main.js, ui.js   setup flow + This-week rendering
app/test/             node --test; parity test vs Python output on the recorded fixtures
.github/workflows/    android.yml: test -> build debug APK -> publish as GitHub Release "latest"
```

The platform-neutral shape uses plain slot/position names (`"IR"`, `"FLEX"`), never ESPN
ids, so a Yahoo adapter only has to produce the same shape.

**Parity rule:** `app/test/make_expected.py` runs the Python pipeline on `fixtures/` and
writes the page JSON; the JS test must produce the same JSON (numbers within 0.05).
Changing the math means changing both and regenerating.

## 4. Flows

- **Setup:** `/` → league ID (or `/league/<id>` pre-fills) → fetch league → if 401: web
  says "private or wrong ID — use the Android app"; Android opens ESPN sign-in → pick team
  (Android with SWID: auto-selected) → remembered on the device.
- **Links:** `/league/<leagueId>` only; team is never in the link (everyone in a league
  shares the link). Android also registers `ffweekly://league/<id>` for the web app's
  "Open in app" button. Verified https App Links wait for a stable release signing key.
- **Refresh:** on open and on button press; last good payload kept on the device and
  shown with its age if ESPN is unreachable.

## 5. Known limits (M1)

- Debug-signed APK: each CI build has a new key, so updating means uninstall → install →
  sign in again. A release keystore (needed for Play Store anyway) fixes this.
- Cookies stored in the app's private WebView storage, not the Android keystore.
- NFL schedule download is ~620 KB compressed; cached on the device for 12 hours.
