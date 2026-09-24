/*
 * Runs in the extension's own context. Its only job is to take what inject.js
 * saw in the page and get it to 127.0.0.1:8777, batched so we don't fire a
 * request per WebSocket frame.
 */
(function () {
  "use strict";
  const ENDPOINT = "http://127.0.0.1:8777/api/ingest";
  const FLUSH_MS = 700;

  let queue = [];
  let dropped = 0;
  let online = false;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__ffdraft !== true) return;
    if (queue.length > 500) { dropped++; return; }
    queue.push({ kind: d.kind, payload: d.payload, t: d.t, href: location.href });
  });

  async function flush() {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try {
      await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch, dropped }),
      });
      dropped = 0;
      if (!online) { online = true; console.log("[draft bridge] connected to local board"); }
    } catch (err) {
      // Server not running. Put the batch back, capped, and keep trying.
      if (queue.length < 300) queue = batch.concat(queue);
      if (online) { online = false; console.warn("[draft bridge] local board unreachable"); }
    }
  }

  setInterval(flush, FLUSH_MS);
  console.log("[draft bridge] active on", location.href);
})();
