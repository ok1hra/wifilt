// JTTY receive log: decoded messages as lines, the way WSJT-X shows them --
// UTC, SNR, audio frequency, text -- one line per message that grows in place
// while its frames arrive. Shared by jtty.html (two views: Band activity and
// RX frequency) and QRPlog's JTTY palette (RX frequency only).
//
// Words are `.jtty-tok` spans; the caller decides what a click does with one
// (jtty.html hands it to QRPlog over 'wifilt-dxc-action', the palette puts it
// in Call/Exch). Own transmissions appear in the RX-frequency view as TX
// lines that grow segment by segment during live entry.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JttyRxLog = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const MAX_MESSAGES = 400;
  const RX_WINDOW_HZ = 70;

  // Messages by id, newest last. apply() takes JttyModem.Receiver updates.
  function createStore() {
    const byId = new Map();
    function apply(updates, wallMs) {
      const changed = [];
      for (const u of updates || []) {
        const old = byId.get(u.id);
        const m = Object.assign(old || {firstSeenMs: wallMs || Date.now()}, u);
        if (!old) byId.set(u.id, m);
        changed.push(m);
      }
      while (byId.size > MAX_MESSAGES) byId.delete(byId.keys().next().value);
      return changed;
    }
    return {apply, all: () => Array.from(byId.values()), get: id => byId.get(id), clear: () => byId.clear()};
  }

  const pad2 = n => String(n).padStart(2, "0");
  function utc(ms) {
    const d = new Date(ms);
    return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
  }

  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c]));

  function tokens(text, myCall) {
    return String(text).split(/(\s+)/).map(part => {
      if (!part || /^\s+$/.test(part) || part === "...") return escapeHtml(part);
      const me = myCall && part === myCall ? " jtty-me" : "";
      return `<span class="jtty-tok${me}">${escapeHtml(part)}</span>`;
    }).join("");
  }

  // options: el, filter(message) -> bool, myCall(), rxHz(), onToken(word,
  // event), onLine(message, event), maxLines
  function createView(options) {
    const el = options.el;
    const maxLines = options.maxLines || 200;
    const lines = new Map();      // id -> element
    const myCallOf = options.myCall || (() => "");
    let placeholder = null;

    function showPlaceholder(text) {
      if (lines.size || placeholder) return;
      placeholder = document.createElement("div");
      placeholder.className = "jtty-rx-empty muted";
      placeholder.textContent = text || "Waiting for signal…";
      el.appendChild(placeholder);
    }
    function dropPlaceholder() {
      if (placeholder) { placeholder.remove(); placeholder = null; }
    }

    function lineHtml(m) {
      const cls = [];
      if (/^CQ\b/.test(m.text)) cls.push("jtty-cq");
      const myCall = myCallOf();
      if (myCall && new RegExp("(^|\\s)" + myCall.replace(/[^A-Z0-9/]/g, "") + "(\\s|$)").test(m.text)) cls.push("jtty-to-me");
      if (!m.complete) cls.push(m.status === "expired" ? "jtty-expired" : "jtty-growing");
      const snr = (m.snr >= 0 ? "+" : "") + m.snr;
      return {cls, html:
        `<span class="jtty-col jtty-t">${utc(m.firstSeenMs)}</span>` +
        `<span class="jtty-col jtty-snr">${escapeHtml(snr)}</span>` +
        `<span class="jtty-col jtty-hz">${Math.round(m.audioHz)}</span>` +
        `<span class="jtty-text">${tokens(m.text, myCall)}${m.complete ? "" : m.status === "expired" ? " <i>…</i>" : ""}</span>`};
    }

    function upsert(m) {
      if (options.filter && !options.filter(m)) {
        const gone = lines.get(m.id);
        if (gone) { gone.remove(); lines.delete(m.id); }
        return;
      }
      dropPlaceholder();
      let line = lines.get(m.id);
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      if (!line) {
        line = document.createElement("div");
        line.dataset.id = String(m.id);
        el.appendChild(line);
        lines.set(m.id, line);
        while (lines.size > maxLines) {
          const [id, first] = lines.entries().next().value;
          first.remove();
          lines.delete(id);
        }
      }
      const {cls, html} = lineHtml(m);
      line.className = ["jtty-line"].concat(cls).join(" ");
      line.innerHTML = html;
      if (atBottom) el.scrollTop = el.scrollHeight;
    }

    // An own transmission: a handle whose append() adds each live segment.
    function echoTx(text) {
      dropPlaceholder();
      const line = document.createElement("div");
      line.className = "jtty-line jtty-tx";
      const span = document.createElement("span");
      span.className = "jtty-text";
      line.innerHTML = `<span class="jtty-col jtty-t">${utc(Date.now())}</span><span class="jtty-col jtty-snr">TX</span><span class="jtty-col jtty-hz">${Math.round(options.txHz ? options.txHz() : 0)}</span>`;
      line.appendChild(span);
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
      const handle = {line, text: ""};
      handle.append = more => {
        if (!more) return;
        handle.text = (handle.text ? handle.text + " " : "") + more;
        span.textContent = handle.text;
        el.scrollTop = el.scrollHeight;
      };
      handle.append(text);
      return handle;
    }
    const markEchoFailed = handle => { if (handle && handle.line) handle.line.classList.add("jtty-tx-failed"); };

    function clear() {
      el.innerHTML = "";
      lines.clear();
      placeholder = null;
      showPlaceholder();
    }

    el.addEventListener("click", event => {
      const tok = event.target.closest(".jtty-tok");
      if (tok && options.onToken) { options.onToken(tok.textContent, event); return; }
      const line = event.target.closest(".jtty-line");
      if (line && options.onLine && line.dataset.id) options.onLine(Number(line.dataset.id), event);
    });
    if (options.onLineDouble) el.addEventListener("dblclick", event => {
      const line = event.target.closest(".jtty-line");
      if (line && line.dataset.id) options.onLineDouble(Number(line.dataset.id), event);
    });

    showPlaceholder(options.placeholder);
    return {upsert, render: list => list.forEach(upsert), echoTx, markEchoFailed, clear,
      refilter: all => { el.innerHTML = ""; lines.clear(); placeholder = null; all.forEach(upsert); showPlaceholder(options.placeholder); }};
  }

  // The RX-frequency view's filter: near the RX offset, or anything with my call.
  function nearRx(rxHz, myCall) {
    return m => Math.abs(m.audioHz - rxHz()) <= RX_WINDOW_HZ ||
      Boolean(myCall() && (" " + m.text + " ").indexOf(" " + myCall() + " ") >= 0);
  }

  return {createStore, createView, nearRx, utc, RX_WINDOW_HZ};
}));
