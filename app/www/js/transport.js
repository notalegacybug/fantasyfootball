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

export function makeGet(cookies) {
  if (isNative()) {
    return async (url, headers) => {
      const h = { ...headers };
      if (cookies?.espn_s2 && cookies?.swid) h.Cookie = `espn_s2=${cookies.espn_s2}; SWID=${cookies.swid}`;
      const { CapacitorHttp } = await capacitorCore();
      const r = await CapacitorHttp.get({ url, headers: h, responseType: "json" });
      let data = r.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { /* not JSON */ } }
      return { status: r.status, data };
    };
  }
  return async (url, headers) => {
    const r = await fetch(url, { headers });
    let data = null;
    try { data = await r.json(); } catch { /* error pages aren't JSON */ }
    return { status: r.status, data };
  };
}
