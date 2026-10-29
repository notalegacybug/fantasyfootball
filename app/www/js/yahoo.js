// Yahoo leagues: parse Yahoo's JSON and match its players to ESPN's public predictions.
// Yahoo supplies rosters, slots and injuries; ESPN's pool supplies the projections.
// Spec: docs/superpowers/specs/2026-10-28-yahoo-api-league-design.md section 4.3

import { norm } from "./manual.js";

export const YAHOO_SLOTS = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DST",
  "W/R/T": "FLEX", "Q/W/R/T": "OP", BN: "BENCH", IR: "IR" };

export const YAHOO_STATUS = { Q: "QUESTIONABLE", D: "DOUBTFUL", O: "OUT", IR: "INJURY_RESERVE",
  "IR-R": "INJURY_RESERVE", PUP: "INJURY_RESERVE", "PUP-R": "INJURY_RESERVE", NFI: "INJURY_RESERVE",
  "NFI-R": "INJURY_RESERVE", SUSP: "SUSPENSION", NA: "OUT" };

// Only the Yahoo abbrevs (uppercased) that differ from ESPN's. JAC and OAK/LA are old spellings.
const YAHOO_TEAM = { WAS: "WSH", JAC: "JAX", OAK: "LV", LA: "LAR" };
export const espnTeam = abbr => YAHOO_TEAM[abbr] ?? abbr;

// Yahoo writes an object as an array of one-key objects ([{a:1},{b:2}], sometimes with empty
// arrays among them) and a list as {"0":x, "1":y, "count":2}. Both merge into one plain object;
// a numbered map merges its entries, so it is for single-entry maps (the game, the league).
export function flat(v) {
  if (Array.isArray(v)) return Object.assign({}, ...v.map(flat));
  if (v && typeof v === "object") {
    const numbered = Object.keys(v).every(k => k === "count" || /^\d+$/.test(k));
    return numbered ? Object.assign({}, ...Object.entries(v).filter(([k]) => k !== "count").map(([, x]) => flat(x)))
                    : { ...v };
  }
  return {};
}

// The values of a numbered map, in order: {"0":a, "1":b, "count":2} -> [a, b].
export const list = m => Object.entries(m || {}).filter(([k]) => /^\d+$/.test(k)).map(([, v]) => v);

// users;use_login=1/games;game_keys=nfl/leagues -> the user's NFL leagues.
export function parseLeagues(raw) {
  const out = [];
  for (const u of list(raw?.fantasy_content?.users)) {
    for (const g of list(flat(u.user).games)) {
      for (const l of list(flat(g.game).leagues)) {
        const L = flat(l.league);
        out.push({ key: L.league_key, name: L.name, season: Number(L.season), numTeams: Number(L.num_teams) });
      }
    }
  }
  return out;
}

// PUP-P, NFI-A and the like are all season-long lists to us, so match them by prefix.
const statusOf = s => YAHOO_STATUS[s] ?? (/^(PUP|NFI)/.test(s) ? "INJURY_RESERVE" : null);

// One Yahoo "player" array -> the fields the app uses, in app names.
export function parseYahooPlayer(p) {
  const f = flat(p);
  const slots = ps => (ps || []).map(x => YAHOO_SLOTS[x.position]).filter(Boolean);
  return {
    name: f.name?.full ?? "",
    team: String(f.editorial_team_abbr || "").toUpperCase(),
    pos: YAHOO_SLOTS[f.display_position] ?? null,
    eligible: [...new Set(slots(f.eligible_positions))],
    slot: YAHOO_SLOTS[flat(f.selected_position).position] ?? null,
    status: statusOf(f.status),
  };
}

// "Kenneth Walker III" and "Kenneth Walker" are the same man to both sites.
// Whole trailing words only, so a surname that happens to end in "v" is left alone.
const SUFFIX = /[\s,]+(jr|sr|ii|iii|iv|v)\.?$/i;
const nameKey = s => norm(String(s || "").replace(SUFFIX, ""));

// Index the ESPN pool by name + ESPN team (defenses by team alone). Each key keeps every row:
// the same name on two teams is two keys; the same name on one team (rare) is two rows.
export function poolIndex(rows, pro) {
  const idx = new Map();
  for (const r of rows) {
    const team = pro[r.pro_team_id]?.abbrev;
    if (!team) continue;
    const key = r.pos === "DST" ? `DST|${team}` : `${nameKey(r.name)}|${team}`;
    idx.set(key, [...(idx.get(key) || []), r]);
  }
  return idx;
}

// The pool row for a parsed Yahoo player, or null (not in ESPN's list: he has no predictions).
// If several rows share name and team, the one with his position wins, else the first.
export function matchPlayer(yp, idx) {
  const team = espnTeam(yp.team);
  const rows = idx.get(yp.pos === "DST" ? `DST|${team}` : `${nameKey(yp.name)}|${team}`);
  return rows ? (rows.find(r => r.pos === yp.pos) ?? rows[0]) : null;
}
