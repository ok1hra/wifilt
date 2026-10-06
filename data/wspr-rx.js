// WSPR receive side of the WSPR page: cuts two-minute cycles out of the AUD1
// RX stream, hands them to the decoder worker (wspr-decoder.js), keeps the
// spots, uploads them to wsprnet.org and writes ALL_WSPR.TXT.
//
// One file on purpose: LittleFS charges by the 4 kB block, so four small
// modules would cost more flash than one.
//
// No DOM here. The page (wspr.js) owns the UI and tells this file what the
// radio is doing; everything below runs under Node too
// (tools/wspr-rx-smoke.js).

(function (root, factory) {
  const value = factory(root);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.WsprRx = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (root) {
  "use strict";

  const RATE = 8000;                     // AUD1 RX: mu-law at 8 kHz
  const CYCLE_MS = 120000;
  const CAPTURE_MS = 114000;             // what wsprd reads of a cycle
  const NEED = CAPTURE_MS / 1000 * RATE;
  const MIN_COVER_MS = 100000;           // less than this of the cycle heard: not worth a decode
  // A dial change after this point lands in the last 1.6 s of a 110.6 s signal,
  // which is where the beacon retunes ahead of its next slot. Earlier than this
  // the cycle is two bands glued together and the spot frequency would be wrong.
  const DIAL_FREEZE_MS = 110000;
  const DIAL_TOLERANCE_HZ = 10;
  const RING = 240 * RATE, BLOCK = 400;  // two cycles of audio, 50 ms blocks
  const RETENTION_MS = 30 * 86400000;
  const UPLOAD_MAX_AGE_MS = 86400000;    // the offline queue gives up after a day
  const PROBE_EVERY_MS = 5 * 60000;

  const pad = (value, width) => String(value).padStart(width, " ");
  const two = value => String(value).padStart(2, "0");
  function utcParts(ms) {
    const d = new Date(ms);
    return {date: `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`,
      time: `${two(d.getUTCHours())}${two(d.getUTCMinutes())}`};
  }
  const mhz = (hz, places) => (hz / 1e6).toFixed(places);

  // ---- receiver -------------------------------------------------------------

  // Sample -> UTC comes from Js8Timebase, the same anchor JS8 decodes on: the
  // earliest arrival among packets fixes sample 0, reconnects open a new media
  // epoch, and the shared clock correction is applied there and nowhere else.
  class Receiver {
    constructor({Timebase, createWorker, coreUrl = "", wallNow = () => Date.now(),
                 onCycle = () => {}, onHashtable = () => {}, hashtable = null}) {
      this.Timebase = Timebase; this.createWorker = createWorker; this.coreUrl = coreUrl;
      this.wallNow = wallNow; this.onCycle = onCycle; this.onHashtable = onHashtable;
      this.hashtable = hashtable;
      this.enabled = false; this.options = {}; this.correctionMs = 0;
      this.ring = new Float32Array(RING);
      this.owner = new Float64Array(RING / BLOCK).fill(-1);
      this.cycles = new Map();
      this.worker = null; this.busy = null; this.queue = [];
      this.reset();
    }

    reset() {
      this.tb = this.Timebase ? new this.Timebase({sampleRate: RATE, autoTimingEnabled: false,
        manualCorrectionMs: this.correctionMs}) : null;
      this.epoch = null; this.lastCycle = null; this.owner.fill(-1);
      this.ingested = 0; this.listenFromMs = null;
    }

    setEnabled(on) {
      on = Boolean(on);
      if (on === this.enabled) return;
      this.enabled = on;
      this.reset();
      this.queue.length = 0;
      if (!on && this.worker) { this.worker.terminate(); this.worker = null; this.busy = null; }
    }

    configure({options, correctionMs} = {}) {
      if (options) this.options = {...options};
      if (correctionMs !== undefined && Number.isFinite(Number(correctionMs)) &&
          Number(correctionMs) !== this.correctionMs) {
        this.correctionMs = Number(correctionMs);
        if (this.tb) this.tb.setManualCorrection(this.correctionMs);
      }
    }

    get status() {
      if (!this.enabled) return {state: "off"};
      if (this.busy) return {state: "decoding", cycleMs: this.busy.cycleMs, pass: this.busy.pass};
      if (!this.tb || this.tb.mediaStatus !== "locked") return {state: "syncing"};
      return {state: "listening"};
    }

    // Why the cycle running at `utcMs` will be skipped, "" while it is still good.
    cycleTainted(utcMs) {
      const rec = this.cycles.get(Math.floor(utcMs / CYCLE_MS) * CYCLE_MS);
      return rec ? rec.tainted : "";
    }

    // What the radio is doing, from /state and the page's own PTT. Evaluated
    // against the wall clock, which is close enough: the decision is per cycle,
    // the transport delay is a fraction of a second.
    noteRadio({frequency, tx, utcMs}) {
      if (!this.enabled) return;
      const cycleMs = Math.floor(utcMs / CYCLE_MS) * CYCLE_MS, into = utcMs - cycleMs;
      let rec = this.cycles.get(cycleMs);
      if (!rec) {
        rec = {dialHz: Number(frequency) || 0, tainted: ""};
        this.cycles.set(cycleMs, rec);
        for (const key of this.cycles.keys()) if (key < cycleMs - 3 * CYCLE_MS) this.cycles.delete(key);
      }
      if (into >= CAPTURE_MS || rec.tainted) return;
      // The first second is still silence: the signal starts 1 s in. A poll
      // that straddles the minute (or a retune landing right on it) only sets
      // which dial this cycle is on.
      if (into < 1000 && !tx) { if (frequency) rec.dialHz = Number(frequency); return; }
      if (tx) rec.tainted = "own transmission";
      else if (!frequency || !rec.dialHz) rec.tainted = "radio not reporting its dial";
      else if (into < DIAL_FREEZE_MS && Math.abs(frequency - rec.dialHz) > DIAL_TOLERANCE_HZ)
        rec.tainted = "dial changed during the cycle";
    }

    ingest(samples, rate, meta) {
      if (!this.enabled || !this.tb || rate !== RATE || !meta) return;
      const first = Number(meta.firstSample);
      const seen = this.tb.observePacket({streamId: meta.streamId, sequence: meta.sequence,
        firstSample: first, sampleCount: samples.length,
        arrivalWallMs: this.wallNow(), arrivalMonotonicMs: meta.arrivalMs});
      if (!seen.accepted) return;
      this.ingested += samples.length;
      if (this.tb.mediaEpoch !== this.epoch) { this.epoch = this.tb.mediaEpoch; this.owner.fill(-1); }
      for (let j = 0; j < samples.length; j++) {
        const s = first + j, pos = s % RING, block = Math.floor(s / BLOCK), slot = (pos / BLOCK) | 0;
        if (this.owner[slot] !== block) {
          this.ring.fill(0, slot * BLOCK, slot * BLOCK + BLOCK);
          this.owner[slot] = block;
        }
        this.ring[pos] = samples[j];
      }
      this.check();
    }

    check() {
      const end = this.tb.expectedSample, endUtc = this.tb.mediaUtcMs(end);
      if (endUtc === null) return;
      if (this.listenFromMs === null) this.listenFromMs = endUtc - this.ingested * 1000 / RATE;
      const cycleMs = Math.floor((endUtc - CAPTURE_MS) / CYCLE_MS) * CYCLE_MS;
      if (this.lastCycle !== null && cycleMs <= this.lastCycle) return;
      this.lastCycle = cycleMs;
      const i0 = Math.round((cycleMs - this.tb.mediaUtcMs(0)) * RATE / 1000);
      const samples = new Float32Array(NEED);
      let covered = 0;
      for (let k = 0; k < NEED;) {
        const s = i0 + k, pos = ((s % RING) + RING) % RING, slot = (pos / BLOCK) | 0;
        const n = Math.min(BLOCK - (pos % BLOCK), NEED - k);
        if (s >= 0 && this.owner[slot] === Math.floor(s / BLOCK)) {
          samples.set(this.ring.subarray(pos, pos + n), k);
          covered += n;
        }
        k += n;
      }
      const rec = this.cycles.get(cycleMs);
      const skipped = covered < MIN_COVER_MS / 1000 * RATE
        ? `only ${Math.round(covered / RATE)} s of audio`
        : !rec ? "radio not reporting its dial" : rec.tainted;
      // A cycle that began before RX was switched on is not news.
      if (skipped && cycleMs < this.listenFromMs) return;
      if (skipped) { this.onCycle({cycleMs, skipped}); return; }
      if (this.queue.length) this.onCycle({cycleMs: this.queue.shift().cycleMs, skipped: "decoder fell behind"});
      this.queue.push({cycleMs, dialHz: rec.dialHz, samples});
      this.pump();
    }

    pump() {
      if (this.busy || !this.queue.length) return;
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = event => this.onWorker(event.data);
        this.worker.postMessage({type: "init", coreUrl: this.coreUrl, hashtable: this.hashtable});
      }
      const job = this.queue.shift();
      this.busy = {cycleMs: job.cycleMs, dialHz: job.dialHz, id: job.cycleMs, pass: 0};
      this.worker.postMessage({type: "decode", id: job.cycleMs, samples: job.samples, sampleRate: RATE,
        opts: this.options}, [job.samples.buffer]);
    }

    onWorker(m) {
      const job = this.busy;
      if (!job || m.id !== job.id) return;
      if (m.type === "progress") { job.pass = m.pass + 1; return; }
      this.busy = null;
      if (m.type === "error") this.onCycle({cycleMs: job.cycleMs, skipped: "decoder error: " + m.message.split("\n")[0]});
      else {
        this.hashtable = m.hashtable;
        this.onHashtable(m.hashtable);
        this.onCycle({cycleMs: job.cycleMs, dialHz: job.dialHz, decodes: m.decodes, ms: m.ms});
      }
      this.pump();
    }
  }

  // A decode plus the cycle it came from, as stored and shown.
  function makeSpot(cycleMs, dialHz, d) {
    return {t: cycleMs, dialHz, freqHz: Math.round(dialHz + d.audioHz), audioHz: d.audioHz,
      snr: d.snr, dt: d.dt, drift: d.drift, call: d.call, grid: d.grid || "", power: d.power,
      type: d.type, osd: Boolean(d.osd), sync: d.sync, pass: d.pass, blocksize: d.blocksize || 1,
      jitter: d.jitter || 0, cycles: d.cycles || 0, upload: "local"};
  }

  // ---- ALL_WSPR.TXT ---------------------------------------------------------

  // Column for column what wsprd writes (checked against /usr/bin/wsprd):
  // date time snr dt freq  message drift sync pass blocksize jitter decodetype
  // nhardmin cycles metric. The last two diagnostics are not kept, so 0.
  function allWsprLine(s) {
    const {date, time} = utcParts(s.t);
    const message = s.type === 2 ? `${s.call} ${s.power}` : `${s.call} ${s.grid} ${s.power}`;
    return `${date} ${time} ${pad(s.snr, 3)} ${pad(Number(s.dt).toFixed(2), 5)} ${pad(mhz(s.freqHz, 7), 11)}` +
      `  ${message.padEnd(22)} ${pad(s.drift, 2)} ${pad(Number(s.sync || 0).toFixed(2), 5)}` +
      ` ${pad(s.pass || 1, 2)} ${pad(s.blocksize || 1, 2)} ${pad(s.jitter || 0, 4)} ${pad(s.osd ? 1 : 0, 2)}` +
      ` ${pad(0, 3)} ${pad(s.cycles || 0, 5)} ${pad(0, 5)}`;
  }
  const allWsprText = spots => spots.map(allWsprLine).join("\n") + (spots.length ? "\n" : "");

  // ---- store ----------------------------------------------------------------

  // Separate database from the beacon's activity log: a heard station is not a
  // transmission, and the two have different retention.
  class SpotStore {
    constructor({indexedDB = root.indexedDB, name = "wspr-rx"} = {}) {
      this.idb = indexedDB; this.name = name; this.db = null;
    }
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const request = this.idb.open(this.name, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("spots", {keyPath: "id", autoIncrement: true}).createIndex("t", "t");
          db.createObjectStore("meta");
        };
        request.onsuccess = () => resolve(this.db = request.result);
        request.onerror = () => reject(request.error);
      });
    }
    async tx(stores, mode, work) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        result = work(t);
      });
    }
    add(spots) {
      return this.tx("spots", "readwrite", t => {
        const os = t.objectStore("spots");
        for (const spot of spots) os.add(spot).onsuccess = event => { spot.id = event.target.result; };
        return spots;
      });
    }
    put(spot) { return this.tx("spots", "readwrite", t => { t.objectStore("spots").put(spot); }); }
    // Walks the time index; `visit` returns false to stop.
    walk(range, direction, visit) {
      return this.tx("spots", "readonly", t => {
        t.objectStore("spots").index("t").openCursor(range, direction).onsuccess = event => {
          const cursor = event.target.result;
          if (cursor && visit(cursor.value) !== false) cursor.continue();
        };
      });
    }
    async recent(limit = 500, match = null) {
      const out = [];
      await this.walk(null, "prev", spot => {
        if (!match || match(spot)) out.push(spot);
        return out.length < limit;
      });
      return out;
    }
    // Newest first from `fromMs` on, at most `limit`; `capped` says whether the
    // period held more. Thirty busy days are hundreds of thousands of spots.
    async since(fromMs, limit = 20000) {
      const spots = [];
      let capped = false;
      await this.walk(IDBKeyRange.lowerBound(fromMs), "prev", spot => {
        if (spots.length >= limit) { capped = true; return false; }
        spots.push(spot);
      });
      return {spots, capped};
    }
    async between(fromMs, toMs) {
      const out = [];
      await this.walk(IDBKeyRange.bound(fromMs, toMs), "next", spot => { out.push(spot); });
      return out;
    }
    async queued(sinceMs) {
      const out = [];
      await this.walk(IDBKeyRange.lowerBound(sinceMs), "next", spot => {
        if (spot.upload === "queued") out.push(spot);
      });
      return out;
    }
    prune(nowMs) {
      return this.tx("spots", "readwrite", t => {
        t.objectStore("spots").index("t").openCursor(IDBKeyRange.upperBound(nowMs - RETENTION_MS))
          .onsuccess = event => {
            const cursor = event.target.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
          };
      });
    }
    getMeta(key) {
      return this.tx("meta", "readonly", t => {
        const out = {};
        t.objectStore("meta").get(key).onsuccess = event => { out.value = event.target.result; };
        return out;
      }).then(out => out.value);
    }
    setMeta(key, value) {
      return this.tx("meta", "readwrite", t => {
        if (value === undefined) t.objectStore("meta").delete(key);
        else t.objectStore("meta").put(value, key);
      });
    }
  }

  // ---- wsprnet.org ----------------------------------------------------------

  // The interface has no business on the internet, so the browser posts. The
  // site sends no CORS headers; a form-encoded POST is still a "simple" request
  // the browser will send with mode no-cors -- it just will not show us the
  // answer. A fetch that resolves therefore means "delivered to the server",
  // one that rejects means "no internet", and that is all this can know.
  // Same fields and URL as WSJT-X (Network/wsprnet.cpp).
  class Uploader {
    constructor({fetchImpl = (...a) => root.fetch(...a), store, now = () => Date.now(),
                 onChange = () => {}, base = null} = {}) {
      this.fetch = fetchImpl; this.store = store; this.now = now; this.onChange = onChange;
      // An https page may not post to http (mixed content); an http one may.
      const secure = base === null ? (root.location && root.location.protocol === "https:") : false;
      this.base = base || (secure ? "https://wsprnet.org" : "http://wsprnet.org");
      this.online = null; this.lastProbeMs = 0; this.sent = 0; this.flushing = false;
      this.lastError = "";
    }
    setOnline(value, error = "") {
      if (this.online !== value || this.lastError !== error) {
        this.online = value; this.lastError = error; this.onChange();
      }
    }
    async request(url, body) {
      const options = {method: body ? "POST" : "GET", mode: "no-cors", cache: "no-store",
        signal: AbortSignal.timeout(10000)};
      if (body) options.body = body;
      await this.fetch(url, options);
    }
    async probe(force = false) {
      if (!force && this.now() - this.lastProbeMs < PROBE_EVERY_MS) return this.online;
      this.lastProbeMs = this.now();
      try { await this.request(`${this.base}/favicon.ico`); this.setOnline(true); }
      catch (error) { this.setOnline(false, String(error && error.message || error)); }
      return this.online;
    }
    static spotBody(spot, station) {
      const {date, time} = utcParts(spot.t);
      const call = String(spot.call).replace(/[<>]/g, "");
      return new URLSearchParams({function: "wspr", date, time, sig: String(spot.snr),
        dt: Number(spot.dt).toFixed(1), drift: String(spot.drift), tqrg: mhz(spot.freqHz, 6),
        tcall: call, tgrid: spot.grid || "", dbm: String(spot.power), version: station.version,
        rcall: station.call, rgrid: station.grid, rqrg: mhz(spot.dialHz, 6), mode: "2"});
    }
    static statusBody(dialHz, station) {
      return new URLSearchParams({function: "wsprstat", rcall: station.call, rgrid: station.grid,
        rqrg: mhz(dialHz, 6), tpct: String(station.tpct || 0), tqrg: mhz(dialHz, 6),
        dbm: String(station.dbm || 0), version: station.version, mode: "2"});
    }
    // Sends everything still queued, oldest first; stops at the first failure
    // and leaves the rest for the next probe that finds the internet back.
    async flush(station) {
      if (this.flushing || !this.online) return;
      this.flushing = true;
      try {
        const queue = await this.store.queued(this.now() - UPLOAD_MAX_AGE_MS);
        for (const spot of queue) {
          try { await this.request(`${this.base}/post/`, Uploader.spotBody(spot, station)); }
          catch (error) { this.setOnline(false, String(error && error.message || error)); break; }
          spot.upload = "sent";
          await this.store.put(spot);
          this.sent++;
          this.onChange(spot);
        }
      } finally { this.flushing = false; }
    }
    // "Listening, nothing heard": keeps the receiver on wsprnet's map.
    async status(dialHz, station) {
      if (!this.online) return;
      try { await this.request(`${this.base}/post/`, Uploader.statusBody(dialHz, station)); }
      catch (error) { this.setOnline(false, String(error && error.message || error)); }
    }
  }

  // ---- appending to a file the operator picked ------------------------------

  // Only where the browser offers the File System Access API, which it does in
  // a secure context only: the native build on localhost, or Chrome told to
  // trust the interface. On plain http from the ESP32 none of this exists and
  // the page shows SAVE alone.
  class FileAppender {
    constructor({store}) { this.store = store; this.handle = null; this.state = "none"; this.error = ""; }
    static available() { return typeof root.showSaveFilePicker === "function"; }
    async restore() {
      if (!FileAppender.available()) return;
      this.handle = await this.store.getMeta("appendFile").catch(() => null) || null;
      if (this.handle) this.state = await this.permission(false);
    }
    async permission(ask) {
      try {
        const query = {mode: "readwrite"};
        let p = await this.handle.queryPermission(query);
        if (p !== "granted" && ask) p = await this.handle.requestPermission(query);
        return p === "granted" ? "ready" : "needs-permission";
      } catch (_error) { return "needs-permission"; }
    }
    get name() { return this.handle ? this.handle.name : ""; }
    async pick() {
      this.handle = await root.showSaveFilePicker({suggestedName: "ALL_WSPR.TXT",
        types: [{description: "WSPR spots", accept: {"text/plain": [".txt"]}}]});
      await this.store.setMeta("appendFile", this.handle);
      this.state = "ready"; this.error = "";
    }
    async resume() { if (this.handle) this.state = await this.permission(true); }
    async forget() { this.handle = null; this.state = "none"; await this.store.setMeta("appendFile", undefined); }
    async append(text) {
      if (!this.handle || this.state !== "ready" || !text) return false;
      try {
        const file = await this.handle.getFile();
        const writable = await this.handle.createWritable({keepExistingData: true});
        await writable.seek(file.size);
        await writable.write(text);
        await writable.close();
        this.error = "";
        return true;
      } catch (error) {
        this.error = String(error && error.message || error);
        this.state = await this.permission(false);
        return false;
      }
    }
  }

  // ---- the radio's GPS as a clock ---------------------------------------------

  // Each /gps answer bounds the browser's clock error. The firmware stamped the
  // 23 00 reply when it arrived (replyAgeMs before it served the request); the
  // radio's stamp is whole seconds, so at that moment UTC lay in
  // [stamp, stamp + 1 s + latency). The browser saw the answer somewhere between
  // sending and receiving. Intersecting many such windows -- the firmware jitters
  // its query times so they land at different points of the GPS second -- pins
  // the offset to roughly the fastest round trip.
  const GPS_LATENCY_MS = 60;
  class GpsClock {
    constructor({windowMs = 180000} = {}) { this.windowMs = windowMs; this.bounds = []; this.lastKey = ""; }
    add({utcStampMs, replyAgeMs, sentMs, receivedMs}) {
      if (![utcStampMs, replyAgeMs, sentMs, receivedMs].every(Number.isFinite)) return this.estimate();
      // The same reply served twice adds nothing but weight.
      const key = `${utcStampMs}|${Math.round(receivedMs - replyAgeMs)}`;
      if (key === this.lastKey) return this.estimate();
      this.lastKey = key;
      const bound = {lo: utcStampMs + replyAgeMs - receivedMs,
                     hi: utcStampMs + 1000 + GPS_LATENCY_MS + replyAgeMs - sentMs, at: receivedMs};
      this.bounds = this.bounds.filter(b => receivedMs - b.at <= this.windowMs);
      this.bounds.push(bound);
      // Windows that no longer overlap mean the browser clock jumped (NTP, sleep)
      // or a stamp was stale: start again from what is true now.
      if (this.intersect().lo > this.intersect().hi) this.bounds = [bound];
      return this.estimate();
    }
    intersect() {
      let lo = -Infinity, hi = Infinity;
      for (const b of this.bounds) { if (b.lo > lo) lo = b.lo; if (b.hi < hi) hi = b.hi; }
      return {lo, hi};
    }
    estimate() {
      if (!this.bounds.length) return null;
      const {lo, hi} = this.intersect();
      return {offsetMs: (lo + hi) / 2, widthMs: hi - lo, count: this.bounds.length,
              lastMs: this.bounds[this.bounds.length - 1].at};
    }
  }
  // "2026-10-06 12:00:07" (the firmware's /gps utc field) -> ms.
  function gpsUtcMs(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  }

  // ---- small pure helpers ---------------------------------------------------

  // Median DT of the most recent decodes: the clock check this page could not
  // make before it received anything.
  function medianDt(spots, count = 30) {
    const values = spots.slice(0, count).map(s => Number(s.dt)).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length < 5) return null;
    const mid = values.length >> 1;
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }

  function locatorLatLon(grid) {
    const g = String(grid || "").toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
    let lon = (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2;
    let lat = (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]);
    if (g.length === 6) { lon += (g.charCodeAt(4) - 65) / 12 + 1 / 24; lat += (g.charCodeAt(5) - 65) / 24 + 1 / 48; }
    else { lon += 1; lat += 0.5; }
    return [lat, lon];
  }
  function distanceBearing(from, to) {
    const a = locatorLatLon(from), b = locatorLatLon(to);
    if (!a || !b) return null;
    const r = Math.PI / 180, la1 = a[0] * r, la2 = b[0] * r, dl = (b[1] - a[1]) * r;
    const d = Math.acos(Math.min(1, Math.max(-1,
      Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dl))));
    const y = Math.sin(dl) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
    return {km: Math.round(d * 6371), az: Math.round((Math.atan2(y, x) / r + 360) % 360)};
  }

  return {RATE, CYCLE_MS, CAPTURE_MS, RETENTION_MS, UPLOAD_MAX_AGE_MS,
    Receiver, makeSpot, allWsprLine, allWsprText, SpotStore, Uploader, FileAppender,
    GpsClock, gpsUtcMs, medianDt, distanceBearing};
});
