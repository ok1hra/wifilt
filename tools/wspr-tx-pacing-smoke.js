#!/usr/bin/env node
"use strict";

// Test layer 3 of docs/wspr-majak-implementace.md: does the browser keep the
// firmware's 1.536 s queue fed for the whole 110.592 s transmission?
//
// This is a co-simulation, not a model. The browser half is the real
// data/wspr-tx.js. The firmware half is a child process built from
// prototype/js8-core-prototype/firmware/wspr_tx_pacing_smoke.cpp, which compiles
// aud1AcceptTxPacket, aud1TxTick and every abort condition VERBATIM out of
// IC-705_Interface.ino, plus the real IcomLanAudioTx Module behind a native
// Adapter. The credit loop closes through the firmware's tx-level messages.
//
// What it measures, beyond "did it abort":
//
//   * ring occupancy across the whole transmission (never 0, never over 12288),
//   * radio starvation -- how far the mu-law actually handed to the radio falls
//     behind real time, which for WSPR is what warps symbol timing,
//   * PTT keyed exactly once, at the slot, and released after the last sample,
//   * uninterrupted radio playout under cooperative-loop stalls of 50/150/400 ms.
//
// Usage: wspr-tx-pacing-smoke.js <path to compiled harness>

const {spawn} = require("child_process");
const path = require("path");
const WsprCore = require("../data/wspr-core.js");
const {WsprTx} = require("../data/wspr-tx.js");

const HARNESS = process.argv[2];
if (!HARNESS) {
  console.error("usage: wspr-tx-pacing-smoke.js <harness binary>");
  process.exit(2);
}

const BASE_UTC = Date.UTC(2026, 6, 26, 12, 4, 0, 0);   // an even UTC minute
const SLOT_UTC = BASE_UTC + 1000;                       // WSPR starts at +1 s
const START_UTC = SLOT_UTC - 12000;                     // 12 s of lead-in
const FIRMWARE_BASE_MS = 100000;                        // arbitrary millis() origin
const LOOP_STEP_MS = 10;                                // cooperative loop cadence
const ULAW_BYTES_PER_MS = 8;                            // 8 kHz, one byte per sample

const toFirmwareMs = utcMs => FIRMWARE_BASE_MS + (utcMs - START_UTC);

let failures = 0, checks = 0;
function check(name, actual, expected) {
  checks++;
  if (actual === expected) return true;
  failures++;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
  return false;
}
function ok(name, condition, detail = "") {
  return check(name + (detail ? ` (${detail})` : ""), Boolean(condition), true);
}

// ---- request/response transport over the child's stdio ---------------------

class Harness {
  constructor(binary) {
    this.child = spawn(binary, [], {stdio: ["pipe", "pipe", "inherit"]});
    this.lines = [];
    this.waiters = [];
    this.buffer = "";
    this.child.stdout.on("data", chunk => {
      this.buffer += chunk;
      for (;;) {
        const at = this.buffer.indexOf("\n");
        if (at < 0) break;
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        this.lines.push(line);
        // Every command is answered by exactly one RING line, which is what
        // makes the exchange synchronous and the simulation deterministic.
        if (line.startsWith("RING ") || line.startsWith("HELLO ")) {
          const waiter = this.waiters.shift();
          if (waiter) waiter(this.take());
        }
      }
    });
  }
  take() { const lines = this.lines; this.lines = []; return lines; }
  hello() { return new Promise(resolve => this.waiters.push(resolve)); }
  send(line) {
    return new Promise(resolve => {
      this.waiters.push(resolve);
      this.child.stdin.write(line + "\n");
    });
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}

// ---- one full transmission -------------------------------------------------

// `stalls` is a list of {atMs, forMs} describing cooperative-loop freezes,
// measured from the slot. During a stall no NOW command is issued, exactly as a
// blocking flash write or DNS lookup would starve the sketch's loop.
async function transmit({stalls = [], keepAlive = true, browserTickMs = 0, label}) {
  const harness = new Harness(HARNESS);
  const [helloLine] = await harness.hello();
  const [, streamIdText] = helloLine.split(" ");
  const streamId = Number(streamIdText) >>> 0;

  const frame = WsprCore.encode({callsign: "OK1HRA", locator: "JN79", powerDbm: 37});
  const observed = {
    pttEvents: [], aborts: [], levels: 0, preKeyLevels: 0, radioBytes: 0,
    ringMin: Infinity, ringMax: 0, ringMinWhileKeyed: Infinity,
    worstStarvationMs: 0, keyedAtUtc: null, drainedAtUtc: null,
    lastRadioUtc: null, browserTicks: 0,
  };
  let pending = [];          // control messages parsed out of the child's output

  function absorb(lines) {
    for (const line of lines) {
      if (line.startsWith("TX ")) {
        const message = JSON.parse(line.slice(3));
        if (message.type === "tx-level") {
          observed.levels++;
          if (!observed.pttEvents.includes(true)) observed.preKeyLevels++;
          // The reading the gain limiter and the calibration act on. Recorded
          // here because the field is the entire interface between the radio's
          // ALC meter and the browser: if it reports zero forever the search
          // blames the radio for a reply it did in fact send.
          if (Object.prototype.hasOwnProperty.call(message, "alcSeq"))
            observed.alc = {raw: message.alc, seq: message.alcSeq};
        }
        if (message.type === "tx-error") observed.aborts.push(message.reason);
        pending.push(message);
      } else if (line.startsWith("PTT ")) {
        observed.pttEvents.push(line.slice(4) === "1");
      } else if (line.startsWith("RADIO ")) {
        observed.radioBytes += Number(line.slice(6));
        observed.lastRadioUtc = currentUtc;
      } else if (line.startsWith("RING ")) {
        const [, used] = line.split(" ");
        observed.ringMin = Math.min(observed.ringMin, Number(used));
        observed.ringMax = Math.max(observed.ringMax, Number(used));
      }
    }
  }

  // A sink shaped like Aud1WebSocketSession, but every call crosses into the
  // real firmware code instead of a socket.
  const queue = [];
  const sink = {
    bufferedAmount: 0,
    prepare(txId, metadata) {
      queue.push(["CTRL", JSON.stringify({
        type: "tx.prepare", txId, sampleRate: 48000,
        samples: metadata.samples, packets: metadata.packets,
        slotUtcMs: metadata.slotUtcMs, clientUtcMs: currentUtc,
        prebufferSamples: metadata.prebufferSamples, packetMs: metadata.packetMs,
        unattended: false})]);
      return true;   // tx-ready is observed asynchronously, like the real socket
    },
    write(wire) { queue.push(["PACKET", Buffer.from(wire).toString("hex")]); },
    sendControl(message) {
      if (message.type === "wspr.ping" && !keepAlive) return;
      queue.push(["CTRL", JSON.stringify(message)]);
    },
    end() {}, abort() {}, isDrained() { return false; },
  };

  let currentUtc = START_UTC;
  const tx = new WsprTx({sink, streamId, wallNow: () => currentUtc});

  async function drainQueue() {
    while (queue.length) {
      const [verb, payload] = queue.shift();
      absorb(await harness.send(`${verb} ${payload}`));
    }
  }

  // Establish millis() BEFORE the first control frame. aud1HandleControl derives
  // aud1TxTargetMs from millis() + delayMs, so a tx.prepare that arrives while
  // the harness clock still reads zero schedules the slot in the distant past
  // and the firmware correctly reports "TX prebuffer missed slot".
  absorb(await harness.send(`TICK ${toFirmwareMs(currentUtc)} 1`));

  tx.queue({symbols: frame.symbols, slotUtcMs: SLOT_UTC, baseHz: 1500,
            amplitude: 0.25}, currentUtc);
  await drainQueue();
  for (const message of pending.splice(0)) tx.onControl(message, currentUtc);
  await drainQueue();

  // A LAN radio on TRX1 answers the ALC meter into the shared CAT globals, never
  // into the per-slot snapshot (lanCivFrameRoute returns early for slot 0). The
  // accessors that choose between the two are lifted from the sketch, so this
  // asserts the production choice: seed the globals, then require the next
  // tx-level to carry them.
  absorb(await harness.send("ALC 37 4"));

  let lastBrowserTick = -Infinity;
  const endUtc = SLOT_UTC + WsprCore.DURATION_S * 1000 + 4000;
  const stallList = stalls.map(stall => ({from: SLOT_UTC + stall.atMs,
                                         to: SLOT_UTC + stall.atMs + stall.forMs}));

  while (currentUtc <= endUtc) {
    const stalled = stallList.some(stall => currentUtc >= stall.from && currentUtc < stall.to);

    // The browser is not the thing that stalls; the ESP32 loop is. So the driver
    // keeps producing packets and the firmware simply does not get ticked.
    // browserTickMs models a throttled background tab: the timer fires rarely and
    // the credit loop has to run off inbound tx-level messages alone.
    if (!browserTickMs || currentUtc - lastBrowserTick >= browserTickMs) {
      lastBrowserTick = currentUtc;
      observed.browserTicks += 1;
      tx.tick(currentUtc);
    }
    await drainQueue();
    for (const message of pending.splice(0)) {
      observed.browserTicks += 1;
      tx.onControl(message, currentUtc);
      await drainQueue();
    }

    // The audio owner advances even while injected HTTP/flash work freezes the
    // cooperative sketch loop.
    absorb(await harness.send(`TICK ${toFirmwareMs(currentUtc)} ${stalled ? 0 : 1}`));

    if (observed.pttEvents.length && observed.pttEvents[0] && observed.keyedAtUtc === null)
      observed.keyedAtUtc = currentUtc;
    if (observed.keyedAtUtc !== null && observed.drainedAtUtc === null) {
      // The 150 ms playout tail intentionally holds PTT after the last byte and
      // is not starvation. Measure lag only while audio remains to be emitted.
      if (observed.radioBytes < 884736) {
        const owed = Math.max(0, (currentUtc - observed.keyedAtUtc) * ULAW_BYTES_PER_MS);
        const behindMs = (owed - observed.radioBytes) / ULAW_BYTES_PER_MS;
        if (behindMs > observed.worstStarvationMs) observed.worstStarvationMs = behindMs;
        observed.ringMinWhileKeyed = Math.min(observed.ringMinWhileKeyed, tx.ringEstimate);
      }
    }
    if (tx.state === "completed" || tx.state === "failed") {
      observed.drainedAtUtc = currentUtc;
      break;
    }
    currentUtc += LOOP_STEP_MS;
  }

  harness.close();
  // The WSPR-relevant number: by how much the delivery of the final mu-law byte
  // slipped past the ideal slot + 110.592 s. A stall that is fully recovered
  // leaves this near zero; one that is not stretches the whole transmission.
  observed.finalDeliveryLagMs = observed.keyedAtUtc === null || observed.lastRadioUtc === null
    ? NaN
    : observed.lastRadioUtc - (observed.keyedAtUtc + WsprCore.DURATION_S * 1000);
  return {observed, snapshot: tx.snapshot(), label};
}

// ---- scenarios -------------------------------------------------------------

(async () => {
  const totalUlaw = 884736;
  const report = (label, {observed, snapshot}) =>
    console.log(`  ${label.padEnd(20)} ${snapshot.state.padEnd(10)}` +
                ` radio=${observed.radioBytes}` +
                ` ring=${observed.ringMin}..${observed.ringMax}` +
                ` starve=${observed.worstStarvationMs.toFixed(0)}ms` +
                ` stretch=${observed.finalDeliveryLagMs.toFixed(0)}ms` +
                ` ticks=${observed.browserTicks}`);

  function common(label, {observed, snapshot}) {
    ok(`${label}: completed`, snapshot.state === "completed",
       snapshot.state + " " + snapshot.error);
    ok(`${label}: no firmware abort`, observed.aborts.length === 0, observed.aborts.join("; "));
    check(`${label}: mu-law reached the radio`, observed.radioBytes, totalUlaw);
    ok(`${label}: ring never overflowed`, observed.ringMax <= 12288, `peak ${observed.ringMax} B`);
    ok(`${label}: ring never ran dry while keyed`, observed.ringMinWhileKeyed > 0,
       `min ${observed.ringMinWhileKeyed} B`);
    check(`${label}: PTT keyed exactly once`, observed.pttEvents.filter(Boolean).length, 1);
    check(`${label}: PTT released`, observed.pttEvents[observed.pttEvents.length - 1], false);
  }

  console.log("\n  scenario             state      observations");

  // 1. Clean run.
  {
    const result = await transmit({label: "clean"});
    report("clean", result);
    common("clean", result);
    check("clean: packets sent", result.snapshot.sentPackets, 5530);
    check("clean: samples sent", result.snapshot.sentSamples, WsprCore.SIGNAL_SAMPLES);
    ok("clean: keyed at the slot",
       Math.abs(result.observed.keyedAtUtc - SLOT_UTC) <= LOOP_STEP_MS,
       `${result.observed.keyedAtUtc - SLOT_UTC} ms off`);
    ok("clean: radio never starved", result.observed.worstStarvationMs < 25,
       `${result.observed.worstStarvationMs.toFixed(0)} ms`);
    // The whole interface between the radio's ALC meter and the browser. Reading
    // the wrong one of the two sources reported "no ALC" forever on the ordinary
    // single-radio setup, and the calibration blamed the radio for it.
    ok("clean: tx-level carries the ALC the radio answered",
       Boolean(result.observed.alc) && result.observed.alc.raw === 37 &&
       result.observed.alc.seq === 4,
       JSON.stringify(result.observed.alc || null));
  }

  // 2. Throttled background tab: the browser timer fires once per second, which
  //    is what Chrome clamps a backgrounded tab to. Everything else has to come
  //    from inbound tx-level messages -- the claim chapter 5.2 rests on.
  {
    const result = await transmit({browserTickMs: 1000, label: "background tab"});
    report("background tab 1 Hz", result);
    common("background tab", result);
    ok("background tab: level-driven, not timer-driven",
       result.observed.browserTicks > 500,
       `${result.observed.browserTicks} pumps for ${result.observed.levels} levels`);
  }

  // 3. Chrome may check a hidden, silent page's chained timers only once per
  //    minute. A prepared TX must therefore be woken by firmware before the
  //    slot; otherwise the first browser wake comes too late to prebuffer.
  {
    const result = await transmit({browserTickMs: 60000, label: "intensive throttle"});
    report("background tab 60 s", result);
    common("intensive throttle", result);
    ok("intensive throttle: firmware wakes browser before keying",
       result.observed.preKeyLevels > 0,
       `${result.observed.preKeyLevels} pre-key levels`);
  }

  // 4. Cooperative-loop stalls. The socket/audio owner must keep its 20 ms
  //    clock independent of the sketch loop which hosts UI, CAT and flash work.
  const starvation = [];
  for (const forMs of [50, 150, 400]) {
    const stalls = [];
    for (let at = 5000; at < 105000; at += 20000) stalls.push({atMs: at, forMs});
    const result = await transmit({stalls, label: `stall ${forMs}`});
    report(`stall ${forMs} ms x${stalls.length}`, result);
    common(`stall ${forMs}`, result);
    starvation.push({forMs, worst: result.observed.worstStarvationMs,
                     stretch: result.observed.finalDeliveryLagMs});
  }
  ok("main-loop stalls do not stretch audio delivery",
     starvation.every(entry => Math.abs(entry.stretch) <= 2 * LOOP_STEP_MS),
     starvation.map(entry => `${entry.forMs}->${entry.stretch.toFixed(0)}`).join(" "));
  ok("main-loop stalls do not starve radio playout",
     starvation.every(entry => entry.worst < 25),
     starvation.map(entry => `${entry.forMs}->${entry.worst.toFixed(0)}`).join(" "));

  // 5. Is the AUD1 keepalive load-bearing? Chapter 5.3 originally claimed the
  //    firmware would refuse to key without it. It does not: liveness is only
  //    evaluated at tx.prepare (where the frame itself refreshes it) and at
  //    keying, and the prebuffer burst 1.35 s earlier covers that. Asserting the
  //    real behaviour keeps the doc honest.
  {
    const result = await transmit({keepAlive: false, label: "no keepalive"});
    report("no keepalive", result);
    common("no keepalive", result);
    ok("no keepalive: keying is NOT blocked (5.3 corrected)",
       result.observed.aborts.length === 0 &&
       result.observed.pttEvents.filter(Boolean).length === 1,
       result.observed.aborts.join("; ") || "keyed normally");
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
