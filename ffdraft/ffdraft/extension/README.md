# Browser plugin

## Why this one doesn't read picks yet

ESPN's draft room is a React app. Its CSS class names are generated and change between
seasons, so any selector I wrote today would be a guess. A plugin built on guessed
selectors doesn't fail loudly — it returns nothing and looks fine, which you'd discover
in round three.

The draft room also receives picks over a **WebSocket**, as structured JSON. That's a far
better source than scraped text: it has real player IDs, it doesn't break when ESPN
restyles a component, and it arrives the instant the pick is made. But I don't know the
frame format, and I'm not going to invent one.

So this plugin does recon. It taps every WebSocket frame, `fetch`, and XHR on the page
and ships them to your local board. You run a mock draft, we look at what actually came
back, and then we write a parser against real data.

## Install

1. Start the local board: `python app.py serve`
2. Chrome → `chrome://extensions` → turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Open an ESPN mock draft. **Open it after installing** — `inject.js` has to replace
   `window.WebSocket` before ESPN's bundle constructs one, so a tab that was already
   open sees nothing. Reload it if in doubt.
5. Click the extension icon. It should say "Local board connected" and the websocket
   frame counter should climb.

## Capture and analyze

Let a mock draft run for ten picks, then:

```bash
python analyze_recon.py
```

It groups traffic by endpoint, scores each stream on how pick-shaped it is, prints
sample frames, and lists every JSON key it saw. Output looks like:

```
Streams ranked by how pick-shaped they look:
  score  6      2 msgs  ws-msg      wss://fantasy.espn.com/draft  <-- LOOK HERE
  score  0      1 msgs  ws-msg      wss://chat.espn.com/x
```

Send me that output and I'll write the parser. The parser needs exactly two things: the
key holding ESPN's player ID, and the key holding the overall pick number.

## The part after that, which is the actual hard part

ESPN's WebSocket will give you an ESPN player ID like `4262921`. Your board is keyed on
FantasyPros IDs. Those two systems have never agreed on anything.

Bridging them means pulling ESPN's player list:

```
GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/players?view=players_wl
    header: X-Fantasy-Filter: {"filterActive":{"value":true}}
```

and joining it to your snapshot on normalized names. That join will not be clean.
Expect failures on suffixes, team defenses, and rookies whose names ESPN spells
differently. The crosswalk has to be built and **verified against the top 200** days
before the draft, not on draft night.

This is why the manual path stays. A silent crosswalk miss looks identical to a player
nobody has drafted.

## Rollout plan

| stage | what you have | what you trust |
| --- | --- | --- |
| now | manual entry | manual entry |
| after recon | manual entry + captured frames | manual entry |
| after parser | auto-picks appear, you verify each | manual entry |
| after one clean mock draft | auto-picks | auto, with manual as backup |

Do not skip the third row. Run a full mock with auto-picks on and your finger still on
the keyboard, and check that the board matches ESPN's pick history at the end. If it
drifts by even one player, go back to typing.

## Fair warning on terms

You're reading data from a page you're logged into, on your own machine, for your own
draft. That's the same thing FantasyPros', PFF's, and Draft Sharks' extensions do. It
is still automated access to ESPN's service, which their terms generally discourage.
Personal use is low risk. Don't redistribute captured data, don't run it against
leagues you're not in, and don't build a product on it.

## Files

- `manifest.json` — MV3, scoped to ESPN draft URLs only
- `inject.js` — runs in the page context at `document_start`, wraps WebSocket/fetch/XHR
- `bridge.js` — runs in the extension context, batches and posts to `127.0.0.1:8777`
- `popup.html` / `popup.js` — connection status and frame counter
- `analyze_recon.py` — reads `recon.jsonl`, finds the pick stream
