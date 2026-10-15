// Yahoo by hand: the user's own roster + ESPN's public predictions -> the same SeasonState the
// ESPN adapter builds, so season.js, report.js and the week page don't know the difference.
// Yahoo's API needs a per-app approval we don't have yet (403, last checked 2026-10-15).
// Spec: docs/superpowers/specs/2026-10-15-yahoo-manual-roster-design.md

import { bestLineup } from "./season.js";
import { SeasonState, statePlayer } from "./state.js";

export const CONFIG_VERSION = 1;   // saved on users' phones: bump only with a migration
// Yahoo's standard roster. W/R/T is the app's FLEX, DEF is DST.
export const YAHOO_DEFAULT_SLOTS = { QB: 1, WR: 3, RB: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6, IR: 1 };
export const SCORING_DEFAULTS = { ppr: 3, standard: 1 };   // ESPN leaguedefaults id per scoring

export function newConfig(name, scoring, slots) {
  return { v: CONFIG_VERSION, name, scoring, slots: { ...slots }, roster: [], taken: [],
           editedAt: Date.now() };
}

// A saved config, or null if it isn't one this version understands.
export function readConfig(o) {
  if (!o || o.v !== CONFIG_VERSION || !Array.isArray(o.roster)) return null;
  return { taken: [], ...o };
}

// What's saved per player: enough to show and place him even after he drops out of ESPN's
// top 600 (then he has no predictions, but he's never silently removed).
export const rosterEntry = row => ({ id: row.player_id, name: row.name, pos: row.pos,
  eligible: row.eligible, pro_team_id: row.pro_team_id, ir: false });

// Half PPR = the average of ESPN's PPR and standard predictions, player by player.
const avg = (a, b) => (a == null ? b : b == null ? a : (a + b) / 2);
export function averagePools(ppr, std) {
  const s = new Map(std.map(r => [r.player_id, r]));
  return ppr.map(r => {
    const o = s.get(r.player_id);
    return o ? { ...r, proj_week: avg(r.proj_week, o.proj_week), proj_ros: avg(r.proj_ros, o.proj_ros) } : r;
  });
}

// fetchRows(leagueDefaultsId) -> parsed rows. Injected so tests don't touch the network.
export async function poolFor(fetchRows, scoring) {
  let rows;
  if (scoring === "half") {
    const [ppr, std] = await Promise.all([fetchRows(SCORING_DEFAULTS.ppr), fetchRows(SCORING_DEFAULTS.standard)]);
    rows = averagePools(ppr, std);
  } else {
    const id = SCORING_DEFAULTS[scoring];
    if (!id) throw new Error(`Unknown scoring "${scoring}".`);
    rows = await fetchRows(id);
  }
  return rows.filter(r => r.pos);
}

// "smith njigba" finds Smith-Njigba, "jamarr" finds Ja'Marr, "nunez" finds Núñez.
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/['.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function searchPool(rows, query, excludeIds = new Set(), n = 8) {
  const q = norm(query);
  if (q.length < 2) return [];
  return rows.filter(r => !excludeIds.has(r.player_id) && norm(r.name).includes(q)).slice(0, n);
}

const MY_TEAM = 1;

// The saved roster as a one-team league. Yahoo doesn't tell us who's starting, so every
// player is placed in his best-lineup slot: "Lineup changes" is then empty by construction
// and "Your best lineup" is the lineup to set in Yahoo.
export function buildManualState(cfg, pool, pro, { season, week, nowMs = Date.now() }) {
  const byId = new Map(pool.map(r => [r.player_id, r]));
  const toPlayer = statePlayer(pro, week, nowMs);

  const players = cfg.roster.map(e => {
    const row = byId.get(e.id);
    const base = row ?? { player_id: e.id, name: e.name, pos: e.pos, eligible: e.eligible,
                          pro_team_id: e.pro_team_id, proj_week: null, proj_ros: null, injury: null,
                          pct_started: null, pct_change: null, outlook: null };
    return { ...toPlayer({ ...base, slot: e.ir ? "IR" : "BENCH" }), missing: !row };
  });

  // Locks are ignored while placing: nobody is a "starter" yet, so a player whose game has
  // kicked off could otherwise never be placed. The report's own bestLineup then keeps him there.
  const placeable = players.filter(p => p.slot !== "IR").map(p => ({ ...p, locked: false }));
  const slotOf = new Map(bestLineup(placeable, cfg.slots).map(([s, p]) => [p.player_id, s]));
  for (const p of players) if (slotOf.has(p.player_id)) p.slot = slotOf.get(p.player_id);

  const skip = new Set([...cfg.roster.map(e => e.id), ...cfg.taken]);
  const freeAgents = pool.filter(r => !skip.has(r.player_id))
    .map(r => toPlayer({ ...r, slot: "BENCH", status: null }));

  const me = { id: MY_TEAM, name: cfg.name, abbrev: null, owners: [], wins: 0, losses: 0, ties: 0,
               points_for: 0, points_against: 0, roster: players };
  return new SeasonState({ season, week, slots: cfg.slots, teams: [me], schedule: [], pro,
                           freeAgents, myTeamId: MY_TEAM });
}
