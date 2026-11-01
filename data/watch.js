// WATCH viewer: follow the data page of whoever holds the radio.
//
// The binary (watch_hub.h, PC build only) relays what the holder's page
// publishes -- a snapshot per role, and the RTTY/JTTY text it streams anyway --
// over /watchws on the audio port, plus, on request, a copy of the RX audio
// that this page turns into its own waterfall. Nothing here decodes, tunes,
// transmits or touches the session: this page only ever opens /watchws and
// reads /health.json, and tools/watch-page-smoke.js holds it to that.

(function () {
  "use strict";

  const ROLES = ["js8", "wspr", "rtty", "jtty", "mercury"];
  const ROLE_NAMES = {js8: "JS8", wspr: "WSPR", rtty: "RTTY", jtty: "JTTY", mercury: "Mercury"};
  // Waterfall window per mode, in audio Hz.
  const RANGES = {js8: [500, 2700], wspr: [1350, 1650], rtty: [300, 2700], jtty: [300, 2700], mercury: [300, 2700]};
  const TAPE_MAX_CHARS = 12000;
  const JTTY_MAX_MESSAGES = 200;
  // The binary sends a status line every 5 s; three missed means the link is dead
  // even if TCP has not noticed.
  const SILENCE_MS = 15000;
  const SAMPLE_RATE = 8000;

  const $ = id => document.getElementById(id);
  const dom = {link: $("link"), holder: $("holder"), viewers: $("viewers"), notice: $("notice"),
    tabs: $("tabs"), stamp: $("stamp"), view: $("view"), waterfall: $("waterfall"),
    canvas: $("waterfallCanvas"), overlay: $("waterfallOverlay"), scaleLow: $("scaleLow"),
    scaleHigh: $("scaleHigh"), waterfallToggle: $("waterfallToggle"), listenToggle: $("listenToggle"),
    audioState: $("audioState")};

  const state = {
    socket: null, connected: false, retryMs: 1000, retryTimer: null, lastMessageMs: 0,
    hello: null, holder: {held: false}, viewers: 0,
    snapshots: {},                       // role -> {data, atMs}
    rtty: {r1: [], r2: []},              // segments {text, tx}
    jtty: [], jttyOpen: new Map(),       // newest first; open messages by id
    tab: null, pinnedFor: null,          // a clicked tab holds until the holder's role changes
    audio: {wanted: false, expected: null, stream: 0},
    renderQueued: false,
  };

  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g,
    c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
  const utc = ms => ms > 0 ? new Date(ms).toISOString().slice(11, 19) : "--:--:--";
  const mhz = hz => hz > 0 ? (hz / 1e6).toFixed(6).replace(/(\.\d{3})(\d{3})$/, "$1.$2") : "—";
  const signed = value => Number.isFinite(Number(value)) && value !== null
    ? `${Number(value) >= 0 ? "+" : ""}${Math.round(Number(value))}` : "—";
  function age(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - Number(ms || 0)) / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  // ── Locator maths (WSPR spots carry a grid, not a position) ────────────────
  function locatorToLatLon(locator) {
    const grid = String(locator || "").trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(grid)) return null;
    let lon = (grid.charCodeAt(0) - 65) * 20 - 180 + Number(grid[2]) * 2;
    let lat = (grid.charCodeAt(1) - 65) * 10 - 90 + Number(grid[3]);
    if (grid.length === 6) {
      lon += (grid.charCodeAt(4) - 65) * 5 / 60 + 2.5 / 60;
      lat += (grid.charCodeAt(5) - 65) * 2.5 / 60 + 1.25 / 60;
    } else { lon += 1; lat += .5; }
    return {lat, lon};
  }
  function qrbAzimuth(from, to) {
    const rad = Math.PI / 180, lat1 = from.lat * rad, lat2 = to.lat * rad, dLon = (to.lon - from.lon) * rad;
    const cosC = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const km = 6371 * Math.acos(Math.max(-1, Math.min(1, cosC)));
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return {km: Math.round(km), az: Math.round((Math.atan2(y, x) / rad + 360) % 360)};
  }

  // ── Waterfall and listening ────────────────────────────────────────────────
  const ULAW = new Float32Array(256);
  for (let index = 0; index < 256; index++) {
    const u = ~index & 0xff;
    const sample = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7)) - 0x84;
    ULAW[index] = ((u & 0x80) ? -sample : sample) / 32768;
  }

  // The AUD1 RX envelope (docs/aud1-audio-websocket-protocol.md), read only as
  // far as this page needs it.
  function parseAud1(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 40 || bytes[0] !== 65 || bytes[1] !== 85 || bytes[2] !== 68 || bytes[3] !== 49 ||
        bytes[4] !== 1 || bytes[5] !== 1) return null;
    const view = new DataView(buffer);
    if (view.getUint32(36, false) !== bytes.length - 40) return null;
    return {flags: view.getUint16(6, false), streamId: view.getUint32(12, false),
      firstSample: Number(view.getBigUint64(24, false)), payload: bytes.subarray(40)};
  }

  let waterfall = null;
  function ensureWaterfall() {
    if (waterfall || !globalThis.Spectrum) return waterfall;
    const [low, high] = RANGES[state.tab] || RANGES.js8;
    waterfall = new Spectrum.Waterfall({canvas: dom.canvas, overlay: dom.overlay, container: dom.waterfall,
      sampleRate: SAMPLE_RATE, lowHz: low, highHz: high, fftSize: 4096, hopSize: 1024, height: 96});
    waterfall.resize();
    return waterfall;
  }
  function applyRange() {
    const [low, high] = RANGES[state.tab] || RANGES.js8;
    dom.scaleLow.textContent = `${low} Hz`;
    dom.scaleHigh.textContent = `${high} Hz`;
    if (waterfall && (waterfall.lowHz !== low || waterfall.highHz !== high)) waterfall.setRange(low, high);
  }

  // Plays the stream with a short jitter buffer; resynchronises instead of
  // drifting when the network or a background tab falls behind.
  const player = {context: null, next: 0,
    start() {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) return false;
      if (!this.context) this.context = new Context();
      if (this.context.state === "suspended") this.context.resume();
      this.next = 0;
      return true;
    },
    stop() { if (this.context) this.context.suspend(); },
    push(samples) {
      const context = this.context;
      if (!context || context.state !== "running") return;
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const now = context.currentTime;
      if (this.next < now + .05 || this.next > now + 1.5) this.next = now + .3;
      source.start(this.next);
      this.next += buffer.duration;
    }};

  function onAudio(buffer) {
    const packet = parseAud1(buffer);
    if (!packet) return;
    const audio = state.audio;
    if (packet.streamId !== audio.stream || (packet.flags & 0x0001)) { audio.stream = packet.streamId; audio.expected = null; }
    const samples = new Float32Array(packet.payload.length);
    for (let index = 0; index < samples.length; index++) samples[index] = ULAW[packet.payload[index]];
    if (waterfall && dom.waterfallToggle.checked) {
      const gap = audio.expected === null ? 0 : packet.firstSample - audio.expected;
      if (gap > 0 && gap < SAMPLE_RATE * 30) waterfall.gap(gap);
      waterfall.ingest(samples);
    }
    audio.expected = packet.firstSample + samples.length;
    if (dom.listenToggle.checked) player.push(samples);
  }

  function onAudioToggle() {
    if (dom.listenToggle.checked && !player.start()) dom.listenToggle.checked = false;
    if (!dom.listenToggle.checked) player.stop();
    dom.waterfall.hidden = !dom.waterfallToggle.checked;
    if (dom.waterfallToggle.checked && ensureWaterfall()) { applyRange(); waterfall.resize(); }
    const wanted = dom.waterfallToggle.checked || dom.listenToggle.checked;
    try { localStorage.setItem("wifilt.watch.audio", JSON.stringify({waterfall: dom.waterfallToggle.checked})); } catch (_error) {}
    if (wanted !== state.audio.wanted) { state.audio.wanted = wanted; reconnect(); }
    renderAudioState();
  }

  function renderAudioState() {
    const wanted = state.audio.wanted;
    dom.audioState.textContent = !wanted ? "" : !state.hello ? "" :
      state.hello.audio ? "RX audio from the radio" : "RX audio for viewers is off in SETUP → Web server";
  }

  // ── Connection ─────────────────────────────────────────────────────────────
  function socketUrl() {
    const port = (globalThis.WIFILT_PORTS && WIFILT_PORTS.audio) || 83;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.hostname}:${port}/watchws${state.audio.wanted ? "?audio=1" : ""}`;
  }

  function connect() {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    let socket;
    try { socket = new WebSocket(socketUrl()); } catch (_error) { scheduleRetry(); return; }
    socket.binaryType = "arraybuffer";
    state.socket = socket;
    socket.onmessage = event => {
      if (socket !== state.socket) return;
      state.lastMessageMs = Date.now();
      if (typeof event.data === "string") onText(event.data);
      else onAudio(event.data);
    };
    socket.onclose = () => {
      if (socket !== state.socket) return;
      const hadHello = Boolean(state.hello);
      state.socket = null; state.connected = false; state.hello = null;
      renderHeader();
      if (!hadHello) explainRefusal();
      scheduleRetry();
    };
  }

  function reconnect() {
    const socket = state.socket;
    state.socket = null; state.hello = null; state.connected = false;
    if (socket) socket.close();
    connect();
  }

  function scheduleRetry() {
    if (state.retryTimer) return;
    state.retryTimer = setTimeout(connect, state.retryMs);
    state.retryMs = Math.min(10000, state.retryMs * 2);
  }

  // A refused handshake says nothing to the browser, so ask the binary why.
  async function explainRefusal() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch("/health.json", {cache: "no-store", signal: controller.signal});
      const health = await response.json();
      if (!health.watch) notice("This interface does not offer WATCH. It is part of the PC version of WIFILT (Linux, Raspberry Pi, Windows).");
      else if (!health.watch.on) notice("WATCH is off. Turn it on in SETUP → Web server on the computer running WIFILT.");
      else if (health.watch.viewers >= 8) notice("Too many viewers are watching already. Trying again…");
      else notice("Cannot reach the audio port of the interface. Trying again…");
    } catch (_error) {
      notice("The interface does not answer. Trying again…");
    } finally {
      clearTimeout(timer);
    }
  }

  function notice(text) {
    dom.notice.textContent = text || "";
    dom.notice.hidden = !text;
  }

  function onText(text) {
    let message;
    try { message = JSON.parse(text); } catch (_error) { return; }
    if (message.type === "hello") {
      state.hello = message; state.connected = true; state.retryMs = 1000;
      // The replay that follows rebuilds the tapes from the binary's recent events.
      state.rtty = {r1: [], r2: []}; state.jtty = []; state.jttyOpen.clear();
      notice("");
      setHolder(message.holder, message.viewers);
      renderAudioState();
    } else if (message.type === "status") {
      setHolder(message.holder, message.viewers);
    } else if (message.type === "snapshot" && ROLES.includes(message.role)) {
      state.snapshots[message.role] = {data: message.data, atMs: Date.now() - (Number(message.ageMs) || 0)};
    } else if (message.type === "event") {
      onEvent(message.role, message.data || {});
    }
    queueRender();
  }

  function setHolder(holder, viewers) {
    const previousRole = state.holder.held ? state.holder.role : null;
    state.holder = holder || {held: false};
    state.viewers = Number(viewers) || 0;
    const role = state.holder.held ? state.holder.role : null;
    if (role !== previousRole) state.pinnedFor = null;
  }

  // ── RTTY / JTTY text ───────────────────────────────────────────────────────
  function appendTape(tape, text, tx) {
    if (!text) return;
    const last = tape[tape.length - 1];
    if (last && last.tx === tx) last.text += text;
    else tape.push({text, tx});
    let total = tape.reduce((sum, segment) => sum + segment.text.length, 0);
    while (total > TAPE_MAX_CHARS && tape.length) {
      const over = total - TAPE_MAX_CHARS;
      if (tape[0].text.length <= over) { total -= tape[0].text.length; tape.shift(); }
      else { tape[0].text = tape[0].text.slice(over); total -= over; }
    }
  }

  function onEvent(role, data) {
    if (role === "rtty") {
      if (data.type === "rtty.tx") appendTape(state.rtty.r1, `\n${data.text}\n`, true);
      else { appendTape(state.rtty.r1, data.r1 || "", false); appendTape(state.rtty.r2, data.r2 || "", false); }
    } else if (role === "jtty") {
      if (data.type === "jtty.tx") {
        state.jtty.unshift({tx: true, text: String(data.text || ""), t: Date.now()});
      } else {
        let message = state.jttyOpen.get(data.id);
        if (!message) {
          message = {id: data.id, text: "", t: Date.now(), complete: false};
          state.jttyOpen.set(data.id, message);
          state.jtty.unshift(message);
        }
        message.text += String(data.text || "");
        message.hz = data.hz; message.snr = data.snr; message.t = Date.now();
        if (data.eom) { message.complete = true; state.jttyOpen.delete(data.id); }
      }
      while (state.jtty.length > JTTY_MAX_MESSAGES) {
        const dropped = state.jtty.pop();
        if (state.jttyOpen.get(dropped.id) === dropped) state.jttyOpen.delete(dropped.id);
      }
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => { state.renderQueued = false; render(); });
  }

  function hasData(role) {
    if (role === "rtty") return state.rtty.r1.length + state.rtty.r2.length > 0;
    if (role === "jtty") return state.jtty.length > 0;
    return Boolean(state.snapshots[role]);
  }

  function currentTab() {
    if (state.pinnedFor !== null && state.tab) return state.tab;
    if (state.holder.held && ROLES.includes(state.holder.role)) return state.holder.role;
    return state.tab || ROLES.find(hasData) || "js8";
  }

  function renderHeader() {
    dom.link.textContent = state.connected ? "LIVE" : "OFFLINE";
    dom.link.className = `pill ${state.connected ? "ok" : "bad"}`;
    const holder = state.holder;
    if (!state.connected) dom.holder.textContent = "";
    else if (holder.held) {
      let text = `${ROLE_NAMES[holder.role] || holder.role || "Radio"} · operated from ${holder.owner}`;
      if (holder.mercuryName) text += ` · ${holder.mercuryName} ${holder.mercuryPercent}%`;
      dom.holder.textContent = text;
    } else dom.holder.textContent = "Nobody is operating the radio — showing the last known state";
    dom.viewers.textContent = state.connected ? `${state.viewers} watching` : "";
  }

  function renderTabs() {
    for (const button of dom.tabs.querySelectorAll("button")) {
      const role = button.dataset.role;
      button.classList.toggle("active", role === state.tab);
      button.classList.toggle("held", Boolean(state.holder.held && state.holder.role === role));
      button.classList.toggle("has-data", hasData(role));
    }
  }

  function renderStamp() {
    const snapshot = state.snapshots[state.tab];
    if (state.tab === "rtty" || state.tab === "jtty") dom.stamp.textContent = hasData(state.tab) ? "Live text from the operator's screen" : "";
    else dom.stamp.textContent = snapshot ? `Operator's screen as of ${age(snapshot.atMs)} ago (${utc(snapshot.atMs)} UTC)` : "";
  }

  function render() {
    const tab = currentTab();
    if (tab !== state.tab) { state.tab = tab; applyRange(); }
    renderHeader();
    renderTabs();
    renderStamp();
    const view = {js8: renderJs8, wspr: renderWspr, rtty: renderRtty, jtty: renderJtty, mercury: renderMercury}[tab];
    const scroll = rememberScroll();
    dom.view.innerHTML = view();
    restoreScroll(scroll);
    const snapshot = state.snapshots[tab];
    document.body.classList.toggle("radio-transmitting", Boolean(snapshot && snapshot.data && snapshot.data.tx &&
      state.holder.held && state.holder.role === tab));
  }

  // A tape that was scrolled to the bottom follows new text; one the viewer
  // scrolled up to read stays where it is.
  function rememberScroll() {
    const kept = {};
    for (const element of dom.view.querySelectorAll("[data-scroll]")) {
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      kept[element.dataset.scroll] = {atBottom, top: element.scrollTop};
    }
    return kept;
  }
  function restoreScroll(kept) {
    for (const element of dom.view.querySelectorAll("[data-scroll]")) {
      const previous = kept[element.dataset.scroll];
      const follow = element.dataset.follow === "bottom";
      if (!previous) { if (follow) element.scrollTop = element.scrollHeight; continue; }
      element.scrollTop = follow && previous.atBottom ? element.scrollHeight : previous.top;
    }
  }

  const empty = text => `<div class="watch-empty">${esc(text)}</div>`;
  const NOTHING = "Nothing published yet. This appears once the radio is operated in this mode.";

  function stationMap(stations, links, centerTitle) {
    const placed = stations.filter(item => Number.isFinite(item.km) && Number.isFinite(item.az));
    if (!placed.length || !globalThis.StationMap) return "";
    return `<h2>Map</h2><div class="station-map">${StationMap.svg({
      stations: placed.map(item => ({key: item.call, km: item.km, az: item.az, member: item})),
      edges: (links || []).map(link => ({from: link.from, to: link.to, tip: `${link.from} → ${link.to} · ${link.detail || ""}`})),
      logScale: false, centerTitle: centerTitle || "My station",
      memberTip: item => `${item.reacted ? "← " : ""}${item.call} · ${item.heard === false ? "not heard directly" : `${signed(item.snr)} dB`} · ${Math.round(item.km)} km · ${item.az}°`,
      clusterClass: members => (members.some(item => item.reacted) ? " reacted" : "") +
        (!members.some(item => item.heard !== false) ? " phantom" : ""),
    })}</div>`;
  }

  function renderJs8() {
    const snapshot = state.snapshots.js8;
    if (!snapshot) return empty(NOTHING);
    const data = snapshot.data || {};
    const traffic = Array.isArray(data.traffic) ? data.traffic : [];
    const stations = Array.isArray(data.stations) ? data.stations : [];
    const facts = `<p class="watch-facts"><span><b>${esc(data.myCall || "—")}</b> ${esc(data.grid || "")}</span>` +
      `<span>${esc(mhz(data.activityHz || data.radioHz))} MHz</span><span>speed ${esc(data.mode || "—")}</span>` +
      `${data.tx ? '<span class="badge">TX</span>' : ""}</p>`;
    const feed = traffic.length ? traffic.map(item => {
      const meta = [utc(item.t), item.speed, Number.isFinite(item.hz) && item.hz !== null ? `${item.hz} Hz` : "",
        item.snr !== null && item.snr !== undefined ? `${signed(item.snr)} dB` : "",
        item.out ? item.status : item.incomplete ? "incomplete" : item.partial ? "receiving" : ""]
        .filter(Boolean).map(part => `<span>${esc(part)}</span>`).join("");
      if (item.out) {
        const emitted = item.status === "completed" || item.status === "unconfirmed";
        return `<article class="tx${emitted ? "" : " unsent"}"><span class="meta">${meta}</span>` +
          `<strong>TX → ${esc(item.to || "CQ/HB")}</strong><span class="text">${esc(item.text)}</span></article>`;
      }
      const classes = [item.forMe ? "for-me" : "", item.partial ? "partial" : ""].filter(Boolean).join(" ");
      return `<article class="${classes}"><span class="meta">${meta}</span><strong>${esc(item.from || "JS8")}</strong>` +
        `<span class="text">${item.forMe ? '<span class="badge">TO YOU</span> ' : ""}${esc(item.text)}</span></article>`;
    }).join("") : empty("Waiting for JS8 activity…");
    const rows = stations.map(item => `<tr class="${item.heard === false ? "indirect" : ""}">` +
      `<td class="call${item.reacted ? " reacted" : ""}">${item.reacted ? "← " : ""}${esc(item.call)}</td>` +
      `<td>${esc(item.country || "—")}</td><td>${item.heard === false ? "—" : signed(item.snr)}</td>` +
      `<td>${item.hz === null || item.hz === undefined ? "—" : esc(item.hz)}</td><td>${esc(item.speed || "—")}</td>` +
      `<td>${Number.isFinite(item.km) ? `${Math.round(item.km)} km ${esc(item.az)}°` : "—"}</td><td>${esc(age(item.t))}</td></tr>`).join("");
    const table = stations.length
      ? `<div class="table-wrap" data-scroll="js8-stations"><table><thead><tr><th>Call</th><th>Country</th><th>SNR</th><th>Hz</th><th>Speed</th><th>Distance</th><th>Age</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : empty("No stations yet.");
    return `${facts}<div class="watch-grid"><div><h2>Traffic</h2><div class="feed" data-scroll="js8-feed">${feed}</div></div>` +
      `<div><h2>Stations · ${stations.length}</h2>${table}${stationMap(stations, data.links, data.myCall)}</div></div>`;
  }

  function renderWspr() {
    const snapshot = state.snapshots.wspr;
    if (!snapshot) return empty(NOTHING);
    const data = snapshot.data || {};
    const spots = Array.isArray(data.spots) ? data.spots : [];
    const home = locatorToLatLon(data.grid);
    const placedByCall = new Map();
    const rows = spots.map(spot => {
      const there = home && locatorToLatLon(spot.grid);
      const direction = there ? qrbAzimuth(home, there) : null;
      if (direction && !placedByCall.has(spot.call))
        placedByCall.set(spot.call, {call: spot.call, km: direction.km, az: direction.az, snr: spot.snr});
      return `<tr><td>${esc(utc(spot.t).slice(0, 5))}</td><td class="call">${esc(spot.call)}</td><td>${esc(spot.grid || "—")}</td>` +
        `<td>${signed(spot.snr)}</td><td>${Number(spot.dt).toFixed(1)}</td><td>${esc(mhz(spot.freqHz))}</td>` +
        `<td>${esc(spot.drift)}</td><td>${esc(spot.power)}</td><td>${direction ? `${direction.km} km` : "—"}</td></tr>`;
    }).join("");
    const facts = `<p class="watch-facts"><span><b>${esc(data.myCall || "—")}</b> ${esc(data.grid || "")}</span>` +
      `<span>dial ${esc(mhz(data.dialHz))} MHz</span><span>beacon ${esc(data.beacon || "—")}</span>` +
      `<span>last cycle ${esc(utc(data.lastCycleMs).slice(0, 5))} UTC</span>${data.tx ? '<span class="badge">TX</span>' : ""}</p>`;
    const table = spots.length
      ? `<div class="table-wrap" data-scroll="wspr-spots"><table><thead><tr><th>UTC</th><th>Call</th><th>Grid</th><th>SNR</th><th>DT</th><th>MHz</th><th>Drift</th><th>dBm</th><th>Distance</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : empty("No spots yet.");
    return `${facts}<div class="watch-grid"><div><h2>Spots · ${spots.length}</h2>${table}</div>` +
      `<div>${stationMap([...placedByCall.values()], [], data.myCall)}</div></div>`;
  }

  function tapeHtml(tape) {
    return tape.map(segment => segment.tx ? `<span class="tx">${esc(segment.text)}</span>` : esc(segment.text)).join("");
  }

  function renderRtty() {
    if (!hasData("rtty")) return empty("No RTTY text yet. It appears as the operator's page decodes it.");
    return `<div class="tapes"><div><p class="tape-label">DEC 1 · transmitted text in red</p>` +
      `<pre class="tape" data-scroll="rtty-1" data-follow="bottom">${tapeHtml(state.rtty.r1)}</pre></div>` +
      `<div><p class="tape-label">DEC 2</p><pre class="tape" data-scroll="rtty-2" data-follow="bottom">${tapeHtml(state.rtty.r2)}</pre></div></div>`;
  }

  function renderJtty() {
    if (!hasData("jtty")) return empty("No JTTY messages yet. They appear as the operator's page decodes them.");
    return `<div class="feed" data-scroll="jtty-feed">${state.jtty.map(message => {
      if (message.tx) return `<article class="tx"><span class="meta"><span>${esc(utc(message.t))}</span></span>` +
        `<strong>TX</strong><span class="text">${esc(message.text)}</span></article>`;
      const meta = [utc(message.t), `${message.hz} Hz`, `${signed(message.snr)} dB`, message.complete ? "complete" : "receiving"]
        .map(part => `<span>${esc(part)}</span>`).join("");
      return `<article class="${message.complete ? "" : "partial"}"><span class="meta">${meta}</span>` +
        `<strong>RX</strong><span class="text">${esc(message.text)}</span></article>`;
    }).join("")}</div>`;
  }

  function renderMercury() {
    const snapshot = state.snapshots.mercury;
    if (!snapshot) return empty(NOTHING);
    const data = snapshot.data || {};
    const lines = list => (Array.isArray(list) && list.length)
      ? `<div class="feed lines">${list.map(line => `<p>${esc(line)}</p>`).join("")}</div>` : "";
    const transfer = data.transfer || {};
    const progress = Number.isFinite(transfer.percent) && transfer.percent !== null
      ? `<progress max="100" value="${Number(transfer.percent)}"></progress>` : "";
    const received = Array.isArray(data.received) && data.received.length
      ? `<h2>Received files</h2>${lines(data.received)}` : "";
    return `<p class="watch-facts"><span>${esc(data.aud1 || "")}</span><span>peer <b>${esc(data.peer || "—")}</b></span></p>` +
      `<h2>Connection</h2>${lines(data.connection) || empty("Idle.")}` +
      (transfer.text || progress ? `<h2>Transfer</h2>${progress}${lines([transfer.text].filter(Boolean))}` : "") +
      (data.arq && data.arq.length ? `<h2>Status</h2>${lines(data.arq)}` : "") +
      (data.heard ? `<h2>CQ heard</h2>${lines([data.heard])}` : "") + received;
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  dom.tabs.addEventListener("click", event => {
    const button = event.target.closest("button[data-role]");
    if (!button) return;
    state.tab = button.dataset.role;
    state.pinnedFor = state.holder.held ? state.holder.role : "";
    applyRange();
    render();
  });
  dom.waterfallToggle.addEventListener("change", onAudioToggle);
  dom.listenToggle.addEventListener("change", onAudioToggle);
  addEventListener("resize", () => { if (waterfall && !dom.waterfall.hidden) waterfall.resize(); });
  setInterval(() => {
    renderStamp();
    if (state.socket && state.connected && Date.now() - state.lastMessageMs > SILENCE_MS) reconnect();
  }, 1000);

  try {
    const saved = JSON.parse(localStorage.getItem("wifilt.watch.audio") || "{}");
    if (saved.waterfall) dom.waterfallToggle.checked = true;
  } catch (_error) {}
  state.audio.wanted = dom.waterfallToggle.checked;
  dom.waterfall.hidden = !dom.waterfallToggle.checked;
  if (dom.waterfallToggle.checked) ensureWaterfall();
  applyRange();
  render();
  connect();
})();
