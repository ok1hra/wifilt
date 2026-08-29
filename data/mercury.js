// Mercury page. LanGate.gate() (ICOM-LAN check) plus the real session lock +
// CALL/LISTEN/file-transfer Worker pump -- all built and verified against a
// real IC-705 before being wired here (see data/mercury-session.js and
// data/mercury-worker.js's own header comments).
//
// What is real on this page now: claiming the AUD1 lease, CALL, LISTEN/arm,
// SEND A FILE (queues a real MRQ1-framed transfer once CONNECTED, with a
// real QUERY/REPLY resume negotiation -- see mercury-worker.js and
// docs/mercury-implementace.md ch.5) plus receiving an unsolicited incoming
// file while armed, and cancelling either direction mid-transfer (drops the
// ARQ connection -- there is no partial-abort API, and a cancelled receive
// keeps its partial bytes in the Worker's resume store for a future resume,
// same as any other disconnect). Not yet wired: ch.8's ALC-based drive
// calibration.
(function () {
  const dom = {};
  let worker = null;
  let workerRole = null; // "call" | "listen" | null
  let ownSession = false; // did THIS page's own action put the lease in use?
  let selectedFile = null; // File chosen in fileInput, awaiting a CONNECTED session
  let isConnected = false;

  // ---- radio-bar parity state (2026-08-23 grill-me, docs/mercury-implementace.md
  // ch.13) -- this page had none of this before: no /state polling at all, and
  // trxFrequency was a disabled placeholder. See ch.13 for why this is a third
  // independent copy of data.js/wspr.js's own pollRadio()/renderHeader(), not a
  // shared module.
  const state = {
    radio: {connected: false, frequency: 0, mode: "", filter: 0, tx: false,
            rfPower: 0, rfPowerSeen: false, radioName: "", transceiverType: "",
            lanStatus: ""},
    lanConfig: {checked: false, ready: false, slot: 0},
    pendingFrequency: null,
    reconnectPending: false,
    calRunning: false,
    planRunning: false,
  };
  // CALLING/ACCEPTING/CONNECTED/DISCONNECTING -- NOT plain LISTENING idle, which
  // is exactly the state bullet 2's band-hopping is FOR. See timetableBusy().
  let sessionBusy = false;

  function byId(id) { return document.getElementById(id); }

  function setAud1Pill(text, cls) {
    dom.aud1State.textContent = "AUD1 " + text;
    dom.aud1State.className = "pill aud1-state" + (cls ? " " + cls : "");
  }

  function setConnectionTest(html, placeholder) {
    dom.connectionTest.classList.toggle("placeholder", Boolean(placeholder));
    dom.connectionTest.innerHTML = html;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  }

  function formatEta(remainingMs) {
    if (!remainingMs || !Number.isFinite(remainingMs) || remainingMs <= 0) return "";
    const totalMin = Math.ceil(remainingMs / 60000);
    if (totalMin < 1) return " -- <1 min left";
    if (totalMin < 60) return ` -- ~${totalMin} min left`;
    return ` -- ~${(totalMin / 60).toFixed(1)} h left`;
  }

  function updateSendButtonState() {
    dom.sendButton.disabled = !(isConnected && selectedFile);
  }

  function showCancelButton(show) {
    dom.cancelButton.hidden = !show;
    dom.cancelButton.disabled = !show;
  }

  function resetTransferUi() {
    isConnected = false;
    dom.transferProgress.hidden = true;
    dom.transferProgress.value = 0;
    showCancelButton(false);
    updateSendButtonState();
  }

  function stopWorker(reason) {
    if (worker) { try { worker.postMessage({ type: "stop" }); } catch (_e) { /* already gone */ } worker = null; }
    workerRole = null;
    resetTransferUi();
    dom.cqButton.disabled = true;
    hideArqStatus(); // §6.5: no session, no stale STATUS panel
    renderTuningLock(); // §6.6: Settings unlocks once no session is running
    if (reason) setAud1Pill(reason);
  }

  function releaseIfOurs() {
    stopWorker();
    if (ownSession) { MercurySession.release(); ownSession = false; }
    // A CAL PLAN cell may be claiming the very same lease this CALL/LISTEN just
    // gave up (mercury-gain-cal.js's own claimSession()) -- re-enabling
    // unconditionally here would let CALL fire into a transmitter a
    // calibration burst still owns.
    const busy = state.calRunning || state.planRunning;
    dom.callButton.disabled = busy;
    dom.peerCall.disabled = busy;
    dom.listenToggle.disabled = busy;
  }

  // Is a Worker actively contending for the transmitter (dialing out or
  // capable of auto-answering)? "monitor" is the ambient waterfall-only
  // role and deliberately excluded -- it never transmits, so it must not
  // block CALL, LISTEN, CQ or the TX-gain calibration plan the way an
  // actual call/listen session does.
  function activeSessionRunning() { return workerRole === "call" || workerRole === "listen"; }

  // Restore the ambient "monitor" (or "listen", if the operator has LISTEN
  // on) worker once nothing exclusive needs the AUD1 socket -- called after
  // an outbound CALL ends, after a CAL/PLAN run finishes, after a takeover,
  // and once at page load. Session lease stays held throughout; this never
  // releases it, unlike the old one-shot arm/call flow.
  async function startAmbientWorker() {
    if (state.calRunning || state.planRunning) return; // calibration owns the socket for its own run right now
    const identity = await withIdentity();
    if (dom.listenToggle.checked && identity.call) {
      dom.peerCall.disabled = true;
      dom.callButton.disabled = true;
      startWorker("listen", "", identity.call);
      return;
    }
    if (dom.listenToggle.checked && !identity.call) {
      // Identity got cleared since LISTEN was turned on -- fall back
      // honestly rather than silently listening with no callsign.
      dom.listenToggle.checked = false; MercurySession.setArmed(false); dom.listenState.textContent = "LISTEN OFF";
    }
    dom.peerCall.disabled = false;
    dom.callButton.disabled = false;
    startWorker("monitor", "", identity.call || "");
  }

  // An outbound CALL ends (peer answered and finished, or never answered):
  // fall back to the ambient worker rather than releasing the session --
  // the lease is now held for the page's whole lifetime, same as JS8/WSPR's
  // own audio lease, not just for the duration of one CALL.
  function endActiveSession() {
    stopWorker();
    // onCall() disables LISTEN for the duration of the call (dialing and
    // answering must not race); nothing else on this normal end-of-call path
    // used to turn it back on, so LISTEN stayed stuck disabled for the rest
    // of the page's life after the very first CALL. Same busy guard as
    // releaseIfOurs()'s own re-enable.
    dom.listenToggle.disabled = state.calRunning || state.planRunning;
    startAmbientWorker();
  }

  function handleWorkerMessage(msg) {
    if (window.__mercuryDebug) window.__mercuryDebug.push({ t: Date.now(), msg });
    if (msg.type === "log") return; // debug only, not shown to the operator
    if (msg.type === "error") {
      setAud1Pill("error", "error");
      setConnectionTest(`<p class="connection-test-line muted">${msg.reason}${msg.detail ? " -- " + msg.detail : ""}</p>`, true);
      stopWorker();
      sessionBusy = false;
      if (dom.listenToggle.checked) { dom.listenToggle.checked = false; MercurySession.setArmed(false); dom.listenState.textContent = "LISTEN OFF"; }
      releaseIfOurs();
      return;
    }
    if (msg.type === "status") {
      // "monitor" never leaves DISCONNECTED (see mercury-worker.js's role
      // branch) -- show it as ambient monitoring, not a misleading
      // "disconnected", which would read as an error on a page that is
      // deliberately not listening.
      setAud1Pill(workerRole === "monitor" ? "monitoring" : msg.connState.toLowerCase());
      // Bullet 2's timetable busy check (timetableBusy()): plain LISTENING is
      // exactly the idle state band-hopping is FOR, so it is deliberately NOT
      // in this list -- only a state actively contending for the channel is.
      sessionBusy = ["CALLING", "ACCEPTING", "CONNECTED", "DISCONNECTING"].includes(msg.connState);
      if (msg.connState === "CALLING") {
        setConnectionTest(`<p class="connection-test-line">Calling <b>${dom.peerCall.value.trim().toUpperCase()}</b>...</p>`, true);
      } else if (msg.connState === "LISTENING") {
        setConnectionTest(`<p class="connection-test-line">Listening -- waiting for an incoming CALL.</p>`, true);
      }
      return;
    }
    if (msg.type === "connected") {
      sessionBusy = true;
      const peer = msg.peerSnrDb === null ? "no report yet" : `${msg.peerSnrDb >= 0 ? "+" : ""}${msg.peerSnrDb.toFixed(0)} dB`;
      const rateLine = msg.modeBps
        ? `<p class="connection-test-line">Recommended mode: <b>${msg.modeName}</b> &middot; ${msg.modeBps} B/s</p>`
        : `<p class="connection-test-line">Mode: <b>${msg.modeName}</b></p>`;
      setConnectionTest(
        `<p class="connection-test-line">Connected with <b>${dom.peerCall.value.trim().toUpperCase()}</b> ` +
        `&middot; SNR RX <b>${msg.localSnrDb >= 0 ? "+" : ""}${msg.localSnrDb.toFixed(0)} dB</b> / TX <b>${peer}</b></p>` +
        rateLine,
        false
      );
      isConnected = true;
      updateSendButtonState();
      return;
    }
    if (msg.type === "disconnected") {
      sessionBusy = false;
      setConnectionTest(`<p class="connection-test-line muted">No response -- call ended.</p>`, true);
      resetTransferUi();
      if (workerRole === "call") endActiveSession();
      return;
    }
    if (msg.type === "stopped") { sessionBusy = false; setAud1Pill("idle"); resetTransferUi(); return; }

    // ---- MRQ1 file transfer (ch.5/E3) ----
    if (msg.type === "send-progress") {
      const percent = msg.totalBytes ? Math.round((msg.sentBytes / msg.totalBytes) * 100) : 0;
      dom.transferProgress.hidden = false;
      dom.transferProgress.value = percent;
      dom.transferEstimate.textContent = `${msg.phase} -- ${formatBytes(msg.sentBytes)} / ${formatBytes(msg.totalBytes)}${formatEta(msg.remainingMs)}`;
      showCancelButton(msg.phase !== "delivered");
      // Feeds doc §6.3's takeover dialog on another tab/device with the
      // real transfer this session is running, not just "in use elsewhere".
      if (ownSession) MercurySession.ping({ name: msg.name || selectedFile?.name || "file", percent, remainingMs: msg.remainingMs || 0 });
      return;
    }
    if (msg.type === "send-complete") {
      dom.transferProgress.hidden = true;
      dom.transferEstimate.textContent = `Sent "${msg.name}" -- delivered.`;
      showCancelButton(false);
      selectedFile = null;
      dom.fileInput.value = "";
      updateSendButtonState();
      return;
    }
    if (msg.type === "send-error") {
      dom.transferProgress.hidden = true;
      dom.transferEstimate.textContent = `Send failed: ${msg.reason}`;
      showCancelButton(false);
      updateSendButtonState();
      return;
    }
    if (msg.type === "incoming-file") {
      dom.transferProgress.hidden = false;
      dom.transferProgress.value = 0;
      dom.transferEstimate.textContent = `Receiving "${msg.name}" (${formatBytes(msg.totalSize)})...`;
      showCancelButton(true);
      return;
    }
    if (msg.type === "receive-progress") {
      const percent = msg.totalBytes ? Math.round((msg.receivedBytes / msg.totalBytes) * 100) : 0;
      dom.transferProgress.hidden = false;
      dom.transferProgress.value = percent;
      // msg.name is the peer's raw claimed filename -- safe here only
      // because textContent (not innerHTML) escapes it; see the
      // receive-complete handler's own note on this.
      dom.transferEstimate.textContent = `Receiving "${msg.name}" -- ${formatBytes(msg.receivedBytes)} / ${formatBytes(msg.totalBytes)}${formatEta(msg.remainingMs)}`;
      showCancelButton(true);
      if (ownSession) MercurySession.ping({ name: msg.name, percent, remainingMs: msg.remainingMs || 0 });
      return;
    }
    if (msg.type === "receive-complete") {
      dom.transferProgress.hidden = true;
      dom.transferEstimate.textContent = `Received "${msg.name}".`;
      showCancelButton(false);
      // msg.name came off the wire from whatever the peer's MRQ1 header
      // claimed -- parseHeader() decodes it as UTF-8 but does not re-sanitize
      // it the way buildHeader() does on the way out, so an unfriendly or
      // buggy peer could put HTML in it. Built via DOM API + textContent,
      // never innerHTML, so there is nothing here for it to inject into.
      const url = URL.createObjectURL(msg.blob);
      const row = document.createElement("div");
      row.className = "received-file";
      const link = document.createElement("a");
      link.href = url; link.download = msg.name; link.textContent = msg.name;
      const size = document.createElement("span");
      size.className = "muted"; size.textContent = formatBytes(msg.size);
      row.append(link, size);
      dom.receivedFiles.prepend(row);
      return;
    }
    if (msg.type === "receive-error") {
      dom.transferEstimate.textContent = `Receive failed (${msg.name || "unknown"}): ${msg.reason}`;
      showCancelButton(false);
      return;
    }
    if (msg.type === "transfer-cancelled") {
      dom.transferEstimate.textContent = "Cancelled.";
      showCancelButton(false);
      // The Worker also drops the ARQ connection right after this -- the
      // "disconnected" message that follows resets the rest (progress bar,
      // SEND button, isConnected) the same way any other disconnect does.
      return;
    }
    if (msg.type === "incoming-query") return; // informational only -- the reply is sent automatically by the Worker
    if (msg.type === "cq-heard") { onCqHeard(msg.call, msg.bwHz); return; }

    // ---- §6.7 waterfall (2026-08-23 grill-me) ----
    // The Worker's own AUD1 client is the only thing that ever sees a raw
    // sample (see mercury-worker.js's onRxTick header comment) -- forwarded
    // here unthrottled, one message per 20ms packet. Paused during this
    // station's own TX (radioTransmitting(), already polled for the radio
    // bar) same as JS8/WSPR, even though the underlying LAN audio is itself
    // duplex -- see mercury-waterfall-plan memory for why showing the live
    // carrier was judged more confusing than informative.
    if (msg.type === "rx-samples") { if (waterfall && !radioTransmitting()) waterfall.ingest(msg.samples); return; }

    // ---- §6.5 live STATUS panel (2026-08-23 grill-me) ----
    if (msg.type === "arq-status") { renderArqStatus(msg); return; }
    if (msg.type === "arq-status-clear") { hideArqStatus(); return; }
  }

  function startWorker(role, peerCall, myCall) {
    stopWorker();
    worker = new Worker("/mercury-worker.js");
    workerRole = role;
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (e) => handleWorkerMessage({ type: "error", reason: "worker crashed", detail: e.message });
    worker.postMessage({ type: "start", wsPort: 83, token: MercurySession.token(), myCall, peerCall: peerCall || "", role });
    setAud1Pill(role === "monitor" ? "monitoring" : "connecting");
    // CQ is a real, un-gated TX broadcast -- ambient "monitor" must not
    // enable it, same safety framing as "not listening means this station
    // cannot be reached/transmit" (only CALL/LISTEN's own active session does).
    dom.cqButton.disabled = (role === "monitor");
    dom.heardStations.textContent = "";
    heardStations.clear();
    renderTuningLock(); // §6.6: Settings locks for the duration of this session
  }

  // "who's out there" -- doc ch.10's E4 gate's last item (CQ/unattended
  // discovery). Sendable in any connection state (LISTENING, CALLING, even
  // mid-transfer -- see mercury-worker.js's sendCq()), so this button is
  // gated only on "is an active call/listen session running" (see
  // startWorker()'s own role check), same as the LISTEN toggle isn't gated
  // on CONNECTED -- but unlike LISTEN/CALL, ambient "monitor" must NOT
  // enable it: CQ is a real TX broadcast with no auto-answer semantics to
  // hide behind.
  const heardStations = new Map(); // call -> bwHz, session-lifetime only
  function onCqClick() {
    if (!worker) return;
    worker.postMessage({ type: "send-cq" });
  }
  function onCqHeard(call, bwHz) {
    heardStations.set(call, bwHz);
    const items = [...heardStations.entries()].map(([c, bw]) => `${c} (${bw} Hz)`).join(", ");
    dom.heardStations.textContent = items ? `Heard: ${items}` : "";
  }

  async function withIdentity() {
    if (typeof StationIdentity === "undefined") return { call: "" };
    try { return (await StationIdentity.read()) || { call: "" }; } catch (_e) { return { call: "" }; }
  }

  async function onCall() {
    if (state.calRunning || state.planRunning) return; // button is disabled too; defence in depth
    const peer = dom.peerCall.value.trim().toUpperCase();
    if (!peer) return;
    const identity = await withIdentity();
    if (!identity.call) { setConnectionTest(`<p class="connection-test-line muted">Set this station's own callsign in SETUP first.</p>`, true); return; }
    const granted = await MercurySession.claim(false);
    if (!granted) return; // onBusy already showed the takeover panel
    ownSession = true;
    dom.callButton.disabled = true;
    dom.listenToggle.disabled = true;
    startWorker("call", peer, identity.call);
  }

  // LISTEN only ever gates whether this station may auto-answer an
  // incoming CALL -- the waterfall/AUD1 feed keeps running regardless via
  // the ambient "monitor" worker (see startAmbientWorker()). Turning it off
  // no longer releases the session or tears down audio, just drops back to
  // "monitor"; the lease is held for the whole page lifetime now, same as
  // JS8/WSPR's own audio lease.
  async function onListenToggle() {
    if (state.calRunning || state.planRunning) { dom.listenToggle.checked = !dom.listenToggle.checked; return; }
    MercurySession.setArmed(dom.listenToggle.checked);
    dom.listenState.textContent = dom.listenToggle.checked ? "LISTENING" : "LISTEN OFF";
    if (!dom.listenToggle.checked) {
      setConnectionTest(`<p class="connection-test-line muted">Not listening -- Mercury cannot be reached, even with this page open.</p>`, true);
      startAmbientWorker();
      return;
    }
    const identity = await withIdentity();
    if (!identity.call) {
      setConnectionTest(`<p class="connection-test-line muted">Set this station's own callsign in SETUP first.</p>`, true);
      dom.listenToggle.checked = false; MercurySession.setArmed(false); dom.listenState.textContent = "LISTEN OFF";
      return;
    }
    const granted = await MercurySession.claim(false);
    if (!granted) { dom.listenToggle.checked = false; MercurySession.setArmed(false); dom.listenState.textContent = "LISTEN OFF"; return; }
    ownSession = true;
    dom.peerCall.disabled = true;
    dom.callButton.disabled = true;
    startWorker("listen", "", identity.call);
  }

  function onFileChosen() {
    const file = dom.fileInput.files && dom.fileInput.files[0];
    selectedFile = file || null;
    dom.transferEstimate.textContent = file
      ? `${formatBytes(file.size)} selected -- ${isConnected ? "ready to send" : "will send once connected"}.`
      : "Pick a file to see a size and time estimate.";
    updateSendButtonState();
  }

  async function onSendClick() {
    if (!worker || !selectedFile || !isConnected) return;
    const file = selectedFile;
    dom.sendButton.disabled = true;
    dom.transferEstimate.textContent = `Reading "${file.name}"...`;
    const buffer = await file.arrayBuffer();
    worker.postMessage({ type: "send-file", name: file.name, buffer }, [buffer]);
  }

  function onCancelClick() {
    if (!worker) return;
    dom.cancelButton.disabled = true; // avoid a double-click racing the Worker's own reply
    worker.postMessage({ type: "cancel-transfer" });
  }

  // ==========================================================================
  // §6.7 waterfall + §6.5 live STATUS panel (2026-08-23 grill-me). Built
  // after radio-bar parity landed, reusing its state.radio/radioTransmitting()
  // rather than polling separately.
  // ==========================================================================

  // Constructed in init(), once dom.waterfallCanvas/dom.waterfallOverlay
  // actually exist -- unlike JS8/WSPR, this page's `dom` starts empty and is
  // filled by init()'s own byId loop, not a module-scope literal, so a
  // top-level `new Spectrum.Waterfall(...)` here would run before its canvas
  // did.
  let waterfall = null;

  function renderArqStatus(msg) {
    dom.statusSection.hidden = false;
    const peer = msg.peerSnrDb === null ? "no report yet" : `${msg.peerSnrDb >= 0 ? "+" : ""}${msg.peerSnrDb.toFixed(0)} dB`;
    const rateLine = msg.modeBps
      ? `<p class="connection-test-line">Mode: <b>${msg.modeName}</b> (peer <b>${msg.peerModeName}</b>) &middot; ${msg.modeBps} B/s nominal</p>`
      : `<p class="connection-test-line">Mode: <b>${msg.modeName}</b> (peer <b>${msg.peerModeName}</b>)</p>`;
    const total = msg.framesOk + msg.framesRetried;
    // "nominal" on the rate line, always -- §6.5's own decision: this is the
    // current mode's rated bitrate (mercury-worker.js's MODE_INFO table),
    // never a measured throughput (TX progress is deliberately time+mode
    // estimated, not byte-counted -- see startRealDataPhase's own comment).
    // retriesLeft is null outside an actual DATA-frame delivery attempt
    // (mercury-worker.js only fills it in during dflow's DATA_TX/WAIT_ACK) --
    // TURN_REQ/MODE_REQ negotiation reuses the same C-side counter from a
    // small fixed budget, so showing it there would flag routine turn-taking
    // as if a frame were about to be dropped.
    const lowRetries = msg.retriesLeft !== null && msg.retriesLeft < 3;
    const successLine = total > 0
      ? `<p class="connection-test-line">Frames: <b>${msg.framesOk}</b> clean, <b>${msg.framesRetried}</b> needed a retry (${Math.round(100 * msg.framesOk / total)}% clean)${lowRetries ? ` <span class="muted">-- ${msg.retriesLeft} retries left on the current frame</span>` : ""}</p>`
      : `<p class="connection-test-line muted">No frames exchanged yet this connection.</p>`;
    dom.arqStatus.innerHTML =
      `<p class="connection-test-line">SNR RX <b>${msg.localSnrDb >= 0 ? "+" : ""}${msg.localSnrDb.toFixed(0)} dB</b> / TX <b>${peer}</b></p>` +
      rateLine + successLine;
  }

  function hideArqStatus() {
    dom.statusSection.hidden = true;
    dom.arqStatus.innerHTML = "";
  }

  // ==========================================================================
  // Radio-bar parity (2026-08-23 grill-me, docs/mercury-implementace.md ch.13).
  // Everything from here to init() is what this page never had: a live polled
  // picture of the radio, the frequency band picker, the frequency timetable
  // and the TX gain calibration plan. Trimmed to what Mercury actually shows --
  // no rfPercent field (no operator-facing power choice here), no waterfall,
  // no audio timebase clock, no trx-help dialog.
  // ==========================================================================

  const RADIO_STATE_URL = "/state?radio=lan";
  const RADIO_CMD_URL = "/cmd?radio=lan";
  const FETCH_TIMEOUT_MS = 8000, FETCH_FLASH_TIMEOUT_MS = 12000;
  const fetchDeadline = (ms = FETCH_TIMEOUT_MS) => AbortSignal.timeout(ms);
  const RADIO_POLL_OFFLINE_FAILURES = 3;
  let radioPollInFlight = false, radioPollFailures = 0;

  function formatFrequency(hz) { return MercuryTrxPresets.formatFrequency(hz || 0); }
  function formatWatts(watts) {
    if (watts < 0.9995) return `${Math.round(watts * 1000)} mW`;
    return watts < 9.95 ? `${watts.toFixed(1)} W` : `${Math.round(watts)} W`;
  }

  // Same cascade as data.js's own fullPowerScale(): a manual override left on
  // the WSPR settings page outranks what the radio calls itself, so all three
  // DATA pages agree on watts for the same transmitter. Read directly rather
  // than through wspr.js (which this page does not otherwise depend on) --
  // it is one localStorage key, not a reason to require that page be open.
  const WSPR_SETTINGS_KEY = "wifilt.wspr.v1";
  // See IcomModels.liveRadioModel()'s own comment for why this guard exists
  // (the ~1s stale-radio-name window on a live LAN-slot model swap, confirmed
  // against both an IC-705 and an IC-7610). Shared with data.js/wspr.js so
  // the fix cannot regress in one page while staying fixed in the others.
  function liveRadioModel() {
    return IcomModels.liveRadioModel(state.radio);
  }
  function fullPowerScale() {
    let override = "";
    try { override = String((JSON.parse(localStorage.getItem(WSPR_SETTINGS_KEY) || "null") || {}).modelOverride || ""); }
    catch (_error) { override = ""; }
    const manual = override && IcomModels.fullPowerWatts(override);
    if (manual) return {watts: manual, source: "manual override"};
    const reported = IcomModels.fullPowerWatts(liveRadioModel());
    return reported ? {watts: reported, source: "radio model"} : {watts: 0, source: ""};
  }

  // The LAN radio is whichever slot the operator gave the LAN connection to --
  // same reason data.js's own renderTrxSlotLabel() names it, and the same
  // guard: this can run before the dom map is built (checkLanConfiguration()
  // runs before it in init()).
  function renderTrxSlotLabel() {
    if (!dom.trxSlotLabel) return;
    const slot = state.lanConfig.slot;
    dom.trxSlotLabel.textContent = slot ? `TRX ${slot}` : "TRX";
    dom.trxSlotLabel.title = slot ? `TRX${slot} is the LAN radio` : "TRX";
  }

  function renderTrxPower(connected) {
    dom.trxPower.hidden = !connected;
    if (!connected) return;
    // Before the radio has answered 14 0A the firmware reports a fabricated
    // default -- show nothing rather than that (same trap data.js's own
    // renderTrxPower() documents).
    const seen = state.radio.rfPowerSeen === true;
    const level = Math.max(0, Math.min(255, Number(state.radio.rfPower) || 0));
    const percent = seen ? level * 100 / 255 : 0;
    // Round the same way the title below does (Math.round(percent)), so the
    // segment count and the printed number never disagree -- see data.js's
    // own renderTrxPower() for the mismatch this used to produce (ceil(percent/10)
    // overshot by a whole segment for almost any non-multiple-of-25.5 raw level).
    // Floor of 1 lit segment is kept for any power at all, same reasoning.
    const lit = seen && percent > 0 ? Math.max(1, Math.min(10, Math.round(percent / 10))) : 0;
    dom.trxPowerSegments.forEach((segment, index) => segment.classList.toggle("on", index < lit));
    const scale = fullPowerScale();
    const watts = seen && scale.watts ? scale.watts * level / 255 : null;
    dom.trxPowerWatts.textContent = watts === null ? "--" : formatWatts(watts);
    dom.trxPower.title = !seen ? "TRX power — the radio has not reported its power level yet"
      : watts === null ? `TRX power ${Math.round(percent)} % · watts unknown: the radio model is not recognised`
      : `TRX power ${Math.round(percent)} % · ${formatWatts(watts)} of ${scale.watts} W (${scale.source})`;
  }

  function radioTransmitting() { return Boolean(state.radio.tx); }

  // The busy check bullet 2's TIMETABLE uses. Deliberately NOT the same as
  // mercuryBlockingReason() below: a plain LISTEN with nobody connected is
  // exactly the state band-hopping is FOR (ch.13's decision -- Mercury is a
  // monitor station now, same as JS8/WSPR, not merely transactional), so
  // retuning is fine there. It is CALLING/ACCEPTING/CONNECTED/a live transfer
  // that must hold the dial still, same rule JS8's own timetable already
  // applies to "never mid-transmission" -- see sessionBusy's own comment.
  function timetableBusy() {
    return radioTransmitting() || sessionBusy || state.calRunning || state.planRunning;
  }

  function renderHeader() {
    const connected = state.radio.connected && state.radio.transceiverType === "ICOM-LAN";
    const shownHz = state.pendingFrequency || state.radio.frequency;
    dom.trxFrequencyValue.textContent = formatFrequency(shownHz);
    dom.trxFrequency.classList.toggle("pending", Boolean(state.pendingFrequency));
    const offDial = connected && Boolean(shownHz) &&
      !MercuryTrxPresets.PRESETS.some(item => item.frequencyHz === shownHz);
    dom.trxFrequency.classList.toggle("off-dial", offDial);
    dom.trxFrequency.title = offDial ? "Not a Mercury dial frequency — choose a band from the menu" : "";
    renderTrxSlotLabel();
    dom.trxMode.textContent = state.radio.mode || "---";
    const modeCompatible = ["USB", "USB-D"].includes(state.radio.mode);
    dom.trxMode.classList.toggle("incompatible", connected && !modeCompatible);
    dom.trxMode.title = connected && !modeCompatible ? "Mercury requires USB or USB-D" : "TRX mode";
    renderTrxPower(connected);
    dom.linkState.textContent = connected ? (radioTransmitting() ? "● TX" : "● RX WAIT") : "● OFFLINE";
    dom.linkState.classList.toggle("error", !connected);
    const reconnectVisible = state.lanConfig.ready && !connected && state.radio.lanStatus === "disconnected";
    dom.trxReconnect.hidden = !reconnectVisible;
    dom.trxReconnect.disabled = state.reconnectPending;
    dom.trxReconnect.textContent = state.reconnectPending ? "Connecting…" : "Reconnect";
    if (frequencyMenuKey !== String(shownHz)) renderFrequencyMenu();
    renderTimetableButton();
  }

  async function pollRadio() {
    if (radioPollInFlight) return;
    radioPollInFlight = true;
    try {
      const response = await fetch(RADIO_STATE_URL, {cache: "no-store", signal: fetchDeadline()});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      radioPollFailures = 0;
      state.radio = {...state.radio, ...next, frequency: Number(next.frequency) || 0};
      if (state.pendingFrequency && state.radio.frequency === state.pendingFrequency) state.pendingFrequency = null;
      // The calibration Worker only ever sees ALC -- it has no SWR meter of its
      // own -- so this is the one feed that can tell it an antenna is reflecting
      // into ALC. Same 500 ms cadence /state itself refreshes on.
      if (state.calRunning) mercuryGainCal.noteMeters({swr: state.radio.swr});
      renderHeader();
      renderTuningPower();
      applyAutoTuningPower();
    } catch (error) {
      radioPollFailures++;
      console.warn(`pollRadio: /state failed (${radioPollFailures} in a row)`, error);
      if (radioPollFailures >= RADIO_POLL_OFFLINE_FAILURES) { state.radio.connected = false; renderHeader(); }
    } finally { radioPollInFlight = false; }
  }

  async function reconnectRadio() {
    if (state.reconnectPending) return;
    state.reconnectPending = true; renderHeader();
    try {
      const response = await fetch("/lan/reconnect", {method: "POST", signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS)});
      if (!response.ok) throw new Error(`Reconnect failed (HTTP ${response.status})`);
      state.radio.lanStatus = "connecting";
    } catch (_error) { /* linkState staying OFFLINE already says so; no separate error banner here */ }
    finally { state.reconnectPending = false; renderHeader(); }
  }

  // Shared with JS8/WSPR's own precondition, so the three DATA pages cannot
  // disagree about whether the LAN link is usable.
  async function checkLanConfiguration() {
    const ready = await LanGate.gate();
    state.lanConfig = {checked: true, ...LanGate.result()};
    renderTrxSlotLabel();
    return ready;
  }

  // ---- bullet 1: band picker ---------------------------------------------
  let frequencyMenuKey = "";

  function closeFrequencyMenu() {
    dom.frequencyMenu.hidden = true;
    dom.trxFrequency.setAttribute("aria-expanded", "false");
  }

  function renderFrequencyMenu() {
    const selected = state.pendingFrequency || state.radio.frequency;
    dom.frequencyMenu.innerHTML = `<header><strong>Mercury dial frequencies</strong>` +
      `<small>Choose a band to tune the TRX</small><span class="tt-actions">` +
      `<button class="tt-clear" type="button" data-menu-close title="Close">CLOSE</button></span></header>` +
      `<div class="frequency-presets">${MercuryTrxPresets.PRESETS.map(item =>
        `<button class="frequency-preset${item.frequencyHz === selected ? " current" : ""}" ` +
        `data-frequency="${item.frequencyHz}" type="button"><strong>${item.band}</strong>` +
        `<span>${formatFrequency(item.frequencyHz)}</span></button>`).join("")}</div>` +
      `<footer>Winlink ARDOP/VARA-HF convention — Region 1 numbers not yet confirmed, see mercury-presets.js</footer>`;
    frequencyMenuKey = String(selected);
  }

  // Tuning a preset also prepares the radio for Mercury by switching to
  // USB-D, only when not already there -- same generic civ.raw endpoint
  // (26 00 <mode> <data> <filter>) data.js's own ensureUsbDataMode() uses, so
  // the firmware CAT code stays untouched.
  async function ensureUsbDataMode() {
    if (!state.radio.connected || state.radio.mode === "USB-D") return;
    const filter = [1, 2, 3].includes(Number(state.radio.filter)) ? Number(state.radio.filter) : 1;
    const data = "26000101" + String(filter).padStart(2, "0");
    try {
      await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({type: "civ.raw", data})});
    } catch (_error) {}
  }

  async function requestFrequency(frequency) {
    state.pendingFrequency = frequency; closeFrequencyMenu(); renderHeader();
    try {
      const response = await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({type: "setFrequency", frequency: String(frequency)})});
      if (!response.ok) throw new Error(`TRX request ${response.status}`);
      await ensureUsbDataMode();
      return true;
    } catch (error) {
      state.pendingFrequency = null; renderHeader();
      throw error;
    }
  }

  // ---- bullet 2: frequency timetable --------------------------------------
  // Structurally JS8's own timetable (one frequency per 30-min UTC slot,
  // data.js's own timetable()/reconcileTimetable()) pointed at bullet 1's
  // presets -- NOT WSPR's band-sequence matrix, which answers a different
  // question ("what order does the beacon run bands in") than this one
  // ("where is this station listening right now").
  let mercurySettings = MercurySettings.load(window.localStorage);
  function persistMercurySettings() { mercurySettings = MercurySettings.save(window.localStorage, mercurySettings); }

  const ttRuntime = {appliedSlotIndex: null, appliedHz: null, appliedBand: null, shownSlotIndex: -1, editSlot: null};

  function timetable() { return mercurySettings.freqTimetable || (mercurySettings.freqTimetable = {enabled: false, slots: {}}); }
  function slotIndexNow() { const d = new Date(); return d.getUTCHours() * 2 + (d.getUTCMinutes() >= 30 ? 1 : 0); }
  function slotLabel(index) { return `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`; }
  function slotText(slot) { return slot ? (slot.band || MercuryTrxPresets.formatFrequency(slot.hz)) : ""; }
  function persistTimetable() { persistMercurySettings(); }

  function timetableDisplay() {
    const tt = timetable();
    if (!tt.enabled) return {text: "OFF", active: false};
    const current = tt.slots[slotIndexNow()];
    if (current) return {text: slotText(current), active: true};
    if (ttRuntime.appliedHz) return {text: ttRuntime.appliedBand || MercuryTrxPresets.formatFrequency(ttRuntime.appliedHz), active: true};
    return {text: "ON", active: true};
  }

  function renderTimetableButton() {
    const view = timetableDisplay();
    dom.freqTimetableValue.textContent = view.text;
    dom.freqTimetableButton.classList.toggle("active", view.active);
    dom.freqTimetablePanel.classList.toggle("active", view.active);
    dom.freqTimetableEnable.textContent = timetable().enabled ? "ON" : "OFF";
    dom.freqTimetableEnable.setAttribute("aria-checked", String(timetable().enabled));
  }

  function renderTimetableGrid() {
    const tt = timetable(), nowIndex = slotIndexNow();
    let html = "";
    for (let hour = 0; hour < 24; hour++) {
      html += `<div class="tt-row"><span class="tt-hour">${String(hour).padStart(2, "0")}</span>`
        + [hour * 2, hour * 2 + 1].map(index => {
            const slot = tt.slots[index];
            return `<button class="tt-cell${slot ? " filled" : ""}${index === nowIndex ? " now" : ""}" type="button" data-slot="${index}" title="${slotLabel(index)} UTC">${slotText(slot) || "·"}</button>`;
          }).join("")
        + `</div>`;
    }
    dom.freqTimetableGrid.innerHTML = html;
    ttRuntime.shownSlotIndex = nowIndex;
  }

  function openTimetablePopover(index, cell) {
    ttRuntime.editSlot = index;
    const tt = timetable(), slot = tt.slots[index], currentHz = slot ? slot.hz : null;
    const bands = MercuryTrxPresets.PRESETS.map(p =>
      `<button class="tt-band${p.frequencyHz === currentHz ? " current" : ""}" type="button" data-band-hz="${p.frequencyHz}" data-band="${p.band}">${p.band}</button>`).join("");
    const pop = dom.freqTimetablePopover;
    pop.innerHTML = `<header><strong>${slotLabel(index)} UTC</strong><small>band or custom kHz</small></header>`
      + `<div class="tt-bands">${bands}</div>`
      + `<div class="tt-custom"><input id="mercuryTtCustom" type="number" inputmode="decimal" step="0.1" placeholder="e.g. 14105" aria-label="Custom frequency in kHz"><button type="button" data-tt-custom>Set kHz</button></div>`
      + `<button class="tt-clear-slot" type="button" data-tt-clear-slot>Clear slot</button>`;
    pop.hidden = false;
    const panelBox = dom.freqTimetablePanel.getBoundingClientRect(), cellBox = cell.getBoundingClientRect();
    const left = Math.max(6, Math.min(cellBox.left - panelBox.left, dom.freqTimetablePanel.clientWidth - pop.offsetWidth - 6));
    pop.style.left = `${left}px`;
    pop.style.top = `${cellBox.bottom - panelBox.top + 4}px`;
    const input = pop.querySelector("#mercuryTtCustom");
    if (input && slot && !slot.band) input.value = String(currentHz / 1000);
  }

  function closeTimetablePopover() {
    ttRuntime.editSlot = null;
    dom.freqTimetablePopover.hidden = true;
    dom.freqTimetablePopover.innerHTML = "";
  }

  function applyTimetableEdit() {
    persistTimetable();
    renderTimetableGrid();
    renderTimetableButton();
    reconcileTimetable();
  }

  function setTimetableSlot(index, hz, band) {
    if (index === null || !Number.isFinite(hz)) return;
    timetable().slots[index] = band ? {hz, band} : {hz};
    applyTimetableEdit();
  }

  function clearTimetableSlot(index) {
    if (index === null) return;
    delete timetable().slots[index];
    applyTimetableEdit();
  }

  function clearTimetable() {
    if (!Object.keys(timetable().slots).length) return;
    if (typeof confirm === "function" && !confirm("Clear the entire frequency timetable?")) return;
    timetable().slots = {};
    applyTimetableEdit();
  }

  function setTimetableEnabled(enabled) {
    timetable().enabled = enabled;
    ttRuntime.appliedSlotIndex = null; ttRuntime.appliedHz = null; ttRuntime.appliedBand = null;
    persistTimetable();
    renderTimetableButton();
    reconcileTimetable();
  }

  function closeTimetablePanel() {
    dom.freqTimetablePanel.hidden = true;
    dom.freqTimetableButton.setAttribute("aria-expanded", "false");
    closeTimetablePopover();
  }

  // The single heartbeat of the schedule. Reruns on a slow tick and after any
  // edit, so it also serves as the "retry once the session clears" mechanism --
  // a due change that lands mid-CALL waits and catches up the instant
  // timetableBusy() clears, never a forced takeover.
  function reconcileTimetable() {
    const tt = timetable(), index = slotIndexNow();
    if (index !== ttRuntime.shownSlotIndex && !dom.freqTimetablePanel.hidden) renderTimetableGrid();
    if (!tt.enabled) {
      ttRuntime.appliedSlotIndex = null; ttRuntime.appliedHz = null; ttRuntime.appliedBand = null;
      renderTimetableButton();
      return;
    }
    const slot = tt.slots[index];
    if (!slot) { ttRuntime.appliedSlotIndex = index; renderTimetableButton(); return; }
    const preset = slot.band ? MercuryTrxPresets.PRESETS.find(item => item.band === slot.band) : null;
    const dialHz = preset ? preset.frequencyHz : slot.hz;
    if (index === ttRuntime.appliedSlotIndex && dialHz === ttRuntime.appliedHz) { renderTimetableButton(); return; }
    if (timetableBusy() || !state.radio.connected) { renderTimetableButton(); return; }
    ttRuntime.appliedSlotIndex = index; ttRuntime.appliedHz = dialHz; ttRuntime.appliedBand = slot.band || null;
    renderTimetableButton();
    requestFrequency(dialHz).catch(() => {});
  }

  // ---- bullet 3: TX gain calibration plan ---------------------------------
  // TxGainPlanUi (data/tx-gain-plan-ui.js) mounted exactly as JS8/WSPR mount
  // it. Its `cal` is data/mercury-gain-cal.js, not their tx-gain-cal-ui.js --
  // see that file's own header for why (a single-tone carrier cannot
  // calibrate a ~7.5 dB-PAPR Mercury burst).
  const mercuryCalBands = () => MercuryTrxPresets.PRESETS.map(preset =>
    ({band: TxGainCal.bandOf(preset.frequencyHz), hz: preset.frequencyHz}));
  const gainStore = new TxGainCal.TxGainStore({
    url: "/mercury-txgain.json",
    fetchImpl: (url, options = {}) => fetch(url, {signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS), ...options}),
  });
  // Read only for one-time migration of the old shared tone plan. Mercury's
  // measured entries never touch this store.
  const legacyToneGainStore = new TxGainCal.TxGainStore({
    fetchImpl: (url, options = {}) => fetch(url, {signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS), ...options}),
  });
  const gainPlanStore = new TxGainPlanStore.PlanStore({
    profile: TxGainPlanStore.PROFILE_MERCURY,
    bands: mercuryCalBands,
    fetchImpl: (url, options = {}) => fetch(url, {signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS), ...options}),
  });

  // The one thing both the calibration adapter and the plan need from this
  // page beyond the radio itself: is the transmitter available AT ALL. A
  // calibration burst needs the same AUD1 socket CALL/LISTEN use, so ANY
  // Mercury worker running -- including an idle LISTEN, unlike
  // timetableBusy() -- blocks it.
  function mercuryBlockingReason() {
    if (!(state.radio.connected && state.radio.transceiverType === "ICOM-LAN")) return "ICOM-LAN is offline";
    if (state.radio.tx) return "TRX PTT is active";
    // Ambient "monitor" does not block this -- onRunChange/onPlanChange
    // below tear it down for the run's duration and restart it afterward,
    // same AUD1 socket, no operator step needed. An actual CALL/LISTEN
    // session (dialing, connected, or armed for an incoming call) still
    // refuses outright rather than interrupting it automatically.
    if (activeSessionRunning()) return "a Mercury CALL/LISTEN session is active — stop it first";
    return "";
  }

  function renderMercuryLock() {
    const busy = state.calRunning || state.planRunning || activeSessionRunning();
    if (dom.callButton) dom.callButton.disabled = busy;
    if (dom.listenToggle) dom.listenToggle.disabled = busy;
    renderTuningLock(); // §6.6: Settings shares this same busy definition
  }

  let gainPlan = null;
  const mercuryGainCal = MercuryGainCal.create({
    store: gainStore,
    radio: () => state.radio,
    model: () => liveRadioModel(),
    percentOf: radio => (radio.rfPowerSeen === true ? WsprCore.civPercent(radio.rfPower) : 0),
    // mercury-worker.js's own uncalibrated fallback (txGainMultiplier = 1.0,
    // raw/unscaled) -- NOT JS8's conservative 0.25, which is a fact about a
    // different carrier and would misreport what an uncalibrated Mercury
    // transmission actually goes out at.
    manualGain: () => 1.0,
    blockingReason: mercuryBlockingReason,
    ensureDataMode: () => ensureUsbDataMode(),
    modLevel: () => (gainPlan ? gainPlan.modLevel() : 0),
    refreshModLevel: () => (gainPlan ? gainPlan.refreshModLevel() : null),
    audioPort: () => 83,
    audioToken: () => MercurySession.token(),
    sessionHeld: () => ownSession,
    // The Mercury session lease (mercury-session.js), not the audio socket
    // itself: the burst authenticates with the SAME token CALL/LISTEN/the
    // ambient monitor worker do, so it must hold the one lease that
    // arbitrates between this station's own pages/devices -- exactly like
    // onCall()/onListenToggle(). The ambient worker already holds it for the
    // whole page lifetime in the normal case; this is a defensive re-claim
    // (same as onListenToggle()'s own), so a run that outlives a closed tab
    // still cannot leave the lease held with nothing using it.
    claimSession: async () => {
      const granted = await MercurySession.claim(false);
      if (granted) ownSession = true;
      return granted;
    },
    releaseSession: () => { if (ownSession) { MercurySession.release(); ownSession = false; } },
    // A calibration burst needs the very same exclusive AUD1 socket the
    // ambient "monitor" worker now holds continuously (see
    // mercuryBlockingReason()'s own comment) -- tear it down for the run's
    // duration and bring it back once done, no operator step needed.
    onRunChange: running => {
      state.calRunning = running;
      if (running && workerRole === "monitor") stopWorker();
      else if (!running) startAmbientWorker();
      renderMercuryLock();
    },
    wallNow: () => Date.now(),
  });

  function createGainPlan() {
    if (gainPlan || typeof TxGainPlanUi === "undefined" || !dom.planField) return gainPlan;
    gainPlan = TxGainPlanUi.create({
      mount: dom.planField,
      button: dom.planButton,
      resultStore: gainStore,
      planStore: gainPlanStore,
      cal: mercuryGainCal,
      calibrationProfileLabel: "Mercury DATAC1",
      model: () => liveRadioModel(),
      modelNumber: () => IcomModels.modelNumber(liveRadioModel()),
      radio: () => state.radio,
      send: async payload => {
        const response = await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
          headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
        if (!response.ok) throw new Error(`${payload.type} failed (${response.status})`);
        return response.json().catch(() => ({ok: true}));
      },
      // TxGainCal.bandOf(hz) -- not preset.band -- because the plan's own
      // guard (tx-gain-plan-ui.js's blockingReason()) rejects a row whenever
      // TxGainCal.bandOf(row.hz) !== row.band: bandOf() returns the no-space
      // form ("20m"), while mercury-presets.js's own preset.band is the
      // display form used in the frequency menu/timetable ("20 m"). Feeding
      // the display form here made every single row fail that check --
      // "20m: 14105.0 kHz is not in that band" on every band, always (found
      // 2026-08-23 by an operator actually trying to calibrate 20 m).
      // data.js's own bands() hook never hits this: it feeds WsprCore.PRESETS,
      // whose own band strings happen to already be the no-space form.
      bands: mercuryCalBands,
      // So the plan can warn about JS8/WSPR's own windows too (registerBusyWindows),
      // the same courtesy those two pages already extend to each other.
      wsprPresets: typeof WsprCore !== "undefined" ? WsprCore.PRESETS : [],
      js8Presets: typeof Js8TrxPresets !== "undefined" ? Js8TrxPresets.PRESETS : [],
      percentOf: radio => (radio.rfPowerSeen === true ? WsprCore.civPercent(radio.rfPower) : 0),
      // No JS8-style "chosen" percent to offer -- Mercury has no operator-facing
      // power field of its own -- only whatever the radio is confirmed at now.
      defaultPowers: () => {
        const out = [];
        if (state.radio.rfPowerSeen === true) out.push(WsprCore.civPercent(state.radio.rfPower));
        return out;
      },
      setFrequency: async hz => {
        await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({type: "setFrequency", frequency: String(hz)})});
        for (let waited = 0; waited < 9000 && state.radio.frequency !== hz; waited += 100)
          await new Promise(resolve => setTimeout(resolve, 100));
        if (state.radio.frequency !== hz)
          throw new Error(`the radio did not confirm the band: asked for ${(hz / 1000).toFixed(1)} kHz, ` +
            `it reports ${(state.radio.frequency / 1000).toFixed(1)} kHz`);
        await new Promise(resolve => setTimeout(resolve, 300));
      },
      setPercent: async percent => {
        const level = WsprCore.percentToLevel(percent);
        const post = payload => fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
          headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
        await post({type: "civ.raw", data: WsprCore.civLevelCommand(level).data});
        const started = Date.now();
        let seen = -1, seenPercent = -1;
        while (Date.now() - started < 9000) {
          try { await post({type: "civ.raw", data: "140A"}); } catch (_error) {}
          await new Promise(resolve => setTimeout(resolve, 300));
          if (state.radio.rfPowerSeen === true) {
            seen = state.radio.rfPower;
            seenPercent = WsprCore.civPercent(seen);
            if (seenPercent === percent || seen === level) return;
          }
        }
        throw new Error(`the radio did not confirm the power: asked for ${percent} % (level ${level})` +
          (seen < 0 ? ", and it never reported a power setting" : `, it reports ${seenPercent} % (level ${seen})`));
      },
      setModeFilter: (mode, filter) => fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({type: "setMode", mode, filter: filter ? "FIL" + filter : undefined})}),
      planBlockingReason: () => "", // cal.blockingReason() (mercuryBlockingReason) already covers this page's own gates
      fetchImpl: (url, options = {}) => fetch(url, {signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS), ...options}),
      // Same AUD1-socket handoff as mercuryGainCal's own onRunChange above.
      onPlanChange: running => {
        state.planRunning = running;
        if (running && workerRole === "monitor") stopWorker();
        else if (!running) startAmbientWorker();
        renderMercuryLock();
      },
    });
    return gainPlan;
  }

  // ==========================================================================
  // §6.6 Settings (2026-08-23 grill-me): ARQ retry/CALLINT/downgrade/mode-
  // ceiling/transfer-limit + RF power. /mercury-tuning.json, ONE station-wide
  // source -- see mercury-tuning.js's own header for why this is not
  // data/mercury-settings.js's MercurySettings (that one is localStorage,
  // scoped to the frequency timetable alone). Read once at page load,
  // written only by SAVE/RESET or a manual power SET; mercury-worker.js
  // reads the same file itself at the START of every session (never
  // mid-transfer -- see mercury-status-plan/mercury-settings-plan memory).
  // ==========================================================================

  const tuningStore = new MercuryTuning.TuningStore({
    fetchImpl: (url, options = {}) => fetch(url, {signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS), ...options}),
  });
  let tuningDoc = MercuryTuning.defaults();

  // Same busy definition as renderMercuryLock(): a running CALL/LISTEN OR a
  // TX-gain CAL/PLAN run all use the one transmitter Settings would also
  // have to write through (CI-V for power, the WASM engine for everything
  // else) -- editing mid-run risks the exact inconsistency §6.6 decided
  // against ("applied only at session start").
  function tuningBusy() { return Boolean(state.calRunning || state.planRunning) || activeSessionRunning(); }

  function renderTuningLock() {
    const busy = tuningBusy();
    [dom.tuningRetryCall, dom.tuningRetryAccept, dom.tuningRetryData, dom.tuningRetryDisconnect,
     dom.tuningCallInt, dom.tuningDowngrade, dom.tuningModeCeiling, dom.tuningTransferLimit,
     dom.tuningPowerPercentInput, dom.tuningPowerSet, dom.tuningSave, dom.tuningReset,
    ].forEach(el => { if (el) el.disabled = busy; });
  }

  function renderTuningFields() {
    dom.tuningRetryCall.value = tuningDoc.retryCallSlots;
    dom.tuningRetryAccept.value = tuningDoc.retryAcceptSlots;
    dom.tuningRetryData.value = tuningDoc.retryDataSlots;
    dom.tuningRetryDisconnect.value = tuningDoc.retryDisconnectSlots;
    dom.tuningCallInt.value = tuningDoc.callIntervalS;
    dom.tuningDowngrade.value = tuningDoc.retryDowngradeThreshold;
    dom.tuningModeCeiling.value = tuningDoc.modeCeiling;
    dom.tuningTransferLimit.value = tuningDoc.transferLimitKb;
    dom.tuningPowerPercentInput.value = tuningDoc.rfPowerPercent === null ? "" : tuningDoc.rfPowerPercent;
    if (dom.settingsSummary) {
      const power = tuningDoc.rfPowerPercent === null ? "power: radio's own" : `${tuningDoc.rfPowerPercent}%`;
      dom.settingsSummary.textContent = `ceiling ${tuningDoc.modeCeiling} · ${power}`;
    }
    renderTuningLock();
  }

  function readTuningFromFields() {
    return {
      retryCallSlots: dom.tuningRetryCall.value,
      retryAcceptSlots: dom.tuningRetryAccept.value,
      retryDataSlots: dom.tuningRetryData.value,
      retryDisconnectSlots: dom.tuningRetryDisconnect.value,
      callIntervalS: dom.tuningCallInt.value,
      retryDowngradeThreshold: dom.tuningDowngrade.value,
      modeCeiling: dom.tuningModeCeiling.value,
      transferLimitKb: dom.tuningTransferLimit.value,
      rfPowerPercent: tuningDoc.rfPowerPercent, // SAVE never touches power -- only SET (setTuningPowerFromField) does
    };
  }

  async function loadTuning() {
    tuningDoc = await tuningStore.load();
    renderTuningFields();
  }

  async function onTuningSave() {
    dom.tuningSaveStatus.textContent = "Saving…";
    dom.tuningSave.disabled = true;
    try {
      tuningDoc = await tuningStore.save(readTuningFromFields());
      renderTuningFields();
      dom.tuningSaveStatus.textContent = "Saved.";
    } catch (error) {
      dom.tuningSaveStatus.textContent = `Save failed: ${error.message || error}`;
    } finally {
      renderTuningLock();
    }
  }

  function onTuningReset() {
    tuningDoc = {...MercuryTuning.defaults(), rfPowerPercent: tuningDoc.rfPowerPercent}; // RESET never touches power either
    renderTuningFields();
    dom.tuningSaveStatus.textContent = "Reset to defaults — not saved yet.";
  }

  // ---- RF power: own stored target, auto-applied on load like JS8/WSPR ----
  // (§6.6 decisions 11-17) but stored in tuningDoc/server, and gated
  // WSPR-style with no safety pledge -- Mercury has none, and writing a
  // power level is not transmitting (same reasoning WSPR's own
  // applyAutoPower() comment gives).
  let tuningPowerAutoArmed = true; // one shot per page load/reconnect, same shape as WSPR's own autoPowerArmed
  let tuningPowerBusy = false;
  let tuningPowerRetryAtMs = 0;

  function renderTuningPower() {
    const connected = state.radio.connected && state.radio.transceiverType === "ICOM-LAN";
    const seen = connected && state.radio.rfPowerSeen === true;
    const level = Math.max(0, Math.min(255, Number(state.radio.rfPower) || 0));
    const percent = seen ? WsprCore.civPercent(level) : null;
    const scale = fullPowerScale();
    const watts = seen && scale.watts ? scale.watts * level / 255 : null;
    dom.tuningPowerWatts.textContent = watts === null ? "--" : formatWatts(watts);
    dom.tuningPowerPercent.textContent = !connected ? "radio offline" : !seen ? "reading the radio" : `${percent} %`;
    const target = tuningDoc.rfPowerPercent;
    const mismatch = connected && seen && target !== null && target !== percent;
    dom.tuningPowerField.classList.toggle("mismatch", mismatch);
    dom.tuningPowerMismatch.hidden = !mismatch;
    if (mismatch) dom.tuningPowerMismatch.textContent = `target ${target} % not applied (radio reports ${percent} %)`;
  }

  // Reconnect (radio.lanStatus flipping to "connecting"/back) re-arms the
  // one-shot exactly like WSPR/JS8's own knob-touch detector does, so a
  // power write survives the radio itself dropping and coming back, not
  // just this tab's own reload.
  let tuningPowerLastLanStatus = "";
  function noteTuningPowerLanStatus() {
    if (state.radio.lanStatus !== tuningPowerLastLanStatus) {
      if (tuningPowerLastLanStatus === "disconnected" && state.radio.lanStatus !== "disconnected") tuningPowerAutoArmed = true;
      tuningPowerLastLanStatus = state.radio.lanStatus;
    }
  }

  async function applyAutoTuningPower() {
    noteTuningPowerLanStatus();
    if (tuningPowerBusy || !tuningPowerAutoArmed) return;
    if (tuningDoc.rfPowerPercent === null) { tuningPowerAutoArmed = false; return; } // nothing chosen -- leave the radio alone
    if (state.calRunning || state.planRunning) return; // a calibration measures the radio as the operator set it up
    if (Date.now() < tuningPowerRetryAtMs) return;
    if (!state.radio.connected || state.radio.transceiverType !== "ICOM-LAN") return;
    if (radioTransmitting()) return; // never mid-carrier
    // Mercury-specific strengthening beyond WSPR's own gate: a running
    // CALL/LISTEN keeps the CI-V control channel busy under real-time ARQ
    // timing pressure ([[icom-lan-loop-stall-compensation]] -- "LAN drop =
    // control starvation under audio load"); an unrelated power write
    // competing for that channel mid-session is a real risk WSPR's own
    // beacon (no ARQ timing to protect) does not have to consider. Checked
    // via activeSessionRunning(), not raw workerRole -- the always-on
    // ambient "monitor" role never transmits and must not block this the
    // way an actual call/listen session does (same exclusion as every
    // other gate in this file).
    if (activeSessionRunning()) return;
    if (state.radio.rfPowerSeen === true && WsprCore.civPercent(state.radio.rfPower) === tuningDoc.rfPowerPercent) {
      tuningPowerAutoArmed = false; // already there -- no CI-V round trip needed to know it
      return;
    }
    tuningPowerBusy = true;
    try {
      const level = WsprCore.percentToLevel(tuningDoc.rfPowerPercent);
      await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({type: "civ.raw", data: WsprCore.civLevelCommand(level).data})});
      tuningPowerAutoArmed = false;
    } catch (_error) {
      tuningPowerRetryAtMs = Date.now() + 5000; // stays armed, backs off rather than flooding a radio that refuses the write
    } finally {
      tuningPowerBusy = false;
      renderTuningPower();
    }
  }

  // The operator's own write (SET button): validates, sends, verifies via
  // the existing 500ms /state poll, AND persists the choice to
  // /mercury-tuning.json -- unlike WSPR/JS8's own SET, which only writes the
  // radio, this one also has to update the stored target so the next page
  // load/reconnect reapplies the SAME value (WSPR/JS8 keep their own target
  // in the settings draft already visible in the field; Mercury's field
  // IS the stored target, there is no separate draft).
  async function setTuningPowerFromField() {
    // Number("") is 0, not NaN, so an empty-vs-invalid check has to look at
    // the parsed value itself, not just the raw string's truthiness --
    // otherwise "abc" or "-5" (non-empty, but not a usable percent) slipped
    // through as `|| 0` silently clamped to 1 and got written to the radio.
    const rawPercent = Number(dom.tuningPowerPercentInput.value);
    if (dom.tuningPowerPercentInput.value === "" || !Number.isFinite(rawPercent)) {
      dom.tuningSaveStatus.textContent = "Enter a power percent first.";
      return;
    }
    const percent = Math.max(1, Math.min(100, Math.round(rawPercent)));
    dom.tuningPowerSet.disabled = true;
    try {
      const level = WsprCore.percentToLevel(percent);
      await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({type: "civ.raw", data: WsprCore.civLevelCommand(level).data})});
      const started = Date.now();
      let confirmed = false;
      while (Date.now() - started < 9000) {
        await new Promise(resolve => setTimeout(resolve, 300));
        if (state.radio.rfPowerSeen === true && WsprCore.civPercent(state.radio.rfPower) === percent) { confirmed = true; break; }
      }
      tuningDoc = await tuningStore.save({...readTuningFromFields(), rfPowerPercent: percent});
      tuningPowerAutoArmed = false;
      renderTuningFields();
      dom.tuningSaveStatus.textContent = confirmed ? `Power set to ${percent} %.` : `Saved ${percent} % as the target — the radio has not confirmed it yet.`;
    } catch (error) {
      dom.tuningSaveStatus.textContent = `Power set failed: ${error.message || error}`;
    } finally {
      dom.tuningPowerSet.disabled = tuningBusy();
      renderTuningPower();
    }
  }

  function onSessionBusy(info) {
    dom.takeoverNotice.hidden = false;
    document.body.classList.add("session-busy-only");
    dom.takeoverDetail.textContent = info.mercuryName
      ? `Mercury transfer “${info.mercuryName}”, ${info.mercuryPercent}% done${info.mercuryRemainingMs ? `, ~${Math.ceil(info.mercuryRemainingMs / 60000)} min remaining` : ""}. Take over and cancel?`
      : `In use elsewhere (${info.owner || "another device"}). Take over?`;
  }

  async function init() {
    // Must return on false rather than rendering a degraded version of
    // itself -- same contract data.js/wspr.js follow (see lan-gate.js).
    // Previously the result was awaited but discarded, so the page kept
    // claiming the Mercury session lease and opening the AUD1 Worker/socket
    // even when the gate said not to start.
    if (typeof LanGate !== "undefined" && !(await checkLanConfiguration())) return;

    [
      "peerCall", "skedTime", "callButton", "connectionTest", "aud1State", "listenToggle", "listenState",
      "takeoverNotice", "takeoverDetail", "takeoverButton",
      "fileInput", "transferEstimate", "sendButton", "cancelButton", "transferProgress", "receivedFiles",
      "cqButton", "heardStations",
      "trxFrequency", "trxFrequencyValue", "trxSlotLabel", "frequencyMenu",
      "trxMode", "trxPower", "trxPowerWatts", "linkState", "trxReconnect",
      "freqTimetableButton", "freqTimetableValue", "freqTimetablePanel", "freqTimetableEnable",
      "freqTimetableClear", "freqTimetableClose", "freqTimetableGrid", "freqTimetablePopover",
      "planButton", "planField",
      "waterfall", "waterfallCanvas", "waterfallOverlay",
      "statusSection", "arqStatus",
      "settingsSummary", "tuningRetryCall", "tuningRetryAccept", "tuningRetryData", "tuningRetryDisconnect",
      "tuningCallInt", "tuningDowngrade", "tuningModeCeiling", "tuningTransferLimit",
      "tuningPowerField", "tuningPowerWatts", "tuningPowerPercent", "tuningPowerPercentInput",
      "tuningPowerSet", "tuningPowerMismatch", "tuningSave", "tuningReset", "tuningSaveStatus",
    ].forEach((id) => { dom[id] = byId(id); });
    dom.trxPowerSegments = Array.from(document.querySelectorAll("#trxPower .pwr-bar i"));

    // §6.7 waterfall: needs the real canvas nodes, so built here, not at
    // module scope (see the `let waterfall = null;` declaration's own
    // comment on why this page differs from JS8/WSPR).
    if (typeof Spectrum !== "undefined" && dom.waterfallCanvas) {
      waterfall = new Spectrum.Waterfall({
        canvas: dom.waterfallCanvas, overlay: dom.waterfallOverlay, container: dom.waterfall,
        sampleRate: 8000, lowHz: 500, highHz: 2700,
      });
      window.addEventListener("resize", () => waterfall.resize());
    }
    // §6.6 mode-ceiling <select>: built from mercury-tuning.js's own list so
    // the two files cannot drift on which modes are offered.
    if (dom.tuningModeCeiling) {
      dom.tuningModeCeiling.innerHTML = MercuryTuning.MODE_CEILING_NAMES
        .map(name => `<option value="${name}">${name}</option>`).join("");
    }

    if (typeof MercurySession === "undefined") return; // gated page (no ICOM-LAN) never got this far

    dom.peerCall.disabled = false;
    dom.callButton.disabled = false;
    dom.listenToggle.disabled = false;
    dom.fileInput.disabled = false;
    dom.cqButton.disabled = true; // enabled only for an active call/listen session -- see startWorker()
    dom.callButton.addEventListener("click", onCall);
    dom.listenToggle.addEventListener("change", onListenToggle);
    dom.fileInput.addEventListener("change", onFileChosen);
    dom.sendButton.addEventListener("click", onSendClick);
    dom.cancelButton.addEventListener("click", onCancelClick);
    dom.cqButton.addEventListener("click", onCqClick);
    dom.listenToggle.checked = MercurySession.isArmed();
    dom.listenState.textContent = dom.listenToggle.checked ? "LISTENING" : "LISTEN OFF";

    MercurySession.onBusy(onSessionBusy);
    MercurySession.onLost(() => {
      stopWorker(); ownSession = false; sessionBusy = false;
      if (dom.listenToggle.checked) { dom.listenToggle.checked = false; MercurySession.setArmed(false); dom.listenState.textContent = "LISTEN OFF"; }
    });
    dom.takeoverButton.addEventListener("click", async () => {
      const granted = await MercurySession.claim(true);
      if (granted) {
        dom.takeoverNotice.hidden = true; document.body.classList.remove("session-busy-only");
        ownSession = true;
        startAmbientWorker();
      }
    });

    // ---- radio-bar wiring: band picker, timetable, CAL PLAN ----
    dom.trxFrequency.addEventListener("click", () => {
      const open = dom.frequencyMenu.hidden;
      dom.frequencyMenu.hidden = !open;
      dom.trxFrequency.setAttribute("aria-expanded", String(open));
    });
    dom.frequencyMenu.addEventListener("click", event => {
      if (event.target.closest("[data-menu-close]")) { closeFrequencyMenu(); return; }
      const button = event.target.closest("[data-frequency]");
      if (button) requestFrequency(Number(button.dataset.frequency)).catch(() => {});
    });
    dom.freqTimetableClose.addEventListener("click", closeTimetablePanel);
    dom.freqTimetableButton.addEventListener("click", () => {
      if (!dom.freqTimetablePanel.hidden) { closeTimetablePanel(); return; }
      dom.freqTimetablePanel.hidden = false;
      dom.freqTimetableButton.setAttribute("aria-expanded", "true");
      renderTimetableGrid(); renderTimetableButton();
    });
    dom.freqTimetableEnable.addEventListener("click", () => setTimetableEnabled(!timetable().enabled));
    dom.freqTimetableClear.addEventListener("click", clearTimetable);
    dom.freqTimetableGrid.addEventListener("click", event => {
      const cell = event.target.closest("[data-slot]");
      if (!cell) return;
      const index = Number(cell.dataset.slot);
      if (ttRuntime.editSlot === index) { closeTimetablePopover(); return; }
      openTimetablePopover(index, cell);
    });
    dom.freqTimetablePopover.addEventListener("click", event => {
      const band = event.target.closest("[data-band-hz]");
      if (band) { setTimetableSlot(ttRuntime.editSlot, Number(band.dataset.bandHz), band.dataset.band); closeTimetablePopover(); return; }
      if (event.target.closest("[data-tt-custom]")) {
        const input = dom.freqTimetablePopover.querySelector("#mercuryTtCustom");
        const hz = Math.round((Number(input && input.value) || 0) * 1000);
        if (hz >= MercurySettings.TIMETABLE_MIN_HZ && hz <= MercurySettings.TIMETABLE_MAX_HZ) { setTimetableSlot(ttRuntime.editSlot, hz, null); closeTimetablePopover(); }
        else if (input) input.focus();
        return;
      }
      if (event.target.closest("[data-tt-clear-slot]")) { clearTimetableSlot(ttRuntime.editSlot); closeTimetablePopover(); return; }
    });
    dom.freqTimetablePopover.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.target.id !== "mercuryTtCustom") return;
      event.preventDefault();
      const hz = Math.round((Number(event.target.value) || 0) * 1000);
      if (hz >= MercurySettings.TIMETABLE_MIN_HZ && hz <= MercurySettings.TIMETABLE_MAX_HZ) { setTimetableSlot(ttRuntime.editSlot, hz, null); closeTimetablePopover(); }
    });
    document.addEventListener("click", event => {
      if (dom.freqTimetablePopover.hidden) return;
      if (event.target.closest(".tt-popover") || event.target.closest("[data-slot]")) return;
      closeTimetablePopover();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") { closeFrequencyMenu(); closeTimetablePanel(); }
    });
    dom.trxReconnect.addEventListener("click", reconnectRadio);

    // ---- §6.6 Settings wiring ----
    dom.tuningSave.addEventListener("click", onTuningSave);
    dom.tuningReset.addEventListener("click", onTuningReset);
    dom.tuningPowerSet.addEventListener("click", setTuningPowerFromField);
    loadTuning();

    createGainPlan();
    // Adopt the shared matrix and import plans left in either legacy result
    // document. Tone is first so an existing JS8/WSPR/RTTY matrix remains the
    // authority; Mercury contributes only its DATAC1 calibration frequencies.
    gainPlanStore.loadAndMigrate([
      {profile: TxGainPlanStore.PROFILE_TONE, store: legacyToneGainStore},
      {profile: TxGainPlanStore.PROFILE_MERCURY, store: gainStore},
    ]).then(() => { if (gainPlan) gainPlan.reload(); });
    renderTimetableButton();
    renderHeader();
    if (waterfall) waterfall.resize();
    pollRadio();
    setInterval(pollRadio, 500);
    setInterval(reconcileTimetable, 5000);

    // Session held for the page's whole lifetime now, same as JS8/WSPR's own
    // audio lease -- claimed once here, not re-claimed per CALL/LISTEN
    // action. Grant starts the ambient worker immediately ("monitor", or
    // "listen" if a previous explicit LISTEN persisted across the reload) so
    // the waterfall is alive from the first paint, independent of whether
    // this station will ever answer anything. Refusal already shows the
    // takeover panel via the onBusy callback registered above.
    const granted = await MercurySession.claim(false);
    if (granted) { ownSession = true; startAmbientWorker(); }

    window.addEventListener("beforeunload", () => { stopWorker(); if (ownSession) MercurySession.release(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}());
