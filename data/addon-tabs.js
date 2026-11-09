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
})();
