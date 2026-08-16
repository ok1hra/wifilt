// JS8 -> APRS-IS gateway: what we do with an @APRSIS message somebody ELSE sent.
//
// js8-aprs.js composes @APRSIS commands for TRANSMISSION. This module is the
// opposite direction: a station on the band asks the network to put its position
// (or a third-party text) on APRS-IS, and any listening igate is expected to
// carry it. From here on we are that igate.
//
// The module holds no DOM and does no I/O. It decides, remembers and hands back
// a POST body; data.js does the fetch and paints the result. That split is what
// keeps the four filters testable in node:
//
//   incomplete   a lost EOT truncates the text, and "JN89HK" cut to "JN89"
//                is a position tens of kilometres away that looks perfectly valid
//   blocked      whoever is blocked on the air does not get an internet gateway
//                from us either
//   duplicate    the same station with the same content inside dedupMinutes
//   hourly cap   the only defence against somebody feeding varying text through
//                our callsign every 15 seconds; dedup does nothing against that
//
// The firmware builds the actual APRS frame (see docs/aprsis-igate-implementace.md)
// because it is the party that signs it with our callsign. What crosses the wire
// from here is fields, never a finished line.

// js8-aprs.js is a dependency, not a neighbour: the group call, the nine-character
// addressee, the 67-character text limit and the locator pattern are ONE rule each,
// and a station that gates by a different rule than it transmits by is a station
// whose two halves disagree about what @APRSIS means. data.html loads that module
// first; node requires it directly.
(function (root, factory) {
  const aprs = typeof module === "object" && module.exports
    ? require("./js8-aprs.js") : root.Js8Aprs;
  const value = factory(aprs);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8AprsGate = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (Js8Aprs) {
  const {GROUP, ADDRESSEE_WIDTH, MESSAGE_TEXT_LIMIT, LOCATOR_RE, addressee} = Js8Aprs;
  const STORAGE_KEY = "wifilt.data.js8-aprs-gate.v1";
  // JS8Call drops a queued packet after PACKET_TIMEOUT_SECONDS = 300 and we use
  // the same number for the same reason: `=` carries no timestamp, so a packet
  // delivered late is plotted as if it had just been heard.
  const TTL_MS = 300000;
  const RETRY_MS = [15000, 30000, 60000, 120000];
  // Kept small on purpose: this is a log of what the badges need, not history.
  const MAX_ENTRIES = 40;

  // What an APRS message looks like once the JS8 command word is off: a colon,
  // the addressee, a colon, the text. The addressee is re-padded to exactly nine
  // characters below, because the sender's copy of that padding is invisible in a
  // one-line input and gets lost the moment anybody hand-edits the draft.
  const CMD_RE = /^:([^:]{1,9}):([\s\S]+)$/;
  // APRS-IS is line based, so a control character in a field is not a formatting
  // problem -- it is a second packet, chosen by whoever transmitted it. "\n" is a
  // literal in the JS8 alphabet and CMD_RE deliberately spans newlines, so this is
  // the check that stops a station on the air from publishing an arbitrary frame
  // under this callsign. The firmware refuses the same thing again on arrival.
  const CONTROL_RE = /[\u0000-\u001f\u007f]/;
  const CALL_RE = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]*(?:[/-][A-Z0-9]{1,4})?$/;

  // Exported so tools/aprsis-conversion-parity.js can hold the firmware's
  // aprsisFieldSafe() to exactly this rule. Two implementations of "what may go
  // into an APRS-IS line" that disagree is how an injection gets through the one
  // that was checked.
  const fieldSafe = value => !CONTROL_RE.test(String(value == null ? "" : value));

  const DEFAULTS = {enabled: false, call: "", passcode: "", host: "czech.aprs2.net",
    port: 14580, maxPerHour: 30, dedupMinutes: 10};

  // APRS-IS passcode, the aprsc passcode.c hash. Not a secret -- it is a checksum
  // of the callsign -- but the server silently drops packets from an unverified
  // connection, so being able to say "this passcode does not match this callsign"
  // before the first packet is the difference between a red field and two hours
  // of wondering why nothing appears on aprs.fi.
  //
  // The trailing NUL of the C original matters: for an odd-length callsign the
  // last character is XORed into the HIGH byte alone. N0CALL must come out 13023.
  function passcode(call) {
    const root = String(call || "").toUpperCase().split("-")[0]
      .replace(/[^A-Z0-9]/g, "");
    let hash = 0x73e2;
    for (let i = 0; i < root.length; i += 2) {
      hash ^= root.charCodeAt(i) << 8;
      if (i + 1 < root.length) hash ^= root.charCodeAt(i + 1);
    }
    return String(hash & 0x7fff);
  }

  function passcodeValid(call, value) {
    const clean = String(value || "").trim();
    if (!clean || !String(call || "").trim()) return false;
    return clean === passcode(call);
  }

  // The login callsign an operator gets offered the first time. -10 is the APRS
  // convention for a full-time igate; it is only a proposal because APRS-IS
  // allows one connection per callsign-SSID and the operator may already have
  // that one taken by a WX station or by JS8Call on a PC.
  function suggestCall(identity) {
    const base = String(identity || "").toUpperCase().split("/")[0]
      .replace(/[^A-Z0-9]/g, "");
    return base ? `${base}-10` : "";
  }

  function normalizeConfig(input) {
    const source = input && typeof input === "object" ? input : {};
    const port = Math.round(Number(source.port));
    const perHour = Math.round(Number(source.maxPerHour));
    const dedup = Math.round(Number(source.dedupMinutes));
    return {
      enabled: source.enabled === true,
      call: String(source.call ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 9),
      passcode: String(source.passcode ?? "").replace(/[^0-9-]/g, "").slice(0, 6),
      host: String(source.host ?? DEFAULTS.host).trim().replace(/[^A-Za-z0-9.\-]/g, "")
        .slice(0, 40) || DEFAULTS.host,
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : DEFAULTS.port,
      maxPerHour: Number.isFinite(perHour) && perHour >= 1 && perHour <= 240
        ? perHour : DEFAULTS.maxPerHour,
      dedupMinutes: Number.isFinite(dedup) && dedup >= 1 && dedup <= 120
        ? dedup : DEFAULTS.dedupMinutes
    };
  }

  // A configured gate is not a working gate: without a valid passcode the server
  // takes the connection and throws the packets away, which is indistinguishable
  // from success at our end. So the gate refuses to run instead.
  function readiness(config) {
    const cfg = normalizeConfig(config);
    if (!cfg.enabled) return {ready: false, reason: "gate off"};
    if (!cfg.call) return {ready: false, reason: "no APRS-IS callsign"};
    if (!CALL_RE.test(cfg.call)) return {ready: false, reason: "APRS-IS callsign is not usable"};
    // Name the BASE callsign, not what is in the field. The passcode is a
    // checksum of the callsign with the SSID stripped, so OK1HRA and OK1HRA-10
    // share one -- and an operator staring at "does not match OK1HRA-10" will
    // reasonably suspect the SSID, which is the one thing that cannot be wrong.
    // The mistake this actually catches is a passcode belonging to a different
    // callsign entirely.
    if (!passcodeValid(cfg.call, cfg.passcode))
      return {ready: false,
        reason: `passcode does not match ${cfg.call.split("-")[0]}`
          + ` — it is a checksum of the callsign, and the SSID is not part of it`};
    if (!cfg.host || !cfg.port) return {ready: false, reason: "no APRS-IS server"};
    return {ready: true, reason: ""};
  }

  // ---- reference frame builder ----------------------------------------------
  // The firmware is what actually builds and signs the frame. This is the ORACLE
  // the smoke test and tools/aprsis-fake-server.js check it against -- two
  // implementations that must agree byte for byte, which is the only way a
  // rounding bug in the C++ conversion ever gets caught. Change one, change both.

  const TOCALL = "APJ8CL";
  const COMMENT_LIMIT = 42;

  // Centre of the cell, not its south-west corner. JS8Call's grid2deg accumulates
  // corners and never adds the half cell, so its spots sit ~1.2 km south and
  // ~1.6 km west of the station -- tens of kilometres on a four-character
  // locator. WSJT-X and PSKReporter report the centre and so do we.
  //
  // Everything below is INTEGER arithmetic in thousandths of a minute, and that
  // is not tidiness. Half of the smallest cell is 0.125′, and a position landing
  // on exactly x.xx5′ is a genuine rounding tie -- JN79NX28 is one. Floating
  // point resolves such a tie by whatever the last bit happens to be, so the JS
  // here and the C++ in wifilt.ino would disagree on the last digit for some
  // locators and nobody would ever find out why. In thousandths every half cell
  // is a whole number (125, 250, 1250, 2500, 30000, 60000) and both sides round
  // half up the same way.
  const LAT_UNITS = [600000, 60000, 2500, 250];   // field, square, subsquare, extended
  const LON_UNITS = [1200000, 120000, 5000, 500];
  const LAT_HALF = [30000, 1250, 125];            // by locator length: 4, 6, 8
  const LON_HALF = [60000, 2500, 250];
  const SOUTH_POLE_TH = 90 * 60 * 1000;
  const ANTIMERIDIAN_TH = 180 * 60 * 1000;

  function gridToThousandths(grid) {
    const g = String(grid || "").toUpperCase();
    if (!LOCATOR_RE.test(g)) return null;
    let lat = (g.charCodeAt(1) - 65) * LAT_UNITS[0] + Number(g[3]) * LAT_UNITS[1];
    let lon = (g.charCodeAt(0) - 65) * LON_UNITS[0] + Number(g[2]) * LON_UNITS[1];
    let level = 0;
    if (g.length >= 6) {
      lat += (g.charCodeAt(5) - 65) * LAT_UNITS[2];
      lon += (g.charCodeAt(4) - 65) * LON_UNITS[2];
      level = 1;
    }
    if (g.length >= 8) {
      lat += Number(g[7]) * LAT_UNITS[3];
      lon += Number(g[6]) * LON_UNITS[3];
      level = 2;
    }
    return {latTh: lat + LAT_HALF[level] - SOUTH_POLE_TH,
      lonTh: lon + LON_HALF[level] - ANTIMERIDIAN_TH};
  }

  // Degrees, for anything that wants to display or compare a position. The frame
  // never goes through here -- it is built from the integers.
  function gridToDegrees(grid) {
    const point = gridToThousandths(grid);
    return point ? {lat: point.latTh / 60000, lon: point.lonTh / 60000} : null;
  }

  // DDMM.hh / DDDMM.hh.
  //
  // There is deliberately NO carry from 60.00 minutes into the degree here, and
  // that is a property of the input rather than an oversight: every term above is
  // a multiple of 125 thousandths (250 for longitude) and so is the pole offset,
  // so the remainder is at most 59875 -- 59.88 minutes. Rounding can never reach
  // 60.00 and a carry branch would be code no test could ever execute. Feed this
  // helper something that is not a locator (a GPS fix, say) and the carry has to
  // come back.
  function thousandthsToAprs(value, degDigits) {
    const abs = Math.abs(value);
    const degrees = Math.floor(abs / 60000);
    const hundredths = Math.floor((abs % 60000 + 5) / 10);
    return `${String(degrees).padStart(degDigits, "0")}`
      + `${String(Math.floor(hundredths / 100)).padStart(2, "0")}`
      + `.${String(hundredths % 100).padStart(2, "0")}`;
  }

  function gridToAprs(grid) {
    const point = gridToThousandths(grid);
    if (!point) return null;
    return {lat: `${thousandthsToAprs(point.latTh, 2)}${point.latTh < 0 ? "S" : "N"}`,
      lon: `${thousandthsToAprs(point.lonTh, 3)}${point.lonTh < 0 ? "W" : "E"}`};
  }

  // AX.25 has no room for "/P": the suffix becomes an SSID when it is a number
  // and is dropped otherwise. What is dropped reappears at the head of the
  // comment, so the portable operation is still visible on aprs.fi.
  function sourceCall(call) {
    const clean = String(call || "").toUpperCase().replace(/[^A-Z0-9/-]/g, "");
    const slash = clean.indexOf("/");
    if (slash < 0) return clean.slice(0, 9);
    const base = clean.slice(0, slash);
    const suffix = clean.slice(slash + 1);
    return (/^[0-9]{1,2}$/.test(suffix) ? `${base}-${suffix}` : base).slice(0, 9);
  }

  const formatSnr = snr => {
    const value = Math.round(Number(snr) || 0);
    return `${value < 0 ? "-" : "+"}${String(Math.abs(value)).padStart(2, "0")}`;
  };

  function comment(entry) {
    const hz = Number(entry.freqHz) || 0;
    const parts = [];
    if (String(entry.from || "").includes("/")) parts.push(entry.from);
    if (hz > 0) parts.push(`${(hz / 1e6).toFixed(6)}MHz`);
    parts.push(`${formatSnr(entry.snrDb)}dB`);
    return parts.join(" ").slice(0, COMMENT_LIMIT);
  }

  // `=` is position-without-timestamp, messaging-capable; `/G` is the primary
  // table's "Grid Square (6 digit)" symbol -- the honest symbol for a position
  // that came out of a locator. `qAR` says an IGate heard this on the radio,
  // which is exactly what happened; JS8Call sends `qAS`, which claims a server
  // put it there.
  function frame(entry, config) {
    const cfg = normalizeConfig(config);
    const source = sourceCall(entry.from);
    if (!source || !cfg.call) return "";
    const head = `${source}>${TOCALL},qAR,${cfg.call}:`;
    if (entry.kind === "cmd") return entry.text ? `${head}${entry.text}` : "";
    const point = gridToAprs(entry.grid);
    if (!point) return "";
    return `${head}=${point.lat}/${point.lon}G#JS8 ${comment(entry)}`;
  }

  const loginFrame = (config, revision) => {
    const cfg = normalizeConfig(config);
    return `user ${cfg.call} pass ${cfg.passcode} vers wifilt ${revision || ""}`.trim();
  };

  // Everything the firmware needs to build one frame, or a refusal with a reason
  // an operator can act on. Never a finished APRS line: the line carries our
  // callsign, so it is built where the callsign lives.
  function describe(message) {
    if (!message || !message.directed) return null;
    const to = String(message.directed.to || "").trim().toUpperCase();
    if (to !== GROUP) return null;
    const command = String(message.directed.command || "").trim().toUpperCase();
    const from = String(message.directed.from || "").trim().toUpperCase();
    const payload = String(message.payload || "").trim();
    if (command !== "GRID" && command !== "CMD") return null;
    // Every return past this point carries a key: a refusal has to be rememberable
    // too, or the badge would re-decide the same message on every render.
    const fallbackKey = `${from}|${command}|${payload}`;
    // Before anything else: a control character anywhere in this message is an
    // attempt to write a second APRS-IS packet, not a malformed one.
    if (CONTROL_RE.test(payload) || CONTROL_RE.test(from))
      return {kind: "", key: fallbackKey, refuse: "control character in the message"};
    if (!from || !CALL_RE.test(from))
      return {kind: "", key: fallbackKey, refuse: "sender callsign unusable"};
    if (command === "GRID") {
      // parseGrids upstream takes every locator in the text; the first usable one
      // is the station's own and the rest are conversation.
      const grid = payload.toUpperCase().split(/\s+/)
        .find(token => LOCATOR_RE.test(token)) || "";
      if (!grid) return {kind: "", key: fallbackKey, refuse: "no usable locator"};
      return {kind: "grid", from, grid, key: `${from}|grid|${grid}`};
    }
    const match = CMD_RE.exec(payload);
    if (!match) return {kind: "", key: fallbackKey, refuse: "not an APRS message"};
    const text = match[2].trim();
    if (!text) return {kind: "", key: fallbackKey, refuse: "empty APRS message"};
    if (text.length > MESSAGE_TEXT_LIMIT)
      return {kind: "", key: fallbackKey,
        refuse: `APRS text over ${MESSAGE_TEXT_LIMIT} characters`};
    const wire = `:${addressee(match[1])}:${text}`;
    return {kind: "cmd", from, text: wire, key: `${from}|cmd|${wire}`};
  }

  class Js8AprsGate {
    constructor({storage = null, ttlMs = TTL_MS, maxEntries = MAX_ENTRIES,
                 onEvent = null} = {}) {
      this.storage = storage;
      this.ttlMs = ttlMs;
      this.maxEntries = maxEntries;
      this.onEvent = onEvent;
      this.entries = [];
      this.sentTimes = [];
      // renderActivity() asks for a badge once per row, up to two hundred rows,
      // on every 500 ms poll. A linear scan there was thousands of comparisons a
      // second for a lookup that is a key.
      this.index = new Map();
      this.load();
    }

    emit(type, entry, detail) {
      if (this.onEvent) this.onEvent({type, entry, detail: detail || ""});
    }

    load() {
      if (!this.storage) return;
      let raw = null;
      try { raw = this.storage.getItem(STORAGE_KEY); } catch (_error) { return; }
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== 1) return;
        this.entries = Array.isArray(parsed.entries) ? parsed.entries.slice(-this.maxEntries) : [];
        // "sending" means a fetch was in flight when the page went away. Nothing
        // would ever touch such an entry again -- due() takes only "queued",
        // awaiting() only "sent", expire() skips both -- so it would sit on its
        // row as an amber badge for ever. The device's dedup ring is what makes
        // demoting it safe: if the packet did go out, the retry is refused there.
        for (const entry of this.entries)
          if (entry && entry.state === "sending") { entry.state = "queued"; entry.nextMs = 0; }
        this.sentTimes = Array.isArray(parsed.sentTimes)
          ? parsed.sentTimes.filter(Number.isFinite) : [];
        this.reindex();
      } catch (_error) { /* a corrupt log is not worth a broken page */ }
    }

    save() {
      if (!this.storage) return;
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify({v: 1,
          entries: this.entries.slice(-this.maxEntries), sentTimes: this.sentTimes}));
      } catch (_error) { /* private mode, quota: the gate still works this session */ }
    }

    reindex() {
      this.index = new Map(this.entries.map(entry => [entry.key, entry]));
    }

    entryFor(key) {
      return this.index.get(key) || null;
    }

    // Counts VERIFIED packets, not attempted ones. A counter that ticked on every
    // write would show a busy gate while a wrong passcode was delivering nothing.
    sentLastHour(nowMs) {
      const since = Number(nowMs) - 3600000;
      return this.sentTimes.filter(time => time >= since).length;
    }

    // The whole decision for one assembled message. Returns the stored entry so the
    // caller can paint a badge, or null when the message is not ours to judge.
    consider(message, {nowMs, config, blockedReason = () => "", freqHz = 0} = {}) {
      const shape = describe(message);
      if (!shape) return null;
      const key = String(message.id || shape.key || "");
      if (!key) return null;
      const existing = this.entryFor(key);
      if (existing) return existing;
      const cfg = normalizeConfig(config);
      const entry = {key, dedupKey: shape.key || key, kind: shape.kind, from: shape.from,
        grid: shape.grid || "", text: shape.text || "",
        snrDb: Number.isFinite(Number(message.snr)) ? Math.round(Number(message.snr)) : 0,
        freqHz: Math.round(Number(freqHz) || 0),
        createdMs: Number(nowMs), attempts: 0, nextMs: Number(nowMs),
        state: "queued", reason: "", sent: "", seq: 0, server: "", sentMs: 0};
      const refuse = reason => {
        entry.state = "skipped";
        entry.reason = reason;
        return entry;
      };
      this.entries.push(entry);
      if (this.entries.length > this.maxEntries)
        this.entries.splice(0, this.entries.length - this.maxEntries);
      this.reindex();
      const decided = (() => {
        const ready = readiness(cfg);
        if (!ready.ready) return refuse(ready.reason);
        if (shape.refuse) return refuse(shape.refuse);
        // Display and act are different verbs: an incomplete reception still shows
        // in the feed, it just never leaves the station.
        if (message.incomplete) return refuse("message incomplete");
        if (message.checksumOk === false) return refuse("checksum failed");
        const blocked = blockedReason(shape.from);
        if (blocked) return refuse(blocked);
        const twin = this.entries.find(item => item !== entry
          && item.dedupKey === entry.dedupKey
          && ["sending", "sent", "verified", "unverified"].includes(item.state)
          && Number(nowMs) - Number(item.createdMs) < cfg.dedupMinutes * 60000);
        if (twin) return refuse(`already gated ${Math.round((Number(nowMs) - Number(twin.createdMs)) / 60000)} min ago`);
        if (this.sentLastHour(nowMs) >= cfg.maxPerHour)
          return refuse(`hourly cap ${cfg.maxPerHour} reached`);
        return entry;
      })();
      this.emit(decided.state === "skipped" ? "skip" : "queue", decided, decided.reason);
      this.save();
      return decided;
    }

    // Entries whose retry time has come. Sending is the caller's job, so this stays
    // synchronous and testable.
    due(nowMs) {
      this.expire(nowMs);
      return this.entries.filter(entry => entry.state === "queued"
        && Number(entry.nextMs) <= Number(nowMs));
    }

    // The POST body. The login block travels with every packet because the whole
    // configuration lives in the JS8 profile and the firmware stores nothing.
    body(entry, config) {
      const cfg = normalizeConfig(config);
      const packet = {kind: entry.kind, from: entry.from,
        snrDb: entry.snrDb, freqHz: entry.freqHz};
      if (entry.kind === "grid") packet.grid = entry.grid;
      else packet.text = entry.text;
      // dedupMinutes and maxPerHour travel with the packet because the DEVICE
      // enforces them: the login lives in the shared station profile, so every
      // browser that opens DATA is a gate and only the interface sees all of
      // them. The copies kept here are a way to avoid a pointless POST, not the
      // rule itself.
      return {login: {call: cfg.call, pass: cfg.passcode, host: cfg.host, port: cfg.port,
        dedupMinutes: cfg.dedupMinutes, maxPerHour: cfg.maxPerHour},
        packet};
    }

    markSending(entry, nowMs) {
      entry.state = "sending";
      entry.attempts = Number(entry.attempts) + 1;
      entry.nextMs = Number(nowMs);
      this.save();
      return entry;
    }

    // The firmware answered. `ok` means the interface accepted the packet -- not
    // that APRS-IS took it, which only the logresp line can say.
    //
    // `transient` is the difference between "this failed" and "not now": the
    // interface refuses to open a socket while the transmitter is keyed, and
    // that refusal is routine in a 15-second JS8 cycle. Counting it as an
    // attempt used to burn the four-step ladder in under two minutes and drop a
    // position nothing had actually refused. A transient answer therefore costs
    // no attempt; the five-minute TTL is what stops it retrying for ever.
    noteSend(entry, {ok, seq = 0, sent = "", error = "", transient = false, nowMs}) {
      if (ok) {
        entry.state = "sent";
        entry.seq = Number(seq) || 0;
        entry.sent = String(sent || "");
        entry.reason = "";
        entry.sentMs = Number(nowMs);
        this.emit("sent", entry, entry.sent);
      } else if (transient) {
        entry.state = "queued";
        entry.attempts = Math.max(0, Number(entry.attempts) - 1);
        entry.reason = error || "not now";
        entry.nextMs = Number(nowMs) + RETRY_MS[0];
        this.emit("wait", entry, entry.reason);
      } else if (Number(entry.attempts) > RETRY_MS.length) {
        entry.state = "failed";
        entry.reason = error || "send failed";
        this.emit("fail", entry, entry.reason);
      } else {
        entry.state = "queued";
        entry.reason = error || "send failed";
        // attempts is 1 on the first failure, so index 0 is the first delay and
        // the last entry of the ladder is reachable -- it was not before.
        entry.nextMs = Number(nowMs) + RETRY_MS[Math.min(RETRY_MS.length - 1,
          Math.max(0, Number(entry.attempts) - 1))];
        this.emit("retry", entry, entry.reason);
      }
      this.save();
      return entry;
    }

    // The interface says this exact frame already went out -- from this browser
    // before a timed-out POST, or from another browser entirely, now that the
    // login lives in the shared station profile. Either way the packet is on the
    // network and the row should say so, under the seq that carried it, so the
    // verdict poll can still resolve it.
    noteDuplicate(entry, {seq = 0, nowMs}) {
      entry.state = "sent";
      entry.seq = Number(seq) || 0;
      entry.sentMs = Number(nowMs);
      // A flag and not only a reason: the verdict for that seq is still coming,
      // and it will legitimately turn this row green -- the frame IS on the
      // network. Without the flag the explanation of WHY this row never had a
      // packet of its own would be wiped by that verdict.
      entry.duplicate = true;
      entry.reason = "already gated by this station";
      this.emit("duplicate", entry, entry.reason);
      this.save();
      return entry;
    }

    // The server's answer to our login, fetched from /aprsis/status. `verified` is
    // the only state that counts towards the hourly total.
    noteStatus(entry, {state, server = "", line = "", nowMs}) {
      if (entry.state !== "sent") return entry;
      if (state === "verified") {
        entry.state = "verified";
        entry.server = String(server || "");
        if (!entry.duplicate) entry.reason = "";
        this.sentTimes.push(Number(nowMs));
        this.sentTimes = this.sentTimes.filter(time => time >= Number(nowMs) - 3600000);
        this.emit("verified", entry, entry.server);
      } else if (state === "unverified") {
        entry.state = "unverified";
        entry.server = String(server || "");
        entry.reason = line || "server refused the login";
        this.emit("unverified", entry, entry.reason);
      } else if (state === "error") {
        // The interface reports "error" only for work that never reached the
        // server -- a failed resolve or a refused connect -- so the packet is
        // still owed, not lost. Back into the queue behind the interface's own
        // backoff; the five-minute TTL is what ends it if the server stays down.
        entry.state = "queued";
        entry.reason = line || "interface could not reach the server";
        entry.nextMs = Number(nowMs) + RETRY_MS[0];
        this.emit("retry", entry, entry.reason);
      } else {
        return entry;   // still pending; the badge stays on "sent"
      }
      this.save();
      return entry;
    }

    // A queued packet older than the TTL is dropped rather than delivered late:
    // `=` has no timestamp, so a late position claims to be current.
    expire(nowMs) {
      let changed = false;
      for (const entry of this.entries) {
        if (entry.state !== "queued") continue;
        if (Number(nowMs) - Number(entry.createdMs) < this.ttlMs) continue;
        entry.state = "failed";
        entry.reason = "expired before it could be sent";
        this.emit("expire", entry, entry.reason);
        changed = true;
      }
      if (changed) this.save();
      return changed;
    }

    // Entries in "sent" are waiting for the server's verdict. Only the newest one
    // can be matched, because the firmware remembers a single last result.
    awaiting() {
      return this.entries.filter(entry => entry.state === "sent");
    }

    clear() {
      this.entries = [];
      this.sentTimes = [];
      this.index.clear();
      this.save();
    }
  }

  return {GROUP, STORAGE_KEY, DEFAULTS, TTL_MS, RETRY_MS, LOCATOR_RE, CMD_RE,
    MESSAGE_TEXT_LIMIT, ADDRESSEE_WIDTH, TOCALL, COMMENT_LIMIT,
    passcode, passcodeValid, suggestCall, normalizeConfig, readiness, describe, fieldSafe,
    addressee, gridToDegrees, gridToAprs, sourceCall, comment, frame, loginFrame,
    Js8AprsGate};
});
