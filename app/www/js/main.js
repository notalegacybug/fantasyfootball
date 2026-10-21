// The app's flow: which league, signed in or not, which team, then the week.
//
//   league ID --(401)--> Android: sign in to ESPN | web: "private, use the app"
//            --(ok)----> team known? (saved pick, or the signed-in SWID's team)
//                        no -> pick team -> This week

import * as espn from "./espn.js";
import { buildState, findMyTeamId } from "./state.js";
import { pageJson } from "./report.js";
import { LOW_PROJECTION_FLAG, CLOSE_CALL_MARGIN, WAIVER_SHORTLIST, BYE_LOOKAHEAD,
         STASH_MIN_ROS_GAIN, rosterLimit } from "./season.js";
import * as manual from "./manual.js";
import { isNative, makeGet, capacitorCore } from "./transport.js";
import { espnLogin } from "./login.js";
import * as store from "./store.js";
import * as ui from "./ui.js";
import { packCards, repackOnResize } from "./layout.js";

const APK_URL = "https://github.com/notalegacybug/fantasyfootball/releases/latest/download/roster-optimizer.apk";
// Transfer links always point at the website: inside the Android app the origin is localhost.
const SITE = "https://fantasyfootball-af1.pages.dev";
const HOUR = 3600e3;

const $ = s => document.querySelector(s);
// The This-week cards are packed into two gap-free columns; other screens have no .cards.
const show = html => { $("#app").innerHTML = html; packCards($("#app .cards")); };
repackOnResize($("#app"), () => $("#app .cards"));

let cookies = store.load("cookies");          // Android only: {espn_s2, swid}
let settings = store.load("settings", {});    // {leagueId, teamId}

// settings is ESPN {leagueId, teamId} or Yahoo-by-hand {source: "manual", manualId}.
const isManual = () => settings.source === "manual";
const manualKey = id => `manual.${id}`;
let manualCfg = null;     // the open Yahoo setup
let manualData = null;    // {season, week, rows, pro}: lets Taken/Show redraw without ESPN
const DAY = 86400e3;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function currentSeason(get) {
  const cached = store.loadFresh("season", 12 * HOUR);
  if (cached) return cached;
  const s = await espn.fetchCurrentSeason(get);
  store.saveFresh("season", s);
  return s;
}

async function proSchedule(get, season) {
  const key = `pro.${season}`;
  const cached = store.loadFresh(key, 12 * HOUR);
  if (cached) return cached;
  const parsed = espn.parseProSchedule(await espn.fetchProSchedule(get, season));
  store.saveFresh(key, parsed);
  return parsed;
}

async function loadLeague(leagueId) {
  const get = makeGet(cookies);
  const season = await currentSeason(get);
  return { get, season, league: await espn.fetchLeague(get, leagueId, season) };
}

async function loadWeek(leagueId, teamId) {
  const { get, season, league } = await loadLeague(leagueId);
  const week = league.scoringPeriodId;
  const [freeAgents, pro] = await Promise.all([
    espn.fetchFreeAgents(get, leagueId, season, week), proSchedule(get, season)]);
  const st = buildState({ league, free_agents: freeAgents, pro_schedule: pro },
                        { swid: cookies?.swid, teamId });
  return pageJson(st);
}

async function currentWeek(get, season) {
  const key = `week.${season}`;
  const cached = store.loadFresh(key, HOUR);
  if (cached) return cached;
  const w = await espn.fetchCurrentWeek(get, season);
  store.saveFresh(key, w);
  return w;
}

// One cache key per scoring type, overwritten each week: a key per week would fill
// localStorage (~300 KB a week) by mid-season.
async function loadManualData(cfg, force) {
  const get = makeGet(null);
  const key = `pool.${cfg.scoring}`;
  const season = await currentSeason(get);
  const [week, pro] = await Promise.all([currentWeek(get, season), proSchedule(get, season)]);
  const fresh = store.loadFresh(key, 12 * HOUR);
  if (!force && fresh && fresh.season === season && fresh.week === week) {
    return { season, week, rows: fresh.rows, pro };
  }
  const fetchRows = async id => espn.parseFreeAgents(
    await espn.fetchPlayerPool(get, season, week, id), season, week);
  const rows = await manual.poolFor(fetchRows, cfg.scoring);
  store.saveFresh(key, { season, week, rows });
  return { season, week, rows, pro };
}

function saveManual() { store.save(manualKey(settings.manualId), manualCfg); }

const editedText = at => {
  const days = Math.floor((Date.now() - at) / DAY);
  return days < 1 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

// bare: a form with its own Cancel, so no Refresh/League buttons that would leave it.
function header(bare = false) {
  const signedIn = isNative() && cookies;
  const league = !bare && (settings.leagueId || isManual());
  $("#nav-right").innerHTML = [
    `<span id="age"></span>`,
    league ? `<button id="refresh">Refresh</button>` : "",
    league ? `<button id="switch">League</button>` : "",
    signedIn ? `<button id="signout">Sign out</button>` : "",
    `<button id="how" aria-label="How it works" title="How it works">?</button>`,
  ].join("");
  $("#how").addEventListener("click", howItWorks);
  $("#refresh")?.addEventListener("click", () => start({ force: true }));
  $("#switch")?.addEventListener("click", () => askLeague());
  $("#signout")?.addEventListener("click", () => {
    cookies = null;
    store.remove("cookies");
    store.save("freshLogin", true);
    settings = {};
    store.save("settings", settings);
    askLeague();
  });
}

function askLeague(error, importError) {
  screenGen++;
  history.replaceState(null, "", "/");
  const yahoo = store.load("manualIds", [])
    .map(id => ({ id, name: store.load(manualKey(id))?.name })).filter(y => y.name);
  show(ui.setupPage(settings.leagueId, error, yahoo, importError));
  header();
  $("#yahoo-new").addEventListener("click", () => yahooNew());
  $("#import-form").addEventListener("submit", e => {
    e.preventDefault();
    try { addImported(manual.importLink($("#import-link").value)); }
    catch (err) { askLeague(null, err.message); }
  });
  for (const b of document.querySelectorAll("button.yahoo-open")) {
    b.addEventListener("click", () => {
      settings = { source: "manual", manualId: b.dataset.id };
      store.save("settings", settings);
      manualCfg = null;
      manualData = null;
      start();
    });
  }
  $("#league-form").addEventListener("submit", e => {
    e.preventDefault();
    const id = $("#league-id").value.trim();
    if (!/^\d{3,12}$/.test(id)) return askLeague("A league ID is just digits, like 1234567.");
    settings = { leagueId: id, teamId: null };
    store.save("settings", settings);
    start();
  });
}

// Back goes through start(), which redraws from the saved page instantly when there is one.
function howItWorks() {
  screenGen++;
  show(ui.howItWorksPage({ low: LOW_PROJECTION_FLAG, margin: CLOSE_CALL_MARGIN,
                           shortlist: WAIVER_SHORTLIST, freeAgents: espn.FREE_AGENT_LIMIT,
                           lookahead: BYE_LOOKAHEAD, stashMin: STASH_MIN_ROS_GAIN }));
  $("#age").textContent = "";
  $("#back").addEventListener("click", () => start());
  window.scrollTo(0, 0);
}

function needLogin() {
  if (!isNative()) {
    show(ui.privateWebPage(settings.leagueId, APK_URL));
  } else {
    show(ui.needLoginPage(settings.leagueId));
    $("#login").addEventListener("click", async () => {
      show(ui.loadingPage("Waiting for you to sign in to ESPN..."));
      try {
        cookies = await espnLogin({ fresh: store.load("freshLogin", false) });
        store.save("cookies", cookies);
        store.remove("freshLogin");
        start();
      } catch (e) {
        needLogin();
        $("#app").insertAdjacentHTML("afterbegin", ui.errorBox(e.message));
      }
    });
  }
  $("#change-league").addEventListener("click", () => askLeague());
}

function pickTeam(teams) {
  show(ui.pickTeamPage(teams));
  for (const b of document.querySelectorAll("button.team")) {
    b.addEventListener("click", () => {
      settings.teamId = Number(b.dataset.team);
      store.save("settings", settings);
      start();
    });
  }
}

// First setup, or (editing) changing the open league's name, scoring or spots.
function yahooNew(error, draft, editing = false) {
  screenGen++;
  const cfg = draft ?? (editing ? structuredClone(manualCfg)
                                : manual.newConfig("", "ppr", manual.YAHOO_DEFAULT_SLOTS));
  show(ui.manualSetupPage(cfg, error, editing));
  header(true);
  for (const b of document.querySelectorAll("button[data-slot]")) {
    b.addEventListener("click", () => {
      const s = b.dataset.slot;
      cfg.slots[s] = Math.max(0, Math.min(10, (cfg.slots[s] || 0) + Number(b.dataset.step)));
      $(`#slot-${s}`).textContent = cfg.slots[s];
    });
  }
  $("#manual-cancel").addEventListener("click", () => (editing ? start() : askLeague()));
  $("#manual-delete")?.addEventListener("click", () => {
    if (!confirm(`Delete ${manualCfg.name} from this phone? Its roster will be gone.`)) return;
    store.remove(manualKey(settings.manualId));
    store.save("manualIds", store.load("manualIds", []).filter(id => id !== settings.manualId));
    settings = {};
    store.save("settings", settings);
    manualCfg = null;
    manualData = null;
    askLeague();
  });
  $("#manual-form").addEventListener("submit", e => {
    e.preventDefault();
    cfg.name = $("#manual-name").value.trim();
    cfg.scoring = document.querySelector("input[name=scoring]:checked")?.value || "ppr";
    if (!cfg.name) return yahooNew("Give the league a name, so you can tell it apart later.", cfg, editing);
    const saved = manual.applySettings(cfg, cfg);
    if (editing) {
      if (saved.scoring !== manualCfg.scoring) manualData = null;   // other predictions
      manualCfg = saved;
      saveManual();
      return start();
    }
    const id = Date.now().toString(36);
    store.save("manualIds", [...store.load("manualIds", []), id]);
    settings = { source: "manual", manualId: id };
    store.save("settings", settings);
    manualCfg = saved;
    manualData = null;
    saveManual();
    rosterScreen();
  });
}

// A league from another device. Same name as one already here -> offered as an update (it
// replaces that one, Taken list included), and only if the user says yes.
function addImported(cfg) {
  const ids = store.load("manualIds", []);
  let id = ids.find(i => store.load(manualKey(i))?.name === cfg.name);
  if (id && !confirm(`Replace your saved "${cfg.name}" with the one in this link? `
                     + "Its roster and Taken list will be the link's.")) return askLeague();
  if (!id) {
    id = Date.now().toString(36);
    store.save("manualIds", [...ids, id]);
  }
  settings = { source: "manual", manualId: id };
  store.save("settings", settings);
  manualCfg = cfg;
  manualData = null;
  saveManual();
  start();
}

async function rosterScreen() {
  const gen = ++screenGen;
  header();
  if (!manualData) {
    show(ui.loadingPage("Loading ESPN's player list..."));
    // Assigned only if still current: a late load for another Yahoo league must not stick.
    let data;
    try { data = await loadManualData(manualCfg, false); }
    catch (e) { if (gen === screenGen) show(ui.errorBox(`Couldn't reach ESPN: ${e.message}`)); return; }
    if (gen !== screenGen) return;
    manualData = data;
  }
  const { rows, pro } = manualData;
  const inPool = new Set(rows.map(r => r.player_id));
  const missing = new Set(manualCfg.roster.filter(e => !inPool.has(e.id)).map(e => e.id));
  show(ui.rosterPage(manualCfg, rosterLimit(manualCfg.slots), missing, store.available()));
  const abbrev = id => pro[id]?.abbrev || "FA";
  const search = $("#search");
  // Only #results redraws while typing, so the box keeps focus and what's typed.
  search.addEventListener("input", () => {
    const mine = new Set(manualCfg.roster.map(e => e.id));
    $("#results").innerHTML = ui.searchResults(manual.searchPool(rows, search.value, mine), search.value, abbrev);
  });
  const edited = () => { manualCfg.editedAt = Date.now(); saveManual(); rosterScreen(); };
  $("#results").addEventListener("click", e => {
    const id = Number(e.target.closest("button[data-add]")?.dataset.add);
    const row = rows.find(r => r.player_id === id);
    if (!row) return;
    manualCfg.roster.push(manual.rosterEntry(row));
    edited();
  });
  for (const b of document.querySelectorAll("button[data-ir]")) {
    b.addEventListener("click", () => {
      const e = manualCfg.roster.find(r => r.id === Number(b.dataset.ir));
      e.ir = !e.ir;
      edited();
    });
  }
  for (const b of document.querySelectorAll("button[data-remove]")) {
    b.addEventListener("click", () => {
      manualCfg.roster = manualCfg.roster.filter(r => r.id !== Number(b.dataset.remove));
      edited();
    });
  }
  $("#roster-done").addEventListener("click", () => {
    if (!manualCfg.roster.length) return $("#search").focus();
    start();
  });
  search.focus();
}

function showManualWeek() {
  const { season, week, rows, pro } = manualData;
  const st = manual.buildManualState(manualCfg, rows, pro, { season, week, nowMs: Date.now() });
  const hidden = manual.hiddenPlayers(manualCfg, rows);
  show(ui.weekPage(pageJson(st), { edited: editedText(manualCfg.editedAt), hidden }));
  $("#age").textContent = `ESPN predictions, week ${week}`;
  $("#edit-roster").addEventListener("click", () => rosterScreen());
  $("#league-settings").addEventListener("click", () => yahooNew(null, null, true));
  $("#send-league").addEventListener("click", () => {
    const link = manual.exportLink(manualCfg, SITE);
    $("#transfer").innerHTML = ui.transferBox(link);
    const box = $("#transfer-link");
    $("#copy-link").addEventListener("click", async e => {
      try { await navigator.clipboard.writeText(link); e.target.textContent = "Copied"; }
      catch { box.select(); e.target.textContent = "Selected: copy it"; }
    });
  });
  for (const b of document.querySelectorAll("button[data-taken]")) {
    b.addEventListener("click", () => {
      const id = Number(b.dataset.taken);
      manual.markTaken(manualCfg, rows.find(r => r.player_id === id) ?? { player_id: id, name: "" });
      saveManual();
      showManualWeek();
    });
  }
  for (const b of document.querySelectorAll("button[data-untake]")) {
    b.addEventListener("click", () => {
      manual.unmarkTaken(manualCfg, Number(b.dataset.untake));
      saveManual();
      showManualWeek();
    });
  }
}

async function startManual({ force = false } = {}) {
  const gen = ++screenGen;
  history.replaceState(null, "", "/");
  manualCfg = manual.readConfig(store.load(manualKey(settings.manualId))) ?? manualCfg;
  if (!manualCfg) {
    settings = {};
    store.save("settings", settings);
    return askLeague("That Yahoo league isn't saved on this device any more. Set it up again.");
  }
  if (!manualCfg.roster.length) return rosterScreen();
  show(ui.loadingPage("Reading ESPN's predictions..."));
  let data, offline = false;
  try {
    data = await loadManualData(manualCfg, force);
  } catch (e) {
    // No network: fall back to this session's load, else the predictions saved on the phone.
    const pool = store.load(`pool.${manualCfg.scoring}`)?.value;
    data = manualData ?? manual.savedData(pool, pool && store.load(`pro.${pool.season}`)?.value);
    if (gen === screenGen && !data) show(ui.errorBox(`Couldn't reach ESPN: ${e.message}`));
    offline = true;
  }
  if (gen !== screenGen || !data) return;
  manualData = data;
  showManualWeek();
  if (offline) $("#age").textContent = "couldn't reach ESPN, showing saved predictions";
}

function showWeek(page, at, note) {
  show(ui.weekPage(page));
  const mins = Math.round((Date.now() - at) / 60e3);
  $("#age").textContent = `ESPN data ${mins < 1 ? "just now" : mins + " min old"}${note ? " · " + note : ""}`;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

// Bumped whenever another screen takes over, so a slow ESPN load can't paint over it.
let screenGen = 0;

async function start({ force = false } = {}) {
  const gen = ++screenGen;
  const stale = () => gen !== screenGen;
  header();
  if (isManual()) return startManual({ force });
  if (!settings.leagueId) return askLeague();
  history.replaceState(null, "", `/league/${settings.leagueId}`);
  const cacheKey = `page.${settings.leagueId}.${settings.teamId ?? "me"}`;
  const cached = store.load(cacheKey);
  if (cached && !force) showWeek(cached.page, cached.at, "updating...");
  else show(ui.loadingPage("Reading your league from ESPN..."));

  try {
    // Team not known yet: read the league once to list teams (or find the SWID's team).
    if (settings.teamId == null) {
      const { league } = await loadLeague(settings.leagueId);
      const teams = espn.parseLeague(league).teams;
      if (stale()) return;
      const mine = findMyTeamId(teams, cookies?.swid);
      if (mine === null) return pickTeam(teams);
      settings.teamId = mine;
      store.save("settings", settings);
    }
    const page = await loadWeek(settings.leagueId, settings.teamId);
    const at = Date.now();
    store.save(`page.${settings.leagueId}.${settings.teamId}`, { page, at });
    if (!stale()) showWeek(page, at);
  } catch (e) {
    if (stale()) return;
    if (e.status === 401) return needLogin();
    if (cached) return showWeek(cached.page, cached.at, "couldn't reach ESPN, showing saved copy");
    show(ui.errorBox(`Couldn't read your league: ${e.message}`));
  }
}

// /league/<id> pre-fills the league (shared links); the team is never in the link.
function leagueFromPath(path) {
  const m = /\/league\/(\d{3,12})/.exec(path || "");
  return m ? m[1] : null;
}

function openLeague(id) {
  if (id && id !== settings.leagueId) {
    settings = { leagueId: id, teamId: null };
    store.save("settings", settings);
  }
  start();
}

// Android: rosteroptimizer://league/<id> from the web app's "Open in the app" button.
const fromAppUrl = url => (url ? leagueFromPath(url.replace("rosteroptimizer://", "/")) : null);
if (isNative()) {
  capacitorCore().then(async ({ registerPlugin }) => {
    const App = registerPlugin("App");
    App.addListener("appUrlOpen", ({ url }) => openLeague(fromAppUrl(url)));
    const launch = await App.getLaunchUrl().catch(() => null);
    openLeague(fromAppUrl(launch?.url));
  }).catch(e => show(ui.errorBox(`App failed to start: ${e.message}`)));
} else if (location.hash.startsWith("#yahoo=")) {
  // A transfer link tapped (laptop, Android browser): add it, then drop it from the address bar.
  const link = location.hash;
  history.replaceState(null, "", "/");
  // A tapped link could come from anyone: say what it adds before saving anything.
  let cfg = null;
  try { cfg = manual.importLink(link); }
  catch (e) { askLeague(null, e.message); }
  if (cfg) {
    if (confirm(`Add the Yahoo league "${cfg.name}" (${cfg.roster.length} players) from this link?`)) addImported(cfg);
    else askLeague();
  }
} else {
  openLeague(leagueFromPath(location.pathname));
}
