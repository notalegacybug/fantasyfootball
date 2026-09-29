"""
Discord message formatting on the recorded fixture. Never posts anything.

    python test_notify.py
"""

import json
import pathlib

import notify
import season
from league import build_state

HERE = pathlib.Path(__file__).parent


def check(label, cond):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    return cond


def fixture_state(now_ms):
    fx = HERE / "fixtures"
    raw = {"league": json.loads((fx / "espn_league.json").read_text()),
           "free_agents": json.loads((fx / "espn_free_agents.json").read_text()),
           "pro_schedule": json.loads((fx / "espn_pro_schedule.json").read_text())}
    return build_state(raw, "{00000000-0000-0000-0000-000000000001}", now_ms=now_ms)


def main():
    ok = True
    print("\n[1] Weekly message from the week-3 fixture, before kickoff")
    st = fixture_state(now_ms=0)
    msg = notify.format_weekly(season.weekly_report(st), st)
    print("     " + msg.replace("\n", "\n     "))
    ok &= check("fits Discord's 2000-char limit", len(msg) <= notify.DISCORD_LIMIT)
    ok &= check("header names the week", msg.startswith("**Week 3"))
    ok &= check("IR swap is in it", "IR" in msg)

    print("\n[2] Truncation keeps whole lines")
    long = notify.fit("\n".join(f"line {i} " + "x" * 50 for i in range(100)))
    ok &= check("under the limit", len(long) <= notify.DISCORD_LIMIT)
    ok &= check("ends with a note, not half a line", long.endswith("(more on the page)"))

    print("\n[3] Webhook URL guard")
    ok &= check("real Discord webhook accepted",
                notify.valid_webhook("https://discord.com/api/webhooks/123/abc"))
    ok &= check("anything else refused",
                not notify.valid_webhook("https://example.com/api/webhooks/123/abc"))
    ok &= check("plain http refused",
                not notify.valid_webhook("http://discord.com/api/webhooks/123/abc"))

    print("\n" + ("ALL CHECKS PASSED" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
