# In-season assistant — design

**Date:** 2026-09-16
**Status:** Approved. Parked before implementation. Resume with an implementation plan.
**Supersedes:** nothing. The draft tool is unchanged by this work.

---

## 1. Context

The existing app is a draft-night assistant: a local FastAPI server, VORP against the
league's actual roster slots, manual pick entry. It was used for the real 2026 draft on
2 September. `draft_state.json` shows 110 of 160 picks entered — entry was abandoned
around round 11 because the pick-entry model (Enter vs Shift+Enter) was too slow under
time pressure.

The draft is over. The season is live (week 2 at time of writing). This spec covers
**extending the tool to in-season weekly management**, which is the part that is useful
now. Redesigning the draft UI is a separate, later project.

### Why this is worth building — evidence from the live roster

Pulled from ESPN on 2026-09-16 for team "Subha's Avengers" (id 3):

| slot | player | week-2 proj |
| --- | --- | --- |
| WR | A.J. Brown | **0.0** |
| FLEX | Rico Dowdle | 10.2 |
| DST | Lions D/ST | 3.5 |

Bench at the same moment: J.K. Dobbins 11.8, Isaiah Likely 11.7, Rams D/ST 5.9.

Currently-set lineup projects **121.2**. The optimal legal lineup projects **136.9**.
That is **+15.7 points left on the bench**, in a league where matchups are routinely
decided by less. A player projected for zero was in the starting lineup. This is the
problem the tool exists to solve, and it recurs every week.

---

## 2. Decisions made, and the evidence behind them

These were settled during design. Treat them as fixed constraints unless new evidence
appears.

### 2.1 Deployment: local-first

**Decision:** extend the existing local Python app. Do not host anything yet.

**Why:** hosting was explored in depth and blocked on authentication (§2.2). Building
locally keeps `engine.py` untouched, requires no JavaScript port, and delivers working
features immediately. Hosting is revisited once the features are proven, with real usage
informing the choice.

**Rejected:** deploying a Python backend to AWS/Fly/Render now. It front-loads
credential custody, auth, HTTPS and uptime work before we know the features are right.

### 2.2 ESPN authentication — what was tested and found

All findings are from live read-only probes against league `1170673738`, season 2026.

| test | result |
| --- | --- |
| League read with no cookies | `401 not authorized` — **this league is private** |
| A known public league, no cookies | `200`, 10 teams — public leagues need no auth |
| CORS preflight from a foreign origin | `200`, `Access-Control-Allow-Origin` echoed, `Allow-Credentials: true` |
| Browser fetch from `espn.com`, `credentials:'include'` | `200`, 10 teams |
| Browser fetch from `example.com`, `credentials:'include'` | **`401` — cookie withheld** |
| `espn_s2`/`SWID` as query parameters | `401` |
| `X-ESPN-SWID` / `X-ESPN-S2` headers | `401` |
| `Authorization: Bearer <espn_s2>` | `401` |
| Raw `Cookie` header | **`200` — the only method that works** |
| Cookie + foreign `Origin` header | `200` — ESPN does not reject foreign origins |

**Conclusions:**

1. ESPN offers **no OAuth** for third parties. The fantasy API is private and undocumented.
2. Only the `Cookie` header authenticates. Browsers are **forbidden** from setting it
   (`Cookie` is on the Fetch spec's forbidden-header list).
3. ESPN's session cookie is `SameSite=Lax` or `Strict` — it is not sent on cross-site
   requests. Confirmed by the `espn.com` → 200 / `example.com` → 401 pair.
4. Therefore **a pure static web app cannot read a private league**, with or without a
   pasted cookie. The only paths are: make the league public, run a server-side proxy,
   ship a browser extension, or run locally.
5. `espn_s2` is `HttpOnly`, so a bookmarklet cannot read it either.

This is why commercial tools (FantasyPros, PFF, Draft Sharks) all ship browser
extensions. They had no alternative.

**Implication for later hosting:** if the app is ever shared, the cheapest good answer is
to set the leagues to publicly viewable, which removes authentication entirely. That was
declined for now.

### 2.3 No LLM and no web scraping in phase 1

**Decision:** phase 1 uses the ESPN league API as its only data source.

**Why:** the payload already carries everything the features need — see §4. ESPN's public
news endpoints are blocked anyway (`403` and `500` when probed). An LLM layer over player
news is explicitly a **phase 2** addition, to be added once the app is running and usable.

### 2.4 Trade suggestions are deterministic

Phase 1 trade logic is arithmetic only, with the arithmetic shown. No model, no
"confidence". Rationale in §5.3.

---

## 3. Scope

### In scope

- Start/sit optimizer for the current week, surfacing only actionable deltas.
- Waiver wire and free-agent ranking, scored against *this* roster.
- League standings and current matchup.
- Deterministic trade finder.
- Matchup context (opponent, kickoff, bye) shown inline next to each player.
- A new web UI for the above, served by the existing app.

### Out of scope (explicitly)

- Draft UI redesign and the Enter/Shift+Enter fix — **separate project, revisit before
  August 2027.**
- Mobile/PWA packaging — deferred with hosting.
- Hosting of any kind.
- Roster import by image upload / OCR — **rejected**: an authenticated GET returns the
  same data exactly, and OCR adds a silent-corruption failure mode.
- Writing to ESPN (setting lineups, filing claims, sending trades). The app advises;
  the user acts in ESPN. Read-only is a deliberate safety boundary.
- LLM news reasoning — phase 2.
- Playoff-schedule-aware valuation — phase 2.

---

## 4. Architecture

```
DRAFT (existing, frozen)        SHARED DATA                 SEASON (new)
  engine.py                       sources.py (modified)       league.py
  static/index.html               snapshot.db (+ cache)       season.py
                                                              static/season.html
                          app.py (modified: routes + CLI)
```

### 4.1 Modules

| module | status | responsibility |
| --- | --- | --- |
| `engine.py` | **unchanged** | Draft math: `Board`, `DraftState`, VORP, replacement ranks |
| `sources.py` | modified | ESPN fetch + persistence. Gains roster/matchup/free-agent/weekly-projection fetches |
| `league.py` | **new** | Models the live league: `League`, `Team`, `SeasonState` |
| `season.py` | **new** | Decision math: `best_lineup`, `close_calls`, `waiver_targets`, `trade_ideas` |
| `app.py` | modified | Routes for both apps; CLI gains `refresh` and `week` |
| `static/season.html` | **new** | Home / Standings / Trades |

### 4.2 Why two new modules rather than extending `engine.py`

A draft asks *"who is the best available player, given a pool that drains."* A week asks
*"what is the best arrangement of players I already own."* They share **replacement level**
as a concept and nothing else — different state, different lifecycle, different failure
modes.

Folding them together produces a `Board` whose meaning depends on which mode it is in,
and a file where a waiver-logic change can silently break the draft board months later.
Keeping them separate means `engine.py` and its 15 passing tests remain a safety net for
the draft tool specifically.

**Rejected alternative:** one module, one app. Fewer files, but the coupling above is not
noticed until it breaks something seasonal.

**Secondary benefit:** if the app is later ported to JavaScript for hosting, only
`league.py` and `season.py` cross over. `sources.py` largely disappears inside a browser,
and `engine.py` need not come at all.

### 4.3 Routes

| route | serves |
| --- | --- |
| `/` | season app |
| `/draft` | existing draft board (moved from `/`) |
| `/api/season/state` | current week, my team, standings, matchup |
| `/api/season/lineup` | optimal lineup + deltas vs. currently set |
| `/api/season/waivers` | ranked free agents |
| `/api/season/trades` | trade suggestions |

### 4.4 Data layer and caching

- ESPN is the only source. Endpoint and cookie auth already exist in `sources.py`.
- Views used: `mRoster`, `mTeam`, `mMatchupScore`, `kona_player_info` (with an
  `x-fantasy-filter` header for free agents), `proTeamSchedules`.
- **Raw responses are cached to `snapshot.db` with a TTL** (default 30 minutes).
  This preserves the draft tool's best property — it works with the wifi off — and
  avoids hammering ESPN during development.
- `python app.py refresh` forces a cache refresh. The server refreshes on boot if stale.
- **The current week comes from ESPN's `scoringPeriodId`, never computed from a date.**
  NFL weeks do not align to calendar weeks and flex scheduling moves games.

### 4.5 Fields the features depend on

Confirmed present in the live payload:

| field | used for |
| --- | --- |
| `stats[]` where `statSourceId==1` and `scoringPeriodId==N` | weekly projection |
| `stats[]` where `statSourceId==1` and `scoringPeriodId==0` | rest-of-season projection |
| `eligibleSlots` | lineup legality — which slots a player may fill |
| `lineupSlotId` | what the user currently has set |
| `injuryStatus` | injury flags |
| `ownership.percentStarted` | crowd sanity check on start/sit |
| `ownership.percentChange` | "the market is moving" signal on waivers |
| `seasonOutlook` | ESPN's written player note, displayed verbatim |

`statSourceId`: 0 = actual, 1 = projected. `scoringPeriodId`: 0 = full season, N = week N.

**Known fragility:** `sources.py` already warns that ESPN has changed lineup-slot IDs
before. Any roster-reading feature inherits this. Mitigated by a fixture test (§7).

---

## 5. Features

### 5.1 Start/sit optimizer

**Input:** my roster with per-player week-N projections and `eligibleSlots`.
**Output:** the optimal legal lineup, and the delta list against what is currently set.

**Algorithm:** fill dedicated slots with the top projected player at each position, then
fill FLEX with the best remaining eligible players.

**This is exact, not a heuristic.** Correctness depends on eligibility being *nested* —
FLEX accepts every position that competes for it, so demoting a player into a dedicated
slot can never free enough value elsewhere to pay for itself. A sort gives the optimum;
no solver is needed, and the result is checkable by eye.

> **Code comment required at this assumption.** The nesting holds for the current slot
> set (QB 1, RB 2, WR 2, TE 1, FLEX 2, DST 1, K 1) and would still hold if a superflex/OP
> slot accepting QB were added. A slot accepting an arbitrary subset — say "RB or TE only"
> — would break it and require real maximum-weight bipartite matching. Fail loudly rather
> than silently degrade if such a slot appears.

**What it displays:** only the deltas, never ten obvious starts. Each row shows
out-player, in-player, and points gained, plus `percentStarted` for both as a crowd check.

**Close-call flagging.** A start/sit decision is flagged as close when the margin between
the chosen starter and the best benched alternative is below `CLOSE_CALL_MARGIN`,
**default 2.5 projected points**, declared as a named constant beside the existing
arguable constants in the codebase.

> **Decision made on the user's behalf, flagged for review:** `percentStarted` is
> *displayed* next to close calls but is **not** folded into the threshold. Reason:
> mixing a points margin with a crowd percentage into one score produces a number nobody
> can interpret. Keep them as two independent signals the reader combines. Easy to change
> — it is one constant and one display rule.

**Honest limitation:** ESPN publishes no variance with its projections, so a fixed margin
is a stand-in for real uncertainty. A 2.5-point gap between two RBs is not the same
decision as a 2.5-point gap between two kickers, and this model cannot tell the difference.

### 5.2 Waiver wire

**Value of a free agent = marginal lineup improvement**, not rank:

1. Add the candidate to the roster.
2. Drop the worst bench player.
3. Recompute the optimal lineup (§5.1).
4. Score = new total − current total.

So a WR5 who would crack the FLEX outranks a bigger name who would sit. This is the same
replacement-level idea as the draft tool, with the pool being "everyone available in this
league" rather than "everyone undrafted."

Runs `best_lineup()` roughly 200 times. Negligible cost.

`ownership.percentChange` rides alongside as a **market-movement flag** — 100k managers
reacting to a beat report is a faster signal than the report, and it needs no NLP.

### 5.3 Trade finder

For each of the 9 other teams, test every 1-for-1 swap:

1. Recompute **my** optimal rest-of-season lineup with the swap applied.
2. Recompute **theirs**.
3. Suggest only if **both** totals rise.

Search space is 16 × 16 × 9 = 2,304 combinations. Brute force; no optimisation needed.
Every suggestion displays the arithmetic that produced it and the positional surplus or
shortage on each side that motivated it.

**Honest limitations, to be stated in the UI and not just here:**

- It assumes the other manager values projections the way this tool does. They do not.
  **Expect most suggestions to be declined.** The tool identifies trades that *should*
  appeal, not trades that *will* be accepted.
- Rest-of-season projections ignore playoff schedule in phase 1.
- Bye-week conflicts are **flagged but not optimised around**.

### 5.4 Home screen composition

One screen answering "what do I do this week", in priority order:

1. Problem players — zero/low projections, injury designations, byes.
2. Lineup deltas from §5.1, with the total points gained.
3. Close calls from §5.1.
4. Top waiver targets from §5.2 — placed directly below problem players, so a flagged
   injury sits next to its replacement.
5. Each player row carries opponent, kickoff time and bye inline.

Standings and current matchup live on a second tab. Trades on a third. **There is no
standalone NFL-schedule tab** — a schedule you cannot act on is not a decision aid; the
useful half is the inline matchup context above.

---

## 6. Constants to argue with

Following the existing codebase convention of naming judgment calls so they can be
challenged rather than reverse-engineered:

| constant | default | effect |
| --- | --- | --- |
| `CLOSE_CALL_MARGIN` | 2.5 pts | Below this, a start/sit decision is flagged as close |
| `CACHE_TTL_MINUTES` | 30 | How stale ESPN data may be before refetch |
| `WAIVER_SHORTLIST` | 5 | How many free agents Home shows |
| `TRADE_MIN_GAIN` | 1.0 pt | Minimum gain on *each* side before a trade is suggested |
| `LOW_PROJECTION_FLAG` | 3.0 pts | Below this, a starter is flagged as a problem |

---

## 7. Testing

Following `test_engine.py`'s existing model — synthetic data, no network, runnable with
nothing installed but Python.

1. **`test_season.py` — unit tests on synthetic rosters.**
   - Optimal lineup on a hand-built roster with a known answer.
   - FLEX contention: the best remaining RB and WR compete for two FLEX spots.
   - A zero-projection starter is always benched when any positive alternative exists.
   - Multi-eligible players (`eligibleSlots` spanning positions) are placed correctly.
   - Waiver scoring returns zero for a player who would not crack the lineup.
   - Trade finder never returns a swap where either side loses.

2. **Fixture test against a recorded ESPN response.**
   A saved JSON capture of a real `mRoster`+`mTeam` response, committed to the repo, with
   assertions on parsing: slot IDs map to the expected slots, projections are extracted
   from the right `statSourceId`/`scoringPeriodId` pair, all 10 teams parse.

   **This is the important one.** It is what catches ESPN changing slot IDs without the
   failure being silent — the specific fragility `sources.py` already warns about.

3. **No test hits the live ESPN API.** Probes during development are manual and
   read-only.

---

## 8. Phase 2 — deliberately deferred

| item | why deferred |
| --- | --- |
| LLM reasoning over player news | Phase 1 proves the math first. An LLM on top of a wrong model produces confident wrong answers |
| Web scraping for news | ESPN's news endpoints are blocked; needs a source decision |
| Hosting | Blocked on §2.2. Revisit once features are proven |
| Mobile / PWA packaging | Follows hosting |
| Playoff-schedule-aware valuation | Meaningful only once rest-of-season value is trusted |
| Draft UI redesign + pick-entry fix | Separate project. Needed by August 2027, not now |

---

## 9. Immediate action, independent of this build

The optimizer was run by hand against the live roster on 2026-09-16. Before week 2 locks:

| change | from | to | gain |
| --- | --- | --- | --- |
| WR | A.J. Brown 0.0 | Parker Washington 12.3 | +12.3 |
| FLEX | Rico Dowdle 10.2 | J.K. Dobbins 11.8 | +1.6 |
| FLEX | (vacated by Washington) | Isaiah Likely 11.7 | — |
| DST | Lions D/ST 3.5 | Rams D/ST 5.9 | +2.4 |

**121.2 → 136.9 projected, +15.7 points.**

---

## 10. Next step

Produce an implementation plan from this spec (`writing-plans`), then implement.

Suggested build order, each independently useful:

1. `sources.py` fetch additions + cache table + fixture test.
2. `league.py` + `season.py::best_lineup()` + `test_season.py`.
3. Home screen showing lineup deltas only. **Ship here — this is the +15.7 points.**
4. Waivers on Home.
5. Standings tab.
6. Trade finder tab.
