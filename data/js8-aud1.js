// PROTOTYPE — future versioned AUD1 RX source + asynchronous TX sink.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Aud1Transport = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const ULAW = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const u = ~i & 0xff;
    let sample = (((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7);
    sample -= 0x84;
    ULAW[i] = ((u & 0x80) ? -sample : sample) / 32768;
  }

  function parseAud1(wire) {
    const bytes = wire instanceof Uint8Array ? wire : new Uint8Array(wire);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 40 || String.fromCharCode(...bytes.subarray(0, 4)) !== "AUD1" ||
        bytes[4] !== 1 || view.getUint16(8, false) !== 40 ||
        view.getUint16(10, false) !== 0 || view.getUint32(36, false) !== bytes.length - 40)
      throw new Error("invalid AUD1 envelope");
    const kind = bytes[5];
    const flags = view.getUint16(6, false);
    const sampleRate = view.getUint32(20, false);
    if (![1, 2, 3, 4].includes(kind) || (flags & ~0x0f) || sampleRate === 0 ||
        ((kind === 2 || kind === 3) && (bytes.length - 40) % 2))
      throw new Error("unsupported AUD1 envelope");
    return {kind, flags, streamId:view.getUint32(12, false),
      sequence:view.getUint32(16, false), sampleRate,
      firstSample:view.getBigUint64(24, false), txId:view.getUint32(32, false),
      payload:bytes.subarray(40), wire:bytes};
  }

  // ---- TX_ULAW (AUD1 kind 4): TX at the radio link's own rate ---------------
  // Every modem builds its TX as PCM16 at 48 kHz; the firmware used to keep
  // every 6th sample (8 kHz link) or 3rd (16 kHz) and code it as uLaw. When the
  // hello offers TX_ULAW the session does exactly that here instead, so the
  // radio gets the very same bytes and the WiFi to the box carries 6-12x less
  // (docs/aud1-audio-websocket-protocol.md). The modems never notice.
  // Bit for bit the firmware's aud1Pcm16ToUlaw (wifilt.ino).
  function encodeUlaw(input) {
    let sample = input | 0;
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += 0x84;
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent -= 1, mask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  const ULAW_ENCODE = new Uint8Array(65536);
  for (let i = 0; i < 65536; i += 1) ULAW_ENCODE[i] = encodeUlaw(i - 32768);

  // "pcm16" forces the old wire for an A/B test: ?aud1tx=pcm16 on the page (a
  // worker sees it when the page passes it on in the worker's URL).
  function txWireOverride() {
    try {
      const search = globalThis.location && globalThis.location.search || "";
      return /[?&]aud1tx=pcm16\b/.test(search) ? "pcm16" : "auto";
    } catch { return "auto"; }
  }

  // What the hello lets this session send: TX_ULAW at the link's rate when it
  // is offered and 48 kHz is a whole multiple of it, otherwise TX_PCM16.
  function pickTxWire(hello, preference = "auto") {
    const pcm = {kind:3, sampleRate:48000, decim:1};
    if (preference === "pcm16" || !hello || !Array.isArray(hello.tx)) return pcm;
    const offer = hello.tx.find(t => t && t.kind === "TX_ULAW" &&
      (t.sampleRate === 8000 || t.sampleRate === 16000));
    return offer ? {kind:4, sampleRate:offer.sampleRate, decim:48000 / offer.sampleRate} : pcm;
  }

  // One TX_PCM16 wire (48 kHz) -> the same packet as TX_ULAW: header fields
  // kept, sample counts in the link's samples, every `decim`-th sample coded.
  function transcodeTxWire(wire, txWire) {
    const bytes = wire instanceof Uint8Array ? wire : new Uint8Array(wire);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 40 || bytes[5] !== 3 || view.getUint32(20, false) !== 48000)
      throw new Error("TX_ULAW: not a 48 kHz TX_PCM16 packet");
    const decim = txWire.decim, samples = (bytes.length - 40) / 2;
    const firstSample = view.getBigUint64(24, false);
    if (samples % decim || firstSample % BigInt(decim))
      throw new Error("TX_ULAW: packet not a whole number of link samples");
    const count = samples / decim, out = new Uint8Array(40 + count);
    out.set(bytes.subarray(0, 40));
    const outView = new DataView(out.buffer);
    out[5] = 4;
    outView.setUint32(20, txWire.sampleRate, false);
    outView.setBigUint64(24, firstSample / BigInt(decim), false);
    outView.setUint32(36, count, false);
    for (let i = 0; i < count; i += 1)
      out[40 + i] = ULAW_ENCODE[(view.getInt16(40 + i * decim * 2, true) + 32768)];
    return out;
  }

  class Aud1WebSocketSession {
    // `now` is monotonic (transport delay); `wallNow` is the UTC source the
    // firmware compares against. It must be the same clock the TX controller
    // used for `slotUtcMs`, because the firmware validates
    // `slotUtcMs - clientUtcMs` against a 100..35000 ms window.
    constructor({url, WebSocketImpl, reconnectMs = 1000, readyTimeoutMs = 3000,
                 pingIntervalMs = 3000, txWire = txWireOverride(),
                 now = () => performance.now(), wallNow = () => Date.now()}) {
      this.url = url; this.WebSocketImpl = WebSocketImpl;
      this.reconnectMs = reconnectMs; this.readyTimeoutMs = readyTimeoutMs; this.now = now;
      this.wallNow = wallNow; this.pingIntervalMs = pingIntervalMs;
      this.socket = null; this.running = false; this.hello = null; this.ptt = false;
      this.sampleCallback = null; this.statusCallback = null; this.packetCallback = null;
      this.controlCallback = null;
      this.pendingPrepare = new Map(); this.drained = new Set(); this.activeTxId = 0;
      this.txFault = null;
      // Diagnostic-only application-level RTT (native WS ping/pong is invisible to
      // page JS). lastPingRttMs is "page RTT" for this always-open socket, not
      // request+TCP-handshake HTTP latency -- see pollRadio's fetch timing for that.
      this.lastPingRttMs = null; this._pingTimer = null;
      // TX wire format, settled by each hello (pickTxWire); "pcm16" pins the old one.
      this.txWirePreference = txWire; this.txWire = pickTxWire(null);
    }

    onSamples(callback) { this.sampleCallback = callback; return this; }
    onPacket(callback) { this.packetCallback = callback; return this; }
    onStatus(callback) { this.statusCallback = callback; return this; }
    // Every control frame, verbatim, including the ones this class has no
    // opinion about. `tx-level` is the important one: it carries the credit
    // count that paces WSPR and the ALC reading the gain limiter acts on, and
    // neither is expressible as a status event. WSPR used to reach it through a
    // subclass of its own -- fine while one page needed it, two mechanisms for
    // one need once JS8LAN needs it too.
    onControl(callback) { this.controlCallback = callback; return this; }
    status(type, detail = {}) { if (this.statusCallback) this.statusCallback({type, ...detail}); }

    start() {
      if (this.running) return;
      this.running = true; this.connect();
    }

    connect() {
      // onclose may already have queued this reconnect when the owning page is
      // locked out and stop() runs. Never resurrect a stopped AUD1 session.
      if (!this.running) return;
      const socket = new this.WebSocketImpl(this.url);
      socket.binaryType = "arraybuffer";
      // A socket that closes without ever opening is the shape of "no audio
      // server" -- or of a firewall. audio-health.js (page context only; absent
      // in workers) works out which and says so; an ordinary drop after a
      // successful open is not its business.
      const health = typeof globalThis !== "undefined" ? globalThis.WifiltAudioHealth : null;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        if (health) health.reachable();
        this.status("open");
      };
      socket.onmessage = event => Promise.resolve(this.receive(event.data))
        .catch(error => {
          this.status("protocol-error", {message:error.message});
          try { socket.close(1002, "AUD1 protocol error"); } catch {}
        });
      socket.onerror = () => this.status("error");
      socket.onclose = () => {
        if (!opened && health && this.running) health.unreachable();
        if (this.socket !== socket) return;
        this.socket = null; this.hello = null; this.ptt = false;
        this.txFault = null; this.txWire = pickTxWire(null);
        if (this._pingTimer) { clearTimeout(this._pingTimer); this._pingTimer = null; }
        for (const pending of this.pendingPrepare.values()) pending.reject(new Error("WebSocket lost"));
        this.pendingPrepare.clear(); this.status("closed", {ptt:false});
        if (this.running) {
          if (this.reconnectMs <= 0) this.connect();
          else setTimeout(() => this.connect(), this.reconnectMs);
        }
      };
      this.socket = socket;
    }

    stop() {
      this.running = false;
      if (this.activeTxId) this.abort(this.activeTxId, "session stop");
      if (this.socket) this.socket.close();
      this.socket = null;
    }

    async receive(data) {
      if (typeof data === "string") return this.receiveControl(JSON.parse(data));
      const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
      const packet = parseAud1(buffer);
      if (packet.kind !== 1 && packet.kind !== 2) return;
      if (!this.hello) throw new Error("AUD1 packet received before hello");
      if (packet.streamId !== this.hello.streamId)
        throw new Error("AUD1 packet stream does not match hello");
      let samples;
      if (packet.kind === 1) {
        samples = new Float32Array(packet.payload.length);
        for (let i = 0; i < samples.length; i += 1) samples[i] = ULAW[packet.payload[i]];
      } else {
        samples = new Float32Array(packet.payload.length / 2);
        const view = new DataView(packet.payload.buffer, packet.payload.byteOffset,
                                  packet.payload.byteLength);
        for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
      }
      const metadata = {streamId:packet.streamId, sequence:packet.sequence,
        firstSample:packet.firstSample, flags:packet.flags, kind:packet.kind,
        sampleRate:packet.sampleRate, sampleCount:samples.length,
        arrivalMs:this.now(), aud1Wire:packet.wire};
      if (this.packetCallback) this.packetCallback(packet, metadata);
      if (this.sampleCallback) this.sampleCallback(samples, packet.sampleRate, metadata);
    }

    receiveControl(message) {
      if (message.type === "hello") {
        if (this.hello) throw new Error("duplicate AUD1 hello");
        if (message.protocol !== "AUD1" || message.version !== 1 ||
            !Number.isInteger(message.streamId) || message.streamId <= 0)
          throw new Error("unsupported audio WebSocket protocol");
        this.hello = message;
        this.txWire = pickTxWire(message, this.txWirePreference);
        this.status("ready", {streamId:message.streamId});
        this._schedulePing();
      } else if (message.type === "pong") {
        this.lastPingRttMs = this.now() - message.t;
        this.status("ping", {rttMs:this.lastPingRttMs});
      } else if (message.type === "tx-ready") {
        const pending = this.pendingPrepare.get(message.txId);
        if (pending) { clearTimeout(pending.timeout); this.pendingPrepare.delete(message.txId); pending.resolve(true); }
      } else if (message.type === "tx-drained") {
        this.drained.add(message.txId); this.ptt = false;
        this.status("tx-drained", {txId:message.txId, ptt:false});
      } else if (message.type === "tx-state") {
        this.ptt = Boolean(message.ptt); this.status("tx-state", {txId:message.txId, ptt:this.ptt});
      } else if (message.type === "tx-error") {
        const pending = this.pendingPrepare.get(message.txId);
        if (pending) { clearTimeout(pending.timeout); this.pendingPrepare.delete(message.txId); pending.reject(new Error(message.reason)); }
        this.txFault = {txId:message.txId, reason:message.reason || "remote TX error"};
        this.ptt = false; this.status("tx-error", {txId:message.txId, reason:message.reason, ptt:false});
      }
      // After the built-in handling, never instead of it: a listener must be
      // able to see tx-error and tx-drained too, and it must see them with this
      // object's own state already settled.
      if (this.controlCallback) this.controlCallback(message);
    }

    // The socket's own backlog. WSPR treats a growing figure as proof that the
    // link cannot carry the pace and gives up rather than transmitting a frame
    // that will arrive in pieces.
    get bufferedAmount() { return this.socket ? this.socket.bufferedAmount : 0; }

    sendControl(message) {
      if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN)
        throw new Error("audio WebSocket is not open");
      // tx.extend counts the modem's 48 kHz samples like everything else the
      // modems say; on a TX_ULAW wire the firmware counts the link's.
      if (message && message.type === "tx.extend" && this.txWire.kind === 4)
        message = {...message, samples:this.toWireSamples(message.samples)};
      this.socket.send(JSON.stringify(message));
    }

    // 48 kHz modem samples -> samples on the TX wire.
    toWireSamples(samples) {
      const decim = this.txWire.decim;
      if (!Number.isInteger(samples) || samples % decim)
        throw new Error(`TX length ${samples} is not a whole number of ${this.txWire.sampleRate} Hz samples`);
      return samples / decim;
    }

    // Self-paced ping loop, running for the lifetime of one hello -- stopped by
    // onclose, restarted by the next hello. A failed send (socket mid-reconnect)
    // just skips one sample; it is not on any critical path.
    _schedulePing() {
      if (this._pingTimer) clearTimeout(this._pingTimer);
      this._pingTimer = setTimeout(() => {
        try { this.sendControl({type:"ping", t:Math.round(this.now())}); } catch {}
        this._schedulePing();
      }, this.pingIntervalMs);
    }

    prepare(txId, metadata) {
      if (!this.hello) return Promise.reject(new Error("AUD1 hello not received"));
      if (!metadata || !Number.isFinite(metadata.slotUtcMs) ||
          !Number.isInteger(metadata.prebufferSamples) || metadata.prebufferSamples <= 0 ||
          metadata.packetMs !== 20)
        return Promise.reject(new Error("TX prepare requires slot and 20 ms pacing"));
      // The wire is fixed for the whole transmission: a later hello (reconnect)
      // ends it anyway, with the socket.
      const wire = this.txWire, ulaw = wire.kind === 4;
      let samples = metadata.samples, prebufferSamples = metadata.prebufferSamples;
      if (ulaw) {
        // The length must be exact (LAST is checked against it); the prebuffer is
        // only a threshold, rounded up to whole link samples.
        try { samples = this.toWireSamples(samples); } catch (error) { return Promise.reject(error); }
        prebufferSamples = Math.ceil(prebufferSamples / wire.decim);
      }
      this.activeTxId = txId; this.drained.delete(txId); this.txFault = null;
      // `alcFast` asks the firmware for the calibration metering rotation (ALC
      // at 2 Hz instead of 1 Hz) for the duration of this transmission only.
      // Deliberately explicit rather than inferred from `mode`: a beacon slot
      // and a calibration carrier are the same thing on the wire.
      this.sendControl({type:"tx.prepare", txId,
        ...(ulaw ? {kind:"TX_ULAW"} : {}), sampleRate:wire.sampleRate,
        samples, packets:metadata.packets, mode:metadata.mode,
        toneHz:metadata.toneHz, slotUtcMs:metadata.slotUtcMs,
        clientUtcMs:this.wallNow(), alcFast:Boolean(metadata.alcFast),
        prebufferSamples, packetMs:metadata.packetMs,
        // RTTY only: the message itself, which the firmware publishes on
        // TrxNet's /rtty-tx once it accepts this prepare (rtty_stream.h).
        ...(typeof metadata.rttyText === "string" ? {rttyText:metadata.rttyText} : {}),
        // JTTY the same, for /jtty-tx; tx.extend carries each later segment.
        ...(typeof metadata.jttyText === "string" ? {jttyText:metadata.jttyText} : {})});
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingPrepare.delete(txId); this.abort(txId, "tx-ready timeout");
          reject(new Error("tx-ready timeout"));
        }, this.readyTimeoutMs);
        this.pendingPrepare.set(txId, {resolve, reject, timeout});
      });
    }

    begin(txId) { this.activeTxId = txId; this.status("tx-stream", {txId}); }
    write(wire) {
      if (this.txFault && this.txFault.txId === this.activeTxId)
        throw new Error(this.txFault.reason);
      if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN)
        throw new Error("audio WebSocket lost during TX");
      this.socket.send(this.txWire.kind === 4 ? transcodeTxWire(wire, this.txWire) : wire);
    }
    end(txId) { this.status("tx-audio-end", {txId}); }
    isDrained(txId) { return this.drained.has(txId); }
    complete(txId) { this.activeTxId = 0; this.drained.delete(txId); this.txFault = null; this.ptt = false; }
    abort(txId, reason) {
      try { this.sendControl({type:"tx.abort", txId, reason}); } catch {}
      this.activeTxId = 0; this.drained.delete(txId); this.txFault = null; this.ptt = false;
      this.status("tx-abort", {txId, reason, ptt:false});
    }
  }

  return {Aud1WebSocketSession, parseAud1, encodeUlaw, pickTxWire, transcodeTxWire};
});
