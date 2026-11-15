// SPDX-License-Identifier: GPL-3.0-or-later
// TS-480 pill for wifilt's DATA pages (JS8Call-ICOM, RTTY-ICOM, JTTY, WSPR,
// Mercury). Served by local-trx and loaded by wifilt's addon-tabs.js, which
// only finds local-trx -- none of this takes room in an ESP32's flash.
//
// At the right end of the DATA sub-tab row: a TS480 pill (only while local-trx
// answers and its panel cable is open). It drops a small palette:
//   * ⏻ -- the radio on/off, through the panel cable (CAT cannot switch a
//     TS-480 on),
//   * a frequency field -- 14074 is kHz, 14.074 MHz (QRPlog's Call rule),
//   * the modes -- LSB USB CW FSK FM AM.
// Frequency and mode go through wifilt's own CAT path, /cmd?radio=lan -- the
// slot local-trx is on, exactly what the DATA pages' own frequency menus use;
// the panel's display shows them back.
(function () {
  "use strict";
  if (window.__ltx480DataMenu) return;
  window.__ltx480DataMenu = true;

  const CFG = window.LTX_TS480 || {};
  if (!CFG.enabled) return;

  const script = document.currentScript;
  const base = new URL(".", script ? script.src : location.href);   // http://host:8765/ts480/
  const REV = encodeURIComponent(CFG.rev || 0);

  // CAT MD codes (the panel's mode_code) -> the mode buttons, and what
  // wifilt's /cmd setMode takes for each.
  const MODES = [
    { label: "LSB", cmd: "LSB",  codes: [1] },
    { label: "USB", cmd: "USB",  codes: [2] },
    { label: "CW",  cmd: "CW",   codes: [3, 7] },
    { label: "FSK", cmd: "RTTY", codes: [6, 9] },
    { label: "FM",  cmd: "FM",   codes: [4] },
    { label: "AM",  cmd: "AM",   codes: [5] },
  ];
  const MIN_HZ = 30000, MAX_HZ = 60000000;   // TS-480: 30 kHz - 60 MHz

  // QRPlog's Call rule: a whole number is kHz, a decimal point (or comma) with
  // less than 1000 in front of it is MHz.
  function parseFreq(text) {
    const s = String(text || "").trim().replace(/\s+/g, "");
    if (!/^\d+(?:[.,]\d*)?$/.test(s)) return 0;
    const value = parseFloat(s.replace(",", "."));
    const mhz = /[.,]/.test(s) && value < 1000;
    const hz = Math.round(value * (mhz ? 1e6 : 1e3));
    return hz >= MIN_HZ && hz <= MAX_HZ ? hz : 0;
  }

  function fmtKHz(hz) {
    const khz = (hz / 1000).toFixed(2).replace(/\.?0+$/, "");
    return khz.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " kHz";
  }

  function loadScript(name) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = new URL(name + "?v=" + REV, base).href;
      s.onload = resolve;
      s.onerror = () => reject(new Error(name));
      document.head.appendChild(s);
    });
  }

  function injectCss() {
    const style = document.createElement("style");
    style.textContent = `
/* The row does not wrap on its own; with the pill in it a phone would scroll sideways. */
.site-topbar .subtabs:has(.ltx480-dm:not([hidden])){flex-wrap:wrap;row-gap:6px}
.ltx480-dm{position:relative;margin-left:auto;display:flex;align-items:center}
.ltx480-dm[hidden]{display:none}
.ltx480-dm-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border:1px solid var(--line,#28443e);
  border-radius:999px;background:transparent;color:var(--muted,#8ba59d);font-family:inherit;font-size:12px;
  font-weight:800;line-height:1.2;letter-spacing:.1em;cursor:pointer}
.ltx480-dm-pill:hover,.ltx480-dm-pill[aria-expanded="true"]{color:var(--text,#e8f3ee);border-color:#2c4f77}
.ltx480-dm-dot{width:7px;height:7px;border-radius:50%;background:#555d66}
.ltx480-dm-pill.on .ltx480-dm-dot{background:#4cd964;box-shadow:0 0 5px #4cd96499}
.ltx480-dm-pill.nolink .ltx480-dm-dot{background:#ff6b6b}
.ltx480-dm-pal{position:absolute;top:calc(100% + 6px);right:0;z-index:300;width:286px;padding:10px;
  background:#0f1620;border:1px solid #2c4f77;border-radius:8px;box-shadow:0 12px 30px rgba(0,0,0,.6);
  color:var(--text,#e8f3ee);font-size:12px;display:flex;flex-direction:column;gap:9px}
.ltx480-dm-pal[hidden]{display:none}
.ltx480-dm-row{display:flex;align-items:center;gap:6px}
.ltx480-dm-pal button{border:1px solid #2a3a4c;border-radius:999px;background:#152131;color:var(--muted,#9aa7b4);
  font:800 11px/1.4 ui-monospace,Consolas,monospace;letter-spacing:.05em;padding:3px 9px;cursor:pointer}
.ltx480-dm-pal button:hover:not(:disabled){color:var(--text,#e8f3ee);border-color:#4a6a8c}
.ltx480-dm-pal button:disabled{opacity:.4;cursor:not-allowed}
.ltx480-dm-pwr{display:inline-flex;align-items:center;gap:5px}
.ltx480-dm-pwr svg{width:13px;height:13px}
.ltx480-dm-pwr.on{color:#4cd964 !important;border-color:#2f7d3d !important;background:#12301b !important}
.ltx480-dm-now{flex:1;text-align:right;font:700 13px/1.2 ui-monospace,Consolas,monospace;color:var(--cyan,#66f2d5);white-space:nowrap}
.ltx480-dm-now small{color:var(--muted,#9aa7b4);font-weight:700;margin-left:6px}
.ltx480-dm-freq{flex:1;min-width:0;padding:5px 8px;border:1px solid #2a3a4c;border-radius:6px;background:#0a1018;
  color:var(--text,#e8f3ee);font:700 13px/1.2 ui-monospace,Consolas,monospace}
.ltx480-dm-freq:focus{outline:none;border-color:#4a6a8c}
.ltx480-dm-modes{flex-wrap:wrap}
.ltx480-dm-modes button.on{color:var(--cyan,#66f2d5);border-color:#2c6f6a;background:#123430}
.ltx480-dm-msg{min-height:14px;color:var(--muted,#9aa7b4);font-size:11px}
.ltx480-dm-msg.err{color:#ff6b6b}`;
    document.head.appendChild(style);
  }

  let client = null, wrap = null, pill = null, pal = null;
  let pwrBtn = null, nowEl = null, freqIn = null, setBtn = null, modeBtns = [], msgEl = null;
  let msg = "", msgErr = false, busy = false;

  function setMsg(text, err) { msg = text || ""; msgErr = !!err; render(); }

  // Same CAT path the DATA pages' own frequency menus take.
  function cmd(body) {
    return fetch("/cmd?radio=lan", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.ok ? "" : r.json().then(j => j.error || "HTTP " + r.status, () => "HTTP " + r.status),
            () => "wifilt did not answer");
  }
  const WHY = { radio_disconnected: "the radio is not connected", tx_failed: "the radio did not take it",
                invalid_mode: "mode not supported", invalid_frequency: "not a frequency" };

  function transmitting() {
    const st = client.last && client.last.state;
    return !!(st && st.lamp === "tx");
  }

  async function run(what, body) {
    if (busy) return;
    if (transmitting()) { setMsg("not while transmitting", true); return; }
    busy = true;
    setMsg(what + " …");
    const err = await cmd(body);
    busy = false;
    setMsg(err ? what + ": " + (WHY[err] || err) : what, !!err);
  }

  function applyFreq() {
    const hz = parseFreq(freqIn.value);
    if (!hz) { setMsg("type kHz (14074) or MHz (14.074), 30 kHz – 60 MHz", true); freqIn.select(); return; }
    freqIn.value = "";
    run(fmtKHz(hz), { type: "setFrequency", frequency: hz });
  }

  function build(nav) {
    injectCss();
    wrap = document.createElement("span");
    wrap.className = "ltx480-dm";
    wrap.hidden = true;
    pill = document.createElement("button");
    pill.type = "button";
    pill.className = "ltx480-dm-pill";
    pill.setAttribute("aria-haspopup", "dialog");
    pill.setAttribute("aria-expanded", "false");
    pill.innerHTML = '<span class="ltx480-dm-dot"></span>TS480';
    pill.addEventListener("click", () => setOpen(pal.hidden));
    wrap.appendChild(pill);

    pal = document.createElement("div");
    pal.className = "ltx480-dm-pal";
    pal.id = "ts480DataPalette";
    pal.hidden = true;
    pal.setAttribute("role", "dialog");
    pal.setAttribute("aria-label", "TS-480");

    const row1 = document.createElement("div");
    row1.className = "ltx480-dm-row";
    pwrBtn = document.createElement("button");
    pwrBtn.type = "button";
    pwrBtn.className = "ltx480-dm-pwr";
    pwrBtn.addEventListener("click", () => {
      if (transmitting()) { setMsg("not while transmitting", true); return; }
      client.power();
    });
    nowEl = document.createElement("span");
    nowEl.className = "ltx480-dm-now";
    row1.append(pwrBtn, nowEl);

    const row2 = document.createElement("div");
    row2.className = "ltx480-dm-row";
    freqIn = document.createElement("input");
    freqIn.className = "ltx480-dm-freq";
    freqIn.type = "text";
    freqIn.inputMode = "decimal";
    freqIn.autocomplete = "off";
    freqIn.spellcheck = false;
    freqIn.placeholder = "kHz 14074 · MHz 14.074";
    freqIn.setAttribute("aria-label", "Frequency");
    freqIn.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); applyFreq(); }
      else if (e.key === "Escape") { e.preventDefault(); setOpen(false); pill.focus(); }
    });
    setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.textContent = "SET";
    setBtn.addEventListener("click", applyFreq);
    row2.append(freqIn, setBtn);

    const row3 = document.createElement("div");
    row3.className = "ltx480-dm-row ltx480-dm-modes";
    modeBtns = MODES.map(m => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = m.label;
      b.addEventListener("click", () => run(m.label, { type: "setMode", mode: m.cmd }));
      row3.appendChild(b);
      return b;
    });

    msgEl = document.createElement("div");
    msgEl.className = "ltx480-dm-msg";
    pal.append(row1, row2, row3, msgEl);
    wrap.appendChild(pal);
    nav.appendChild(wrap);

    // Closes on a click anywhere else and on Esc.
    document.addEventListener("pointerdown", e => {
      if (!pal.hidden && !wrap.contains(e.target)) setOpen(false);
    }, true);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !pal.hidden) setOpen(false);
    });
  }

  function setOpen(open) {
    pal.hidden = !open;
    pill.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { setMsg(""); if (client.powerOn) freqIn.focus(); }
  }

  function render() {
    if (!client || !wrap) return;
    const show = client.serverUp && !!(client.last && client.last.portOpen);
    wrap.hidden = !show;
    if (!show && !pal.hidden) setOpen(false);
    const on = client.powerOn, linked = client.linked;
    pill.classList.toggle("on", on);
    pill.classList.toggle("nolink", !linked);
    pill.title = !linked ? "TS-480: no data from the radio (panel cable)" : on ? "TS-480: on" : "TS-480: off";

    pwrBtn.innerHTML = window.Ts480Client.ICONS.power + (on ? "ON" : "OFF");
    pwrBtn.classList.toggle("on", on);
    pwrBtn.disabled = !linked;
    pwrBtn.title = !linked ? "No data from the radio (panel cable)" : on ? "Switch the radio off" : "Switch the radio on";

    const st = (client.last && client.last.state) || {};
    const code = on ? st.mode_code : null;
    nowEl.innerHTML = "";
    if (on && st.freq_hz) {
      nowEl.textContent = fmtKHz(st.freq_hz);
      const mode = MODES.find(m => m.codes.indexOf(code) >= 0);
      if (mode || st.mode) {
        const small = document.createElement("small");
        small.textContent = st.mode || mode.label;
        nowEl.appendChild(small);
      }
    } else {
      nowEl.textContent = on ? "" : "—";
    }

    const ready = on && !busy;
    freqIn.disabled = !on;
    setBtn.disabled = !ready;
    modeBtns.forEach((b, i) => {
      b.disabled = !ready;
      b.classList.toggle("on", MODES[i].codes.indexOf(code) >= 0);
    });
    const text = !linked ? "No data from the radio — panel cable, port " + ((client.hello && client.hello.port) || "?")
      : !on && !msg ? "The radio is off — ⏻ switches it on" : msg;
    msgEl.textContent = text;
    msgEl.classList.toggle("err", !linked || msgErr);
  }

  function start() {
    const nav = document.querySelector("nav.subtabs");
    if (!nav) return;
    loadScript("client.js")      // no lcd.js, no audio.js: no display and no AF here
      .then(() => {
        client = new Ts480Client(`ws://${base.hostname}:${CFG.wsPort}/ts480`);
        build(nav);
        client.on("refresh", render);
        client.connect();
        render();
      })
      .catch(e => console.warn("TS-480 pill: cannot load " + e.message + " from local-trx"));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
