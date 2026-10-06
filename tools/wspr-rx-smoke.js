#!/usr/bin/env node
"use strict";

// data/wspr-rx.js without a browser: the cycle cutter fed with simulated AUD1
// packets through the real Js8Timebase and the real decoder (run in-process in
// place of the worker), the skip rules, the clock correction, the ALL_WSPR.TXT
// columns and the wsprnet uploader against a fake fetch.

const Core = require("../data/wspr-core.js");
const Decoder = require("../data/wspr-decoder.js");
const {Js8Timebase} = require("../data/js8-timebase.js");
const Rx = require("../data/wspr-rx.js");

let failures = 0, checks = 0;
function ok(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

const RATE = 8000, PACKET = 4000, DIAL = 14095600;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);          // an even minute

let seed = 7;
function gaussian() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const u = (seed + 1) / 0x80000000;
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * (seed + 1) / 0x80000000);
}
// One cycle of audio (120 s) starting at the even minute: noise, plus a signal
// one second in when `message` is given.
function cycleAudio(message, freq = 20, snr = -15, dt = 0) {
  const n = 120 * RATE, out = new Float32Array(n), sigma = 0.03;
  for (let i = 0; i < n; i++) out[i] = sigma * gaussian();
  if (!message) return out;
  const [call, grid, power] = message.split(" ");
  const sym = Core.encode({callsign: call, locator: grid, powerDbm: Number(power)}).symbols;
  const amp = Math.sqrt(2 * sigma * sigma * 2500 / (RATE / 2) * Math.pow(10, snr / 10));
  const start = (1 + dt) * RATE;
  let phase = 0;
  for (let k = Math.ceil(start); k < n; k++) {
    const i = Math.floor((k - start) / RATE / (8192 / 12000));
    if (i >= 162) break;
    out[k] += amp * Math.sin(phase);
    phase += 2 * Math.PI * (1500 + freq + (sym[i] - 1.5) * 12000 / 8192) / RATE;
  }
  return out;
}

// The worker, in-process: same messages, answered asynchronously.
function fakeWorker() {
  const hashes = new Decoder.HashTable();
  const worker = {
    onmessage: null, terminated: false, inits: 0,
    postMessage(m) {
      setImmediate(() => {
        if (worker.terminated) return;
        if (m.type === "init") { worker.inits++; hashes.load(m.hashtable); return; }
        const r = Decoder.decode(m.samples, m.sampleRate, m.opts, hashes);
        worker.onmessage({data: {type: "result", id: m.id, decodes: r.decodes, ms: r.ms,
          hashtable: hashes.toJSON()}});
      });
    },
    terminate() { worker.terminated = true; },
  };
  return worker;
}

const until = async (test, ms = 60000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise(resolve => setImmediate(resolve));
  }
};

// Feeds packets from `fromMs` on; `plan(cycleIndex)` says what each cycle holds.
// The browser's wall clock is `skewMs` off true UTC; every packet arrives 30 ms
// (plus a little jitter) after its last sample was produced.
async function run({cycles, plan, skewMs = 0, correctionMs = 0, startOffsetMs = -30000}) {
  const events = [];
  let wall = 0;
  const rx = new Rx.Receiver({Timebase: Js8Timebase, createWorker: fakeWorker,
    wallNow: () => wall, onCycle: e => events.push(e)});
  rx.configure({options: {osdDepth: 0}, correctionMs});
  rx.setEnabled(true);
  let sample = 0, sequence = 0, streamId = 4242;
  const firstCycle = Math.floor(startOffsetMs / 120000);
  for (let c = firstCycle; c < cycles; c++) {
    const p = plan(c) || {};
    const audio = cycleAudio(p.message, p.freq, p.snr);
    const cycleStart = T0 + c * 120000;
    const begin = c === firstCycle ? Math.round((startOffsetMs - c * 120000) / 1000 * RATE) : 0;
    for (let k = begin; k < audio.length; k += PACKET) {
      const tMs = cycleStart + (k + PACKET) / RATE * 1000;     // true UTC at packet end
      if (p.holeFrom !== undefined && tMs > cycleStart + p.holeFrom && tMs <= cycleStart + p.holeTo) {
        sample += PACKET; continue;                            // lost packets
      }
      if (p.reconnectAt !== undefined && Math.abs(tMs - cycleStart - p.reconnectAt) < 250) {
        streamId++; sample = 0; sequence = 0;                  // firmware re-mints the stream
      }
      wall = tMs + 30 + (k % 3) * 7 - skewMs;
      const into = tMs - cycleStart;
      const dial = p.dialChangeAt !== undefined && into >= p.dialChangeAt ? DIAL + 3000000 : DIAL;
      rx.noteRadio({frequency: dial, tx: p.txAt !== undefined && into >= p.txAt && into < p.txAt + 20000,
        utcMs: wall + correctionMs});
      rx.ingest(audio.subarray(k, k + PACKET), RATE,
        {streamId, sequence: sequence++, firstSample: sample, arrivalMs: wall});
      sample += PACKET;
      await until(() => !rx.busy && !rx.queue.length);
    }
  }
  return {events, rx};
}

(async () => {
  const msg = "OK1HRA JN79 37";
  const {events} = await run({cycles: 5, plan: c => ({
    0: {message: msg},
    1: {message: msg, txAt: 30000},
    2: {message: msg, dialChangeAt: 60000},
    3: {message: msg, freq: -50, dialChangeAt: 111000},
    4: {message: msg, holeFrom: 40000, holeTo: 70000},
  })[c]});
  const at = c => events.find(e => e.cycleMs === T0 + c * 120000);
  console.log(events.map(e => `  ${new Date(e.cycleMs).toISOString().slice(11, 16)} ` +
    (e.skipped ? `skipped: ${e.skipped}` : e.decodes.map(d => `${d.call} ${d.snr} dt ${d.dt} ${d.audioHz}`).join(", "))).join("\n"));

  ok("the partial cycle before RX started is not reported", !at(-1), JSON.stringify(at(-1)));
  const e0 = at(0);
  ok("cycle 0 decodes", e0 && e0.decodes && e0.decodes.some(d => d.call === "OK1HRA" && d.power === 37));
  ok("cycle 0 carries the dial", e0 && e0.dialHz === DIAL);
  ok("cycle 0 DT ~0 through the timebase", e0 && e0.decodes && Math.abs(e0.decodes[0].dt) <= 0.2,
    e0 && e0.decodes && e0.decodes[0] && e0.decodes[0].dt);
  ok("own transmission skips the cycle", at(1) && at(1).skipped === "own transmission", JSON.stringify(at(1)));
  ok("dial change mid-cycle skips it", at(2) && at(2).skipped === "dial changed during the cycle",
    JSON.stringify(at(2)));
  const e3 = at(3);
  ok("a retune after 110 s keeps the cycle", e3 && e3.decodes && e3.decodes.some(d => d.call === "OK1HRA"),
    JSON.stringify(e3 && (e3.skipped || e3.decodes.length)));
  ok("... and files it under the old dial", e3 && e3.dialHz === DIAL);
  ok("a 30 s hole skips the cycle", at(4) && /^only 8\d s of audio$/.test(at(4).skipped), JSON.stringify(at(4)));
  if (e3 && e3.decodes && e3.decodes[0]) {
    const spot = Rx.makeSpot(e3.cycleMs, e3.dialHz, e3.decodes[0]);
    ok("spot frequency = dial + audio", Math.abs(spot.freqHz - (DIAL + 1450)) <= 1, spot.freqHz);
  }

  // The browser clock 2.5 s slow, the shared correction set to +2.5 s.
  const skew = await run({cycles: 1, skewMs: 2500, correctionMs: 2500, startOffsetMs: -5000,
    plan: c => (c === 0 ? {message: msg} : null)});
  const s0 = skew.events.find(e => e.cycleMs === T0);
  ok("clock correction lands the cycle on the right samples",
    s0 && s0.decodes && s0.decodes[0] && Math.abs(s0.decodes[0].dt) <= 0.2,
    JSON.stringify(s0 && (s0.skipped || s0.decodes[0])));
  const raw = await run({cycles: 1, skewMs: 2500, correctionMs: 0, startOffsetMs: -5000,
    plan: c => (c === 0 ? {message: msg} : null)});
  const r0 = raw.events.find(e => e.cycleMs === T0 - 0) || raw.events[0];
  ok("without the correction a clock 2.5 s slow shows as DT ≈ -2.5 s",
    r0 && r0.decodes && r0.decodes[0] && Math.abs(r0.decodes[0].dt + 2.5) <= 0.3,
    JSON.stringify(r0 && (r0.skipped || r0.decodes[0])));

  // A reconnect (new stream, sample counter restarts) inside a cycle.
  const re = await run({cycles: 2, startOffsetMs: -5000, plan: c => ({0: {message: msg, reconnectAt: 50000},
    1: {message: msg}})[c]});
  const re0 = re.events.find(e => e.cycleMs === T0), re1 = re.events.find(e => e.cycleMs === T0 + 120000);
  ok("a reconnect mid-cycle loses that cycle, not the receiver",
    re0 && re0.skipped && re1 && re1.decodes && re1.decodes.some(d => d.call === "OK1HRA"),
    JSON.stringify([re0, re1 && (re1.skipped || re1.decodes.length)]));

  // ---- ALL_WSPR.TXT: the line wsprd itself wrote for the same decode ------
  const line = Rx.allWsprLine({t: Date.UTC(2026, 9, 6, 12, 0), freqHz: 10140220, snr: -20, dt: -0.02,
    drift: 0, call: "K1ABC", grid: "FN42", power: 37, type: 1, sync: 0.48, pass: 1, blocksize: 1,
    jitter: 0, osd: false, cycles: 1});
  ok("ALL_WSPR.TXT line matches wsprd's columns",
    line === "261006 1200 -20 -0.02  10.1402200  K1ABC FN42 37           0  0.48  1  1    0  0   0     1     0",
    JSON.stringify(line));
  const type2 = Rx.allWsprLine({t: T0, freqHz: 14097100, snr: -7, dt: 1.1, drift: -1, call: "PJ4/K1ABC",
    grid: "", power: 37, type: 2, sync: 0.6, osd: true});
  ok("type 2 line has no locator and flags OSD",
    type2 === "261006 1200  -7  1.10  14.0971000  PJ4/K1ABC 37           -1  0.60  1  1    0  1   0     0     0",
    JSON.stringify(type2));

  // ---- uploader ---------------------------------------------------------------
  const requests = [];
  let net = true;
  const fetchImpl = async (url, options) => {
    if (!net) throw new TypeError("Failed to fetch");
    ok("every request is no-cors", options.mode === "no-cors");
    requests.push({url, body: options.body ? String(options.body) : ""});
    return {type: "opaque"};
  };
  const stored = [];
  const store = {
    async queued(since) { return stored.filter(s => s.upload === "queued" && s.t >= since); },
    async put(spot) { Object.assign(stored.find(s => s === spot), spot); },
  };
  let now = T0 + 300000;
  const up = new Rx.Uploader({fetchImpl, store, now: () => now, base: "http://wsprnet.org"});
  const station = {call: "OK1HRA", grid: "JN79", version: "WIFILT 20261006"};
  const spot = Rx.makeSpot(T0, DIAL, {snr: -21, dt: 0.34, drift: -1, audioHz: 1520.4, call: "K1ABC",
    grid: "FN42", power: 37, type: 1});
  spot.upload = "queued";
  stored.push(spot, {...spot, t: T0 - 2 * 86400000});

  net = false;
  ok("probe without internet says offline", (await up.probe(true)) === false && up.online === false);
  await up.flush(station);
  ok("nothing is sent offline, the spot stays queued", !requests.length && spot.upload === "queued");
  net = true;
  ok("probe with internet says online", (await up.probe(true)) === true);
  ok("probe hits wsprnet", requests[0] && requests[0].url === "http://wsprnet.org/favicon.ico");
  await up.flush(station);
  const post = requests.find(r => r.url === "http://wsprnet.org/post/");
  ok("queued spot is posted to /post/", post);
  const fields = new URLSearchParams(post ? post.body : "");
  const expect = {function: "wspr", date: "261006", time: "1200", sig: "-21", dt: "0.3", drift: "-1",
    tqrg: "14.097120", tcall: "K1ABC", tgrid: "FN42", dbm: "37", version: "WIFILT 20261006",
    rcall: "OK1HRA", rgrid: "JN79", rqrg: "14.095600", mode: "2"};
  for (const [key, value] of Object.entries(expect))
    ok(`spot field ${key}=${value}`, fields.get(key) === value, fields.get(key));
  ok("spot marked sent", spot.upload === "sent");
  ok("a spot older than a day stays queued, never sent",
    stored[1].upload === "queued" && requests.filter(r => r.url.endsWith("/post/")).length === 1);
  const hashed = Rx.Uploader.spotBody({...spot, call: "<PJ4/K1ABC>", grid: "FK52UD", type: 3}, station);
  ok("hashed call is sent without brackets", hashed.get("tcall") === "PJ4/K1ABC");
  const stat = Rx.Uploader.statusBody(DIAL, {...station, tpct: 20, dbm: 23});
  ok("wsprstat carries the receiver and dial",
    stat.get("function") === "wsprstat" && stat.get("rqrg") === "14.095600" && stat.get("tpct") === "20");
  net = false;
  spot.upload = "queued";
  await up.flush(station);
  ok("a failing post flips the uploader offline", up.online === false && spot.upload === "queued");

  // ---- GPS clock ----------------------------------------------------------------
  // Truth: the browser runs 437 ms behind UTC. The radio answers 23 00 at random
  // points of the GPS second (the firmware jitters its queries), the page polls
  // /gps every 5 s over a link with a 40-160 ms round trip.
  function simulateGps(offsetMs, polls, startMs = T0, clock = new Rx.GpsClock()) {
    let rng = 99;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    let estimate = null;
    for (let i = 0; i < polls; i++) {
      const sentUtc = startMs + i * 5000 + rand() * 1000;
      const rtt = 40 + rand() * 120, serveUtc = sentUtc + rtt * (0.3 + 0.4 * rand());
      const replyAge = rand() * 4500, replyUtc = serveUtc - replyAge;
      const stamp = Math.floor((replyUtc - 20) / 1000) * 1000;   // stamped ~20 ms before it arrived
      estimate = clock.add({utcStampMs: stamp, replyAgeMs: Math.round(replyAge),
        sentMs: sentUtc - offsetMs, receivedMs: sentUtc + rtt - offsetMs});
    }
    return {estimate, clock};
  }
  const g = simulateGps(437, 36).estimate;
  ok("GPS clock converges on the true offset ±60 ms", g && Math.abs(g.offsetMs - 437) <= 60,
    g && `${g.offsetMs.toFixed(0)} ±${(g.widthMs / 2).toFixed(0)} from ${g.count}`);
  ok("GPS clock window narrows below 300 ms", g && g.widthMs <= 300, g && g.widthMs.toFixed(0));
  const one = simulateGps(437, 1).estimate;
  ok("one answer alone is a full second wide", one && one.widthMs >= 1000, one && one.widthMs);
  const jumped = simulateGps(437, 36);
  const after = simulateGps(-2500, 36, T0 + 200000, jumped.clock).estimate;
  ok("a clock jump starts the estimate again rather than averaging",
    after && Math.abs(after.offsetMs + 2500) <= 60, after && after.offsetMs.toFixed(0));
  ok("the /gps utc field parses", Rx.gpsUtcMs("2026-10-06 12:00:07") === T0 + 7000 && Rx.gpsUtcMs(null) === null);

  // ---- helpers ------------------------------------------------------------------
  ok("median DT needs five spots", Rx.medianDt([{dt: 1}, {dt: 1}]) === null);
  ok("median DT", Rx.medianDt([0.1, 0.2, 0.9, 1.0, 1.1, 1.2].map(dt => ({dt}))) === 0.95);
  const db = Rx.distanceBearing("JN79", "FN42");
  ok("distance JN79 -> FN42 ~6320 km, ~299°", db && Math.abs(db.km - 6320) < 50 && Math.abs(db.az - 299) < 3,
    JSON.stringify(db));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
