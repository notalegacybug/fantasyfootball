// Records a small, trimmed slice of ESPN's public player pool for the pool/manual tests.
// Re-run when ESPN changes its format (the tests will fail first):
//
//     cd app && node test/capture_pool.mjs

import { writeFileSync } from "node:fs";
import { fetchCurrentSeason, fetchCurrentWeek, fetchPlayerPool } from "../www/js/espn.js";

const get = async (u, headers) => {
  const r = await fetch(u, { headers });
  return { status: r.status, data: await r.json() };
};

// Only the fields parsePlayer reads, and only ESPN's projections (statSourceId 1).
const trim = e => ({
  status: e.status,
  player: {
    id: e.player.id, fullName: e.player.fullName, defaultPositionId: e.player.defaultPositionId,
    proTeamId: e.player.proTeamId, eligibleSlots: e.player.eligibleSlots,
    injuryStatus: e.player.injuryStatus,
    ownership: { percentStarted: e.player.ownership?.percentStarted,
                 percentChange: e.player.ownership?.percentChange },
    stats: (e.player.stats || []).filter(s => s.statSourceId === 1)
      .map(({ seasonId, scoringPeriodId, statSourceId, statSplitTypeId, appliedTotal }) =>
        ({ seasonId, scoringPeriodId, statSourceId, statSplitTypeId, appliedTotal })),
  },
});

const season = await fetchCurrentSeason(get);
const week = await fetchCurrentWeek(get, season);
for (const [name, id] of [["ppr", 3], ["std", 1]]) {
  const raw = await fetchPlayerPool(get, season, week, id, 150);
  const out = { season, week, raw: { players: raw.players.map(trim) } };
  writeFileSync(new URL(`../../fixtures/espn_pool_${name}.json`, import.meta.url),
                JSON.stringify(out, null, 1) + "\n");
  console.log(`espn_pool_${name}.json: ${out.raw.players.length} players, season ${season} week ${week}`);
}
