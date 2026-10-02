// The app's flow: which league, signed in or not, which team, then the week.
//
//   league ID --(401)--> Android: sign in to ESPN | web: "private, use the app"
//            --(ok)----> team known? (saved pick, or the signed-in SWID's team)
//                        no -> pick team -> This week

import * as espn from "./espn.js";
import { buildState, findMyTeamId } from "./state.js";
import { pageJson } from "./report.js";
import { isNative, makeGet, capacitorCore } from "./transport.js";
import { espnLogin } from "./login.js";
import * as store from "./store.js";
import * as ui from "./ui.js";

const APK_URL = "https://github.com/notalegacybug/fantasyfootball/releases/latest/download/fantasy-weekly.apk";
const HOUR = 3600e3;

const $ = s => document.querySelector(s);
const show = html => { $("#app").innerHTML = html; };

let cookies = store.load("cookies");          // Android only: {espn_s2, swid}
let settings = store.load("settings", {});    // {leagueId, teamId}

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

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function header() {
  const signedIn = isNative() && cookies;
  $("#nav-right").innerHTML = [
    `<span id="age"></span>`,
    settings.leagueId ? `<button id="refresh">Refresh</button>` : "",
    settings.leagueId ? `<button id="switch">League</button>` : "",
    signedIn ? `<button id="signout">Sign out</button>` : "",
  ].join("");
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

function askLeague(error) {
  history.replaceState(null, "", "/");
  show(ui.setupPage(settings.leagueId, error));
  header();
  $("#league-form").addEventListener("submit", e => {
    e.preventDefault();
    const id = $("#league-id").value.trim();
    if (!/^\d{3,12}$/.test(id)) return askLeague("A league ID is just digits, like 1234567.");
    settings = { leagueId: id, teamId: null };
    store.save("settings", settings);
    start();
  });
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

function showWeek(page, at, note) {
  show(ui.weekPage(page));
  const mins = Math.round((Date.now() - at) / 60e3);
  $("#age").textContent = `ESPN data ${mins < 1 ? "just now" : mins + " min old"}${note ? " · " + note : ""}`;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

async function start({ force = false } = {}) {
  header();
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
      const mine = findMyTeamId(teams, cookies?.swid);
      if (mine === null) return pickTeam(teams);
      settings.teamId = mine;
      store.save("settings", settings);
    }
    const page = await loadWeek(settings.leagueId, settings.teamId);
    const at = Date.now();
    store.save(`page.${settings.leagueId}.${settings.teamId}`, { page, at });
    showWeek(page, at);
  } catch (e) {
    if (e.status === 401) return needLogin();
    if (cached) return showWeek(cached.page, cached.at, "offline, showing saved copy");
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

// Android: ffweekly://league/<id> from the web app's "Open in the app" button.
const fromAppUrl = url => (url ? leagueFromPath(url.replace("ffweekly://", "/")) : null);
if (isNative()) {
  capacitorCore().then(async ({ registerPlugin }) => {
    const App = registerPlugin("App");
    App.addListener("appUrlOpen", ({ url }) => openLeague(fromAppUrl(url)));
    const launch = await App.getLaunchUrl().catch(() => null);
    openLeague(fromAppUrl(launch?.url));
  }).catch(e => show(ui.errorBox(`App failed to start: ${e.message}`)));
} else {
  openLeague(leagueFromPath(location.pathname));
}
