// How requests reach ESPN. The only file that differs between browser and Android.
//
// Browser: plain fetch(). Public leagues only -- browsers never attach espn.com's
//   cookies to a request from our site (measured: 401 from example.com while signed in).
// Android: Capacitor's native HTTP, which isn't subject to browser cookie rules, with
//   the cookies captured at sign-in (login.js) sent as a Cookie header -- exactly what
//   sources._espn_get does in Python.

// The Android shell injects window.Capacitor; a browser never has it.
export const isNative = () => Boolean(globalThis.Capacitor?.isNativePlatform?.());

// @capacitor/core, loaded only on Android. There's no bundler: the CI build copies the
// package's ESM file to www/vendor/ (gitignored), so the web deploy never ships it.
let corePromise = null;
export const capacitorCore = () => (corePromise ??= import("/vendor/capacitor-core.js"));

// ESPN normally answers in a second or two. Without a limit, a request that stalls
// (network switch, app backgrounded) left the page on "updating..." until the app was closed.
export const REQUEST_TIMEOUT_MS = 20_000;

// Rejects after ms and calls onTimeout (to cancel the request where that's possible).
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: cancelling makes the request itself reject, and the race keeps
      // whichever settles first -- the user should see this message, not "aborted".
      reject(new Error(`ESPN didn't answer within ${Math.round(ms / 1000)} seconds. Tap Refresh to try again.`));
      onTimeout?.();
    }, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export function makeGet(cookies, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (isNative()) {
    return async (url, headers) => {
      const h = { ...headers };
      if (cookies?.espn_s2 && cookies?.swid) h.Cookie = `espn_s2=${cookies.espn_s2}; SWID=${cookies.swid}`;
      const { CapacitorHttp } = await capacitorCore();
      // The plugin's own timeouts close the socket; withTimeout covers any other stall.
      const r = await withTimeout(CapacitorHttp.get({ url, headers: h, responseType: "json",
                                                      connectTimeout: timeoutMs, readTimeout: timeoutMs }),
                                  timeoutMs);
      let data = r.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { /* not JSON */ } }
      return { status: r.status, data };
    };
  }
  return async (url, headers) => {
    const ctl = new AbortController();
    const r = await withTimeout(fetch(url, { headers, signal: ctl.signal }), timeoutMs, () => ctl.abort());
    let data = null;
    try { data = await r.json(); } catch { /* error pages aren't JSON */ }
    return { status: r.status, data };
  };
}
