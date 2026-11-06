// XARA (VARA-compatible) modem worker (docs/vara-implementace.md, phase 3).
//
// One HfStation (data/vara-modem.js) and its host-protocol front end (Tnc,
// data/vara-host.js) on top of the AUD1 audio socket (data/js8-aud1.js), the
// same transport Mercury's worker uses. The station is a duplex sample stream,
// not a burst engine: every block of received audio is pushed through
// station.process(rx, tx), which returns a block of transmit audio of the same
// length. So the radio's own RX sample clock is the modem's clock -- AUD1's
// firstSample is the authority, gaps are filled with silence and overlaps
// trimmed (docs/aud1-audio-websocket-protocol.md) -- and a keyed stretch of
// the output is streamed to the firmware as ONE AUD1 transmission:
// tx.prepare when keying starts, tx.extend while it lasts, FIRST/LAST packets
// at its exact ends (station.keyed marks every keyed sample).
//
// Latency is the price of that path and the one number the protocol cares
// about: the station is told the whole round trip, its own output to its own
// input (upstream's tx_latency: capture + backlog + lead + keying + queue +
// out), so it mutes its own echo and times its reply windows from when its
// frames really ended on the air. VARA tolerates a slow PEER only so far --
// tools/vara-loopback-test.js with a delay: a caller of ours is fine with any
// latency we have, a Winlink-timing caller of theirs waits ~200 ms for us, a
// P2P/chat one ~500 ms. Hence the short slot and prebuffer below.
//
// UMD: the Worker loads it with importScripts and runs the glue at the end;
// Node (tools/vara-worker-test.js) requires the core and drives it with a
// simulated firmware.
(function (root, factory) {
  const value = factory(root);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.VaraWorker = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (root) {
  "use strict";
  const FS = 48000, PACKET = 960; // AUD1 TX: 20 ms packets at 48 kHz

  // ---- 8 kHz -> 48 kHz, polyphase windowed-sinc interpolator -------------
  // The station's front end decimates by 16 to 3 kHz on its own, so all this
  // has to do is put the AUD1 band back at 48 kHz without images that alias
  // into it. 24 taps per phase, Blackman, cut at 3.7 kHz (the 2750 band ends
  // at ~3.1 kHz, mu-law's own band at 4).
  const UP = 6, TAPS = 24;
  const UP_H = (() => {
    const n = UP * TAPS, h = new Float64Array(n), m = (n - 1) / 2, fc = 3700 / FS;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const x = i - m, w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
      h[i] = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * w;
      s += h[i];
    }
    for (let i = 0; i < n; i++) h[i] *= UP / s;
    return h;
  })();
  class Upsampler {
    constructor() { this.hist = new Float64Array(TAPS); this.p = 0; }
    run(x) {
      const out = new Float64Array(x.length * UP), hist = this.hist;
      for (let n = 0; n < x.length; n++) {
        this.p = (this.p + TAPS - 1) % TAPS;
        hist[this.p] = x[n];
        for (let ph = 0; ph < UP; ph++) {
          let y = 0;
          for (let k = 0; k < TAPS; k++) y += UP_H[ph + UP * k] * hist[(this.p + k) % TAPS];
          out[n * UP + ph] = y;
        }
      }
      return out;
    }
  }

  // ---- AUD1 TX: one keyed stretch of station output = one transmission ----
  // The firmware wants the length up front (tx.prepare) and FIRST/LAST on the
  // exact ends (aud1AcceptTxPacket); the station only knows a burst has ended
  // when it has. So the declared length is kept a few packets ahead with
  // tx.extend, and the end is padded with silence up to whatever is declared
  // -- never more than EXTEND_STEP packets of keyed silence.
  const EXTEND_STEP = 3;
  function txPacket(streamId, txId, seq, firstSample, pcm, first, last) {
    const wire = new Uint8Array(40 + pcm.length * 2), v = new DataView(wire.buffer);
    wire.set([0x41, 0x55, 0x44, 0x31], 0); wire[4] = 1; wire[5] = 3;
    v.setUint16(6, (first ? 1 : 0) | (last ? 2 : 0), false); v.setUint16(8, 40, false);
    v.setUint32(12, streamId >>> 0, false); v.setUint32(16, seq >>> 0, false); v.setUint32(20, FS, false);
    v.setBigUint64(24, BigInt(firstSample), false); v.setUint32(32, txId >>> 0, false);
    v.setUint32(36, pcm.length * 2, false);
    for (let i = 0; i < pcm.length; i++) v.setInt16(40 + i * 2, pcm[i], true);
    return wire;
  }
  class TxStream {
    constructor(aud1, opts) {
      this.aud1 = aud1; this.opts = opts; this.nextId = 1; this.cur = null;
      this.pcm = new Int16Array(PACKET); this.fill = 0; this.faults = 0; this.sent = 0;
    }
    get active() { return this.cur !== null; }
    feed(out, keyed) {
      for (let i = 0; i < out.length; i++) {
        if (keyed[i]) {
          if (!this.cur) this.start();
          const v = Math.round(out[i] * 32767 * this.opts.gain());
          this.pcm[this.fill++] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
          if (this.fill === PACKET) this.flush(false);
        } else if (this.cur) this.finish();
      }
    }
    start() {
      const o = this.opts, pre = Math.max(1, Math.round(o.prebufferMs() / 20)), txId = this.nextId++;
      this.cur = {txId, seq: 0, declared: pre + 2, failed: false};
      this.fill = 0;
      try {
        this.aud1.prepare(txId, {slotUtcMs: o.wallNow() + o.slotMs(), prebufferSamples: pre * PACKET, packetMs: 20,
          samples: this.cur.declared * PACKET, packets: this.cur.declared, mode: "XARA", toneHz: 0})
          .catch(e => this.fail(txId, e));
        this.aud1.begin(txId);
      } catch (e) { this.fail(txId, e); }
      o.event({kind: "tx-start", txId});
    }
    fail(txId, e) {
      if (!this.cur || this.cur.txId !== txId || this.cur.failed) return;
      this.cur.failed = true; this.faults++;
      this.opts.event({kind: "tx-fault", txId, reason: e && e.message || String(e)});
    }
    send(last) {
      const c = this.cur;
      if (!c.failed) {
        try {
          this.aud1.write(txPacket(this.aud1.hello.streamId, c.txId, c.seq, c.seq * PACKET, this.pcm, c.seq === 0, last));
        } catch (e) { this.fail(c.txId, e); }
      }
      c.seq++; this.sent++;
      this.fill = 0;
    }
    flush(last) {
      const c = this.cur;
      // A non-last packet may never be the last one declared (the firmware
      // reads that as a missing LAST), so stay EXTEND_STEP ahead of it.
      if (!last && c.seq + 2 > c.declared) {
        if (!c.failed) {
          try { this.aud1.sendControl({type: "tx.extend", txId: c.txId, samples: EXTEND_STEP * PACKET, packets: EXTEND_STEP}); }
          catch (e) { this.fail(c.txId, e); }
        }
        c.declared += EXTEND_STEP;
      }
      this.send(last);
    }
    finish() {
      const c = this.cur;
      if (this.fill > 0 || c.seq < c.declared) {
        this.pcm.fill(0, this.fill);
        while (c.seq < c.declared - 1) { this.send(false); this.pcm.fill(0); }
        this.send(true);
      }
      if (!c.failed) try { this.aud1.end(c.txId); } catch (_e) { /* socket gone */ }
      this.opts.event({kind: "tx-end", txId: c.txId, packets: c.seq, failed: c.failed});
      this.cur = null;
    }
    abort(reason) {
      if (!this.cur) return;
      try { this.aud1.abort(this.cur.txId, reason); } catch (_e) { /* socket gone */ }
      this.cur = null; this.fill = 0;
    }
  }

  // ---- the core -------------------------------------------------------------
  const DEFAULTS = {mycall: "", bw: 2300, latencyMs: 350, slotMs: 200, prebufferMs: 120, driveDb: -5, gain: 1,
    listen: false, p2p: true};
  const STALL_MS = 250, STALL_KEEP_MS = 150, STALL_MAX_MS = 3000, GAP_MAX_SAMPLES = 8000 * 5;
  class VaraCore {
    // deps: {M: vara-modem, H: vara-host, aud1, post(msg, transfer), wallNow(), monoNow()}
    constructor(deps, settings) {
      this.d = deps; this.M = deps.M; this.H = deps.H;
      this.s = Object.assign({}, DEFAULTS, settings || {});
      const M = this.M, bw = M.bandwidth(this.s.bw) || M.BW2300, cfg = M.hfConfig(bw, this.s.mycall || "N0CALL");
      cfg.p2p = Boolean(this.s.p2p);
      const lat = Math.round(this.s.latencyMs * FS / 1000);
      // rxLag = txLatency: PTT "off" lands on the burst's last sample, which is
      // where the AUD1 transmission has to end -- the firmware itself holds the
      // radio keyed until that audio has actually left.
      this.station = new M.HfStation(cfg, {driveDb: this.s.driveDb, txLatency: lat, rxLag: lat});
      this.tnc = new this.H.Tnc(this.station, {
        line: line => this.post({type: "line", line}),
        data: bytes => this.post({type: "data", bytes: Uint8Array.from(bytes)}),
        hasCmdClient: () => true, hasDataClient: () => true,
      }, {onEvent: e => this.onTncEvent(e)});
      this.up = new Upsampler();
      this.tx = new TxStream(deps.aud1, {
        gain: () => this.s.gain, slotMs: () => this.s.slotMs, prebufferMs: () => this.s.prebufferMs,
        wallNow: deps.wallNow, event: e => this.post({type: "tx", ...e}),
      });
      this.expect = null; this.lastAdvance = 0; this.stalled = 0; this.ready = false;
      this.cpuMs = 0; this.audioMs = 0; this.lastStatus = 0; this.lastStatusKey = "";
      this.rx8 = 0; this.filled = 0; this.trimmed = 0;
      if (this.s.mycall) this.tnc.cmdLine("MYCALL " + this.s.mycall);
      this.tnc.cmdLine("LISTEN " + (this.s.listen ? "ON" : "OFF"));
      this.tnc.cmdLine(this.s.p2p ? "P2P SESSION" : "WINLINK SESSION");
    }
    post(msg, transfer) { this.d.post(msg, transfer); }
    onTncEvent(e) {
      if (e.kind === "trace") this.post({type: "trace", text: e.text});
      else if (e.kind === "unableToConnect" || e.kind === "timedOut") this.post({type: "event", kind: e.kind});
    }
    // AUD1 RX: `samples` are floats at 8 kHz, `meta.firstSample` the radio's
    // media time for the first of them.
    onRx(samples, meta) {
      this.ready = true;
      const first = Number(meta.firstSample);
      let x = samples;
      if (this.expect === null) this.expect = first;
      if (first > this.expect) {
        const gap = first - this.expect;
        if (gap > GAP_MAX_SAMPLES) this.expect = first; // a new epoch, not a hole worth filling
        else this.feed8(new Float32Array(gap), true);
      } else if (first < this.expect) {
        const skip = this.expect - first;
        this.trimmed += Math.min(skip, x.length);
        if (skip >= x.length) return;
        x = x.subarray(skip);
      }
      this.feed8(x, false);
      this.lastAdvance = this.d.monoNow();
      this.stalled = 0;
    }
    // A Wi-Fi hiccup on the RX side would otherwise stop the modem's clock --
    // and with it a transmission that is streaming out of it. Keep time with
    // silence for a while; real samples that turn up late are trimmed above.
    tick() {
      if (!this.ready || this.expect === null) return;
      const now = this.d.monoNow(), late = now - this.lastAdvance;
      if (late < STALL_MS || this.stalled >= STALL_MAX_MS) return;
      const ms = Math.min(late - STALL_KEEP_MS, STALL_MAX_MS - this.stalled);
      const n = Math.floor(ms * 8);
      if (n <= 0) return;
      this.stalled += n / 8; this.lastAdvance += n / 8;
      this.feed8(new Float32Array(n), true);
    }
    feed8(x8, synthetic) {
      if (synthetic) this.filled += x8.length;
      this.expect += x8.length; this.rx8 += x8.length;
      if (!synthetic) this.post({type: "rx-samples", samples: Float32Array.from(x8)});
      const t0 = this.d.monoNow();
      const rx = this.up.run(x8), out = new Float64Array(rx.length);
      this.tnc.process(rx, out);
      this.tx.feed(out, this.station.keyed);
      this.cpuMs += this.d.monoNow() - t0; this.audioMs += x8.length / 8;
      this.status(false);
    }
    status(force) {
      const now = this.d.monoNow();
      if (!force && now - this.lastStatus < 250) return;
      const st = this.station, link = st.link();
      const s = {type: "status", state: link.state, level: link.level, peer: link.peer, bw: Number(link.bw),
        afcHz: link.afcHz, ptt: st.ptt(), txActive: this.tx.active, busy: st.busy(), buffered: st.buffered(),
        tuning: st.tuning(), mycall: (st.config().host.mycalls || [])[0] || "", listen: st.listenOn,
        p2p: Boolean(st.config().p2p), load: this.audioMs ? this.cpuMs / this.audioMs : 0,
        filledMs: this.filled / 8, trimmedMs: this.trimmed / 8, txFaults: this.tx.faults};
      const key = JSON.stringify(s);
      if (!force && key === this.lastStatusKey && now - this.lastStatus < 1000) return;
      this.lastStatus = now; this.lastStatusKey = key;
      this.cpuMs = 0; this.audioMs = 0;
      this.post(s);
    }
    // page -> modem
    command(line) { this.tnc.cmdLine(line); this.tnc.service(); this.status(true); }
    send(bytes) { this.tnc.dataBytes(bytes); this.tnc.service(); this.status(true); }
    tune(on) { this.tnc.uiTune(on); this.status(true); }
    drive(db) { this.s.driveDb = this.tnc.uiDrive(db); this.status(true); }
    abort() { this.tnc.uiAbort(); this.tx.abort("operator abort"); this.status(true); }
    configure(next) {
      Object.assign(this.s, next);
      if ("latencyMs" in next) { const lat = Math.round(this.s.latencyMs * FS / 1000); this.station.setTxLatency(lat, lat); }
      if ("driveDb" in next) this.drive(next.driveDb);
      this.status(true);
    }
    stop() { this.tx.abort("worker stop"); }
  }

  // ---- Worker glue ------------------------------------------------------------
  const inWorker = typeof importScripts === "function" && typeof module !== "object";
  if (inWorker) {
    const Q = root.location.search;
    importScripts("js8-aud1.js" + Q, "vara-modem.js" + Q, "vara-host.js" + Q);
    let core = null, aud1 = null, timer = null;
    const post = (m, transfer) => transfer ? postMessage(m, transfer) : postMessage(m);
    root.onmessage = event => {
      const m = event.data || {};
      if (m.type === "start") {
        if (core) return;
        aud1 = new root.Js8Aud1Transport.Aud1WebSocketSession({
          url: `ws://${root.location.hostname}:${m.wsPort}/audiows?token=${encodeURIComponent(m.token)}`,
          WebSocketImpl: WebSocket, wallNow: () => Date.now()});
        core = new VaraCore({M: root.VaraModem, H: root.VaraHost, aud1, post,
          wallNow: () => Date.now(), monoNow: () => performance.now()}, m.settings);
        aud1.onSamples((samples, _rate, meta) => {
          try { core.onRx(samples, meta); } catch (e) { post({type: "error", reason: "modem", detail: e && e.stack || String(e)}); }
        });
        aud1.onStatus(s => {
          if (s.type === "tx-drained") aud1.complete(s.txId);
          post({type: "aud1", status: s.type, reason: s.reason || s.message || ""});
        });
        aud1.start();
        timer = setInterval(() => core.tick(), 50);
        post({type: "started"});
      } else if (!core) return;
      else if (m.type === "cmd") core.command(m.line);
      else if (m.type === "send") core.send(new Uint8Array(m.bytes));
      else if (m.type === "tune") core.tune(Boolean(m.on));
      else if (m.type === "drive") core.drive(Number(m.db));
      else if (m.type === "abort") core.abort();
      else if (m.type === "configure") core.configure(m.settings || {});
      else if (m.type === "stop") {
        core.stop(); clearInterval(timer); aud1.stop(); core = null;
        post({type: "stopped"});
      }
    };
  }

  return {VaraCore, TxStream, Upsampler, txPacket, DEFAULTS, PACKET};
});
