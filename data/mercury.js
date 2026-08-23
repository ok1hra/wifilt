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
    if (reason) setAud1Pill(reason);
  }

  function releaseIfOurs() {
    stopWorker();
    if (ownSession) { MercurySession.release(); ownSession = false; }
    dom.callButton.disabled = false;
    dom.peerCall.disabled = false;
    dom.armToggle.disabled = false;
  }

  function handleWorkerMessage(msg) {
    if (window.__mercuryDebug) window.__mercuryDebug.push({ t: Date.now(), msg });
    if (msg.type === "log") return; // debug only, not shown to the operator
    if (msg.type === "error") {
      setAud1Pill("error", "error");
      setConnectionTest(`<p class="connection-test-line muted">${msg.reason}${msg.detail ? " -- " + msg.detail : ""}</p>`, true);
      stopWorker();
      if (dom.armToggle.checked) dom.armToggle.checked = false;
      releaseIfOurs();
      return;
    }
    if (msg.type === "status") {
      setAud1Pill(msg.connState.toLowerCase());
      if (msg.connState === "CALLING") {
        setConnectionTest(`<p class="connection-test-line">Calling <b>${dom.peerCall.value.trim().toUpperCase()}</b>...</p>`, true);
      } else if (msg.connState === "LISTENING") {
        setConnectionTest(`<p class="connection-test-line">Listening -- armed, waiting for an incoming CALL.</p>`, true);
      }
      return;
    }
    if (msg.type === "connected") {
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
      setConnectionTest(`<p class="connection-test-line muted">No response -- call ended.</p>`, true);
      resetTransferUi();
      if (workerRole === "call") releaseIfOurs();
      return;
    }
    if (msg.type === "stopped") { setAud1Pill("idle"); resetTransferUi(); return; }

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
  }

  function startWorker(role, peerCall, myCall) {
    stopWorker();
    worker = new Worker("/mercury-worker.js");
    workerRole = role;
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (e) => handleWorkerMessage({ type: "error", reason: "worker crashed", detail: e.message });
    worker.postMessage({ type: "start", wsPort: 83, token: MercurySession.token(), myCall, peerCall: peerCall || "", role });
    setAud1Pill("connecting");
    dom.cqButton.disabled = false;
    dom.heardStations.textContent = "";
    heardStations.clear();
  }

  // "who's out there" -- doc ch.10's E4 gate's last item (CQ/unattended
  // discovery). Sendable in any connection state (LISTENING, CALLING, even
  // mid-transfer -- see mercury-worker.js's sendCq()), so this button is
  // gated only on "is a Worker running at all", same as the arm toggle
  // isn't gated on CONNECTED.
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
    const peer = dom.peerCall.value.trim().toUpperCase();
    if (!peer) return;
    const identity = await withIdentity();
    if (!identity.call) { setConnectionTest(`<p class="connection-test-line muted">Set this station's own callsign in SETUP first.</p>`, true); return; }
    const granted = await MercurySession.claim(false);
    if (!granted) return; // onBusy already showed the takeover panel
    ownSession = true;
    dom.callButton.disabled = true;
    dom.armToggle.disabled = true;
    startWorker("call", peer, identity.call);
  }

  async function onArmToggle() {
    MercurySession.setArmed(dom.armToggle.checked);
    dom.armState.textContent = dom.armToggle.checked ? "ARMED" : "NOT ARMED";
    if (!dom.armToggle.checked) { releaseIfOurs(); setConnectionTest(`<p class="connection-test-line muted">Not armed -- Mercury cannot be reached even with this page open.</p>`, true); return; }
    const identity = await withIdentity();
    if (!identity.call) {
      setConnectionTest(`<p class="connection-test-line muted">Set this station's own callsign in SETUP first.</p>`, true);
      dom.armToggle.checked = false; MercurySession.setArmed(false); dom.armState.textContent = "NOT ARMED";
      return;
    }
    const granted = await MercurySession.claim(false);
    if (!granted) { dom.armToggle.checked = false; MercurySession.setArmed(false); dom.armState.textContent = "NOT ARMED"; return; }
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

  function onSessionBusy(info) {
    dom.takeoverNotice.hidden = false;
    document.body.classList.add("session-busy-only");
    dom.takeoverDetail.textContent = info.mercuryName
      ? `Mercury transfer “${info.mercuryName}”, ${info.mercuryPercent}% done${info.mercuryRemainingMs ? `, ~${Math.ceil(info.mercuryRemainingMs / 60000)} min remaining` : ""}. Take over and cancel?`
      : `In use elsewhere (${info.owner || "another device"}). Take over?`;
  }

  function init() {
    if (typeof LanGate !== "undefined") LanGate.gate();
    [
      "peerCall", "skedTime", "callButton", "connectionTest", "aud1State", "armToggle", "armState",
      "takeoverNotice", "takeoverDetail", "takeoverButton",
      "fileInput", "transferEstimate", "sendButton", "cancelButton", "transferProgress", "receivedFiles",
      "cqButton", "heardStations",
    ].forEach((id) => { dom[id] = byId(id); });

    if (typeof MercurySession === "undefined") return; // gated page (no ICOM-LAN) never got this far

    dom.peerCall.disabled = false;
    dom.callButton.disabled = false;
    dom.armToggle.disabled = false;
    dom.fileInput.disabled = false;
    dom.cqButton.disabled = true; // enabled once a Worker is actually running -- see startWorker()
    dom.callButton.addEventListener("click", onCall);
    dom.armToggle.addEventListener("change", onArmToggle);
    dom.fileInput.addEventListener("change", onFileChosen);
    dom.sendButton.addEventListener("click", onSendClick);
    dom.cancelButton.addEventListener("click", onCancelClick);
    dom.cqButton.addEventListener("click", onCqClick);
    dom.armToggle.checked = MercurySession.isArmed();
    dom.armState.textContent = dom.armToggle.checked ? "ARMED" : "NOT ARMED";

    MercurySession.onBusy(onSessionBusy);
    MercurySession.onLost(() => { stopWorker(); ownSession = false; if (dom.armToggle.checked) { dom.armToggle.checked = false; dom.armState.textContent = "NOT ARMED"; } });
    dom.takeoverButton.addEventListener("click", async () => {
      const granted = await MercurySession.claim(true);
      if (granted) { dom.takeoverNotice.hidden = true; document.body.classList.remove("session-busy-only"); }
    });

    if (dom.armToggle.checked) onArmToggle(); // restore LISTEN across a reload, same honesty WSPR's own pledge uses

    window.addEventListener("beforeunload", () => { stopWorker(); if (ownSession) MercurySession.release(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}());
