// Why there is no audio -- said in one sentence, with what to do about it.
//
// The audio channel is its own listener (the box's port 83), separate from the
// page's own port. On a PC it can fail to open while the page loads perfectly
// (no permission for low ports, or the port is taken), and a firewall can let the
// page through and drop the audio. Every page used to say only "no audio" or
// "Audio link unavailable" and leave the operator to find the log.
//
// Two facts decide it:
//   1. /health.json -- did the firmware's audio listener bind, and where;
//   2. a WebSocket to /audiows/probe from THIS browser -- the server answers it
//      with a handshake and an immediate close, never touching the one real
//      audio client, so probing cannot cut a running stream.
//
// Used by SETUP's Audio step (check + explain) and by every page that streams
// audio: js8-aud1.js reports a socket that keeps failing to open, and a banner
// appears with the cause and a link to SETUP. Like lan-gate.js it carries its
// own markup and CSS.

(function (root) {
  "use strict";

  var PROBE_TIMEOUT_MS = 4000;

  function audioPort() {
    var ports = root.WIFILT_PORTS || {};
    return Number(ports.audio) || 83;
  }

  function probe(port) {
    return new Promise(function (resolve) {
      if (typeof root.WebSocket !== "function") { resolve(null); return; }
      var settled = false, socket;
      function done(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch (e) {}
        resolve(value);
      }
      var timer = setTimeout(function () { done(false); }, PROBE_TIMEOUT_MS);
      try {
        var scheme = root.location.protocol === "https:" ? "wss" : "ws";
        socket = new root.WebSocket(scheme + "://" + root.location.hostname + ":" + port + "/audiows/probe");
      } catch (e) { done(false); return; }
      socket.onopen = function () { done(true); };
      socket.onerror = function () { done(false); };
      socket.onclose = function () { done(false); };
    });
  }

  function fetchHealth() {
    var options = {cache: "no-store"};
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) options.signal = AbortSignal.timeout(6000);
    return fetch("/health.json", options)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function listenerOf(health, name) {
    var list = health && health.listeners;
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name === name) return list[i];
    return null;
  }

  // health: /health.json (null = this firmware has none, or it did not answer);
  // reached: probe result (true / false / null = not tried).
  // Returns {state: "ok"|"down"|"unreachable"|"unknown", what, fix, port}.
  function explain(health, reached) {
    var audio = listenerOf(health, "audio");
    var web = listenerOf(health, "web");
    var platform = (health && health.platform) || "esp32";
    var pc = platform !== "esp32";
    if (!audio) {
      // An older firmware, or the device did not answer. The probe alone still
      // says something, but not why.
      if (reached === false) return {state: "unknown", port: audioPort(),
        what: "This browser cannot open the audio channel (port " + audioPort() + ").",
        fix: "Check that WIFILT is running and that nothing between this device and it blocks the port."};
      return {state: reached ? "ok" : "unknown", port: audioPort(), what: "", fix: ""};
    }
    var port = Number(audio.actual) || Number(audio.port) || 83;
    if (!audio.ok) {
      // `actual` is the port that was tried: 83, or what --audio-port asked for.
      var tried = Number(audio.actual) || Number(audio.port) || 83;
      return {state: "down", port: tried,
        what: "The audio server is not running: port " + tried + " could not be opened"
          + (audio.error ? " (" + audio.error + ")" : "") + ".",
        fix: platform === "windows"
          ? "Another program holds that port. Start WIFILT with --audio-port 9083 (any free port)."
          : "Start WIFILT with --audio-port 9083 (any free port), or give it the right to use "
            + "low ports: sudo setcap cap_net_bind_service=+ep <path to wifilt> — then restart WIFILT."};
    }
    if (reached === false) {
      var webPort = web ? (Number(web.actual) || 80) : 80;
      return {state: "unreachable", port: port,
        what: "The audio server runs on port " + port + ", but this browser cannot reach it.",
        fix: pc
          ? "A firewall on the WIFILT computer is probably letting the web page (port " + webPort
            + ") through but not port " + port + ". Allow TCP " + port
            + (platform === "linux" ? " — with ufw: sudo ufw allow " + port + "/tcp." : ".")
          : "Something between this device and WIFILT blocks port " + port
            + " — a guest network, or client isolation on the router."};
    }
    return {state: reached ? "ok" : "unknown", port: port, what: "", fix: ""};
  }

  function check() {
    return fetchHealth().then(function (health) {
      var listener = listenerOf(health, "audio");
      // Nothing to probe when the server already said it is not listening.
      if (listener && !listener.ok) return {health: health, reached: null};
      var port = listener ? (Number(listener.actual) || audioPort()) : audioPort();
      return probe(port).then(function (reached) { return {health: health, reached: reached}; });
    }).then(function (result) {
      result.verdict = explain(result.health, result.reached);
      return result;
    });
  }

  // ---- the banner, for pages that stream audio -----------------------------

  var CSS = ""
    + ".audio-health-banner{position:relative;z-index:50;margin:0;padding:9px 40px 9px 12px;"
    + "background:#3a1d00;color:#ffcf8a;border-bottom:2px solid #c96a00;font:13px/1.45 system-ui,sans-serif}"
    + ".audio-health-banner b{color:#ffe3b8}"
    + ".audio-health-banner code{user-select:all;color:#ffe3b8}"
    + ".audio-health-banner a{color:inherit;font-weight:700;margin-left:6px}"
    + ".audio-health-banner button{position:absolute;right:8px;top:6px;background:none;border:0;"
    + "color:inherit;font-size:18px;cursor:pointer}";

  var banner = null, checking = false, failures = 0, reachableSince = 0;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[c];
    });
  }

  function withCommands(text) {
    // Commands are what the operator copies, so they are set apart.
    return escapeHtml(text)
      .replace(/(sudo [^—.]+?)(?= —|\.$|$)/g, "<code>$1</code>")
      .replace(/(--audio-port \d+)/g, "<code>$1</code>");
  }

  function showBanner(verdict) {
    var doc = root.document;
    if (!doc || !doc.body) return;
    if (!doc.getElementById("audio-health-style")) {
      var style = doc.createElement("style");
      style.id = "audio-health-style";
      style.textContent = CSS;
      doc.head.appendChild(style);
    }
    if (!banner) {
      banner = doc.createElement("div");
      banner.className = "audio-health-banner";
      banner.setAttribute("role", "alert");
      doc.body.insertBefore(banner, doc.body.firstChild);
    }
    banner.hidden = false;
    banner.innerHTML = "<b>" + escapeHtml(verdict.what) + "</b> " + withCommands(verdict.fix)
      + "<a href=\"/setup#audio\">SETUP · AUDIO ↗</a>";
    var close = doc.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Hide for now";
    // For this page view only: the state is derived, and it comes back on the
    // next failure while it is still true.
    close.addEventListener("click", function () { banner.hidden = true; });
    banner.appendChild(close);
  }

  function hideBanner() { if (banner) banner.hidden = true; }

  // Called by the audio transport. One failed attempt is ordinary -- a page
  // reload, a radio restart -- so the check runs only after a few in a row.
  function unreachable() {
    failures++;
    if (failures < 3) return;
    diagnose();
  }

  // Check now and show the banner only when the audio server is the problem.
  // Safe to call on any failure: a fault elsewhere comes back "ok" and shows
  // nothing. For a page whose transport runs in a worker (Mercury).
  function diagnose() {
    if (checking) return;
    checking = true;
    check().then(function (result) {
      checking = false;
      // Opened in the meantime: whatever it was, it is over.
      if (reachableSince && failures === 0) return;
      var verdict = result.verdict;
      if (verdict.state === "down" || verdict.state === "unreachable" || verdict.state === "unknown") {
        if (verdict.what) showBanner(verdict);
      }
    }, function () { checking = false; });
  }

  function reachable() {
    failures = 0;
    reachableSince = Date.now();
    hideBanner();
  }

  var api = {check: check, explain: explain, probe: probe, unreachable: unreachable,
             reachable: reachable, diagnose: diagnose, audioPort: audioPort};
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WifiltAudioHealth = api;
})(typeof window !== "undefined" ? window : globalThis);
