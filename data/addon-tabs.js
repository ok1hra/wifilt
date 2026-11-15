"use strict";

// Extra DATA sub-tabs from add-ons (see "Add-ons" in wifilt.ino). The core
// ships /addon-tabs.json as an empty list; an add-on's own copy replaces it in
// the filesystem image and names its pages:
//
//   [{"href": "/x.html", "label": "X", "title": "...", "before": "/mercury.html"}]
//
// Each becomes an <a class="subtab"> in the page's nav.subtabs, in front of the
// tab whose href is `before` (or at the end), marked active on its own page.
(function () {
  function addTabs(list) {
    const nav = document.querySelector("nav.subtabs");
    if (!nav || !Array.isArray(list)) return;
    for (const tab of list) {
      if (!tab || typeof tab.href !== "string" || typeof tab.label !== "string") continue;
      if (nav.querySelector(`a.subtab[href="${CSS.escape(tab.href)}"]`)) continue;
      const link = document.createElement("a");
      link.className = "subtab";
      link.href = tab.href;
      link.textContent = tab.label;
      if (typeof tab.title === "string") link.title = tab.title;
      if (location.pathname === tab.href) {
        link.classList.add("subtab-active");
        link.setAttribute("aria-current", "page");
      }
      const before = typeof tab.before === "string"
        ? nav.querySelector(`a.subtab[href="${CSS.escape(tab.before)}"]`) : null;
      nav.insertBefore(link, before);
    }
  }

  fetch("/addon-tabs.json", {cache: "no-cache"})
    .then(response => response.ok ? response.json() : [])
    .then(addTabs)
    .catch(() => {});

  // The TS480 pill at the end of the row (on/off, frequency, mode) when
  // local-trx runs the TS-480 software panel. Like QRPlog's loader at the end
  // of log.js, wifilt only finds local-trx -- the LAN slot's IP, loopback
  // meaning the host this page came from -- and everything else is served by
  // local-trx (/ts480/datamenu.js). No local-trx: config.js fails to load and
  // nothing appears. Deferred, so lan-gate.js has already run.
  function loadLocalTrxTs480() {
    if (!document.querySelector("nav.subtabs") || !window.LanGate || !LanGate.read) return;
    const known = LanGate.result && LanGate.result();
    (known ? Promise.resolve(known) : LanGate.read(document)).then(r => {
      if (!r || !r.localTrx || !r.slot) return;
      const cfg = (LanGate.config && LanGate.config()) || {};
      let ip = String(cfg["trx" + r.slot + "lanip"] || (r.slot === 1 ? cfg.lanip : "") || "").trim();
      if (!ip || ip === "0.0.0.0") return;
      if (/^(127\.|localhost$)/i.test(ip)) ip = location.hostname;
      const base = "http://" + ip + ":8765/ts480/";
      const add = (src, onload) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = onload || null;
        document.head.appendChild(s);
      };
      add(base + "config.js", () => {
        const c = window.LTX_TS480;
        if (c && c.enabled) add(base + "datamenu.js?v=" + encodeURIComponent(c.rev || 0));
      });
    }).catch(() => {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadLocalTrxTs480);
  else loadLocalTrxTs480();
})();
