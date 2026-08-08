// WSPR transmission driver: feeds one 110.592 s frame into the firmware's AUD1
// TX path. See docs/wspr-majak-implementace.md chapter 5.
//
// The hard part is not generating audio, it is pacing. The firmware ring holds
// AUD1_TX_RING_SIZE = 12288 bytes of 8 kHz mu-law, which is 1.536 s. A WSPR
// transmission lasts 110.592 s, so the browser must keep that ring fed for 72
// consecutive ring-fulls without a single gap longer than 1.5 s -- from a tab
// that may be in the background, where setTimeout is clamped to 1/s and worse.
//
// So the clock is NOT a timer. It is the firmware's own tx-level message, which
// arrives every 200 ms while streaming and carries a CUMULATIVE count of the
// mu-law bytes the radio has already consumed. Incoming WebSocket messages are
// not throttled in background tabs, and
//
//     ringEstimate = sentUlaw - lastKnownConsumed
//
// is always an UPPER bound on the ring level, because `consumed` can only be
// stale, never ahead. Overflow is therefore impossible by construction, and the
// feed self-clocks to real time: 200 ms of drain (1600 B) opens room for exactly
// ten packets.

(function (root, factory) {
  const value = factory(typeof module === "object" && module.exports
    ? require("./wspr-core.js") : root.WsprCore);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.WsprTx = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (WsprCore) {
  if (!WsprCore) throw new Error("WsprTx requires WsprCore");

  const RING_CAPACITY_BYTES = 12288;      // AUD1_TX_RING_SIZE
  const PACKET_SAMPLES = 960;             // 20 ms at 48 kHz
  const PACKET_ULAW_BYTES = PACKET_SAMPLES / 6;   // 160
  // 65 % of the ring. Leaves ~4.3 kB (0.54 s) of headroom for a burst, while
  // still holding a full second of audio ahead of the radio.
  const TARGET_FILL_BYTES = 8000;
  // The pre-key burst. Nothing drains before PTT, so this is bounded by the ring
  // itself; 1350 ms mirrors js8-tx.js and stays under its TX_RING_LIMIT_MS.
  const STREAM_LEAD_MS = 1350;
  const PREBUFFER_MS = 1000;              // what tx.prepare declares
  const PREPARE_LEAD_MS = 10000;          // inside the firmware's 100..35000 window
  // Liveness is a hard gate at keying even for unattended:false, and only an
  // AUD1 frame refreshes it -- the HTTP session ping does not. Keying happens
  // ~10 s after tx.prepare, so without this the radio would never key.
  const PING_INTERVAL_MS = 2000;
  const BUFFERED_LIMIT_BYTES = 200000;    // TCP backpressure means we are losing

  const STATES = ["idle", "preparing", "waiting-slot", "prebuffering",
                  "streaming", "draining", "completed", "failed"];

  class WsprTxError extends Error {}

  class WsprTx {
    constructor(options = {}) {
      this.sink = options.sink;
      if (!this.sink) throw new WsprTxError("WsprTx requires an AUD1 sink");
      this.wallNow = options.wallNow || (() => Date.now());
      // A number or a getter. There is no default any more: the identity belongs
      // to the firmware's hello, and inventing one only produces transmissions
      // the radio aborts on arrival.
      this.streamId = typeof options.streamId === "function"
        ? options.streamId : (options.streamId ?? 0) >>> 0;
      this.ringCapacityBytes = options.ringCapacityBytes ?? RING_CAPACITY_BYTES;
      this.targetFillBytes = options.targetFillBytes ?? TARGET_FILL_BYTES;
      this.streamLeadMs = options.streamLeadMs ?? STREAM_LEAD_MS;
      this.prebufferMs = options.prebufferMs ?? PREBUFFER_MS;
      this.prepareLeadMs = options.prepareLeadMs ?? PREPARE_LEAD_MS;
      this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
      this.bufferedLimitBytes = options.bufferedLimitBytes ?? BUFFERED_LIMIT_BYTES;
      this.nextTxId = options.firstTxId ?? 1;
      this.onEvent = options.onEvent || (() => {});
      this.reset();
    }

    reset() {
      this.state = "idle";
      this.stream = null;
      this.txId = 0;
      this.slotUtcMs = 0;
      this.prebufferStartUtcMs = 0;
      this.error = "";
      this.sentSamples = 0;
      this.sentPackets = 0;
      this.consumedUlaw = 0;      // last value the firmware reported
      this.lastLevel = null;
      this.audioEnded = false;
      this.ptt = false;
      this.nextPingUtcMs = 0;
      this.peakRingEstimate = 0;
      this.minRingEstimateWhileStreaming = Infinity;
    }

    get totalSamples() { return WsprCore.SIGNAL_SAMPLES; }
    get totalPackets() { return Math.ceil(WsprCore.SIGNAL_SAMPLES / PACKET_SAMPLES); }
    get sentUlaw() { return Math.floor(this.sentSamples / 6); }
    // Upper bound, deliberately: `consumed` may lag but never leads, so acting
    // on this can only ever under-fill the ring, never overflow it.
    get ringEstimate() { return this.sentUlaw - this.consumedUlaw; }

    snapshot() {
      return {state: this.state, txId: this.txId, ptt: this.ptt,
              sentSamples: this.sentSamples, sentPackets: this.sentPackets,
              consumedUlaw: this.consumedUlaw, ringEstimate: this.ringEstimate,
              peakRingEstimate: this.peakRingEstimate,
              minRingEstimateWhileStreaming: this.minRingEstimateWhileStreaming,
              audioEnded: this.audioEnded, error: this.error};
    }

    emit(type, detail = {}) { this.onEvent({type, at: this.wallNow(), ...detail}); }

    fail(reason) {
      if (this.state === "failed") return;
      const wasKeyed = this.ptt;
      this.state = "failed";
      this.error = String(reason);
      // Distinguishing these two is the whole point of the red/orange split in
      // the activity grid: one missed a slot, the other put a truncated signal
      // on the air.
      this.emit("failed", {reason: this.error, afterKeying: wasKeyed});
      // Only ever about OUR transmission. The firmware reads a tx.abort with
      // txId 0 as "abort whatever is in flight" (aud1HandleControl: `!txId ||
      // txId == aud1TxId`), so a driver that never queued anything -- the
      // beacon's, while the calibration is keying on the same socket -- would
      // kill somebody else's carrier by reporting its own idle fault.
      if (this.txId) { try { this.sink.abort(this.txId, this.error); } catch (_error) {} }
      this.ptt = false;
    }

    // ---- lifecycle ---------------------------------------------------------

    // Arms one transmission for `slotUtcMs` (one second past an even UTC
    // minute). Call at least prepareLeadMs before the slot.
    queue({symbols, slotUtcMs, baseHz = 1500, amplitude = 0.25,
           leadMs = this.prepareLeadMs, alcFast = false},
          nowUtcMs = this.wallNow()) {
      if (!["idle", "completed", "failed"].includes(this.state))
        throw new WsprTxError(`cannot queue while ${this.state}`);
      const delayMs = slotUtcMs - nowUtcMs;
      // The firmware validates 100 < delayMs < 35000 in aud1HandleControl and
      // aborts otherwise, so refuse locally rather than burning a slot.
      // `leadMs` is per-call because TUNE cannot wait the beacon's ten seconds
      // before a tone appears; the prebuffer only needs streamLeadMs.
      if (!(delayMs > leadMs * 0.5 && delayMs < 35000))
        throw new WsprTxError(`slot is ${delayMs} ms away, outside the usable window`);

      // The firmware refuses any TX packet whose streamId is not the one it
      // minted in `hello` (aud1AcceptTxPacket), and it mints a new one on every
      // WebSocket upgrade. So it has to be resolved here, per transmission, not
      // frozen at construction -- hence the callable form.
      const streamId = (typeof this.streamId === "function"
        ? this.streamId() : this.streamId) >>> 0;
      if (!streamId)
        throw new WsprTxError("the audio link has no stream identity yet");

      this.reset();
      this.txId = this.nextTxId++;
      this.slotUtcMs = slotUtcMs;
      this.prebufferStartUtcMs = slotUtcMs - this.streamLeadMs;
      this.stream = new WsprCore.WsprStream(symbols,
        {baseHz, amplitude, streamId, txId: this.txId,
         samplesPerPacket: PACKET_SAMPLES});
      this.state = "preparing";
      this.nextPingUtcMs = nowUtcMs + this.pingIntervalMs;

      // No `unattended` field: Aud1WebSocketSession.prepare builds the tx.prepare
      // JSON itself and does not forward extras, so passing one would only look
      // like it did something. The firmware defaults the flag to false
      // (extractJsonBool(json, "unattended", false)) and the flag can only ever
      // restrict, never unlock -- so an absent field is exactly decision 9's
      // "operator-initiated", and tools/wspr-browser-smoke.js pins that.
      // `alcFast` is forwarded rather than defaulted here: it asks the firmware
      // to poll ALC at 2 Hz for this transmission, which only the gain
      // calibration wants and which the firmware clears again the moment the
      // transmission ends, however it ends.
      const ready = this.sink.prepare(this.txId, {
        samples: this.totalSamples, packets: this.totalPackets,
        slotUtcMs, prebufferSamples: this.prebufferMs * 48, packetMs: 20,
        mode: "WSPR", toneHz: baseHz, alcFast});
      this.emit("prepared", {txId: this.txId, slotUtcMs, delayMs});
      if (ready && typeof ready.then === "function")
        return ready.then(value => {
          if (!value) throw new WsprTxError("sink did not become ready");
          if (this.state === "preparing") this.state = "waiting-slot";
          return this.snapshot();
        }).catch(error => { this.fail(error.message || error); return this.snapshot(); });
      if (!ready) { this.fail("sink did not become ready"); return this.snapshot(); }
      this.state = "waiting-slot";
      return this.snapshot();
    }

    // The firmware confirms the prepare out of band on the real socket.
    markReady() { if (this.state === "preparing") this.state = "waiting-slot"; }

    // ---- inbound control ---------------------------------------------------

    // Every frame the firmware sends carries the txId it is about (tx-ready,
    // tx-state, tx-level, tx-drained and tx-error alike), and a frame about
    // another transmission is not news about this one. It used to be read as if
    // it were, which the calibration turns from a theoretical race into a
    // routine one: it keys a carrier per cell and ends every one of them with a
    // tx.abort, and the firmware answers that abort with a tx-error. Let that
    // answer arrive late -- the LittleFS write of /txgain.json between cells is
    // enough -- and the PREVIOUS cell's acknowledgement failed the NEXT cell,
    // which reached the operator as "client abort: calibration finished" on a
    // cell that had barely started.
    aboutUs(message) {
      const txId = Number(message.txId);
      if (!Number.isFinite(txId) || !txId) return true;   // no id: cannot rule it out
      return txId === this.txId;
    }

    onControl(message, nowUtcMs = this.wallNow()) {
      if (!message || typeof message !== "object") return this.snapshot();
      switch (message.type) {
        case "tx-ready":
          if (this.aboutUs(message)) this.markReady();
          break;
        case "tx-state":
          if (!this.aboutUs(message)) break;
          this.ptt = Boolean(message.ptt);
          if (this.ptt && this.state === "prebuffering") {
            this.state = "streaming";
            this.emit("keyed", {txId: this.txId});
          }
          break;
        case "tx-level":
          if (message.txId === this.txId && Number.isFinite(message.consumed)) {
            // Monotonic by construction in the firmware; guard anyway so a
            // reordered frame cannot make the estimate go backwards and let us
            // over-fill.
            this.consumedUlaw = Math.max(this.consumedUlaw, Number(message.consumed));
            this.lastLevel = message;
            if (this.state === "streaming")
              this.minRingEstimateWhileStreaming =
                Math.min(this.minRingEstimateWhileStreaming, this.ringEstimate);
          }
          break;
        case "tx-drained":
          if (message.txId === this.txId) {
            this.ptt = false;
            this.state = "completed";
            this.emit("completed", {txId: this.txId, sentSamples: this.sentSamples});
          }
          return this.snapshot();
        case "tx-error":
          // Nothing armed means nothing to fault. An idle driver that "fails"
          // still emits, still gets read as a fault by the page, and -- before
          // the guard in fail() -- aborted whatever the other driver was doing.
          if (!this.aboutUs(message) ||
              ["idle", "completed", "failed"].includes(this.state))
            return this.snapshot();
          this.fail(message.reason || "remote TX error");
          return this.snapshot();
        default:
          break;
      }
      // Every inbound message is also a scheduling opportunity, and the reason
      // this survives timer throttling.
      return this.tick(nowUtcMs);
    }

    // ---- the pump ----------------------------------------------------------

    tick(nowUtcMs = this.wallNow()) {
      if (["idle", "completed", "failed"].includes(this.state)) {
        this.keepAlive(nowUtcMs);
        return this.snapshot();
      }
      this.keepAlive(nowUtcMs);

      if (this.state === "waiting-slot" && nowUtcMs >= this.prebufferStartUtcMs) {
        this.state = "prebuffering";
        this.emit("prebuffering", {txId: this.txId});
      }
      if (this.state === "prebuffering" || this.state === "streaming") {
        this.pump(nowUtcMs);
        // The firmware keys on its own schedule; if the confirmation has not
        // arrived well past the slot, something is wrong and a silent wait
        // would burn the whole transmission.
        if (this.state === "prebuffering" && nowUtcMs > this.slotUtcMs + 500 && !this.ptt)
          this.fail("PTT confirmation did not arrive");
      }
      if (this.state === "streaming" && this.audioEnded &&
          nowUtcMs > this.slotUtcMs + WsprCore.DURATION_S * 1000 + 5000)
        this.fail("drain watchdog");
      return this.snapshot();
    }

    keepAlive(nowUtcMs) {
      if (nowUtcMs < this.nextPingUtcMs) return;
      this.nextPingUtcMs = nowUtcMs + this.pingIntervalMs;
      // Unknown control types are ignored by aud1HandleControl, so this is a
      // no-op that refreshes both the liveness dead-man and the session lease.
      //
      // Failures are swallowed on purpose. The ping is insurance against an idle
      // socket, never a critical path: the AUD1 session reconnects on its own, and
      // between transmissions the socket may legitimately be mid-reconnect. A link
      // that is genuinely dead is caught by write() during the transmission, which
      // is where failing actually means something.
      try { this.sink.sendControl({type: "wspr.ping", txId: this.txId}); }
      catch (_error) { this.pingFailures = (this.pingFailures || 0) + 1; }
    }

    // How many packets may go out right now without any risk of overflow.
    creditPackets() {
      if (this.state === "prebuffering") {
        // Nothing drains before PTT, so the pre-key span is bounded by the ring
        // rather than by credit.
        const wanted = Math.floor(this.streamLeadMs * 48 / PACKET_SAMPLES);
        return Math.max(0, Math.min(wanted - this.sentPackets,
          Math.floor((this.ringCapacityBytes - this.ringEstimate) / PACKET_ULAW_BYTES)));
      }
      return Math.max(0, Math.floor(
        (this.targetFillBytes - this.ringEstimate) / PACKET_ULAW_BYTES));
    }

    pump(nowUtcMs) {
      if (!this.stream || this.audioEnded) return;
      let budget = this.creditPackets();
      while (budget-- > 0 && !this.audioEnded) {
        const buffered = Number(this.sink.bufferedAmount ?? 0);
        if (buffered > this.bufferedLimitBytes) {
          this.fail(`socket backlog ${buffered} B: the link cannot keep up`);
          return;
        }
        const packet = this.stream.nextPacket();
        if (!packet) { this.audioEnded = true; break; }
        try { this.sink.write(packet.wire, nowUtcMs); }
        catch (error) { this.fail(error.message || error); return; }
        this.sentSamples += packet.samples;
        this.sentPackets += 1;
        this.peakRingEstimate = Math.max(this.peakRingEstimate, this.ringEstimate);
        if (this.ringEstimate > this.ringCapacityBytes) {
          // Unreachable while creditPackets() is honoured; kept because the
          // firmware's response to overflow is to abort mid-transmission.
          this.fail(`ring estimate ${this.ringEstimate} B exceeds capacity`);
          return;
        }
        if (packet.last) {
          this.audioEnded = true;
          try { this.sink.end(this.txId); } catch (_error) {}
          this.emit("audio-complete", {txId: this.txId, packets: this.sentPackets});
        }
      }
    }
  }

  return {WsprTx, WsprTxError, RING_CAPACITY_BYTES, PACKET_SAMPLES,
          PACKET_ULAW_BYTES, TARGET_FILL_BYTES, STREAM_LEAD_MS, PREBUFFER_MS,
          PREPARE_LEAD_MS, PING_INTERVAL_MS, STATES};
});
