// Periodic telemetry: TrxNet readings beaconed to a callsign or a @GROUP.
//
// The station's own LAN carries measurements nobody off it can see -- a weather
// head, an amplifier, a rotator, whatever else the operator built. This layer
// decides WHEN one of those turns into a JS8 message and WHAT it says. It never
// transmits and never touches the DOM, like the heartbeat and auto-reply engines
// beside it, so the whole of it runs under Node in the smoke test.
//
// Two rules shape everything below, and both are about not wasting a shared
// channel:
//
//   1. A message that would read exactly like the last one that went out is not
//      sent. The comparison is on the RENDERED TEXT, not the raw bytes, which is
//      what makes it right: a sensor jittering 21.234 -> 21.237 under a display
//      set to one decimal has not said anything new, and beaconing "TEMP 21.2C"
//      an hour after beaconing "TEMP 21.2C" is noise on somebody else's band.
//
//   2. A field whose source has gone quiet for longer than the job's own period
//      drops out of the message rather than riding along frozen. Rule 1 alone
//      does not cover this: when the thermometer dies but the hygrometer lives,
//      the message keeps changing and the dead temperature travels inside it
//      looking exactly like a fresh reading.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Telemetry = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {

  // Periods start at an hour. Telemetry is the one automatic transmission here
  // with no conversational purpose at all -- nobody is waiting for it -- so it
  // gets the most conservative schedule of anything on the page. The cap is per
  // JOB: three hourly jobs are three messages an hour, which is the operator's
  // airtime to spend, and the budget line in the panel says how much it is.
  const PERIOD_CHOICES_MIN = [60, 120, 180, 360, 720, 1440];
  const DEFAULT_PERIOD_MIN = 60;
  // Two jobs falling due in the same minute must not key back to back for four
  // solid minutes. This is a floor between telemetry messages only; it never
  // delays anything else on the page.
  const MIN_GAP_MS = 2 * 60000;
  // How long a queued telemetry message is still worth sending. Past this the
  // reading it carries is old enough that the next period's message is the
  // better one to wait for.
  const QUEUE_TTL_MS = 10 * 60000;
  const MAX_JOBS = 6;
  // Pills past this collapse into a "+N" tail; the header has to stay readable
  // on a tablet held in one hand.
  const MAX_JOB_PILLS = 4;
  const MAX_NAME_LEN = 6;
  const MAX_LABEL_LEN = 8;
  const MAX_UNIT_LEN = 4;

  const TYPES = ["uint8", "int8", "uint16", "int16", "uint32", "int32"];
  const DIVISORS = [1, 10, 100, 1000];

  // What this network publishes, transcribed from TrxNet's INTEGRATION.md topic
  // table. It is a STARTING POINT, not a law: every job field carries its own
  // type and divisor, and the catalogue only pre-fills them. A home-built board
  // publishing /temp as tenths is then a two-click correction rather than a
  // reason this feature cannot be used.
  const CATALOG = {
    "/hz":        {type: "uint32", div: 1,   unit: "HZ",  dec: 0, label: "FREQ"},
    "/temp":      {type: "int16",  div: 100, unit: "C",   dec: 1, label: "TEMP"},
    "/hum":       {type: "uint16", div: 100, unit: "%",   dec: 0, label: "HUM"},
    "/press":     {type: "uint16", div: 10,  unit: "HPA", dec: 0, label: "PRESS"},
    "/rain":      {type: "uint16", div: 100, unit: "MM",  dec: 1, label: "RAIN"},
    "/winddir":   {type: "uint16", div: 1,   unit: "DEG", dec: 0, label: "DIR"},
    "/windavg":   {type: "uint16", div: 100, unit: "M/S", dec: 1, label: "WIND"},
    "/windmax":   {type: "uint16", div: 100, unit: "M/S", dec: 1, label: "GUST"},
    "/fwd":       {type: "uint16", div: 10,  unit: "W",   dec: 0, label: "FWD"},
    "/ref":       {type: "uint16", div: 10,  unit: "W",   dec: 0, label: "REF"},
    "/swr":       {type: "uint16", div: 100, unit: "",    dec: 2, label: "SWR"},
    "/band":      {type: "uint8",  div: 1,   unit: "M",   dec: 0, label: "BAND"},
    "/pa-temp":   {type: "int16",  div: 100, unit: "C",   dec: 1, label: "PATEMP"},
    "/azimuth":   {type: "uint16", div: 1,   unit: "DEG", dec: 0, label: "AZ"},
    "/elevation": {type: "uint16", div: 1,   unit: "DEG", dec: 0, label: "EL"}
  };

  // The characters a JS8 data frame can actually carry, from Varicode's JSC
  // literal table (js8-protocol.js). Worth spelling out rather than trusting:
  // "%" IS in here, so a humidity unit costs only a wider dense codeword -- but
  // "°" is NOT, and packData stops at the first character it cannot encode, so a
  // unit typed as "°C" would silently truncate the message from that point on.
  const JS8_TEXT_RE = /^[0-9A-Z ,.\-+"'?!()=:_/&$%#@*><\[\]{}|;^`~\\]*$/;

  const clampInt = (value, low, high, fallback) => {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
  };

  const catalogFor = topic => CATALOG[String(topic || "")] || null;

  // ---- decoding -------------------------------------------------------------

  // Raw wire bytes as hex (little-endian, exactly as TrxNet sent them) to a number.
  // Returns null for anything it cannot read, and the caller treats that the same
  // way it treats a missing reading -- there is no "0" fallback here, because 0 is
  // a perfectly ordinary temperature and must never be invented.
  function decodeRaw(hex, type) {
    const text = String(hex || "").trim().toUpperCase();
    if (!text || text.length % 2) return null;
    if (!/^[0-9A-F]+$/.test(text)) return null;
    const bytes = [];
    for (let i = 0; i < text.length; i += 2)
      bytes.push(parseInt(text.slice(i, i + 2), 16));
    const width = {uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4}[type];
    if (!width || bytes.length < width) return null;
    let value = 0;
    for (let i = width - 1; i >= 0; i -= 1) value = value * 256 + bytes[i];
    if (type[0] === "i") {
      const limit = Math.pow(2, width * 8 - 1);
      if (value >= limit) value -= limit * 2;
    }
    return value;
  }

  // Raw hex to the text that goes on the air: scaled, rounded, unit glued on.
  // The unit sits hard against the digits ("21.3C", not "21.3 C") because every
  // saved character is real airtime -- a JS8 data frame holds about ten.
  function formatValue(hex, {type, div, dec, unit} = {}) {
    const raw = decodeRaw(hex, type);
    if (raw === null) return null;
    const divisor = DIVISORS.includes(Number(div)) ? Number(div) : 1;
    const places = clampInt(dec, 0, 3, 0);
    const scaled = raw / divisor;
    if (!Number.isFinite(scaled)) return null;
    return scaled.toFixed(places) + String(unit || "");
  }

  // Is this text safe to hand to the JS8 encoder? Uppercased first, because the
  // encoder uppercases anyway and refusing "m/s" would be refusing the thing the
  // operator meant.
  function validateText(text) {
    return JS8_TEXT_RE.test(String(text || "").toUpperCase());
  }

  function normalizeField(input) {
    const field = input && typeof input === "object" ? input : {};
    const topic = String(field.topic || "").trim();
    const cat = catalogFor(topic) || {};
    const label = String(field.label != null ? field.label : (cat.label || ""))
      .toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, MAX_LABEL_LEN);
    const unitRaw = String(field.unit != null ? field.unit : (cat.unit || ""))
      .toUpperCase().slice(0, MAX_UNIT_LEN);
    return {
      peer: String(field.peer || "").trim(),
      topic,
      label,
      unit: validateText(unitRaw) ? unitRaw : "",
      type: TYPES.includes(field.type) ? field.type : (cat.type || "uint16"),
      div: DIVISORS.includes(Number(field.div)) ? Number(field.div)
        : (cat.div != null ? cat.div : 1),
      dec: clampInt(field.dec, 0, 3, cat.dec != null ? cat.dec : 0)
    };
  }

  function normalizeJob(input, index = 0) {
    const job = input && typeof input === "object" ? input : {};
    const periodMin = PERIOD_CHOICES_MIN.includes(Number(job.periodMin))
      ? Number(job.periodMin) : DEFAULT_PERIOD_MIN;
    return {
      id: String(job.id || `tlm${index + 1}`).slice(0, 16),
      name: String(job.name || `TLM${index + 1}`).toUpperCase()
        .replace(/[^A-Z0-9]/g, "").slice(0, MAX_NAME_LEN) || `TLM${index + 1}`,
      enabled: job.enabled === true,
      to: String(job.to || "").toUpperCase().trim(),
      periodMin,
      fields: (Array.isArray(job.fields) ? job.fields : [])
        .map(normalizeField).filter(field => field.topic && field.peer).slice(0, 8)
    };
  }

  function normalizeJobs(input) {
    return (Array.isArray(input) ? input : []).slice(0, MAX_JOBS).map(normalizeJob);
  }

  // ---- what a job would say right now ---------------------------------------

  // snapshot is /trxnet-topics.json as delivered: {topics:[{p,t,v,a}]}, `a` being
  // the reading's age in seconds. Returns the text plus the fields that were left
  // out, so the panel can say WHY a message got shorter instead of just showing a
  // shorter message.
  function renderJob(job, snapshot) {
    const normalized = normalizeJob(job);
    const rows = (snapshot && Array.isArray(snapshot.topics)) ? snapshot.topics : [];
    const staleAfterS = normalized.periodMin * 60;
    const parts = [], used = [], dropped = [];
    for (const field of normalized.fields) {
      const row = rows.find(entry => entry && entry.p === field.peer && entry.t === field.topic);
      if (!row) { dropped.push({...field, reason: "never heard"}); continue; }
      if (Number(row.a) > staleAfterS) {
        dropped.push({...field, reason: `silent for ${Math.round(Number(row.a) / 60)} min`});
        continue;
      }
      const text = formatValue(row.v, field);
      if (text === null) { dropped.push({...field, reason: "undecodable"}); continue; }
      const piece = field.label ? `${field.label} ${text}` : text;
      parts.push(piece);
      used.push({...field, value: text});
    }
    return {text: parts.join(" "), fields: used, dropped};
  }

  // ---- the scheduler --------------------------------------------------------

  class Js8Telemetry {
    constructor({onEvent = null} = {}) {
      this.onEvent = onEvent;
      this.enabled = false;
      this.jobs = [];
      // Per job: {dueMs, sent, lastText}. Kept out of the job definitions on
      // purpose -- definitions are shared station-wide through the profile, this
      // is one browser's running state and belongs in its own localStorage key.
      this.state = new Map();
      this.lastSendMs = null;
    }

    _emit(event) { if (this.onEvent) this.onEvent(event); }

    _stateFor(id) {
      if (!this.state.has(id)) this.state.set(id, {dueMs: null, sent: 0, lastText: ""});
      return this.state.get(id);
    }

    // Restores what survived a reload. Anything already overdue is pulled to one
    // period from now rather than fired at once: a browser coming back from a
    // refresh must not key the moment it finishes loading.
    restore(runtime, nowMs = 0) {
      const source = runtime && typeof runtime === "object" ? runtime : {};
      this.enabled = source.enabled === true;
      const jobs = source.jobs && typeof source.jobs === "object" ? source.jobs : {};
      for (const [id, saved] of Object.entries(jobs)) {
        const entry = this._stateFor(id);
        entry.sent = clampInt(saved && saved.sent, 0, 1e6, 0);
        entry.lastText = String((saved && saved.lastText) || "");
        const due = Number(saved && saved.dueMs);
        entry.dueMs = Number.isFinite(due) ? due : null;
      }
      this.configure(this.jobs, nowMs);
      return this;
    }

    snapshotRuntime() {
      const jobs = {};
      for (const [id, entry] of this.state)
        jobs[id] = {dueMs: entry.dueMs, sent: entry.sent, lastText: entry.lastText};
      return {enabled: this.enabled, jobs};
    }

    setEnabled(enabled, nowMs = 0) {
      this.enabled = enabled === true;
      this.configure(this.jobs, nowMs);
      return this.enabled;
    }

    // Arms every runnable job that is not armed yet and disarms the rest. A job
    // that is already armed keeps its schedule, so editing a label does not
    // reset an hour of waiting.
    configure(jobs, nowMs = 0) {
      this.jobs = normalizeJobs(jobs);
      const live = new Set(this.jobs.map(job => job.id));
      for (const id of [...this.state.keys()])
        if (!live.has(id)) this.state.delete(id);
      for (const job of this.jobs) {
        const entry = this._stateFor(job.id);
        const runnable = this.enabled && job.enabled && job.to && job.fields.length > 0;
        if (!runnable) { entry.dueMs = null; continue; }
        if (entry.dueMs === null) entry.dueMs = nowMs + job.periodMin * 60000;
        else if (entry.dueMs < nowMs) entry.dueMs = nowMs + job.periodMin * 60000;
      }
      return this.jobs;
    }

    dueInMs(id, nowMs = 0) {
      const entry = this.state.get(id);
      if (!entry || entry.dueMs === null) return null;
      return Math.max(0, entry.dueMs - nowMs);
    }

    // The job to send now, or null. Honours the floor between two telemetry
    // messages; when several are due at once the earliest-scheduled one wins and
    // the others come back two minutes later.
    dueJob(nowMs = 0) {
      if (!this.enabled) return null;
      if (this.lastSendMs !== null && nowMs - this.lastSendMs < MIN_GAP_MS) return null;
      let best = null, bestDue = Infinity;
      for (const job of this.jobs) {
        const entry = this.state.get(job.id);
        if (!entry || entry.dueMs === null || entry.dueMs > nowMs) continue;
        if (entry.dueMs < bestDue) { best = job; bestDue = entry.dueMs; }
      }
      return best;
    }

    // Called when the message has been handed to the TX queue. The period is
    // re-armed HERE rather than on completion, so a message stuck behind a long
    // QSO cannot come due a second time and queue twice.
    noteQueued(id, nowMs = 0) {
      const job = this.jobs.find(entry => entry.id === id);
      const entry = this._stateFor(id);
      entry.dueMs = nowMs + (job ? job.periodMin : DEFAULT_PERIOD_MIN) * 60000;
      this.lastSendMs = nowMs;
      return entry.dueMs;
    }

    // A job that came due and decided not to speak -- nothing changed, or every
    // reading had gone stale. The period is re-armed so it does not re-ask every
    // five seconds, but lastSendMs is deliberately NOT touched: no air time was
    // spent, so nothing else should have to wait two minutes for it.
    noteSkipped(id, nowMs = 0) {
      const job = this.jobs.find(entry => entry.id === id);
      const entry = this._stateFor(id);
      entry.dueMs = nowMs + (job ? job.periodMin : DEFAULT_PERIOD_MIN) * 60000;
      return entry.dueMs;
    }

    // Called only once the transmission actually finished. The counter and the
    // text to compare against next time move together and only here: a message
    // that failed on the air must not consume the change that prompted it, or
    // the reading would go unreported until it happened to change again.
    noteSent(id, text, nowMs = 0) {
      const entry = this._stateFor(id);
      entry.sent += 1;
      entry.lastText = String(text || "");
      this._emit({type: "sent", id, text: entry.lastText, nowMs});
      return entry.sent;
    }

    // Decides a due job's fate in one place so the page and the test see the same
    // reasoning. `force` is the operator pressing SEND NOW: it skips the
    // unchanged check (otherwise a correctly configured job could never be tried)
    // but nothing else -- the TX gate and the pledge still apply, upstream.
    evaluate(job, snapshot, {force = false} = {}) {
      const normalized = normalizeJob(job);
      const entry = this._stateFor(normalized.id);
      if (!normalized.to) return {send: false, reason: "no recipient"};
      if (!normalized.fields.length) return {send: false, reason: "no fields"};
      const rendered = renderJob(normalized, snapshot);
      if (!rendered.text) return {send: false, reason: "no fresh readings", ...rendered};
      if (!force && rendered.text === entry.lastText)
        return {send: false, reason: "unchanged", ...rendered};
      return {send: true, to: normalized.to, ...rendered};
    }

    // What the pills read. `sent` totals across jobs, `dueInMs` is the nearest
    // one, because the header answers "when does this station next transmit?".
    snapshot(nowMs = 0) {
      const jobs = this.jobs.map(job => {
        const entry = this._stateFor(job.id);
        return {id: job.id, name: job.name, enabled: job.enabled,
          sent: entry.sent, dueInMs: this.dueInMs(job.id, nowMs),
          lastText: entry.lastText};
      });
      const due = jobs.map(job => job.dueInMs).filter(value => value !== null);
      return {enabled: this.enabled, jobs,
        sent: jobs.reduce((total, job) => total + job.sent, 0),
        dueInMs: due.length ? Math.min(...due) : null};
    }
  }

  return {Js8Telemetry, renderJob, formatValue, decodeRaw, validateText,
    normalizeJob, normalizeJobs, normalizeField, catalogFor,
    CATALOG, TYPES, DIVISORS, PERIOD_CHOICES_MIN, DEFAULT_PERIOD_MIN,
    MIN_GAP_MS, QUEUE_TTL_MS, MAX_JOBS, MAX_JOB_PILLS, MAX_NAME_LEN};
});
