# Draft board

A local draft assistant for a 10-team ESPN league. One Python process, no build step,
no network dependency once the snapshot is on disk.

## What this does that FantasyPros' own cheat sheet doesn't

It computes **value over replacement against your league's actual roster slots**, and
it recomputes replacement level after every pick as the pool drains. Consensus rank
can't do this, because rank doesn't know how many teams are in your league.

In your 10-team league that matters a lot. Replacement level for RB lands around RB25
instead of RB30, which means the marginal RB is meaningfully better than the one a
12-team drafter is settling for. Most draft advice you read is calibrated to 12 teams
and will push you toward RBs earlier than your league justifies.

The second thing it does is quantify **the cost of waiting**. When you're on the clock
the real question is never "who's ranked highest," it's "if I take the WR now, what RB
is still here in 12 picks?" That's the panel on the right.

## Setup

```bash
pip install -r requirements.txt
cp config.example.json config.json     # then fill it in
```

`config.json`:

| field | where to get it |
| --- | --- |
| `fantasypros_api_key` | secure.fantasypros.com/api-keys/request |
| `espn.league_id` | the `leagueId=` in your ESPN league URL |
| `espn.espn_s2`, `espn.swid` | browser dev tools → Application → Cookies, only if the league is private |
| `my_draft_slot` | your draft position, 1-indexed. Set this once the order is drawn. |

Then:

```bash
python app.py check-espn   # confirms it read your scoring and roster slots correctly
python app.py prefetch     # pulls FantasyPros into snapshot.db
python app.py serve        # http://127.0.0.1:8777
```

No key yet? `python app.py demo` builds a synthetic board with fake names and real
math, so you can drill the keyboard flow.

## Read this before draft night: there is no ESPN live sync

ESPN's read API (`lm-api-reads.fantasy.espn.com`, view `mDraftDetail`) is reliable for
a **completed** draft. It is not a live feed. The ESPN draft room runs on a separate
real-time service.

The evidence is what the paid tools do. FantasyPros' ESPN sync requires their Chrome
extension with the draft room open in the same browser; their mobile app supports only
the *manual* assistant for ESPN. PFF requires the same setup and documents a resync
step where you sit on the Pick History tab for 60 seconds. Draft Sharks also ships a
Chrome extension. Three companies with engineering teams all read the DOM of a tab you
have open. If polling worked, none of them would.

So this tool is **manual entry first, by design**. You type each pick as it happens.
With fuzzy search that's about three keystrokes per player, and you have nine picks to
enter between your turns in a 10-team league — dead time you'd otherwise spend
watching someone else deliberate.

If you want automation later, the honest path is a Playwright-driven browser scraping
the draft room DOM, same as the extensions. Build it after the manual path works, and
validate it in a mock draft, never as your only input.

## Keyboard

| key | action |
| --- | --- |
| any letter | jumps to search |
| ↑ ↓ | move through matches |
| Enter | someone else drafted him |
| Shift+Enter | **you** drafted him |
| Ctrl/Cmd+Z | undo last pick |

State persists to `draft_state.json` after every pick, so a browser crash or an
accidental refresh costs you nothing. `python app.py reset` clears it.

## Assumptions you should know about

These are judgment calls, not facts. They're in the code as named constants so you can
argue with them.

- **`FLEX_SHARE` in `engine.py`** — flex slots are assumed to be filled 45% RB, 45% WR,
  10% TE. This moves replacement level. If your league flexes almost entirely RB, raise
  the RB share and RBs get less valuable, not more (deeper replacement).
- **`_expected_taken`** — guesses how many players at a position go before your next
  turn, proportional to how much of the top of the board that position occupies. It's a
  heuristic. It will be wrong when your league has a run.
- **Need bonus in `recommend()`** — only +8 points for an unfilled starting slot. It's
  deliberately small. Drafting for need over value is the most common way to end up with
  a mediocre team.
- **FantasyPros scoring buckets** — the API accepts only PPR / HALF / STD. If your league
  has custom scoring, `check-espn` will show you the real values and the tool will snap
  to the nearest bucket. Projections will be slightly off in a predictable direction.

## Draft-day checklist

**A week out**
- [ ] `check-espn` output matches what you see in your league settings page
- [ ] `prefetch` reports zero unmatched players in the top 200
- [ ] `python test_engine.py` passes

**The day before**
- [ ] Run `prefetch` again. Rankings move a lot in the last week.
- [ ] Join an ESPN mock draft and run the tool alongside it for a full 15 rounds. This
      is the only real test. You're checking that you can keep up with entry, not that
      the math works.
- [ ] Set `my_draft_slot` once the order is drawn

**Twenty minutes before**
- [ ] `prefetch` one final time for late injury news
- [ ] `python app.py reset`
- [ ] Server running, page open, second monitor or second window
- [ ] Confirm it still works with wifi off. It should. That's the point.

## Legal

FantasyPros' free tier is personal, non-commercial, non-production. Premium requires an
active HOF subscription and dies with it. Anything commercial needs a separate agreement,
and you may not build something that competes with FantasyPros. Credit them if you
publish analysis from this. Player headshots are Sportradar's and are not licensed here.
