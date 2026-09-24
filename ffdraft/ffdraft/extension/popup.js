async function tick() {
  try {
    const r = await fetch("http://127.0.0.1:8777/api/ingest/status");
    const d = await r.json();
    document.getElementById("dot").classList.add("on");
    document.getElementById("status").textContent = "Local board connected";
    document.getElementById("events").textContent = d.events;
    document.getElementById("ws").textContent = d.ws_frames;
    document.getElementById("mode").textContent = d.mode;
    document.getElementById("hint").textContent = d.ws_frames > 0
      ? "Frames are landing. Run analyze_recon.py to see what they contain."
      : "No websocket frames yet. Make sure the draft room tab was opened AFTER installing this.";
  } catch (e) {
    document.getElementById("dot").classList.remove("on");
    document.getElementById("status").textContent = "Local board not running";
    document.getElementById("hint").textContent = "Start it with: python app.py serve";
  }
}
tick(); setInterval(tick, 1500);
