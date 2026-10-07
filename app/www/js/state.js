// The live league as the season math sees it. No network, no decision math.
// Players are plain objects; season.js copies rather than mutates them.

import { parseLeague, parseFreeAgents, parseProSchedule } from "./espn.js";

// ESPN statuses that mean "not playing this week".
// QUESTIONABLE usually plays, so it keeps its projection and is flagged in Fix first.
export const WONT_PLAY_STATUSES = ["OUT", "DOUBTFUL", "INJURY_RESERVE", "SUSPENSION"];
// ESPN's projection as-is: only the "status and projection disagree" checks use it.
export const espnPts = p => p.proj_week || 0;
// Points we expect: 0 when ESPN says he won't play, whatever it still projects.
export const weekPts = p => (WONT_PLAY_STATUSES.includes(p.injury) ? 0 : espnPts(p));
export const isStarter = p => p.slot !== "BENCH" && p.slot !== "IR";

// ESPN stores owners as the same braced GUID as the SWID cookie. Case-insensitive.
export function findMyTeamId(teams, swid) {
  const want = (swid || "").trim().toLowerCase();
  if (!want) return null;
  const t = teams.find(t => t.owners.some(o => o.toLowerCase() === want));
  return t ? t.id : null;
}

// raw = {league, free_agents, pro_schedule}. pro_schedule may be passed already parsed
// (the app caches the parsed form) -- detected by the absence of `settings`.
// The team is the SWID's team when signed in, else the team the user picked.
export function buildState(raw, { swid = "", teamId = null, nowMs = Date.now() } = {}) {
  const lg = parseLeague(raw.league);
  const pro = raw.pro_schedule.settings ? parseProSchedule(raw.pro_schedule) : raw.pro_schedule;
  const week = lg.week;

  const player = row => {
    const game = pro[row.pro_team_id]?.games?.[week] ?? null;
    const locked = Boolean(game && game.kickoff_ms && game.kickoff_ms <= nowMs);
    return {
      player_id: row.player_id, name: row.name, pos: row.pos, pro_team_id: row.pro_team_id,
      eligible: row.eligible, proj_week: row.proj_week, proj_ros: row.proj_ros,
      injury: row.injury, pct_started: row.pct_started, pct_change: row.pct_change,
      outlook: row.outlook, slot: row.slot ?? "BENCH", status: row.status ?? null,
      game, locked, bye: pro[row.pro_team_id]?.bye ?? null,
    };
  };

  const teams = lg.teams.map(t => ({
    id: t.id, name: t.name, abbrev: t.abbrev, owners: t.owners, wins: t.wins,
    losses: t.losses, ties: t.ties, points_for: t.points_for,
    points_against: t.points_against, roster: t.roster.map(player),
  }));
  const freeAgents = parseFreeAgents(raw.free_agents, lg.season, week)
    .filter(r => r.pos).map(player);

  const myId = findMyTeamId(lg.teams, swid) ?? teamId;
  if (myId === null || !teams.some(t => t.id === myId)) {
    throw new Error("Pick your team first.");
  }
  return new SeasonState({ season: lg.season, week, slots: lg.slots, teams,
                           schedule: lg.schedule, pro, freeAgents, myTeamId: myId });
}

export class SeasonState {
  constructor(o) { Object.assign(this, o); }

  team(id) { return this.teams.find(t => t.id === id); }

  get me() { return this.team(this.myTeamId); }

  opponent() {
    for (const m of this.schedule) {
      if (m.period === this.week && (m.home === this.myTeamId || m.away === this.myTeamId)) {
        const other = m.home === this.myTeamId ? m.away : m.home;
        return other !== null ? this.team(other) : null;
      }
    }
    return null;
  }

  proAbbrev(proTeamId) { return this.pro[proTeamId]?.abbrev || "FA"; }
}
