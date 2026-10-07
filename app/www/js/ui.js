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

export function weekPage(d) {
  const gain = d.optimal_total - d.current_total;
  let h = `<div class="stats">
    <div class="stat"><div class="l">Week ${d.week} · ${esc(d.me.name)} (${rec(d.me)})</div><div class="v">${pts(d.current_total)}</div></div>
    <div class="stat"><div class="l">${d.opponent ? esc(d.opponent.name) + " (" + rec(d.opponent) + ")" : "No opponent"}</div><div class="v">${d.opponent_total == null ? "-" : pts(d.opponent_total)}</div></div>
    <div class="stat"><div class="l">Points left on bench</div><div class="v ${gain > 0.05 ? "" : "good"}">${pts(gain)}</div></div>
  </div>`;

  h += card("Fix first", d.problems.map(x => row(who(x.player), esc(x.message))),
    `<span class="good">All clear.</span>`, d.problems.length ? "danger" : "");

  h += card("IR moves", d.ir_moves.map(m =>
    row(who(m.player), `${m.from.toLowerCase()} &rarr; ${m.to.toLowerCase()} · ${esc(m.reason)}`)),
    "Nothing to move.");

  h += card("Lineup changes", d.deltas.map(x =>
    row(`Start ${who(x.in)}<br><span class="m">instead of ${esc(x.out.name)} (${pts(x.out.proj)})</span>`,
        `${esc(x.slot)} · ${pts(x.in.proj)} · <b class="good">+${pts(x.gain)}</b>`)),
    `<span class="good">None. Your lineup is already the best one.</span>`);

  h += card("Pickups", d.pickups.map(w =>
    row(`${who(w.add)} <span class="pill ${w.add.status === "WAIVERS" ? "warn" : "ok"}">${w.add.status === "WAIVERS" ? "waivers" : "free agent"}</span><br>
         <span class="m">${game(w.add)} · proj ${pts(w.add.proj)} · owned ${w.add.owned_change > 0 ? "+" : ""}${pts(w.add.owned_change)}% this week</span>`,
        `+${pts(w.gain)} this week · ${w.drop ? "drop " + esc(w.drop.name) : "no drop needed"}<br>rest of season ${w.ros_delta >= 0 ? "+" : ""}${pts(w.ros_delta)}`)),
    "No free agent would crack your lineup this week.");

  h += card("Bye weeks ahead", d.bye_crunch.map(c =>
    row(`<b>Week ${c.week}</b>: only ${slotsText(c.short)}<br>
         <span class="m">On bye: ${c.on_bye.map(p => `${esc(p.name)} (${esc(p.pos)})`).join(", ")}</span>`,
        `<span class="pill warn">plan a pickup</span>`)),
    `<span class="good">Your lineup is covered for the next ${d.constants.bye_lookahead} weeks.</span>`,
    d.bye_crunch.length ? "warn" : "");

  if (d.stash.length) {
    h += card("Stash (on bye now, worth holding)", d.stash.map(w =>
      row(`${who(w.add)} <span class="pill ${w.add.status === "WAIVERS" ? "warn" : "ok"}">${w.add.status === "WAIVERS" ? "waivers" : "free agent"}</span><br>
           <span class="m">on bye this week · scores 0 now</span>`,
          `rest of season <b class="good">+${pts(w.ros_delta)}</b><br>${w.drop ? "drop " + esc(w.drop.name) : "no drop needed"}`)), "");
  }

  h += card(`Close calls (under ${d.constants.close_call_margin} pts)`, d.close_calls.map(c =>
    row(`${esc(c.slot)} · ${esc(c.starter.name)} ${pts(c.starter.proj)} over ${esc(c.alt.name)} ${pts(c.alt.proj)}`,
        `<span class="pill warn">${pts(c.margin)} pts</span> started ${pts(c.starter.started_pct)}% / ${pts(c.alt.started_pct)}%`)),
    "No start/sit decisions are close.", "warn");

  h += card("Your best lineup", d.starters.map(p =>
    row(`<span class="m">${esc(p.slot)}</span> ${who(p)}`, `${game(p)} · ${pts(p.proj)}`)), "");

  h += `<section class="card setup">
    <h2>Weekly reminder</h2>
    <p class="m">Adds a repeating Wednesday 9 AM event to your phone's calendar, after waivers clear.
       Change the day or time in your calendar. It ends after the fantasy playoffs.</p>
    <a class="button" href="${REMINDER_URL}">Add to my calendar</a>
  </section>`;
  return h;
}

// Absolute on purpose: inside the Android app, a link to another site opens in the phone's
// browser, which hands the .ics file to the calendar app. (A local file would just load in the app.)
const REMINDER_URL = "https://fantasyfootball-af1.pages.dev/remind.ics";

export function setupPage(leagueId, error) {
  return `<section class="card setup">
    <h2>Your ESPN league</h2>
    <p class="m">Find the league ID in your ESPN league's web address: <code>...leagueId=<b>1234567</b></code></p>
    <form id="league-form">
      <input id="league-id" inputmode="numeric" autocomplete="off" placeholder="League ID" value="${esc(leagueId || "")}">
      <button class="primary" type="submit">Continue</button>
    </form>
    ${error ? `<p class="field-err">${esc(error)}</p>` : ""}
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
      sitting in IR, because ESPN can block your pickups while he's there.`)}
    ${item("IR moves", `Healthy players come out of IR first. Then injured (OUT or IR) players with almost no
      predicted points go into empty IR spots, which frees a bench spot.`)}
    ${item("Lineup changes", `Every legal lineup is tried (QB, RB, WR, TE, FLEX...). If yours is already the
      highest-scoring one, it says so.`)}
    ${item("Pickups", `Each free agent is tried on your team in place of your weakest bench player (lowest
      rest-of-season prediction, so a good player on bye is never cut). The top ${c.shortlist} that raise
      this week's score are shown.`)}
    ${item("Bye weeks ahead", `Looks at the next ${c.lookahead} weeks. If the players who aren't on bye can't
      fill every starting spot, it names the week and who's off, so you can pick someone up early.`)}
    ${item("Stash", `A free agent on bye this week scores 0, so he never shows in Pickups. If his
      rest-of-season prediction beats your weakest bench player's by ${c.stashMin} or more, he's listed here.`)}
    ${item("Close calls", `Start/sit choices less than ${c.margin} points apart. Basically a coin flip, so
      go with your gut.`)}
    ${item("Locked", `That player's game has started. ESPN won't let you move him, so the app doesn't suggest it.`)}
    <p class="m">Private leagues: a website can't read them (browsers keep your ESPN sign-in to ESPN).
       Make the league public, or use the Android app, which signs in for you.</p>
    <button class="primary" id="back">Back</button>
  </section>`;
}

export const loadingPage =msg => `<p class="empty">${esc(msg || "Loading...")}</p>`;
export const errorBox = msg => `<div class="err">${esc(msg)}</div>`;
