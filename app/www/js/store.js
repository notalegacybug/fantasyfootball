// Everything the app remembers, on this device only: league, team, ESPN cookies
// (Android), the last good page, and the parsed NFL schedule. Nothing goes to a server.
// Storage can be unavailable (private windows, blocked site data), so every access is
// guarded and the app still works -- it just forgets.

const PREFIX = "ffw.";

export function load(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* forget */ }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* nothing to do */ }
}

// Value cached with a time-to-live: returns null once older than ttlMs.
export function loadFresh(key, ttlMs) {
  const v = load(key);
  return v && Date.now() - v.at < ttlMs ? v.value : null;
}

export function saveFresh(key, value) { save(key, { at: Date.now(), value }); }
