"""
Reads recon.jsonl and tells you where the picks are hiding.

Run this after a ten-pick mock draft:

    python analyze_recon.py

It groups traffic by endpoint, scores each stream on how pick-shaped it looks, and
dumps sample frames. You then write the parser against what it found, not against
a guess.
"""

import json
import pathlib
import re
from collections import Counter, defaultdict

LOG = pathlib.Path(__file__).parent / "recon.jsonl"

# Words that show up in a draft-pick payload and rarely anywhere else.
PICK_WORDS = ["playerId", "player_id", "pickNumber", "pick_number", "overallPickNumber",
              "roundId", "round_id", "teamId", "team_id", "autodraft", "autoDraft",
              "DRAFT_PICK", "draftPick", "SELECTION", "onTheClock", "memberId"]


def load():
    if not LOG.exists():
        raise SystemExit(f"No {LOG}. Start the server, load the extension, "
                         "and run a mock draft first.")
    out = []
    for line in LOG.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def score(text: str) -> int:
    return sum(1 for w in PICK_WORDS if w in text)


def main():
    events = load()
    print(f"{len(events)} events captured\n")

    kinds = Counter(e.get("kind") for e in events)
    print("By kind:")
    for k, n in kinds.most_common():
        print(f"  {n:6d}  {k}")

    streams = defaultdict(list)
    for e in events:
        url = (e.get("payload") or {}).get("url", "?")
        host = re.sub(r"\?.*$", "", str(url))
        streams[(e.get("kind"), host)].append(e)

    print("\nStreams ranked by how pick-shaped they look:")
    ranked = []
    for (kind, url), evs in streams.items():
        best = 0
        for e in evs:
            d = (e.get("payload") or {}).get("data")
            if isinstance(d, str):
                best = max(best, score(d))
        ranked.append((best, len(evs), kind, url))
    ranked.sort(reverse=True)
    for sc, n, kind, url in ranked[:15]:
        flag = "  <-- LOOK HERE" if sc >= 3 else ""
        print(f"  score {sc:2d}  {n:5d} msgs  {kind:10s}  {url[:70]}{flag}")

    print("\n" + "=" * 70)
    print("Sample payloads from the top stream")
    print("=" * 70)
    if not ranked or ranked[0][0] == 0:
        print("Nothing looked pick-shaped. Either the draft hadn't started, or the tab")
        print("was open before the extension loaded. Reload the draft room and retry.")
        return

    _, _, kind, url = ranked[0]
    shown = 0
    for e in streams[(kind, url)]:
        d = (e.get("payload") or {}).get("data")
        if not isinstance(d, str) or score(d) < 2:
            continue
        print(f"\n--- frame {shown + 1} ---")
        try:
            print(json.dumps(json.loads(d), indent=2)[:2500])
        except json.JSONDecodeError:
            print(d[:2500])
        shown += 1
        if shown >= 3:
            break

    print("\n" + "=" * 70)
    print("Every distinct key seen across pick-shaped frames:")
    keys = Counter()

    def walk(o, prefix=""):
        if isinstance(o, dict):
            for k, v in o.items():
                keys[f"{prefix}{k}"] += 1
                walk(v, f"{prefix}{k}.")
        elif isinstance(o, list) and o:
            walk(o[0], f"{prefix}[].")

    for e in events:
        d = (e.get("payload") or {}).get("data")
        if isinstance(d, str) and score(d) >= 2:
            try:
                walk(json.loads(d))
            except json.JSONDecodeError:
                pass
    for k, n in keys.most_common(50):
        print(f"  {n:5d}  {k}")

    print("\nNext step: find the key holding the ESPN player id and the key holding")
    print("the overall pick number. Those two are all the parser needs.")


if __name__ == "__main__":
    main()
