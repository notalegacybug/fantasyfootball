// Cloudflare Pages Function: Yahoo sign-in and a read-only relay to the Yahoo Fantasy API.
// The browser can't call Yahoo directly (no CORS, and the client secret must stay secret),
// so tokens live in HttpOnly cookies and this Function adds them to each request.
//
//   GET  /api/yahoo/login       -> send the user to Yahoo
//   GET  /api/yahoo/callback    -> Yahoo sends them back here; swap the code for tokens
//   GET  /api/yahoo/v2/<path>   -> relay to Yahoo (GET only); 401 {"error":"signin"} if not signed in
//   POST /api/yahoo/logout      -> forget the tokens

import { REDIRECT_URI, authUrl, parseCookies, setCookie, relayTarget, swapToken } from "../../_lib/yahoo.js";

const RT_AGE = 400 * 24 * 3600;  // refresh token: long-lived
const STATE_AGE = 600;           // sign-in must finish within 10 minutes
const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const signin = () => json({ error: "signin" }, 401);

// oldRt: Yahoo may leave refresh_token out of a refresh answer; then the old one still works,
// so keep it rather than store "undefined". A missing expires_in falls back to Yahoo's usual hour.
function withTokens(res, t, oldRt) {
  const rt = t.refresh_token || oldRt;
  if (rt) res.headers.append("Set-Cookie", setCookie("yh_rt", rt, RT_AGE));
  // Expire the access token a minute early so we never send one that's about to die.
  const life = Number(t.expires_in) || 3600;
  res.headers.append("Set-Cookie", setCookie("yh_at", t.access_token, Math.max(life - 60, 0)));
  return res;
}

// Any sign-in failure (the user tapped "Don't allow", a stale or forged state, a failed token
// swap) goes back to the app, which says so; raw JSON would be a dead end in a Home Screen app.
const signinFailed = () => new Response(null, { status: 302, headers: { Location: "/#yahoo-signin-failed" } });

export async function onRequest({ request, env, params }) {
  // Tests pass a stub through env.fetch; in production this is the global fetch.
  const fetchFn = env.fetch ?? fetch;
  const url = new URL(request.url);
  const [head, ...rest] = [params.path].flat();
  const cookies = parseCookies(request.headers.get("Cookie"));

  if (head === "login" && request.method === "GET") {
    const state = crypto.randomUUID();
    return new Response(null, {
      status: 302,
      headers: { Location: authUrl(env, state), "Set-Cookie": setCookie("yh_state", state, STATE_AGE) },
    });
  }

  if (head === "callback" && request.method === "GET") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    // The state must match the cookie we set at login, or this isn't our sign-in.
    if (!state || !code || state !== cookies.yh_state) return signinFailed();
    let t;
    try {
      t = await swapToken(env, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }, fetchFn);
    } catch { return signinFailed(); }
    return withTokens(new Response(null, { status: 302, headers: { Location: "/#yahoo-signed-in" } }), t);
  }

  if (head === "logout" && request.method === "POST") {
    const res = new Response(null, { status: 204 });
    for (const n of ["yh_rt", "yh_at", "yh_state"]) res.headers.append("Set-Cookie", setCookie(n, "", 0));
    return res;
  }

  if (head === "v2") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET" });
    const target = relayTarget(rest.join("/"), url.search);
    if (!target) return json({ error: "bad path" }, 400);

    let access = cookies.yh_at;
    let fresh = null;
    const refresh = async () => {
      if (!cookies.yh_rt) return false;
      try {
        fresh = await swapToken(env, { grant_type: "refresh_token", refresh_token: cookies.yh_rt, redirect_uri: REDIRECT_URI }, fetchFn);
      } catch { return false; }
      access = fresh.access_token;
      return true;
    };
    const get = () => fetchFn(target, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" } });

    if (!access && !(await refresh())) return signin();
    let upstream = await get();
    // Yahoo can revoke a token before its cookie expires. Refresh once and retry once;
    // if that doesn't work either, the user needs to sign in again.
    if (upstream.status === 401) {
      if (fresh || !(await refresh())) return signin();
      upstream = await get();
      if (upstream.status === 401) return signin();
    }
    const res = new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
    return fresh ? withTokens(res, fresh, cookies.yh_rt) : res;
  }

  return json({ error: "not found" }, ["login", "callback", "logout"].includes(head) ? 405 : 404);
}
