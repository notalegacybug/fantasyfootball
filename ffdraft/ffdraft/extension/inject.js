/*
 * Runs in the PAGE's JavaScript context at document_start, before ESPN's bundle loads.
 * That timing is the whole trick: we have to replace window.WebSocket before the draft
 * room constructs one, or we see nothing.
 *
 * This file knows nothing about football. It records traffic. Parsing comes later,
 * once we've seen what the traffic actually looks like.
 */
(function () {
  "use strict";
  if (window.__ffdraftTapInstalled) return;
  window.__ffdraftTapInstalled = true;

  const MAX = 40000;                       // don't ship megabyte payloads
  const clip = (s) => (typeof s === "string" && s.length > MAX ? s.slice(0, MAX) + "…[clipped]" : s);

  function emit(kind, payload) {
    try {
      window.postMessage({ __ffdraft: true, kind, payload, t: Date.now() }, "*");
    } catch (_) { /* never let logging break the draft room */ }
  }

  // ---- WebSocket ----------------------------------------------------------
  const NativeWS = window.WebSocket;
  function TappedWebSocket(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    const u = String(url);
    emit("ws-open", { url: u });

    ws.addEventListener("message", function (e) {
      if (typeof e.data === "string") {
        emit("ws-msg", { url: u, data: clip(e.data) });
      } else if (e.data instanceof Blob) {
        e.data.text().then((t) => emit("ws-msg", { url: u, binary: true, data: clip(t) }))
                     .catch(() => emit("ws-binary", { url: u, size: e.data.size }));
      } else {
        try {
          emit("ws-msg", { url: u, binary: true,
                           data: clip(new TextDecoder().decode(e.data)) });
        } catch (_) {
          emit("ws-binary", { url: u, size: e.data.byteLength });
        }
      }
    });
    ws.addEventListener("close", () => emit("ws-close", { url: u }));

    const nativeSend = ws.send.bind(ws);
    ws.send = function (d) {
      if (typeof d === "string") emit("ws-send", { url: u, data: clip(d) });
      return nativeSend(d);
    };
    return ws;
  }
  TappedWebSocket.prototype = NativeWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k, i) => { TappedWebSocket[k] = i; });
  window.WebSocket = TappedWebSocket;

  // ---- fetch --------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      return nativeFetch.apply(this, arguments).then((res) => {
        if (/draft|pick|player|league/i.test(url)) {
          res.clone().text()
            .then((t) => emit("fetch", { url, status: res.status, data: clip(t) }))
            .catch(() => {});
        }
        return res;
      });
    };
  }

  // ---- XMLHttpRequest -----------------------------------------------------
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ffdraftUrl = url;
    this.addEventListener("load", function () {
      const u = this.__ffdraftUrl || "";
      if (!/draft|pick|player|league/i.test(u)) return;
      let body = "";
      try { body = typeof this.responseText === "string" ? this.responseText : ""; } catch (_) {}
      emit("xhr", { url: u, status: this.status, data: clip(body) });
    });
    return nativeOpen.apply(this, arguments);
  };

  emit("tap-ready", { href: location.href });
})();
