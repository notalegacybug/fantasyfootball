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
const SCORINGS = ["ppr", "half", "standard"];

export function newConfig(name, scoring, slots) {
  return { v: CONFIG_VERSION, name, scoring, slots: { ...slots }, roster: [], taken: [],
           takenNames: {}, editedAt: Date.now() };
}

// A saved config, or null if it isn't one this version understands.
export function readConfig(o) {
  if (!o || o.v !== CONFIG_VERSION || !Array.isArray(o.roster)) return null;
  return { taken: [], ...o, takenNames: { ...o.takenNames } };
}

// Name, scoring and roster spots changed after setup; the roster and Taken list are kept
// (player ids are the same in ESPN's PPR, half and standard lists).
export function applySettings(cfg, { name, scoring, slots }) {
  return { ...cfg, name: name.trim(), scoring,
           slots: Object.fromEntries(Object.entries(slots).filter(([, n]) => n > 0)),
           editedAt: Date.now() };
}

// takenNames is optional (added after v1 shipped; older configs have none), so the hidden
// list can still name a player who has dropped out of ESPN's list.
export function markTaken(cfg, row) {
  if (!cfg.taken.includes(row.player_id)) cfg.taken.push(row.player_id);
  cfg.takenNames[row.player_id] = row.name;
}
export function unmarkTaken(cfg, id) {
  cfg.taken = cfg.taken.filter(t => t !== id);
  delete cfg.takenNames[id];
}
export function hiddenPlayers(cfg, rows) {
  const pool = new Map(rows.map(r => [r.player_id, r.name]));
  return cfg.taken.map(id => ({ id, name: cfg.takenNames[id] || pool.get(id) || "Unknown player" }));
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

// "smith njigba" finds Smith-Njigba, "jamarr" finds Ja'Marr, "nunez" finds Núñez. iPhones type
// curly apostrophes by default, so those are dropped like straight ones. Spaces are ignored
// too, so "St.Brown" finds "St. Brown".
export const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/['\u2018\u2019.]/g, "").replace(/[^a-z0-9]+/g, "");

export function searchPool(rows, query, excludeIds = new Set(), n = 8) {
  const q = norm(query);
  if (q.length < 2) return [];
  return rows.filter(r => !excludeIds.has(r.player_id) && norm(r.name).includes(q)).slice(0, n);
}

// Offline fallback: the last saved predictions (pool cache value) + NFL schedule, whatever
// their age, or null when either is missing.
export function savedData(pool, pro) {
  return pool && pro ? { season: pool.season, week: pool.week, rows: pool.rows, pro } : null;
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

// Moving a league to another device. There's no server, so the whole config rides in the
// link, after "#": browsers never send that part to the website. iPhone Home Screen apps
// have their own storage, apart from Safari, so the link is pasted in the app, not tapped.
const B64 = /#yahoo=([A-Za-z0-9_-]*)/;
const toB64 = bytes => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

export function exportLink(cfg, origin) {
  const { v, name, scoring, slots, roster, taken, takenNames, editedAt } = cfg;
  const json = JSON.stringify({ v, name, scoring, slots, roster, taken, takenNames, editedAt });
  return `${origin}/#yahoo=${toB64(new TextEncoder().encode(json))}`;
}

// The config from a link, or anything containing one (a pasted text message).
export function importLink(text) {
  const m = B64.exec(String(text || ""));
  if (!m) throw new Error("That isn't a league link. Copy the whole link from the message.");
  let o;
  try { o = JSON.parse(new TextDecoder().decode(fromB64(m[1]))); }
  catch { throw new Error("That link got cut off. Copy the whole link again."); }
  if (o?.v > CONFIG_VERSION) throw new Error("That link is from a newer version. Reload the app, then paste again.");
  const cfg = cleanConfig(o);
  if (!cfg) throw new Error("That link got cut off. Copy the whole link again.");
  return cfg;
}

// Anyone can send a link, so the league is rebuilt from checked fields only and anything
// unexpected rejects the whole link -- nothing from it reaches the page or the math unchecked.
const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "OP", "K", "DST", "BENCH", "IR"];
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
const isId = n => Number.isInteger(n) && n > -1e6 && n < 1e10;
const isText = (t, max) => typeof t === "string" && t.length <= max;
const isObj = o => o !== null && typeof o === "object" && !Array.isArray(o);

function cleanConfig(o) {
  if (!isObj(o) || o.v !== CONFIG_VERSION || !isText(o.name, 80) || !SCORINGS.includes(o.scoring)) return null;
  if (!isObj(o.slots) || !Object.entries(o.slots).every(([k, n]) => SLOTS.includes(k) && Number.isInteger(n) && n >= 0 && n <= 10)) return null;
  if (!Array.isArray(o.roster) || o.roster.length > 60) return null;
  const roster = [];
  for (const e of o.roster) {
    const ok = isObj(e) && isId(e.id) && isText(e.name, 80) && POSITIONS.includes(e.pos)
      && Array.isArray(e.eligible) && e.eligible.every(x => SLOTS.includes(x))
      && (e.pro_team_id == null || isId(e.pro_team_id)) && typeof e.ir === "boolean";
    if (!ok) return null;
    roster.push({ id: e.id, name: e.name, pos: e.pos, eligible: [...e.eligible],
                  pro_team_id: e.pro_team_id ?? null, ir: e.ir });
  }
  const taken = o.taken ?? [];
  if (!Array.isArray(taken) || taken.length > 600 || !taken.every(isId)) return null;
  const names = o.takenNames ?? {};
  if (!isObj(names) || !Object.entries(names).every(([k, v]) => isId(Number(k)) && /^-?\d+$/.test(k) && isText(v, 80))) return null;
  return { v: CONFIG_VERSION, name: o.name, scoring: o.scoring, slots: { ...o.slots }, roster,
           taken: [...taken], takenNames: { ...names },
           editedAt: Number.isFinite(o.editedAt) ? o.editedAt : Date.now() };
}
