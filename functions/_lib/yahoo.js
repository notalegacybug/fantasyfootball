// Pure helpers for the Yahoo Pages Function. Kept free of Request/Response so they
// are easy to test; the router in functions/api/yahoo/[[path]].js wires them up.

const LOGIN = "https://api.login.yahoo.com/oauth2";
const API = "https://fantasysports.yahooapis.com/fantasy/v2/";

// Fixed on purpose: Yahoo requires this to match the registered app exactly, so we never
// derive it from the incoming request.
export const REDIRECT_URI = "https://fantasyfootball-af1.pages.dev/api/yahoo/callback";

// Read-only scope on purpose: the app can look at leagues but never change them.
export function authUrl(env, state) {
  const q = new URLSearchParams({
    client_id: env.YAHOO_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "fspt-r",
    state,
  });
  return `${LOGIN}/request_auth?${q}`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
  }
  return out;
}

// HttpOnly keeps the token away from page scripts; Path limits it to our own endpoints.
export function setCookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSec}; Path=/api/yahoo; HttpOnly; Secure; SameSite=Lax`;
}

// Build the Yahoo URL for a relayed GET, or null if the path could point anywhere
// other than the fantasy API. We check the raw text, before any decoding, so an
// encoded "../" can't slip through.
export function relayTarget(pathAfterV2, search) {
  const p = pathAfterV2 || "";
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("//") || p.includes("..") ||
      p.includes(":") || /%(2e|2f|5c)/i.test(p)) return null;
  const q = new URLSearchParams(search || "");
  q.set("format", "json"); // Yahoo defaults to XML
  return `${API}${p}?${q}`;
}

// Trade a sign-in code or a refresh token for tokens. params: {grant_type, code, redirect_uri}
// or {grant_type, refresh_token}. Throws on any non-200 so callers can treat it as "sign in again".
export async function swapToken(env, params, fetchFn) {
  const res = await fetchFn(`${LOGIN}/get_token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  const { access_token, refresh_token, expires_in } = await res.json();
  return { access_token, refresh_token, expires_in };
}
