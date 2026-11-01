// WATCH from the "radio is driven from somewhere else" card: a second visitor
// can follow the station on /watch.html instead of taking the radio over.
//
// The link sits hidden in each busy card ([data-watch-link]) and is shown only
// when the binary says WATCH is on (/health.json "watch", the PC build only),
// so the box and a PC with WATCH off never offer a page that would refuse
// them. /health.json is read only once a busy card actually shows.

(function () {
  "use strict";

  const RECHECK_MS = 60000;
  let answer = null, answeredMs = 0;

  function watchOn() {
    if (answer && Date.now() - answeredMs < RECHECK_MS) return answer;
    answeredMs = Date.now();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 4000) : null;
    answer = fetch("/health.json", {cache: "no-store", signal: controller ? controller.signal : undefined})
      .then(response => response.ok ? response.json() : null)
      .then(body => Boolean(body && body.watch && body.watch.on))
      .catch(() => false)
      .finally(() => { if (timer) clearTimeout(timer); });
    return answer;
  }

  function update(link) {
    const card = link.closest(".session-busy");
    if (!card || card.hidden) return;
    watchOn().then(on => { link.hidden = !on; });
  }

  for (const link of document.querySelectorAll("[data-watch-link]")) {
    const card = link.closest(".session-busy");
    if (!card) continue;
    new MutationObserver(() => update(link)).observe(card, {attributes: true, attributeFilter: ["hidden"]});
    update(link);
  }
})();
