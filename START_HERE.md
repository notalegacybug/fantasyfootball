# Start here

Unzip. Then, from inside the `ffdraft` folder:

```bash
pip install -r requirements.txt
cp config.example.json config.json
python app.py demo
python app.py serve
```

Open **http://127.0.0.1:8777** in your browser.

`demo` loads fake players with real math, so this works right now without a
FantasyPros key. Player names will read "RB Player 01" — that's expected.

## What went wrong the first time

`index.html` isn't a web page you open. It's the front end for the Python server.
Every button on it calls back to `app.py`. Double-clicked from your downloads folder
it has no server to call, so it sits blank.

The folder layout matters too. `index.html` has to be inside `static/`:

```
ffdraft/
├── app.py
├── engine.py
├── sources.py
├── test_engine.py
├── analyze_recon.py
├── config.example.json
├── requirements.txt
├── static/
│   └── index.html          <- here, not next to app.py
└── extension/
    ├── manifest.json
    ├── inject.js
    ├── bridge.js
    ├── popup.html
    └── popup.js
```

The zip already has it right. Don't rearrange it.

## If something still doesn't work

The page now tells you what's wrong instead of failing silently. It will say either
"Open this through the server" or "Can't reach the draft board server," with the fix.

Other things that bite:

| symptom | cause |
| --- | --- |
| `No config.json` | you skipped the `cp config.example.json config.json` step |
| `No snapshot.db` | run `python app.py demo` (or `prefetch`) first |
| `ModuleNotFoundError: fastapi` | dependencies didn't install; check you're on Python 3.9+ |
| port 8777 in use | an old server is still running; kill it or change the port in `app.py` |
| blank page, no error | hard-refresh with Ctrl+Shift+R, you have the old file cached |

To confirm the math is sound without touching the server at all:

```bash
python test_engine.py
```

That runs 15 checks on synthetic data and needs nothing installed but Python.
