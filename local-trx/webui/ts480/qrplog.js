// SPDX-License-Identifier: GPL-3.0-or-later
// TS-480 palette for QRPlog. Served by local-trx, runs inside wifilt's QRPlog
// page: wifilt's log.js only finds local-trx (LanGate: the LOCAL-TRX slot's
// IP) and loads /ts480/config.js + this file -- so none of the panel's code
// takes room in an ESP32's flash.
//
// What it adds to QRPlog:
//   * a TS480 button on the bottom bar (only while local-trx answers and its
//     panel cable is open),
//   * a palette with nothing but the radio's display: drag it by the header,
//     resize it with the corner (the display scales), header = TS-480, ⏻, AF,
//     PTT, and expand at the right end,
//   * expand: closes the palette and opens the full panel (panel.html) in its
//     own window; that window's collapse closes it and brings the palette back
//     (postMessage -- the two pages are on different origins).
(function () {
  "use strict";
  if (window.__ltx480Palette) return;
  window.__ltx480Palette = true;

  const CFG = window.LTX_TS480 || {};
  if (!CFG.enabled) return;

  const script = document.currentScript;
  const base = new URL(".", script ? script.src : location.href);   // http://host:8765/ts480/
  const ORIGIN = base.origin;
  const REV = encodeURIComponent(CFG.rev || 0);
  const STORE_KEY = "wifilt-ts480-panel";
  const DEFAULT_W = 320, MIN_W = 200;

  function loadScript(name) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = new URL(name + "?v=" + REV, base).href;
      s.onload = resolve;
      s.onerror = () => reject(new Error(name));
      document.head.appendChild(s);
    });
  }

  // ---- stored geometry (wrapped: a private window refuses localStorage) ----
  let state = { open: false, x: null, gap: null, width: DEFAULT_W, popped: false, af: false };
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (v && typeof v === "object") state = Object.assign(state, v);
  } catch (_) {}
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  function injectCss() {
    const style = document.createElement("style");
    style.textContent = `
.ltx480-pal{position:fixed;z-index:91;width:${DEFAULT_W}px;min-width:${MIN_W}px;display:flex;flex-direction:column;
  overflow:hidden;resize:horizontal;background:#0e1b19;border:1px solid #28443e;border-radius:7px;
  box-shadow:0 10px 30px rgba(0,0,0,.55);color:#e8f3ee;user-select:none}
.ltx480-pal[hidden]{display:none}
.ltx480-pal-head{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 8px;border-bottom:1px solid #28443e;
  cursor:move;font:700 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.08em;color:#8ba59d;flex:none;min-width:0}
.ltx480-pal-title{color:#e8f3ee;flex:none}
.ltx480-pal-body{background:#060708;padding:3px;line-height:0}
.ltx480-pal-body svg{display:block;width:100%;height:auto}
#btnTs480.ts480-on{border-color:#2f7d3d}`;
    document.head.appendChild(style);
  }

  let client = null, lcd = null, pal = null, btn = null, popup = null;
  let placed = null;

  function clampPos(x, y) {
    const w = pal.offsetWidth, h = pal.offsetHeight;
    return {
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
    };
  }

  // Hangs from the bottom of the window like the RTTY palette: `gap` is the
  // distance from the window's bottom edge, so it keeps its place above the
  // log's entry fields when the window is resized.
  function place() {
    if (!pal || pal.hidden) return;
    const h = pal.offsetHeight;
    if (state.x === null || state.gap === null) {
      const r = btn ? btn.getBoundingClientRect() : null;
      const p = r ? clampPos(r.right - pal.offsetWidth, r.top - h - 8) : { x: 20, y: 20 };
      state.x = p.x;
      state.gap = window.innerHeight - (p.y + h);
    }
    const p = clampPos(state.x, window.innerHeight - h - state.gap);
    pal.style.left = p.x + "px";
    pal.style.top = p.y + "px";
    placed = { y: p.y, h };
  }

  function mountDrag(handle) {
    let dragging = false, dx = 0, dy = 0;
    handle.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      dragging = true;
      dx = e.clientX - pal.offsetLeft;
      dy = e.clientY - pal.offsetTop;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handle.addEventListener("pointermove", e => {
      if (!dragging) return;
      const p = clampPos(e.clientX - dx, e.clientY - dy);
      pal.style.left = p.x + "px";
      pal.style.top = p.y + "px";
    });
    const end = e => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      state.x = pal.offsetLeft;
      state.gap = window.innerHeight - (pal.offsetTop + pal.offsetHeight);
      placed = { y: pal.offsetTop, h: pal.offsetHeight };
      save();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function build() {
    injectCss();
    pal = document.createElement("div");
    pal.className = "ltx480-pal";
    pal.id = "ts480Panel";
    pal.hidden = true;
    pal.style.width = Math.max(MIN_W, Math.min(state.width || DEFAULT_W, window.innerWidth - 20)) + "px";
    const head = document.createElement("div");
    head.className = "ltx480-pal-head";
    const title = document.createElement("span");
    title.className = "ltx480-pal-title";
    title.textContent = "TS-480";
    head.appendChild(title);
    head.appendChild(client.headerControls({ end: { icon: "expand", title: "Open the full panel in its own window", onClick: expand } }));
    const body = document.createElement("div");
    body.className = "ltx480-pal-body";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", Ts480Lcd.LCD_VIEWBOX);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    body.appendChild(svg);
    pal.appendChild(head);
    pal.appendChild(body);
    // Keep QRPlog's caret in Call: nothing in the palette takes focus.
    pal.addEventListener("mousedown", e => { if (!e.target.closest("input")) e.preventDefault(); });
    document.body.appendChild(pal);
    mountDrag(head);

    // The corner handle changes the width; the display (and so the height)
    // follows. Keep the bottom edge where the operator put it.
    new ResizeObserver(() => {
      if (pal.hidden) return;
      const h = pal.offsetHeight, w = pal.offsetWidth;
      if (placed && placed.h !== h) {
        pal.style.top = Math.max(0, window.innerHeight - h - state.gap) + "px";
        placed = { y: pal.offsetTop, h };
      }
      if (w && w !== state.width) { state.width = w; save(); }
    }).observe(pal);
    window.addEventListener("resize", place);
  }

  function setOpen(open) {
    state.open = !!open;
    pal.hidden = !open;
    if (open) {
      // The LCD lays text out by its rendered width: mount it once visible.
      if (!lcd) {
        lcd = Ts480Lcd.mount(pal.querySelector(".ltx480-pal-body svg"));
        lcd.render(client.last);
      }
      place();
      if (state.af && !client.af) client.wantAf();
    } else if (client.af) {
      client.setAf(false);
    }
    save();
  }

  function expand() {
    const af = client.af || client.afWanted;
    state.af = af;
    setOpen(false);
    state.popped = true;
    save();
    const url = new URL("panel.html", base);
    if (af) url.searchParams.set("af", "1");
    popup = window.open(url.href, "TS480", "width=1100,height=600,menubar=no,location=no,status=no");
    if (!popup) {   // pop-up blocked: stay in the palette
      state.popped = false;
      setOpen(true);
      client.setMessage("the browser blocked the pop-up window", true);
    }
  }

  window.addEventListener("message", e => {
    if (e.origin !== ORIGIN || !e.data || e.data.src !== "ltx-ts480") return;
    if (e.data.op === "collapse") {
      state.popped = false;
      state.af = !!e.data.af;
      popup = null;
      setOpen(true);
    } else if (e.data.op === "closed") {
      state.popped = false;
      popup = null;
      save();
    }
  });

  function buildButton() {
    btn = document.createElement("button");
    btn.id = "btnTs480";
    btn.type = "button";
    btn.className = "btn-trx";
    btn.textContent = "TS480";
    btn.title = "TS-480 display (local-trx software panel)";
    btn.hidden = true;
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      if (state.popped && popup && !popup.closed) { popup.focus(); return; }
      state.popped = false;
      setOpen(pal.hidden);
    });
    const pa = document.getElementById("btnPa");
    const groups = document.querySelectorAll(".log-btn-group");
    if (pa && pa.parentNode) pa.parentNode.insertBefore(btn, pa);
    else if (groups.length) groups[groups.length - 1].appendChild(btn);
    else document.body.appendChild(btn);
  }

  function updateButton() {
    const show = client.serverUp && !!(client.last && client.last.portOpen);
    btn.hidden = !show;
    btn.classList.toggle("ts480-on", client.powerOn);
    if (!show && !pal.hidden) pal.hidden = true;               // keep state.open for when it comes back
    else if (show && state.open && pal.hidden && !state.popped) setOpen(true);
  }

  Promise.all([loadScript("lcd.js"), loadScript("audio.js")])
    .then(() => loadScript("client.js"))
    .then(() => {
      const host = base.hostname;
      client = new Ts480Client(`ws://${host}:${CFG.wsPort}/ts480`);
      buildButton();
      build();
      client.on("state", m => { if (lcd && !pal.hidden) lcd.render(m); });
      client.on("refresh", updateButton);
      client.connect();
      updateButton();
    })
    .catch(e => console.warn("TS-480 palette: cannot load " + e.message + " from local-trx"));
})();
