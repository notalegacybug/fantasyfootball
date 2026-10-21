// Questionable starters: the app still starts them (most play), and Fix first names who to
// start instead if he's ruled out -- the player the best lineup would bring in without him.
//
//     cd app && node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { bestLineup, ifRuledOut } from "../www/js/season.js";
import { weekPage } from "../www/js/ui.js";

let nextId = 1;
const P = (pos, proj, o = {}) => ({
  player_id: nextId++, name: o.name || `${pos}${nextId}`, pos,
  eligible: ["RB", "WR", "TE"].includes(pos) ? [pos, "FLEX", "BENCH"] : [pos, "BENCH"],
  proj_week: proj, proj_ros: 100, injury: o.injury ?? null, slot: "BENCH", status: null,
  game: { opp: 1, kickoff_ms: o.kickoff ?? 1000 }, locked: o.locked ?? false, bye: null,
});
const SLOTS = { QB: 1, RB: 1, WR: 1, FLEX: 1, BENCH: 4 };

test("backup is whoever the best lineup brings in without him, even after a reshuffle", () => {
  // Without the WR, the FLEX WR slides to WR and the bench RB takes FLEX: the RB is the backup.
  const q = P("WR", 20, { injury: "QUESTIONABLE" });
  const wr2 = P("WR", 15), rb2 = P("RB", 9, { name: "Bench RB" });
  const players = [P("QB", 18), P("RB", 14), q, wr2, rb2, P("WR", 4)];
  const got = ifRuledOut(players, SLOTS, bestLineup(players, SLOTS));
  assert.equal(got.get(q.player_id).name, "Bench RB");
});

test("no one left to fill in: backup is null", () => {
  const q = P("QB", 18, { injury: "QUESTIONABLE" });
  const players = [q, P("RB", 14), P("WR", 12), P("WR", 10)];
  const got = ifRuledOut(players, SLOTS, bestLineup(players, SLOTS));
  assert.ok(got.has(q.player_id));
  assert.equal(got.get(q.player_id), null);
});

test("skipped: benched, locked (game started) and healthy players", () => {
  const benched = P("WR", 2, { injury: "QUESTIONABLE" });
  const locked = P("RB", 14, { injury: "QUESTIONABLE", locked: true });
  locked.slot = "RB";
  const players = [P("QB", 18), locked, P("WR", 12), P("WR", 10), benched, P("RB", 3)];
  const got = ifRuledOut(players, SLOTS, bestLineup(players, SLOTS));
  assert.equal(got.size, 0);
});

// --- Fix first wording -----------------------------------------------------------------

const pj = (name, kickoff) => ({ id: name, name, pos: "WR", team: "X", proj: 9.8, injury: null,
                                 game: { opp: "Y", home: true, kickoff_ms: kickoff } });
const page = problems => ({
  week: 8, me: { name: "Me", wins: 0, losses: 0 }, opponent: null, current_total: 0, optimal_total: 0,
  opponent_total: null, problems, ir_moves: [], deltas: [], close_calls: [], pickups: [], stash: [],
  bye_crunch: [], starters: [{ ...pj("Q Guy", 5000), slot: "WR" }],
  constants: { close_call_margin: 2.5, bye_lookahead: 4 },
});
const qProblem = backup => ({ player: { ...pj("Q Guy", 5000), injury: "QUESTIONABLE" }, kind: "injury",
                              message: "questionable", backup });

test("Fix first: names the backup and when inactives come out", () => {
  const html = weekPage(page([qProblem(pj("Later Guy", 9000))]));
  assert.match(html, /If he's ruled out, start Later Guy \(9\.8\)/);
  assert.match(html, /Inactives come out about 90 minutes before kickoff/);
  assert.doesNotMatch(html, /decide by then/i);
});

test("Fix first: warns when the backup's game starts first", () => {
  const html = weekPage(page([qProblem(pj("Early Guy", 1000))]));
  assert.match(html, /Early Guy plays first, so decide by then/);
});

test("Fix first: no backup on the roster says so; Yahoo mode doesn't add the no-backup note too", () => {
  const html = weekPage(page([qProblem(null)]), { edited: "today", hidden: [] });
  assert.match(html, /No one on your bench can fill in/);
  assert.doesNotMatch(html, /No one else on your roster can play here/);
});
