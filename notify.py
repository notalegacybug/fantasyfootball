"""
Push the weekly answer to a phone via a Discord webhook. One outbound POST; nothing
listens, so the PC only has to be awake for the moment it runs.

A webhook URL is a write-only secret: anyone holding it can post to the channel. It
lives in config.json (gitignored), never in the repo.
"""

import httpx

DISCORD_LIMIT = 2000        # Discord rejects message content longer than this
WEBHOOK_PREFIXES = ("https://discord.com/api/webhooks/",
                    "https://discordapp.com/api/webhooks/")


def valid_webhook(url: str) -> bool:
    """Refuse anything that isn't a Discord webhook, so a typo in config.json can't
    send league data to some other host."""
    return bool(url) and url.startswith(WEBHOOK_PREFIXES)


def fit(text: str, limit: int = DISCORD_LIMIT) -> str:
    """Trim to whole lines under the limit, saying so."""
    if len(text) <= limit:
        return text
    note = "(more on the page)"
    out = []
    for line in text.split("\n"):
        if len("\n".join(out + [line, note])) > limit:
            break
        out.append(line)
    return "\n".join(out + [note])


def _p(p) -> str:
    return f"{p.name} ({p.week_pts:.1f})"


def format_weekly(r: dict, state) -> str:
    opp = r["opponent"]
    vs = f" vs {opp.name} {r['opponent_total']:.1f}" if opp else ""
    lines = [f"**Week {r['week']} | you {r['current_total']:.1f}{vs}**"]
    gain = r["optimal_total"] - r["current_total"]
    if gain > 0.05:
        lines.append(f"Best lineup: {r['optimal_total']:.1f} (+{gain:.1f} left on your bench)")

    if r["problems"]:
        lines.append("\n**Fix first**")
        lines += [f"- {x['player'].name}: {x['message']}" for x in r["problems"]]
    if r["ir_moves"]:
        lines.append("\n**IR moves**")
        lines += [f"- {m['player'].name}: {m['from'].lower()} -> {m['to'].lower()}"
                  for m in r["ir_moves"]]
    lines.append("\n**Lineup**")
    if r["deltas"]:
        lines += [f"- Start {_p(d['in'])} over {_p(d['out'])} at {d['slot']}: +{d['gain']:.1f}"
                  for d in r["deltas"]]
    else:
        lines.append("- No changes. Your lineup is already the best one.")
    lines.append("\n**Pickups**")
    if r["pickups"]:
        for w in r["pickups"]:
            how = "waiver claim" if w["add"].status == "WAIVERS" else "free agent"
            drop = f", drop {w['drop'].name}" if w["drop"] else ""
            lines.append(f"- {w['add'].name} {w['add'].pos} ({how}){drop}: +{w['gain']:.1f} this week")
    else:
        lines.append("- Nobody worth adding this week.")
    if r["close_calls"]:
        lines.append("\n**Close calls**")
        lines += [f"- {c['slot']}: {_p(c['starter'])} vs {_p(c['alt'])}, {c['margin']:.1f} apart"
                  for c in r["close_calls"]]
    stale = [k for k, v in state.info.items() if v.get("source") == "stale"]
    if stale:
        lines.append(f"\n_ESPN unreachable; used saved data for {', '.join(stale)}._")
    return fit("\n".join(lines))


def post_discord(url: str, content: str, timeout: float = 15.0) -> None:
    if not valid_webhook(url):
        raise ValueError("discord.webhook_url in config.json isn't a Discord webhook URL.")
    r = httpx.post(url, json={"content": content,
                              "allowed_mentions": {"parse": []}},   # never ping @everyone
                   timeout=timeout)
    r.raise_for_status()
