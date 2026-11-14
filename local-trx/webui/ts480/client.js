// SPDX-License-Identifier: GPL-3.0-or-later
// TS-480 panel client, shared by the QRPlog palette (qrplog.js) and the full
// panel window (panel.html): the WebSocket to local-trx (ts480_ws.h), and the
// header both have -- title, ⏻, AF, PTT, and one button at the right end
// (expand in the palette, collapse in the window).
//
//   const client = new Ts480Client("ws://host:8766/ts480");
//   client.on("state", m => lcd.render(m));
//   header.appendChild(client.headerControls({ end: { icon, title, onClick } }));
//   client.connect();
(function () {
  "use strict";
  if (window.Ts480Client) return;

  // Same glyphs as wifilt's own top bar (fw-version.js POWER_ICON) -- copied,
  // local-trx does not load wifilt's files.
  const ICONS = {
    power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 3v9"/><path d="M6.34 7.34A8 8 0 1 0 17.66 7.34"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M11 5H5v14h14v-6"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6"/><path d="M10 14l-7 7"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/></svg>',
  };

  function injectCss() {
    if (document.getElementById("ltx480-head-css")) return;
    const style = document.createElement("style");
    style.id = "ltx480-head-css";
    style.textContent = `
.ltx480-ctl{display:inline-flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0}
.ltx480-ctl button{display:inline-flex;align-items:center;justify-content:center;gap:3px;
  border:1px solid #28443e;border-radius:999px;background:#132724;color:#8ba59d;cursor:pointer;
  font:700 9px/1.5 ui-monospace,Consolas,monospace;letter-spacing:.04em;padding:1px 6px;flex:none}
.ltx480-ctl button[hidden]{display:none}
.ltx480-ctl button:hover{border-color:#8ba59d;color:#e8f3ee}
.ltx480-ctl button svg{width:12px;height:12px;display:block}
.ltx480-ctl .ltx480-pwr{padding:2px 4px}
.ltx480-ctl .ltx480-pwr.on{color:#4cd964;border-color:#2f7d3d}
.ltx480-ctl .ltx480-pwr.nolink{opacity:.45}
.ltx480-ctl .ltx480-af.on{border-color:#66f2d5;background:#123430;color:#66f2d5}
.ltx480-ctl .ltx480-af.blocked{animation:ltx480-pulse 1s ease-in-out infinite}
.ltx480-ctl .ltx480-ptt.on{border-color:#ff4b3a;background:#5a1410;color:#fff}
.ltx480-ctl .ltx480-ptt:disabled{opacity:.4;cursor:not-allowed}
.ltx480-ctl .ltx480-msg{color:#8ba59d;font:400 10px/1.2 ui-monospace,Consolas,monospace;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.ltx480-ctl .ltx480-msg.err{color:#ff6b6b}
.ltx480-ctl .ltx480-end{margin-left:auto;padding:2px 4px}
@keyframes ltx480-pulse{0%,100%{border-color:#28443e;color:#8ba59d}50%{border-color:#66f2d5;color:#66f2d5}}`;
    document.head.appendChild(style);
  }

  class Ts480Client {
    constructor(wsUrl) {
      this.wsUrl = wsUrl;
      this.ws = null;
      this.handlers = {};
      this.hello = null;
      this.last = null;        // last "state" message
      this.serverUp = false;
      this.af = false;
      this.afWanted = false;   // AF should be on but the browser wants a click first
      this.ptt = false;
      this.pttBusy = false;
      this.message = "";
      this.messageErr = false;
      this.closed = false;
      this.audio = window.Ts480Audio ? new window.Ts480Audio(b => this.sendBinary(b)) : null;
      this.controls = [];
    }

    on(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); return this; }
    emit(type, arg) { for (const fn of this.handlers[type] || []) { try { fn(arg); } catch (e) { console.error(e); } } }

    connect() {
      if (this.closed) return;
      let ws;
      try { ws = new WebSocket(this.wsUrl); } catch (e) { setTimeout(() => this.connect(), 3000); return; }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        this.serverUp = true;
        if (this.af) this.send({ op: "af", on: true });
        this.refresh();
      };
      ws.onmessage = e => {
        if (typeof e.data !== "string") {
          if (this.audio) this.audio.pushRx(e.data);
          return;
        }
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.type === "hello") { this.hello = m; this.emit("hello", m); }
        else if (m.type === "state") { this.last = m; this.emit("state", m); }
        else if (m.type === "ptt") this.onPttReply(m);
        this.refresh();
      };
      ws.onclose = () => {
        const was = this.serverUp;
        this.serverUp = false;
        this.ws = null;
        if (this.ptt) this.dropPtt("connection to local-trx lost");
        if (was) { this.last = null; this.emit("state", null); }
        this.refresh();
        if (!this.closed) setTimeout(() => this.connect(), 3000);
      };
    }

    close() {
      this.closed = true;
      if (this.ptt) this.setPtt(false);
      if (this.ws) this.ws.close();
      if (this.audio) this.audio.close();
    }

    send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
    sendBinary(buf) { if (this.ws && this.ws.readyState === 1 && this.ptt) this.ws.send(buf); }

    get linked() { return !!(this.last && this.last.connected); }
    get powerOn() { return !!(this.last && this.last.connected && this.last.state && this.last.state.power === true); }
    get modeCode() { return this.last && this.last.state ? this.last.state.mode_code : null; }
    get voiceMode() { return window.Ts480Lcd ? window.Ts480Lcd.isVoiceMode(this.modeCode) : false; }

    power() { this.send({ op: "down", key: "POWER" }); }

    setMessage(text, err) { this.message = text || ""; this.messageErr = !!err; this.refresh(); }

    // Called from a click: that is what lets the browser start audio.
    async setAf(on) {
      if (!this.audio || !(this.hello && this.hello.af)) return;
      if (on) {
        try {
          await this.audio.startRx();
        } catch (e) {
          this.setMessage("audio: " + e.message, true);
          return;
        }
        this.af = true;
        this.afWanted = false;
        this.send({ op: "af", on: true });
      } else {
        if (this.ptt) this.setPtt(false);
        this.af = false;
        this.afWanted = false;
        this.audio.stopRx();
        this.audio.stopMic();
        this.send({ op: "af", on: false });
      }
      this.emit("af", this.af);
      this.refresh();
    }

    // AF was on where this page came from (expand/collapse): show AF pulsing
    // until the operator clicks it -- a new window has no user gesture yet.
    wantAf() { this.afWanted = true; this.refresh(); }

    async setPtt(on) {
      if (!this.audio) return;
      if (on) {
        if (this.ptt || this.pttBusy) return;
        if (!window.Ts480Audio.canMic()) {
          this.setMessage("microphone needs https or a browser on this PC (localhost)", true);
          return;
        }
        this.pttBusy = true;
        this.refresh();
        try {
          await this.audio.startMic();
        } catch (e) {
          this.pttBusy = false;
          this.setMessage("microphone: " + e.message, true);
          return;
        }
        this.send({ op: "ptt", on: true });   // onPttReply() starts the audio
      } else {
        this.pttBusy = false;
        if (this.audio) this.audio.setTx(false);
        if (this.ptt) this.send({ op: "ptt", on: false });
        this.ptt = false;
        this.refresh();
      }
    }

    onPttReply(m) {
      this.pttBusy = false;
      this.ptt = !!m.on;
      if (this.audio) this.audio.setTx(this.ptt);
      if (this.ptt) this.setMessage("TX");
      else this.setMessage(m.reason || "", !!m.reason);
      this.emit("ptt", this.ptt);
    }

    dropPtt(reason) {
      this.ptt = false;
      this.pttBusy = false;
      if (this.audio) this.audio.setTx(false);
      this.setMessage(reason, true);
    }

    // The header's buttons; `end` is the right-hand button (expand/collapse).
    headerControls({ end } = {}) {
      injectCss();
      const box = document.createElement("span");
      box.className = "ltx480-ctl";
      const mk = (cls, html, title) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.innerHTML = html;
        if (title) b.title = title;
        // Keep the caret where it is (QRPlog's Call field).
        b.addEventListener("mousedown", e => e.preventDefault());
        box.appendChild(b);
        return b;
      };
      const pwr = mk("ltx480-pwr", ICONS.power, "Power");
      pwr.addEventListener("click", () => this.power());
      const af = mk("ltx480-af", "AF", "Radio audio in this browser");
      af.addEventListener("click", () => this.setAf(!this.af));
      const ptt = mk("ltx480-ptt", "PTT", "Transmit the microphone (SSB/AM/FM)");
      ptt.addEventListener("click", () => this.setPtt(!this.ptt));
      const msg = document.createElement("span");
      msg.className = "ltx480-msg";
      box.appendChild(msg);
      let endBtn = null;
      if (end) {
        endBtn = mk("ltx480-end", ICONS[end.icon] || end.icon, end.title);
        endBtn.addEventListener("click", end.onClick);
      }
      this.controls.push({ pwr, af, ptt, msg });
      this.refresh();
      return box;
    }

    refresh() {
      const h = this.hello || {};
      for (const c of this.controls) {
        c.pwr.classList.toggle("on", this.powerOn);
        c.pwr.classList.toggle("nolink", !this.linked);
        c.pwr.title = !this.serverUp ? "local-trx not reachable"
          : !this.linked ? "No data from the radio (panel cable / port " + (h.port || "?") + ")"
          : this.powerOn ? "Switch the radio off" : "Switch the radio on";
        c.af.hidden = !h.af;
        c.af.classList.toggle("on", this.af);
        c.af.classList.toggle("blocked", (this.afWanted && !this.af) || !!(this.audio && this.audio.blocked));
        const canTx = !!h.tx && this.af && this.voiceMode && this.powerOn;
        c.ptt.hidden = !canTx && !this.ptt;
        c.ptt.classList.toggle("on", this.ptt);
        const secure = window.Ts480Audio && window.Ts480Audio.canMic();
        c.ptt.disabled = !secure || this.pttBusy;
        c.ptt.title = secure ? (this.ptt ? "Stop transmitting" : "Transmit the microphone")
          : "Microphone TX needs https or a browser on this PC (localhost) -- or Chrome's "
            + "unsafely-treat-insecure-origin-as-secure flag for this address";
        c.msg.textContent = !this.serverUp ? "local-trx offline" : this.message;
        c.msg.classList.toggle("err", !this.serverUp || this.messageErr);
      }
      this.emit("refresh");
    }
  }

  Ts480Client.ICONS = ICONS;
  window.Ts480Client = Ts480Client;
})();
