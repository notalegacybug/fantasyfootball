// ESPN adapter: the only file that knows ESPN's URLs, ids and field names.
// Everything it returns is the platform-neutral shape (plain slot/position names) that
// state.js and season.js read, so a Yahoo adapter only has to produce the same shape.

export const ESPN_GAME = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const ESPN_BASE = `${ESPN_GAME}/seasons`;

// A player's actual position (defaultPositionId) -- a DIFFERENT numbering from slots.
const ESPN_POSITION_ID = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };

// lineupSlotId -> slot name. ESPN has renumbered these before; slotName() fails loudly.
const ESPN_SLOTS = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K",
  23: "FLEX", 7: "OP", 20: "BENCH", 21: "IR",
};

// statSplitTypeId: period 0 carries rest-of-season (0) AND full-season (2) projections.
const SPLIT_WEEK = 1, SPLIT_REST_OF_SEASON = 0;

// lineupSlot ids for the six real positions (ESPN_SLOTS numbering).
const FREE_AGENT_SLOT_IDS = [0, 2, 4, 6, 16, 17];

export class EspnError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// --------------------------------------------------------------------------
// Fetching. `get(url, headers)` is injected (transport.js) so the same code runs in a
// browser (plain fetch) and in the Android app (native HTTP with the login cookies).
// --------------------------------------------------------------------------

function url(path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of params) q.append(k, v);      // repeated `view` is how ESPN combines views
  return `${path}?${q}`;
}

async function getJson(get, u, headers) {
  const r = await get(u, headers || {});
  if (r.status === 401) {
    // A private league and a nonexistent league id BOTH return 401 (measured 2026-10-02).
    throw new EspnError(401, "This league is private, or the league ID is wrong.");
  }
  if (r.status < 200 || r.status >= 300) throw new EspnError(r.status, `ESPN answered ${r.status}.`);
  return r.data;
}

export async function fetchCurrentSeason(get) {
  return (await getJson(get, ESPN_GAME)).currentSeasonId;
}

export function fetchLeague(get, leagueId, season) {
  const views = ["mTeam", "mRoster", "mMatchupScore", "mSettings"].map(v => ["view", v]);
  return getJson(get, url(`${ESPN_BASE}/${season}/segments/0/leagues/${leagueId}`, views));
}

export const FREE_AGENT_LIMIT = 150;

export function fetchFreeAgents(get, leagueId, season, week, limit = FREE_AGENT_LIMIT) {
  const flt = { players: {
    filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
    filterSlotIds: { value: FREE_AGENT_SLOT_IDS },
    sortPercOwned: { sortPriority: 1, sortAsc: false },
    limit,
  } };
  return getJson(get,
    url(`${ESPN_BASE}/${season}/segments/0/leagues/${leagueId}`,
        [["view", "kona_player_info"], ["scoringPeriodId", week]]),
    { "x-fantasy-filter": JSON.stringify(flt) });
}

// Public, no auth. ~9 MB of JSON but ~620 KB on the wire (gzip); callers cache the
// PARSED result, which is small.
export function fetchProSchedule(get, season) {
  return getJson(get, url(`${ESPN_BASE}/${season}`, [["view", "proTeamSchedules"]]));
}

// --------------------------------------------------------------------------
// Parsing: ESPN JSON -> plain shape. Same rules as sources.py, kept in the same order.
// --------------------------------------------------------------------------

function floatOrNull(v) {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function intOrNull(v) {
  const n = floatOrNull(v);
  return n === null ? null : Math.trunc(n);
}

export function pickStat(stats, season, period, source, split = null) {
  for (const s of stats || []) {
    if (s.seasonId === season && s.scoringPeriodId === period && s.statSourceId === source
        && (split === null || s.statSplitTypeId === split)) {
      return floatOrNull(s.appliedTotal);
    }
  }
  return null;
}

export function slotName(slotId) {
  const name = ESPN_SLOTS[slotId];
  if (name === undefined) {
    throw new Error(`Unknown ESPN lineupSlotId ${slotId}. ESPN may have renumbered its slots.`);
  }
  return name;
}

export function parsePlayer(p, season, week) {
  const own = p.ownership || {};
  const eligible = [...new Set((p.eligibleSlots || []).filter(s => s in ESPN_SLOTS)
    .map(s => ESPN_SLOTS[s]))].sort();
  return {
    player_id: p.id ?? null,
    name: p.fullName || "",
    pos: ESPN_POSITION_ID[p.defaultPositionId] ?? null,
    pro_team_id: p.proTeamId ?? null,
    eligible,
    proj_week: pickStat(p.stats, season, week, 1, SPLIT_WEEK),
    proj_ros: pickStat(p.stats, season, 0, 1, SPLIT_REST_OF_SEASON),
    injury: p.injuryStatus ?? null,
    pct_started: floatOrNull(own.percentStarted),
    pct_change: floatOrNull(own.percentChange),
    outlook: p.seasonOutlook ?? null,
  };
}

export function parseLeague(raw, week = null) {
  const season = raw.seasonId;
  week = week === null ? raw.scoringPeriodId : week;

  const slots = {};
  const counts = raw.settings?.rosterSettings?.lineupSlotCounts || {};
  for (const [rawId, count] of Object.entries(counts)) {
    if (count) slots[slotName(Number(rawId))] = count;
  }

  const teams = (raw.teams || []).map(t => {
    const roster = ((t.roster || {}).entries || []).map(e => {
      const p = (e.playerPoolEntry || {}).player || {};
      return { ...parsePlayer(p, season, week), slot: slotName(e.lineupSlotId) };
    });
    const rec = (t.record || {}).overall || {};
    const name = t.name || `${t.location || ""} ${t.nickname || ""}`.trim();
    return {
      id: t.id, name, abbrev: t.abbrev ?? null, owners: t.owners || [],
      wins: rec.wins ?? 0, losses: rec.losses ?? 0, ties: rec.ties ?? 0,
      points_for: rec.pointsFor ?? 0, points_against: rec.pointsAgainst ?? 0,
      roster,
    };
  });

  const schedule = (raw.schedule || []).map(m => {
    const home = m.home || {}, away = m.away || {};
    return {
      period: m.matchupPeriodId ?? null,
      home: home.teamId ?? null, away: away.teamId ?? null,     // away is null on a bye
      home_pts: home.totalPoints ?? null, away_pts: away.totalPoints ?? null,
    };
  });

  return {
    season, week, current_week: raw.scoringPeriodId ?? null,
    matchup_period: raw.status?.currentMatchupPeriod ?? null,
    slots, teams, schedule,
  };
}

export function parseFreeAgents(raw, season, week) {
  return (raw.players || []).map(e => ({ ...parsePlayer(e.player || {}, season, week),
                                         status: e.status ?? null }));
}

export function parseProSchedule(raw) {
  const out = {};
  for (const t of raw.settings?.proTeams || []) {
    if (!t.id) continue;                       // id 0 is ESPN's "FA" pseudo-team
    const games = {};
    for (const [wk, gs] of Object.entries(t.proGamesByScoringPeriod || {})) {
      for (const g of gs) {
        const home = g.homeProTeamId === t.id;
        games[Number(wk)] = {
          opp: home ? (g.awayProTeamId ?? null) : (g.homeProTeamId ?? null),
          home, kickoff_ms: g.date ?? null,
        };
      }
    }
    out[t.id] = { abbrev: t.abbrev ?? null, bye: intOrNull(t.byeWeek), games };
  }
  return out;
}
