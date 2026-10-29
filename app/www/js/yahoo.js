// Yahoo leagues: parse Yahoo's JSON and match its players to ESPN's public predictions.
// Yahoo supplies rosters, slots and injuries; ESPN's pool supplies the projections.
// Spec: docs/superpowers/specs/2026-10-28-yahoo-api-league-design.md section 4.3

import { norm } from "./manual.js";
import { SeasonState, statePlayer } from "./state.js";

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

// ---- The league bundle -> the week's SeasonState (spec section 4.3 / 4.5) ----
//
// CALL SHAPE ASSUMED: one combined call, league/<key>;out=settings,standings,scoreboard/teams/roster.
// Its response has fantasy_content.league = [ {league_key, name, season, current_week, ...},
// {settings}, {standings}, {scoreboard}, {teams} ] in some order; flat() merges that array so the
// order does not matter. If Yahoo refuses that combination (to be checked against real data in
// Task 6), fall back to separate calls and wrap each response's league resource in the same array.
// Everything below reads through flat()/list(), so the exact nesting level may vary a little.

const REC_STAT = 11;     // receptions
const PASS_TD_STAT = 4;  // passing touchdowns

// roster_positions -> {QB:1, RB:2, FLEX:1, ...} in app names. An unmapped position stops the
// league: silently dropping a roster spot would make every lineup answer wrong.
function parseSlots(settings) {
  const slots = {};
  for (const rp of settings.roster_positions || []) {
    const { position, count } = flat(rp.roster_position ?? rp);
    const slot = YAHOO_SLOTS[position];
    if (!slot) throw new Error(`This league has a roster spot the app doesn't handle yet: ${position}.`);
    slots[slot] = (slots[slot] || 0) + Number(count ?? 1);
  }
  return slots;
}

// Receptions worth 1 -> ppr, 0.5 -> half, anything else -> standard.
// Odd scoring (not 4-point passing TDs, or any bonus rule) is flagged: ESPN's predictions
// assume standard point values, so the page can warn.
function parseScoring(settings) {
  const stats = (settings.stat_modifiers?.stats || []).map(s => s.stat ?? s);
  const stat = id => stats.find(s => Number(s.stat_id) === id);
  const rec = Number(stat(REC_STAT)?.value ?? 0);
  const ptd = stat(PASS_TD_STAT);
  return {
    scoring: rec === 1 ? "ppr" : rec === 0.5 ? "half" : "standard",
    oddScoring: (ptd !== undefined && Number(ptd.value) !== 4) ||
      stats.some(s => (Array.isArray(s.bonuses) ? s.bonuses.length : s.bonuses ? 1 : 0) > 0),
  };
}

const rosterOf = roster => list(roster).flatMap(r => list(r.players).map(p => p.player));

export function parseLeagueBundle(raw) {
  const L = flat(raw?.fantasy_content?.league);
  const settings = flat(L.settings);

  // Standings and teams both list every team; merge them by team_id.
  const byId = new Map();
  for (const part of [L.standings && flat(L.standings).teams, L.teams]) {
    for (const t of list(part)) {
      const f = flat(t.team);
      byId.set(String(f.team_id), { ...byId.get(String(f.team_id)), ...f });
    }
  }
  const teams = [...byId.values()].map(f => {
    const st = f.team_standings || {};
    const o = st.outcome_totals || {};
    return {
      id: Number(f.team_id), name: f.name, mine: Number(f.is_owned_by_current_login) === 1,
      wins: Number(o.wins ?? 0), losses: Number(o.losses ?? 0), ties: Number(o.ties ?? 0),
      points_for: Number(st.points_for ?? 0), points_against: Number(st.points_against ?? 0),
      roster: rosterOf(f.roster).map(parseYahooPlayer),
    };
  });

  // scoreboard: {"0":{matchups:{"0":{matchup:{week, "0":{teams:{"0":{team},"1":{team}}}}}}}}
  const sb = flat(L.scoreboard);
  const schedule = [];
  for (const m of list(sb.matchups)) {
    const mu = m.matchup;
    const ids = list(flat(list(mu)[0]).teams).map(t => Number(flat(t.team).team_id));
    if (ids.length === 2) schedule.push({ period: Number(mu.week ?? L.current_week), home: ids[0], away: ids[1] });
  }

  return { season: Number(L.season), week: Number(L.current_week), ...parseScoring(settings),
           slots: parseSlots(settings), teams, schedule };
}

// Rostered players come from Yahoo (slot, injury); the ESPN pool row adds the predictions.
// A rostered player ESPN doesn't list is kept as `missing` with no predictions, the same shape
// buildManualState uses. Free agents are the pool rows nobody in the league has.
export function buildYahooState(bundle, poolRows, pro, { nowMs = Date.now() } = {}) {
  const { season, week } = bundle;
  const idx = poolIndex(poolRows, pro);
  const toPlayer = statePlayer(pro, week, nowMs);
  const proId = new Map(Object.entries(pro).map(([id, t]) => [t.abbrev, Number(id)]));
  const taken = new Set();

  const teams = bundle.teams.map(t => ({
    id: t.id, name: t.name, abbrev: null, owners: [], wins: t.wins, losses: t.losses, ties: t.ties,
    points_for: t.points_for, points_against: t.points_against,
    roster: t.roster.map(yp => {
      const row = matchPlayer(yp, idx);
      if (row) taken.add(row.player_id);
      const base = row ?? { player_id: `yahoo:${yp.team}:${yp.name}`, name: yp.name, pos: yp.pos,
        eligible: yp.eligible, pro_team_id: proId.get(espnTeam(yp.team)) ?? null, proj_week: null,
        proj_ros: null, pct_started: null, pct_change: null, outlook: null };
      return { ...toPlayer({ ...base, injury: yp.status, slot: yp.slot }), missing: !row };
    }),
  }));

  const mine = bundle.teams.find(t => t.mine);
  if (!mine) throw new Error("Couldn't tell which team is yours in this league.");
  const freeAgents = poolRows.filter(r => r.pos && !taken.has(r.player_id)).map(toPlayer);

  return new SeasonState({ season, week, slots: bundle.slots, teams, schedule: bundle.schedule,
                           pro, freeAgents, myTeamId: mine.id });
}
