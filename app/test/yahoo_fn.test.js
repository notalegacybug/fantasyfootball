// The Yahoo Pages Function: sign-in redirect, token swap, and the read-only relay.
// Yahoo is never called for real; a stub fetch is passed in through env.fetch.
//
//     cd app && node --test test/yahoo_fn.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../../functions/api/yahoo/[[path]].js";
import { relayTarget } from "../../functions/_lib/yahoo.js";

const ORIGIN = "https://example.test";

// A fake env: dummy credentials plus a fetch that records calls and replies from a queue.
function fakeEnv(replies = []) {
  const calls = [];
  const env = {
    YAHOO_CLIENT_ID: "dummy-id",
    YAHOO_CLIENT_SECRET: "dummy-secret",
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const r = replies.shift();
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    },
  };
  return env;
}

// Run the Function the way Pages does: params.path is the segments after /api/yahoo/.
function call(env, method, path, { cookie, search = "" } = {}) {
  const url = `${ORIGIN}/api/yahoo/${path}${search}`;
  const headers = cookie ? { cookie } : {};
  return onRequest({ request: new Request(url, { method, headers }), env, params: { path: path.split("/") } });
}

const cookiesOf = res => res.headers.getSetCookie();
const find = (res, name) => cookiesOf(res).find(c => c.startsWith(name + "="));

test("login redirects to Yahoo and stores the same state in a cookie", async () => {
  const res = await call(fakeEnv(), "GET", "login");
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"));
  assert.equal(loc.host, "api.login.yahoo.com");
  assert.equal(loc.searchParams.get("scope"), "fspt-r");
  assert.equal(loc.searchParams.get("response_type"), "code");
  const cookie = find(res, "yh_state");
  assert.ok(cookie);
  assert.equal(loc.searchParams.get("redirect_uri"), "https://fantasyfootball-af1.pages.dev/api/yahoo/callback");
  assert.equal(cookie.split(";")[0].split("=")[1], loc.searchParams.get("state"));
});

test("callback with a mismatched state is rejected and fetches nothing", async () => {
  const env = fakeEnv();
  const res = await call(env, "GET", "callback", { search: "?code=abc&state=wrong", cookie: "yh_state=right" });
  assert.equal(res.status, 400);
  assert.equal(env.calls.length, 0);
});

test("callback with a good state sets both token cookies and goes home", async () => {
  const env = fakeEnv([{ body: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } }]);
  const res = await call(env, "GET", "callback", { search: "?code=abc&state=s1", cookie: "yh_state=s1" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/#yahoo-signed-in");
  for (const name of ["yh_rt", "yh_at"]) {
    const c = find(res, name);
    assert.ok(c, name);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/yahoo"]) assert.ok(c.includes(attr), `${name} ${attr}`);
  }
  assert.ok(find(res, "yh_at").includes("Max-Age=3540"));
  assert.equal(env.calls[0].url, "https://api.login.yahoo.com/oauth2/get_token");
  assert.match(env.calls[0].init.body, /redirect_uri=https%3A%2F%2Ffantasyfootball-af1\.pages\.dev%2Fapi%2Fyahoo%2Fcallback/);
  assert.equal(env.calls[0].init.headers.Authorization, "Basic " + btoa("dummy-id:dummy-secret"));
});

test("relayTarget builds the Yahoo URL with format=json", () => {
  assert.equal(relayTarget("league/470.l.1/teams", ""),
    "https://fantasysports.yahooapis.com/fantasy/v2/league/470.l.1/teams?format=json");
  assert.equal(relayTarget("league/470.l.1/teams", "?out=settings&format=xml"),
    "https://fantasysports.yahooapis.com/fantasy/v2/league/470.l.1/teams?out=settings&format=json");
});

test("relayTarget rejects anything that could escape the Yahoo API", () => {
  for (const bad of ["../x", "//evil.com/x", "https://evil.com", "a\\b", "a/%2e%2e/b", "a/%2E%2E/b", ""]) {
    assert.equal(relayTarget(bad, ""), null, bad);
  }
});

test("relay with only a refresh token refreshes once, then calls Yahoo with the new token", async () => {
  const env = fakeEnv([
    { body: { access_token: "NEW", refresh_token: "RT2", expires_in: 3600 } },
    { body: { fantasy_content: { ok: 1 } } },
  ]);
  const res = await call(env, "GET", "v2/league/470.l.1/teams", { cookie: "yh_rt=RT1" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { fantasy_content: { ok: 1 } });
  assert.equal(env.calls.length, 2);
  assert.match(env.calls[0].init.body, /grant_type=refresh_token/);
  assert.equal(env.calls[1].url, "https://fantasysports.yahooapis.com/fantasy/v2/league/470.l.1/teams?format=json");
  assert.equal(env.calls[1].init.headers.Authorization, "Bearer NEW");
  assert.ok(find(res, "yh_at").startsWith("yh_at=NEW"));
  assert.ok(find(res, "yh_rt").startsWith("yh_rt=RT2"));
});

test("relay with an access token goes straight to Yahoo and passes the status through", async () => {
  const env = fakeEnv([{ status: 404, body: { error: "nope" } }]);
  const res = await call(env, "GET", "v2/league/9", { cookie: "yh_at=AT" });
  assert.equal(res.status, 404);
  assert.equal(env.calls.length, 1);
  assert.equal(cookiesOf(res).length, 0);
});

test("relay with no cookies, or a failed refresh, says sign in", async () => {
  const none = await call(fakeEnv(), "GET", "v2/league/1");
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { error: "signin" });

  const env = fakeEnv([{ status: 400, body: { error: "invalid_grant" } }]);
  const failed = await call(env, "GET", "v2/league/1", { cookie: "yh_rt=old" });
  assert.equal(failed.status, 401);
  assert.deepEqual(await failed.json(), { error: "signin" });
  assert.equal(env.calls.length, 1);
});

test("POST to the relay is 405; logout clears all three cookies; unknown path is 404", async () => {
  assert.equal((await call(fakeEnv(), "POST", "v2/league/1")).status, 405);
  const out = await call(fakeEnv(), "POST", "logout");
  assert.equal(out.status, 204);
  for (const n of ["yh_rt", "yh_at", "yh_state"]) assert.ok(find(out, n).includes("Max-Age=0"), n);
  assert.equal((await call(fakeEnv(), "GET", "nothing")).status, 404);
});

test("a revoked access token is refreshed once and the call retried", async () => {
  const env = fakeEnv([
    { status: 401, body: { error: "revoked" } },
    { body: { access_token: "NEW", refresh_token: "RT2", expires_in: 3600 } },
    { body: { fantasy_content: { ok: 1 } } },
  ]);
  const res = await call(env, "GET", "v2/league/1", { cookie: "yh_at=OLD; yh_rt=RT" });
  assert.equal(res.status, 200);
  assert.equal(env.calls.length, 3);
  assert.match(env.calls[1].init.body, /grant_type=refresh_token/);
  assert.equal(env.calls[2].init.headers.Authorization, "Bearer NEW");
  assert.ok(find(res, "yh_at").startsWith("yh_at=NEW"));
  assert.ok(find(res, "yh_rt").startsWith("yh_rt=RT2"));
});

test("a revoked access token with no refresh token, a failed refresh, or a failed retry says sign in", async () => {
  const noRt = fakeEnv([{ status: 401, body: {} }]);
  const a = await call(noRt, "GET", "v2/league/1", { cookie: "yh_at=OLD" });
  assert.equal(a.status, 401);
  assert.deepEqual(await a.json(), { error: "signin" });

  const badRefresh = fakeEnv([{ status: 401, body: {} }, { status: 400, body: {} }]);
  const b = await call(badRefresh, "GET", "v2/league/1", { cookie: "yh_at=OLD; yh_rt=RT" });
  assert.equal(b.status, 401);
  assert.deepEqual(await b.json(), { error: "signin" });

  const stillBad = fakeEnv([
    { status: 401, body: {} },
    { body: { access_token: "NEW", refresh_token: "RT2", expires_in: 3600 } },
    { status: 401, body: {} },
  ]);
  const c = await call(stillBad, "GET", "v2/league/1", { cookie: "yh_at=OLD; yh_rt=RT" });
  assert.equal(c.status, 401);
  assert.deepEqual(await c.json(), { error: "signin" });
  assert.equal(stillBad.calls.length, 3);
});
