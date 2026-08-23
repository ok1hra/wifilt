// Runs inside a real browser Worker (classic worker, importScripts -- the
// same loading style data/js8-decoder.js and friends use), loaded by
// ../browser-worker-smoke.js under headless Chrome. This is the first check
// that mercury-host.wasm works OUTSIDE Node at all: every prior check in
// this prototype ran under Node's ENVIRONMENT=node build, which needed its
// own fetch-vs-ENVIRONMENT_IS_NODE workaround (see run-loopback.js) that is
// specific to Node and doesn't apply to a real browser. E2 needs this
// module running in an actual Worker (docs/mercury-implementace.md ch.4.2),
// so this is where that gets proven before any real page exists.
//
// Reuses run-host-bench.js's approach almost verbatim (host_modem_relay,
// the one-shot in-WASM encode+decode round trip) rather than the streaming
// host_tx_start/host_rx_push API -- proving the FSM+modem combination works
// in a Worker is the goal here, not re-deriving the native-mercury bridge.
importScripts("mercury-host.js");

const EV = { APP_LISTEN: 0, APP_CONNECT: 2, APP_DATA_READY: 4 };
const CONN_STATE = ["DISCONNECTED", "LISTENING", "CALLING", "ACCEPTING", "CONNECTED", "DISCONNECTING"];
const checks = [];
function check(name, pass, detail = "") { checks.push([name, pass, detail]); }

createMercuryHost().then((m) => {
  try {
    const cw = (name, ret, args) => m.cwrap(name, ret, args);
    const init = cw("host_init", null, []);
    const epCreate = cw("host_endpoint_create", "number", ["string", "string"]);
    const dispatchSimple = cw("host_dispatch_simple", null, ["number", "number"]);
    const connect = cw("host_connect", null, ["number", "string"]);
    const queueTx = cw("host_queue_tx", null, ["number", "number", "number"]);
    const delivered = cw("host_delivered", "number", ["number", "number", "number"]);
    const connState = cw("host_conn_state", "number", ["number"]);
    const takeOutframe = cw("host_take_outframe", "number", ["number"]);
    const ofLen = cw("host_of_len", "number", []);
    const ofMode = cw("host_of_mode", "number", []);
    const ofBuf = cw("host_of_buf", "number", []);
    const timeoutMs = cw("host_timeout_ms", "number", ["number", "number"]);
    const fireDeadline = cw("host_fire_deadline_if_due", "number", ["number", "number"]);
    const clockNow = cw("host_clock_now_ms", "number", []);
    const clockAdvance = cw("host_clock_advance_to_ms", null, ["number"]);
    const deliver = cw("host_deliver", "number", ["number", "number", "number", "number"]);
    const relayOutPtr = cw("host_relay_out_ptr", "number", []);
    const modemRelay = cw("host_modem_relay", "number", ["number", "number", "number"]);
    const lastRelaySamples = cw("host_last_relay_samples", "number", []);

    check("wasm module instantiated in a real Worker", true);

    init();
    const A = epCreate("OK1HRA", "OK2XYZ");
    const B = epCreate("OK2XYZ", "OK1HRA");
    const INT_MAX = 2147483647;
    const pending = [];

    function drainOutframesFrom(sender, peer, now) {
      while (takeOutframe(sender)) {
        const len = ofLen(), mode = ofMode(), framePtr = ofBuf();
        const decodedLen = modemRelay(mode, framePtr, len);
        const samples = lastRelaySamples();
        const airtimeMs = Math.round(samples / 8);
        pending.push({ fireAt: now + airtimeMs, kind: "TX_COMPLETE", target: sender });
        if (decodedLen === len) {
          const outPtr = relayOutPtr();
          const bytes = m.HEAPU8.slice(outPtr, outPtr + decodedLen);
          pending.push({ fireAt: now + airtimeMs + 100, kind: "RX", target: peer, bytes, len: decodedLen });
        }
      }
    }
    function drainAll(now) { drainOutframesFrom(A, B, now); drainOutframesFrom(B, A, now); }
    function firePending(p) {
      if (p.kind === "TX_COMPLETE") { dispatchSimple(p.target, 22); return; }
      const ptr = m._malloc(p.len);
      m.HEAPU8.set(p.bytes, ptr);
      deliver(p.target, ptr, p.len, 12.0);
      m._free(ptr);
    }
    function runUntilIdle(maxMs) {
      const start = clockNow();
      for (;;) {
        const now = clockNow();
        drainAll(now);
        const ta = timeoutMs(A, now), tb = timeoutMs(B, now);
        if (pending.length === 0 && ta === INT_MAX && tb === INT_MAX) break;
        let next = Infinity;
        for (const p of pending) if (p.fireAt < next) next = p.fireAt;
        if (ta !== INT_MAX) next = Math.min(next, now + ta);
        if (tb !== INT_MAX) next = Math.min(next, now + tb);
        if (next === Infinity || next > start + maxMs) { clockAdvance(start + maxMs); break; }
        clockAdvance(next);
        const now2 = clockNow();
        fireDeadline(A, now2); drainAll(now2);
        fireDeadline(B, now2); drainAll(now2);
        for (let i = 0; i < pending.length; ) {
          if (pending[i].fireAt <= now2) {
            const p = pending.splice(i, 1)[0];
            firePending(p);
            drainAll(clockNow());
            i = 0;
          } else i++;
        }
      }
      return clockNow() - start;
    }

    dispatchSimple(B, EV.APP_LISTEN);
    connect(A, "OK2XYZ");
    runUntilIdle(60000);
    const stateA = CONN_STATE[connState(A)], stateB = CONN_STATE[connState(B)];
    check("handshake reached CONNECTED/CONNECTED", stateA === "CONNECTED" && stateB === "CONNECTED",
      `A=${stateA} B=${stateB}`);

    const blob = new Uint8Array(300);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 13 + 5) & 0xff;
    const blobPtr = m._malloc(blob.length);
    m.HEAPU8.set(blob, blobPtr);
    queueTx(A, blobPtr, blob.length);
    m._free(blobPtr);
    dispatchSimple(A, EV.APP_DATA_READY);
    runUntilIdle(120000);

    const outPtr = m._malloc(blob.length + 64);
    const gotLen = delivered(B, outPtr, blob.length + 64);
    const got = m.HEAPU8.slice(outPtr, outPtr + gotLen);
    m._free(outPtr);
    let same = gotLen === blob.length;
    if (same) for (let i = 0; i < blob.length; i++) if (got[i] !== blob[i]) { same = false; break; }
    check("300B transfer delivered byte-exact inside the Worker", same, `sent=${blob.length} got=${gotLen}`);
  } catch (e) {
    check("no exception", false, e && e.stack || String(e));
  }
  postMessage({ checks });
}).catch((e) => {
  postMessage({ checks: [["wasm module instantiated in a real Worker", false, e && e.stack || String(e)]] });
});
