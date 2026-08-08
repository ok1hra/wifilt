// The ICOM-LAN precondition, shared by the two DATA sub-pages (JS8Call-ICOM and
// WSPR).
//
// Both need the same thing from the radio -- Icom network control plus
// bidirectional network audio -- and both used to decide it for themselves. They
// drifted: the JS8 page read the saved configuration and looked for whichever TRX slot
// carries the LAN transport, WSPR compared the primary radio's reported type, so
// with LAN on TRX2 or TRX3 the two pages disagreed about whether the feature was
// available at all. One module, one rule, one explanation.
//
// Like wake-lock.js this carries its own markup and CSS, so putting the gate on
// a page is one script tag plus one call. The card class is deliberately generic
// (.gate-card): the session-busy panels on both pages reuse it, which keeps the
// two lock-out screens looking like siblings rather than accidents.
(function (root) {
  "use strict";

  const GATE_CSS = ""
    + ".gate-card{max-width:760px;margin:clamp(28px,8vh,90px) auto 24px;"
    + "padding:clamp(20px,4vw,36px);display:grid;grid-template-columns:44px minmax(0,1fr);"
    + "gap:18px;border:1px solid #8a572b;border-radius:8px;background:#21170d;"
    + "box-shadow:0 16px 48px #0007}"
    + ".gate-card[hidden]{display:none}"
    + ".gate-card-icon{width:42px;height:42px;display:grid;place-items:center;"
    + "border:2px solid #e0a020;border-radius:50%;color:#e0a020;"
    + "font:900 24px/1 ui-monospace,monospace}"
    + ".gate-card h1{margin:0 0 9px;color:#fff;font-size:clamp(20px,4vw,28px)}"
    + ".gate-card p{margin:8px 0;color:#d9c6ad;line-height:1.55}"
    + ".gate-card ol{margin:15px 0;padding-left:24px;color:#f1e3d2}"
    + ".gate-card li{margin:8px 0;padding-left:3px}"
    + ".gate-card li::marker{color:#e0a020;font-weight:900}"
    + ".gate-card-note{color:#7e918b!important;font-size:12px}"
    + ".gate-card-action{display:inline-block;margin-top:8px;padding:9px 13px;"
    + "border:1px solid #e0a020;border-radius:4px;background:#352311;color:#ffd49a;"
    + "font-weight:850;text-decoration:none}"
    + ".gate-card-action:hover,.gate-card-action:focus-visible{background:#4a3016;color:#fff}"
    + "button.gate-card-action{cursor:pointer;font:inherit;font-weight:850}"
    + ".gate-card small{display:block;min-height:1em;margin-top:10px;color:#e5484d}"
    + ".session-busy-where{color:#f1e3d2!important;font-weight:800}"
    + ".session-busy small{color:#7e918b!important}"
    // Both states blank the page rather than leaving it half-rendered: a modem
    // or beacon screen that cannot key the radio is worse than an explanation.
    // Only the topbar survives, so the sub-nav still switches pages -- which is
    // why it lives up there and not inside <main>.
    + "body.lan-gate-checking>:not(.site-topbar),"
    + "body.lan-gate-blocked>:not(.site-topbar){display:none}"
    + "body.lan-gate-blocked>main{display:block}"
    + "body.lan-gate-blocked>main>:not(.gate-card){display:none}"
    + "@media (max-width:700px){.gate-card{grid-template-columns:1fr;margin-top:18px;"
    + "padding:19px 16px}.gate-card-icon{width:36px;height:36px;font-size:20px}}";

  // Written as one string rather than a DOM build so the whole operator-facing
  // text sits in one readable block. Nothing here is interpolated.
  const CARD_HTML = ""
    + '<div class="gate-card-icon" aria-hidden="true">!</div>'
    + "<div>"
    + "<h1>DATA requires a TRX over ICOM-LAN</h1>"
    // Not "WLAN": only the IC-705 is wireless and calls it that. Every other
    // supported radio is Ethernet and calls it LAN, and this card is the first
    // thing their operators see.
    + "<p>This function uses Icom network control and bidirectional network audio. "
    + "TRXNET and CI-V carry commands only, so there is no way to get audio in or "
    + "out through them.</p>"
    + "<ol>"
    + "<li>Put the radio on the same network as this interface &mdash; by cable on the "
    + "Ethernet models, over WLAN on the IC-705 &mdash; and enable "
    + "<strong>Network Control</strong> in its remote/network settings.</li>"
    + "<li>Open <strong>SETUP &rarr; Radio</strong> and select "
    + "<strong>Connection: ICOM-LAN</strong> on one of TRX1-TRX3.</li>"
    + "<li>Enter the radio IP address, network username and network password, "
    + "then save the setup.</li>"
    + "</ol>"
    // Filled in by show(): the card appears precisely when no radio is connected,
    // so it must not name one. If a model was remembered from an earlier login it
    // is named; otherwise this says nothing about which radio you have.
    + '<p class="gate-card-note" id="lanGateRadio"></p>' 
    + '<a class="gate-card-action" href="/setup#radioSection">OPEN ICOM-LAN SETUP</a>'
    + '<small id="lanGateDetail"></small>'
    + "</div>";

  let result = null, config = null;

  function injectStyle(doc) {
    if (doc.getElementById("lanGateStyle")) return;
    const style = doc.createElement("style");
    style.id = "lanGateStyle";
    style.textContent = GATE_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  // The saved configuration, not the live radio: the question is whether the
  // operator has set the link up at all, which must be answerable before
  // anything tries to connect.
  async function read(doc) {
    const query = new URLSearchParams({scope: "js8call"});
    // Smoke harnesses serve their own /setup-data.json and pick a scenario with
    // this; the firmware has no such argument. Gated on ?test so a stray
    // parameter cannot steer a real radio's page.
    const params = new URLSearchParams(root.location.search);
    if (params.has("test") && params.get("lanFixture"))
      query.set("fixture", params.get("lanFixture"));
    let ready = false, detail = "", slot = 0;
    try {
      const response = await root.fetch(`/setup-data.json?${query}`, {cache: "no-store"});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      config = await response.json();
      // LAN is exclusive to a single radio slot but the operator picks which one,
      // so find it rather than assuming TRX1. Slot 1 also answers under the
      // legacy unprefixed lan* keys.
      slot = [1, 2, 3].find(index => config[`trx${index}transport`] === "lan") || 0;
      const at = key => String((slot ? config[`trx${slot}${key}`] : "")
                              || (slot === 1 ? config[key] : "") || "").trim();
      const ip = at("lanip"), user = at("lanuser"), password = at("lanpass");
      const missing = [];
      if (!slot) missing.push("no TRX connection is set to ICOM-LAN");
      else {
        if (!ip || ip === "0.0.0.0") missing.push("radio IP address is missing");
        if (!user) missing.push("network username is missing");
        if (!password) missing.push("network password is missing");
      }
      ready = missing.length === 0;
      detail = missing.join(" · ");
    } catch (error) {
      detail = `Unable to read the radio configuration: ${error.message}`;
    }
    result = {ready, detail, slot};
    return result;
  }

  function show(doc, detail) {
    const host = doc.querySelector("main");
    if (!host) return;
    const card = doc.createElement("section");
    card.id = "lanGate";
    card.className = "gate-card";
    card.setAttribute("role", "alert");
    card.innerHTML = CARD_HTML;
    host.insertBefore(card, host.firstChild);
    const line = doc.getElementById("lanGateDetail");
    if (line) line.textContent = detail;

    // radioSlots[].model survives a reboot, so even with the link down the
    // interface usually knows what it last spoke to. Name that, or name nothing --
    // never a model the operator may not own.
    const note = doc.getElementById("lanGateRadio");
    if (note) {
      const slot = result && result.slot;
      const remembered = slot && config
        ? String(config[`trx${slot}model`] || "").trim() : "";
      note.textContent = remembered
        ? `TRX${slot} last identified itself as ${remembered}. Any Icom transceiver with `
          + "network remote control and network audio can be used here; the IC-705 is the "
          + "model this interface has been verified against."
        : "Any Icom transceiver with network remote control and network audio can be used "
          + "here. The IC-705 is the model this interface has been verified against; press "
          + "Test & identify radio in SETUP to record which one you have.";
    }
  }

  // Resolves false when the page must not start. Callers return on false rather
  // than rendering a degraded version of themselves.
  async function gate(doc) {
    doc = doc || root.document;
    injectStyle(doc);
    const outcome = await read(doc);
    doc.body.classList.remove("lan-gate-checking");
    doc.body.classList.toggle("lan-gate-blocked", !outcome.ready);
    if (!outcome.ready) show(doc, outcome.detail);
    return outcome.ready;
  }

  const LanGate = {
    gate,
    result: () => result,
    config: () => config,
    slot: () => (result ? result.slot : 0),
  };

  if (typeof module === "object" && module.exports) module.exports = LanGate;
  else root.LanGate = LanGate;
})(typeof globalThis === "object" ? globalThis : this);
