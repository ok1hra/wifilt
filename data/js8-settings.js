// PROTOTYPE — versioned, validated settings store for the compact JS8 UI.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Settings = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const STORAGE_KEY = "wifilt.data.js8-settings";
  const SCHEMA_VERSION = 10;
  // Frequency timetable: 48 half-hour UTC slots (index 0 = 00:00, 47 = 23:30).
  // Global to the station (one radio), independent of the active modem.
  const TIMETABLE_SLOTS = 48;
  const TIMETABLE_MIN_HZ = 1000;
  const TIMETABLE_MAX_HZ = 470000000;
  const MODEMS = ["js8call", "rtty45", "psk31", "ft8", "ft4", "cw"];
  const SPEEDS = ["AUTO", "A", "B", "C", "E", "I"];
  const DISCLOSURES = ["spectrum", "reply", "traffic", "stations", "inbox",
    "settings", "timing"];
  // Must match UNATTENDED_ARM_CHOICES_H in unattended_guard.h.
  const ARM_HOURS = [1, 6, 12, 24, 168];
  // Must match INTERVAL_CHOICES_MS in js8-heartbeat.js.
  const HB_MINUTES = [5, 10, 15, 30, 60];
  // @ALLCALL and @HB are always joined: the first is how anyone addresses
  // everybody, the second is what makes the heartbeat network work at all.
  const ALWAYS_GROUPS = ["@ALLCALL", "@HB"];
  // @ plus up to eight characters is not an arbitrary limit: the compound frame packs
  // eleven characters with two of them reserved as separators, so nine is everything
  // that survives a round trip on the air.
  const GROUP_RE = /^@[A-Z0-9/]{1,8}$/;
  // Gateways, not nets. Upstream refuses to join these too (Varicode::isGroupAllowed):
  // they answer to a server, so a station calling itself a member would be lying.
  const RESERVED_GROUPS = ["@APRSIS", "@JS8NET"];
  // Used only when js8-aprs-gate.js is not on the page (wspr.html). The gate owns
  // the real defaults; this is the shape a profile written without it must keep.
  const APRSIS_FALLBACK = {enabled: false, call: "", passcode: "",
    host: "czech.aprs2.net", port: 14580, maxPerHour: 30, dedupMinutes: 10};
  const MAX_GROUPS = 8;
  // Minutes between repeated CQ calls; 0 means the repeat is off.
  const CQ_REPEAT_MIN = [0, 2, 5, 10, 15];
  // What this station answers to STATUS?. A menu rather than a bare field: the page
  // is operated from a tablet, where typing forty characters is the worst possible
  // input for a value that changes twice a year, and the list doubles as the
  // documentation of what is worth saying. Entries are kept short on purpose --
  // roughly fourteen characters buy another frame, so a chatty status costs fifteen
  // seconds of air time on every single answer.
  const STATUS_PRESETS = ["AUTO STATION UNATTENDED", "MONITORING", "QRV FOR QSO",
    "QRT SOON"];
  // Sentinels for the two menu entries that are not literal answers. Upstream solves
  // the same problem with a macro language (<MYIDLE> and friends, expanded at send
  // time); STATUS_AUTO buys the one dynamic value we can honestly derive -- the
  // arming window -- without teaching the operator that angle brackets mean
  // something. '#' is outside the character whitelist applied to a stored answer, so
  // neither sentinel can ever collide with one.
  const STATUS_AUTO = "#auto";
  const STATUS_CUSTOM = "#custom";

  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, low, high, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
  };

  // Splits a group list the way the operator typed it and says WHY an entry was
  // refused, instead of dropping it silently the way this field used to. `sendable`,
  // when supplied, is the set of names this build can actually put on the air: a
  // well-formed name outside it would otherwise be joinable but never transmittable,
  // which is exactly the inconsistency that made this rewrite necessary.
  function validateGroups(input, sendable = null) {
    const raw = Array.isArray(input) ? input : String(input || "").split(/[\s,]+/);
    const allowed = sendable
      ? new Set([...sendable].map(group => String(group).toUpperCase())) : null;
    const groups = [], rejected = [];
    for (const entry of raw) {
      const trimmed = String(entry || "").toUpperCase().trim();
      if (!trimmed) continue;
      const group = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      if (groups.includes(group)) continue;
      if (!GROUP_RE.test(group))
        rejected.push({value: group, reason: "not a group name: @ plus up to 8 of A-Z 0-9 /"});
      else if (RESERVED_GROUPS.includes(group))
        rejected.push({value: group, reason: "a gateway, not a net — it cannot be joined"});
      else if (ALWAYS_GROUPS.includes(group))
        rejected.push({value: group, reason: "always joined, listing it changes nothing"});
      else if (allowed && !allowed.has(group))
        // "a second frame" was the first wording here and it read as "a second window".
        // Say the cost in the thing the operator actually spends: air time.
        rejected.push({value: group,
          reason: "not one of the built-in group names — a custom one costs an extra 15 s of air time on every message and is not supported yet"});
      else if (groups.length >= MAX_GROUPS)
        rejected.push({value: group, reason: `at most ${MAX_GROUPS} groups`});
      else groups.push(group);
    }
    return {groups, rejected};
  }

  function defaults() {
    return {schemaVersion: SCHEMA_VERSION, activeModem: "js8call",
      modems: {js8call: {myCall: "", grid: "", speed: "AUTO",
        txOffsetHz: 1500, clockCorrectionMs: 0, autoTiming: true,
        followSpeed:true, txGain:0.25, txSafetyAccepted:false,
        // Unattended operation. `auto` is the operator's switch; `armHours` is
        // how long it stays on before the firmware lets it lapse by itself.
        // A fresh profile answers STATUS? out of the box, the way upstream does with
        // its "IDLE ... VERSION ..." default. An existing profile keeps whatever is
        // stored, including an empty answer: turning transmission on for a station
        // that was silent is not a decision an upgrade gets to make.
        auto:false, armHours:1, infoText:"", statusText:STATUS_PRESETS[0],
        statusAuto:false,
        // A short tone when a directed frame arrives for us. Off by default: the
        // page is meant to be left running for days next to a radio that is
        // already making noise, so a sound nobody asked for is a regression on
        // every existing installation. No schema bump is needed -- an absent key
        // normalises to false, which is the default anyway.
        alertBeep:false,
        hb:false, hbAck:true, hbMinutes:60, groups:[], cqRepeatMin:0,
        // Percent of the radio's CI-V power scale, written on page open and
        // after a reconnect. null means the operator has never chosen, and
        // that is what keeps the page from writing power to a radio nobody
        // asked it to touch -- unlike WSPR there is no naturally safe value
        // to propose, because a QSO mode has no beacon-sized opening bid.
        rfPercent:null}},
      ui: {disclosures: {spectrum: true, reply: true, traffic: false,
        stations: false, inbox: false, settings: false, timing: false}},
      // The APRS-IS gate. It lives in the profile and not in SETUP because it is
      // a JS8 function: it only ever acts on @APRSIS traffic this modem decoded.
      // The profile is SHARED -- it is pushed to the interface and read back by
      // every browser that opens DATA -- so configuring the gate once configures
      // it for the station, and every one of those browsers is then a gate. That
      // is why the duplicate check and the hourly cap are enforced on the device
      // and not here: a per-browser cap is no cap, and two tabs would otherwise
      // publish one position twice.
      // Off by default, and deliberately: an upgrade must never start publishing
      // other stations' positions under this callsign on its own.
      aprsis: normalizeAprsis(null, APRSIS_FALLBACK),
      // Sparse schedule: only the slots the operator filled are stored. `enabled`
      // is the ON/OFF switch that lets the browser apply changes on slot bounds.
      freqTimetable: {enabled: false, slots: {}}};
  }

  // Keeps only well-formed, in-range slots. Each value is {hz, band?} -- `band`
  // is a short display label (present for presets, absent for custom entries).
  function normalizeTimetable(input) {
    const source = input && typeof input === "object" ? input : {};
    const rawSlots = source.slots && typeof source.slots === "object" ? source.slots : {};
    const slots = {};
    for (let index = 0; index < TIMETABLE_SLOTS; index++) {
      const value = rawSlots[index] ?? rawSlots[String(index)];
      if (!value || typeof value !== "object") continue;
      const hz = Math.round(Number(value.hz));
      if (!Number.isFinite(hz) || hz < TIMETABLE_MIN_HZ || hz > TIMETABLE_MAX_HZ) continue;
      const band = typeof value.band === "string" && value.band.trim()
        ? value.band.trim().slice(0, 8) : null;
      slots[index] = band ? {hz, band} : {hz};
    }
    return {enabled: source.enabled === true, slots};
  }

  // The APRS-IS gate's rules live in ONE place: data/js8-aprs-gate.js. This store
  // does not re-implement them, it asks -- because two copies of "what a valid
  // APRS-IS callsign is" drift, and the copy that loses is whichever one nobody
  // is looking at.
  //
  // The module is not always there: js8-settings.js also runs on wspr.html,
  // which has no gate. A page that cannot validate this branch must not rewrite
  // it either, so it is carried through untouched -- and that is safe because
  // the gate normalises again at the point of use, which is the only moment the
  // values become a TCP connection under the operator's callsign.
  function normalizeAprsis(input, fallback) {
    const gate = typeof globalThis !== "undefined" && globalThis.Js8AprsGate;
    if (gate && typeof gate.normalizeConfig === "function")
      return gate.normalizeConfig(input);
    return input && typeof input === "object" ? {...input} : {...fallback};
  }

  function normalize(input) {
    const fallback = defaults();
    const source = input && typeof input === "object" ? input : {};
    const js8 = source.modems && source.modems.js8call || {};
    const call = String(js8.myCall ?? fallback.modems.js8call.myCall)
      .toUpperCase().replace(/[^A-Z0-9/]/g, "").slice(0, 12);
    const gridCandidate = String(js8.grid ?? fallback.modems.js8call.grid)
      .toUpperCase().trim();
    const grid = /^[A-R]{2}[0-9]{2}(?:[A-X]{2})?$/.test(gridCandidate)
      ? gridCandidate : fallback.modems.js8call.grid;
    const speed = SPEEDS.includes(js8.speed) ? js8.speed : "AUTO";
    const disclosures = {};
    for (const key of DISCLOSURES)
      disclosures[key] = typeof source.ui?.disclosures?.[key] === "boolean"
        ? source.ui.disclosures[key] : fallback.ui.disclosures[key];
    return {schemaVersion: SCHEMA_VERSION,
      activeModem: MODEMS.includes(source.activeModem)
        ? source.activeModem : "js8call",
      modems: {js8call: {myCall: call, grid,
        speed, txOffsetHz: Math.round(clamp(js8.txOffsetHz, 500, 2700, 1500)),
        clockCorrectionMs: Math.round(clamp(js8.clockCorrectionMs,
          -1000, 1000, 0)), autoTiming: js8.autoTiming !== false,
        followSpeed:js8.followSpeed !== false,
        txGain:clamp(js8.txGain, 0.1, 0.8, 0.25),
        txSafetyAccepted:js8.txSafetyAccepted === true,
        auto:js8.auto === true,
        alertBeep:js8.alertBeep === true,
        armHours:ARM_HOURS.includes(Number(js8.armHours)) ? Number(js8.armHours) : 1,
        // Free text answered to INFO?/STATUS?; kept short so the reply fits
        // one frame, and stripped of characters the protocol cannot pack.
        infoText:String(js8.infoText ?? "").toUpperCase()
          .replace(/[^A-Z0-9 ./?+-]/g, "").slice(0, 40).trim(),
        statusText:String(js8.statusText ?? "").toUpperCase()
          .replace(/[^A-Z0-9 ./?+-]/g, "").slice(0, 40).trim(),
        // The composed answer is a marker, not a text: `statusText` stays whatever the
        // operator last chose by hand, so switching the menu back does not lose it.
        // An absent key normalises to false, which is the default -- no schema bump.
        statusAuto:js8.statusAuto === true,
        hb:js8.hb === true, hbAck:js8.hbAck !== false,
        hbMinutes:HB_MINUTES.includes(Number(js8.hbMinutes)) ? Number(js8.hbMinutes) : 60,
        // Custom groups only; the always-joined ones are added at use time so a
        // stored profile can never accidentally drop them. Deliberately validated
        // WITHOUT the sendable list: which names this build can transmit to changes
        // between stages, and a stored profile must not be silently emptied by it.
        groups:validateGroups(Array.isArray(js8.groups) ? js8.groups : []).groups,
        cqRepeatMin:CQ_REPEAT_MIN.includes(Number(js8.cqRepeatMin)) ? Number(js8.cqRepeatMin) : 0,
        // Only 1..100 is settable: the radio's step is one percent, so a
        // stored 0.5 would be written as something else entirely.
        rfPercent:Number.isFinite(Number(js8.rfPercent)) && Number(js8.rfPercent) >= 1
          ? Math.min(100, Math.round(Number(js8.rfPercent))) : null}},
      ui: {disclosures},
      aprsis: normalizeAprsis(source.aprsis, fallback.aprsis),
      freqTimetable: normalizeTimetable(source.freqTimetable)};
  }

  function migrate(input) {
    if (!input || typeof input !== "object")
      return {settings: defaults(), status: "invalid"};
    if (input.schemaVersion === SCHEMA_VERSION)
      return {settings: normalize(input), status: "loaded"};
    if (input.schemaVersion === 1 || input.version === 1) {
      return {settings: normalize({activeModem: input.activeModem,
        modems: {js8call: {myCall: input.myCall, grid: input.grid,
          speed: input.speed, txOffsetHz: input.txOffsetHz,
          clockCorrectionMs: input.clockCorrectionMs,
          autoTiming: input.autoTiming}},
        ui: {disclosures: input.disclosures}}), status: "migrated-v1"};
    }
    if (input.schemaVersion === 2)
      return {settings:normalize(input), status:"migrated-v2"};
    if (input.schemaVersion === 3)
      return {settings:normalize(input), status:"migrated-v3"};
    if (input.schemaVersion === 4)
      return {settings:normalize(input), status:"migrated-v4"};
    if (input.schemaVersion === 5)
      return {settings:normalize(input), status:"migrated-v5"};
    if (input.schemaVersion === 6)
      return {settings:normalize(input), status:"migrated-v6"};
    if (input.schemaVersion === 7)
      return {settings:normalize(input), status:"migrated-v7"};
    // v8 -> v9 moves the heartbeat interval to 60 minutes, and does it to stored
    // profiles too rather than only to the default. A stored 15 cannot be told
    // apart from v8's own default -- the same trap the WSPR settings hit with
    // powerDbm -- so leaving it alone would mean the new interval never reaches
    // anyone who has ever opened the page. One selection in the menu undoes it.
    if (input.schemaVersion === 8) {
      const migrated = normalize(input);
      migrated.modems.js8call.hbMinutes = 60;
      return {settings:migrated, status:"migrated-v8"};
    }
    // v9 -> v10 only adds the APRS-IS gate, and normalize() fills it from the
    // defaults -- which have it switched off. Unlike the v8 heartbeat migration
    // there is nothing here to rewrite in a stored profile: starting to publish
    // other stations' positions is not a decision an upgrade gets to make.
    if (input.schemaVersion === 9)
      return {settings:normalize(input), status:"migrated-v9"};
    if (Number(input.schemaVersion) > SCHEMA_VERSION)
      return {settings: defaults(), status: "unsupported-future"};
    return {settings: defaults(), status: "invalid"};
  }

  function label(status) {
    return ({default: "Defaults · not saved", loaded: "Saved locally",
      saved: "Saved locally", reset: "Defaults restored",
      "migrated-v9": "Migrated from schema v9",
      "migrated-v8": "Migrated from schema v8",
      "migrated-v1": "Migrated from schema v1",
      "migrated-v2": "Migrated from schema v2",
      "migrated-v3": "Migrated from schema v3",
      "migrated-v4": "Migrated from schema v4",
      "migrated-v5": "Migrated from schema v5",
      "migrated-v6": "Migrated from schema v6",
      "migrated-v7": "Migrated from schema v7",
      corrupt: "Invalid saved data · defaults used",
      invalid: "Invalid saved data · defaults used",
      "unsupported-future": "Newer schema ignored",
      "storage-unavailable": "Storage unavailable"})[status] || status;
  }

  function load(storage) {
    try {
      const raw = storage && storage.getItem(STORAGE_KEY);
      if (!raw) return {settings: defaults(), status: "default",
        label: label("default")};
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (_error) {
        return {settings: defaults(), status: "corrupt", label: label("corrupt")};
      }
      const result = migrate(parsed);
      if (result.status.startsWith("migrated-"))
        storage.setItem(STORAGE_KEY, JSON.stringify(result.settings));
      return {...result, label: label(result.status)};
    } catch (_error) {
      return {settings: defaults(), status: "storage-unavailable",
        label: label("storage-unavailable")};
    }
  }

  function save(storage, input) {
    const settings = normalize(input);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(settings));
      return {settings, status: "saved", label: label("saved")};
    } catch (_error) {
      return {settings, status: "storage-unavailable",
        label: label("storage-unavailable")};
    }
  }

  function reset(storage) {
    try { storage.removeItem(STORAGE_KEY); }
    catch (_error) {
      return {settings: defaults(), status: "storage-unavailable",
        label: label("storage-unavailable")};
    }
    return {settings: defaults(), status: "reset", label: label("reset")};
  }

  return {STORAGE_KEY, SCHEMA_VERSION, ARM_HOURS, HB_MINUTES, CQ_REPEAT_MIN,
    STATUS_PRESETS, STATUS_AUTO, STATUS_CUSTOM, ALWAYS_GROUPS,
    RESERVED_GROUPS, MAX_GROUPS, GROUP_RE, validateGroups,
    TIMETABLE_SLOTS, TIMETABLE_MIN_HZ, TIMETABLE_MAX_HZ, normalizeTimetable,
    defaults, normalize, migrate, load, save, reset, clone};
});
