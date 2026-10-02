// Android only: ESPN sign-in inside the app.
//
// Opens ESPN's real site in an in-app browser (cordova-plugin-inappbrowser). The user
// signs in on ESPN's own page -- the app never sees the password. While it's open we
// read document.cookie every 1.5 s; once `espn_s2` appears (ESPN only sets it after a
// sign-in; SWID exists for anonymous visitors too) we keep espn_s2 + SWID and close.
// Both cookies are readable by page JS on espn.com (verified 2026-10-02).

const START_URL = "https://www.espn.com/fantasy/football/";
const POLL_MS = 1500;

function deviceReady() {
  return new Promise(resolve => {
    if (globalThis.cordova?.InAppBrowser) return resolve();
    document.addEventListener("deviceready", () => resolve(), { once: true });
  });
}

export function parseEspnCookies(cookieString) {
  const jar = Object.fromEntries(String(cookieString || "").split(";").map(c => {
    const i = c.indexOf("=");
    return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  return jar.espn_s2 && jar.SWID ? { espn_s2: jar.espn_s2, swid: jar.SWID } : null;
}

// fresh=true wipes the in-app browser's session first (after "Sign out").
export async function espnLogin({ fresh = false } = {}) {
  await deviceReady();
  const opts = ["location=yes", "zoom=no", "closebuttoncaption=Cancel",
                ...(fresh ? ["clearsessioncache=yes", "clearcache=yes"] : [])].join(",");
  const ref = globalThis.cordova.InAppBrowser.open(START_URL, "_blank", opts);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, cookies) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (err) reject(err); else { resolve(cookies); ref.close(); }
    };
    const timer = setInterval(() => {
      ref.executeScript({ code: "document.cookie" }, res => {
        const c = parseEspnCookies(res?.[0]);
        if (c) finish(null, c);
      });
    }, POLL_MS);
    ref.addEventListener("exit", () => finish(new Error("Sign-in was cancelled.")));
  });
}
