// XARA (VARA-compatible) host protocol: command parser, reply lines and the TNC
// glue between a host (Pat / Winlink Express over the ESP32 TCP bridge, or the
// built-in chat page) and an HfStation from vara-modem.js. Hand port of
// x0rro/xara (MIT, (C) 2026 x0rro): xara-host/src/{command,response}.rs and
// xara/src/tnc.rs. Port (C) 2026 RemoteQTH.com. docs/vara-implementace.md.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./vara-modem.js"));
  else root.VaraHost = factory(root.VaraModem);
})(typeof self !== "undefined" ? self : this, function (M) {
  "use strict";

  // ───────────────────────────── commands (command.rs)
  const DRIVE_MIN_DB = -30;
  function fixSuffix(t) {
    return t.length === 8 && !t.includes("-") && "RTXL".includes(t[7]) ? t.slice(0, 7) + "-" + t.slice(7) : t;
  }
  function validCall(t) {
    const u = t.toUpperCase(), i = u.indexOf("-");
    const base = i < 0 ? u : u.slice(0, i), suf = i < 0 ? null : u.slice(i + 1);
    if (base.length < 1 || base.length > 7 || !/^[A-Z0-9]+$/.test(base)) return null;
    let ok;
    if (suf === null) ok = true;
    else if (suf.length === 1) ok = "TRXL".includes(suf) || (suf >= "1" && suf <= "9");
    else if (suf.length === 2) ok = /^\d\d$/.test(suf) && +suf >= 1 && +suf <= 19;
    else ok = false;
    return ok ? u : null;
  }
  const call = t => validCall(fixSuffix(t));
  const isDigit = c => c >= "0" && c <= "9";
  function vbRadix(s, radix, short) {
    let n = 0;
    while (n < s.length && !isNaN(parseInt(s[n], radix))) n++;
    if (!n) return null;
    const v = parseInt(s.slice(0, n), radix);
    if (v > 0xFFFFFFFF) return null;
    return n <= short && v <= 0xFFFF ? (v >= 0x8000 ? v - 0x10000 : v) : v | 0;
  }
  // VB6 Val(): whitespace dropped, &H / &O radix, D or E exponent; null when there is no number at all.
  function vbNum(s0) {
    const s = s0.replace(/[\t\n\r 　]/g, ""), u = s.toUpperCase();
    if (u.startsWith("&H")) return vbRadix(u.slice(2), 16, 4);
    if (u.startsWith("&O")) return vbRadix(u.slice(2), 8, 6);
    const digits = i => { let n = 0; while (i + n < s.length && isDigit(s[i + n])) n++; return n; };
    let i = s[0] === "-" || s[0] === "+" ? 1 : 0;
    const int = digits(i);
    i += int;
    let frac = 0;
    if (s[i] === ".") { frac = digits(i + 1); i += 1 + frac; }
    if (int + frac === 0) return null;
    if ("DdEe".includes(s[i] || "x")) {
      const j = i + 1 + (s[i + 1] === "-" || s[i + 1] === "+" ? 1 : 0), n = digits(j);
      if (n > 0) return Number(s.slice(0, i) + "e" + s.slice(i + 1, j + n));
    }
    return Number(s.slice(0, i));
  }
  const vbVal = s => { const v = vbNum(s); return v === null ? 0 : v; };
  function drive(rest) {
    const v = vbNum(rest);
    if (v === null) return {kind: "notNumeric"};
    return v >= DRIVE_MIN_DB && v <= 0 ? {kind: "db", db: M.rint(v)} : {kind: "outOfRange"};
  }
  function cbyte(v) { const r = M.rint(v); return r >= 0 && r <= 255 ? r : null; }
  const EXACT = {
    "DISCONNECT": {kind: "disconnect"}, "ABORT": {kind: "abort"},
    "LISTEN CQ": {kind: "chat", on: true}, "CHAT ON": {kind: "chat", on: true}, "CHAT OFF": {kind: "chat", on: false},
    "WINLINK SESSION": {kind: "winlinkSession"}, "P2P SESSION": {kind: "p2pSession"},
    "LISTEN ON": {kind: "listen", on: true}, "LISTEN OFF": {kind: "listen", on: false},
    "PUBLIC ON": {kind: "public", on: true}, "PUBLIC OFF": {kind: "public", on: false},
    "CWID ON": {kind: "cwid", on: true}, "CWID OFF": {kind: "cwid", on: false},
    "COMPRESSION OFF": {kind: "compression", comp: M.COMP.OFF}, "COMPRESSION ON": {kind: "compression", comp: M.COMP.TEXT},
    "COMPRESSION TEXT": {kind: "compression", comp: M.COMP.TEXT}, "COMPRESSION FILES": {kind: "compression", comp: M.COMP.FILES},
    "IGNOREKISSDCD ON": {kind: "ignoreKissDcd", on: true}, "IGNOREKISSDCD OFF": {kind: "ignoreKissDcd", on: false},
    "BW2300": {kind: "bw", hz: 2300}, "BW2750": {kind: "bw", hz: 2750}, "BW500": {kind: "bw", hz: 500},
    "CLEANTXBUFFER": {kind: "cleanTxBuffer"}, "VERSION": {kind: "version"},
  };
  // One command line (without CR) -> command object, or null for WRONG.
  function parse(line) {
    if (line.startsWith("CONNECT ")) {
      const t = line.split(" ");
      if (t.length === 3) { const a = call(t[1]), b = call(t[2]); return a && b ? {kind: "connect", mycall: a, remote: b} : null; }
      if ((t.length === 5 || t.length === 6) && t[3] === "VIA") {
        const a = call(t[1]), b = call(t[2]), vias = t.slice(4).map(call);
        return a && b && vias.every(v => v) ? {kind: "connectVia", mycall: a, remote: b, vias} : null;
      }
      return null;
    }
    if (line.startsWith("MYCALL ")) {
      const t = line.split(" ").slice(1);
      if (!t[0] || t.length > 5) return {kind: "mycall", calls: null};
      const calls = t.map(call);
      return {kind: "mycall", calls: calls.every(c => c) ? calls : null};
    }
    if (line.startsWith("GATEWAY ")) return {kind: "gateway"};
    if (line.startsWith("CQFRAME ")) {
      const t = line.split(" ");
      if (t.length < 2 || t.length > 3 || !t[t.length - 1]) return null;
      const c = call(t[1]);
      return c ? {kind: "cqFrame", call: c, bw: t.length === 3 ? t[2] : null} : null;
    }
    if (Object.prototype.hasOwnProperty.call(EXACT, line)) return Object.assign({}, EXACT[line]);
    if (line.startsWith("RETRIES ")) return {kind: "retries", n: cbyte(vbVal(line.slice(8)))};
    if (line.startsWith("TUNE ")) {
      const rest = line.slice(5), t = rest.trim();
      if (t.toUpperCase() === "OFF") return {kind: "tuneOff"};
      if (t === "?") return {kind: "tuneQuery"};
      return {kind: "tune", drive: drive(rest)};
    }
    if (line.startsWith("DRIVELEVEL ")) return {kind: "driveLevel", drive: drive(line.slice(11))};
    return null;
  }

  // ───────────────────────────── replies (response.rs)
  const printable = s => Array.from(s, c => (c >= "!" && c <= "~") || c === " " ? c : "?").join("");
  function shownCall(c) {
    const v = Array.from(c);
    if (v.length === 9 && v[7] === "-" && "RTXL".includes(v[8])) v.splice(7, 1);
    return printable(v.join("")).replace(/ /g, "?");
  }
  const onOff = on => on ? "ON" : "OFF";
  // Rust {:.1}: the exact binary value rounded half to even (ties are exactly x.25 / x.75).
  function fixed1(x) {
    const s = Math.abs(x), q = s * 4;
    let out;
    if (Number.isInteger(q) && q % 2 === 1) { const t = Math.floor(s * 10); out = ((t % 2 === 0 ? t : t + 1) / 10).toFixed(1); }
    else out = s.toFixed(1);
    return x < 0 || Object.is(x, -0) ? "-" + out : out;
  }
  const R = {
    ok: () => "OK", wrong: () => "WRONG", busy: on => "BUSY " + onOff(on), ptt: on => "PTT " + onOff(on),
    bitrate: (level, bps, tx) => `BITRATE (${level})  ${bps} bps ${tx ? "TX" : "RX"}`,
    pending: () => "PENDING", cancelPending: () => "CANCELPENDING",
    connected(caller, answerer, vias, width) {
      let s = "CONNECTED " + shownCall(caller) + " " + shownCall(answerer);
      if (vias.length) s += " VIA" + vias.map(v => " " + shownCall(v)).join("");
      return s + " " + width;
    },
    disconnected: () => "DISCONNECTED", linkRegistered: r => r ? "LINK REGISTERED" : "LINK UNREGISTERED",
    buffer: n => "BUFFER " + n, sn: s => "SN " + fixed1(s), iAmAlive: () => "IAMALIVE",
    registered: calls => "REGISTERED" + (calls || []).map(c => " " + printable(c)).join(""),
    encryptionDisabled: () => "ENCRYPTION DISABLED", unencryptedLink: () => "UNENCRYPTED LINK",
    tune: d => "TUNE " + String(d), cleanTxBuffer: empty => empty ? "CLEANTXBUFFER BUFFEREMPTY" : "CLEANTXBUFFER FAILED ",
    version: v => v, line: l => printable(l),
  };
  const isReply = l => l === "OK" || l === "WRONG" || ["VERSION ", "TUNE ", "CLEANTXBUFFER "].some(p => l.startsWith(p));

  // ───────────────────────────── TNC (tnc.rs)
  const SECOND = M.SECOND, REGISTERED_AFTER = 5 * SECOND, HOST_TUNE_LIMIT = 60 * SECOND, UI_TUNE_LIMIT = 60 * SECOND;
  const ALIVE_EVERY = 60 * SECOND, HOST_INPUTS_PER_CALL = 32, MAX_LINE = 1024;
  function hostResponse(h) {
    switch (h.kind) {
      case "pending": return R.pending();
      case "cancelPending": return R.cancelPending();
      case "connected": return R.connected(h.caller, h.answerer, h.vias, String(h.bw.hz));
      case "disconnected": return R.disconnected();
      case "registered": return R.linkRegistered(h.registered);
      case "buffer": return R.buffer(h.n);
      case "sn": return R.sn(h.sn);
      default: return null;
    }
  }
  // host: {line(text), data(bytes), hasCmdClient(), hasDataClient()} -- the two VARA TCP ports.
  // Feed it with cmdBytes()/dataBytes()/clientConnected()/clientClosed(); hold() tells the
  // transport to stop reading the data port (TX buffer full).
  class Tnc {
    constructor(station, host, opts) {
      this.station = station; this.host = host; this.opts = opts || {};
      this.input = []; this.lineBuf = []; this.longLine = false;
      this.keyed = false; this.forcedOff = false; this.aliveAt = station.now + ALIVE_EVERY; this.registeredAt = null;
      this.deferredMycall = undefined; this.savedRetries = 0; this.busy = false; this.tuneBy = null; this.tuneUntil = 0;
      this.held = false;
    }
    // transport side
    cmdBytes(bytes) {
      for (const b of bytes) {
        if (b === 13) {
          const l = new TextDecoder().decode(Uint8Array.from(this.lineBuf));
          this.lineBuf = [];
          if (this.longLine) { this.longLine = false; continue; }
          const c = parse(l);
          this.input.push(c ? {kind: "command", cmd: c, line: l} : {kind: "wrong", line: l});
        } else if (b === 10) continue;
        else if (this.lineBuf.length >= MAX_LINE) { this.lineBuf = []; this.longLine = true; }
        else if (!this.longLine) this.lineBuf.push(b);
      }
    }
    cmdLine(line) { this.cmdBytes(new TextEncoder().encode(line + "\r")); }
    dataBytes(bytes) { this.input.push({kind: "data", data: Uint8Array.from(bytes)}); }
    clientConnected() { this.input.push({kind: "connected"}); }
    clientClosed() { this.lineBuf = []; this.longLine = false; this.input.push({kind: "closed"}); }
    hold() { return this.held; }
    // modem side
    service() {
      this.holdData();
      for (let k = 0; k < HOST_INPUTS_PER_CALL && this.input.length; k++) {
        const i = this.input.shift();
        if (i.kind === "command") { this.echo("> " + i.line); this.command(i.cmd); }
        else if (i.kind === "wrong") { this.echo("> " + JSON.stringify(i.line)); this.say(R.wrong()); }
        else if (i.kind === "data") { this.station.send(i.data); this.holdData(); }
        else if (i.kind === "connected") this.toggleBusy();
        else if (i.kind === "closed") this.hostDropped();
      }
      this.flush();
    }
    process(input, output) {
      this.service();
      this.station.process(input, output);
      const now = this.station.now;
      if (now >= this.aliveAt) { this.aliveAt += ALIVE_EVERY; this.say(R.iAmAlive()); }
      if (this.registeredAt !== null && now >= this.registeredAt) {
        this.registeredAt = null;
        const h = this.station.config().host;
        this.say(R.registered(h.registered ? h.mycalls : null));
        this.say(R.encryptionDisabled());
      }
      this.flush();
      if (this.station.busy() !== this.busy) this.reportBusy(this.station.busy());
      this.limitTune(now);
    }
    limitTune(now) {
      if (this.tuneBy === null) return;
      if (!this.station.tuning()) this.tuneBy = null;
      else if (now >= this.tuneUntil) {
        const limit = this.tuneBy === "host" ? HOST_TUNE_LIMIT : UI_TUNE_LIMIT;
        this.stopTune();
        this.event({kind: "control", what: "tune off after " + limit / SECOND + " s", ok: true});
      }
    }
    startTune(by) {
      const ok = this.station.tune(true);
      if (ok) { this.tuneBy = by; this.tuneUntil = this.station.now + (by === "host" ? HOST_TUNE_LIMIT : UI_TUNE_LIMIT); }
      return ok;
    }
    stopTune() { this.tuneBy = null; return this.station.tune(false); }
    setDrive(db) {
      db = M.rint(Math.min(0, Math.max(DRIVE_MIN_DB, db)));
      this.station.setDrive(db);
      return db;
    }
    hostTune(d) {
      if (d.kind === "outOfRange") return;
      if (d.kind === "db") this.setDrive(d.db);
      if (!this.station.tuning()) this.startTune("host");
    }
    // the built-in page's controls (telemetry Control in upstream)
    uiTune(on) { return on ? this.startTune("ui") : this.stopTune(); }
    uiDrive(db) { return this.setDrive(db); }
    uiAbort() { this.stopTune(); this.station.abort(); this.flush(); }
    forcePttOff(off) {
      if (off !== this.forcedOff) { this.forcedOff = off; if (this.keyed) this.say(R.ptt(!off)); }
    }
    echo(s) { if (this.opts.log) this.opts.log((this.station.now / SECOND).toFixed(3).padStart(10) + " " + s); }
    event(e) { if (this.opts.onEvent) this.opts.onEvent(e); }
    trace(s) { this.echo("  " + s); this.event({kind: "trace", text: s}); }
    say(line) {
      this.echo("< " + line);
      this.host.line(line);
      this.event({kind: "line", line});
    }
    reportBusy(on) { this.busy = on; this.say(R.busy(on)); }
    toggleBusy() { this.reportBusy(!this.busy); }
    holdData() { this.held = !this.idle() && this.station.buffered() >= M.TX_RING_BYTES; }
    idle() { return this.station.idle(); }
    reconfigure(f) {
      const c = M.cloneCfg(this.station.config());
      f(c);
      return this.station.reconfigure(c);
    }
    setMycalls(calls) {
      if (this.reconfigure(c => { c.host.mycalls = calls.slice(); })) this.registeredAt = this.station.now + REGISTERED_AFTER;
    }
    setChat(on) { if (!this.reconfigure(c => { c.host.chat = on; })) this.station.update(c => { c.host.chat = on; }); }
    hostDropped() {
      if (this.tuneBy === "host") this.stopTune();
      this.station.setListen(false);
      this.station.dropLink();
      this.setChat(false);
    }
    command(c) {
      const st = this.station, idle = this.idle();
      let ok;
      switch (c.kind) {
        case "connect": ok = !st.ptt() && st.connect(c.mycall, c.remote, []); break;
        case "connectVia": ok = st.constructor.VIAS && !st.ptt() && !c.vias.includes(c.mycall) && st.connect(c.mycall, c.remote, c.vias); break;
        case "mycall":
          if (!idle) { this.deferredMycall = c.calls; ok = false; }
          else if (c.calls) { this.deferredMycall = undefined; this.setMycalls(c.calls); ok = true; }
          else { this.say(R.wrong()); ok = true; }
          break;
        case "cqFrame": ok = idle && st.cqFrame(c.call, c.bw); break;
        case "disconnect": st.disconnect(); ok = true; break;
        case "abort": st.abort(); ok = true; break;
        case "chat":
          if (!idle) { ok = false; break; }
          if (c.on) this.toggleBusy();
          this.setChat(c.on && this.host.hasCmdClient() && this.host.hasDataClient());
          if (c.on) st.setListen(true);
          ok = true;
          break;
        case "winlinkSession": case "p2pSession": st.setP2p(c.kind === "p2pSession"); ok = true; break;
        case "retries": {
          const cur = st.config().host.retries;
          let n = null;
          if (c.n === 0 && this.savedRetries > 0) n = this.savedRetries;
          else if (c.n !== null && c.n !== 0) { this.savedRetries = cur; n = c.n; }
          if (n !== null) st.update(cfg => { cfg.host.retries = n; });
          ok = true;
          break;
        }
        case "listen": {
          const linked = !idle;
          st.setListen(c.on);
          this.say(R.ok());
          if (linked) st.dropLink();
          return;
        }
        case "compression": st.update(cfg => { cfg.host.compression = c.comp; }); ok = true; break;
        case "bw": ok = idle && st.setBw(c.hz); break;
        case "gateway": case "cwid": ok = st.constructor.CWID_GATEWAY; break;
        case "public": ok = true; break;
        case "tuneOff": this.stopTune(); ok = true; break;
        case "tune": this.say(R.ok()); this.hostTune(c.drive); return;
        case "driveLevel": if (c.drive.kind === "db") this.setDrive(c.drive.db); ok = true; break;
        case "ignoreKissDcd": st.setIgnoreDcd(c.on); ok = true; break;
        case "tuneQuery": this.say(R.tune(Math.round(st.opts.driveDb))); return;
        case "cleanTxBuffer": this.say(R.cleanTxBuffer(st.buffered() === 0)); return;
        case "version": this.say(R.version(st.constructor.VERSION)); return;
        default: ok = false;
      }
      this.say(ok ? R.ok() : R.wrong());
    }
    flush() {
      let r;
      while ((r = this.station.pop())) {
        switch (r.kind) {
          case "trace": this.trace(r.text); break;
          case "ptt": this.keyed = r.on; if (!this.forcedOff) this.say(R.ptt(r.on)); this.event({kind: "ptt", on: r.on}); break;
          case "busy": if (r.on !== this.busy) this.reportBusy(r.on); break;
          case "unencrypted": this.say(R.unencryptedLink()); break;
          case "line": this.say(R.line(r.line)); break;
          case "bitrate": this.say(R.bitrate(r.level, r.bps, r.tx)); break;
          case "host": {
            const h = r.ev;
            if (h.kind === "data") { this.host.data(h.data); break; }
            if (h.kind === "disconnected") {
              const d = this.deferredMycall;
              this.deferredMycall = undefined;
              if (d === null) this.say(R.wrong());
              this.say(R.disconnected());
              if (d) this.setMycalls(d);
              break;
            }
            if (h.kind === "unableToConnect" || h.kind === "timedOut") { this.event({kind: h.kind}); break; }
            const s = hostResponse(h);
            if (s !== null) this.say(s);
            break;
          }
        }
      }
    }
  }

  return {parse, fixSuffix, validCall, vbNum, R, shownCall, fixed1, isReply, hostResponse, Tnc, MAX_LINE, DRIVE_MIN_DB};
});
