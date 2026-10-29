// Rendering only: data in, HTML out. The This-week page is a port of static/season.html.

export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pts = n => (n ?? 0).toFixed(1);
const rec = t => (t ? `${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}` : "");

function game(p) {
  if (!p.game) return "bye";
  const when = new Date(p.game.kickoff_ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  return `${p.game.home ? "vs" : "@"}${esc(p.game.opp)} · ${when}`;
}
function badges(p) {
  let b = "";
  if (p.injury && p.injury !== "ACTIVE") b += `<span class="pill danger">${esc(p.injury.replaceAll("_", " ").toLowerCase())}</span>`;
  if (p.locked) b += `<span class="pill lock">locked</span>`;
  return b;
}
const who = p => `${esc(p.name)} <span class="m">${esc(p.pos)} · ${esc(p.team)}${p.bye ? ` · bye ${p.bye}` : ""}</span>${badges(p)}`;
const slotsText = short => short.map(s => `${s.have} ${esc(s.slot)} for ${s.need} spot${s.need > 1 ? "s" : ""}`).join(", ");
function card(title, rows, empty, cls = "") {
  return `<section class="card ${cls}"><h2>${title}</h2>${rows.length ? rows.join("") : `<div class="empty">${empty}</div>`}</section>`;
}
const row = (left, right) => `<div class="row"><span>${left}</span><span class="m">${right}</span></div>`;

// For these helpers `yahoo` is true for both Yahoo modes (by hand, or read from Yahoo).
// Yahoo modes don't know waivers vs free agent, so no pill there.
const status = (p, yahoo) => (yahoo ? "" : `<span class="pill ${p.status === "WAIVERS" ? "warn" : "ok"}">${p.status === "WAIVERS" ? "waivers" : "free agent"}</span>`);
const taken = (p, manual) => (manual ? ` <button class="taken" data-taken="${p.id}">Taken</button>` : "");
// season.js words its IR advice for ESPN; the rules are the same in Yahoo, only the name differs.
const site = (text, yahoo) => (yahoo ? text.replace("ESPN can block", "Yahoo can block") : text);
// ESPN's owned % is ESPN players' ownership, not this Yahoo league's, so Yahoo mode leaves it out.
const owned = (p, yahoo) => (yahoo ? "" : ` · owned ${p.owned_change > 0 ? "+" : ""}${pts(p.owned_change)}% this week`);

// manual: null for ESPN leagues; for Yahoo-by-hand {edited: "3 days ago", hidden: [{id, name}]}.
// opts.yahoo: a league read from Yahoo (a real lineup and opponent, so ESPN's layout, but
// Yahoo's words). opts.oddScoring: the league scores plays ESPN's predictions don't count.
export function weekPage(d, manual = null, { yahoo: fromYahoo = false, oddScoring = false } = {}) {
  const yahoo = Boolean(manual) || fromYahoo;
  const gain = d.optimal_total - d.current_total;
  let h = "";
  if (oddScoring) {
    h += `<p class="m">This league scores some plays differently from usual (like 6-point passing TDs or bonuses).
      ESPN's predictions use the usual points, so treat them as a close guess.</p>`;
  }
  if (manual) {
    h += `<div class="row"><span class="m">Roster edited ${esc(manual.edited)}</span><span><button id="edit-roster">Edit roster</button>
      <button id="league-settings">League settings</button></span></div>
    <div class="stats">
      <div class="stat"><div class="l">Week ${d.week} · ${esc(d.me.name)}</div><div class="v">${pts(d.optimal_total)}</div></div>
    </div>`;
  } else {
    h += `<div class="stats">
    <div class="stat"><div class="l">Week ${d.week} · ${esc(d.me.name)} (${rec(d.me)})</div><div class="v">${pts(d.current_total)}</div></div>
    <div class="stat"><div class="l">${d.opponent ? esc(d.opponent.name) + " (" + rec(d.opponent) + ")" : "No opponent"}</div><div class="v">${d.opponent_total == null ? "-" : pts(d.opponent_total)}</div></div>
    <div class="stat"><div class="l">Points left on bench</div><div class="v ${gain > 0.05 ? "" : "good"}">${pts(gain)}</div></div>
  </div>`;
  }

  // Yahoo mode: a problem player who is still in the best lineup has no backup on the roster,
  // so "fix first" alone would contradict "Set this lineup". Say what to do instead.
  const starterIds = new Set(d.starters.map(p => p.id));
  const noBackup = p => (manual && starterIds.has(p.id)
    ? `<br><span class="m">No one else on your roster can play here. See Pickups.</span>` : "");
  // Questionable starters keep their spot (most play); say who goes in if he's ruled out.
  const ifOut = x => {
    if (!x.backup) return `<br><span class="m">No one on your bench can fill in. See Pickups.</span>`;
    const b = x.backup, first = b.game && x.player.game && b.game.kickoff_ms < x.player.game.kickoff_ms;
    return `<br><span class="m">If he's ruled out, start ${esc(b.name)} (${pts(b.proj)}). ` +
      (first ? `${esc(b.name)} plays first, so decide by then.`
             : `Inactives come out about 90 minutes before kickoff.`) + `</span>`;
  };
  // Cards with nothing to do fold into one strip of green chips at the top, so the page
  // is only as long as the work this week. On wide screens the rest flow into two columns.
  const clear = [];
  let body = "";
  const add = (n, chip, html) => { if (n) body += html; else clear.push(chip); };
  add(d.problems.length, "Fix first: all clear", card("Fix first", d.problems.map(x =>
    row(`${who(x.player)}${"backup" in x ? ifOut(x) : noBackup(x.player)}`, esc(site(x.message, yahoo)))),
    `<span class="good">All clear.</span>`, "danger"));

  add(d.ir_moves.length, "IR: nothing to move", card("IR moves", d.ir_moves.map(m =>
    row(who(m.player), `${m.from.toLowerCase()} &rarr; ${m.to.toLowerCase()} · ${esc(site(m.reason, yahoo))}`)),
    "Nothing to move."));

  if (!manual) {
    add(d.deltas.length, "Lineup: already the best", card("Lineup changes", d.deltas.map(x =>
      row(`Start ${who(x.in)}<br><span class="m">instead of ${esc(x.out.name)} (${pts(x.out.proj)})</span>`,
          `${esc(x.slot)} · ${pts(x.in.proj)} · <b class="good">+${pts(x.gain)}</b>`)),
      `<span class="good">None. Your lineup is already the best one.</span>`));
  }

  // Right after the start/sit advice: these are start/sit decisions too, just too close to call.
  add(d.close_calls.length, "Close calls: none", card(`Close calls (under ${d.constants.close_call_margin} pts)`, d.close_calls.map(c =>
    row(`${esc(c.slot)} · ${esc(c.starter.name)} ${pts(c.starter.proj)} over ${esc(c.alt.name)} ${pts(c.alt.proj)}`,
        `<span class="pill warn">${pts(c.margin)} pts</span> started ${pts(c.starter.started_pct)}% / ${pts(c.alt.started_pct)}%`)),
    "No start/sit decisions are close.", "warn"));

  // Before Pickups: on phones it then sits beside the short cards instead of below the
  // full-width Pickups list.
  body += card(manual ? "Set this lineup in Yahoo" : "Your best lineup", d.starters.map(p =>
    row(`<span class="m">${esc(p.slot)}</span> ${who(p)}`, `${game(p)} · ${pts(p.proj)}`)), "");

  // Yahoo: players hidden as taken are listed inside Pickups (or alone when Pickups is empty).
  const hiddenList = manual && manual.hidden.length ? `<p class="m hidden-list">Hidden as taken: ${manual.hidden.map(x =>
      `${esc(x.name)} <button data-untake="${esc(x.id)}">Show</button>`).join(" · ")}</p>` : "";
  if (!d.pickups.length && hiddenList) body += hiddenList;
  add(d.pickups.length, "Pickups: none worth it", card("Pickups", [...d.pickups.map(w =>
    row(`${who(w.add)} ${status(w.add, yahoo)}${taken(w.add, manual)}<br>
         <span class="m">${game(w.add)} · proj ${pts(w.add.proj)}${owned(w.add, yahoo)}</span>`,
        `+${pts(w.gain)} this week · ${w.drop ? "drop " + esc(w.drop.name) : "no drop needed"}<br>rest of season ${w.ros_delta >= 0 ? "+" : ""}${pts(w.ros_delta)}`)),
    hiddenList].filter(Boolean), "No free agent would crack your lineup this week."));


  add(d.bye_crunch.length, `Byes: covered for ${d.constants.bye_lookahead} weeks`, card("Bye weeks ahead", d.bye_crunch.map(c =>
    row(`<b>Week ${c.week}</b>: only ${slotsText(c.short)}<br>
         <span class="m">On bye: ${c.on_bye.map(p => `${esc(p.name)} (${esc(p.pos)})`).join(", ")}</span>`,
        `<span class="pill warn">plan a pickup</span>`)),
    `<span class="good">Your lineup is covered for the next ${d.constants.bye_lookahead} weeks.</span>`,
    "warn"));

  if (d.stash.length) {
    body += card("Stash (on bye now, worth holding)", d.stash.map(w =>
      row(`${who(w.add)} ${status(w.add, yahoo)}${taken(w.add, manual)}<br>
           <span class="m">on bye this week · scores 0 now</span>`,
          `rest of season <b class="good">+${pts(w.ros_delta)}</b><br>${w.drop ? "drop " + esc(w.drop.name) : "no drop needed"}`)), "");
  }

  body += `<section class="card setup">
    <h2>Weekly reminder</h2>
    <p class="m">Adds a repeating Wednesday 9 AM event to your phone's calendar, after waivers clear.
       Change the day or time in your calendar. It ends after the fantasy playoffs.</p>
    <a class="button" href="${REMINDER_URL}">Add to my calendar</a>
  </section>`;
  if (manual) {
    body += `<section class="card setup">
    <h2>Use this league on another device</h2>
    <p class="m">Makes a link with your roster in it. Send it to the other phone, and paste it there.</p>
    <button id="send-league">Make a link</button>
    <div id="transfer"></div>
  </section>`;
  }
  if (clear.length) h += `<div class="clear">${clear.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>`;
  h += `<div class="cards">${body}</div>`;
  return h;
}

// The link, ready to copy. On iPhone the Home Screen app keeps its own data apart from
// Safari, so the link is pasted inside the app rather than tapped.
export function transferBox(link) {
  return `<textarea id="transfer-link" readonly rows="3">${esc(link)}</textarea>
    <button class="primary" id="copy-link">Copy link</button>
    <p class="m">On the other phone: open the app, tap <b>League</b> if needed, and paste the link in
       <b>Got a link from another device?</b> Tapping the link in a text opens Safari instead of the app.</p>`;
}

// Absolute on purpose: inside the Android app, a link to another site opens in the phone's
// browser, which hands the .ics file to the calendar app. (A local file would just load in the app.)
const REMINDER_URL = "https://fantasyfootball-af1.pages.dev/remind.ics";

// The Yahoo sign-in. A plain link: the whole page goes to Yahoo and comes back to /#yahoo-signed-in.
const YAHOO_LOGIN = "/api/yahoo/login";

// yahooBeta: show "Sign in to Yahoo" (hidden until the device has opened /#yahoo-beta once).
// lastYahoo: {leagueKey, name} of the Yahoo league last opened through sign-in, or null.
export function setupPage(leagueId, error, yahoo = [], importError = null, yahooBeta = false, lastYahoo = null) {
  return `<section class="card setup">
    <h2>Your ESPN league</h2>
    <p class="m">Find the league ID in your ESPN league's web address: <code>...leagueId=<b>1234567</b></code></p>
    <form id="league-form">
      <input id="league-id" inputmode="numeric" autocomplete="off" placeholder="League ID" value="${esc(leagueId || "")}">
      <button class="primary" type="submit">Continue</button>
    </form>
    ${error ? `<p class="field-err">${esc(error)}</p>` : ""}
  </section>
  <section class="card setup">
    <h2>Yahoo league</h2>
    ${yahooBeta ? `<p class="m">Test version: sign in and the app reads your Yahoo league itself.</p>
    <a class="button primary" id="yahoo-signin" href="${YAHOO_LOGIN}">Sign in to Yahoo</a>
    ${lastYahoo?.leagueKey ? `<button id="yahoo-api-open">Open ${esc(lastYahoo.name || "my Yahoo league")}</button>` : ""}` : ""}
    <p class="m">Yahoo doesn't let apps read leagues yet. Enter your roster once and the app uses ESPN's predictions.</p>
    ${yahoo.map(y => `<button class="yahoo-open" data-id="${esc(y.id)}">Open ${esc(y.name)}</button>`).join("")}
    <button id="yahoo-new">My league is on Yahoo — enter my roster</button>
    <form id="import-form">
      <label class="m" for="import-link">Got a link from another device? Paste it here.</label>
      <input id="import-link" autocomplete="off" placeholder="https://...#yahoo=...">
      <button type="submit">Add league</button>
    </form>
    ${importError ? `<p class="field-err">${esc(importError)}</p>` : ""}
  </section>`;
}

// After Yahoo sign-in, when the account has no football league or more than one.
export function yahooLeaguesPage(leagues) {
  if (!leagues.length) {
    return `<section class="card setup">
    <h2>No Yahoo football leagues on this account</h2>
    <p class="m">Check that this is the Yahoo account that's in the league. You can also enter your roster by hand.</p>
    <button id="yahoo-new">Enter my roster by hand</button>
    <button id="change-league">Use a different league</button>
  </section>`;
  }
  return `<section class="card setup">
    <h2>Which Yahoo league?</h2>
    <p class="m">Remembered on this device.</p>
    ${leagues.map(l => `<button class="yahoo-league" data-key="${esc(l.key)}">${esc(l.name)} <span class="m">${esc(l.numTeams)} teams</span></button>`).join("")}
    <button id="change-league">Use a different league</button>
  </section>`;
}

// Yahoo's sign-in has run out (or was never done on this device). One tap fixes it.
export function yahooSignInPage(message) {
  return `<section class="card setup">
    <h2>Sign in to Yahoo again</h2>
    <p>${esc(message)}</p>
    <p class="m">Yahoo's own page opens, then brings you back here. Your password goes only to Yahoo.</p>
    <a class="button primary" href="${YAHOO_LOGIN}">Sign in to Yahoo</a>
    <button id="change-league">Use a different league</button>
  </section>`;
}

export function needLoginPage(leagueId) {
  return `<section class="card setup">
    <h2>Sign in to ESPN</h2>
    <p>League ${esc(leagueId)} is private (or the ID is wrong). Sign in with the ESPN account that's in this league.</p>
    <p class="m">ESPN's own page opens. Tap <b>Log In</b>, sign in, and the app continues by itself. Your password goes only to ESPN; the app keeps just the sign-in cookie, on this phone.</p>
    <button class="primary" id="login">Sign in to ESPN</button>
    <button id="change-league">Use a different league</button>
  </section>`;
}

export function privateWebPage(leagueId, apkUrl) {
  return `<section class="card setup">
    <h2>This league is private, or the ID is wrong</h2>
    <p>League ${esc(leagueId)} can't be read from a website. Browsers don't let one site use your ESPN sign-in.</p>
    <p>The Android app can: it signs in to ESPN for you.</p>
    <a class="button primary" href="rosteroptimizer://league/${encodeURIComponent(leagueId)}">Open in the app</a>
    <a class="button" href="${esc(apkUrl)}">Get the Android app</a>
    <button id="change-league">Use a different league</button>
  </section>`;
}

export function pickTeamPage(teams) {
  return `<section class="card setup">
    <h2>Which team is yours?</h2>
    <p class="m">Remembered on this device.</p>
    ${teams.map(t => `<button class="team" data-team="${t.id}">${esc(t.name)} <span class="m">${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}</span></button>`).join("")}
  </section>`;
}

const SLOT_LABELS = { QB: "QB", WR: "WR", RB: "RB", TE: "TE", FLEX: "W/R/T", K: "K", DST: "DEF", BENCH: "Bench", IR: "IR" };

// editing: true when changing a saved league (Save + Delete), false on first setup.
export function manualSetupPage(cfg, error, editing = false) {
  const scoring = [["ppr", "PPR"], ["half", "Half PPR"], ["standard", "Standard"]];
  return `<section class="card setup">
    <h2>Your Yahoo league</h2>
    <form id="manual-form">
      <label class="m" for="manual-name">League name</label>
      <input id="manual-name" autocomplete="off" placeholder="Sam's Yahoo league" value="${esc(cfg.name)}">
      <p class="m">Scoring (in Yahoo: League, then Settings)</p>
      <div class="choice">${scoring.map(([v, l]) =>
        `<label><input type="radio" name="scoring" value="${v}"${cfg.scoring === v ? " checked" : ""}> ${l}</label>`).join("")}</div>
      <p class="m">Roster spots (Yahoo's usual setup; change them to match yours)</p>
      ${Object.entries(SLOT_LABELS).map(([s, l]) => `<div class="row"><span>${l}</span><span class="stepper">
        <button type="button" data-slot="${s}" data-step="-1" aria-label="Fewer ${l}">−</button>
        <b id="slot-${s}">${esc(cfg.slots[s] || 0)}</b>
        <button type="button" data-slot="${s}" data-step="1" aria-label="More ${l}">+</button></span></div>`).join("")}
      <button class="primary" type="submit">${editing ? "Save" : "Next: add players"}</button>
      <button type="button" id="manual-cancel">Cancel</button>
    </form>
    ${error ? `<p class="field-err">${esc(error)}</p>` : ""}
    ${editing ? `<button type="button" id="manual-delete" class="danger">Delete this league from this phone</button>` : ""}
  </section>`;
}

export function rosterPage(cfg, limit, missingIds, storageOk) {
  const n = cfg.roster.filter(r => !r.ir).length;
  return `<section class="card setup">
    <h2>${esc(cfg.name)}: your roster</h2>
    ${storageOk ? "" : `<div class="err">This browser can't save your roster. It works until you close this tab.</div>`}
    <input id="search" type="search" autocomplete="off" placeholder="Player name, like Jaxon">
    <div id="results"></div>
    <p class="m">${n} of ${limit} spots${n > limit ? ` · <b class="warn-text">${n - limit} over</b>` : ""} (IR not counted)</p>
    ${cfg.roster.map(r => `<div class="row"><span>${esc(r.name)} <span class="m">${esc(r.pos)}</span>${missingIds.has(r.id) ? `<span class="pill warn">not in ESPN's list</span>` : ""}</span>
      <span>${cfg.slots.IR || r.ir ? `<button data-ir="${esc(r.id)}" aria-pressed="${r.ir === true}">${r.ir ? "In IR" : "IR"}</button>` : ""}
      <button data-remove="${esc(r.id)}" aria-label="Remove ${esc(r.name)}">×</button></span></div>`).join("")}
    <button class="primary" id="roster-done">See this week</button>
  </section>`;
}

export function searchResults(rows, query, abbrev) {
  if (query.trim().length < 2) return "";
  if (!rows.length) return `<div class="empty">Not found in ESPN's top 600.</div>`;
  return rows.map(r => `<div class="row"><span>${esc(r.name)} <span class="m">${esc(r.pos)} · ${esc(abbrev(r.pro_team_id))}</span></span>
    <button data-add="${r.player_id}">Add</button></div>`).join("");
}

// Plain-language rules behind each card. Numbers come from the code's constants (c) so the
// page can't drift from what the math actually does.
export function howItWorksPage(c) {
  const item = (title, text) => `<div class="row"><span><b>${title}</b><br><span class="m">${text}</span></span></div>`;
  return `<section class="card setup how">
    <h2>How it works</h2>
    <p>Think of a coach with a whiteboard. The app takes <b>ESPN's own point predictions</b> for every player,
       tries every legal lineup, and shows the one that scores the most. No secret formula: all numbers come from ESPN.</p>
    <p class="m">It reads your league, your roster, injuries, game times, and the top ${c.freeAgents} free agents.</p>
    ${item("Fix first", `Starters who are on bye, injured, or predicted under ${c.low} points. Also a healthy player
      sitting in IR, because ESPN can block your pickups while he's there. A questionable starter keeps his
      spot (most play), and it names who to start instead if he's ruled out.`)}
    ${item("IR moves", `Healthy players come out of IR first. Then injured (OUT or IR) players with almost no
      predicted points go into empty IR spots, which frees a bench spot.`)}
    ${item("Lineup changes", `Every legal lineup is tried (QB, RB, WR, TE, FLEX...). If yours is already the
      highest-scoring one, it says so.`)}
    ${item("Close calls", `Start/sit choices less than ${c.margin} points apart. Basically a coin flip, so
      go with your gut.`)}
    ${item("Pickups", `Each free agent is tried on your team in place of your weakest bench player (lowest
      rest-of-season prediction, so a good player on bye is never cut). The top ${c.shortlist} that raise
      this week's score are shown.`)}
    ${item("Bye weeks ahead", `Looks at the next ${c.lookahead} weeks. If the players who aren't on bye can't
      fill every starting spot, it names the week and who's off, so you can pick someone up early.`)}
    ${item("Stash", `A free agent on bye this week scores 0, so he never shows in Pickups. If his
      rest-of-season prediction beats your weakest bench player's by ${c.stashMin} or more, he's listed here.`)}
    ${item("Locked", `That player's game has started. ESPN won't let you move him, so the app doesn't suggest it.`)}
    <p class="m">Private leagues: a website can't read them (browsers keep your ESPN sign-in to ESPN).
       Make the league public, or use the Android app, which signs in for you.</p>
    <button class="primary" id="back">Back</button>
  </section>`;
}

export const loadingPage =msg => `<p class="empty">${esc(msg || "Loading...")}</p>`;
export const errorBox = msg => `<div class="err">${esc(msg)}</div>`;
