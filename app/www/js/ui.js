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
const who = p => `${esc(p.name)} <span class="m">${esc(p.pos)} · ${esc(p.team)}</span>${badges(p)}`;
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

  h += card(`Close calls (under ${d.constants.close_call_margin} pts)`, d.close_calls.map(c =>
    row(`${esc(c.slot)} · ${esc(c.starter.name)} ${pts(c.starter.proj)} over ${esc(c.alt.name)} ${pts(c.alt.proj)}`,
        `<span class="pill warn">${pts(c.margin)} pts</span> started ${pts(c.starter.started_pct)}% / ${pts(c.alt.started_pct)}%`)),
    "No start/sit decisions are close.", "warn");

  h += card("Your best lineup", d.starters.map(p =>
    row(`<span class="m">${esc(p.slot)}</span> ${who(p)}`, `${game(p)} · ${pts(p.proj)}`)), "");
  return h;
}

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
    <a class="button primary" href="ffweekly://league/${encodeURIComponent(leagueId)}">Open in the app</a>
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

export const loadingPage = msg => `<p class="empty">${esc(msg || "Loading...")}</p>`;
export const errorBox = msg => `<div class="err">${esc(msg)}</div>`;
