// "Enable radio TX" -- a refusal you can see, with the way to the switch.
//
// The pledge is the one TX gate an operator meets on day one, and it used to be
// the quietest: the button went disabled and the reason sat in its `title`,
// which a tablet never shows and a disabled button cannot even be clicked to
// reveal. Operators reported hunting for it.
//
// So when the pledge is the ONLY thing standing in the way, the button stays
// clickable (dimmed). The click transmits nothing: a capture-phase listener on
// the document takes it before the button's own handler ever runs, and shows a
// toast saying why, with GO TO SETTING -- which opens the switch on THIS page
// (the page passes its own reveal), so a running JS8 modem is never left
// behind. Any other reason (radio offline, link not ready...) keeps the button
// disabled exactly as before: enabling TX would not make it work.
//
// Same reason string on every page: "confirm Enable radio TX".

(function (root) {
  "use strict";

  var PLEDGE = "confirm Enable radio TX";
  var TOAST_MS = 9000;

  var CSS = ""
    + ".tx-pledge-blocked{opacity:.55}"
    + ".tx-pledge-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:1000;"
    + "display:flex;gap:12px;align-items:center;max-width:calc(100% - 32px);padding:10px 12px 10px 14px;"
    + "border:1px solid #c98a00;border-radius:7px;background:#2b2000;color:#ffd27a;"
    + "font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45)}"
    + ".tx-pledge-toast[hidden]{display:none}"
    + ".tx-pledge-toast button{flex:none;padding:6px 10px;border:1px solid #e0a020;border-radius:5px;"
    + "background:#e0a020;color:#1a1300;font:700 12px system-ui,sans-serif;letter-spacing:.04em;cursor:pointer}";

  var reveal = null, toast = null, hideTimer = null, installed = false;

  function list(reasons) {
    if (!reasons) return [];
    return Array.isArray(reasons) ? reasons.filter(Boolean) : [String(reasons)];
  }

  function onlyPledge(reasons) {
    var items = list(reasons);
    return items.length === 1 && items[0] === PLEDGE;
  }

  // Sets the button from the reasons it is blocked by. Returns true when it is
  // blocked at all (pledge included), so a caller can still branch on it.
  function gate(button, reasons) {
    if (!button) return false;
    var items = list(reasons);
    var pledge = items.length === 1 && items[0] === PLEDGE;
    button.disabled = items.length > 0 && !pledge;
    if (pledge) button.setAttribute("data-pledge-blocked", "");
    else button.removeAttribute("data-pledge-blocked");
    button.classList.toggle("tx-pledge-blocked", pledge);
    return items.length > 0;
  }

  function injectStyle(doc) {
    if (doc.getElementById("tx-pledge-style")) return;
    var style = doc.createElement("style");
    style.id = "tx-pledge-style";
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function show() {
    var doc = root.document;
    if (!doc || !doc.body) return;
    injectStyle(doc);
    if (!toast) {
      toast = doc.createElement("div");
      toast.className = "tx-pledge-toast";
      toast.setAttribute("role", "alert");
      var text = doc.createElement("span");
      text.textContent = "Nothing was sent: radio TX is not enabled in SETTINGS.";
      var go = doc.createElement("button");
      go.type = "button";
      go.textContent = "GO TO SETTING";
      go.addEventListener("click", function () {
        hide();
        if (reveal) reveal();
      });
      toast.appendChild(text);
      toast.appendChild(go);
      doc.body.appendChild(toast);
    }
    toast.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, TOAST_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    if (toast) toast.hidden = true;
  }

  // revealFn: opens this page's own Enable radio TX switch.
  function install(revealFn) {
    reveal = revealFn || reveal;
    if (installed || !root.document) return;
    installed = true;
    injectStyle(root.document);
    root.document.addEventListener("click", function (event) {
      var target = event.target;
      var button = target && target.closest ? target.closest("[data-pledge-blocked]") : null;
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      show();
    }, true);
  }

  var api = {PLEDGE: PLEDGE, gate: gate, onlyPledge: onlyPledge, install: install,
             show: show, hide: hide};
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TxPledge = api;
})(typeof window !== "undefined" ? window : globalThis);
