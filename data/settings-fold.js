// Remembers whether a page's ADVANCED settings fold is open -- per browser, per
// page -- and opens SETTINGS when the page is reached as /page#settings. A convenience only: it lives in localStorage, comes back closed when the
// storage is unavailable, and never holds anything that matters. The JS8 page
// keeps its folds in its own settings (ui.disclosures) and does not use this.
(function () {
  "use strict";
  function key(details) {
    return "wifilt.fold." + location.pathname.replace(/[^a-z0-9]+/gi, "_") + "." + details.id;
  }
  function wire() {
    var folds = document.querySelectorAll("details.settings-advanced[id]:not([data-section])");
    Array.prototype.forEach.call(folds, function (details) {
      try { if (localStorage.getItem(key(details)) === "1") details.open = true; } catch (e) {}
      details.addEventListener("toggle", function () {
        try { localStorage.setItem(key(details), details.open ? "1" : "0"); } catch (e) {}
      });
    });
  }
  // /data.html#settings, /wspr.html#settings ...: SETUP's mode-settings links land
  // on the page's own SETTINGS, opened, instead of at the top of a long page.
  function revealFromHash() {
    if (location.hash !== "#settings") return;
    var section = document.querySelector('details[data-section="settings"]');
    if (!section) return;
    section.open = true;
    try { section.scrollIntoView({behavior: "smooth", block: "start"}); }
    catch (e) { section.scrollIntoView(); }
  }
  function start() { wire(); revealFromHash(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
  window.addEventListener("hashchange", revealFromHash);
})();
