"use strict";

// JS8Call page controller. Modem DSP lives in a Worker; this file owns only the
// public modem contracts, radio/audio adapters and DOM projection.

const PAGE_PARAMS = new URLSearchParams(location.search);
const TEST_MODE = PAGE_PARAMS.has("test");
const ASSET_REV = "ce4552e0";
// Two of the files the worker importScripts() are also loaded by this page with
// its own <script> tag, and each carried an independent version: the tag in
// data.html and ASSET_REV here. Nothing forced them to agree, and js8-protocol.js
// had already drifted (20260801a in the tag, 20260719d here) -- with
// Cache-Control: max-age=3600 on static assets that lets the page run for an hour
// on a newer protocol than its own worker, which is where the ActivityStore
// actually lives. The page's tag is therefore the single truth wherever the
// document loads the file at all; ASSET_REV still serves the worker-only assets
// (the wasm blobs, the worker runtime, the JSC dictionary), which have one URL
// and cannot drift.
const PAGE_ASSETS = new Map([...document.querySelectorAll("script[src]")]
  .map(node => node.getAttribute("src"))
  .map(src => [src.split("?")[0], src]));
const assetUrl = path => PAGE_ASSETS.get(path) || `${path}?v=${ASSET_REV}`;
const TRX_HELP_SEEN_KEY = "wifilt.data.trx-help-seen.v1";
// This page drives the LAN radio, which the operator may have put on any of the
// three TRX slots, so it asks the firmware for that radio by name rather than
// for "the primary radio" -- /state and /cmd without the marker still mean TRX1
// and are what the log page, band decoder and WSPR read.
const RADIO_STATE_URL = "/state?radio=lan";
const RADIO_CMD_URL = "/cmd?radio=lan";
const AUDIO_WS_PORT = Number(new URLSearchParams(location.search).get("audioPort")) || 83;
const RX_LOW = 500, RX_HIGH = 2700, HB_HIGH = 1000, AUDIO_RATE = 8000;
const FFT_SIZE = 4096, HOP_SIZE = 2048;
const SPEED_TO_MODE = {A:0, B:1, C:2, E:4, I:8};
const MODE_TO_SPEED = {0:"A", 1:"B", 2:"C", 4:"E", 8:"I"};
// One source of truth with the reassembly store, which needs the slot length to tell a
// missed frame from a frame that has not arrived yet.
const MODE_PERIOD_SECONDS = Js8Protocol.MODE_PERIOD_SECONDS;
const ACTIVITY_FREQUENCY_TOLERANCE_HZ = 2000;

function emptyActivity() {
  return {messages:[], calls:[], timing:[], frames:[], channels:[], clearedAtMs:0};
}

class AudioSource {
  constructor(sampleRate) { this.sampleRate = sampleRate; this._cb = null; }
  onSamples(callback) { this._cb = callback; return this; }
  start() {}
  stop() {}
}

class Decoder {
  constructor(sampleRate) { this.sampleRate = sampleRate; this._onText = null; this._onEvent = null; }
  pushSamples(_samples, _metadata) {}
  onText(callback) { this._onText = callback; return this; }
  onEvent(callback) { this._onEvent = callback; return this; }
  configure(_options) { return this; }
  _emit(text) { if (this._onText) this._onText(text); }
  reset(_reason) {}
}

class Encoder {
  constructor(sampleRate) { this.sampleRate = sampleRate; this.toneHz = 1500; this._onAudio = null; this._onEvent = null; }
  setToneOffset(hz) { this.toneHz = hz; return this; }
  configure(_options) { return this; }
  encode(_text, _context) {}
  onAudio(callback) { this._onAudio = callback; return this; }
  onEvent(callback) { this._onEvent = callback; return this; }
  _emit(samples, rate, metadata) { if (this._onAudio) this._onAudio(samples, rate, metadata); }
  abort() {}
}

const Modems = {};
function registerModem(id, definition) {
  if (!id || !definition || !definition.label) throw new Error("Invalid modem registration");
  Modems[id] = definition;
}

// Keep the documented modem extension contract reachable after the release
// build mangles private top-level names for the tight SPIFFS image.
Object.assign(globalThis, {AudioSource, Modems, registerModem, Decoder, Encoder});

const $ = id => document.getElementById(id);
const dom = {
  radioBar:document.querySelector(".radio-bar"), trxFrequency:$("trxFrequency"),
  trxFrequencyValue:$("trxFrequencyValue"), trxSlotLabel:$("trxSlotLabel"),
  trxMode:$("trxMode"), trxDot:$("trxDot"),
  trxPower:$("trxPower"), trxPowerWatts:$("trxPowerWatts"),
  rfPowerField:$("rfPowerField"), rfPercent:$("rfPercent"), rfPercentWatts:$("rfPercentWatts"),
  rfPercentSet:$("rfPercentSet"), rfPercentState:$("rfPercentState"),
  trxPowerSegments:Array.from(document.querySelectorAll("#trxPower .pwr-bar i")),
  trxHelpButton:$("trxHelpButton"), trxHelpDialog:$("trxHelpDialog"),
  trxHelpModeWarning:$("trxHelpModeWarning"),
  frequencyMenu:$("frequencyMenu"), freqTimetableClose:$("freqTimetableClose"), linkState:$("linkState"), stationIdentity:$("stationIdentity"),
  freqTimetableButton:$("freqTimetableButton"), freqTimetableValue:$("freqTimetableValue"),
  freqTimetablePanel:$("freqTimetablePanel"), freqTimetableEnable:$("freqTimetableEnable"),
  freqTimetableClear:$("freqTimetableClear"), freqTimetableGrid:$("freqTimetableGrid"),
  freqTimetablePopover:$("freqTimetablePopover"),
  trxReconnect:$("trxReconnect"),
  utcClock:$("utcClock"), timingState:$("timingState"), modeSelect:$("modeSelect"),
  modemState:$("modemState"), js8:$("js8Interface"),
  spectrumSummary:$("spectrumSummary"), waterfall:$("waterfall"), canvas:$("waterfallCanvas"),
  overlay:$("waterfallOverlay"), recipient:$("recipient"), txSpeed:$("txSpeed"),
  slotMeter:$("slotMeter"), slotLabel:$("slotLabel"), slotFill:$("slotFill"),
  txSpeedResolved:$("txSpeedResolved"), recipientClear:$("recipientClear"),
  txOffset:$("txOffset"), audioLevel:$("audioLevel"), txSummary:$("txSummary"),
  heartbeat:$("heartbeatButton"), heartbeatOffset:$("heartbeatOffset"),
  tune:$("tuneButton"), tuneLabel:$("tuneLabel"), tuneOffset:$("tuneOffset"),
  sessionCall:$("sessionCall"), sessionMeta:$("sessionMeta"), abort:$("abortButton"), logQso:$("logQsoButton"),
  txSessionMode:$("txSessionMode"), txSessionModeHint:$("txSessionModeHint"),
  txPayload:$("txPayload"),
  chatSession:$("chatSession"), emailSession:$("emailSession"), binSession:$("binSession"),
  chat:$("chatThread"), composer:$("composer"), message:$("messageInput"), send:$("sendButton"),
  emailComposer:$("emailComposer"), emailAddress:$("emailAddress"),
  emailGateway:$("emailGateway"), emailGatewayAdd:$("emailGatewayAdd"),
  emailGatewayEdit:$("emailGatewayEdit"), emailGatewayDelete:$("emailGatewayDelete"),
  emailGatewayDetails:$("emailGatewayDetails"), emailMessage:$("emailMessage"),
  emailBudget:$("emailBudget"), emailPreview:$("emailPreview"), emailError:$("emailError"),
  emailStatus:$("emailStatus"), emailSend:$("emailSend"),
  emailGatewayDialog:$("emailGatewayDialog"), emailGatewayForm:$("emailGatewayForm"),
  emailGatewayDialogTitle:$("emailGatewayDialogTitle"), emailGatewayName:$("emailGatewayName"),
  emailGatewayTarget:$("emailGatewayTarget"), emailGatewayDial:$("emailGatewayDial"),
  emailGatewayOffset:$("emailGatewayOffset"), emailGatewayFormat:$("emailGatewayFormat"),
  emailGatewayTemplateRow:$("emailGatewayTemplateRow"), emailGatewayTemplate:$("emailGatewayTemplate"),
  emailGatewayMaxBody:$("emailGatewayMaxBody"), emailGatewayPolicy:$("emailGatewayPolicy"),
  emailGatewayError:$("emailGatewayError"), emailConfirmDialog:$("emailConfirmDialog"),
  emailConfirmGateway:$("emailConfirmGateway"), emailConfirmFrequency:$("emailConfirmFrequency"),
  emailConfirmOffset:$("emailConfirmOffset"), emailConfirmFrames:$("emailConfirmFrames"),
  emailConfirmPayload:$("emailConfirmPayload"),
  binComposer:$("binComposer"), binRecipient:$("binRecipient"), binFile:$("binFile"),
  binFileDetails:$("binFileDetails"), binPeerExpected:$("binPeerExpected"),
  binError:$("binError"), binDraftStatus:$("binDraftStatus"), binOffer:$("binOffer"),
  binTransferPanel:$("binTransferPanel"), binTransferTitle:$("binTransferTitle"),
  binTransferPeer:$("binTransferPeer"), binTransferState:$("binTransferState"),
  binProgress:$("binProgress"), binProgressText:$("binProgressText"),
  binTransferRate:$("binTransferRate"), binLastActivity:$("binLastActivity"),
  binTransferId:$("binTransferId"), binTransferHash:$("binTransferHash"),
  binProtocolMessage:$("binProtocolMessage"), binTransferLog:$("binTransferLog"),
  binPause:$("binPause"), binResume:$("binResume"), binStop:$("binStop"),
  binDownload:$("binDownload"), binConfirmDialog:$("binConfirmDialog"),
  binConfirmPeer:$("binConfirmPeer"), binConfirmFile:$("binConfirmFile"),
  binConfirmProfile:$("binConfirmProfile"), binConfirmPlan:$("binConfirmPlan"),
  binConfirmHash:$("binConfirmHash"), binCopyHash:$("binCopyHash"), binIncomingDialog:$("binIncomingDialog"),
  binIncomingPeer:$("binIncomingPeer"), binIncomingFile:$("binIncomingFile"),
  binIncomingSize:$("binIncomingSize"), binIncomingHash:$("binIncomingHash"),
  messagePresetsButton:$("messagePresetsButton"), messagePresetsMenu:$("messagePresetsMenu"),
  sendHint:$("sendHint"), aprsParamDialog:$("aprsParamDialog"), aprsParamForm:$("aprsParamForm"),
  aprsParamTitle:$("aprsParamTitle"), aprsParamGrid:$("aprsParamGrid"),
  aprsParamError:$("aprsParamError"), aprsParamPreview:$("aprsParamPreview"),
  aprsParamCost:$("aprsParamCost"), aprsParamInsert:$("aprsParamInsert"),
  aprsRecentCalls:$("aprsRecentCalls"),
  traffic:$("traffic"), trafficSummary:$("trafficSummary"), stationRows:$("stationRows"),
  trafficHistogram:$("trafficHistogram"),
  trafficSection:document.querySelector('[data-section="traffic"]'),
  trafficFilter:document.querySelector(".traffic-filter"),
  trafficClear:document.querySelector("[data-traffic-clear]"),
  trafficHide:document.querySelector("[data-traffic-hide]"),
  stationsSection:document.querySelector('[data-section="stations"]'),
  stationMapSection:document.querySelector('[data-section="stations-map"]'),
  stationMap:$("stationMap"), stationMapSummary:$("stationMapSummary"), stationMapLinks:$("stationMapLinks"),
  stationMapLog:$("stationMapLog"),
  stationHead:document.querySelector(".traffic-table thead"), reply:document.querySelector('[data-section="reply"]'),
  stationSummary:$("stationSummary"), myCall:$("myCall"), myGrid:$("myGrid"),
  promoteRow:$("promoteRow"), promoteSettings:$("promoteSettings"), promoteState:$("promoteState"),
  followSpeed:$("followSpeed"), clockCorrection:$("clockCorrection"), autoTiming:$("autoTiming"),
  txGain:$("txGain"), calResolved:$("calResolved"), calField:$("calField"),
  planField:$("planField"), planButton:$("planButton"),
  txSafety:$("txSafety"), storageState:$("storageState"),
  txQueueState:$("txQueueState"),
  hbEnabled:$("hbEnabled"), hbMinutes:$("hbMinutes"), hbAck:$("hbAck"), hbState:$("hbState"),
  groups:$("groups"), groupNames:$("groupNames"), groupsHint:$("groupsHint"),
  groupsButton:$("groupsButton"), stationGroupsButton:$("stationGroupsButton"),
  groupPanel:$("groupPanel"), groupPanelGrid:$("groupPanelGrid"), groupAddForm:$("groupAddForm"),
  cqRepeat:$("cqRepeat"), cqState:$("cqState"),
  infoText:$("infoText"), statusText:$("statusText"), statusPreset:$("statusPreset"),
  statusPreview:$("statusPreview"), autoReply:$("autoReply"), alertBeep:$("alertBeep"),
  inboxRows:$("inboxRows"), inboxSummary:$("inboxSummary"), inboxQueryMsgs:$("inboxQueryMsgs"), inboxRefresh:$("inboxRefresh"),
  inboxFilters:$("msgBoxFilters"), inboxUndo:$("msgBoxUndo"), inboxUndoButton:$("msgBoxUndoButton"),
  inboxHint:$("msgBoxHint"), inboxSection:document.querySelector('[data-section="inbox"]'),
  sendLater:$("sendLaterButton"),
  armHours:$("armHours"), autoState:$("autoState"),
  resetSettings:$("resetSettings"), settingsSummary:$("settingsSummary"), settingsFlags:$("settingsFlags"),
  diagnosticSummary:$("diagnosticSummary"), diagnostics:$("diagnostics"),
  sessionBusy:$("sessionBusy"), sessionBusyWhere:$("sessionBusyWhere"),
  sessionBusyDetail:$("sessionBusyDetail"), sessionTakeover:$("sessionTakeover"),
  startup:$("startupLoader"), startupProgress:$("startupProgress"),
  startupPercent:$("startupPercent"), startupLabel:$("startupLabel"),
  startupDetail:$("startupDetail"), startupRetry:$("startupRetry")
};

const loaded = Js8Settings.load(localStorage);
let settings = loaded.settings;

// One clock and one scheduler for the whole page. Everything time-driven
// registers with `scheduler`; the master interval below is the ONLY
// setTimeout/setInterval in this file. Keeping it that way is what makes
// background operation (L3) a swap of `js8Clock.now` plus a different tick
// source, instead of another rewrite of the TX path.
const js8Clock = {now: () => Date.now()};
// Scheduler anomalies (coalesced backlogs, a task that threw) must never be
// silent -- they are the first symptom when timing misbehaves.
const scheduler = new Js8Scheduler.Js8Scheduler({wallNow: () => js8Clock.now(),
  onEvent: event => console.warn("[js8-scheduler]", event.type, event)});
const TICK_IDLE_MS = 100, TICK_TX_MS = 20;

// Auto-reply decision layer. Both are pure; they never transmit. Every refusal
// carries a reason and is logged, so the station never goes quiet unexplained.
const restrictions = new Js8Restrictions.Js8Restrictions({
  onEvent: event => console.warn("[js8-restrictions]", event.type, event)});
// The firmware holds the durable copy (decision 10); this store is the working
// mirror. Loaded once at start, written back whenever it changes, so mail
// survives a reload and is readable from /msgbox on any device.
const inboxStore = new Js8Inbox.MemoryStore();
// Types, eviction and the operator actions live here; the inbox engine above it
// only decides what the protocol may do. Both work on this one store.
let msgBoxFull = false;      // nothing evictable left and still over budget
const msgBox = new Js8MsgBox.Js8MsgBox({store: inboxStore,
  onEvent: event => console.info("[msgbox]", event.type, event.id || "",
    event.recordType || "", event.from || "")});
let inboxSyncPending = false;
function syncInbox() {
  if (inboxSyncPending) return;
  inboxSyncPending = true;
  // Trim BEFORE serializing: the firmware answers 413 over its cap, and a mirror
  // that keeps growing past a refused write looks healthy until a reload finds
  // flash still holding the last body that fit.
  const outcome = msgBox.enforceBudget();
  if (outcome.evicted.length)
    console.info("[msgbox] evicted", outcome.evicted.length, "records to fit flash");
  msgBoxFull = outcome.full;
  const body = msgBox.toJsonl();
  fetch("/msgbox", {method: "POST", headers: {"Content-Type": "text/plain"}, body})
    .then(response => { if (!response.ok) throw new Error(String(response.status)); })
    .catch(error => {
      // A refused write is a state the operator has to see, not a console line:
      // from here on the durable copy and this tab disagree.
      msgBoxFull = true;
      console.warn("[msgbox] firmware did not store:", error.message);
      renderInbox();
    })
    .finally(() => { inboxSyncPending = false; });
}
function loadInbox() {
  fetch("/msgbox", {cache: "no-store"})
    .then(response => response.ok ? response.text() : Promise.reject(new Error(String(response.status))))
    .then(text => {
      const result = msgBox.loadJsonl(text);
      if (result.restored)
        console.info("[msgbox] restored", result.restored, "records from firmware");
      // The pre-type file comes back through the same endpoint; writing it out
      // once in the new shape is what completes the migration and lets the
      // firmware drop the old file.
      if (result.migrated) {
        console.info("[msgbox] migrated", result.migrated, "records to typed records");
        syncInbox();
      }
      if (result.dropped) console.warn("[msgbox]", result.dropped, "unreadable lines dropped");
      renderInbox();
    })
    .catch(error => console.warn("[msgbox] could not load:", error.message));
}
const inbox = new Js8Inbox.Js8Inbox({store: inboxStore,
  onEvent: event => { console.info("[js8-inbox]", event.type, event.id || "",
    event.reason || "", event.detail || "");
    // Mail arriving is exactly when the header has to light up, so the panel is
    // redrawn here rather than waiting for the next decode to redraw the page.
    syncInbox(); renderInbox(); }});
const relay = new Js8Relay.Js8Relay({
  onEvent: event => console.info("[js8-relay]", event.type,
    event.to || "", event.reason || "", event.detail || event.text || "")});
const heartbeat = new Js8Heartbeat.Js8Heartbeat({restrictions,
  onEvent: event => console.info("[js8-heartbeat]", event.type, event.to || "", event.detail || "")});
const txCaptured = [];
const txQueue = new Js8TxQueue.Js8TxQueue({
  onEvent: event => {
    if (event.type === "queued") txCaptured.push({source: event.source, to: event.to, text: event.text});
    if (event.type === "expired") noteTxQueueExpiry(event);
    console.info("[js8-txqueue]", event.type, event.source || "",
      event.to || "", event.detail || "");
  }});
const autoReply = new Js8AutoReply.Js8AutoReply({restrictions,
  onEvent: event => {
    if (event.type === "skip") console.info("[js8-autoreply] skip:", event.reason, event.detail || "");
    else console.info("[js8-autoreply]", event.type, event.to, event.text);
  }});
let masterTimer = null, masterPeriodMs = 0;
function setMasterTick(periodMs) {
  if (masterTimer && masterPeriodMs === periodMs) return;
  if (masterTimer) clearInterval(masterTimer);
  masterPeriodMs = periodMs;
  masterTimer = setInterval(() => scheduler.tick(), periodMs);
}
const emailState = {gateways:Js8Email.load(localStorage),selectedId:"",editingId:"",
  pendingDraft:null,activeOutgoing:null,status:"Draft is not stored in message history."};
if(emailState.gateways.length)emailState.selectedId=emailState.gateways[0].id;
const transferStore=new Js8FileTransfer.TransferStore();
const binState={sessions:[],active:null,prepared:null,preparing:false,peerDraft:"",
  txQueue:[],txCurrent:null,responseTimer:null,incomingOffer:null,nackParts:new Map(),
  lastProtocol:"",storageError:"",restored:false};
const state = {
  radio:{connected:false, lanStatus:"connecting", transceiverType:"", power:false, frequency:0, mode:"", tx:false, rfPower:0, rfPowerSeen:false, radioName:""},
  activeMode:settings.activeModem, selectedCall:"", activity:emptyActivity(),
  activityFrequency:0, activitySessions:[],
  conversations:{}, audioStatus:"stopped", decoderStatus:"loading", txStatus:"idle",
  txState:null, txWasmReady:false, pendingFrequency:null, lastAudioMs:0,
  startup:{ready:false, failed:false, progress:0, label:"Loading JS8Call-ICOM modem",
    detail:"Preparing modem components…"},
  stationSort:{key:"lastSlotUtcMs", direction:"desc"}, trafficFilter:"all", trafficHide:0, testActivityLocked:false,
  previewHz:null, stationLabels:[], stationLabelsVisible:false, stationLabelsArmedMs:0,
  hearingLinksVisible:true, mapLogScale:false,
  txSessionMode:"CHAT", audioDb:-90, tuneActive:false, spectrumWasTransmitting:false,
  help:{incompatibleActive:false},
  lanConfig:{checked:false, ready:false, detail:"", slot:0},
  ownCallAttention:{call:"", messages:new Set(), stations:new Set()},
  // Rows addressed to us, so the beep fires once per message. `seeded` keeps the
  // first render after a reload silent: everything on screen is history, and a
  // burst of tones for messages that arrived while the tab was shut is noise.
  answerAttention:{call:"", messages:new Set(), seeded:false},
  activeOutgoing:null, lastOutgoing:null, outgoingLog:[],
  blockedDxccList:[],
  settingsDraft:{txGain:null}, reconnectPending:false,
  js8Log:null, loggedCalls:new Set(), autoLogInFlight:new Set(),
  autoExpiryAt:null, // epoch ms when unattended arming lapses (null = unknown/disarmed)
};
let audioSource = null, activeDecoder = null, activeEncoder = null;
// Whether the modem ever came up in this page's life, and whether the one free
// retry has been spent. Both are per page load: a retry loop would hide the
// failure it is retrying.
let modemEverReady = false, modemRetried = false;
let radioPollInFlight = false;
let frequencyMenuKey = "";
const decoderActivitySeen = {messages:new Set(), frames:new Set(), calls:new Map()};

// ---- Session snapshot: survive a round-trip to QRPLog / SETUP ----------------
// The header tabs are full-page navigations, so leaving /data tears down the
// whole JS8 runtime (decoder worker, audio WebSocket, in-memory activity). We
// snapshot the operator-visible session into sessionStorage on the way out and
// rebuild it on return, so received messages, conversations and the compose
// draft survive. Audio and live decoding are deliberately not restored (they
// cannot resume mid-slot); a divider in the traffic list marks the pause. The
// key is versioned and any corrupt/stale snapshot is discarded, never fatal.
const SESSION_SNAPSHOT_KEY = "js8lan.session.v1";
const SESSION_MAX_BUCKETS = 20;
const SESSION_MAX_CONVERSATION = 200;
const TX_LIVE_STATUSES = ["queued","transmitting","draining"];
let sessionPersistTimer = null;
let sessionRestored = false; // a snapshot was rebuilt on this page load

function sessionStore() { try { return globalThis.sessionStorage; } catch (_error) { return null; } }

// A transmission in progress when the operator left cannot resume mid-frame, so
// it is recorded as interrupted with a one-click resend offer instead.
function snapshotOutgoing(item) {
  const copy = {...item};
  if (TX_LIVE_STATUSES.includes(copy.status)) { copy.status = "interrupted"; copy.activeFraction = 0; copy.resend = true; }
  return copy;
}

function buildSessionSnapshot() {
  const buckets = (state.activitySessions || []).slice(-SESSION_MAX_BUCKETS).map(session => ({
    frequencyHz: session.frequencyHz,
    messages: (session.activity.messages || []).slice(-200).map(item => ({...item})),
    calls: (session.activity.calls || []).map(item => ({...item}))
  }));
  const conversations = {};
  for (const [call, items] of Object.entries(state.conversations || {})) {
    if (!Array.isArray(items) || !items.length) continue;
    conversations[call] = items.slice(-SESSION_MAX_CONVERSATION)
      .map(item => item.direction === "outgoing" ? snapshotOutgoing(item) : {...item});
  }
  return {
    version: 1, savedAtMs: Date.now(),
    activityFrequency: state.activityFrequency || 0,
    buckets, conversations,
    selectedCall: state.selectedCall || "",
    trafficFilter: state.trafficFilter || "all",
    trafficHide: Number(state.trafficHide) || 0,
    stationSort: {...state.stationSort},
    hearingLinksVisible: state.hearingLinksVisible !== false,
    mapLogScale: state.mapLogScale === true,
    draft: (dom.message && dom.message.value) || "",
    lastOutgoing: state.lastOutgoing ? snapshotOutgoing(state.lastOutgoing) : null,
    // Own-TX feed history: mid-flight sends become "interrupted" (grey) on the way
    // out, so a restored feed never claims something went on air that a reload cut off.
    outgoingLog: (state.outgoingLog || []).slice(-OUTGOING_LOG_MAX)
      .map(item => ({...snapshotOutgoing(item), restored: true}))
  };
}

function writeSessionSnapshot() {
  const store = sessionStore(); if (!store) return;
  try {
    store.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(buildSessionSnapshot()));
  } catch (_error) {
    // Quota or serialization failure must never break the running page. Retry
    // once keeping only the most recent frequency buckets, then give up quietly.
    try {
      const trimmed = buildSessionSnapshot();
      trimmed.buckets = trimmed.buckets.slice(-3);
      store.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(trimmed));
    } catch (_retryError) { /* running page stays intact */ }
  }
}

function persistSession() {
  if (TEST_MODE || sessionPersistTimer) return;
  sessionPersistTimer = setTimeout(() => { sessionPersistTimer = null; writeSessionSnapshot(); }, 500);
}

function flushSession() {
  if (sessionPersistTimer) { clearTimeout(sessionPersistTimer); sessionPersistTimer = null; }
  writeSessionSnapshot();
}

function discardSession() {
  const store = sessionStore(); if (!store) return;
  try { store.removeItem(SESSION_SNAPSHOT_KEY); } catch (_error) { /* ignore */ }
}

// Rebuild the global dedup structures from restored activity so a live decode
// that repeats a restored slot is skipped instead of duplicated. ownCall
// attention is intentionally not restored; it is re-derived from current myCall.
function rebuildDecoderSeen() {
  decoderActivitySeen.messages.clear();
  decoderActivitySeen.frames.clear();
  decoderActivitySeen.calls.clear();
  for (const session of state.activitySessions || []) {
    for (const message of session.activity.messages || []) decoderActivitySeen.messages.add(activityMessageKey(message));
    for (const call of session.activity.calls || []) decoderActivitySeen.calls.set(call.call, activityCallSignature(call));
  }
}

function restoreSession() {
  const store = sessionStore(); if (!store) return false;
  let raw = null;
  try { raw = store.getItem(SESSION_SNAPSHOT_KEY); } catch (_error) { return false; }
  if (!raw) return false;
  let snapshot = null;
  try { snapshot = JSON.parse(raw); } catch (_error) { discardSession(); return false; }
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.buckets)) { discardSession(); return false; }
  try {
    const buckets = [];
    for (const bucket of snapshot.buckets) {
      if (!bucket || typeof bucket.frequencyHz !== "number") continue;
      const messages = (Array.isArray(bucket.messages) ? bucket.messages : []).map(item => ({...item, restored: true}));
      const calls = (Array.isArray(bucket.calls) ? bucket.calls : []).map(item => ({...item}));
      buckets.push({frequencyHz: bucket.frequencyHz, activity: {messages, calls, timing: [], frames: [], channels: []}});
    }
    if (!buckets.length) { discardSession(); return false; }
    state.activitySessions = buckets;
    if (snapshot.conversations && typeof snapshot.conversations === "object") {
      const conversations = {};
      for (const [call, items] of Object.entries(snapshot.conversations))
        if (Array.isArray(items)) conversations[call] = items.map(item => ({...item}));
      state.conversations = conversations;
    }
    if (typeof snapshot.selectedCall === "string") state.selectedCall = snapshot.selectedCall;
    if (typeof snapshot.trafficFilter === "string") state.trafficFilter = snapshot.trafficFilter;
    if (Number.isFinite(Number(snapshot.trafficHide)))
      state.trafficHide = Math.max(0, Math.min(TRAFFIC_HIDE_STEPS.length - 1, Number(snapshot.trafficHide)));
    if (snapshot.stationSort && typeof snapshot.stationSort.key === "string")
      state.stationSort = {key: snapshot.stationSort.key, direction: snapshot.stationSort.direction === "asc" ? "asc" : "desc"};
    if (typeof snapshot.hearingLinksVisible === "boolean") state.hearingLinksVisible = snapshot.hearingLinksVisible;
    if (typeof snapshot.mapLogScale === "boolean") state.mapLogScale = snapshot.mapLogScale;
    if (snapshot.lastOutgoing && typeof snapshot.lastOutgoing === "object") state.lastOutgoing = {...snapshot.lastOutgoing};
    if (Array.isArray(snapshot.outgoingLog)) {
      state.outgoingLog = snapshot.outgoingLog.map(item => ({...item, restored: true}));
      // Ids identify a row for RESEND and are carried through the snapshot, so the
      // counter has to resume above the restored ones or a new send would claim an id
      // that already belongs to a row on screen.
      outgoingSequence = state.outgoingLog.reduce((max, item) => Math.max(max, Number(item.id) || 0), outgoingSequence);
    }
    // Select the bucket for the restored frequency now so history is visible
    // immediately, before pollRadio confirms the live frequency.
    const frequency = Number(snapshot.activityFrequency) || 0;
    if (frequency > 0) {
      const session = activitySessionFor(frequency, false);
      if (session) { state.activityFrequency = session.frequencyHz; state.activity = session.activity; }
    }
    if (dom.message && typeof snapshot.draft === "string") dom.message.value = snapshot.draft;
    rebuildDecoderSeen();
    sessionRestored = true;
    return true;
  } catch (_error) { discardSession(); return false; }
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
}
function signed(value) { const n = Math.round(Number(value) || 0); return `${n >= 0 ? "+" : ""}${n}`; }
function formatJs8Snr(value) {
  const n=Math.max(-60,Math.min(60,Math.round(Number(value)||0)));
  return `${n>=0?"+":"-"}${String(Math.abs(n)).padStart(2,"0")}`;
}
function cqType(text) {
  const normalized=String(text||"").trim().toUpperCase();
  return ["CQ CQ CQ","CQ DX","CQ QRP","CQ CONTEST","CQ FIELD","CQ FD","CQ CQ","CQ"].includes(normalized) ? normalized : "";
}
function formatFrequency(hz) { return Js8TrxPresets.formatFrequency(hz || 0); }
function speedDetail(mode) {
  const number=Number(mode), speed=MODE_TO_SPEED[number] || "?", seconds=MODE_PERIOD_SECONDS[number];
  return seconds ? `${speed} · ${seconds} s` : speed;
}
function callOf(message) { return (message.callsigns || []).find(call => call && !call.startsWith("@") && call !== currentJs8().myCall) || ""; }
function currentJs8() { return settings.modems.js8call; }

// ---- calibrated TX gain -----------------------------------------------------
//
// This page never calibrates -- its tune carrier is pre-rendered into one buffer,
// so the level cannot be moved while it plays. It only USES the station's table
// and runs the limiter half of the design (docs/tx-auto-gain-implementace.md).
// Calibration happens on the WSPR page, which has a streaming generator, and it
// deliberately measures the radio as it stands -- so calibrating for JS8 means
// setting this page's band and power first, then calibrating there.
const gainStore = new TxGainCal.TxGainStore();
const alcGuard = new TxAlcGuard.TxAlcGuard();

// What the table says for the radio's CURRENT band and power, or the manual
// value with a reason. Never a guess: a level filed under a model we have not
// been told or a power the radio has not confirmed would be applied silently.
// The calibration tool, the same module the WSPR page mounts. This page used to
// only USE the table and point at the other page for the measuring, which left an
// operator who works in JS8 with an amber "not calibrated" line and no way
// forward. The tool brings its own carrier -- a streamed WsprStream tone, because
// this page's own tune carrier is pre-rendered and its level cannot move while it
// plays -- so nothing in the JS8 TX path had to change to host it.
let gainCal = null;
function createGainCal() {
  if (gainCal || !dom.calField || typeof TxGainCalUi === "undefined") return gainCal;
  gainCal = TxGainCalUi.create({
    mount: dom.calField,
    store: gainStore,
    // The JS8 sink plus the two methods the pacing driver needs. Built here
    // rather than added to sinkProxy so the JS8 path keeps the surface it had.
    sink: {
      prepare:(...args) => requireAudio().prepare(...args),
      begin:(...args) => requireAudio().begin(...args),
      write:(...args) => requireAudio().write(...args),
      end:(...args) => requireAudio().end(...args),
      isDrained:(...args) => audioSource ? audioSource.isDrained(...args) : false,
      complete:(...args) => requireAudio().complete(...args),
      abort:(...args) => audioSource && audioSource.abort(...args),
      sendControl:(...args) => requireAudio().sendControl(...args),
      get bufferedAmount() { return audioSource ? audioSource.bufferedAmount : 0; },
      get ptt() { return Boolean(audioSource && audioSource.ptt); },
    },
    streamId:() => audioSource ? audioSource.state().readyStreamId : 0,
    wallNow:() => js8Clock.now(),
    now:() => Date.now(),
    radio:() => state.radio,
    model:() => state.radio.radioName || "",
    manualGain:() => Number(currentJs8().txGain) || 0.25,
    dbm:() => null,          // WSPR files power references; this page has none to file
    blockingReason:() => {
      if (!(state.radio.connected && state.radio.transceiverType === "ICOM-LAN"))
        return "ICOM-LAN is offline";
      if (!sessionHeld || !sessionConfirmed) return "another page holds the radio";
      if (!audioSource || !audioSource.state().readyStreamId)
        return "the audio link is not ready";
      if (!currentJs8().txSafetyAccepted) return "confirm Enable radio TX";
      // One transmitter, two drivers. A calibration carrier queued into the same
      // socket as a JS8 frame would put two transmissions into one slot.
      if (!["idle","completed","aborted","fault"].includes(state.txStatus))
        return "JS8 TX is busy";
      if (state.radio.tx) return "TRX PTT is active";
      return "";
    },
    ensureDataMode:async () => {
      await ensureUsbDataMode();
      for (let waited = 0; waited < 5000 && state.radio.mode !== "USB-D"; waited += 100)
        await new Promise(resolve => setTimeout(resolve, 100));
      if (state.radio.mode !== "USB-D") throw new Error("the radio did not confirm USB-D");
    },
    setMode:mode => fetch(RADIO_CMD_URL,{method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({type:"setMode", mode})}),
    onRunChange:running => { state.calRunning = running; renderControls(); },
    modLevel:() => (gainPlan ? gainPlan.modLevel() : 0),
    // The plan panel owns the CI-V client that can read it; without this a
    // calibration started from this settings section alone files its knee under
    // an unknown MOD level, which nothing can ever call stale.
    refreshModLevel:() => (gainPlan ? gainPlan.refreshModLevel() : null),
  });
  gainCal.arm(true);
  createGainPlan();
  return gainCal;
}

// The batch plan, the same module the WSPR page mounts. Not behind a hash here: on
// WSPR the hash gate exists because SETUP links to a page people also visit for the
// beacon, while on this page the panel sits in a settings section the operator
// opened themselves -- hiding it would reproduce exactly the undiscoverability the
// tool was moved here to fix.
let gainPlan = null;
function createGainPlan() {
  if (gainPlan || !dom.planField || typeof TxGainPlanUi === "undefined") return gainPlan;
  gainPlan = TxGainPlanUi.create({
    mount:dom.planField,
    button:dom.planButton,
    store:gainStore,
    cal:gainCal,
    model:() => state.radio.radioName || "",
    modelNumber:() => IcomModels.modelNumber(state.radio.radioName || ""),
    radio:() => state.radio,
    send:async payload => {
      const response = await fetch(RADIO_CMD_URL,{method:"POST",
        headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
      if (!response.ok) throw new Error(`${payload.type} failed (${response.status})`);
      return response.json().catch(() => ({ok:true}));
    },
    bands:() => WsprCore.PRESETS.map(preset => ({band:preset.band, hz:preset.hz})),
    wsprPresets:WsprCore.PRESETS,
    js8Presets:typeof Js8TrxPresets !== "undefined" ? Js8TrxPresets.PRESETS : [],
    percentOf:radio => (radio.rfPowerSeen === true ? WsprCore.civPercent(radio.rfPower) : 0),
    // What this station operates on: the percentage the operator chose for JS8, and
    // whatever the radio is set to now. No invented ladder -- each column costs a
    // carrier on every band.
    defaultPowers:() => {
      const out = [];
      const chosen = Number(currentJs8().rfPercent);
      if (Number.isFinite(chosen) && chosen >= 1) out.push(Math.round(chosen));
      if (state.radio.rfPowerSeen === true) out.push(WsprCore.civPercent(state.radio.rfPower));
      return out;
    },
    setFrequency:async hz => {
      await fetch(RADIO_CMD_URL,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({type:"setFrequency", frequency:String(hz)})});
      for (let waited = 0; waited < 9000 && state.radio.frequency !== hz; waited += 100)
        await new Promise(resolve => setTimeout(resolve, 100));
      if (state.radio.frequency !== hz)
        throw new Error(`the radio did not confirm the band: asked for ` +
          `${(hz / 1000).toFixed(1)} kHz, it reports ` +
          `${(state.radio.frequency / 1000).toFixed(1)} kHz`);
      // The band-decoder outputs follow the dial and the relays they drive have to
      // have settled before a carrier arrives.
      await new Promise(resolve => setTimeout(resolve, 300));
    },
    // Written, then CONFIRMED by ASKING. The firmware polls 14 0A once per fifteen-slot
    // rotation (1.5 s) and not at all during a transmission, so waiting passively right
    // after a carrier depends on a rotation that may not have resumed -- and the
    // timeout that produced ended the whole run, not the cell. A read request costs one
    // CI-V frame. And when it still does not agree, say what the radio reports.
    setPercent:async percent => {
      const level = WsprCore.percentToLevel(percent);
      const post = payload => fetch(RADIO_CMD_URL,{method:"POST",
        headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
      await post({type:"civ.raw", data:WsprCore.civLevelCommand(level).data});
      const started = Date.now();
      let seen = -1, seenPercent = -1;
      while (Date.now() - started < 9000) {
        try { await post({type:"civ.raw", data:"140A"}); } catch (_error) {}
        await new Promise(resolve => setTimeout(resolve, 300));
        if (state.radio.rfPowerSeen === true) {
          seen = state.radio.rfPower;
          seenPercent = WsprCore.civPercent(seen);
          // Either unit agreeing is agreement: the radio quantises to whole percent.
          if (seenPercent === percent || seen === level) return;
        }
      }
      throw new Error(`the radio did not confirm the power: asked for ${percent} % ` +
        `(level ${level})` + (seen < 0 ? ", and it never reported a power setting"
          : `, it reports ${seenPercent} % (level ${seen})`));
    },
    // The plan keys carriers on bands this page's own scheduler knows nothing about,
    // and between its cells it waits minutes for an antenna answer with PTT down. A
    // heartbeat or an unattended reply landing in that gap would transmit on the
    // plan's band, at the plan's power, into an antenna the operator is at that very
    // moment being asked about. Blocking TX for the duration is done in
    // txBlockReasons; refusing to START while unattended operation is armed is here,
    // because switching it off for the operator is a promise this page cannot keep
    // if the tab dies mid-run.
    planBlockingReason:() => (currentJs8().auto
      ? "turn unattended operation off first — the plan keys on other bands" : ""),
    fetchImpl:(...args) => fetch(...args),
    setModeFilter:(mode, filter) => fetch(RADIO_CMD_URL,{method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({type:"setMode", mode, filter:filter?"FIL"+filter:undefined})}),
    onPlanChange:running => { state.planRunning = running; renderControls(); },
  });
  return gainPlan;
}

// What the table says for the radio's CURRENT band and power, or the manual value
// with a reason. Never a guess: a level filed under a model we have not been told
// or a power the radio has not confirmed would be applied silently.
function resolvedGain() {
  if (gainCal) return gainCal.resolved();
  const manual = Number(currentJs8().txGain) || 0.25;
  return {gain:manual, calibrated:false, key:"", why:"the calibration tool is not ready"};
}

function stampGain(frames) {
  const resolved = resolvedGain();
  for (const frame of frames) frame.gain = resolved.gain;
  return frames;
}

function beginAlcGuard() {
  const resolved = resolvedGain();
  // Nothing to protect and nothing to learn without an entry: the manual level
  // is the operator's own choice, and trimming it behind their back would be
  // this page arguing with the slider they set.
  if (!resolved.calibrated) return;
  alcGuard.beginTx({key:resolved.key, gain:resolved.gain});
}

function endAlcGuard() {
  const outcome = alcGuard.endTx();
  if (!outcome || !outcome.reduced) return;
  state.alcTrim = {key:outcome.key, gain:outcome.gain, witnesses:outcome.witnesses,
                   needsRecalibration:outcome.needsRecalibration};
  if (outcome.persistGain === null) { renderControls(); return; }
  // Second witness: the stored level really does not hold any more. Only ever
  // downwards, and only ever to a level a transmission actually finished at.
  const entry = gainStore.entry(outcome.key);
  if (!entry) { renderControls(); return; }
  gainStore.put(outcome.key, {...entry, gain:Number(outcome.persistGain.toFixed(4)),
                              autoTrimmed:true, at:Date.now()})
    .catch(() => {})
    .then(() => renderControls());
}

// Read-only, beside the manual field and never inside it: a calibrated level can
// be 0.006 or 0.63 and the field steps in 0.05, so writing it there would round
// the measurement away the first time the operator touched it.
function renderResolvedGain() {
  if (!dom.calResolved) return;
  const resolved = resolvedGain();
  const trim = state.alcTrim && state.alcTrim.key === resolved.key ? state.alcTrim : null;
  if (resolved.calibrated) {
    const entry = resolved.entry || {};
    dom.calResolved.textContent =
      `calibrated ${resolved.gain} — ${resolved.band} @ ${resolved.percent} %` +
      (entry.autoTrimmed ? ", trimmed on air" : "") +
      (trim && trim.needsRecalibration ? " — ALC still acting 6 dB down, recalibrate" : "");
  } else {
    dom.calResolved.textContent = `${resolved.why} — using the manual ${resolved.gain}`;
  }
  dom.calResolved.classList.toggle("uncalibrated",
    !resolved.calibrated || Boolean(trim && trim.needsRecalibration));
  if (gainCal) gainCal.render();
}

// Every control frame from the firmware. Only tx-level matters here, and only
// while a calibrated transmission is in flight.
function onAudioControl(message) {
  // One socket, two drivers, never at once. WsprTx acts on tx-ready/tx-state/
  // tx-error without checking txId, so handing every frame to both would let one
  // run's abort fault the other's idle driver.
  if (gainCal && gainCal.running) { gainCal.onControl(message); return; }
  if (!message || message.type !== "tx-level" || !alcGuard.active) return;
  const before = alcGuard.gain;
  const after = alcGuard.noteLevel({consumed:message.consumed, alc:message.alc,
                                    alcSeq:message.alcSeq});
  // No mid-frame correction on this page: the modulator has already baked the
  // level into the frame that is playing. The reduction reaches the air on the
  // next frame, through frameGain().
  if (after !== before) renderControls();
}
function sameCall(left,right) {
  return Boolean(right) && String(left||"").toUpperCase()===String(right).toUpperCase();
}
// An IGate relays an APRS reply back as "@APRSIS MSG to:<US> ... DE <ROBOT>"
// (AprsInboundRelay.cpp:192), addressed to the group rather than to us, so the
// callsign list alone would hide our own WHO-IS and WXBOT answers under MYCALL.
function messageMentionsCall(message,call) {
  return Boolean(call) && ((message.callsigns||[]).some(value=>sameCall(value,call)) ||
    Js8Aprs.replyForMe(message,call));
}
function ownCallText(text,call) {
  const html=esc(text);
  if(!call)return html;
  const escaped=String(call).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return html.replace(new RegExp(`(^|[^A-Z0-9/])(${escaped})(?=$|[^A-Z0-9/])`,"gi"),
    '$1<span class="own-callsign" data-own-call="true">$2</span>');
}

function activityMessageKey(item) {
  return `${item.firstSlotUtcMs || 0}|${item.lastSlotUtcMs || 0}|${item.submode}|${item.offsetHz}|${item.text}|${(item.raw || []).join("")}`;
}
function activityFrameKey(item) {
  return `${item.slotUtcMs || 0}|${item.submode}|${item.offsetHz}|${item.raw}`;
}
function activityCallSignature(item) {
  return `${item.lastSlotUtcMs || 0}|${item.snr}|${item.offsetHz}|${item.submode}|${item.dtMs}|${item.quality}|${item.grid || ""}|${item.heardDirectly !== false}`;
}
function activitySessionFor(frequency, create=true) {
  const hz=Number(frequency)||0;
  if(hz<=0)return null;
  let session=state.activitySessions
    .filter(item=>Math.abs(item.frequencyHz-hz)<=ACTIVITY_FREQUENCY_TOLERANCE_HZ)
    .sort((a,b)=>Math.abs(a.frequencyHz-hz)-Math.abs(b.frequencyHz-hz))[0];
  if(!session && create){
    session={frequencyHz:hz,activity:emptyActivity()};
    state.activitySessions.push(session);
  }
  return session || null;
}
function selectActivityFrequency(frequency) {
  const hz=Number(frequency)||0;
  if(hz<=0)return false;
  if(state.activityFrequency && Math.abs(state.activityFrequency-hz)<=ACTIVITY_FREQUENCY_TOLERANCE_HZ)return false;
  const session=activitySessionFor(hz);
  state.activityFrequency=session.frequencyHz;
  state.activity=session.activity;
  return true;
}
function applyDecoderActivity(snapshot) {
  if(!snapshot)return;
  if(!state.activityFrequency)selectActivityFrequency(state.radio.frequency);
  const session=activitySessionFor(state.activityFrequency,false);
  if(!session)return;
  const activity=session.activity;
  for(const item of snapshot.messages || []){
    const key=activityMessageKey(item);
    if(decoderActivitySeen.messages.has(key))continue;
    decoderActivitySeen.messages.add(key);
    activity.messages.push({...item});
    if(!item.restored) dispatchAssembledMessage(item);
    Promise.resolve(handleFileActivityMessage(item)).catch(error=>{
      binState.storageError=error.message; renderControls();
    });
  }
  if(activity.messages.length>200)activity.messages.splice(0,activity.messages.length-200);
  const calls=new Map(activity.calls.map(item=>[item.call,item]));
  for(const item of snapshot.calls || []){
    const signature=activityCallSignature(item);
    if(decoderActivitySeen.calls.get(item.call)===signature)continue;
    decoderActivitySeen.calls.set(item.call,signature);
    calls.set(item.call,{...item});
  }
  activity.calls=[...calls.values()].sort((a,b)=>String(a.call).localeCompare(String(b.call)));
  for(const item of snapshot.frames || []){
    const key=activityFrameKey(item);
    if(decoderActivitySeen.frames.has(key))continue;
    decoderActivitySeen.frames.add(key);
    activity.frames.push({...item});
  }
  if(activity.frames.length>500)activity.frames.splice(0,activity.frames.length-500);
  activity.timing=(snapshot.timing || []).map(item=>({...item}));
  activity.channels=(snapshot.channels || []).map(item=>({...item}));
  state.activity=activity;
  persistSession();
}
function selectedMode() {
  const speed = currentJs8().speed;
  if (speed !== "AUTO") return SPEED_TO_MODE[speed];
  const station = state.activity.calls.find(item => item.call === state.selectedCall);
  return station ? Number(station.submode) : 0;
}

function settingsSnapshot() { return settings; }

// How the station operates belongs to the station, not to this browser: the
// heartbeat interval, the groups, the band schedule and the RF power are the
// same facts whichever screen is looking. Debounced because the settings panel
// saves on every keystroke, and the far end is flash.
const pushStationProfile = window.StationProfile ? window.StationProfile.writer("js8", 1500) : null;

function persistSettings(label = true) {
  settings.activeModem = state.activeMode;
  const saved = Js8Settings.save(localStorage, settingsSnapshot());
  settings = saved.settings;
  if (label) dom.storageState.textContent = saved.label;
  applySettingsToRuntime();
  if (pushStationProfile) pushStationProfile(settings);
}

function applyHeartbeatSettings() {
  const js8 = currentJs8();
  heartbeat.configure({enabled: js8.hb === true, ackEnabled: js8.hbAck !== false,
    intervalMs: (Number(js8.hbMinutes) || 60) * 60000}, js8Clock.now());
  renderHeartbeatState();
}

// Says when the next beacon is due, so a postponed heartbeat does not look like
// a broken one.
function renderHeartbeatState() {
  if (!dom.hbState) return;
  const dueInMs = heartbeat.dueInMs(js8Clock.now());
  if (dueInMs === null) { dom.hbState.textContent = "off"; return; }
  if (!currentJs8().auto) { dom.hbState.textContent = "waiting for unattended mode"; return; }
  dom.hbState.textContent = dueInMs <= 0 ? "due now"
    : `next in ${Math.max(1, Math.round(dueInMs / 60000))} min`;
}

function applySettingsToRuntime() {
  const js8 = currentJs8();
  if (audioSource && audioSource.configure)
    audioSource.configure({clockCorrectionMs:js8.clockCorrectionMs, autoTiming:js8.autoTiming});
  if (activeEncoder) activeEncoder.configure({myCall:js8.myCall, toCall:state.selectedCall,
    mode:selectedMode(), clockCorrectionMs:js8.clockCorrectionMs});
  renderControls();
}

// ---- WASM modem registration ------------------------------------------------

const workerInit = {
  runtimeJs:assetUrl("/js8-worker-runtime.js"),
  portableJs:assetUrl("/js8-core.js"), portableWasm:assetUrl("/js8-core.wasm"),
  decoderJs:assetUrl("/js8-decoder.js"),
  decoderWasmBr:assetUrl("/js8-decoder.wasm.br"), decoderWasmSize:895356,
  protocolJs:assetUrl("/js8-protocol.js"),
  jscUrlBr:assetUrl("/js8-jsc.bin.br"), jscSize:1913889,
  brotliJs:assetUrl("/js8-brotli.js"), brotliWasm:assetUrl("/js8-brotli.wasm"),
  strictEpochAnchoring:true,
};

let txWasm = null, txModulePromise = null;
function loadTxModule() {
  if (txModulePromise) return txModulePromise;
  txModulePromise = self.createJs8Prototype({locateFile:path =>
    path.endsWith(".wasm") ? assetUrl("/js8-core.wasm") : path})
    .then(module => { txWasm = module; state.txWasmReady = true; renderControls(); return module; })
    .catch(error => {
      state.decoderStatus = `TX core error: ${error.message}`;
      // The repaint is the last thing standing between a fault and the operator,
      // so it must not be able to swallow one. When renderControls() itself
      // throws, this catch used to end in an unhandled rejection that replaced
      // "TX core error: ..." with whatever the renderer tripped over -- reporting
      // nothing, from the very handler whose job is to report.
      try { renderControls(); } catch (renderError) { failStartup(renderError); }
    });
  return txModulePromise;
}

// The level for a frame, decided when the frame was BUILT and only ever lowered
// afterwards.
//
// Both halves matter. The baseline is stamped at queue time because the band can
// change between queueing a message and modulating its third frame, and the
// calibration is per band -- reading the table at modulation time would put one
// band's level on another band's transmission. The cap is applied here because
// the ALC limiter cannot reach into a frame that is already modulated: JS8 bakes
// the gain into the whole frame, so a reduction it decides during frame two can
// only take effect on frame three.
function frameGain(frame) {
  const baseline = Number(frame && frame.gain) > 0 ? Number(frame.gain) : resolvedGain().gain;
  const limited = alcGuard.active ? alcGuard.gain : baseline;
  return Math.min(baseline, limited > 0 ? limited : baseline);
}

function modulateFrame(frame, mode, toneHz) {
  if(frame.role==="tune"){
    const count=48000*Math.max(1,Math.min(10,Number(frame.durationSeconds)||10));
    const pcm=new Int16Array(count), amplitude=Math.round(frameGain(frame)*32767);
    for(let i=0;i<count;i++)pcm[i]=Math.round(amplitude*Math.sin(2*Math.PI*toneHz*i/48000));
    return pcm;
  }
  if (!txWasm) throw new Error("JS8 TX core is not ready");
  const framePtr = txWasm._malloc(12);
  for (let i = 0; i < 12; i++) txWasm.HEAPU8[framePtr + i] = frame.raw.charCodeAt(i);
  const gain = frameGain(frame);
  const count = txWasm._js8_proto_modulate_frame48k(framePtr, frame.frameType, mode, toneHz, gain, 0, 0);
  if (count <= 0) { txWasm._free(framePtr); throw new Error("JS8 modulator rejected frame"); }
  const outputPtr = txWasm._malloc(count * 2);
  const written = txWasm._js8_proto_modulate_frame48k(framePtr, frame.frameType, mode, toneHz, gain, outputPtr, count);
  const pcm = txWasm.HEAP16.slice(outputPtr >> 1, (outputPtr >> 1) + written);
  txWasm._free(outputPtr); txWasm._free(framePtr);
  if (written !== count) throw new Error("JS8 modulator length mismatch");
  return pcm;
}

const sinkProxy = {
  prepare:(...args) => requireAudio().prepare(...args), begin:(...args) => requireAudio().begin(...args),
  write:(...args) => requireAudio().write(...args), end:(...args) => requireAudio().end(...args),
  isDrained:(...args) => audioSource ? audioSource.isDrained(...args) : false,
  complete:(...args) => requireAudio().complete(...args), abort:(...args) => audioSource && audioSource.abort(...args),
  get ptt() { return Boolean(audioSource && audioSource.ptt); }
};
function requireAudio() { if (!audioSource) throw new Error("Audio link is not connected"); return audioSource; }

const adapter = createJs8ModemAdapter({
  DecoderBase:Decoder, EncoderBase:Encoder, workerInit,
  createWorker:() => new Worker(assetUrl("/js8-worker.js")),
  getStreamId:() => audioSource ? audioSource.state().readyStreamId : 0,
  createTxController:() => new Js8Tx.TxController({buildFrames:request=>stampGain(
    request.kind==="tune"
    ? [{raw:"",frameType:0,role:"tune",durationSeconds:TEST_MODE?2:10}]
    : Js8Protocol.buildTxFrames(request)),
    encoder:modulateFrame, sink:sinkProxy, clockCorrectionMs:currentJs8().clockCorrectionMs,
    prebufferMs:1000, maxCatchupPackets:25, wallNow:() => js8Clock.now()}) // Tolerate a 500 ms mobile-browser pause before the TX slot.
});
registerModem(adapter.id, adapter.definition);

// ---- modem lifecycle --------------------------------------------------------

function populateModes() {
  const entries=Object.entries(Modems).sort(([a],[b])=>a==="js8call"?-1:b==="js8call"?1:0);
  dom.modeSelect.innerHTML = entries.map(([id, modem]) =>
    `<option value="${esc(id)}">${esc(modem.label)}</option>`).join("");
  if (!Modems[state.activeMode]) state.activeMode = "js8call";
  dom.modeSelect.value = state.activeMode;
}

function closeActiveModem() {
  stopTxTicking();
  scheduler.cancel("modemStall");
  if (activeEncoder && activeEncoder.disconnect) activeEncoder.disconnect();
  if (activeDecoder && activeDecoder.close) activeDecoder.close();
  activeDecoder = null; activeEncoder = null;
}

// Starting the modem is three network fetches and two WASM instantiations deep
// before anything can be decoded, and the failures divide in two. A worker whose
// script cannot be loaded raises `error`, which the adapter now reports. A fetch
// the radio accepts and then never answers raises nothing at all -- the ESP32
// serves one request at a time, and a request that dies inside it dies silently.
// This is the answer to the second kind: a startup that has stopped advancing is
// broken, and the page says so instead of holding the operator on 0% for ever.
// Re-armed by every progress report, so a slow link only ever costs patience.
const MODEM_STALL_MS = 20000;
function armModemWatchdog() {
  scheduler.after("modemStall", MODEM_STALL_MS,
    () => failModem(`no progress for ${Math.round(MODEM_STALL_MS / 1000)} s ` +
      `while "${state.startup.label}" — the radio stopped answering`));
}

// One free retry, and only before the modem has ever been ready: the commonest
// cause is a single dropped asset fetch, which costs nothing to repeat, while a
// modem that broke after running is a fault the operator must see.
function failModem(reason) {
  scheduler.cancel("modemStall");
  const retrying = !modemRetried && !modemEverReady;
  state.decoderStatus = reason;
  state.startup.failed = true; state.startup.ready = false;
  state.startup.label = "Modem loading failed";
  state.startup.detail = retrying ? `${reason} — retrying once` : reason;
  stopAudio();
  renderStartup(); renderControls(); renderDiagnostics();
  if (!retrying) return;
  modemRetried = true;
  scheduler.after("modemRetry", 1500, () => selectMode(state.activeMode));
}

function selectMode(id) {
  if (!Modems[id]) return;
  closeActiveModem(); stopAudio(); state.activeMode = id; persistSettings(false);
  const modem = Modems[id];
  dom.js8.hidden = id !== "js8call";
  if (!modem.Decoder && !modem.Encoder) {
    state.startup.ready = true; state.startup.failed = false;
    dom.modemState.textContent = "Not installed"; dom.modemState.className = "modem-state unavailable";
    renderStartup(); return;
  }
  state.decoderStatus = "loading";
  state.startup = {ready:false, failed:false, progress:0,
    label:`Loading ${modem.label} modem`, detail:"Preparing modem components…"};
  renderStartup();
  armModemWatchdog();
  activeDecoder = new modem.Decoder(AUDIO_RATE).onText(() => {}).onEvent(handleDecoderEvent);
  activeEncoder = new modem.Encoder(AUDIO_RATE).onEvent(handleEncoderEvent);
  activeEncoder.setToneOffset(currentJs8().txOffsetHz);
  applySettingsToRuntime();
  dom.modemState.textContent = "Loading decoder…"; dom.modemState.className = "modem-state";
}

function handleDecoderEvent(event) {
  let activityChanged=false;
  if (event.type === "loading") {
    state.decoderStatus = "loading";
    armModemWatchdog();   // progress proves the chain is alive; start the clock again
    state.startup.progress = Number(event.progress) || 0;
    state.startup.label = event.label || "Loading JS8Call-ICOM modem";
    state.startup.detail = event.total > 0
      ? `${Math.round(event.loaded / 1024)} / ${Math.round(event.total / 1024)} KiB`
      : "Initializing modem components…";
  }
  if (event.type === "status") {
    state.decoderStatus = event.status;
    if (event.status === "ready") {
      scheduler.cancel("modemStall");
      modemEverReady = true;
      state.startup.ready = true; state.startup.failed = false;
      state.startup.progress = 100; state.startup.label = "JS8Call-ICOM modem ready";
      ensureAudio();
    }
  }
  if (event.type === "error") failModem(event.message);
  if (event.type === "activity" && !state.testActivityLocked) {
    applyDecoderActivity(event.activity); activityChanged=true;
  }
  if (event.type === "frame" && audioSource) {
    const decoded = state.activity.frames.find(item => item.raw === event.frame.raw && item.slotUtcMs === event.frame.slotUtcMs);
    const call = decoded && decoded.callsigns ? decoded.callsigns[0] : "";
    try { audioSource.observeDecode(event.frame, call); } catch (_error) {}
    if (decoded) handleDecodedFrame(decoded);
  }
  renderStartup();
  if (activityChanged) renderActivity();
  // A new decode may complete the both-directions SNR exchange for some station.
  if (activityChanged || event.type === "frame") maybeAutoLogQsos();
  if (["loading","status","error"].includes(event.type)) renderControls();
  if (["status","error"].includes(event.type)) renderDiagnostics();
}

function handleEncoderEvent(event) {
  if (event.type !== "tx") return;
  state.txState = event.state; state.txStatus = event.state.status;
  updateOutgoingTxProgress(event.state);
  const running = !["idle","completed","aborted","fault"].includes(state.txStatus);
  // One message, one witness. The limiter is bracketed by the CONTROLLER's run,
  // not by PTT: a three-frame message is three keyings of the radio, and
  // counting them separately would let a single event -- one gust of ALC on one
  // message -- look like the two independent witnesses the table demands before
  // it rewrites a measured level.
  if (running && !alcGuard.active) beginAlcGuard();
  if (!running && alcGuard.active) endAlcGuard();
  state.tuneActive=running && Boolean(event.state.frames?.some(frame=>frame.role==="tune"));
  dom.abort.hidden = !running;
  if (!running) { stopTxTicking(); queueMicrotask(()=>{drainTxQueue();renderTxQueue();}); }
  renderControls();
  if(!running&&binState.txCurrent&&["completed","aborted","fault"].includes(state.txStatus))
    queueMicrotask(()=>finishFileProtocolTx(state.txStatus));
}

// ---- AUD1 audio and waterfall ----------------------------------------------

function audioUrl() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  // The session token goes in the query because a WebSocket handshake cannot
  // carry custom headers; the firmware refuses the upgrade unless it owns.
  return `${scheme}://${location.hostname}:${AUDIO_WS_PORT}/audiows?token=${encodeURIComponent(sessionToken())}`;
}

function ensureAudio() {
  const lan = state.radio.connected && state.radio.transceiverType === "ICOM-LAN";
  // A duplicated tab can share the holder's sessionStorage token, so the
  // firmware cannot distinguish it from the real owner. Wait until the local
  // BroadcastChannel probe confirms this page before opening AUD1.
  if (!sessionHeld || !sessionConfirmed || !lan || state.decoderStatus !== "ready") {
    stopAudio();
    return;
  }
  if (audioSource) return;
  audioSource = new Js8WsAudioSource.WsAudioSource(AUDIO_RATE,
    {url:audioUrl(), wallNow:() => js8Clock.now()})
    .onSamples(onSamples).onStatus(onAudioStatus).onEpoch(() => renderDiagnostics())
    .onControl(onAudioControl);
  audioSource.configure({clockCorrectionMs:currentJs8().clockCorrectionMs, autoTiming:currentJs8().autoTiming});
  audioSource.start();
}

function stopAudio() {
  if (!audioSource) return;
  if (activeEncoder && activeEncoder.disconnect) activeEncoder.disconnect();
  audioSource.stop(); audioSource = null; state.audioStatus = "stopped"; state.lastAudioMs=0;
}

function onAudioStatus(status) {
  state.audioStatus = status.message ? `${status.type}: ${status.message}` : status.type;
  if (status.type === "closed") {
    state.lastAudioMs=0;
    if (activeEncoder && activeEncoder.disconnect) activeEncoder.disconnect();
  }
  renderHeader(); renderControls(); renderDiagnostics();
}

let lastSlotIndex = null, lastSlotPeriod = 0;
let testDecoderPushes = 0;

// The FFT, ring, AGC and canvas scrolling live in data/spectrum.js, shared with
// the WSPR-Beacon page. What stays here is JS8-specific: the slot ruler burnt
// into each new row, and the overlay showing the heartbeat sub-band and the TX
// window for the selected speed.
const waterfall = new Spectrum.Waterfall({
  canvas: dom.canvas, overlay: dom.overlay, container: dom.waterfall,
  sampleRate: AUDIO_RATE, lowHz: RX_LOW, highHz: RX_HIGH,
  fftSize: FFT_SIZE, hopSize: HOP_SIZE,
  markRow: (context, width) => {
    // Burn a faint line into the newest row whenever a UTC slot boundary passes,
    // so it scrolls down with the history. Same clock and period as the slot
    // meter (renderRhythm) — ruler and slot-fill bar stay in lockstep.
    const slotPeriodMs=(MODE_PERIOD_SECONDS[selectedMode()] || 15)*1000;
    const slotCorrection=audioSource ? Number(audioSource.state().timebase?.correction?.totalMs || 0) : 0;
    const slotIndex=Math.floor((Date.now()+slotCorrection)/slotPeriodMs);
    if(lastSlotPeriod===slotPeriodMs && lastSlotIndex!==null && slotIndex!==lastSlotIndex){
      context.fillStyle="rgba(235,240,250,0.6)"; context.fillRect(0,0,width,2);
    }
    lastSlotIndex=slotIndex; lastSlotPeriod=slotPeriodMs;
  },
  drawOverlay: (context, view) => drawTxMarker(context, view),
});

function radioTransmitting() { return Boolean(state.radio.tx || sinkProxy.ptt); }

function resetSpectrumAnalyzer() { waterfall.reset(); lastSlotIndex=null; }

// Pause only the visual analyser while transmitting: a monitored carrier would
// poison its AGC. RX samples must still reach the JS8 decoder because the radio
// and UI can report the RX transition late after PTT release.
function ingestSpectrum(samples) {
  if(radioTransmitting())return;
  waterfall.ingest(samples);
}

function onSamples(samples, rate, metadata) {
  state.lastAudioMs = performance.now();
  let sum=0;
  for (const value of samples) sum += value * value;
  ingestSpectrum(samples);
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  state.audioDb=20*Math.log10(rms + 1e-9);
  dom.audioLevel.textContent = `${Math.round(state.audioDb)} dBFS`;
  if (activeDecoder) {
    activeDecoder.pushSamples(samples, metadata);
    if(TEST_MODE)testDecoderPushes++;
  }
}

function resizeWaterfall() { waterfall.resize(); }

// Called by the waterfall with a freshly cleared overlay context; use
// waterfall.paintOverlay() to request a repaint from elsewhere.
function drawTxMarker(overlayCtx, view) {
  const hzToX=hz=>view.hzToX(hz,dom.overlay.width);
  const heartbeatRight=hzToX(HB_HIGH);
  overlayCtx.strokeStyle="rgba(185,195,191,.52)"; overlayCtx.lineWidth=1; overlayCtx.setLineDash([3,3]);
  overlayCtx.beginPath(); overlayCtx.moveTo(Math.round(heartbeatRight)+.5,0); overlayCtx.lineTo(Math.round(heartbeatRight)+.5,dom.overlay.height); overlayCtx.stroke();
  overlayCtx.setLineDash([]); overlayCtx.fillStyle="rgba(210,220,216,.68)"; overlayCtx.font="bold 9px monospace"; overlayCtx.fillText("HB 500–1000",5,12);
  const mode=selectedMode();
  const start=hzToX(currentJs8().txOffsetHz);
  const width=Js8Protocol.bandwidthHz(mode)/(RX_HIGH-RX_LOW)*dom.overlay.width;
  overlayCtx.fillStyle="rgba(255,0,36,.28)"; overlayCtx.fillRect(start,0,Math.max(3,width),dom.overlay.height);
  overlayCtx.strokeStyle="#ff1838"; overlayCtx.lineWidth=2; overlayCtx.beginPath(); overlayCtx.moveTo(start+1,0); overlayCtx.lineTo(start+1,dom.overlay.height); overlayCtx.stroke();
  // Where a click would put the transmission. Drawn after the TX marker so it stays legible
  // while the pointer is inside the marker's own band, and deliberately thin and white --
  // it is a proposal, not a state, and must not be mistaken for the red TX marker itself.
  if(state.previewHz!==null){
    const at=Math.round(hzToX(state.previewHz))+.5;
    overlayCtx.strokeStyle="rgba(255,255,255,.75)"; overlayCtx.lineWidth=1;
    overlayCtx.beginPath(); overlayCtx.moveTo(at,0); overlayCtx.lineTo(at,dom.overlay.height); overlayCtx.stroke();
  }
  const label=`TX ${currentJs8().txOffsetHz} Hz`, labelX=Math.min(start+5,dom.overlay.width-96);
  overlayCtx.fillStyle="#fff"; overlayCtx.font="bold 11px monospace";
  overlayCtx.shadowColor="#000"; overlayCtx.shadowBlur=3; overlayCtx.fillText(label,labelX,14);
  overlayCtx.shadowBlur=0;
  overlayCtx.lineWidth=1;
  drawStationLabels(overlayCtx,hzToX);
}

function renderRhythm() {
  const mode=selectedMode(), period=MODE_PERIOD_SECONDS[mode] || 15;
  const correction=audioSource ? Number(audioSource.state().timebase?.correction?.totalMs || 0) : 0;
  const within=((Date.now()+correction)%(period*1000)+period*1000)%(period*1000);
  dom.slotFill.style.width=`${(within/(period*1000)*100).toFixed(2)}%`;
  dom.slotLabel.textContent=`${MODE_TO_SPEED[mode] || "?"} ${period} s`;
}

// ---- UI projection ----------------------------------------------------------

// A dial on none of the presets the menu offers is a band nobody is listening
// on. The menu already answers half of that by highlighting the matching preset;
// this is the other half, for the button that is on screen when the menu is not.
// Exact equality on purpose -- the same test as the `current` class below, so
// the two can never disagree about which preset the radio is on. A preset still
// being written counts as arrived: pendingFrequency is only ever one of them.
function offDialFrequency() {
  const hz=state.pendingFrequency || state.radio.frequency;
  if(!hz)return false;
  return !Js8TrxPresets.PRESETS.some(item => item.frequencyHz===hz);
}

// Closing a pop-out is three statements, and it was written out at every place
// that needed it -- which is how the Escape key ended up leaving `aria-expanded`
// on the frequency button set to "true" on one of the paths.
function closeFrequencyMenu() {
  dom.frequencyMenu.hidden=true;
  dom.trxFrequency.setAttribute("aria-expanded","false");
}

function closeTimetablePanel() {
  dom.freqTimetablePanel.hidden=true;
  dom.freqTimetableButton.setAttribute("aria-expanded","false");
  closeTimetablePopover();
}

function renderFrequencyMenu() {
  const selected=state.pendingFrequency || state.radio.frequency;
  dom.frequencyMenu.innerHTML = `<header><strong>JS8 dial frequencies</strong><small>Choose a band to tune the TRX</small><span class="tt-actions"><button class="tt-clear" type="button" data-menu-close title="Close">CLOSE</button></span></header><div class="frequency-presets">${Js8TrxPresets.PRESETS.map(item =>
    `<button class="frequency-preset${item.frequencyHz===selected?" current":""}" data-frequency="${item.frequencyHz}" type="button"><strong>${item.band}</strong><span>${formatFrequency(item.frequencyHz)}</span></button>`).join("")}</div><footer>Dial frequencies from the bundled JS8Call source</footer>`;
  frequencyMenuKey=String(selected);
}

// ---- frequency timetable ----------------------------------------------------
// A sparse 24-hour UTC schedule of 48 half-hour slots that tunes the TRX at slot
// boundaries. It runs on the page-wide scheduler and stores itself in
// Js8Settings. Empty slots leave the radio alone (no catch-up); a due change is
// held back while transmitting or disconnected and lands once the radio is free.
const ttRuntime = {appliedSlotIndex:null, appliedHz:null, appliedBand:null, shownSlotIndex:-1, editSlot:null};

function timetable() { return settings.freqTimetable || (settings.freqTimetable={enabled:false, slots:{}}); }
function slotIndexNow() { const d=new Date(); return d.getUTCHours()*2 + (d.getUTCMinutes()>=30 ? 1 : 0); }
function slotLabel(index) { return `${String(Math.floor(index/2)).padStart(2,"0")}:${index%2 ? "30" : "00"}`; }
function slotText(slot) { return slot ? (slot.band || Js8TrxPresets.formatFrequency(slot.hz)) : ""; }
// Edits mutate settings.freqTimetable in place; persistSettings re-normalizes and
// writes it. label:false leaves the storage banner untouched.
function persistTimetable() { persistSettings(false); }

function timetableDisplay() {
  const tt=timetable();
  if (!tt.enabled) return {text:"OFF", active:false};
  const current=tt.slots[slotIndexNow()];
  if (current) return {text:slotText(current), active:true};
  if (ttRuntime.appliedHz) return {text:ttRuntime.appliedBand || Js8TrxPresets.formatFrequency(ttRuntime.appliedHz), active:true};
  return {text:"ON", active:true};
}

function renderTimetableButton() {
  const view=timetableDisplay();
  dom.freqTimetableValue.textContent=view.text;
  dom.freqTimetableButton.classList.toggle("active",view.active);
  dom.freqTimetablePanel.classList.toggle("active",view.active);
  dom.freqTimetableEnable.textContent=timetable().enabled ? "ON" : "OFF";
  dom.freqTimetableEnable.setAttribute("aria-checked",String(timetable().enabled));
}

function renderTimetableGrid() {
  const tt=timetable(), nowIndex=slotIndexNow();
  let html="";
  for (let hour=0; hour<24; hour++) {
    html+=`<div class="tt-row"><span class="tt-hour">${String(hour).padStart(2,"0")}</span>`
      + [hour*2, hour*2+1].map(index => {
          const slot=tt.slots[index];
          return `<button class="tt-cell${slot?" filled":""}${index===nowIndex?" now":""}" type="button" data-slot="${index}" title="${slotLabel(index)} UTC">${slotText(slot)||"·"}</button>`;
        }).join("")
      + `</div>`;
  }
  dom.freqTimetableGrid.innerHTML=html;
  ttRuntime.shownSlotIndex=nowIndex;
}

function openTimetablePopover(index, cell) {
  ttRuntime.editSlot=index;
  const tt=timetable(), slot=tt.slots[index], currentHz=slot?slot.hz:null;
  const bands=Js8TrxPresets.PRESETS.map(p =>
    `<button class="tt-band${p.frequencyHz===currentHz?" current":""}" type="button" data-band-hz="${p.frequencyHz}" data-band="${p.band}">${p.band}</button>`).join("");
  const pop=dom.freqTimetablePopover;
  pop.innerHTML=`<header><strong>${slotLabel(index)} UTC</strong><small>band or custom kHz</small></header>`
    + `<div class="tt-bands">${bands}</div>`
    + `<div class="tt-custom"><input id="ttCustom" type="number" inputmode="decimal" step="0.1" placeholder="e.g. 14074" aria-label="Custom frequency in kHz"><button type="button" data-tt-custom>Set kHz</button></div>`
    + `<button class="tt-clear-slot" type="button" data-tt-clear-slot>Clear slot</button>`;
  pop.hidden=false;
  const panelBox=dom.freqTimetablePanel.getBoundingClientRect(), cellBox=cell.getBoundingClientRect();
  const left=Math.max(6, Math.min(cellBox.left-panelBox.left, dom.freqTimetablePanel.clientWidth-pop.offsetWidth-6));
  pop.style.left=`${left}px`;
  pop.style.top=`${cellBox.bottom-panelBox.top+4}px`;
  const input=pop.querySelector("#ttCustom");
  if (input && slot && !slot.band) input.value=String(currentHz/1000);
}

function closeTimetablePopover() {
  ttRuntime.editSlot=null;
  dom.freqTimetablePopover.hidden=true;
  dom.freqTimetablePopover.innerHTML="";
}

function applyTimetableEdit() {
  persistTimetable();
  renderTimetableGrid();
  renderTimetableButton();
  reconcileTimetable();
}

function setTimetableSlot(index, hz, band) {
  if (index===null || !Number.isFinite(hz)) return;
  timetable().slots[index]=band ? {hz, band} : {hz};
  applyTimetableEdit();
}

function clearTimetableSlot(index) {
  if (index===null) return;
  delete timetable().slots[index];
  applyTimetableEdit();
}

function clearTimetable() {
  if (!Object.keys(timetable().slots).length) return;
  if (typeof confirm==="function" && !confirm("Clear the entire frequency timetable?")) return;
  timetable().slots={};
  applyTimetableEdit();
}

function setTimetableEnabled(enabled) {
  timetable().enabled=enabled;
  // Re-evaluate from scratch: on enable this re-applies the current slot when it
  // is filled; on disable it stops holding any applied marker.
  ttRuntime.appliedSlotIndex=null; ttRuntime.appliedHz=null; ttRuntime.appliedBand=null;
  persistTimetable();
  renderTimetableButton();
  reconcileTimetable();
}

// The single heartbeat of the schedule. Reruns on a slow tick (every ~5 s) and
// after any edit, so it also serves as the "retry once TX clears" mechanism.
function reconcileTimetable() {
  const tt=timetable(), index=slotIndexNow();
  if (index!==ttRuntime.shownSlotIndex && !dom.freqTimetablePanel.hidden) renderTimetableGrid();
  if (!tt.enabled) {
    ttRuntime.appliedSlotIndex=null; ttRuntime.appliedHz=null; ttRuntime.appliedBand=null;
    renderTimetableButton();
    return;
  }
  const slot=tt.slots[index];
  if (!slot) {
    // Empty current slot: never search backwards. Mark it seen so a later move
    // into a filled slot registers as a fresh change.
    ttRuntime.appliedSlotIndex=index;
    renderTimetableButton();
    return;
  }
  if (index===ttRuntime.appliedSlotIndex && slot.hz===ttRuntime.appliedHz) {
    renderTimetableButton();
    return;
  }
  if (radioTransmitting() || !state.radio.connected) { renderTimetableButton(); return; }
  ttRuntime.appliedSlotIndex=index; ttRuntime.appliedHz=slot.hz; ttRuntime.appliedBand=slot.band||null;
  renderTimetableButton();
  requestFrequency(slot.hz).catch(()=>{});
}

// trx-help.js is a separate script, so guard rather than assume: a page that
// somehow loads without it must still work, just without the guide.
function root_TrxHelp() { return typeof TrxHelp === "undefined" ? null : TrxHelp; }

// Before any radio answers, the model the operator's radio reported last time is
// still the right guide to open -- radioSlots[].model survives a reboot precisely
// so this answer does not disappear with the link.
function seedTrxHelpFromSetup() {
  const help=root_TrxHelp(); if(!help)return;
  if(state.radio.radioName)return;
  const config=(typeof LanGate!=="undefined" && LanGate.config()) || null;
  const slot=(typeof LanGate!=="undefined" && LanGate.slot()) || 0;
  if(config && slot) help.setReportedModel(config[`trx${slot}model`] || "");
}

function hasSeenTrxHelp() {
  try { return localStorage.getItem(TRX_HELP_SEEN_KEY) === "1"; }
  catch (_error) { return false; }
}

function openTrxHelp(reason = "manual") {
  dom.trxHelpModeWarning.hidden=reason!=="mode";
  try { localStorage.setItem(TRX_HELP_SEEN_KEY,"1"); } catch (_error) {}
  if(dom.trxHelpDialog.open)return;
  if(typeof dom.trxHelpDialog.showModal==="function")dom.trxHelpDialog.showModal();
  else dom.trxHelpDialog.setAttribute("open","");
}

// The LAN radio is whichever slot the operator gave the LAN connection to, so
// the frequency button names it ("TRX 2") instead of an anonymous "TRX". Before
// the configuration check answers there is no number to show yet.
function renderTrxSlotLabel() {
  if(!dom.trxSlotLabel)return;
  const slot=state.lanConfig.slot;
  dom.trxSlotLabel.textContent=slot ? `TRX ${slot}` : "TRX";
  dom.trxSlotLabel.title=slot ? `TRX${slot} is the LAN radio` : "TRX";
}

// Full scale of the LAN radio, on the very cascade wspr.js fullPower() uses: the
// operator's manual override outranks what the radio calls itself, so the two
// pages can never put different watts on the same transmitter. An unrecognised
// model returns null rather than a guess -- a factor-of-ten error here would be
// invisible and wrong.
const WSPR_SETTINGS_KEY="wifilt.wspr.v1";
function fullPowerScale() {
  let override="";
  try { override=String((JSON.parse(localStorage.getItem(WSPR_SETTINGS_KEY)||"null")||{}).modelOverride||""); }
  catch(_error) { override=""; }
  const manual=override && WsprCore.fullPowerWatts(override);
  if(manual)return {watts:manual, source:"manual override"};
  const reported=WsprCore.fullPowerWatts(state.radio.radioName);
  return reported ? {watts:reported, source:`reported as ${state.radio.radioName}`} : {watts:null, source:""};
}

// The CI-V level is quantised to 1/255 and the radio's own scale is not exactly
// linear in watts, so more precision than this would be invented. Below a watt
// the beacon levels live, which is why milliwatts get their own branch: "0 W"
// for a station actually radiating 100 mW is the one reading worth avoiding.
function formatWatts(watts) {
  if(watts<0.9995)return `${Math.round(watts*1000)} mW`;
  return watts<9.95 ? `${watts.toFixed(1)} W` : `${Math.round(watts)} W`;
}

// rfPower is the 0..255 CI-V level. Percent is a property of the level alone, so
// the bar stays honest for a radio whose model we cannot turn into watts --
// only the number beside it goes to "--".
function renderTrxPower(connected,mismatch=false) {
  dom.trxPower.hidden=!connected;
  // The settings panel opens collapsed, so the bar carries the same state: it is
  // always on screen and it is where anyone looks for power in the first place.
  dom.trxPower.classList.toggle("mismatch",connected && mismatch);
  if(!connected)return;
  // Before the radio has answered 14 0A the firmware is reporting a fabricated
  // default (205 on TRX1, 0 in the LAN snapshot). Show nothing rather than that.
  const seen=state.radio.rfPowerSeen===true;
  const level=Math.max(0,Math.min(255,Number(state.radio.rfPower)||0));
  const percent=seen ? level*100/255 : 0;
  // ceil, so any power at all lights the bottom segment: a radio left on the
  // WSPR beacon's 1 % must not read as a dead transmitter.
  const lit=seen ? Math.min(10,Math.ceil(percent/10)) : 0;
  dom.trxPowerSegments.forEach((segment,index)=>segment.classList.toggle("on",index<lit));
  const scale=fullPowerScale();
  const watts=seen && scale.watts ? scale.watts*level/255 : null;
  dom.trxPowerWatts.textContent=watts===null ? "--" : formatWatts(watts);
  dom.trxPower.title=!seen ? "TRX power — the radio has not reported its power level yet"
    : watts===null ? `TRX power ${Math.round(percent)} % · watts unknown: the radio model is not recognised`
    : `TRX power ${Math.round(percent)} % · ${formatWatts(watts)} of ${scale.watts} W (${scale.source})`;
}

// ---- RF power ---------------------------------------------------------------
//
// Same machinery as the WSPR page, one deliberate difference: there the target
// is a legal WSPR dBm level, because that number goes into the message. JS8
// announces no power at all, so the unit here is percent -- the radio's own
// display unit and its actual resolution, which also means every value that can
// be typed is one the radio can be set to, without needing the model table.
//
// The other difference is the direction. WSPR's automatic value is always the
// minimum, so its write goes down; this one can go UP, into whatever load the
// operator happens to have on the antenna socket. That is why it writes only a
// level the operator chose themselves, and only once "Enable radio TX" is
// ticked -- the one place on this page where they said the antenna is fine.
let rfAppliedPercent=null;   // last percent written AND confirmed by readback
let rfKnobTouched=false;     // operator moved it; the automation stands down
let rfAutoArmed=true;        // a write is owed: page load, or the link returned
let rfAutoBusy=false, rfAutoRetryMs=0, rfLinkWasUp=false, rfLastError="";
// What the operator has typed but not yet written. null means "not editing",
// and only then may a render put the stored target back into the box. Without
// it the number is lost the moment focus leaves the field -- which is exactly
// what happens on the way to the SET button beside it. Same shape as the
// txGain draft a few settings further down.
let rfDraft=null;

// Only for a reply that actually arrived, so it is the radio's link being
// judged and not the browser's.
function noteRadioLink(next) {
  const up=Boolean(next.connected);
  if(up && !rfLinkWasUp)rfAutoArmed=true;
  rfLinkWasUp=up;
}

// Meaningful only when no write is owed: just after the link returns the reading
// disagrees precisely because the radio may have forgotten, which is the case
// the automation is for -- not evidence of a hand on the front panel.
function noteRfKnob() {
  if(rfAutoArmed || rfAppliedPercent===null)return;
  if(!state.radio.connected || state.radio.rfPowerSeen!==true)return;
  if(WsprCore.civPercent(state.radio.rfPower)!==rfAppliedPercent)rfKnobTouched=true;
}

function rfTargetPercent() {
  const stored=currentJs8().rfPercent;
  return Number.isFinite(Number(stored)) && Number(stored)>=1 ? Number(stored) : null;
}

// Every write goes through here, so SET and the automation cannot drift apart.
async function writeRfPercent(percent) {
  const command=WsprCore.civLevelCommand(WsprCore.percentToLevel(percent));
  const wanted=WsprCore.civPercent(command.level);
  await fetch(RADIO_CMD_URL,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({type:"civ.raw",data:command.data})});
  // Confirmed in whole percent, never on the raw level: the radio quantises to
  // its own step, so demanding an exact echo would fail a write that landed
  // exactly where it was asked to.
  await new Promise((resolve,reject)=>{
    const started=Date.now();
    const timer=setInterval(()=>{
      if(state.radio.rfPowerSeen===true &&
         WsprCore.civPercent(state.radio.rfPower)===wanted){clearInterval(timer);resolve();}
      else if(Date.now()-started>=6000){clearInterval(timer);
        reject(new Error("the radio did not confirm the power level"));}
    },100);
  });
  rfAppliedPercent=wanted;
  return wanted;
}

async function applyAutoRfPower() {
  if(rfAutoBusy || !rfAutoArmed || rfKnobTouched)return;
  // A calibration measures the radio as the operator set it up. Writing a target
  // mid-run would file the result under a power the radio was never on -- and during
  // a plan the power is the plan's own, changing from cell to cell.
  if(state.calRunning || state.planRunning)return;
  if(Date.now()<rfAutoRetryMs)return;
  const target=rfTargetPercent();
  // Nothing chosen, nothing to apply. There is no safe value to invent for a
  // QSO mode, so a page nobody has configured leaves the radio alone.
  if(target===null){rfAutoArmed=false;return;}
  if(!currentJs8().txSafetyAccepted)return;
  if(!state.radio.connected || state.radio.transceiverType!=="ICOM-LAN")return;
  // Never mid-transmission: LAN drops on this setup happen under audio load,
  // which is exactly when something is on the air.
  if(radioTransmitting())return;
  if(state.radio.rfPowerSeen===true &&
     WsprCore.civPercent(state.radio.rfPower)===WsprCore.civPercent(WsprCore.percentToLevel(target))){
    // Already there. Record it so the knob detector has a baseline without
    // spending a CI-V round trip to establish one.
    rfAppliedPercent=WsprCore.civPercent(WsprCore.percentToLevel(target));
    rfAutoArmed=false; return;
  }
  rfAutoBusy=true;
  try { await writeRfPercent(target); rfAutoArmed=false; }
  catch (_error) { rfAutoRetryMs=Date.now()+5000; }   // stays armed, backs off
  finally { rfAutoBusy=false; renderHeader(); renderControls(); }
}

// The operator's own write. Still the only thing that turns a number in the box
// into a stored choice -- the automation applies a target, it never decides one.
async function setRfPowerFromField() {
  const percent=Math.max(1,Math.min(100,Math.round(Number(rfDraft ?? dom.rfPercent.value)||0)));
  dom.rfPercent.value=String(percent);
  dom.rfPercentSet.disabled=true;
  try {
    await writeRfPercent(percent);
    setJs8Setting("rfPercent",percent);
    // A fresh decision stands the automation back up after a turn of the knob.
    rfKnobTouched=false; rfAutoArmed=false; rfAutoRetryMs=0; rfLastError="";
    rfDraft=null;                       // written; the box may follow the target again
  } catch (error) {
    rfLastError=error.message;
  }
  dom.rfPercentSet.disabled=false;
  renderHeader(); renderControls();
}

function renderRfPowerField() {
  const scale=fullPowerScale();
  const seen=state.radio.rfPowerSeen===true;
  const radioPercent=seen ? WsprCore.civPercent(state.radio.rfPower) : null;
  const target=rfTargetPercent();
  // Nothing stored yet: show what the radio is on, so SET means "adopt this"
  // rather than making the operator guess a number to type.
  if(rfDraft===null && document.activeElement!==dom.rfPercent)
    dom.rfPercent.value=String(target ?? radioPercent ?? "");
  const shown=Number(rfDraft ?? dom.rfPercent.value)||0;
  dom.rfPercentWatts.textContent=scale.watts && shown>=1
    ? formatWatts(scale.watts*WsprCore.percentToLevel(shown)/255) : "--";
  const mismatch=Boolean(target!==null && radioPercent!==null && radioPercent!==target);
  dom.rfPowerField.classList.toggle("mismatch",mismatch);
  // One line, one source of truth: a failed write outranks everything, then the
  // disagreement, then nothing. Written as a single assignment so the line can
  // never keep saying something that stopped being true two renders ago.
  const message=rfLastError ? rfLastError
    : !mismatch ? ""
    : `The radio is on ${radioPercent} %, not the ${target} % set here` +
      (rfKnobTouched
        ? " — changed on the radio, so it is not written automatically until you press SET."
        : " — press SET to write it.");
  dom.rfPercentState.hidden=!message;
  dom.rfPercentState.textContent=message;
  return mismatch;
}

function renderHeader() {
  const connected=state.radio.connected && state.radio.transceiverType === "ICOM-LAN";
  const transmitting=radioTransmitting();
  const receiving=connected && state.lastAudioMs>0 && performance.now()-state.lastAudioMs<1500;
  if(state.spectrumWasTransmitting && !transmitting)resetSpectrumAnalyzer();
  state.spectrumWasTransmitting=transmitting;
  const modeCompatible=["USB","USB-D"].includes(state.radio.mode);
  dom.trxFrequencyValue.textContent=formatFrequency(state.pendingFrequency || state.radio.frequency);
  dom.trxFrequency.classList.toggle("pending",Boolean(state.pendingFrequency));
  const offDial=offDialFrequency();
  dom.trxFrequency.classList.toggle("off-dial",offDial);
  dom.trxFrequency.title=offDial ? "Not a JS8 dial frequency — choose a band from the menu" : "";
  renderTrxSlotLabel();
  dom.trxMode.textContent=state.radio.mode || "---";
  dom.trxMode.classList.toggle("incompatible",connected && !modeCompatible);
  dom.trxMode.title=connected && !modeCompatible ? "JS8Call-ICOM requires USB or USB-D" : "TRX mode";
  renderTrxPower(connected,renderRfPowerField());
  const incompatible=connected && Boolean(state.radio.mode) && !modeCompatible;
  if(incompatible && !state.help.incompatibleActive)openTrxHelp("mode");
  state.help.incompatibleActive=incompatible;
  dom.radioBar.classList.toggle("tx",transmitting);
  document.body.classList.toggle("radio-transmitting",transmitting);
  const starting=!state.startup.ready;
  dom.linkState.textContent=starting ? (state.startup.failed ? "● LOAD ERROR" : "● LOADING")
    : connected ? (transmitting ? "● TX" : receiving ? "● RX LIVE" : "● RX WAIT") : "● OFFLINE";
  dom.linkState.classList.toggle("error",state.startup.failed || (!starting && !connected));
  dom.linkState.classList.toggle("warning",!starting && connected && !transmitting && !receiving);
  const reconnectVisible=state.lanConfig.ready && !connected && state.radio.lanStatus==="disconnected";
  dom.trxReconnect.hidden=!reconnectVisible;
  dom.trxReconnect.disabled=state.reconnectPending;
  dom.trxReconnect.textContent=state.reconnectPending ? "Connecting…" : "Reconnect";
  dom.stationIdentity.textContent=`${currentJs8().myCall} · ${currentJs8().grid}`;
  const tb=audioSource ? audioSource.state().timebase : null;
  dom.timingState.textContent=tb ? `${tb.clock.status} · ${signed(tb.correction.totalMs)} ms` : "clock unchecked";
  if (frequencyMenuKey !== String(state.pendingFrequency || state.radio.frequency)) renderFrequencyMenu();
  renderTimetableButton();
}

function renderStartup() {
  // When a session was restored, drop the blocking full-screen gate so the
  // rebuilt history is visible immediately; the modem then warms up behind the
  // inline modem-state line instead of hiding everything. A FAILED modem is the
  // exception: that line lives in a section the page keeps hidden, so suppressing
  // the gate would leave the operator with a dead page, no explanation and no
  // reachable RETRY.
  const pending=(!state.startup.ready && !sessionRestored) || state.startup.failed;
  document.body.classList.toggle("startup-pending",pending);
  dom.startup.hidden=!pending;
  const progress=Math.max(0,Math.min(100,state.startup.progress));
  dom.startupProgress.value=progress;
  dom.startupProgress.textContent=`${Math.round(progress)}%`;
  dom.startupPercent.textContent=`${Math.round(progress)}%`;
  dom.startupLabel.textContent=state.startup.label;
  dom.startupDetail.textContent=state.startup.detail;
  dom.startupRetry.hidden=!state.startup.failed;
  if(!pending)requestAnimationFrame(resizeWaterfall);
}

function txBlockReasons(needsRecipient,allowFileTransfer=false) {
  const js8=currentJs8(), connected=state.radio.connected && state.radio.transceiverType === "ICOM-LAN";
  const busy=!['idle','completed','aborted','fault'].includes(state.txStatus);
  const mediaLocked=Boolean(audioSource && audioSource.state().timebase.media.status==="locked");
  const reasons=[];
  // A calibration owns the transmitter, and a calibration PLAN owns it for minutes at
  // a stretch -- including the pauses where it waits for an antenna answer with PTT
  // down and txStatus idle. Without this a heartbeat or an unattended reply would key
  // on the band the plan tuned, at the power the plan set, into the antenna the
  // operator is at that moment being asked about. state.radio.tx cannot cover it: it
  // comes off a 1 Hz poll and is false through every gap.
  if(state.planRunning)reasons.push("a calibration plan is running");
  else if(state.calRunning)reasons.push("a calibration is running");
  if(busy)reasons.push("TX is busy"); if(!connected)reasons.push("ICOM-LAN is offline");
  if(state.radio.tx&&!busy)reasons.push("TRX PTT is active");
  if(!["USB","USB-D"].includes(state.radio.mode))reasons.push("TRX mode must be USB or USB-D");
  if(!state.txWasmReady)reasons.push("TX core is loading");
  if(state.decoderStatus!=="ready")reasons.push("decoder is loading");
  if(!mediaLocked)reasons.push("audio timebase is not locked");
  if(needsRecipient && !state.selectedCall)reasons.push("select a recipient");
  if(needsRecipient && state.selectedCall){
    const blockedCountry=blockedCountryForCall(state.selectedCall);
    if(blockedCountry)reasons.push(`${state.selectedCall} is blocked (${blockedCountry})`);
  }
  if(!js8.myCall)reasons.push("set My callsign");
  if(!js8.txSafetyAccepted)reasons.push("confirm Enable radio TX");
  if(!allowFileTransfer&&binState.active&&!terminalTransferState(binState.active.state))reasons.push("a file-transfer session is active");
  return reasons;
}

function selectedEmailGateway() {
  return emailState.gateways.find(item=>item.id===emailState.selectedId) || null;
}

function emailFrameEstimate(draft) {
  const transport=Js8Email.transportParts(draft.payload,draft.gateway.target);
  return Js8Protocol.buildReplyFrames({myCall:currentJs8().myCall,
    toCall:transport.toCall,text:transport.text,mode:emailTxMode()}).length;
}

function emailTxMode() {
  return currentJs8().speed==="AUTO"?0:SPEED_TO_MODE[currentJs8().speed];
}

function emailDraftResult() {
  const gateway=selectedEmailGateway();
  if(!gateway)return {gateway:null,draft:null,error:"Select or add a gateway."};
  try {
    const draft=Js8Email.buildDraft(gateway,dom.emailAddress.value,dom.emailMessage.value);
    emailFrameEstimate(draft);
    return {gateway,draft,error:""};
  } catch(error) { return {gateway,draft:null,error:error.message}; }
}

function renderEmailControls() {
  const selected=selectedEmailGateway();
  const optionKey=`${emailState.selectedId}|${emailState.gateways.map(item=>`${item.id}:${item.name}`).join("|")}`;
  if(dom.emailGateway.dataset.options!==optionKey){
    dom.emailGateway.innerHTML='<option value="">Add or select a gateway</option>'+emailState.gateways
      .filter(item=>item.enabled).map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
    dom.emailGateway.value=emailState.selectedId;
    dom.emailGateway.dataset.options=optionKey;
  }
  dom.emailGatewayEdit.disabled=!selected; dom.emailGatewayDelete.disabled=!selected;
  const values=selected?[selected.target,`${(selected.dialFrequencyHz/1e6).toFixed(6)} MHz`,
    `${selected.offsetHz} Hz`,selected.format]:["—","—","—","—"];
  dom.emailGatewayDetails.innerHTML=`<span>Target</span><code>${esc(values[0])}</code><span>Dial</span><code>${esc(values[1])}</code><span>Offset</span><code>${esc(values[2])}</code><span>Format</span><code>${esc(values[3])}</code>`;
  const email=dom.emailAddress.value.trim();
  const budget=selected?Js8Email.getBodyBudget(selected,email):0;
  const normalizedLength=dom.emailMessage.value.replace(/[\r\n\t]+/g," ").replace(/\s+/g," ").trim().length;
  dom.emailBudget.textContent=selected
    ? `${Math.max(0,budget-normalizedLength)} of ${budget} characters remaining${selected.format==="aprs-email2"?" (email address included in APRS limit)":""}.`
    : "Select a gateway to see the message limit.";
  dom.emailBudget.classList.toggle("invalid",Boolean(selected&&normalizedLength>budget));
  const result=emailDraftResult();
  dom.emailPreview.textContent=result.draft?result.draft.payload:"Complete the form to preview the exact radio payload.";
  const touched=email.length>0||dom.emailMessage.value.trim().length>0;
  dom.emailError.textContent=touched?result.error:"";
  const blocks=txBlockReasons(false);
  if(!result.draft)blocks.push(result.error);
  const gatewayCountry=result.gateway&&blockedCountryForCall(result.gateway.target);
  if(gatewayCountry)blocks.push(`gateway ${result.gateway.target} is blocked (${gatewayCountry})`);
  dom.emailSend.disabled=blocks.filter(Boolean).length>0;
  dom.emailSend.title=blocks.filter(Boolean).join("; ");
  const outgoing=emailState.activeOutgoing;
  if(outgoing){
    if(outgoing.status==="completed")emailState.status="RF transmission completed. Gateway reception and email delivery are unconfirmed.";
    else if(outgoing.status==="fault"||outgoing.status==="aborted")emailState.status=`RF transmission ${outgoing.status}. Email was not confirmed.`;
    else emailState.status=`RF transmission ${outgoing.status}. Gateway reception is not yet confirmed.`;
  }
  dom.emailStatus.textContent=emailState.status;
}

function currentBinProfile() {
  const js8=currentJs8();
  let submode=SPEED_TO_MODE[js8.speed];
  if(js8.speed==="AUTO"){
    const station=state.activity.calls.find(item=>item.call===state.selectedCall);
    submode=station?Number(station.submode):0;
  }
  return Js8FileTransfer.profileForSubmode(submode);
}

function formatBytes(value) {
  const bytes=Number(value)||0;
  if(bytes<1024)return `${bytes} B`;
  const kib=bytes/1024;
  return `${Number.isInteger(kib)?kib:kib.toFixed(1)} KiB`;
}

function formatMinutes(value) {
  const minutes=Math.max(0,Math.ceil(Number(value)||0));
  return minutes<60?`${minutes} min`:`${Math.floor(minutes/60)} h ${minutes%60} min`;
}

// Countdown as hh:mm from a millisecond duration -- used for the unattended
// "time left until deactivation" readout on the AUTO pill. Rounds minutes up
// (like formatMinutes) so a fresh 12 h window reads 12:00, and the final
// partial minute still shows 00:01 rather than dropping to 00:00 early.
function formatHhMm(ms) {
  const minutes=Math.max(0,Math.ceil((Number(ms)||0)/60000));
  return `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;
}

// hh:mm still remaining on the arming window, or "" when disarmed/expired/unknown.
function autoRemainingLabel() {
  if(!state.autoExpiryAt)return "";
  const remaining=state.autoExpiryAt-Date.now();
  return remaining>0?formatHhMm(remaining):"";
}

// hh:mm until the next heartbeat beacon. heartbeat.dueInMs already folds in the
// bounded activity defer, so a busy band pushes this out (up to the ceiling) on
// its own. Blank when HB is off or unattended mode is not armed, because the
// beacon only actually fires while armed -- a live countdown otherwise would
// promise a transmission that never comes.
function hbNextLabel() {
  const dueInMs=heartbeat.dueInMs(js8Clock.now());
  if(dueInMs===null||!currentJs8().auto)return "";
  return formatHhMm(Math.max(0,dueInMs));
}

function terminalTransferState(value) {
  return ["complete","cancelled","rejected","failed"].includes(value);
}

function binSessionCounts(record) {
  if(!record)return {valid:0,total:0,bytes:0};
  const total=Number(record.blockCount)||0;
  if(record.direction==="tx"){
    const acknowledged=new Set(record.acknowledged||[]);
    let bytes=0;for(const sequence of acknowledged)if(sequence>0&&record.blocks?.[sequence])bytes+=record.blocks[sequence].length;
    return {valid:[...acknowledged].filter(value=>value>0).length,total,bytes};
  }
  let valid=0,bytes=0;for(let sequence=1;sequence<=total;sequence+=1)if(record.blocks?.[sequence]){valid+=1;bytes+=record.blocks[sequence].length;}
  return {valid,total,bytes};
}

function renderBinControls() {
  if(!binState.peerDraft&&state.selectedCall)binState.peerDraft=state.selectedCall;
  if(document.activeElement!==dom.binRecipient)dom.binRecipient.value=binState.peerDraft;
  const profile=currentBinProfile(),prepared=binState.prepared;
  const estimate=prepared?Js8FileTransfer.estimateDuration(prepared.manifest.originalSize,profile):null;
  const details=[
    ["Size",prepared?formatBytes(prepared.manifest.originalSize):"—"],
    ["Profile",`${profile.label} · ${profile.periodSeconds} s`],
    ["Hard limit",profile.hardLimit?formatBytes(profile.hardLimit):"Disabled"],
    ["Recommended",profile.warningSize?`≤ ${formatBytes(profile.warningSize)}`:"Disabled"],
    ["Blocks",prepared?`${prepared.manifest.blockCount} + manifest`:"—"],
    ["Estimate",estimate?`${formatMinutes(estimate.optimisticMinutes)}–${formatMinutes(estimate.plannedMinutes)}`:"—"]
  ];
  dom.binFileDetails.innerHTML=details.map(([label,value])=>`<span>${esc(label)}</span><code>${esc(value)}</code>`).join("");
  let error="";
  try{Js8FileTransfer.normalizeCallsign(binState.peerDraft);if(prepared)Js8FileTransfer.enforceFileLimit(prepared.manifest.originalSize,profile);}
  catch(reason){error=reason.message;}
  if(!prepared&&!binState.preparing)error=error||"Select a file.";
  if(binState.preparing)error="Preparing SHA-256 and blocks…";
  if(binState.storageError)error=binState.storageError;
  if(sameCall(binState.peerDraft,currentJs8().myCall))error="Cannot send a file to your own callsign";
  const binPeerCountry=blockedCountryForCall(binState.peerDraft);
  if(binPeerCountry)error=`${binState.peerDraft} is blocked (${binPeerCountry})`;
  dom.binError.textContent=error;
  const blocks=txBlockReasons(false);
  if(error)blocks.push(error);
  if(!dom.binPeerExpected.checked)blocks.push("confirm that the peer expects the transfer");
  if(binState.active&&!terminalTransferState(binState.active.state))blocks.push("another file-transfer session is active");
  dom.binOffer.disabled=blocks.length>0;
  dom.binOffer.title=blocks.join("; ");
  dom.binOffer.textContent=binState.preparing?"PREPARING…":"PREPARE OFFER";
  dom.binDraftStatus.textContent=prepared
    ? `${prepared.manifest.fileName} · SHA-256 ${prepared.manifest.sha256Hex.slice(0,16)}… · maximum ${formatBytes(profile.hardLimit)}`
    : profile.hardLimit?`${profile.label} accepts up to ${formatBytes(profile.hardLimit)}. The file is checked before loading.`:`${profile.label} file transfer is disabled.`;
  const record=binState.active;
  dom.binTransferPanel.hidden=!record;
  if(!record)return;
  const counts=binSessionCounts(record),elapsedMinutes=Math.max(1/60,(Date.now()-(record.startedAt||record.createdAt||Date.now()))/60000);
  dom.binTransferTitle.textContent=record.fileName;
  dom.binTransferPeer.textContent=`${record.direction==="tx"?"To":"From"} ${record.peerCallsign}`;
  dom.binTransferState.textContent=String(record.state||"idle").toUpperCase().replaceAll("-"," ");
  dom.binProgress.max=Math.max(1,counts.total);dom.binProgress.value=counts.valid;
  dom.binProgress.textContent=`${Math.round(counts.valid/Math.max(1,counts.total)*100)}%`;
  dom.binProgressText.textContent=`${counts.valid} / ${counts.total} data blocks${record.retransmittedBlocks?` · ${record.retransmittedBlocks} repaired`:""}`;
  const measuredRate=Math.round(counts.bytes/elapsedMinutes),remainingBytes=Math.max(0,record.originalSize-counts.bytes);
  dom.binTransferRate.textContent=`${measuredRate} B/min${measuredRate>0&&remainingBytes?` · ETA ${formatMinutes(remainingBytes/measuredRate)}`:""}`;
  dom.binLastActivity.textContent=record.lastActivityAt?`${age(record.lastActivityAt)} ago${record.lastSnr!=null?` · ${signed(record.lastSnr)} dB`:""}`:"No activity";
  dom.binTransferId.textContent=record.id;
  dom.binTransferHash.textContent=record.sha256Hex||record.hash12||"Pending manifest";
  dom.binProtocolMessage.textContent=binState.lastProtocol||record.lastProtocol||"—";
  dom.binTransferLog.innerHTML=(record.log||[]).slice(-30).map(item=>`<div><span>${esc(new Date(item.at).toISOString().slice(11,19))}</span><code>${esc(item.text)}</code></div>`).join("");
  dom.binPause.hidden=record.state==="paused"||terminalTransferState(record.state);
  dom.binPause.disabled=false;
  dom.binResume.hidden=record.state!=="paused";
  dom.binStop.disabled=terminalTransferState(record.state);
  dom.binDownload.hidden=!(record.direction==="rx"&&record.state==="complete"&&record.fileBytes);
}

// Signal-only pills in the SETTINGS header. Only switches with an on-air
// consequence are listed, so a closed panel still answers "what will this
// station do by itself?". Reading a setting is all they do -- switching one
// stays inside the section, which is why these are spans and not buttons.
// needsTx marks the switches that only reach the air through the txSafetyAccepted
// gate (drainTxQueue / checkHeartbeat / checkCqRepeat all refuse without it). With
// Radio TX off they are configured-but-silent, so the header must show them off.
const SETTINGS_FLAGS=[
  {key:"TX",   label:"Radio TX",                on:js8=>js8.txSafetyAccepted===true},
  {key:"AUTO", label:"Automatic query answers", on:js8=>js8.auto===true, needsTx:true,
    detail:()=>autoRemainingLabel(), inline:true},
  {key:"CQ",   label:"Repeated CQ",             on:js8=>Number(js8.cqRepeatMin)>0, needsTx:true,
    detail:js8=>`every ${Number(js8.cqRepeatMin)} min`},
  {key:"HB",   label:"Heartbeat transmission",  on:js8=>js8.hb===true, needsTx:true,
    detail:()=>hbNextLabel(), inline:true, tip:js8=>`every ${Number(js8.hbMinutes)} min`},
  {key:"ACK",  label:"Heartbeat acknowledgements", on:js8=>js8.hbAck!==false, needsTx:true}
];

function renderSettingsFlags(js8) {
  if(!dom.settingsFlags)return;
  const txOn=js8.txSafetyAccepted===true;
  dom.settingsFlags.innerHTML=SETTINGS_FLAGS.map(flag=>{
    // A TX-dependent switch that is configured but blocked by Radio TX being off is
    // shown off (no pill, no countdown); the tooltip names the reason so it does not
    // read as "the operator turned it off".
    const configured=flag.on(js8)===true;
    const suppressed=flag.needsTx===true && !txOn;
    const on=configured && !suppressed;
    const detailText=on && flag.detail ? flag.detail(js8) : "";
    const tipExtra=on && flag.tip ? flag.tip(js8) : "";
    // AUTO/HB show their live countdown (hh:mm to deactivation / next beacon)
    // inline so it is visible without hovering; the others keep the key alone and
    // carry any detail only in the tooltip. The tooltip always spells out the
    // full state, including the configured interval via `tip`.
    const text=flag.key + (flag.inline && detailText ? ` · ${detailText}` : "");
    const stateWord=on ? "on" : (suppressed && configured ? "off · needs Radio TX" : "off");
    const tip=[stateWord, detailText, tipExtra].filter(Boolean).join(" · ");
    return `<span class="summary-flag${on?" on":""}" title="${esc(flag.label)}: ${esc(tip)}">${esc(text)}</span>`;
  }).join("");
}

function renderControls() {
  const js8=currentJs8(), mode=selectedMode();
  // Never clobber a field the operator is actively editing: renderControls runs on
  // the 500 ms radio poll, so an unguarded assignment wipes each keystroke (same
  // focus guard as binRecipient). recipient commits via chooseCall on change.
  if(document.activeElement!==dom.recipient)dom.recipient.value=state.selectedCall;
  if(document.activeElement!==dom.txSpeed)dom.txSpeed.value=js8.speed;
  dom.txSpeedResolved.textContent=js8.speed==="AUTO" ? `→ ${speedDetail(mode)}` : `${MODE_PERIOD_SECONDS[mode]} s`;
  if(document.activeElement!==dom.txOffset)dom.txOffset.value=js8.txOffsetHz;
  dom.spectrumSummary.textContent=`RX ${RX_LOW}–${RX_HIGH} Hz · TX ${js8.txOffsetHz} Hz · ${speedDetail(mode)}`;
  // No focus guard and no draft: these are displays now, not fields, so there is
  // nothing half-typed to protect and no reason for this page to hold an opinion.
  dom.myCall.textContent=js8.myCall||"— not set";
  dom.myGrid.textContent=js8.grid||"— not set";
  dom.followSpeed.checked=js8.followSpeed;
  if(document.activeElement!==dom.clockCorrection)dom.clockCorrection.value=js8.clockCorrectionMs;
  dom.autoTiming.checked=js8.autoTiming;
  if(document.activeElement!==dom.txGain)dom.txGain.value=state.settingsDraft.txGain===null?js8.txGain:state.settingsDraft.txGain;
  renderResolvedGain();
  dom.txSafety.checked=js8.txSafetyAccepted;
  if(document.activeElement!==dom.infoText)dom.infoText.value=js8.infoText;
  renderStatusAnswer(js8);
  dom.autoReply.checked=js8.auto===true;
  if(dom.alertBeep)dom.alertBeep.checked=js8.alertBeep===true;
  if(!dom.armHours.options.length)
    dom.armHours.innerHTML=Js8Settings.ARM_HOURS.map(h=>`<option value="${h}">${h} h</option>`).join("");
  dom.armHours.value=String(js8.armHours);
  if(dom.groupNames && !dom.groupNames.options.length)
    dom.groupNames.innerHTML=joinableGroups().map(g=>`<option value="${g}"></option>`).join("");
  // The field only ever adds; what is joined lives in the palette, so nothing is written
  // back into the input and a second name cannot overwrite the first.
  renderGroupPanel();
  if(document.activeElement!==dom.groups && !dom.groupsHint.dataset.refused)
    renderGroupsHint(null);
  if(!dom.cqRepeat.options.length)
    dom.cqRepeat.innerHTML=Js8Settings.CQ_REPEAT_MIN.map(m=>`<option value="${m}">${m?m+" min":"off"}</option>`).join("");
  dom.cqRepeat.value=String(js8.cqRepeatMin||0);
  renderCqState();
  dom.hbEnabled.checked=js8.hb===true;
  dom.hbAck.checked=js8.hbAck!==false;
  if(!dom.hbMinutes.options.length)
    dom.hbMinutes.innerHTML=Js8Settings.HB_MINUTES.map(m=>`<option value="${m}">${m} min</option>`).join("");
  dom.hbMinutes.value=String(js8.hbMinutes);
  renderAutoState();
  renderHeartbeatState();
  dom.settingsSummary.textContent=`${js8.myCall} · ${js8.grid} · ${js8.speed}`;
  renderSettingsFlags(js8);
  const busy=!["idle","completed","aborted","fault"].includes(state.txStatus);
  // CQ carries its own recipient in the frame and an @APRSIS command carries its
  // own group call, so neither needs a station selected in the composer.
  const aprsDraft=Js8Aprs.isDraft(dom.message.value);
  const txBlocks=txBlockReasons(!cqType(dom.message.value)&&!aprsDraft), heartbeatBlocks=txBlockReasons(false), tuneBlocks=txBlockReasons(false);
  if(state.txSessionMode!=="CHAT")txBlocks.push(`${state.txSessionMode} uses its own form`);
  // A half-built command costs the same airtime as a whole one and the gateway
  // has nothing to do with it, so it never reaches the encoder.
  if(aprsDraft){
    const check=Js8Aprs.validate(dom.message.value);
    if(!check.ok)txBlocks.push(check.reason);
  }
  renderSendHint(aprsDraft);
  dom.send.disabled=txBlocks.length>0; dom.send.title=txBlocks.join("; ");
  // SEND LATER only needs a message and a real station -- deliberately NOT the
  // TX gates, because parking mail is what you do when you cannot transmit to
  // that station now. It refuses a group, since a group never shows up.
  if(dom.sendLater){
    const draft=dom.message.value.trim();
    const target=String(state.selectedCall||"");
    const reasons=[];
    if(!draft)reasons.push("type a message first");
    if(!target)reasons.push("select a station");
    else if(target.startsWith("@"))reasons.push("a group never shows up on the band");
    else if(!Js8Inbox.isCallsign(target))reasons.push(`${target} cannot be addressed in a directed frame`);
    if(draft.length>120)reasons.push(`${draft.length} characters, limit 120`);
    if(state.txSessionMode!=="CHAT")reasons.push("only in CHAT");
    dom.sendLater.disabled=reasons.length>0;
    dom.sendLater.title=reasons.length?reasons.join("; ")
      :`Hold this message and send it when ${target} shows up on the band`;
  }
  dom.heartbeat.disabled=heartbeatBlocks.length>0; dom.heartbeat.title=heartbeatBlocks.join("; ");
  dom.heartbeatOffset.textContent=`${js8.txOffsetHz} Hz`;
  dom.tune.disabled=!state.tuneActive && tuneBlocks.length>0;
  dom.tune.title=state.tuneActive ? "Stop tuning carrier" : tuneBlocks.join("; ");
  dom.tune.classList.toggle("active",state.tuneActive);
  dom.tuneLabel.textContent=state.tuneActive?"STOP":"TUNE";
  dom.tuneOffset.textContent=`${js8.txOffsetHz} Hz`;
  renderMessagePresets();
  // A value with no matching <option> blanks the selector, and neither EMAIL nor BIN
  // has one; keep the last real choice on screen instead of an empty box. Both modes
  // still work when state.txSessionMode is set from elsewhere (e.g. the test hook).
  if([...dom.txSessionMode.options].some(option=>option.value===state.txSessionMode))
    dom.txSessionMode.value=state.txSessionMode;
  dom.chatSession.hidden=state.txSessionMode!=="CHAT";
  dom.emailSession.hidden=state.txSessionMode!=="EMAIL";
  dom.binSession.hidden=state.txSessionMode!=="BIN";
  dom.txSessionModeHint.textContent=({CHAT:"Keyboard-to-keyboard messages",EMAIL:"Short radio email via a configured JS8 gateway",BIN:"Reliable store-and-resume transfer for small files"})[state.txSessionMode];
  dom.send.textContent=busy ? "QUEUED" : "SEND";
  dom.txSummary.textContent=state.txState ? `${state.txState.status}${state.txState.frameCount ? ` · frame ${Math.min(state.txState.frameIndex+1,state.txState.frameCount)}/${state.txState.frameCount}` : ""}${state.txState.error ? ` · ${state.txState.error}` : ""}` : "Idle";
  dom.modemState.textContent=state.decoderStatus === "ready" ? "JS8Call-ICOM ready · auto speed RX" : state.decoderStatus;
  // A stalled worker fetch is a failure whose text says nothing about "error", so
  // the state flag decides the colour rather than the wording of the reason.
  dom.modemState.className=`modem-state ${state.decoderStatus === "ready" ? "available" : state.startup.failed || state.decoderStatus.includes("error") ? "error" : ""}`;
  renderEmailControls(); renderBinControls(); renderTxPayload(); waterfall.paintOverlay(); renderHeader();
}

function chooseCall(call) {
  if (!call) return clearRecipient();
  const target=String(call).toUpperCase();
  // A group is a legitimate recipient, but only one we have joined. Answering to
  // @NET and calling into it are the same membership, and a group we are not in has
  // nobody there to hear us. @ALLCALL and @HB stay unselectable: a CQ addresses the
  // first by itself and the beacon owns the second.
  const group=target.startsWith("@");
  if (group && !isMyGroup(target)) return;
  if (sameCall(call,currentJs8().myCall)) return rejectOwnCall();
  state.selectedCall=group?target:call;
  // A file transfer needs a station that can acknowledge frames; a group cannot.
  if (!group) binState.peerDraft=call;
  state.txSessionMode="CHAT";
  const station=state.activity.calls.find(item=>item.call===call);
  if (station && currentJs8().followSpeed && currentJs8().speed!=="AUTO") currentJs8().speed=MODE_TO_SPEED[station.submode] || currentJs8().speed;
  persistSettings(false); renderActivity(); renderControls();
  dom.reply.open=true;
  dom.message.focus({preventScroll:true});
  persistSession();
}

function clearRecipient() {
  state.selectedCall="";
  renderActivity(); renderControls();
  dom.recipient.focus({preventScroll:true});
  persistSession();
}

// You can't work yourself: refuse your own callsign as recipient, revert the field to the
// current selection and explain why. Covers both a table-row click and a typed callsign.
function rejectOwnCall() {
  dom.recipient.value=state.selectedCall;
  dom.sessionMeta.textContent="Cannot call your own callsign";
}

function stationDirection(station) {
  if(!self.DXCC || !station)return null;
  const own=DXCC.locatorToLatLon(currentJs8().grid);
  let remote=station.grid ? DXCC.locatorToLatLon(station.grid) : null;
  let source=station.grid ? station.grid : "";
  if(!remote){
    const entity=DXCC.lookupDxcc(station.call);
    if(entity){remote={lat:entity.latitude,lon:entity.longitude};source=`DXCC estimate · ${entity.country}`;}
  }
  if(!own || !remote)return null;
  return {...DXCC.calculateQrbAzimuth(own.lat,own.lon,remote.lat,remote.lon),source};
}

// DXCC entity name for the stations table, from the same prefix table the QRPLog
// page uses (dxcc.js is loaded by both). Memoised because every render and every
// sort comparison asks for it again, and a callsign never changes entity.
const countryByCall=new Map();
function stationCountry(station) {
  const call=station && station.call;
  if(!call || !self.DXCC)return "";
  let country=countryByCall.get(call);
  if(country===undefined){
    country=DXCC.lookupDxcc(call)?.country || "";
    countryByCall.set(call,country);
  }
  return country;
}

// Blocked DXCC: the same list the QRPLog "Blocked DXCC" setting drives (delivered
// through /setup-data.json), now applied across JS8LAN. A callsign is blocked when
// its DXCC entity name contains any blocked entry (case-insensitive substring, the
// same match log.js uses). An unresolved callsign is NOT blocked — we never hide or
// refuse on a guess. Group calls (@ALLCALL, @APRSIS) never resolve, so they pass.
function blockedCountryForCall(call) {
  if(!state.blockedDxccList.length || !self.DXCC || !call)return null;
  if(String(call).startsWith("@"))return null;
  const country=stationCountry({call});
  if(!country)return null;
  const lc=country.toLowerCase();
  return state.blockedDxccList.some(entry=>lc.includes(entry))?country:null;
}
function isBlockedCall(call){return Boolean(blockedCountryForCall(call));}
// A decoded message is hidden when any callsign it touches (sender or recipient)
// is blocked.
function messageInvolvesBlocked(message){
  return (message.callsigns||[]).some(isBlockedCall);
}

function sortedStations(calls) {
  const {key,direction}=state.stationSort, factor=direction==="asc" ? 1 : -1;
  return [...calls].sort((a,b)=>{
    if(key==="country"){
      // Unresolved prefixes sink to the bottom in both directions -- an empty
      // cell sorted between two entities reads as a lookup bug.
      const av=stationCountry(a), bv=stationCountry(b);
      if(!av && !bv)return String(a.call).localeCompare(String(b.call));
      if(!av)return 1; if(!bv)return -1;
      return av.localeCompare(bv)*factor || String(a.call).localeCompare(String(b.call));
    }
    if(key==="distance"){
      const av=stationDirection(a)?.qrbKm, bv=stationDirection(b)?.qrbKm;
      if(av==null && bv==null)return String(a.call).localeCompare(String(b.call));
      if(av==null)return 1; if(bv==null)return -1;
      return (av-bv)*factor || String(a.call).localeCompare(String(b.call));
    }
    const av=a[key], bv=b[key];
    // Missing numbers (stations we only heard about) sink to the bottom in both
    // directions, exactly like an unresolved prefix or an unknown distance.
    if(key!=="call"){
      if(av==null && bv==null)return String(a.call).localeCompare(String(b.call));
      if(av==null)return 1; if(bv==null)return -1;
    }
    const result=key==="call" ? String(av).localeCompare(String(bv)) : Number(av||0)-Number(bv||0);
    return result*factor || String(a.call).localeCompare(String(b.call));
  });
}

function renderStationSort() {
  dom.stationHead.querySelectorAll("[data-station-sort]").forEach(button=>{
    const active=button.dataset.stationSort===state.stationSort.key;
    button.classList.toggle("active",active);
    button.querySelector(".sort-arrow").textContent=active ? (state.stationSort.direction==="asc" ? "↑" : "↓") : "";
    button.closest("th").setAttribute("aria-sort",active ? (state.stationSort.direction==="asc" ? "ascending" : "descending") : "none");
  });
}

// ---- "somebody is calling me" ----------------------------------------------
// Narrower than messageMentionsCall(), on purpose. Our callsign turns up in other
// people's HEARING lists and relay bodies all day long on a busy band; none of
// that is somebody talking TO us. The frame has to be addressed: directed.to is
// our callsign. That covers a reply to our CQ, an HB ack, and a hand-typed line,
// and it excludes being merely mentioned.
function messageAddressesMe(message,own){
  if(!own || message.outgoing)return false;
  return Boolean(message.directed) && sameCall(message.directed.to,own);
}

// One AudioContext, built on demand and never before. Two reasons it cannot be
// created at load: a browser will not let audio start without a user gesture, and
// this page already owns a real-time audio path to the radio that must not compete
// with a context nobody asked for. The first click anywhere on the page unlocks it.
let alertAudio=null;
function alertBeep(){
  try {
    const Ctor=self.AudioContext || self.webkitAudioContext;
    if(!Ctor)return;
    if(!alertAudio)alertAudio=new Ctor();
    if(alertAudio.state==="suspended")alertAudio.resume();
    // Still suspended means the page has never been clicked. Staying silent is the
    // honest outcome -- there is no way to force it, and the highlighted row is
    // what the operator gets in the meantime.
    if(alertAudio.state!=="running")return;
    const now=alertAudio.currentTime;
    const osc=alertAudio.createOscillator(), gain=alertAudio.createGain();
    osc.type="sine"; osc.frequency.value=880;
    // Shaped, not switched: a bare start/stop on a sine clicks at both ends, and
    // a click is exactly what a station listening on a nearby speaker notices.
    gain.gain.setValueAtTime(0.0001,now);
    gain.gain.exponentialRampToValueAtTime(0.18,now+0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001,now+0.34);
    osc.connect(gain).connect(alertAudio.destination);
    osc.start(now); osc.stop(now+0.36);
  } catch(_error) { /* an alert that cannot sound must never break the feed */ }
}

// Fires once per message, not once per frame: a long reception grows its text (and
// therefore its message key) with every frame, so the channel id is what identifies
// it while it arrives, exactly as openSectionsForNewOwnCall does. Without that a
// six-frame message addressed to us would beep six times.
function noteCallsToMe(messages){
  const own=currentJs8().myCall;
  const previous=state.answerAttention;
  const keys=new Set(messages.filter(item=>messageAddressesMe(item,own))
    .map(item=>item.id ? `channel|${item.id}` : activityMessageKey(item)));
  const sameOperator=previous.call===own;
  // A changed callsign re-seeds the set instead of beeping for the whole feed at
  // once, and a restored session does the same on the first render after reload.
  const fresh=sameOperator && previous.seeded
    ? [...keys].filter(key=>!previous.messages.has(key)) : [];
  state.answerAttention={call:own,messages:keys,seeded:true};
  if(fresh.length && currentJs8().alertBeep===true)alertBeep();
}

function openSectionsForNewOwnCall(messages,calls) {
  const own=currentJs8().myCall;
  const previous=state.ownCallAttention;
  // Keyed by channel identity where there is one: a growing reception changes its text and
  // therefore its message key with every frame, which would re-open a section the operator
  // has just collapsed, every few seconds. The identity also survives finalization, so one
  // reception pops the section open exactly once.
  const messageKeys=new Set(messages.filter(item=>!item.outgoing && messageMentionsCall(item,own))
    .map(item=>item.id ? `channel|${item.id}` : activityMessageKey(item)));
  const stationKeys=new Set(calls.filter(item=>sameCall(item.call,own))
    .map(item=>`${item.call}|${activityCallSignature(item)}`));
  const sameOperator=previous.call===own;
  if(messageKeys.size && (!sameOperator || [...messageKeys].some(key=>!previous.messages.has(key))))
    dom.trafficSection.open=true;
  if(stationKeys.size && (!sameOperator || [...stationKeys].some(key=>!previous.stations.has(key))))
    dom.stationsSection.open=true;
  state.ownCallAttention={call:own,messages:messageKeys,stations:stationKeys};
}

const TRAFFIC_WINDOWS={"5m":5*60*1000};
function messageTimeMs(message){return Number(message.lastSlotUtcMs || message.firstSlotUtcMs || 0);}
// Recent-traffic filter: one active mode at a time. Time windows are rolling (recomputed
// each render against Date.now()); MYCALL keeps only frames mentioning the operator's call;
// TX keeps every own transmission. It used to keep only the ones that went on air, which
// stopped making sense once a failed row carries a RESEND button: TX is where an operator
// comes back to sort out what did not get out, and that view must not hide the failures.
function filterTraffic(items,own){
  // CLEAR cannot reach the reassembly store inside the worker, so a live partial row would
  // pop straight back and read as a broken button. The watermark hides what the operator
  // wiped; a reception still in flight returns with its next frame, which is right -- that
  // is live traffic, not history. Own TX rows are wiped from outgoingLog instead.
  const cleared=Number(state.activity.clearedAtMs)||0;
  const messages=cleared
    ? items.filter(item=>item.outgoing || messageTimeMs(item)>cleared) : items;
  const filter=state.trafficFilter;
  if(filter==="mycall")return own ? messages.filter(message=>messageMentionsCall(message,own)) : messages;
  if(filter==="tx")return messages.filter(message=>message.outgoing);
  const windowMs=TRAFFIC_WINDOWS[filter];
  if(!windowMs)return messages;
  const cutoff=Date.now()-windowMs;
  return messages.filter(message=>messageTimeMs(message)>=cutoff);
}
// The report this row was decoded at. Blank -- not "+0" -- when there is none:
// signed() turns a missing value into a confident zero, and a fabricated report is
// worse than an empty cell. Rows we were only told about carry snr:null by design
// (js8-protocol.js), and so do own transmissions, which have nobody to report them.
function metaSnr(message){
  const value=Number(message && message.snr);
  return Number.isFinite(value) ? signed(value) : "";
}

// Multi-step HIDE: each press drops one more meta column, and the step after the
// last one brings them all back. The order runs from the piece the row can most
// afford to lose to the one it cannot -- Hz goes first because the signal stripe
// under the row already shows where in the passband this sat, and the timestamp
// goes last because it is the only anchor the feed is read by.
// Nothing is re-rendered to hide a column: the step lands in a data attribute on
// the container and CSS does the rest, so a press costs one attribute write even
// with a hundred rows on screen.
const TRAFFIC_HIDE_STEPS=[
  {next:"HIDE Hz",   title:"Hide the audio offset column"},
  {next:"HIDE SPD",  title:"Hide the speed column too"},
  {next:"HIDE SNR",  title:"Hide the signal report too"},
  {next:"HIDE TIME", title:"Hide the timestamp too — only callsign and text remain"},
  {next:"SHOW ALL",  title:"Bring every column back"},
];
function renderTrafficHideButton(){
  const step=((Number(state.trafficHide)||0)%TRAFFIC_HIDE_STEPS.length+TRAFFIC_HIDE_STEPS.length)
    %TRAFFIC_HIDE_STEPS.length;
  state.trafficHide=step;
  dom.traffic.dataset.hide=String(step);
  if(!dom.trafficHide)return;
  // The label names what the NEXT press removes, so the operator never has to
  // press once to find out what the button does.
  dom.trafficHide.textContent=TRAFFIC_HIDE_STEPS[step].next;
  dom.trafficHide.title=TRAFFIC_HIDE_STEPS[step].title;
  dom.trafficHide.classList.toggle("active",step>0);
  dom.trafficHide.setAttribute("aria-pressed",String(step>0));
}

function renderTrafficFilterButtons(own){
  if(state.trafficFilter==="mycall" && !own)state.trafficFilter="all";
  for(const button of dom.trafficFilter.querySelectorAll("[data-traffic-filter]")){
    const value=button.dataset.trafficFilter, active=value===state.trafficFilter;
    button.classList.toggle("active",active);
    button.setAttribute("aria-pressed",String(active));
    if(value==="mycall")button.disabled=!own;
  }
}

// CLEAR empties the recent-traffic history for the current frequency session only. Mutated in
// place so state.activity and the stored session keep sharing one array; the dedup set is left
// intact so cleared frames don't reappear while new decodes keep flowing in.
function clearRecentTraffic(){
  const messages=state.activity.messages;
  if(Array.isArray(messages))messages.length=0;
  // Live reassemblies and channels that finalize late live in the worker, out of reach of
  // this array; the watermark is what keeps them cleared.
  state.activity.clearedAtMs=js8Clock.now();
  // CLEAR empties the whole feed, own TX included. The per-station chat thread and
  // the in-flight transmission are untouched — this only wipes the traffic view.
  state.outgoingLog.length=0;
  renderActivity();
  persistSession();
}

// Own transmissions (manual and automatic) as recent-traffic feed items. Colour is
// LOCAL transmit state only — JS8 has no delivery ACK: "completed" means the frames
// went on air (rendered red, matching the radio's TX colour), anything else means a
// link/TX failure kept them off air (rendered grey). "unconfirmed" counts as on air:
// only the drain answer was lost, the carrier was not. Shaped like a decoded message
// so the existing filters and sort apply unchanged.
function outgoingTrafficItems(){
  const own=currentJs8().myCall;
  const tuned=Number(state.activityFrequency)||0;
  // Own TX belongs to the band it was sent on. Heard traffic is bucketed per frequency
  // while this log is global, so without the filter a 40 m transmission surfaces in the
  // 20 m feed — and its RESEND button would key the radio on the wrong band.
  return state.outgoingLog.filter(item=>onTunedBand(item.frequencyHz,tuned)).map(item=>({
    outgoing:true, status:item.status, emitted:["completed","unconfirmed"].includes(item.status),
    to:item.to||"", text:item.text, lastSlotUtcMs:Number(item.utcMs)||0,
    restored:Boolean(item.restored), item,
    // Where this transmission actually sat in the audio passband, recorded by the
    // encoder rather than read from the current setting: a heartbeat picks its own
    // tone, and so do the email gateway and file transfer. Items logged before this
    // existed carry neither, and simply get no stripe.
    offsetHz:Number(item.offsetHz), submode:Number(item.submode),
    callsigns:[own,item.to].filter(Boolean)}));
}

// Live reassemblies as feed items, shaped like a message so the existing sort and filters
// apply unchanged. A long message is visible while it arrives instead of appearing whole
// after its last frame -- and if that last frame never comes, the text is still here.
// `live` is the renderer's own staleness check with the same 4-period constant the store
// uses: when audio stops, no decode window is produced to age the channel, and a row must
// not keep claiming "receiving" for a reception that ended minutes ago.
function partialTrafficItems(){
  const now=js8Clock.now();
  return (state.activity.channels||[]).map(channel=>{
    const live=now-Number(channel.lastSlotUtcMs||0)
      < Js8Protocol.REASSEMBLY_TIMEOUT_PERIODS*Js8Protocol.slotPeriodMs(channel.submode);
    return {...channel, partial:true, live, text:String(channel.text||"").trimEnd()};
  }).filter(item=>!messageInvolvesBlocked(item));
}

// One word, the heaviest fact, in the same meta slot where a TX row reports
// completed/aborted. Colour stays a TX-only vocabulary (red = it was on the air), so
// nothing here needs a legend. A restored message from before this feature carries none of
// these fields and is complete by construction: back then only an EOT frame could push a
// message into the store at all.
function receptionState(message){
  if(message.partial)return message.live ? "receiving" : "incomplete";
  if(message.incomplete)return "incomplete";
  if(message.checksumOk===false)return "bad crc";
  if((message.gaps||[]).length)return "gap";
  return "";
}

// Where this row's signal sat in the audio passband, drawn on the same axis as the
// waterfall above: 500 Hz is the left edge of the row, 2700 Hz the right one, exactly as
// Spectrum.hzToX maps them onto the canvas. That only holds because the block is absolutely
// positioned -- its containing block is the row's PADDING box, which is the section's inner
// width, the same width the canvas is stretched to. A grid item would need the row's 10px
// padding negated by hand, and would silently drift the day that padding changes.
//
// The block starts at the reported offset and grows right, because the offset IS the lowest
// tone (js8_core.cpp: frequency = base + tone * spacing) and a signal occupies
// offset..offset+bandwidth. Same convention as drawTxMarker, same as the decoder reports.
//
// Not drawn at all when the offset is unknown -- a row restored from a session written
// before own-TX offsets were recorded. An invented position would be worse than none.
function stripeGeometry(message){
  const offsetHz=Number(message.offsetHz);
  if(!Number.isFinite(offsetHz)||!offsetHz)return null;
  const widthHz=Js8Protocol.bandwidthHz(Number(message.submode));
  const span=RX_HIGH-RX_LOW;
  const left=Math.max(0,Math.min(100,(offsetHz-RX_LOW)/span*100));
  // Clamped so a signal near the top of the passband cannot paint past the row edge and
  // claim bandwidth outside the decoder's range.
  return {offsetHz,widthHz,left,width:Math.max(0,Math.min(100-left,widthHz/span*100))};
}

// How solid a signal's occupancy band looks. SNR drives it because the question the band
// answers is "how much of an obstacle is this station" -- a +5 dB signal on your chosen
// offset is a different problem from a -20 dB one. Anything without a recorded SNR (own
// transmissions, rows restored from before SNR was kept) gets a flat middle value rather
// than a guess in either direction.
function stripeAlpha(snr){
  const value=Number(snr);
  if(!Number.isFinite(value))return .10;
  return .06+Math.max(0,Math.min(1,(value+26)/36))*.22;
}

function renderSignalStripe(message){
  const geometry=stripeGeometry(message);
  if(!geometry)return "";
  const {offsetHz,widthHz,left,width}=geometry;
  const kind=message.outgoing?(message.emitted?"tx-on-air":"tx-off-air"):"rx";
  // Full-height occupancy band behind the text, revealed only while the pointer is over the
  // waterfall. That is the moment the operator is asking "can I transmit here?", and the
  // answer is whether the hairline at the prospective offset runs through anybody's band.
  // Hidden the rest of the time on purpose: a hundred permanently tinted rows would be
  // wallpaper. Own transmissions get none -- they are not an obstacle to themselves.
  const band=message.outgoing ? ""
    : `<span class="signal-band" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;`
      +`background:rgba(120,214,196,${stripeAlpha(message.snr).toFixed(3)})"></span>`;
  // The tooltip is filled in on hover (see the mouseover handler): age has to be computed
  // when it is read, not when the feed happens to be redrawn.
  return band+`<span class="signal-stripe stripe-${kind}" data-stripe-offset="${Math.round(offsetHz)}"`
    +` data-stripe-width="${widthHz}" data-stripe-slot="${Number(message.lastSlotUtcMs)||0}"`
    +(Number.isFinite(Number(message.snr))?` data-stripe-snr="${Math.round(Number(message.snr))}"`:"")
    +` style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></span>`;
}

// The same bars from every visible row, stacked into one strip in the filter bar. Nothing is
// counted or bucketed: the bars are drawn translucent on top of each other, so where several
// stations sit on the same offset the colour simply adds up. That is the histogram -- band
// occupancy read at a glance, on the same axis as the waterfall and as every row below.
function renderTrafficHistogram(messages){
  return messages.map(message=>{
    const geometry=stripeGeometry(message);
    if(!geometry)return "";
    const own=message.outgoing?" histogram-bar-tx":"";
    return `<span class="histogram-bar${own}" style="left:${geometry.left.toFixed(3)}%;`
      +`width:${geometry.width.toFixed(3)}%"></span>`;
  }).join("");
}

// A thin line where a click on the waterfall would put the transmission, drawn in the
// waterfall itself and repeated across the whole feed. On its own the waterfall answers
// "is that frequency busy right now"; the feed answers "who has been there", which is the
// question a 16-second-deep waterfall cannot. Same axis in both, so the line is one
// straight edge from the canvas down through every row.
// Who was last heard where, as callsigns standing on the waterfall's own axis. Built from
// the rows on screen, newest first, one entry per station -- the same list the bars and the
// histogram come from, so nothing can disagree with anything. No age cut-off: a station that
// has not been heard for an hour still owns that frequency until somebody else takes it, and
// that is exactly what the operator needs to know before choosing where to call.
function collectStationLabels(messages){
  const seen=new Set(), labels=[];
  for(const message of messages){
    if(message.outgoing)continue;
    const geometry=stripeGeometry(message);
    if(!geometry)continue;
    const sender=message.headerMissing ? null : senderOf(message);
    if(!sender||!sender.clickable||seen.has(sender.call))continue;
    seen.add(sender.call);
    labels.push({call:sender.call, offsetHz:geometry.offsetHz,
      lastSlotUtcMs:Number(message.lastSlotUtcMs)||0});
  }
  return labels;
}

// Visible while the operator is working the waterfall, gone shortly after they stop. Crossing
// the edge shows them at once; every movement pushes the hiding back by three seconds; standing
// still for three seconds, or leaving, takes them away. The timer HIDES -- two earlier attempts
// had it revealing instead, and both were wrong for the same reason: choosing a frequency is
// continuous movement, so the labels have to be up during the movement, not after it.
const STATION_LABEL_IDLE_MS=3000;
function showStationLabels(){
  const appearing=!state.stationLabelsVisible;
  state.stationLabelsVisible=true;
  state.stationLabelsArmedMs=js8Clock.now();
  // Re-registering the same id replaces the pending task, which is what makes every movement
  // restart the countdown rather than queue another one.
  scheduler.after("stationLabels",STATION_LABEL_IDLE_MS,()=>{
    state.stationLabelsVisible=false;
    waterfall.paintOverlay();
  });
  if(appearing)waterfall.paintOverlay();
}
function clearStationLabels(){
  scheduler.cancel("stationLabels");
  if(!state.stationLabelsVisible)return;
  state.stationLabelsVisible=false;
  // Repaints here rather than leaving it to setCollisionPreview(null): the pointer can leave
  // without the hover frequency having changed, and the labels would then stay on a
  // waterfall nobody is pointing at.
  waterfall.paintOverlay();
}

// Vertical, reading upward, hanging from the top edge of the waterfall so the callsign sits
// above the trace it names. Brightness is age: the most recent station is pure white and the
// oldest fades to a dark grey, interpolated across whatever span is actually on screen -- with
// one station that means white, which is honest, since there is nothing to be older than.
// Drawn oldest first so a fresh station wins where two labels collide.
function drawStationLabels(overlayCtx,hzToX){
  const labels=state.stationLabels;
  if(!state.stationLabelsVisible||!labels.length)return;
  const times=labels.map(item=>item.lastSlotUtcMs);
  const newest=Math.max(...times), oldest=Math.min(...times);
  const span=newest-oldest;
  overlayCtx.save();
  overlayCtx.textBaseline="top";
  for(const label of [...labels].sort((a,b)=>a.lastSlotUtcMs-b.lastSlotUtcMs)){
    const t=span ? (newest-label.lastSlotUtcMs)/span : 0;
    const level=Math.round(255-t*(255-0x55));
    // A long compound callsign would run off the bottom of a 64 px canvas and be clipped into
    // a different callsign, which is worse than being small. Drop a size instead.
    let size=13;
    overlayCtx.font=`bold ${size}px ui-monospace, monospace`;
    let width=overlayCtx.measureText(label.call).width;
    if(width>dom.overlay.height-6){
      size=10;
      overlayCtx.font=`bold ${size}px ui-monospace, monospace`;
      width=overlayCtx.measureText(label.call).width;
    }
    overlayCtx.save();
    overlayCtx.translate(hzToX(label.offsetHz),3+width);
    overlayCtx.rotate(-Math.PI/2);
    // Solid black under the text, not a tint and not a shadow. The waterfall's warm end is
    // nearly white, and the dark-grey end of the age ramp was unreadable on top of it -- the
    // plate has to owe nothing to whatever is behind it. In this rotated frame local +x runs
    // up the screen and local +y runs right, so the plate is width-long and a line-height wide.
    overlayCtx.fillStyle="#000";
    overlayCtx.fillRect(-3,-2,width+6,size+5);
    overlayCtx.fillStyle=`rgb(${level},${level+6},${level+3})`;
    overlayCtx.fillText(label.call,0,0);
    overlayCtx.restore();
  }
  overlayCtx.restore();
}

function setCollisionPreview(hz){
  const value=Number.isFinite(hz)?Math.round(hz):null;
  if(state.previewHz===value)return;      // mousemove fires far faster than this needs to run
  state.previewHz=value;
  const active=value!==null;
  dom.traffic.classList.toggle("collision-preview",active);
  dom.trafficFilter.classList.toggle("collision-preview",active);
  if(active){
    const at=`${((value-RX_LOW)/(RX_HIGH-RX_LOW)*100).toFixed(3)}%`;
    dom.traffic.style.setProperty("--collision-x",at);
    dom.trafficFilter.style.setProperty("--collision-x",at);
  }
  waterfall.paintOverlay();
}

// Holes are drawn from the slot gaps the store recorded alongside the text, never from
// sentinels inside it: the text stays byte-identical for the inbox, relay, file transfer,
// APRS and the dedup key.
// The sender's callsign appears twice in a row: once in the <strong> column, which is the
// button that picks whom to talk to, and again at the head of the decoded text, where it has
// never done anything. That second, inert copy is where the aprs.fi lookup goes -- the
// selector keeps its click, and the underline promises a link only where there is one.
const APRS_FI_CALL = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]*(?:[-/][A-Z0-9]{1,3})?$/;
// aprs.fi only knows a station that reached APRS-IS, and the one message that proves it did
// is "@APRSIS GRID": the sender is asking the gateway to put their position on the network,
// so from that moment there is a page to link to. Every other row would be a guess, and a
// link that leads to "no data" teaches the operator to stop trusting the underline.
function callIsOnAprs(message){
  return /@APRSIS\s+GRID\b/i.test(String(message.text||""));
}
function senderLookupText(text,call,own){
  // Only the leading "CALL:" is linked, never a callsign quoted later in the body: aprs.fi
  // would answer for those too, but they are stations being talked ABOUT, and a row full of
  // underlines stops signalling anything.
  const head=`${call}:`;
  if(!call||!APRS_FI_CALL.test(call)||!text.toUpperCase().startsWith(head.toUpperCase()))
    return ownCallText(text,own);
  return `<a class="call-lookup" href="https://aprs.fi/${encodeURIComponent(call)}"`
    +` target="_blank" rel="noopener noreferrer"`
    +` title="Look ${esc(call)} up on aprs.fi">${esc(text.slice(0,call.length))}</a>`
    +ownCallText(text.slice(call.length),own);
}

// ---- REPLY: answering a CQ from the row that carries it ---------------------
// A CQ is recognised structurally, from the decoder's own frame classification
// (js8-protocol.js gives kind "cq" to a heartbeat-type frame with the CQ bit set),
// never by looking for the letters "CQ" in the text. A station saying "TNX FOR CQ"
// is not calling one, and a row that offers to transmit must not be decided by a
// substring.
//
// Answering is the operator's click and nothing else. The station never answers a
// CQ by itself: js8-autoreply.js still holds no handler for a bare SNR, so the only
// path from a CQ to the transmitter is this button.
const CQ_REPLY_MAX_AGE_MS=5*60*1000;   // the same 5 minutes the feed's own 5m filter uses

function isCqMessage(message){
  return !message.outgoing && Array.isArray(message.kinds) && message.kinds.includes("cq");
}

// Did we already answer THIS CQ? Derived from the own-TX log rather than from a
// flag stored on the row: the log is what survives a reload, and a second answer
// to the same call is only wrong if it came after this particular call went out.
function answeredCqSince(call,sinceMs){
  const since=Number(sinceMs)||0;
  return (state.outgoingLog||[]).some(item=>item && sameCall(item.to,call)
    && (Number(item.utcMs)||0)>=since
    && ["completed","unconfirmed","transmitting","queued"].includes(item.status));
}

// Whether the row's REPLY is live, and if not, exactly why. The button is rendered
// either way: a control that silently vanishes on some rows and not others reads as
// a rendering bug, and decision 13 does not allow a refusal without a reason.
// `blockedNow` is the transmit-gate verdict, computed once per render and passed in:
// it is the same answer for every row, and this page's comments are explicit that
// the render loop must not keep the encoder waiting.
function cqReplyState(message,sender,nowMs,blockedNow){
  if(!isCqMessage(message))return null;
  const call=sender && sender.clickable ? sender.call : "";
  if(!call || call.startsWith("@"))return null;         // nobody addressable to answer
  if(sameCall(call,currentJs8().myCall))return null;    // our own CQ echoed back
  const snr=Number(message.snr);
  const text=Number.isFinite(snr)?`SNR ${formatJs8Snr(snr)}`:"";
  const off=(reason)=>({call,text,enabled:false,reason});
  // Without a measured report there is nothing to say. This is the one CQ we heard
  // about rather than heard -- sending "+00" would be inventing a measurement.
  if(!text)return off("no signal report was measured for this row");
  const ageMs=nowMs-(Number(message.lastSlotUtcMs||message.firstSlotUtcMs)||0);
  if(ageMs>CQ_REPLY_MAX_AGE_MS)
    return off(`this CQ is ${Math.round(ageMs/60000)} min old — they are most likely in a QSO by now`);
  if(answeredCqSince(call,message.lastSlotUtcMs||message.firstSlotUtcMs))
    return off(`already answered ${call} since this call`);
  const blockedCountry=blockedCountryForCall(call);
  if(blockedCountry)return off(`${call} is blocked (${blockedCountry})`);
  if(blockedNow&&blockedNow.length)return off(blockedNow[0]);
  if(!activeEncoder)return off("TX core is not ready");
  return {call,text,enabled:true,reason:`Answer ${call} with ${text}`};
}

// One click: take over the TX session for this station, then queue the report.
// Queued rather than transmitted straight out, for the same reason RESEND is: the
// click can land in the middle of a frame that is already on the air.
function replyToCq(call,text){
  if(!call || !text)return;
  chooseCall(call);                       // recipient, TX SESSION open, thread on screen
  txQueue.push({source:"operator", text, to:call,
    nowMs:js8Clock.now(), submode:selectedMode(), meta:{command:"SNR"}});
  drainTxQueue(); renderTxQueue(); renderActivity();
}

function renderReceivedText(message,own){
  const text=String(message.text||"");
  const gaps=[...(message.gaps||[])].sort((a,b)=>Number(a.textIndex)-Number(b.textIndex));
  let html=message.headerMissing
    ? renderGapMarker({frames:1,slotUtcMs:message.firstSlotUtcMs},"header") : "";
  // A missing header means we tuned into the middle: the text does not begin with the
  // sender at all, and senderOf() has already refused to name one.
  const sender=message.headerMissing ? null : senderOf(message);
  const lead=sender&&sender.clickable&&callIsOnAprs(message) ? sender.call : "";
  let at=0;
  for(const gap of gaps){
    const index=Math.max(at,Math.min(text.length,Number(gap.textIndex)||0));
    const slice=text.slice(at,index);
    html+=(at===0?senderLookupText(slice,lead,own):ownCallText(slice,own))+renderGapMarker(gap);
    at=index;
  }
  const tail=text.slice(at);
  return html+(at===0?senderLookupText(tail,lead,own):ownCallText(tail,own));
}

// One fixed block per lost frame: how many characters it carried is unknowable (JSC
// compression packs a variable number into the same 72 bits), so the marker states the
// frame count it does know and claims nothing about length.
function renderGapMarker(gap,kind){
  const frames=Math.max(1,Number(gap.frames)||1);
  const when=Number(gap.slotUtcMs)||0;
  const at=when ? new Date(when).toISOString().slice(11,19) : "";
  const title=kind==="header"
    ? `header frame missing${at?` before ${at}`:""}`
    : `${frames} frame${frames===1?"":"s"} lost${at?` from ${at}`:""}`;
  return `<span class="rx-gap" title="${esc(title)}">${"░░░".repeat(frames)}</span>`;
}

// directed.from is the decoded sender. A callsign lifted out of the body is only a mention,
// and putting it in this column would also arm the row's click to switch the selected
// station -- the next transmission would then go to the wrong address.
function senderOf(message){
  if(message.directed && message.directed.from)
    return {call:message.directed.from, clickable:true};
  if(message.headerMissing)return {call:"?", clickable:false};
  const call=callOf(message);
  return {call, clickable:Boolean(call)};
}

// An item with no recorded frequency predates the field (or was restored from an older
// snapshot); showing it everywhere is better than hiding history the operator wrote.
function onTunedBand(frequencyHz,tunedHz){
  const band=Number(frequencyHz)||0, tuned=Number(tunedHz)||0;
  return !band || !tuned || Math.abs(band-tuned)<=ACTIVITY_FREQUENCY_TOLERANCE_HZ;
}

function renderActivity() {
  const bannedCalls = new Map(restrictions.activeBans(js8Clock.now()).map(ban => [ban.call, ban]));
  // Blocked DXCC entities are hidden everywhere: heard traffic, the stations table
  // (and the map, which derives from it below).
  const heard=(state.activity.messages || []).filter(message=>!messageInvolvesBlocked(message));
  const calls=(state.activity.calls || []).filter(item=>!isBlockedCall(item.call));
  const own=currentJs8().myCall;
  const responders=respondingCalls();
  renderTrafficFilterButtons(own);
  renderTrafficHideButton();   // paints the step restored from the session on first render
  // Hoisted out of the row loop: one band lookup and one clock read per render,
  // not one per row -- and every row then ages a CQ against the same instant.
  const workedBand=bandOf(state.radio.frequency);
  const nowMs=js8Clock.now();
  // needsRecipient is false on purpose: a REPLY addresses its own row's sender, not
  // whatever TX SESSION currently has selected.
  const blockedNow=txBlockReasons(false);
  const partials=partialTrafficItems();
  dom.trafficClear.disabled=(state.activity.messages || []).length===0
    && state.outgoingLog.length===0 && partials.length===0;
  // Merge own TX into the feed so a returning operator sees what the station sent
  // unattended, and by colour what actually went out versus what a failure dropped.
  // Reassemblies in progress ride along, so the newest row is what is arriving now.
  const messages=[...heard,...outgoingTrafficItems(),...partials];
  const filtered=filterTraffic(messages,own);
  // Receptions in progress are counted apart: they are not messages yet, and diluting them
  // into one total hides both facts.
  const receiving=filtered.filter(item=>item.partial && item.live).length;
  const total=filtered.length-receiving, all=messages.length-receiving;
  dom.trafficSummary.textContent=(total===all
    ? `${all} message${all===1?"":"s"}`
    : `${total} / ${all} messages`)+(receiving?` · ${receiving} receiving`:"");
  dom.stationSummary.textContent=`${calls.length} active`;
  const recent=[...filtered].sort((a,b)=>Number(b.lastSlotUtcMs||b.firstSlotUtcMs||0)-Number(a.lastSlotUtcMs||a.firstSlotUtcMs||0)).slice(0,100);
  let dividerShown=false;
  dom.traffic.innerHTML=recent.length ? recent.map(message => {
    // Traffic is newest-first, so live decodes sit above restored history. One
    // divider (relocated on every restore) marks where decoding was paused.
    let divider="";
    if(!dividerShown && message.restored){
      divider='<div class="restore-divider" role="separator">session restored · live decoding was paused while away</div>';
      dividerShown=true;
    }
    const when=new Date(message.lastSlotUtcMs || message.firstSlotUtcMs || 0).toISOString().slice(11,19);
    if(message.outgoing){
      // Red = went on air, grey = a failure kept it off air. A partially transmitted
      // message is neither: renderOutgoingText() keeps the frames that did radiate red
      // and strikes through only the rest, because claiming nothing went out when two
      // of five frames were keyed is a lie the operator would act on.
      const item=message.item;
      const cls=message.emitted?"tx-emitted":"tx-unsent";
      const target=message.to?esc(message.to):"CQ/HB";
      const attempts=Number(item&&item.attempts)||1;
      const retryUntil=Number(item&&item.retryUntilMs)||0;
      const resend=txResendable(item)
        ? `<button type="button" class="tx-resend" data-resend-id="${esc(String(item.id))}" title="${esc(resendTitle(item))}">↻ RESEND</button>` : "";
      return divider+`<article class="message message-tx ${cls}" data-tx-status="${esc(message.status)}" data-tx-attempts="${attempts}"><span class="message-meta"><span class="meta-time">${when}</span><span>TX</span><span>${esc(message.status)}${attempts>1?` ×${attempts}`:""}</span><span class="tx-retry" data-retry-until="${retryUntil}"></span></span><strong>${target}</strong><span class="message-text">${item?renderOutgoingText(item):esc(message.text)}</span>${resend}${renderSignalStripe(message)}</article>`;
    }
    const sender=senderOf(message);
    const call=sender.call;
    const operational=Array.isArray(message.kinds) && !message.kinds.includes("data");
    const ownCall=sameCall(call,currentJs8().myCall);
    // Already in the JS8CALL log on the band we are tuned to: dimmed, so the eye
    // lands on the stations still worth working. The predicate is the same set the
    // LOG QSO button reads, rebuilt from the log's real content by refreshJs8Log(),
    // so it survives a reload and a write from the QRPLog window. Own call and a
    // group are never "worked"; the green own-callsign rule wins by !important
    // anyway, which is why an operator's own row can never dim.
    const workedHere=!ownCall && call && !call.startsWith("@")
      && state.loggedCalls.has(loggedKey(call,workedBand));
    const senderClass=[ownCall?"own-callsign":"",workedHere?"worked":""].filter(Boolean).join(" ");
    // An APRS-IS answer to one of our own commands is addressed to the group, so
    // nothing else in the row would tell the operator it came back for them.
    const aprsReply=Js8Aprs.replyForMe(message,currentJs8().myCall)
      ? '<span class="aprs-badge" title="APRS-IS reply to your command">APRS</span>' : "";
    // ♢ means the same on both sides of the feed: the end of the message was confirmed. Its
    // absence is therefore evidence, which is why every intact reception carries it.
    const status=receptionState(message);
    const snrText=metaSnr(message);
    const ended=!message.partial && !message.incomplete;
    const reply=cqReplyState(message,sender,nowMs,blockedNow);
    const replyButton=reply
      ? `<button type="button" class="cq-reply" data-reply-call="${esc(reply.call)}"`
        +` data-reply-text="${esc(reply.text)}"${reply.enabled?"":" disabled"}`
        +` title="${esc(reply.reason)}">REPLY</button>` : "";
    // Addressed to us: the row gets its own frame and badge. This is the only
    // reaction -- nothing is transmitted in answer, by design. REPLY is the single
    // path from this feed to the transmitter, and it is a click.
    const forMe=messageAddressesMe(message,currentJs8().myCall);
    const classes=`message${operational?" operational":""}${aprsReply?" aprs-reply":""}`
      +(forMe?" message-for-me":"")
      +(reply&&reply.enabled?" has-reply":"")
      +(message.partial&&message.live?" message-receiving":"")
      +(status==="incomplete"?" message-incomplete":"")+(status==="bad crc"?" message-badcrc":"");
    return divider+`<article class="${classes}"${status?` data-rx-state="${esc(status)}"`:""}><span class="message-meta"><span class="meta-time">${when}</span><span class="meta-speed">${MODE_TO_SPEED[message.submode]||"?"}</span><span class="meta-hz">${Math.round(message.offsetHz)} Hz</span>${snrText?`<span class="meta-snr" title="Signal report this row was decoded at">${snrText} dB</span>`:""}${status?`<span class="rx-state">${esc(status)}</span>`:""}</span><strong${sender.clickable?` data-call="${esc(call)}"`:""}${senderClass?` class="${senderClass}"`:""}${ownCall?' data-own-call="true"':""}${workedHere?` title="${esc(call)} already logged on ${esc(workedBand||"this band")}"`:""}>${esc(call || "JS8")}</strong><span class="message-text">${forMe?'<span class="forme-badge" title="Addressed to your callsign">TO YOU</span>':""}${aprsReply}${renderReceivedText(message,currentJs8().myCall)}${ended?'<span class="rx-eot" title="End of message confirmed">♢</span>':""}</span>${replyButton}${renderSignalStripe(message)}</article>`;
  }).join("") : '<div class="empty-row">Waiting for JS8 activity…</div>';
  // Built from `recent`, the rows actually on screen, so the histogram and the list can
  // never disagree -- change the filter and the strip follows.
  dom.trafficHistogram.innerHTML=renderTrafficHistogram(recent);
  state.stationLabels=collectStationLabels(recent);
  if(state.stationLabelsVisible)waterfall.paintOverlay();
  renderRetryCountdowns();   // the 1 s tick owns it afterwards; this fills the first second
  dom.stationRows.innerHTML=sortedStations(calls).map(item=>{
    const direction=stationDirection(item);
    const directionHtml=direction ? `<span title="${esc(direction.source)} · ${direction.qrbKm} km · ${direction.azimuthDeg}°"><span class="station-bearing" style="transform:rotate(${direction.azimuthDeg}deg)">↑</span><span class="station-distance">${(direction.qrbKm/1000).toFixed(1)}</span></span>` : "—";
    const ownCall=sameCall(item.call,currentJs8().myCall);
    // Red callsign + arrow when this station has reacted to us, mirroring its red dot on
    // the map (Q7). Own call is never a responder, so the two never collide.
    const reacted=!ownCall && stationReacted(responders,item.call);
    // A station we are currently refusing to answer must say so, otherwise the
    // operator sees silence with no explanation (decision 13).
    const ban=bannedCalls.get(item.call);
    const banMark=ban?`<span class="station-ban" title="Auto replies paused ${Math.ceil(ban.remainingMs/60000)} min (level ${ban.level})">&#9208;</span>`:"";
    const country=stationCountry(item);
    // Stations we were only told about (named in someone else's frame) have no signal of
    // their own: showing the transmitting station's numbers here would credit them to the
    // wrong callsign, so the cells stay empty until we hear the station ourselves.
    const heard=item.heardDirectly!==false;
    const heardTitle=heard?"":' title="Heard about only — never decoded here"';
    return `<tr data-call="${esc(item.call)}" class="${item.call===state.selectedCall?"selected":""}${ban?" station-restricted":""}${heard?"":" station-indirect"}"${heardTitle}><td class="call${ownCall?" own-callsign":""}${reacted?" reacted":""}"${ownCall?' data-own-call="true"':""}${reacted?' title="Reacted to your transmission"':""}>${reacted?"← ":""}${esc(item.call)}${banMark}</td><td class="station-country"${country?` title="${esc(country)}"`:""}>${esc(country||"—")}</td><td>${heard?signed(item.snr):"—"}</td><td>${heard?Math.round(item.offsetHz):"—"}</td><td>${heard?speedDetail(item.submode):"—"}</td><td class="station-direction">${directionHtml}</td><td>${age(item.lastSlotUtcMs)}</td></tr>`;
  }).join("")+groupRowsHtml();
  noteCallsToMe(recent);
  openSectionsForNewOwnCall(recent,calls);
  renderStationSort();
  renderStationMap(calls,responders);
  renderConversation();
}

// Stations that have reacted to our transmissions: any received message whose callsigns
// include our call -- directed TO us (HEARTBEAT SNR ack, CQ reply, SNR/GRID report, message
// delivery, relay) or our call listed in a HEARING/relay body -- credited to the sender.
// Derived fresh every render (no per-station state), so it survives reload and resets with
// CLEAR, exactly like the traffic it is read from. Blocked entities are excluded like elsewhere.
function respondingCalls() {
  const own=currentJs8().myCall;
  const responders=new Set();
  if(!own) return responders;
  for(const message of state.activity.messages || []){
    if(message.outgoing || messageInvolvesBlocked(message) || !messageMentionsCall(message,own)) continue;
    const sender=(message.directed && message.directed.from) || (message.callsigns || [])[0];
    if(sender && !sameCall(sender,own)) responders.add(String(sender).toUpperCase());
  }
  return responders;
}
function stationReacted(responders,call){ return responders.has(String(call||"").toUpperCase()); }

// HEARING LINKS: the traffic constantly proves who is hearing whom, not only who I hear.
// Two commands carry a real report ("your signal is -13 dB here"), a handful are replies
// that make no sense except as a reaction to something copied, and HEARING names the
// stations the sender is currently copying. Everything else proves nothing: a station is
// called blind precisely when it cannot be heard, and store-and-forward mail is aimed at
// stations that may not even be on the band.
const HEARING_REPORT_COMMANDS=new Set([" SNR"," HEARTBEAT SNR"]);
const HEARING_REPLY_COMMANDS=new Set([" ACK"," NACK"," RR"," QSL"," 73"," SK"," YES"," NO",
  " FB"," AGN?"," DIT DIT"," STATUS"," INFO"," GRID"]);
// Propagation moves; an hour-old arrow claims a path that may be long gone.
const HEARING_LINK_MAX_AGE_MS=3600000;

// Groups, the placeholder call and free-text words out of a HEARING payload are not
// stations. Every real callsign carries a digit, which is enough of a sieve here.
function hearingLinkCall(call){
  const value=String(call||"").trim().toUpperCase();
  return /^[A-Z0-9/]{3,}$/.test(value) && /\d/.test(value) ? value : "";
}

// Ordered pairs "heard -> listener", newest report per pair. Pairs touching my own call are
// left out on purpose: every dot is by definition a station I hear, and "they reacted to me"
// is already the red dot plus the ← in the stations table.
function hearingLinks(messages, own, nowMs){
  const links=new Map();
  const add=(heard,listener,detail,atMs)=>{
    const from=hearingLinkCall(heard), to=hearingLinkCall(listener);
    if(!from || !to || from===to) return;
    if(sameCall(from,own) || sameCall(to,own)) return;
    if(isBlockedCall(from) || isBlockedCall(to)) return;
    const key=`${from}|${to}`, previous=links.get(key);
    if(previous && previous.atMs>=atMs) return;
    links.set(key,{from,to,detail,atMs});
  };
  for(const message of messages||[]){
    // An incomplete or checksum-failed reception proves nothing about who hears whom: a
    // truncated HEARING payload would draw a path on the map that may not exist.
    if(message.incomplete || message.checksumOk===false) continue;
    const directed=!message.outgoing && message.directed;
    if(!directed) continue;
    const atMs=Number(message.lastSlotUtcMs||message.firstSlotUtcMs||0);
    if(!atMs || nowMs-atMs>HEARING_LINK_MAX_AGE_MS) continue;
    if(HEARING_REPORT_COMMANDS.has(directed.command)){
      const report=String(message.payload||"").trim().split(/\s+/)[0]||"";
      add(directed.to,directed.from,report?`${report} dB`:"report",atMs);
    } else if(HEARING_REPLY_COMMANDS.has(directed.command)){
      add(directed.to,directed.from,directed.command.trim().toLowerCase(),atMs);
    } else if(directed.command===" HEARING"){
      // The payload lists who the SENDER copies; the addressee is only who is being told.
      for(const listed of String(message.payload||"").toUpperCase().split(/[^A-Z0-9/]+/))
        add(listed,directed.from,"hearing",atMs);
    }
  }
  return [...links.values()];
}

// STATIONS MAP: azimuthal-equidistant radar centred on my QTH. Dots are stations placed by
// azimuth (0deg = N = up) and linear distance (furthest sits at the plotting edge). Summary
// count is always refreshed; the SVG is only built while the disclosure is open. Dots of
// stations that reacted to us are drawn red (see respondingCalls), and green arrows between
// two remote dots show a third-party path (see hearingLinks).
function renderStationMap(calls, responders) {
  responders=responders || respondingCalls();
  renderHearingLinksButton();
  const placed=[], noPos=[];
  for(const item of (calls||[])){
    const dir=stationDirection(item);
    const reacted=stationReacted(responders,item.call);
    if(dir && Number.isFinite(dir.qrbKm) && Number.isFinite(dir.azimuthDeg)) placed.push({item,dir,reacted});
    else noPos.push(item);
  }
  // Only paths whose both ends are on the map can be drawn -- and are counted, so the
  // summary never promises links the operator cannot see.
  const onMap=new Set(placed.map(entry=>entry.item.call));
  const edges=hearingLinks(state.activity.messages,currentJs8().myCall,Date.now())
    .filter(link=>onMap.has(link.from) && onMap.has(link.to));
  const reactedCount=(calls||[]).filter(item=>stationReacted(responders,item.call)).length;
  const parts=[`${placed.length} on map`];
  if(reactedCount) parts.push(`${reactedCount} reacted`);
  if(edges.length) parts.push(`${edges.length} link${edges.length===1?"":"s"}`);
  if(noPos.length) parts.push(`${noPos.length} no pos`);
  dom.stationMapSummary.textContent=parts.join(" · ");
  if(!dom.stationMapSection || !dom.stationMapSection.open) return;
  if(!self.DXCC || !DXCC.locatorToLatLon(currentJs8().grid)){
    dom.stationMap.innerHTML='<div class="empty-row">Set My grid to see the map.</div>'; return;
  }
  if(!placed.length){
    dom.stationMap.innerHTML='<div class="empty-row">Waiting for stations with position…</div>'; return;
  }
  dom.stationMap.innerHTML=buildStationMapSvg(placed,state.hearingLinksVisible?edges:[]);
}

function renderHearingLinksButton(){
  if(dom.stationMapLog){
    const log=state.mapLogScale===true;
    dom.stationMapLog.classList.toggle("active",log);
    dom.stationMapLog.setAttribute("aria-pressed",String(log));
  }
  if(!dom.stationMapLinks) return;
  const on=state.hearingLinksVisible!==false;
  dom.stationMapLinks.classList.toggle("active",on);
  dom.stationMapLinks.setAttribute("aria-pressed",String(on));
}

// Distance -> radius. Linear is the default and unchanged: half the radius is half
// the distance, which is what a radar plot promises.
//
// LOG exists for the case the linear plot cannot draw at all -- a map holding both
// a station 30 km away and one 15 000 km away puts the neighbour 0.2 % out from the
// centre, under the operator's own dot. log10(1+d)/log10(1+dmax) spreads those out:
// 0 km still maps to the centre (log10(1) = 0, so there is no floor to invent and
// no free constant to tune), it is monotonic, and dmax still lands on the rim.
function mapRadiusFor(qrbKm,maxKm,plotR){
  const d=Math.max(0,Number(qrbKm)||0), max=Math.max(1,Number(maxKm)||1);
  if(state.mapLogScale!==true)return (d/max)*plotR;
  return (Math.log10(1+d)/Math.log10(1+max))*plotR;
}

// The rings. In linear mode they sit at a third and two thirds of the radius, as
// they always have. In LOG mode that would be meaningless -- two thirds of the
// radius is no longer two thirds of the distance -- so the rings become decades and
// carry their value. A ring is only drawn when it actually falls inside the plot,
// otherwise a 200 km map would be crossed by a labelled 10 000 km circle.
const MAP_LOG_DECADES=[10,100,1000,10000];
function mapRings(maxKm,plotR,cx,cy){
  if(state.mapLogScale!==true)
    return `<circle cx="${cx}" cy="${cy}" r="${(plotR/3).toFixed(1)}" class="map-ring"/>`
      +`<circle cx="${cx}" cy="${cy}" r="${(plotR*2/3).toFixed(1)}" class="map-ring"/>`;
  let out="";
  for(const km of MAP_LOG_DECADES){
    if(km>=maxKm)continue;                 // beyond the rim, or the rim itself
    const r=mapRadiusFor(km,maxKm,plotR);
    if(r<12)continue;                      // too close to the centre dot to read
    out+=`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" class="map-ring"/>`
      +`<text x="${cx+3}" y="${(cy-r+3).toFixed(1)}" class="map-ring-label">`
      +`${km>=1000?`${km/1000}k`:km}</text>`;
  }
  return out;
}

const MAP={CX:150, CY:150, R_FRAME:132, R_PLOT:120, DOT:4, LABEL_R:143};
function stationMapTip({item,dir,reacted}){
  // A station we only ever heard *about* has no signal numbers of its own -- the ones in
  // the table row belong to whoever transmitted its callsign.
  const heard=item.heardDirectly!==false;
  return `${reacted?"← ":""}${item.call} · ${heard?`${signed(item.snr)} dB`:"not heard directly"} · ${Math.round(dir.qrbKm)} km · ${dir.azimuthDeg}°`;
}
function hearingLinkTip(link){ return `${link.from} → ${link.to} · ${link.detail} · ${age(link.atMs)}`; }
function buildStationMapSvg(placed, edges) {
  const {CX,CY,R_FRAME,R_PLOT,DOT,LABEL_R}=MAP;
  const maxKm=Math.max(...placed.map(p=>p.dir.qrbKm)) || 1;
  const points=placed.map(({item,dir,reacted})=>{
    const r=mapRadiusFor(dir.qrbKm,maxKm,R_PLOT), a=dir.azimuthDeg*Math.PI/180;
    return {item,dir,reacted,x:CX+r*Math.sin(a),y:CY-r*Math.cos(a)};
  });
  // Merge dots that would touch (centre-to-centre distance <= one diameter). Greedy single pass;
  // each cluster keeps the first member's position so a dot never drifts off its real bearing.
  const clusters=[], touch=DOT*2;
  for(const p of points){
    const c=clusters.find(cl=>Math.hypot(cl.x-p.x,cl.y-p.y)<=touch);
    if(c) c.members.push(p); else clusters.push({x:p.x,y:p.y,members:[p]});
  }
  // Hearing links attach to the merged cluster, never to the raw point, or an arrow would
  // end next to the dot it belongs to. One line per station pair: reported in both
  // directions it becomes a single line with a head at each end ("we hear each other").
  const clusterOf=new Map();
  for(const cluster of clusters) for(const member of cluster.members) clusterOf.set(member.item.call,cluster);
  const pairs=new Map();
  for(const link of edges||[]){
    const from=clusterOf.get(link.from), to=clusterOf.get(link.to);
    if(!from || !to) continue;
    const key=[link.from,link.to].sort().join("|"), pair=pairs.get(key);
    if(pair) pair.links.push(link); else pairs.set(key,{from,to,links:[link]});
  }
  const insideCluster=new Map(), hearingLines=[];
  for(const pair of pairs.values()){
    // Both ends merged into one dot: there is no line to draw, so the pair is reported in
    // that dot's tooltip instead of being lost.
    if(pair.from===pair.to){
      const listed=insideCluster.get(pair.from) || [];
      listed.push(...pair.links.map(link=>`hears: ${hearingLinkTip(link)}`));
      insideCluster.set(pair.from,listed); continue;
    }
    const dx=pair.to.x-pair.from.x, dy=pair.to.y-pair.from.y, length=Math.hypot(dx,dy) || 1;
    // Pull each end back so the arrowhead clears the dot instead of hiding under it,
    // without ever inverting the line when two clusters sit close together.
    const gap=Math.min(DOT+2,(length-2)/2), ux=dx/length*gap, uy=dy/length*gap;
    const x1=(pair.from.x+ux).toFixed(1), y1=(pair.from.y+uy).toFixed(1);
    const x2=(pair.to.x-ux).toFixed(1), y2=(pair.to.y-uy).toFixed(1);
    const both=pair.links.length>1 ? ' marker-start="url(#mapHearingArrow)"' : "";
    hearingLines.push(`<g class="map-hearing"><title>${esc(pair.links.map(hearingLinkTip).join("\n"))}</title>`+
      `<line class="map-hearing-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`+
      `<line class="map-hearing-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#mapHearingArrow)"${both}/></g>`);
  }
  const defs=`<defs><marker id="mapHearingArrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z" class="map-hearing-head"/></marker></defs>`;
  const frame=
    mapRings(maxKm,R_PLOT,CX,CY)+
    `<circle cx="${CX}" cy="${CY}" r="${R_FRAME}" class="map-frame"/>`+
    `<text x="${CX}" y="${CY-LABEL_R}" class="map-compass">N</text>`+
    `<text x="${CX+LABEL_R}" y="${CY}" class="map-compass">E</text>`+
    `<text x="${CX}" y="${CY+LABEL_R}" class="map-compass">S</text>`+
    `<text x="${CX-LABEL_R}" y="${CY}" class="map-compass">W</text>`+
    `<text x="294" y="14" class="map-scale">${state.mapLogScale===true?"LOG · ":""}${(maxKm/1000).toFixed(1)} kkm</text>`;
  const spokes=clusters.map(c=>`<line x1="${c.x.toFixed(1)}" y1="${c.y.toFixed(1)}" x2="${CX}" y2="${CY}" class="map-link"/>`).join("");
  const dots=clusters.map(c=>{
    const tip=esc([...c.members.map(stationMapTip),...(insideCluster.get(c)||[])].join("\n"));
    // A cluster is red if any of its merged members reacted to us (Q4): the alert
    // that "someone here made contact" must win over the plain heard dots.
    const reacted=c.members.some(m=>m.reacted);
    // Hollow while every station merged here is one we have only been told about, so the
    // map never claims to hear a station that merely got named on the air.
    const phantom=!c.members.some(m=>m.item.heardDirectly!==false);
    const badge=c.members.length>1 ? `<text x="${(c.x+6).toFixed(1)}" y="${(c.y-5).toFixed(1)}" class="map-badge">×${c.members.length}</text>` : "";
    return `<g class="map-dot${reacted?" reacted":""}${phantom?" phantom":""}"><circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${DOT}"><title>${tip}</title></circle>${badge}</g>`;
  }).join("");
  const center=`<circle cx="${CX}" cy="${CY}" r="5" class="map-center"><title>${esc(currentJs8().myCall||"My station")}</title></circle>`;
  return `<svg viewBox="0 0 300 300" class="station-map-svg" role="img" aria-label="Stations radar map">${defs}${frame}${spokes}${hearingLines.join("")}${dots}${center}</svg>`;
}

function age(utcMs) {
  const seconds=Math.max(0,Math.round((Date.now()-Number(utcMs||0))/1000));
  if(seconds<60)return `${seconds}s`;
  const minutes=Math.floor(seconds/60);
  if(minutes<60)return `${minutes}m`;
  // Larger ages read poorly as a raw minute count (e.g. "125m"); show them as
  // elapsed h:mm instead.
  return `${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,"0")}`;
}
function messageBelongsToConversation(message) {
  // A chat thread is a record of what was said; half a sentence with a hole in it belongs
  // in the traffic feed, where its state is spelled out, not in a conversation.
  if(message.incomplete)return false;
  const calls=message.callsigns||[];
  // A group thread is the mirror image of a station thread: the selection is the
  // RECIPIENT and the senders are many, so the test moves from calls[0] to calls[1].
  // Our own transmissions are excluded because they already arrive from the outgoing
  // side of the thread -- a decoded copy of our own frame would show up twice.
  if(isMyGroup(state.selectedCall))
    return sameCall(calls[1],state.selectedCall) && !sameCall(calls[0],currentJs8().myCall);
  if(!sameCall(calls[0],state.selectedCall))return false;
  const directed=Array.isArray(message.kinds)&&message.kinds.includes("directed");
  return !directed || !calls[1] || sameCall(calls[1],currentJs8().myCall);
}
function conversationItems() {
  // `from` matters only for a group thread, where every bubble may have a different
  // sender; on a station thread it is always the selected call anyway.
  const received=(state.activity.messages||[]).filter(messageBelongsToConversation).map(message=>({direction:"incoming",from:senderOf(message).call,time:new Date(message.lastSlotUtcMs||0).toISOString().slice(11,19),text:message.text,status:"received"}));
  return [...received,...(state.conversations[state.selectedCall]||[])].sort((a,b)=>a.time.localeCompare(b.time));
}
function renderOutgoingText(item) {
  const length=item.text.length;
  const sent=Math.max(0,Math.min(length,Number(item.sentChars)||0));
  // "unconfirmed" is deliberately absent: the carrier went out, only the drain answer
  // was lost, so striking the text through would claim a failure that did not happen.
  const failed=["aborted","fault","expired","interrupted"].includes(item.status);
  const active=!failed&&sent<length&&Number(item.activeFraction)>0;
  const pendingStart=Math.min(length,sent+(active?1:0));
  let html="";
  if(sent>0)html+=`<span class="tx-copy tx-copy-sent">${esc(item.text.slice(0,sent))}</span>`;
  if(active)html+=`<span class="tx-copy tx-copy-active" style="--tx-character-progress:${Math.round(item.activeFraction*100)}%">${esc(item.text.slice(sent,sent+1))}</span>`;
  if(pendingStart<length)html+=`<span class="tx-copy ${failed?"tx-copy-failed":"tx-copy-pending"}">${esc(item.text.slice(pendingStart))}</span>`;
  if(!html)html=`<span class="tx-copy ${failed?"tx-copy-failed":"tx-copy-pending"}">${esc(item.text)}</span>`;
  if(item.status==="completed")html+='<span class="tx-eot" title="End of transmission">♢</span>';
  return html;
}
function renderTxPayload() {
  const item=state.lastOutgoing;
  dom.txPayload.hidden=!item;
  if(!item){dom.txPayload.textContent="";return;}
  dom.txPayload.innerHTML=`<strong>LAST TX</strong><span class="tx-payload-copy">${renderOutgoingText(item)}</span><small>${esc(item.status)}</small>`;
}
function renderConversation() {
  dom.sessionCall.textContent=state.selectedCall || "No station selected";
  const station=state.activity.calls.find(item=>item.call===state.selectedCall);
  const blockedCountry=blockedCountryForCall(state.selectedCall);
  // A station we have only been told about carries no signal numbers of its own; saying
  // so is better than printing the zeros left behind by the missing values.
  const indirect=Boolean(station) && station.heardDirectly===false;
  // A group has no signal of its own to report, so the line says what it is instead of
  // leaving the "choose a callsign" prompt up while a recipient is plainly selected.
  const group=isMyGroup(state.selectedCall);
  dom.sessionMeta.textContent=blockedCountry
    ? `blocked · ${blockedCountry} — TX refused`
    : group ? "group broadcast · no QSO, no log"
    : indirect ? "heard about only — never decoded here"
    : station ? `${signed(station.snr)} dB · ${Math.round(station.offsetHz)} Hz · speed ${speedDetail(station.submode)}` : "Choose a callsign from traffic or stations";
  dom.sessionMeta.classList.toggle("session-blocked",Boolean(blockedCountry));
  updateLogQsoButton(station);
  const items=state.selectedCall ? conversationItems() : [];
  dom.chat.innerHTML=items.length ? items.map(item=>{
    if(item.direction==="system")return `<div class="chat-row system"><div class="chat-system">${esc(item.text)}</div></div>`;
    // Same word, same meaning as in the traffic feed: it sends. A conversation restored
    // from a snapshot is detached from the outgoing log, so those rows keep the older
    // behaviour of restaging the text in the composer rather than offering a dead button.
    const resend=item.direction!=="outgoing" ? ""
      : txResendable(item) ? `<button type="button" class="chat-resend" data-resend-id="${esc(String(item.id))}">↻ resend</button>`
      : item.status==="interrupted" ? `<button type="button" class="chat-resend" data-resend-text="${esc(item.sourceText||item.text)}">↻ resend</button>` : "";
    return `<div class="chat-row ${item.direction}"><article class="chat-bubble" data-message-status="${esc(item.status)}"><header><strong>${item.direction==="incoming"?esc(item.from||state.selectedCall):esc(currentJs8().myCall)}</strong><time>${esc(item.time)}</time></header><div class="chat-message">${item.direction==="outgoing"?renderOutgoingText(item):esc(item.text)}</div><footer>${esc(item.status)}${resend}</footer></article></div>`;
  }).join("") : '<div class="chat-empty">No messages in this session.</div>';
  dom.chat.scrollTop=dom.chat.scrollHeight;
}

// ---- JS8CALL log: auto/manual "Log QSO" from the TX session -----------------
// JS8LAN owns a dedicated, permanent log named JS8CALL and always writes into it,
// independent of whichever log the QRPLog tab has marked active. A QSO is logged
// automatically the moment an SNR was exchanged in BOTH directions (we sent one
// and they sent one), or manually at any time before that. Dedup is per band, so
// the same station can be logged again on a different band but not twice on one.
const JS8_LOG_NAME="JS8CALL";

// Amateur band from a dial frequency (mirrors freqToBand in log.js). "" = unknown.
function bandOf(hz) {
  const f=Number(hz)||0;
  if(f>=1800000&&f<=2000000)return"160m";
  if(f>=3500000&&f<=4000000)return"80m";
  if(f>=5351500&&f<=5366500)return"60m";
  if(f>=7000000&&f<=7300000)return"40m";
  if(f>=10100000&&f<=10150000)return"30m";
  if(f>=14000000&&f<=14350000)return"20m";
  if(f>=18068000&&f<=18168000)return"17m";
  if(f>=21000000&&f<=21450000)return"15m";
  if(f>=24890000&&f<=24990000)return"12m";
  if(f>=28000000&&f<=29700000)return"10m";
  if(f>=50000000&&f<=54000000)return"6m";
  if(f>=70000000&&f<=71000000)return"4m";
  if(f>=144000000&&f<=148000000)return"2m";
  if(f>=222000000&&f<=225000000)return"1.25m";
  if(f>=420000000&&f<=450000000)return"70cm";
  if(f>=902000000&&f<=928000000)return"33cm";
  return"";
}

// In-memory dedup key: one QSO per callsign per band.
function loggedKey(call, band) { return `${String(call||"").toUpperCase()}|${band||"?"}`; }

// The newest JS8CALL log, or null. Identity is the contest name, not the date in
// the id, so the log created on day one keeps receiving QSOs forever.
async function findJs8Log() {
  const logs=await window.LogDB.getLogs();
  return (logs||[]).filter(item=>item && item.contestName===JS8_LOG_NAME)
    .sort((a,b)=>String(b.createdAtUtc||"").localeCompare(String(a.createdAtUtc||"")))[0] || null;
}

// Resolve the JS8CALL log, creating it on first use (id becomes YYYY-MM-DD-JS8CALL).
// Creation does NOT touch activeLogId — JS8LAN stays independent of the QRPLog tab.
async function ensureJs8Log() {
  if(state.js8Log)return state.js8Log;
  let log=await findJs8Log();
  if(!log){
    const js8=currentJs8();
    log=await window.LogDB.createLog({contestName:JS8_LOG_NAME,
      stationCall:js8.myCall||"", myLocator:js8.grid||"", defaultExchange:"", startQsoNumber:1});
  }
  state.js8Log=log;
  return log;
}

// Load the JS8CALL log and rebuild the per-band logged set from its real content,
// so the button state is correct even after a reload. Never creates the log.
async function refreshJs8Log() {
  if(!window.LogDB)return;
  try {
    state.js8Log=await findJs8Log();
    const logged=new Set();
    if(state.js8Log){
      const qsos=await window.LogDB.getQsosForLog(state.js8Log.id);
      for(const qso of qsos||[]) if(qso && !qso.deleted && qso.call)
        logged.add(loggedKey(qso.call, bandOf(qso.frequencyHz)));
    }
    state.loggedCalls=logged;
  } catch(_error) { state.js8Log=null; }
  renderConversation();
}

// Scan decoded messages newest→oldest for the SNR the selected station last
// reported about us (a directed message FROM them TO our call). Returns "" when
// they never sent one — that half of the pair is optional per the design.
function reportedSnrForCall(call) {
  const my=currentJs8().myCall;
  if(!call || !my)return "";
  const messages=state.activity.messages || [];
  for(let index=messages.length-1;index>=0;index-=1){
    const message=messages[index];
    if(!Array.isArray(message.kinds) || !message.kinds.includes("directed"))continue;
    const callsigns=message.callsigns || [];
    if(!sameCall(callsigns[0],call) || !sameCall(callsigns[1],my))continue;
    const match=/\bSNR\s*([+-]?\d+)/i.exec(message.text || "");
    if(match)return formatJs8Snr(Number(match[1]));
  }
  return "";
}

// Scan our own outgoing messages to a call newest→oldest for the SNR we last sent
// them (an HB ack "HEARTBEAT SNR xx" or an answer "SNR xx"). Faulted/interrupted
// transmissions never reached the air, so they do not count as a sent SNR.
function sentSnrForCall(call) {
  const items=state.conversations[call] || [];
  for(let index=items.length-1;index>=0;index-=1){
    const item=items[index];
    if(item.direction!=="outgoing")continue;
    if(item.status==="fault" || item.status==="interrupted")continue;
    const match=/\bSNR\s*([+-]?\d+)/i.exec(item.sourceText || item.text || "");
    if(match)return formatJs8Snr(Number(match[1]));
  }
  return "";
}

function updateLogQsoButton(station) {
  const button=dom.logQso;
  if(!button)return;
  const call=state.selectedCall;
  if(!window.LogDB){button.dataset.action="log";button.disabled=true;button.textContent="LOG QSO";button.title="Log storage unavailable";return;}
  const band=bandOf(state.radio.frequency);
  const loggedHere=Boolean(call) && state.loggedCalls.has(loggedKey(call,band));
  // VIEW LOG: the selected station is already logged on this band, or nothing is
  // selected but a JS8CALL log already exists to open.
  if(loggedHere || (!call && state.js8Log)){
    button.dataset.action="view";button.disabled=false;button.textContent="VIEW LOG";
    button.title=loggedHere ? `${call} logged on ${band||"this band"} → ${JS8_LOG_NAME} (open log)` : `Open ${JS8_LOG_NAME} log`;
    return;
  }
  // LOG QSO: manual logging is always available once a station is selected.
  button.dataset.action="log";button.textContent="LOG QSO";
  if(!call){button.disabled=true;button.title="Select a station to log";return;}
  // A group is a target, not a station on the other end: there is nobody to have
  // worked, so the button says why rather than writing "@NET" into the log.
  if(isMyGroup(call)){button.disabled=true;button.title=`${call} is a group, not a station — nothing to log`;return;}
  button.disabled=false;
  button.title=`Log ${call} to ${JS8_LOG_NAME}`;
}

function pushSystemMessage(call, text) {
  if(!call)return;
  if(!state.conversations[call])state.conversations[call]=[];
  state.conversations[call].push({direction:"system",time:new Date().toISOString().slice(11,19),text,status:"info"});
  renderConversation();
  persistSession();
}

// Write one QSO for `call` into the JS8CALL log. Deduped per band against both the
// in-memory set and the log's real content, and guarded against concurrent writes.
// Shared by the manual button and the automatic both-SNR trigger.
async function logQsoFor(call, {manual=false}={}) {
  if(!call || !window.LogDB)return;
  // Last line of defence: no path may write a group into the log, whichever layer
  // above decided to call this.
  if(String(call).startsWith("@"))return;
  const frequencyHz=Number(state.radio.frequency)||0;
  const band=bandOf(frequencyHz);
  const key=loggedKey(call,band);
  if(state.loggedCalls.has(key) || state.autoLogInFlight.has(key))return;
  state.autoLogInFlight.add(key);
  try {
    const log=await ensureJs8Log();
    // Persistent per-band dedup: survives reloads and writes from other pages.
    const dupes=await window.LogDB.findDupes(log.id, call);
    if((dupes||[]).some(qso=>qso && !qso.deleted && bandOf(qso.frequencyHz)===band)){
      state.loggedCalls.add(key); renderConversation(); return;
    }
    const station=state.activity.calls.find(item=>item.call===call);
    const rstSent=sentSnrForCall(call);
    const rstReceived=reportedSnrForCall(call);
    const saved=await window.LogDB.commitQso({
      logId:log.id, call, rstSent, rstReceived,
      frequencyHz, frequencyDisplay:formatFrequency(frequencyHz),
      mode:"JS8", trx:state.radio.trx1Label||"TRX1",
      grid:(station && station.grid) || "",
      bandClass:frequencyHz>49_000_000 ? "VHF_PLUS" : "HF",
      source:manual ? "js8-tx-session" : "js8-auto",
    });
    state.loggedCalls.add(key);
    pushSystemMessage(call,`QSO logged → ${JS8_LOG_NAME} #${saved.qsoNumber} · ${band||"?"} · rst ${rstSent||"—"} / rcv ${rstReceived||"—"}${manual?"":" (auto)"}`);
    renderConversation();
  } catch(error) {
    pushSystemMessage(call,`Log failed: ${error.message||error}`);
  } finally {
    state.autoLogInFlight.delete(key);
  }
}

// Global auto-log sweep: every station that has exchanged an SNR in BOTH directions
// gets logged, selected or not, so unattended QSOs are logged too. Cheap guards keep
// it off the database once a call+band is already logged.
function maybeAutoLogQsos() {
  if(!window.LogDB)return;
  const my=currentJs8().myCall;
  if(!my)return;
  const band=bandOf(state.radio.frequency);
  const candidates=new Set();
  for(const call of Object.keys(state.conversations||{}))candidates.add(call);
  for(const item of state.activity.calls||[]) if(item && item.call)candidates.add(item.call);
  for(const call of candidates){
    if(!call || sameCall(call,my))continue;
    // Groups arrive here by themselves the moment one gets a conversation thread, and
    // an auto-logged QSO with "@NET" is not a mistake anyone would spot in the log.
    if(String(call).startsWith("@"))continue;
    const key=loggedKey(call,band);
    if(state.loggedCalls.has(key) || state.autoLogInFlight.has(key))continue;
    if(blockedCountryForCall(call))continue;
    if(sentSnrForCall(call) && reportedSnrForCall(call))logQsoFor(call,{manual:false});
  }
}

async function handleLogQso() {
  const call=state.selectedCall;
  if(!call || !window.LogDB)return;
  dom.logQso.disabled=true; // guard against a double click while the write runs
  await logQsoFor(call,{manual:true});
  renderConversation();
}

// VIEW LOG: steer the QRPLog tab to the JS8CALL log, then open it in a new window.
async function openJs8Log() {
  try {
    const log=state.js8Log || await findJs8Log();
    if(log)await window.LogDB.setSetting("activeLogId", log.id);
  } catch(_error) {}
  window.open("/log","_blank");
}

function renderDiagnostics() {
  const tb=audioSource ? audioSource.state().timebase : null;
  if (!tb) { dom.diagnosticSummary.textContent="Audio link unavailable"; dom.diagnostics.innerHTML="<span>Transport</span><code>Waiting for ICOM-LAN audio</code>"; return; }
  dom.diagnosticSummary.textContent=`${tb.clock.status} · ${tb.media.status} · gaps ${tb.transport.sequenceGaps}`;
  dom.diagnostics.innerHTML=`<span>Audio WebSocket</span><code>${esc(state.audioStatus)}</code><span>Browser/system clock</span><code>${esc(tb.clock.status)} · epoch ${tb.clock.epoch} · jumps ${tb.clock.jumps} <button id="confirmClock" type="button">Confirm synchronized</button></code><span>Media epoch</span><code>${tb.media.epoch} · ${esc(tb.media.reason)} · ${esc(tb.media.status)}</code><span>Packets</span><code>${tb.transport.acceptedPackets} accepted · ${tb.transport.duplicatePackets} duplicate · ${tb.transport.sequenceGaps} gaps</code><span>Timing correction</span><code>manual ${signed(tb.correction.manualMs)} ms · auto ${signed(tb.correction.autoMs)} ms · ${esc(tb.correction.status)} <button id="resetTiming" type="button">Reset</button></code>`;
  $("confirmClock").addEventListener("click",()=>{audioSource.confirmClock();renderDiagnostics();renderHeader();});
  $("resetTiming").addEventListener("click",()=>{audioSource.resetTiming();renderDiagnostics();renderHeader();});
}

function openEmailGatewayDialog(gateway=null) {
  emailState.editingId=gateway?.id||"";
  dom.emailGatewayDialogTitle.textContent=gateway?"Edit email gateway":"Add email gateway";
  dom.emailGatewayName.value=gateway?.name||"";
  dom.emailGatewayTarget.value=gateway?.target||"";
  dom.emailGatewayDial.value=gateway?.dialFrequencyHz||state.radio.frequency||"";
  dom.emailGatewayOffset.value=gateway?.offsetHz||currentJs8().txOffsetHz;
  dom.emailGatewayFormat.value=gateway?.format||"direct";
  dom.emailGatewayTemplate.value=gateway?.template||"{TARGET} MSG EMAIL {EMAIL} {BODY}";
  dom.emailGatewayMaxBody.value=gateway?.maxBodyLength||60;
  dom.emailGatewayPolicy.value=gateway?.characterPolicy||"js8";
  dom.emailGatewayTemplateRow.hidden=dom.emailGatewayFormat.value!=="template";
  dom.emailGatewayError.textContent="";
  dom.emailGatewayDialog.showModal();
  dom.emailGatewayName.focus();
}

function gatewayFromDialog() {
  return Js8Email.normalizeGateway({id:emailState.editingId||undefined,
    name:dom.emailGatewayName.value,target:dom.emailGatewayTarget.value,
    dialFrequencyHz:Number(dom.emailGatewayDial.value),offsetHz:Number(dom.emailGatewayOffset.value),
    format:dom.emailGatewayFormat.value,template:dom.emailGatewayTemplate.value,
    maxBodyLength:Number(dom.emailGatewayMaxBody.value),characterPolicy:dom.emailGatewayPolicy.value});
}

function saveEmailGateway(event) {
  event.preventDefault();
  try {
    const gateway=gatewayFromDialog();
    const index=emailState.gateways.findIndex(item=>item.id===gateway.id);
    if(index>=0)emailState.gateways.splice(index,1,gateway);else emailState.gateways.push(gateway);
    emailState.gateways=Js8Email.save(localStorage,emailState.gateways);
    emailState.selectedId=gateway.id; emailState.status="Gateway profile saved locally.";
    dom.emailGatewayDialog.close(); renderControls();
  } catch(error) { dom.emailGatewayError.textContent=error.message; }
}

function deleteSelectedEmailGateway() {
  const gateway=selectedEmailGateway();
  if(!gateway||!confirm(`Delete gateway profile “${gateway.name}”?`))return;
  emailState.gateways=emailState.gateways.filter(item=>item.id!==gateway.id);
  emailState.gateways=Js8Email.save(localStorage,emailState.gateways);
  emailState.selectedId=emailState.gateways[0]?.id||"";
  emailState.status="Gateway profile deleted."; renderControls();
}

function openEmailConfirmation() {
  const result=emailDraftResult();
  if(!result.draft){dom.emailError.textContent=result.error;return;}
  const draft=result.draft;
  emailState.pendingDraft=draft;
  dom.emailConfirmGateway.textContent=`${draft.gateway.name} · ${draft.gateway.target}`;
  dom.emailConfirmFrequency.textContent=`${(draft.gateway.dialFrequencyHz/1e6).toFixed(6)} MHz`;
  dom.emailConfirmOffset.textContent=`${draft.gateway.offsetHz} Hz`;
  dom.emailConfirmFrames.textContent=String(emailFrameEstimate(draft));
  dom.emailConfirmPayload.textContent=draft.payload;
  dom.emailConfirmDialog.returnValue="";
  dom.emailConfirmDialog.showModal();
}

function waitForRadioFrequency(frequency,timeoutMs=12000) {
  return new Promise((resolve,reject)=>{
    const started=Date.now();
    const timer=setInterval(()=>{
      if(state.radio.frequency===frequency){clearInterval(timer);resolve();}
      else if(Date.now()-started>=timeoutMs){clearInterval(timer);reject(new Error("TRX did not confirm the gateway dial frequency."));}
    },100);
  });
}

function startEmailTx(draft) {
  const js8=currentJs8(),transport=Js8Email.transportParts(draft.payload,draft.gateway.target);
  activeEncoder.setToneOffset(draft.gateway.offsetHz).configure({myCall:js8.myCall,
    toCall:transport.toCall,mode:emailTxMode(),clockCorrectionMs:js8.clockCorrectionMs});
  const item=queueOutgoing(Js8Protocol.formatDirectedMessage({myCall:js8.myCall,
    toCall:transport.toCall,text:transport.text}));
  item.email=true; emailState.activeOutgoing=item;
  driveEncoder(activeEncoder.encode(transport.text),error=>failOutgoing(item,error));
}

async function transmitPendingEmail() {
  const draft=emailState.pendingDraft; emailState.pendingDraft=null;
  if(!draft)return;
  try {
    const current=Js8Email.buildDraft(draft.gateway,draft.recipientEmail,draft.body);
    if(current.payload!==draft.payload)throw new Error("Email draft changed before transmission.");
    const blocks=txBlockReasons(false);
    if(blocks.length)throw new Error(blocks.join("; "));
    emailState.status="Tuning the TRX to the gateway…"; renderControls();
    if(currentJs8().txOffsetHz!==draft.gateway.offsetHz)setJs8Setting("txOffsetHz",draft.gateway.offsetHz);
    if(state.radio.frequency!==draft.gateway.dialFrequencyHz){
      await requestFrequency(draft.gateway.dialFrequencyHz);
      await waitForRadioFrequency(draft.gateway.dialFrequencyHz);
    }
    const readyBlocks=txBlockReasons(false);
    if(readyBlocks.length)throw new Error(readyBlocks.join("; "));
    startEmailTx(draft);
    dom.emailMessage.value="";
    emailState.status="Queued for RF transmission. Gateway reception and email delivery are unconfirmed.";
    renderControls();
  } catch(error) {
    if(state.pendingFrequency===draft.gateway.dialFrequencyHz)state.pendingFrequency=null;
    emailState.status=`Email TX failed: ${error.message}`;
    dom.emailError.textContent=error.message; renderControls();
  }
}

function addTransferLog(record,text) {
  if(!record)return;
  if(!Array.isArray(record.log))record.log=[];
  record.log.push({at:Date.now(),text:String(text)});
  if(record.log.length>100)record.log.splice(0,record.log.length-100);
  record.lastActivityAt=Date.now();record.lastProtocol=String(text);binState.lastProtocol=String(text);
}

async function saveTransfer(record) {
  if(!record)return false;
  record.updatedAt=Date.now();
  const index=binState.sessions.findIndex(item=>item.id===record.id);
  if(index>=0)binState.sessions[index]=record;else binState.sessions.push(record);
  try{await transferStore.save(record);binState.storageError="";renderControls();return true;}
  catch(error){binState.storageError=`Transfer storage failed: ${error.message}`;renderControls();return false;}
}

function transferRecordFromPrepared(prepared,peer,profile) {
  const now=Date.now();
  return {id:prepared.manifest.transferId,direction:"tx",peerCallsign:peer,
    fileName:prepared.manifest.fileName,mimeType:prepared.manifest.mimeType,
    originalSize:prepared.manifest.originalSize,compression:"none",
    blockSize:prepared.manifest.blockSize,blockCount:prepared.manifest.blockCount,
    sha256Hex:prepared.manifest.sha256Hex,hash12:prepared.manifest.hash12,
    blocks:prepared.blocks.map(item=>item.bytes),profileKey:profile.key,submode:profile.submode,
    windowSize:profile.windowSize,state:"offered",acknowledged:[],retransmitQueue:[],
    retransmittedBlocks:0,lastWindow:[],offerAttempts:0,statusAttempts:0,
    createdAt:now,startedAt:now,updatedAt:now,lastActivityAt:now,log:[]};
}

function encodedTransferBlock(record,sequence) {
  const bytes=record.blocks?.[sequence];
  if(!bytes)throw new Error(`Transfer block ${sequence} is unavailable.`);
  return {sequence,binaryLength:bytes.length,crc16:Js8FileTransfer.crc16Ccitt(bytes),
    payloadBase32:Js8FileTransfer.base32Encode(bytes),bytes};
}

function clearTransferTimer() {
  scheduler.cancel("binResponse");
  binState.responseTimer=null;
}

function queueFileProtocol(record,peer,messages,onDone=null,force=false) {
  const list=Array.isArray(messages)?messages:[messages];
  list.forEach((text,index)=>binState.txQueue.push({record,peer,text,
    onSent:index===list.length-1?onDone:null,force}));
  pumpFileProtocolTx();
}

function pumpFileProtocolTx() {
  if(binState.txCurrent||!binState.txQueue.length)return;
  const task=binState.txQueue[0];
  if(task.record?.state==="paused"&&!task.force)return;
  if(!["idle","completed","aborted","fault"].includes(state.txStatus))return;
  const blocks=txBlockReasons(false,true);
  if(blocks.length){
    if(task.record&&!terminalTransferState(task.record.state)){task.record.state="paused";addTransferLog(task.record,`PAUSED ${blocks.join("; ")}`);saveTransfer(task.record);}
    return;
  }
  binState.txQueue.shift();binState.txCurrent=task;
  addTransferLog(task.record,`TX ${task.text}`);
  const js8=currentJs8(),profile=task.record?Js8FileTransfer.PROFILES[task.record.profileKey]:currentBinProfile();
  activeEncoder.setToneOffset(js8.txOffsetHz).configure({myCall:js8.myCall,toCall:task.peer,
    mode:profile.submode,clockCorrectionMs:js8.clockCorrectionMs});
  const item=queueOutgoing(Js8Protocol.formatDirectedMessage({myCall:js8.myCall,toCall:task.peer,text:task.text}));
  item.fileTransfer=true;task.outgoing=item;
  driveEncoder(activeEncoder.encode(task.text),error=>failOutgoing(item,error));
}

function finishFileProtocolTx(status) {
  const task=binState.txCurrent;if(!task)return;
  binState.txCurrent=null;
  if(status==="completed"){
    Promise.resolve(task.onSent&&task.onSent()).catch(error=>failTransfer(task.record,error));
    pumpFileProtocolTx();
    return;
  }
  if(task.record&&!terminalTransferState(task.record.state)&&task.record.state!=="paused"){
    task.record.state="paused";addTransferLog(task.record,`TX ${status}; session paused`);saveTransfer(task.record);
  }
  binState.txQueue=[];renderControls();
}

function transferTimeoutMs(record,kind) {
  if(TEST_MODE)return 3000;
  const profile=Js8FileTransfer.PROFILES[record.profileKey]||Js8FileTransfer.PROFILES.NORMAL;
  return 1000*(kind==="offer"?profile.offerTimeoutSeconds:profile.statusTimeoutSeconds);
}

function armTransferTimeout(record,kind) {
  clearTransferTimer();
  binState.responseTimer="binResponse";
  scheduler.after("binResponse",transferTimeoutMs(record,kind),()=>{
    binState.responseTimer=null;handleTransferTimeout(record,kind);});
}

function handleTransferTimeout(record,kind) {
  if(binState.active!==record||terminalTransferState(record.state)||record.state==="paused")return;
  if(kind==="offer"&&record.offerAttempts<=Js8FileTransfer.DEFAULTS.offerRetries){
    addTransferLog(record,"ACCEPT timeout; repeating OFFER");sendFileOffer(record);return;
  }
  record.statusAttempts=(record.statusAttempts||0)+1;
  if(record.statusAttempts<=Js8FileTransfer.DEFAULTS.statusRetries){
    addTransferLog(record,"Status timeout; sending QUERY");
    queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeQuery(record.id),()=>armTransferTimeout(record,"status"));
    saveTransfer(record);return;
  }
  record.state="paused";addTransferLog(record,"Timeout retry limit reached; session paused");saveTransfer(record);
}

function sendFileOffer(record) {
  record.state="waiting-accept";record.offerAttempts=(record.offerAttempts||0)+1;
  const text=Js8FileTransfer.encodeOffer({transferId:record.id,originalSize:record.originalSize,
    blockCount:record.blockCount,blockSize:record.blockSize,compression:record.compression,
    hash12:record.hash12,fileName:record.fileName});
  queueFileProtocol(record,record.peerCallsign,text,()=>{saveTransfer(record);armTransferTimeout(record,"offer");});
  saveTransfer(record);
}

function transferFrameCount(peer,text) {
  return Js8Protocol.buildReplyFrames({myCall:currentJs8().myCall,toCall:peer,text,mode:selectedMode()}).length;
}

function sendNextFileWindow(record) {
  if(record.state==="paused"||terminalTransferState(record.state))return;
  const acknowledged=new Set(record.acknowledged||[]),all=Array.from({length:record.blockCount+1},(_,index)=>index);
  let sequences=[];
  if(record.retransmitQueue?.length){sequences=record.retransmitQueue.splice(0,record.windowSize);record.retransmittedBlocks=(record.retransmittedBlocks||0)+sequences.length;}
  else sequences=all.filter(sequence=>!acknowledged.has(sequence)).slice(0,record.windowSize);
  if(!sequences.length){record.state="waiting-complete";addTransferLog(record,"All blocks acknowledged; waiting for COMPLETE");saveTransfer(record);armTransferTimeout(record,"status");return;}
  const profile=Js8FileTransfer.PROFILES[record.profileKey],dutySequences=[];let seconds=0;
  for(const sequence of sequences){
    const text=Js8FileTransfer.encodeData(record.id,encodedTransferBlock(record,sequence));
    const duration=transferFrameCount(record.peerCallsign,text)*profile.periodSeconds;
    if(dutySequences.length&&seconds+duration>Js8FileTransfer.DEFAULTS.maxContinuousTxSeconds)break;
    dutySequences.push(sequence);seconds+=duration;
  }
  sequences=dutySequences;record.lastWindow=sequences.slice();record.statusScope=Math.max(...sequences);record.state="sending";
  const messages=sequences.map(sequence=>Js8FileTransfer.encodeData(record.id,encodedTransferBlock(record,sequence)));
  messages.push(Js8FileTransfer.encodeEnd(record.id,Math.max(...sequences)));
  queueFileProtocol(record,record.peerCallsign,messages,()=>{record.state="waiting-status";record.statusAttempts=0;addTransferLog(record,"RX status window");saveTransfer(record);armTransferTimeout(record,"status");});
  saveTransfer(record);
}

function acknowledgeThrough(record,through,missing=[]) {
  const missingSet=new Set(missing),acknowledged=new Set(record.acknowledged||[]);
  for(let sequence=0;sequence<=Math.min(Number(through)||0,record.blockCount);sequence+=1)
    if(!missingSet.has(sequence))acknowledged.add(sequence);
  record.acknowledged=[...acknowledged].sort((a,b)=>a-b);
}

function failTransfer(record,error) {
  clearTransferTimer();
  if(record){record.state="failed";addTransferLog(record,`FAILED ${error.message||error}`);saveTransfer(record);}
  binState.storageError=error.message||String(error);renderControls();
}

async function prepareSelectedFile() {
  const file=dom.binFile.files&&dom.binFile.files[0];
  binState.prepared=null;binState.storageError="";
  if(!file){renderControls();return;}
  binState.preparing=true;renderControls();
  try{
    const profile=currentBinProfile();Js8FileTransfer.enforceFileLimit(file.size,profile);
    const bytes=new Uint8Array(await file.arrayBuffer());
    binState.prepared=await Js8FileTransfer.prepareBytes(bytes,{fileName:file.name,mimeType:file.type});
  }catch(error){binState.storageError=error.message;}
  finally{binState.preparing=false;renderControls();}
}

function openBinConfirmation() {
  if(!binState.prepared)return;
  let peer;try{peer=Js8FileTransfer.normalizeCallsign(binState.peerDraft);}catch(error){binState.storageError=error.message;renderControls();return;}
  const profile=currentBinProfile(),manifest=binState.prepared.manifest,estimate=Js8FileTransfer.estimateDuration(manifest.originalSize,profile);
  dom.binConfirmPeer.textContent=peer;dom.binConfirmFile.textContent=`${manifest.fileName} · ${formatBytes(manifest.originalSize)}`;
  dom.binConfirmProfile.textContent=`${profile.label} · ${profile.periodSeconds} s frames · ${profile.windowSize}-block negotiated window`;
  dom.binConfirmPlan.textContent=estimate?`${formatMinutes(estimate.optimisticMinutes)}–${formatMinutes(estimate.plannedMinutes)}, including 30% repair reserve${manifest.originalSize>=profile.warningSize?" · ABOVE RECOMMENDED SIZE; operators must remain present":""}`:"Unavailable";
  dom.binConfirmHash.textContent=manifest.sha256Hex;
  dom.binConfirmDialog.returnValue="";dom.binConfirmDialog.showModal();
}

async function copyPreparedFileHash() {
  const hash=binState.prepared?.manifest.sha256Hex;if(!hash)return;
  try{
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(hash);
    else{const input=document.createElement("textarea");input.value=hash;document.body.append(input);input.select();document.execCommand("copy");input.remove();}
    dom.binCopyHash.textContent="COPIED";setTimeout(()=>dom.binCopyHash.textContent="COPY HASH",1200);
  }catch(error){binState.storageError=`Unable to copy hash: ${error.message}`;renderControls();}
}

async function beginPreparedTransfer() {
  const prepared=binState.prepared;if(!prepared)return;
  try{
    const peer=Js8FileTransfer.normalizeCallsign(binState.peerDraft),profile=currentBinProfile();
    Js8FileTransfer.enforceFileLimit(prepared.manifest.originalSize,profile);
    const record=transferRecordFromPrepared(prepared,peer,profile);
    binState.active=record;binState.sessions.push(record);binState.prepared=null;dom.binFile.value="";
    addTransferLog(record,`CREATED ${record.fileName} ${record.originalSize}B SHA256 ${record.sha256Hex}`);
    if(!await saveTransfer(record)){record.state="failed";return;}
    sendFileOffer(record);
  }catch(error){binState.storageError=error.message;renderControls();}
}

function radioMessageEndpoints(item) {
  const prefix=String(item.text||"").slice(0,String(item.text||"").indexOf(Js8FileTransfer.PROTOCOL_PREFIX));
  const match=/^\s*([^:\s]+):\s+([^\s]+)/.exec(prefix);
  const calls=item.callsigns||[];
  return {from:String(match?.[1]||calls[0]||"").toUpperCase(),to:String(match?.[2]||calls[1]||"").toUpperCase()};
}

async function handleFileActivityMessage(item) {
  // A torso would be reported as RX INVALID and could cancel a healthy transfer; the
  // sender retries the frame anyway, so silence is the honest answer here.
  if(item.incomplete)return;
  if(!String(item.text||"").includes(Js8FileTransfer.PROTOCOL_PREFIX))return;
  let message;try{message=Js8FileTransfer.parseMessage(item.text);}catch(error){binState.lastProtocol=`RX INVALID ${error.message}`;renderControls();return;}
  if(!message)return;
  const endpoints=radioMessageEndpoints(item),own=currentJs8().myCall;
  if(!sameCall(endpoints.to,own)||sameCall(endpoints.from,own))return;
  binState.lastProtocol=`RX ${String(item.text).slice(String(item.text).indexOf("~F1"))}`;
  if(message.type==="offer"){await handleIncomingFileOffer(message,endpoints.from,item.submode,item.snr);return;}
  const record=binState.active;
  if(!record||record.id!==message.id||!sameCall(record.peerCallsign,endpoints.from))return;
  const station=state.activity.calls.find(item=>sameCall(item.call,endpoints.from));
  if(station)record.lastSnr=station.snr;
  addTransferLog(record,binState.lastProtocol);
  clearTransferTimer();
  if(record.direction==="tx")await handleOutgoingFileResponse(record,message);
  else await handleIncomingFileMessage(record,message);
  if(!await saveTransfer(record)){record.state="paused";clearTransferTimer();}
}

async function handleIncomingFileOffer(message,peer,submode,snr) {
  const active=binState.active;
  if(active&&!terminalTransferState(active.state)){
    if(active.direction==="rx"&&active.id===message.id&&sameCall(active.peerCallsign,peer)){
      const profile=Js8FileTransfer.PROFILES[active.profileKey];queueFileProtocol(active,peer,Js8FileTransfer.encodeAccept(active.id,active.windowSize,profile),null,true);
    }else queueFileProtocol(active,peer,Js8FileTransfer.encodeReject(message.id,"BUSY"),null,true);
    return;
  }
  const profile=Js8FileTransfer.profileForSubmode(submode);
  try{
    Js8FileTransfer.enforceFileLimit(message.size,profile);
    if(message.compression!=="none"||message.blockSize!==Js8FileTransfer.DEFAULTS.blockSizeBytes||message.blockCount!==Math.ceil(message.size/message.blockSize))throw new Error("Unsupported OFFER parameters.");
  }catch(_error){queueFileProtocol(null,peer,Js8FileTransfer.encodeReject(message.id,"POLICY"),null,true);return;}
  binState.incomingOffer={...message,peer,profileKey:profile.key,snr};
  dom.binIncomingPeer.textContent=peer;dom.binIncomingFile.textContent=message.fileName;
  dom.binIncomingSize.textContent=formatBytes(message.size);dom.binIncomingHash.textContent=message.hash12;
  dom.binIncomingDialog.returnValue="";dom.binIncomingDialog.showModal();
}

async function acceptIncomingFileOffer() {
  const offer=binState.incomingOffer;if(!offer)return;
  const now=Date.now(),profile=Js8FileTransfer.PROFILES[offer.profileKey];
  const record={id:offer.id,direction:"rx",peerCallsign:offer.peer,fileName:offer.fileName,
    mimeType:"application/octet-stream",originalSize:offer.size,compression:offer.compression,
    blockSize:offer.blockSize,blockCount:offer.blockCount,hash12:offer.hash12,sha256Hex:"",
    blocks:Array(offer.blockCount+1).fill(null),profileKey:profile.key,submode:profile.submode,
    windowSize:profile.windowSize,state:"receiving",retransmittedBlocks:0,createdAt:now,
    startedAt:now,updatedAt:now,lastActivityAt:now,lastSnr:offer.snr,log:[]};
  binState.active=record;binState.sessions.push(record);binState.incomingOffer=null;
  addTransferLog(record,`ACCEPTED OFFER ${record.fileName} ${record.originalSize}B`);
  if(!await saveTransfer(record)){
    record.state="failed";queueFileProtocol(null,record.peerCallsign,Js8FileTransfer.encodeReject(record.id,"STORAGE"),null,true);return;
  }
  queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeAccept(record.id,record.windowSize,profile),null,true);
}

function rejectIncomingFileOffer(reason="POLICY") {
  const offer=binState.incomingOffer;if(!offer)return;
  queueFileProtocol(null,offer.peer,Js8FileTransfer.encodeReject(offer.id,reason),null,true);
  binState.incomingOffer=null;renderControls();
}

async function handleOutgoingFileResponse(record,message) {
  if(message.type==="accept"){
    if(!message.profile||message.windowSize<1){failTransfer(record,new Error("Peer returned an invalid ACCEPT."));return;}
    record.profileKey=message.profile.key;record.submode=message.profile.submode;
    record.windowSize=Math.min(record.windowSize,message.windowSize,8);record.accepted=true;record.state="sending";record.statusAttempts=0;sendNextFileWindow(record);return;
  }
  if(message.type==="ack"){
    acknowledgeThrough(record,message.sequence);record.statusAttempts=0;sendNextFileWindow(record);return;
  }
  if(message.type==="nack"){
    const key=`${message.id}`;let parts=binState.nackParts.get(key)||{total:message.parts,values:new Map()};parts.values.set(message.part,message.sequences);binState.nackParts.set(key,parts);
    if(parts.values.size<parts.total){armTransferTimeout(record,"status");return;}
    const missing=[...parts.values.values()].flat();binState.nackParts.delete(key);
    if(missing==="ALL"||missing.includes?.("ALL")){record.acknowledged=[];record.retransmitQueue=Array.from({length:record.blockCount+1},(_,index)=>index);}
    else{acknowledgeThrough(record,record.statusScope??Math.max(...(record.lastWindow||[0])),missing);record.retransmitQueue=[...new Set(missing)].filter(sequence=>sequence>=0&&sequence<=record.blockCount);}
    sendNextFileWindow(record);return;
  }
  if(message.type==="complete"){
    if(message.hash12!==record.hash12){failTransfer(record,new Error("Peer COMPLETE hash does not match."));return;}
    record.state="complete";record.completedAt=Date.now();addTransferLog(record,"COMPLETE verified by peer");return;
  }
  if(message.type==="reject"){record.state="rejected";addTransferLog(record,`REJECTED ${message.reason}`);return;}
  if(message.type==="cancel"){record.state="cancelled";addTransferLog(record,`CANCELLED BY PEER ${message.reason}`);return;}
  if(message.type==="query"){
    if(record.state==="complete")queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeComplete(record.id,record.hash12),null,true);
    else if(record.lastWindow?.length)queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeEnd(record.id,Math.max(...record.lastWindow)),null,true);
  }
}

function expectedIncomingBlockLength(record,sequence) {
  if(sequence===0)return 32;
  if(sequence<1||sequence>record.blockCount)throw new Error("DATA sequence is outside this transfer.");
  return sequence===record.blockCount?record.originalSize-record.blockSize*(record.blockCount-1):record.blockSize;
}

function incomingMissing(record,through=record.blockCount) {
  const result=[];for(let sequence=0;sequence<=Math.min(through,record.blockCount);sequence+=1)if(!record.blocks[sequence])result.push(sequence);return result;
}

async function finishIncomingTransfer(record) {
  record.state="verifying";await saveTransfer(record);
  try{
    const result=await Js8FileTransfer.verifyReceived(record);record.sha256Hex=result.sha256Hex;
    record.fileBytes=result.bytes;record.state="complete";record.completedAt=Date.now();
    addTransferLog(record,`SHA256 OK ${result.sha256Hex}`);
    queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeComplete(record.id,result.hash12),null,true);
  }catch(error){record.state="failed";addTransferLog(record,`HASH FAILED ${error.message}`);queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeNacks(record.id,"ALL"),null,true);}
}

async function handleIncomingFileMessage(record,message) {
  if(message.type==="data"){
    try{
      const length=expectedIncomingBlockLength(record,message.sequence),bytes=Js8FileTransfer.decodeDataMessage(message,length);
      if(!record.blocks[message.sequence])record.blocks[message.sequence]=bytes;
      else addTransferLog(record,`DUPLICATE block ${message.sequence}`);
    }catch(error){addTransferLog(record,`BAD block ${message.sequence}: ${error.message}`);}
    return;
  }
  if(message.type==="end"){
    const missing=incomingMissing(record,message.sequence);
    if(missing.length){queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeNacks(record.id,missing),null,true);return;}
    queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeAck(record.id,message.sequence),()=>{if(!incomingMissing(record).length)return finishIncomingTransfer(record);},true);return;
  }
  if(message.type==="query"){
    const missing=incomingMissing(record);
    if(missing.length)queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeNacks(record.id,missing),null,true);
    else if(record.state==="complete")queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeComplete(record.id,record.hash12),null,true);
    else queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeAck(record.id,record.blockCount),()=>finishIncomingTransfer(record),true);
    return;
  }
  if(message.type==="cancel"){record.state="cancelled";addTransferLog(record,`CANCELLED BY PEER ${message.reason}`);}
}

function pauseFileTransfer() {
  const record=binState.active;if(!record||terminalTransferState(record.state))return;
  clearTransferTimer();binState.txQueue=[];record.state="paused";addTransferLog(record,"PAUSED BY OPERATOR");saveTransfer(record);
  if(binState.txCurrent)activeEncoder.abort();
}

function resumeFileTransfer() {
  const record=binState.active;if(!record||record.state!=="paused")return;
  record.state=record.direction==="rx"?"receiving":"sending";addTransferLog(record,"RESUMED BY OPERATOR");saveTransfer(record);
  if(record.direction==="tx"){
    if(!record.accepted)sendFileOffer(record);
    else queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeQuery(record.id),()=>armTransferTimeout(record,"status"));
  }else{
    const missing=incomingMissing(record);
    queueFileProtocol(record,record.peerCallsign,missing.length?Js8FileTransfer.encodeNacks(record.id,missing):Js8FileTransfer.encodeAck(record.id,record.blockCount),null,true);
  }
}

function stopFileTransfer() {
  const record=binState.active;if(!record||terminalTransferState(record.state))return;
  clearTransferTimer();binState.txQueue=[];record.state="cancelled";addTransferLog(record,"CANCELLED BY OPERATOR");saveTransfer(record);
  const sendCancel=()=>queueFileProtocol(record,record.peerCallsign,Js8FileTransfer.encodeCancel(record.id,"USER"),null,true);
  if(binState.txCurrent){const current=binState.txCurrent;current.onSent=sendCancel;activeEncoder.abort();setTimeout(sendCancel,0);}else sendCancel();
}

function downloadReceivedFile() {
  const record=binState.active;if(!record||record.direction!=="rx"||record.state!=="complete"||!record.fileBytes)return;
  const url=URL.createObjectURL(new Blob([record.fileBytes],{type:record.mimeType||"application/octet-stream"}));
  const anchor=document.createElement("a");anchor.href=url;anchor.download=record.fileName;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function restoreFileTransfers() {
  try{
    binState.sessions=await transferStore.all();
    const sorted=[...binState.sessions].sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
    const resumable=sorted.find(item=>!terminalTransferState(item.state));
    binState.active=resumable||sorted[0]||null;
    if(resumable){resumable.state="paused";addTransferLog(resumable,"RESTORED AFTER PAGE RELOAD");await saveTransfer(resumable);}
  }catch(error){binState.storageError=`Transfer restore failed: ${error.message}`;}
  binState.restored=true;renderControls();
}

// ---- radio commands and TX --------------------------------------------------

async function requestFrequency(frequency) {
  state.pendingFrequency=frequency; closeFrequencyMenu(); renderHeader();
  try {
    const response=await fetch(RADIO_CMD_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"setFrequency",frequency:String(frequency)})});
    if (!response.ok) throw new Error(`TRX request ${response.status}`);
    await ensureUsbDataMode();
    return true;
  } catch (error) { dom.modemState.textContent=error.message; dom.modemState.className="modem-state error"; state.pendingFrequency=null; renderHeader(); throw error; }
}

// Tuning a preset also prepares the radio for JS8 by switching to USB-D, but only when
// not already there. Best-effort: a failed mode set never rolls back the frequency change.
// Uses the generic civ.raw endpoint (26 00 <mode> <data> <filter>) so the firmware CAT
// code stays untouched — USB (0x01), DATA on (0x01), current FILx slot (fallback FIL1).
async function ensureUsbDataMode() {
  if (!state.radio.connected || state.radio.mode === "USB-D") return;
  const filter=[1,2,3].includes(Number(state.radio.filter)) ? Number(state.radio.filter) : 1;
  const data="26000101"+String(filter).padStart(2,"0");
  try { await fetch(RADIO_CMD_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"civ.raw",data})}); }
  catch (_error) {}
}

// Arming lives in the firmware so it survives a reload and can be revoked from
// any device on the network; this only mirrors the operator's switch to it.
// The readout is derived from the mirrored deadline rather than remembered from
// the last POST, so a window armed before this page loaded -- or from another
// device -- is shown here too, and ticks down with renderControls.
let autoStateError = "";   // last firmware refusal, kept until an arming exists
function renderAutoState() {
  if (!dom.autoState) return;
  const remaining = state.autoExpiryAt ? state.autoExpiryAt - Date.now() : 0;
  dom.autoState.textContent = autoStateError || (remaining > 0
    ? `armed, ${Math.max(1, Math.round(remaining / 60000))} min left`
    : "disarmed");
}
// The composed STATUS answer. It is the one dynamic value this station can state
// honestly: while unattended is armed we know how much longer it will keep answering
// by itself, and while it is not, the operator is the one who answers. Upstream
// derives its equivalent (the <MYIDLE> macro) from operator inactivity in the GUI --
// a measurement this page cannot make, because the browser is either closed on a
// tablet nobody is holding, or open in front of nobody at all, and both would read
// as "someone is here".
function dynamicStatusText() {
  const remainingMs = state.autoExpiryAt ? state.autoExpiryAt - Date.now() : 0;
  if (!(remainingMs > 0)) return "MONITORING";
  const hours = Math.floor(remainingMs / 3600000);
  return hours >= 1 ? `AUTO STATION ${hours}H LEFT`
    : `AUTO STATION ${Math.max(1, Math.round(remainingMs / 60000))}M LEFT`;
}

// The answer as it would go out right now -- the only value that may reach the air or
// the message box. What sits in the profile is what the operator chose, which is not
// the same thing once the composed entry is picked.
function effectiveStatusText() {
  const js8 = currentJs8();
  return js8.statusAuto === true ? dynamicStatusText() : js8.statusText;
}

// Air time is what the operator actually spends and the only cost a text field hides:
// roughly every fourteenth character buys another frame, and a frame is a whole slot.
// Memoised because renderControls runs on the 500 ms radio poll.
let statusFrameCache = {key:"", frames:0};
function statusFrameCount(text) {
  const js8 = currentJs8();
  if (!text || !js8.myCall) return 0;
  const toCall = state.selectedCall || js8.myCall;
  const mode = selectedMode();
  const key = `${text}|${js8.myCall}|${toCall}|${mode}`;
  if (statusFrameCache.key === key) return statusFrameCache.frames;
  let frames = 0;
  try {
    frames = Js8Protocol.buildReplyFrames(
      {myCall:js8.myCall, toCall, text:`STATUS ${text}`, mode}).length;
  } catch (_error) { frames = 0; }
  statusFrameCache = {key, frames};
  return frames;
}

// "Custom" is a screen state, not a stored setting: the profile holds one string and
// the menu entry is derived from it. The draft is what makes a wrong click survivable
// -- picking a preset overwrites the stored answer, so without it the hand-written one
// would be gone before the operator noticed the menu had moved. Session-only on
// purpose: an answer the operator left on a preset IS a preset, and a reload should
// not resurrect something they moved away from days ago.
let statusCustomDraft = "";
let statusCustomOpen = false;

function renderStatusAnswer(js8) {
  if (!dom.statusPreset) return;
  if (!dom.statusPreset.options.length) {
    // "No answer" leads because it is what a station that must stay silent needs, and
    // it is also what an older profile with an empty answer already means -- so that
    // profile lands on a menu entry instead of on "Custom" with nothing in the box.
    dom.statusPreset.innerHTML = ['<option value="">No answer</option>']
      .concat(Js8Settings.STATUS_PRESETS.map(text => `<option value="${text}">${text}</option>`))
      .concat([`<option value="${Js8Settings.STATUS_AUTO}">Follow the station</option>`,
        `<option value="${Js8Settings.STATUS_CUSTOM}">Custom…</option>`]).join("");
  }
  const stored = js8.statusText || "";
  // An answer that is not one of the presets can only have been typed, so a stored
  // profile lands on "Custom" by itself -- the menu needs nothing remembered for it.
  const typed = !js8.statusAuto && stored && !Js8Settings.STATUS_PRESETS.includes(stored);
  if (typed) statusCustomDraft = stored;
  const custom = !js8.statusAuto && (typed || statusCustomOpen);
  const value = js8.statusAuto === true ? Js8Settings.STATUS_AUTO
    : custom ? Js8Settings.STATUS_CUSTOM : stored;
  if (document.activeElement !== dom.statusPreset) dom.statusPreset.value = value;
  // The field appears only when it is the thing being edited: two visible copies of one
  // answer read as two settings that could disagree.
  dom.statusText.hidden = value !== Js8Settings.STATUS_CUSTOM;
  if (document.activeElement !== dom.statusText) dom.statusText.value = stored;
  const text = effectiveStatusText();
  const frames = statusFrameCount(text);
  dom.statusPreview.textContent = text
    ? `Sends: STATUS ${text}${frames ? ` · ${frames} frame${frames === 1 ? "" : "s"}` : ""}`
    : "STATUS? goes unanswered.";
}

function armUnattended(action) {
  const hours = Number(currentJs8().armHours) || 1;
  return fetch("/unattended", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({action, hours})})
    .then(response => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
    .then(result => {
      autoStateError = "";
      applyUnattendedState(result);
      console.info("[js8-unattended]", action, result.armed ? `${hours} h armed` : "disarmed");
      renderAutoState();
    })
    .catch(error => {
      // The switch stays where the operator put it; the firmware is the one that
      // did not confirm, and saying so is better than silently reverting.
      autoStateError = `firmware did not confirm (${error.message})`;
      console.warn("[js8-unattended]", action, "failed:", error.message);
      renderAutoState();
    });
}

// Mirror the firmware's arming window into the local clock so the AUTO pill can
// count down between polls without another round-trip. remainingMs is anchored
// to Date.now() at receipt; disarmed clears it so the pill shows no time.
function applyUnattendedState(result) {
  state.autoExpiryAt = result && result.armed && Number(result.remainingMs) > 0
    ? Date.now() + Number(result.remainingMs)
    : null;
  // A refusal stands until the arming it failed to create actually exists, so a
  // 5 s poll cannot wipe the only explanation the operator gets.
  if (state.autoExpiryAt) autoStateError = "";
}

// The firmware holds the arming window in RAM only, while the AUTO switch is a
// browser setting that outlives both the tab and the ESP. Left alone the two
// disagree after a restart: the pill reads AUTO on with no countdown at all,
// and the operator has to switch AUTO off and on again to get one. So re-arm on
// the two occasions where the window was *lost* rather than given up -- a page
// load (an operator is right there, opening it) and a firmware restart. A window
// that lapsed on its own, or one revoked from another device, leaves the ESP
// running and armed==false, and neither is re-armed here: a forgotten tab still
// switches itself off and a remote revoke still sticks.
function reconcileUnattended(reason) {
  if (!currentJs8().auto || state.autoExpiryAt) return;
  console.info("[js8-unattended] arming after", reason);
  return armUnattended("arm");
}

// Firmware is the source of truth for the arming window: it survives a page
// reload and can be revoked/extended from any device, so poll it to keep the
// AUTO countdown honest even when this browser did not start the timer.
let unattendedUpMs = null;   // firmware millis() at the last poll
async function pollUnattended() {
  try {
    const response = await fetch("/unattended", {cache: "no-store"});
    if (!response.ok) return;
    const result = await response.json();
    // millis() only ever climbs while the ESP runs, so a drop means it rebooted
    // (or wrapped after 49 days, which is harmless to treat the same way).
    const upMs = Number(result.upMs);
    const rebooted = unattendedUpMs !== null && Number.isFinite(upMs) && upMs < unattendedUpMs;
    if (Number.isFinite(upMs)) unattendedUpMs = upMs;
    applyUnattendedState(result);
    if (rebooted) reconcileUnattended("firmware restart");
  } catch (_error) { /* transient; the last known expiry keeps ticking */ }
}

// Routes a decoded frame to whichever engine owns it. Any traffic at all pushes
// our own beacon back, because a heartbeat landing in the middle of somebody's
// conversation is exactly what upstream warns against.
function handleDecodedFrame(decoded, {live = true} = {}) {
  if (!decoded) return;
  const now = js8Clock.now();
  if (decoded.kind === "directed" || decoded.kind === "heartbeat" || decoded.kind === "cq")
    heartbeat.noteBandActivity(now);
  if (decoded.kind === "directed") noteCqReply(decoded);
  // MSG BOX: a heartbeat, a CQ or a frame aimed at us is a station saying it is
  // here and listening -- the only moment worth spending a deferred message or a
  // mail pickup on. `live` is false for a command another station relayed to us:
  // that proves the relay is on the band, not the originator.
  if (live) {
    const mine = decoded.kind === "directed" && sameCall(decoded.to, currentJs8().myCall);
    if (decoded.kind === "heartbeat" || decoded.kind === "cq" || mine)
      noteStationAppearance(decoded.from, now);
    // A bare ACK/NACK is single-frame, so it never reaches the assembled path.
    if (mine && (decoded.command === " ACK" || decoded.command === " NACK"))
      noteMailAck(decoded.from, now, {negative: decoded.command === " NACK"});
  }
  if (decoded.kind === "heartbeat") { handleHeartbeatFrame(decoded, now); return; }
  // Single-frame queries (SNR?/GRID?/...) are answered here per frame. MSG, MSG
  // TO:, QUERY MSG/CALL and relay carry a multi-frame payload and are dispatched
  // from the assembled, checksum-verified message instead (dispatchAssembledMessage).
  handleDirectedFrame(decoded);
}

// Text-bearing commands, dispatched once the whole message is assembled and its
// checksum verified. This is where store-and-forward and relay actually act on
// real traffic -- the per-frame path only ever sees the header.
function dispatchAssembledMessage(message) {
  if (!message || !message.directed) return;
  // Never act on a reception that never ended. The CRC would refuse it anyway (the check
  // bytes ride at the very end), but relaying half of somebody else's traffic under my
  // callsign is bad enough to deserve its own guard.
  if (message.incomplete) {
    console.info("[js8-reassembly] incomplete, display only", message.directed.command);
    return;
  }
  const js8 = currentJs8();
  if (!js8.myCall) return;
  if (message.checksumOk === false) {
    console.info("[js8-reassembly] checksum failed, dropping", message.directed.command);
    return;
  }
  const now = js8Clock.now();
  // Mail somebody is holding for us is announced inside ordinary traffic --
  // "HEARTBEAT SNR -12 MSG ID 32", "YES MSG ID 7 +2" -- so the whole payload is
  // inspected before it is routed by command.
  noteMailAdvert(message.directed, message.payload, now);
  const norm = Js8Protocol.normalizeAssembledCommand(message.directed.command, message.payload);
  if (!norm) {
    // Not a command any engine owns: an ordinary message somebody typed at us.
    // It belongs in the MSG BOX, otherwise three days away means never seeing it.
    fileIncomingMessage(message.directed, message.payload, now);
    return;
  }
  if (norm.kind === "relay") handleRelayAssembled(message.directed, norm.text, now);
  else if (norm.kind === "inbox") handleInboxAssembled(message.directed, norm, now);
}

// Machine chatter carries no message: filing an SNR report as mail would bury
// the one line the operator actually has to read. Free text is command " ".
const MSGBOX_MACHINE_COMMANDS = new Set([" SNR", " HEARTBEAT SNR", " ACK", " NACK",
  " GRID", " INFO", " STATUS", " HEARING", " YES", " NO", " RR", " QSL", " 73",
  " SK", " FB", " AGN?", " DIT DIT", " HW CPY?", " QUERY", " QUERY MSGS",
  " QUERY MSGS?", " QUERY CALL", " SNR?", " GRID?", " INFO?", " STATUS?", " HEARING?"]);
function fileIncomingMessage(directed, payload, now) {
  const js8 = currentJs8();
  const text = String(payload || "").trim();
  if (!text || !js8.myCall) return;
  if (!sameCall(directed.to, js8.myCall)) return;   // group traffic is not mail
  if (MSGBOX_MACHINE_COMMANDS.has(directed.command)) return;
  if (isBlockedCall(directed.from)) return;
  const outcome = inbox.fileIncoming({from: directed.from, to: directed.to, text},
    {nowMs: now, myCall: js8.myCall});
  if (outcome.action === "store") { syncInbox(); renderInbox(); }
}

// ---- mail somebody else is holding for us ----------------------------------
// Upstream announces it ("HEARTBEAT SNR -12 MSG ID 32") and then waits for a
// human to click. A station meant to run for a week unattended cannot; if we do
// not ask, the message is never collected. So we ask -- under the same arming
// that governs every other unattended transmission, and under a hard attempt cap
// so a station whose delivery keeps failing cannot make us transmit forever.
const mailAttempts = new Js8MsgBox.AttemptLedger();   // key: "STATION|id"
const mailWaiting = new Map();                        // key -> {station, id, more, atMs}
const mailPending = new Map();                        // station -> {id, sinceMs}
const mailChain = new Map();                          // station -> {sinceMs, count}
const MSGBOX_CHAIN_MAX = 3;        // messages pulled from one station per appearance
const MSGBOX_CHAIN_WINDOW_MS = 15 * 60000;
const mailKey = (station, id) => `${String(station).toUpperCase()}|${id}`;

function noteMailAdvert(directed, payload, now) {
  const js8 = currentJs8();
  if (!js8.myCall || !sameCall(directed.to, js8.myCall)) return;
  if (isBlockedCall(directed.from)) return;
  const advert = Js8MsgBox.parseMailAdvert(payload);
  if (!advert) return;
  registerMailWaiting(directed.from, advert.id, advert.more, now);
}

function registerMailWaiting(station, id, more, now) {
  const call = String(station || "").toUpperCase();
  if (!call || !Number.isInteger(id) || id <= 0) return;
  // A directed frame packs the recipient into 28 bits, so a base callsign longer
  // than six characters cannot be addressed at all -- packDirectedHeader throws.
  // Registering a pickup we could never ask for would turn every advertisement
  // from such a station into an exception inside the decode path.
  if (!Js8Inbox.isCallsign(call)) {
    console.info("[msgbox] cannot fetch from", call, "-- callsign is not packable");
    return;
  }
  const key = mailKey(call, id);
  if (!mailWaiting.has(key))
    mailWaiting.set(key, {station: call, id, more: Number(more) || 0, atMs: now});
  renderInbox();
  fetchWaitingMail(call, now);
}

// One open mail transaction per station: an ACK and a delivery carry no message
// id, so two overlapping exchanges with the same station cannot be told apart
// (decision 12). The window is the same four periods everything else uses.
function mailTransactionOpen(station, now) {
  const open = mailPending.get(station);
  if (!open) return false;
  if (now - open.sinceMs > Js8TxQueue.resendTtlMs(selectedMode())) {
    mailPending.delete(station);
    return false;
  }
  return true;
}

function mailChainRoom(station, now) {
  const chain = mailChain.get(station);
  if (!chain || now - chain.sinceMs > MSGBOX_CHAIN_WINDOW_MS) return true;
  return chain.count < MSGBOX_CHAIN_MAX;
}
function noteMailChain(station, now) {
  const chain = mailChain.get(station);
  if (!chain || now - chain.sinceMs > MSGBOX_CHAIN_WINDOW_MS)
    mailChain.set(station, {sinceMs: now, count: 1});
  else chain.count += 1;
}

// Returns the reason it did not transmit, or "" when a fetch was queued -- the
// panel prints it, because a FETCH button that does nothing without saying why
// is the silent suppression decision 13 exists to forbid.
function fetchWaitingMail(station, now, {manual = false, probe = false} = {}) {
  const js8 = currentJs8();
  const call = String(station || "").toUpperCase();
  const waiting = [...mailWaiting.values()]
    .filter(item => item.station === call)
    .sort((left, right) => left.id - right.id);
  if (!waiting.length) return "nothing waiting";
  if (!js8.txSafetyAccepted || !activeEncoder) return "tx not enabled";
  // Collecting our own mail still means keying the transmitter unattended.
  if (!manual && js8.auto !== true) return "waiting for AUTO";
  if (mailTransactionOpen(call, now)) return "exchange in progress";
  if (!manual && !mailChainRoom(call, now)) return "three already fetched";
  const next = waiting.find(item => manual || mailAttempts.due(mailKey(call, item.id), now));
  if (!next) return waiting.some(item => mailAttempts.exhausted(mailKey(call, item.id)))
    ? "gave up after 5 tries" : "waiting for the retry window";
  if (probe) return "";   // the panel asks whether it COULD go, without sending

  const key = mailKey(call, next.id);
  mailAttempts.note(key, now);
  noteMailChain(call, now);
  mailPending.set(call, {id: next.id, sinceMs: now});
  txQueue.push({source: "msgbox", text: `QUERY MSG ${next.id}`, to: call, nowMs: now,
    submode: selectedMode(), meta: {command: "QUERY MSG", msgboxFetch: key}});
  drainTxQueue(); renderTxQueue(); renderInbox();
  return "";
}

// A delivered message arrives as "TEXT FROM <origin> NEXT MSG ID 33". The tail
// is protocol, not mail: it is turned into the next pickup and taken out of the
// text, so what the operator reads is what somebody wrote.
//
// The shape alone must not be enough to trigger this -- "GREETINGS FROM PRAGUE"
// is an ordinary sentence. It counts as a delivery only when we asked this
// station for mail, or when the tail is actually there.
function unwrapDeliveredMail(from, norm, now) {
  const text = String(norm.text || "");
  if (norm.command !== "MSG") return text;
  const call = String(from || "").toUpperCase();
  const asked = mailPending.has(call);
  if (!asked && !/NEXT MSG ID/i.test(text)) return text;
  const delivery = Js8MsgBox.parseDeliveredMail(text);
  if (!delivery) return text;
  const open = mailPending.get(call);
  if (open) clearMailWaiting(call, open.id);
  if (delivery.nextId) {
    registerMailWaiting(call, delivery.nextId, delivery.more, now);
    console.info("[msgbox] more mail waiting at", call, "id", delivery.nextId);
  }
  return `${delivery.text} FROM ${delivery.origin}`;
}

// ---- our own mail, waiting for the recipient to show up ---------------------
// A deferred message is not a slow send: it is mail parked until there is a
// reason to believe somebody is listening. The reason is narrow on purpose --
// a heartbeat, a CQ or a frame aimed at us, all of which mean "I am here and
// receiving". A station heard mid-QSO with somebody else is not an invitation.
//
// It goes out as MSG, so the recipient's station files and acknowledges it even
// with nobody at the keyboard, and that ACK is the only real proof of delivery
// the protocol can produce (decision 3).
const deferredAttempts = new Js8MsgBox.AttemptLedger();  // key: record id

function deferMessage(toCall, text) {
  const js8 = currentJs8();
  const now = js8Clock.now();
  const outcome = msgBox.defer({to: toCall, text, nowMs: now, myCall: js8.myCall});
  if (outcome.refused) return outcome.refused;
  if (isBlockedCall(toCall)) { msgBox.remove(outcome.id); return "blocked"; }
  syncInbox(); renderInbox();
  console.info("[msgbox] deferred", outcome.id, "for", outcome.to);
  return "";
}

// Called only from a live decode. Reading it from the stations table instead
// would fire a salvo at everybody who was on the band an hour ago, every reload.
// Order matters and is the agreed one: my own mail first, then a direct send,
// then what I hold for this station, and only last the roundabout way. Each step
// is gated by the one-open-transaction rule, so at most one of them transmits.
function noteStationAppearance(call, now) {
  const station = String(call || "").toUpperCase();
  if (!station || isBlockedCall(station)) return;
  if (mailWaiting.size) fetchWaitingMail(station, now);
  sendDeferredTo(station, now);
  pushHeldMailTo(station, now);
  parkDeferredVia(station, now);
}

// Stations this one is currently copying, from the same evidence the map draws
// its arrows with: a signal report, an answer that only makes sense as a
// reaction, or a HEARING list. Nothing older than the hour -- propagation moves.
function stationsHeardBy(listener, now) {
  const js8 = currentJs8();
  const links = hearingLinks(state.activity.messages || [], js8.myCall, now);
  const call = String(listener || "").toUpperCase();
  return links.filter(link => link.to === call).map(link => link.from);
}

// Mail we hold for somebody who has just shown up. Upstream waits to be asked
// with QUERY MSG -- and nobody ever asks, so the message rots in the store. This
// is the same authority QUERY MSG already needs (transmitting for a third
// party), spent at a moment we know the recipient is listening.
function pushHeldMailTo(station, now, {manual = false, probe = false} = {}) {
  const js8 = currentJs8();
  const call = String(station || "").toUpperCase();
  const held = inbox.pending(call).filter(item => !isBlockedCall(item.from));
  if (!held.length) return "nothing held";
  if (!js8.txSafetyAccepted || !activeEncoder) return "tx not enabled";
  if (!manual && js8.auto !== true) return "waiting for AUTO";
  if (mailTransactionOpen(call, now)) return "exchange in progress";
  const next = held.find(item => manual || deferredAttempts.due(`held-${item.id}`, now));
  if (!next) return "waiting for the retry window";
  if (probe) return "";

  deferredAttempts.note(`held-${next.id}`, now);
  mailPending.set(call, {id: next.id, sinceMs: now, held: true});
  txQueue.push({source: "msgbox", text: `MSG ${next.text} FROM ${next.from}`, to: call,
    nowMs: now, submode: selectedMode(),
    meta: {command: "MSG", msgboxHeldId: next.id}});
  drainTxQueue(); renderTxQueue(); renderInbox();
  return "";
}

// The station that just appeared hears somebody we are waiting for. Leaving the
// message in its inbox costs one exchange and does not need the recipient to be
// on the band at this instant -- unlike a relay hop, which needs both ends lucky
// at once (decision 4). Its ACK proves storage, and that ends the automation.
function parkDeferredVia(station, now, {manual = false, probe = false} = {}) {
  const js8 = currentJs8();
  const call = String(station || "").toUpperCase();
  const waiting = msgBox.items("waiting")
    .filter(item => (item.state || "waiting") === "waiting" && item.to !== call);
  if (!waiting.length) return "nothing waiting";
  const heard = stationsHeardBy(call, now);
  const next = waiting.find(item => heard.includes(item.to));
  if (!next) return "does not hear anybody we are waiting for";
  if (!js8.txSafetyAccepted || !activeEncoder) return "tx not enabled";
  if (!manual && js8.auto !== true) return "waiting for AUTO";
  if (mailTransactionOpen(call, now)) return "exchange in progress";
  if (!manual && !deferredAttempts.due(`via-${next.id}`, now)) return "waiting for the retry window";
  if (probe) return "";

  deferredAttempts.note(`via-${next.id}`, now);
  mailPending.set(call, {id: next.id, sinceMs: now, handoff: true});
  txQueue.push({source: "msgbox", text: `MSG TO:${next.to} ${next.text}`, to: call,
    nowMs: now, submode: selectedMode(),
    meta: {command: "MSG TO:", msgboxHandoffId: next.id}});
  drainTxQueue(); renderTxQueue(); renderInbox();
  console.info("[msgbox] parking", next.id, "for", next.to, "at", call);
  return "";
}

// Same shape as fetchWaitingMail: returns the reason it did not transmit, or ""
// when a message was queued. Silence with no reason is what decision 13 forbids.
function sendDeferredTo(station, now, {manual = false, probe = false} = {}) {
  const js8 = currentJs8();
  const call = String(station || "").toUpperCase();
  const waiting = msgBox.deferredFor(call, now);
  if (!waiting.length) return "nothing waiting";
  if (!js8.txSafetyAccepted || !activeEncoder) return "tx not enabled";
  // Transmitting mail the operator wrote days ago, with nobody watching, is
  // unattended operation whatever the content is (decision 8).
  if (!manual && js8.auto !== true) return "waiting for AUTO";
  if (mailTransactionOpen(call, now)) return "exchange in progress";
  const next = waiting.find(item => manual || deferredAttempts.due(String(item.id), now));
  if (!next) return waiting.some(item => deferredAttempts.exhausted(String(item.id)))
    ? "gave up after 5 tries" : "waiting for the retry window";
  if (probe) return "";

  deferredAttempts.note(String(next.id), now);
  msgBox.noteDeferredAttempt(next.id, now);
  mailPending.set(call, {id: next.id, sinceMs: now, deferred: true});
  txQueue.push({source: "msgbox", text: `MSG ${next.text}`, to: call, nowMs: now,
    submode: selectedMode(), meta: {command: "MSG", msgboxDeferredId: next.id}});
  drainTxQueue(); renderTxQueue(); syncInbox(); renderInbox();
  return "";
}

// ACK carries no message id -- not here, not upstream -- so it can only be read
// as "the one exchange open with this station succeeded" (decision 12). That is
// exactly why never more than one is allowed to be open.
function noteMailAck(from, now, {negative = false} = {}) {
  const call = String(from || "").toUpperCase();
  const open = mailPending.get(call);
  if (!open || (!open.deferred && !open.handoff && !open.held)) return;
  if (now - open.sinceMs > Js8TxQueue.resendTtlMs(selectedMode())) {
    mailPending.delete(call);
    return;   // too late to belong to our transmission
  }
  mailPending.delete(call);
  if (negative) {
    console.info("[msgbox] NACK from", call, "-- attempt failed");
    renderInbox();
    return;
  }
  if (open.handoff) {
    // The intermediary stored it. That is all its ACK can mean -- nobody will
    // ever tell us whether the recipient got it -- so the automation stops here
    // and the record stays visible for the operator to act on (decision 5).
    const record = msgBox.handOffDeferred(open.id, call);
    if (record) console.info("[msgbox] parked", record.id, "for", record.to, "at", call);
  } else if (open.held) {
    // The member matters for group mail: one message, delivered once to each.
    if (inbox.confirmDelivered(open.id, call)) {
      deferredAttempts.clear(`held-${open.id}`);
      console.info("[msgbox] handed over", open.id, "to", call);
    }
  } else {
    const record = msgBox.confirmDeferred(open.id);
    if (record) {
      deferredAttempts.clear(String(open.id));
      console.info("[msgbox] delivered to", call, ":", record.text);
    }
  }
  syncInbox(); renderInbox();
}

// The delivery answers the fetch. Whatever the reason it stopped waiting, the
// pointer goes: either the mail is now ours, or it was never there.
function clearMailWaiting(station, id) {
  const call = String(station || "").toUpperCase();
  mailWaiting.delete(mailKey(call, id));
  mailAttempts.clear(mailKey(call, id));
  const open = mailPending.get(call);
  if (open && open.id === id) mailPending.delete(call);
  renderInbox();
}

// Everything we answer to besides our own callsign. The always-joined pair is
// added here rather than stored, so a saved profile can never drop it.
function myGroups() {
  return [...Js8Settings.ALWAYS_GROUPS, ...(currentJs8().groups || [])];
}

// Groups the operator may actually select as a recipient: the joined ones, minus
// @ALLCALL and @HB. Those two are always joined so that we ANSWER to them, which is
// not the same as offering them as a target -- a CQ already goes to @ALLCALL by
// itself, and @HB belongs to the beacon.
function selectableGroups() {
  return (currentJs8().groups || []).slice();
}
function isMyGroup(call) {
  return Boolean(call) && selectableGroups().includes(String(call).toUpperCase());
}

// Offset for a reply triggered by a group-directed query. Null means the band left
// nothing free, in which case we key on our own offset — and say so, because that is
// the one case where members can still land on top of each other.
function groupReplyToneHz() {
  const js8=currentJs8();
  const picked=Js8Protocol.pickGroupReplyOffsetHz({
    frames:state.activity.frames, myCall:js8.myCall,
    submode:selectedMode(), nowMs:js8Clock.now()});
  if(picked===null)
    console.info("[js8-groups] no free offset, answering on",js8.txOffsetHz,"Hz");
  return picked;
}

// The palette: every name that can be joined, with the joined ones lit. One renderer for
// both places it opens from, so SETTINGS and STATIONS can never disagree about what this
// station belongs to.
function renderGroupPanel() {
  if (!dom.groupPanelGrid) return;
  const joined=selectableGroups(), builtins=joinableGroups();
  // Built-ins in their own order first; a custom name is rarer and costs more, so it reads
  // better at the end than sorted in among them.
  const names=[...builtins, ...joined.filter(group => !builtins.includes(group))];
  dom.groupPanelGrid.innerHTML=names.map(group => {
    const on=joined.includes(group);
    // A custom name costs a second frame on every message; the pill says so where the
    // decision is made, rather than leaving it to be discovered on the air.
    const mark=groupFrameCost(group)>1
      ? '<span class="group-cost" title="Custom name: two frames per message, about 15 s more air time">2×</span>' : "";
    return `<button type="button" class="group-pill" data-group="${esc(group)}"`
      + ` aria-pressed="${on}" title="${on?`Leave ${esc(group)}`:`Join ${esc(group)}`}">`
      + `${esc(group)}${mark}</button>`;
  }).join("");
  for (const button of [dom.groupsButton, dom.stationGroupsButton]) {
    if (!button) continue;
    const label=button===dom.groupsButton
      ? (joined.length?`${joined.length} joined`:"none joined") : "GROUPS";
    button.innerHTML=`${esc(label)} <span class="chevron">▾</span>`;
    button.classList.toggle("joined", joined.length>0);
    button.title=joined.length?`Joined: ${joined.join(" ")}`:"No groups joined";
  }
}

// The panel is a single node that moves to whichever control opened it: two copies would
// be two things to keep in step, and they would drift.
function toggleGroupPanel(button) {
  if (!dom.groupPanel) return;
  const host=button.closest(".group-control");
  const open=dom.groupPanel.hidden || dom.groupPanel.parentElement!==host;
  if (open) host.appendChild(dom.groupPanel);
  dom.groupPanel.hidden=!open;
  for (const other of [dom.groupsButton, dom.stationGroupsButton])
    if (other) other.setAttribute("aria-expanded", String(open && other===button));
  if (open) { renderGroupPanel(); renderGroupsHint(null); dom.groups.focus({preventScroll:true}); }
}
function closeGroupPanel() {
  if (!dom.groupPanel || dom.groupPanel.hidden) return;
  dom.groupPanel.hidden=true;
  for (const button of [dom.groupsButton, dom.stationGroupsButton])
    if (button) button.setAttribute("aria-expanded","false");
}

// Joining from the palette. Leaving is the same click again, which is why a pill is a
// toggle rather than a name with a separate × to hunt for.
function joinGroup(group) {
  const added=Js8Settings.validateGroups(group);
  const merged=Js8Settings.validateGroups([...selectableGroups(), ...added.groups]);
  setJs8Setting("groups", merged.groups);
  renderGroupsHint({rejected:[...added.rejected, ...merged.rejected]});
  renderGroupPanel(); renderActivity(); renderControls();
}

// Joined groups sit under the stations, the way upstream lists them under the callsigns.
// They are targets, not stations, so every column that describes a received signal stays
// a dash: a group has never transmitted anything and never will.
function groupRowsHtml() {
  // A flag where upstream puts one: mail is held here for this net and any member may
  // come for it.
  const held=new Set(inbox.snapshot().items
    .filter(item=>item.type==="STORE"&&String(item.to||"").startsWith("@"))
    .map(item=>item.to));
  // No leave button on the row: the palette above the table does that job better, and a
  // second way to leave next to a row whose only other click SELECTS the group is a way
  // to leave one by accident.
  return selectableGroups().sort().map(group =>
    `<tr data-call="${esc(group)}" class="station-group${group===state.selectedCall?" selected":""}">`
    + `<td class="call">${held.has(group)?'<span class="group-mail" title="Mail is held here for this group">⚑</span> ':""}`
    + `${esc(group)}</td><td class="station-country">group</td>`
    + `<td>—</td><td>—</td><td>—</td><td class="station-direction">—</td><td>—</td></tr>`).join("");
}

// Leaving a group from the row it is displayed on. The settings field stays the source
// of truth, but nobody goes looking for it there while staring at the stations table —
// which is exactly how a joined group became something you could add and not remove.
function leaveGroup(group) {
  const name=String(group||"").toUpperCase();
  setJs8Setting("groups",selectableGroups().filter(item=>item!==name));
  if(state.selectedCall===name){state.selectedCall="";binState.peerDraft="";persistSession();}
  renderGroupsHint(null);
  renderGroupPanel(); renderActivity(); renderControls();
}

// The built-in group names. Since stage 2 these are a SUGGESTION, not the limit: any
// well-formed name can be joined and transmitted to. They are still worth offering first,
// because they are the ones that fit a single frame.
function joinableGroups() {
  return Js8Protocol.SPECIAL_CALLS.filter(call => call.startsWith("@")
    && !Js8Settings.RESERVED_GROUPS.includes(call)
    && !Js8Settings.ALWAYS_GROUPS.includes(call));
}
// One frame or two. A name outside the built-in table does not fit the 28-bit callsign
// field, so every message to it carries a compound pair instead — one extra slot, about
// 15 s on Normal.
function groupFrameCost(group) {
  return Js8Protocol.needsCompoundTo(group) ? 2 : 1;
}

// Says what happened to what the operator typed. Silence used to be the answer to a
// refused group, which is how a station could believe it was in @ARESGA while every
// frame for that group went past it unread.
function renderGroupsHint(result) {
  if (!dom.groupsHint) return;
  const joined = selectableGroups();
  const refused = result && result.rejected.length ? result.rejected : [];
  const parts = refused.map(item => `${item.value} refused — ${item.reason}.`);
  // Says how to USE a joined group; removing it is the × on the chip and on its row, so
  // it does not need spelling out twice.
  parts.push(joined.length
    ? "Click a group under STATIONS to send to it."
    : "Type any @NAME, or start with @ for the built-in list — those fit one transmission, a custom name costs two.");
  parts.push("@ALLCALL and @HB are always joined.");
  dom.groupsHint.textContent = parts.join(" ");
  dom.groupsHint.classList.toggle("groups-refused", refused.length > 0);
  // A refusal outlives the next render on purpose: renderControls() runs on every
  // decode, so a message cleared by the next frame would be a message nobody reads.
  // It goes away when the operator edits the field again, not before.
  if (refused.length) dom.groupsHint.dataset.refused = "1";
  else delete dom.groupsHint.dataset.refused;
}

// MSG BOX. Durable and read from any device: the operator needs to see mail that
// arrived while nobody was here, what the station is holding for others, and be
// able to pull mail from another station by hand.
const MSGBOX_STATE_LABEL = {UNREAD: "new", READ: "read", STORE: "held",
  DELIVERED: "sent", DEFERRED: "waiting", EXPIRED: "expired"};
let msgBoxFilter = "all";
let msgBoxUndo = null, msgBoxUndoTimer = 0;
const MSGBOX_BASE_TITLE = typeof document === "object" ? document.title : "";

// Unread mail is the one thing on this page that has to be noticeable from a tab
// the operator is not looking at, so the count rides in the title as well.
function renderMsgBoxTitle(unread) {
  if (typeof document !== "object") return;
  document.title = unread > 0 ? `(${unread}) ${MSGBOX_BASE_TITLE}` : MSGBOX_BASE_TITLE;
}

function renderInbox() {
  if (!dom.inboxRows) return;
  // Hide messages to/from a blocked DXCC entity, like everywhere else in JS8LAN.
  const visible = item => !isBlockedCall(item.from) && !isBlockedCall(item.to);
  const all = msgBox.items("all").filter(visible);
  const items = msgBox.items(msgBoxFilter).filter(visible);
  const unread = all.filter(item => item.type === "UNREAD").length;
  const waiting = all.filter(item =>
    item.type === "DEFERRED" && (item.state || "waiting") === "waiting").length;
  const held = all.filter(item => item.type === "STORE").length;

  const parts = [];
  if (unread) parts.push(`<strong class="msgbox-new">${unread} NEW</strong>`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (held) parts.push(`${held} held`);
  if (msgBoxFull) parts.push('<strong class="msgbox-full">FULL</strong>');
  dom.inboxSummary.innerHTML = parts.length ? parts.join(" · ") : "empty";
  renderMsgBoxTitle(unread);

  // Mail another station says it holds for us. Not messages yet -- pointers --
  // so they are rows of their own, above the mail we actually have.
  const pickups = (msgBoxFilter === "all" || msgBoxFilter === "mine")
    ? [...mailWaiting.values()].filter(item => !isBlockedCall(item.station))
      .sort((left, right) => left.atMs - right.atMs)
    : [];
  const pickupRows = pickups.map(item => {
    const key = mailKey(item.station, item.id);
    const gaveUp = mailAttempts.exhausted(key);
    const more = item.more ? ` +${item.more}` : "";
    return `<tr class="msgbox-row msgbox-pickup" data-pickup-key="${esc(key)}">` +
      `<td>${item.id}</td>` +
      `<td class="msgbox-state">${gaveUp ? "gave up" : "at station"}</td>` +
      `<td class="call" data-call="${esc(item.station)}">${esc(item.station)}</td>` +
      `<td class="inbox-text">Mail waiting at ${esc(item.station)}${more}</td>` +
      `<td>${age(item.atMs)}</td>` +
      `<td class="msgbox-actions"><button type="button" data-msg-action="fetch">FETCH</button>` +
      `<button type="button" data-msg-action="forget">DEL</button></td></tr>`;
  }).join("");

  dom.inboxRows.innerHTML = pickupRows + (items.length
    ? items.map(item => {
        const type = item.type || "STORE";
        const mine = type === "UNREAD" || type === "READ";
        // The other station: whoever wrote to me, or whoever the message is for.
        const peer = mine ? item.from : item.to;
        const label = type === "DEFERRED"
          ? (item.state === "handed" ? `via ${esc(item.via || "?")}`
            : item.state === "attention" ? "attention" : "waiting")
          : MSGBOX_STATE_LABEL[type] || type.toLowerCase();
        return `<tr class="msgbox-row msgbox-${type.toLowerCase()}" data-msg-id="${item.id}">` +
          `<td>${item.id}</td>` +
          `<td class="msgbox-state">${label}</td>` +
          `<td class="call" data-call="${esc(peer)}">${esc(peer)}</td>` +
          `<td class="inbox-text">${esc(item.text)}</td>` +
          `<td>${age(item.atMs)}</td>` +
          `<td class="msgbox-actions">` +
            (mine ? `<button type="button" data-msg-action="reply" title="Answer ${esc(item.from)}">REPLY</button>` : "") +
            (type === "DEFERRED" ? `<button type="button" data-msg-action="sendnow" title="Send it now instead of waiting for ${esc(item.to)} to show up">SEND NOW</button>` : "") +
            `<button type="button" data-msg-action="delete" title="Delete this message">DEL</button>` +
          `</td></tr>`;
      }).join("")
    : (pickupRows ? "" : `<tr><td colspan="6" class="inbox-empty">${
        msgBoxFilter === "all" ? "No messages." : "Nothing under this filter."}</td></tr>`));

  // Why a fetch is not happening, in the panel rather than the console.
  if (dom.inboxHint) {
    const blocked = pickups.length ? fetchWaitingMail(pickups[0].station, js8Clock.now(),
      {probe: true}) : "";
    dom.inboxHint.textContent = blocked && blocked !== "nothing waiting"
      ? `Mail waiting: ${blocked}.` : "";
    dom.inboxHint.hidden = !dom.inboxHint.textContent;
  }
  if (dom.inboxFilters) for (const button of dom.inboxFilters.querySelectorAll("[data-msgbox-filter]"))
    button.setAttribute("aria-pressed", String(button.dataset.msgboxFilter === msgBoxFilter));
  if (dom.inboxUndo) dom.inboxUndo.hidden = !msgBoxUndo;
  if (dom.inboxQueryMsgs)
    dom.inboxQueryMsgs.disabled = !state.selectedCall || !currentJs8().txSafetyAccepted || !activeEncoder;
}

// Reading is confirmed by a click, never by the section being open: a box that
// marks everything read the moment it scrolls past is a box that loses messages.
function markMsgRead(id) {
  if (!msgBox.markRead(id)) return;
  syncInbox(); renderInbox();
}

// Deletion is undoable instead of confirmed. The window is short on purpose --
// long enough to catch the wrong row, short enough that the record does not
// linger outside the store while mail keeps arriving.
const MSGBOX_UNDO_MS = 10000;
function deleteMsg(id) {
  const record = msgBox.remove(id);
  if (!record) return;
  msgBoxUndo = record;
  if (msgBoxUndoTimer) clearTimeout(msgBoxUndoTimer);
  msgBoxUndoTimer = setTimeout(() => { msgBoxUndo = null; msgBoxUndoTimer = 0; renderInbox(); },
    MSGBOX_UNDO_MS);
  syncInbox(); renderInbox();
}
function undoDeleteMsg() {
  if (!msgBoxUndo) return;
  msgBox.restore(msgBoxUndo);
  msgBoxUndo = null;
  if (msgBoxUndoTimer) { clearTimeout(msgBoxUndoTimer); msgBoxUndoTimer = 0; }
  syncInbox(); renderInbox();
}

// Ask the selected station whether it holds mail for us. Its answer
// (YES MSG ID <id> or NO) comes back through the normal decode path.
// Repeat CQ on an interval until somebody replies. Purely operator-driven and
// independent of unattended mode: calling CQ is not answering queries.
let lastCqMs = 0, cqPreviousMs = 0, cqRetryPending = false;
function renderCqState() {
  if (!dom.cqState) return;
  const min = Number(currentJs8().cqRepeatMin) || 0;
  dom.cqState.textContent = min ? `every ${min} min` : "off";
}
function checkCqRepeat() {
  const js8 = currentJs8();
  const min = Number(js8.cqRepeatMin) || 0;
  if (!min || !js8.txSafetyAccepted || !activeEncoder) return;
  // The whole gate, not just a free TX state: calling into a link that is down would
  // burn the interval on a transmission that never leaves the browser.
  if (txBlockReasons(false).length) return;
  const now = js8Clock.now();
  if (now - lastCqMs < min * 60000) return;
  cqPreviousMs = lastCqMs;
  lastCqMs = now;
  beginOutgoing({kind:"cq",cq:cqType("CQ CQ CQ"),to:"",text:"CQ CQ CQ",
    sourceText:"CQ CQ CQ",meta:{cqAuto:true},source:"operator"});
}
// The schedule moves BEFORE the send, so without rolling it back a single lost packet
// silences the station for the whole cqRepeatMin interval -- ten minutes of nothing for
// one dropped frame. Rolled back once per interval, which is the same "exactly one more
// attempt" every other source gets from the queue.
function noteCqFault() {
  if (cqRetryPending) return;
  cqRetryPending = true;
  lastCqMs = cqPreviousMs;
}
// A directed message to us means somebody answered; stop calling into a QSO.
function noteCqReply(decoded) {
  if (decoded && decoded.to === currentJs8().myCall) lastCqMs = js8Clock.now();
}

function queryStoredMessages() {
  if (!state.selectedCall || !currentJs8().txSafetyAccepted || !activeEncoder) return;
  txQueue.push({source: "operator", text: "QUERY MSGS", to: state.selectedCall,
    nowMs: js8Clock.now(), meta: {command: "QUERY MSGS"}});
  drainTxQueue(); renderTxQueue();
}

// Multi-frame checksummed commands (MSG, MSG TO:, QUERY MSG/CALL, relay) are
// dispatched from the assembled message once the ActivityStore has verified the
// CRC (dispatchAssembledMessage); the per-frame path only handles single-frame
// queries.

// Store-and-forward. Accepting mail costs no airtime and works while disarmed;
// handing somebody else's message over is transmitting for a third party and
// needs unattended mode, exactly like a relay hop.
function handleInboxAssembled(directed, norm, now) {
  const js8 = currentJs8();
  if (!js8.myCall) return;
  // Only stations decoded here may be offered as heard -- a callsign we merely saw named
  // in someone else's frame must never be relayed on air as one we copy.
  const heard = (state.activity.calls || []).filter(item => item && item.call && item.heardDirectly !== false);
  const text = unwrapDeliveredMail(directed.from, norm, now);
  const outcome = inbox.handle(
    {from: directed.from, to: directed.to, command: norm.command,
     text, complete: true},
    // Groups make a command addressed to @NET as much ours as one addressed to our
    // callsign; the inbox needs the list to tell that from somebody else's net.
    {nowMs: now, myCall: js8.myCall, groups: myGroups(), armed: js8.auto === true,
     hearing: heard});

  if (outcome.action === "skip") {
    if (outcome.nack && js8.txSafetyAccepted && activeEncoder) {
      txQueue.push({source: "inbox", text: outcome.nack.text, to: outcome.nack.to,
        nowMs: now, meta: {command: "NACK"}});
      drainTxQueue(); renderTxQueue();
    }
    return;
  }
  syncInbox();
  const send = outcome.ack || (outcome.action === "reply" || outcome.action === "deliver"
    ? {to: outcome.to, text: outcome.text} : null);
  if (!send) return;
  if (!js8.txSafetyAccepted || !activeEncoder) {
    console.info("[js8-inbox] cannot answer: tx-not-enabled");
    return;
  }
  txQueue.push({source: "inbox", text: send.text, to: send.to, nowMs: now,
    meta: {command: norm.command, inboxDeliveryId: outcome.deliveryId || null}});
  drainTxQueue(); renderTxQueue();
}

// Relay is the only path where we transmit text somebody else wrote, so every
// forward is logged and every refusal names the limit it hit.
function handleRelayAssembled(directed, relayText, now) {
  const js8 = currentJs8();
  if (!js8.myCall) return;
  if (isBlockedCall(directed.from)) {
    console.info("[js8-relay] skip: blocked", directed.from);
    return;
  }
  const outcome = relay.handle(
    {from: directed.from, to: directed.to, text: relayText, complete: true},
    {nowMs: now, myCall: js8.myCall, armed: js8.auto === true});

  if (outcome.action === "deliver") {
    // If the relayed payload is itself a directed command, act on it and answer
    // the originator, rather than only filing the text.
    const relayed = parseRelayedCommand(outcome.text, directed.from);
    // Not a live appearance: the relay is on the band, the originator may not be.
    if (relayed) { handleDecodedFrame(relayed, {live: false}); return; }
    // Mail for us arrives regardless of unattended mode; only the ACK needs a
    // working transmitter.
    appendRelayMessage(directed.from, outcome.text);
    // A relayed message is somebody writing to us the hard way -- it belongs in
    // the MSG BOX for exactly the same reason a direct one does.
    fileIncomingMessage({from: directed.from, to: js8.myCall, command: " "},
      outcome.text, now);
    if (js8.txSafetyAccepted && activeEncoder && outcome.ack) {
      txQueue.push({source: "relay", text: outcome.ack.text, to: outcome.ack.to,
        nowMs: now, meta: {command: "ACK"}});
      drainTxQueue(); renderTxQueue();
    }
    return;
  }
  if (outcome.action !== "forward") return;
  if (!js8.txSafetyAccepted || !activeEncoder) {
    console.info("[js8-relay] cannot forward: tx-not-enabled");
    return;
  }
  txQueue.push({source: "relay", text: outcome.text, to: outcome.to,
    nowMs: now, meta: {command: ">", origin: outcome.origin}});
  drainTxQueue(); renderTxQueue();
}

// A relayed message may carry a directed command for us, e.g. the chain
// "OK1HRA>SNR?" delivers "SNR? DE K0OG". Recognise a leading command token and
// turn it back into a directed frame addressed to us from the true originator
// (the DE callsign), so the normal engines answer it via the relay reply.
const RELAYED_COMMANDS = [" SNR?", " GRID?", " INFO?", " STATUS?", " HEARING?",
  " AGN?", " MSG", " MSG TO:", " QUERY MSGS", " QUERY MSG", " QUERY CALL"];
function parseRelayedCommand(text, fallbackFrom) {
  const clean = String(text || "").trim();
  const deMatch = /\bDE\s+([A-Z0-9/]+)\s*$/i.exec(clean);
  const origin = deMatch ? deMatch[1].toUpperCase() : fallbackFrom;
  const body = deMatch ? clean.slice(0, deMatch.index).trim() : clean;
  for (const command of RELAYED_COMMANDS) {
    const token = command.trim();
    if (body === token || body.startsWith(token + " ")) {
      return {kind: "directed", from: origin, to: currentJs8().myCall,
        command, text: body.slice(token.length).trim(), viaRelay: true};
    }
  }
  return null;
}

// A relayed message that reached its destination belongs in the conversation,
// not only in the console.
function appendRelayMessage(from, text) {
  const item = {direction: "incoming", time: new Date().toISOString().slice(11, 19),
    text: `${from}: ${text}`, status: "relayed"};
  if (!state.conversations[from]) state.conversations[from] = [];
  state.conversations[from].push(item);
  renderConversation();
  persistSession();
}

// A multi-frame channel is only closed when its final frame arrives; a lost last
// frame (routine on HF) otherwise strands it in the reassembly map forever. Only
// a channel still being fed -- one that advanced within the last couple of slots
// -- means a message is genuinely arriving. Without this, one stranded partial
// would latch messageBusy true and suppress every future HB ACK.
const REASSEMBLY_ACTIVE_MS = 90000;   // longest HB slot (Slow, 30 s) plus margin
function hasActiveReassembly(nowMs) {
  return (state.activity.channels || []).some(channel =>
    nowMs - Number(channel.lastSlotUtcMs || 0) < REASSEMBLY_ACTIVE_MS);
}

// "HB ACK" is the behaviour name; the compatible wire command is HEARTBEAT SNR.
// It is gated by the same restriction engine as everything else, with the long
// 55 minute window upstream uses for exactly this.
function handleHeartbeatFrame(decoded, now) {
  const js8 = currentJs8();
  if (!js8.myCall) return;
  if (isBlockedCall(decoded.from)) {
    console.info("[js8-heartbeat] skip: blocked", decoded.from);
    return;
  }
  const station = state.activity.calls.find(item => item.call === decoded.from);
  const outcome = heartbeat.handleHeartbeat(
    {from: decoded.from, snr: station ? station.snr : 0},
    {nowMs: now, myCall: js8.myCall, armed: js8.auto === true,
     submode: selectedMode(),
     messageBusy: hasActiveReassembly(now),
     // If we are holding mail for this station, the beacon advertises it.
     pendingMsgId: call => { const waiting = inbox.pending(call); return waiting.length ? waiting[0].id : null; }});
  if (outcome.action !== "ack") {
    console.info("[js8-heartbeat] no ack:", outcome.reason, outcome.detail || "", decoded.from);
    return;
  }
  if (!js8.txSafetyAccepted || !activeEncoder) return;
  txQueue.push({source: "autoreply", text: outcome.text, to: outcome.to,
    nowMs: now, submode: selectedMode(), meta: {command: "HEARTBEAT"}});
  drainTxQueue(); renderTxQueue();
}

// Fires when the beacon is due. Nothing is queued: a heartbeat that could not go
// out now is simply rescheduled, so beacons never stack up.
function checkHeartbeat() {
  const js8 = currentJs8();
  const verdict = heartbeat.evaluate({nowMs: js8Clock.now(), submode: selectedMode(),
    txBusy: !["idle", "completed", "aborted", "fault"].includes(state.txStatus),
    armed: js8.auto === true, myCall: js8.myCall});
  if (!verdict.send) return;
  if (!js8.txSafetyAccepted || !activeEncoder) return;
  // Mark it sent up front so a second checkHeartbeat tick cannot fire a duplicate
  // beacon. If the TX then faults, updateOutgoingTxProgress calls heartbeat.noteFault
  // to pull the retry back to the next quiet frame instead of a whole interval.
  heartbeat.noteSent(js8Clock.now());
  startHeartbeat(verdict.offsetHz, true);
}

// Feeds decoded directed frames to the auto-reply engine. Any directed frame --
// ours or not -- arms the QSO lock, so the station does not talk over a
// conversation already in progress.
function handleDirectedFrame(decoded) {
  if (!decoded || decoded.kind !== "directed") return;
  const now = js8Clock.now();
  const js8 = currentJs8();
  if (!js8.myCall) { autoReply.noteDirectedFrame(now); return; }
  // Never answer a blocked DXCC entity, even automatically. Still arm the QSO lock
  // so we don't talk over the frequency, and log the reason (decision 13).
  const blockedCountry = blockedCountryForCall(decoded.from);
  if (blockedCountry) {
    console.info("[js8-autoreply] skip: blocked", blockedCountry, decoded.from);
    autoReply.noteDirectedFrame(now);
    return;
  }
  const station = state.activity.calls.find(item => item.call === decoded.from);
  // A HEARING answer must list only stations actually decoded here, never one we were
  // just told about (heardDirectly === false).
  const heard = (state.activity.calls || [])
    .filter(item => item.call && item.call !== js8.myCall && item.heardDirectly !== false)
    .sort((a, b) => (b.lastSlotUtcMs || 0) - (a.lastSlotUtcMs || 0))
    .map(item => item.call);

  const outcome = autoReply.handle(
    {from: decoded.from, to: decoded.to, command: decoded.command,
     snr: station ? station.snr : 0, complete: true},
    // selectedCall drives the QSO-lock window, which is about the station we are
    // working. A selected group is not a station, so it must not shorten that window
    // for whoever happens to be asking.
    {nowMs: now, myCall: js8.myCall, groups: myGroups(),
     selectedCall: isMyGroup(state.selectedCall) ? "" : state.selectedCall,
     auto: js8.auto === true, grid: js8.grid, infoText: js8.infoText,
     // The composed answer is built here rather than inside the reply engine, which is
     // deliberately a pure decision layer: it has no clock and no station state of its
     // own. Composing first also keeps the "needs" refusal honest -- an answer that
     // comes out empty is refused instead of being transmitted as a bare STATUS.
     statusText: effectiveStatusText(), hearing: heard});
  autoReply.noteDirectedFrame(now);

  if (outcome.action === "buffer") {
    // AUTO off: hand the answer to the operator instead of transmitting it.
    dom.message.value = `${outcome.to} ${outcome.text}`;
    renderControls(); persistSession();
    return;
  }
  if (outcome.action !== "reply") return;

  if (!js8.txSafetyAccepted || !activeEncoder) {
    console.info("[js8-autoreply] skip: tx-not-enabled", outcome.to, outcome.command);
    return;
  }
  // Queue rather than transmit directly: the radio may be mid-transfer. The
  // entry carries the current submode so it expires after two of its periods —
  // an SNR report that waited out a ten minute file transfer is worthless.
  // A query addressed to a group is answered by every member in the same slot, so this
  // one moves off our own offset. See docs/js8-skupiny-implementace.md, decisions 4-6.
  const groupTone = isMyGroup(decoded.to) ? groupReplyToneHz() : null;
  txQueue.push({source: "autoreply", text: outcome.text,
    to: outcome.to, nowMs: now, submode: selectedMode(),
    meta: groupTone === null ? {command: outcome.command}
                             : {command: outcome.command, toneHz: groupTone}});
  drainTxQueue();
  renderTxQueue();
}

// Sends the highest-priority entry that is still worth sending. Called when a
// transmission finishes and on a slow tick, so expiries are noticed (and logged)
// even while the station is idle.
// Shows what is waiting and why it has not gone out yet. A queue that silently
// holds an answer looks identical to a station that decided not to answer, and
// decision 13 does not allow that ambiguity.
function renderTxQueue() {
  if (!dom.txQueueState) return;
  const now = js8Clock.now();
  const snapshot = txQueue.snapshot(now);
  if (!snapshot.size) { dom.txQueueState.hidden = true; return; }
  const busy = !["idle", "completed", "aborted", "fault"].includes(state.txStatus);
  const next = snapshot.items[0];
  const expiry = next.inMs === null ? "" :
    ` · drops in ${Math.max(0, Math.round(next.inMs / 1000))} s`;
  dom.txQueueState.textContent =
    `${snapshot.size} queued · ${busy ? "waiting for TX to finish" : "sending next"}${expiry}`;
  dom.txQueueState.title = snapshot.items
    .map(item => `${item.source}${item.to ? ` → ${item.to}` : ""}: ${item.text}`).join("\n");
  dom.txQueueState.hidden = false;
}

function drainTxQueue() {
  const now = js8Clock.now();
  if (!activeEncoder || !currentJs8().txSafetyAccepted) { txQueue.prune(now); return; }
  // The real precondition for keying is the whole gate -- LAN up, TRX in USB, timebase
  // locked, PTT free -- not merely a free TX state. Without it the queue fires into a
  // link that is down, which for a retry means spending its one attempt on nothing.
  if (txBlockReasons(false).length) { txQueue.prune(now); return; }
  const entry = txQueue.take(now);
  if (!entry) return;
  // Last line of defence: nothing addressed to a blocked entity leaves the queue,
  // regardless of which decision layer enqueued it.
  if (entry.to && isBlockedCall(entry.to)) {
    console.info("[js8-txqueue] drop: blocked recipient", entry.to);
    return;
  }
  // A repeat attaches to the row it came from instead of opening a new one.
  if (entry.meta && entry.meta.resendItem) { releaseTxRetry(entry.meta.resendItem, entry); return; }
  if (entry.to) autoReply.noteSent(entry.to, entry.text);
  if (entry.to) startTxTo(entry.to, entry.text, entry.meta, entry.text, entry.source);
  else startTx(entry.text, entry.source);
}

function stopTxTicking() {
  scheduler.cancel("tx");
  setMasterTick(TICK_IDLE_MS);
}

function driveEncoder(prepared, onError) {
  Promise.resolve(prepared).then(()=>{
    scheduler.every("tx", TICK_TX_MS, now=>activeEncoder.tick(now), {startDelayMs:0});
    setMasterTick(TICK_TX_MS);
    activeEncoder.tick(js8Clock.now());
  }).catch(onError);
}

// ---- Failed transmissions: RESEND and one automatic retry -------------------
// docs/js8-tx-resend-plan.md. "Failed" here is always LOCAL — JS8 has no delivery ACK,
// so the only thing we can ever know is whether the frames reached the antenna. Every
// rule below is one line drawn twice: a machine may repeat a transmission only where a
// repeat cannot do harm, and a human may repeat anything as long as the row tells the
// truth about what already went out.

// Whitelist of transport failures. Anything unlisted counts as permanent: it keeps the
// button (the operator may have fixed the cause) but never earns an automatic attempt,
// because a failure that repeats identically only produces a second grey row.
const TX_RETRYABLE_REASONS=["tx-ready timeout","ptt confirmation timeout",
  "prebuffer missed slot","packet pacing missed","audio incomplete",
  "sink did not become ready","websocket lost","websocket is not open",
  "hello not received","ring overflow"];
const TX_MAX_ATTEMPTS=2;   // the original send plus exactly one machine retry

// `drain watchdog` is not the same kind of failure. Draining starts only after the slot
// plus the whole audio length, every packet was written and PTT is already down, so the
// frame almost certainly radiated and only the tx-drained answer was lost. Repeating it
// would key the radio twice for one message, which is why it gets its own state and no
// automatic attempt — that call belongs to a human.
function txOutcome(status,reason){
  const text=String(reason||"").toLowerCase();
  if(status==="completed")return "completed";
  if(text.includes("drain watchdog"))return "unconfirmed";
  if(status==="aborted")return text.includes("websocket lost")?"retryable":"operator";
  return TX_RETRYABLE_REASONS.some(entry=>text.includes(entry))?"retryable":"permanent";
}

// Which rows offer the button. An operator STOP is a decision, not a failure; the BIN
// protocol repeats its own blocks and a hand-sent duplicate would desync the sequence;
// a missed beacon is not worth resending because the next one is already due.
function txResendable(item){
  if(!item||!item.recipe||!item.id)return false;
  if(item.fileTransfer||item.recipe.kind==="heartbeat")return false;
  if(item.outcome==="operator")return false;
  return ["fault","aborted","interrupted","unconfirmed","expired"].includes(item.status);
}

function resendTitle(item){
  const band=Number(item.frequencyHz)||0, tuned=Number(state.activityFrequency)||0;
  const detail=item.txError?` (${item.txError})`:"";
  return onTunedBand(band,tuned) ? `Send this message again${detail}`
    : `Sent on ${formatFrequency(band)} — resending will transmit on the current frequency${detail}`;
}

// One place decides what a badly finished transmission earns, so the two fault paths --
// an encoder rejection before the air and a TxController fault during it -- cannot
// disagree about the same failure.
function noteTxOutcome(item,status,reason){
  const outcome=txOutcome(status,reason);
  item.txError=String(reason||"");
  item.outcome=outcome;
  if(outcome==="unconfirmed")item.status="unconfirmed";
  if(outcome!=="retryable")return;
  // Periodic traffic never queues a repeat: it moves its own schedule back instead, so
  // a lost packet costs one interval's silence rather than stacking beacons.
  const kind=item.recipe&&item.recipe.kind;
  if(kind==="heartbeat"){
    if(item.txMeta&&item.txMeta.heartbeatAuto)heartbeat.noteFault(js8Clock.now());
    return;
  }
  if(kind==="cq"){ if(item.txMeta&&item.txMeta.cqAuto)noteCqFault(); return; }
  if(item.fileTransfer)return;
  if(item.manualResend)return;   // a hand-sent copy puts the human back in the loop
  if((Number(item.attempts)||1)>=TX_MAX_ATTEMPTS)return;
  armTxRetry(item);
}

// Armed, not fired. After a WebSocket loss `hello` is null and the next prepare() is
// rejected within milliseconds, so an immediate retry would spend the single attempt on
// a link that is still down. drainTxQueue() releases it once the gate is open again.
function armTxRetry(item){
  if(item.retryQueueId)return;   // a terminal state may be reported more than once
  const now=js8Clock.now();
  const source=(item.recipe&&item.recipe.source)||"operator";
  // relay/inbox are store-and-forward and keep their own 30 min: a message for an absent
  // station does not go stale. Everything else is live dialogue and is worth nothing a
  // few slots later.
  const ttlMs=["relay","inbox"].includes(source)?undefined:Js8TxQueue.resendTtlMs(selectedMode());
  const queued=txQueue.push({source,text:item.text,to:(item.recipe&&item.recipe.to)||"",
    nowMs:now,submode:selectedMode(),ttlMs,
    meta:{...(item.recipe&&item.recipe.meta||{}),resendItem:item}});
  if(!queued.queued)return;
  item.retryQueueId=queued.id;
  item.retryUntilMs=ttlMs===undefined?0:now+ttlMs;
  renderActivity();
}

// Two gates the queue cannot check for us, tested at the moment of firing rather than
// when the entry was made -- minutes may pass in between.
function releaseTxRetry(item,entry){
  const tuned=Number(state.activityFrequency)||Number(state.radio.frequency)||0;
  // A machine never moves a message to another band: it has no way of knowing that the
  // station, or the message, still means anything there. A human may -- calling the same
  // station on another band is ordinary operating -- so the check is on the ENTRY, not on
  // the row: a hand-pressed resend carries its own permission and later automatic
  // attempts at the same row are still refused.
  if(!entry.meta?.manualResend&&!onTunedBand(item.frequencyHz,tuned))
    return expireTxRetry(item,`band changed to ${formatFrequency(tuned)}`);
  // Auto replies, relay hops and inbox deliveries only exist while unattended mode is
  // armed. If the arming lapsed while the retry waited, the message must not go out
  // behind the operator's back -- that is the whole point of the expiry.
  if(entry.source!=="operator"&&!currentJs8().auto)
    return expireTxRetry(item,"unattended mode disarmed");
  if(entry.to)autoReply.noteSent(entry.to,entry.text);
  restartOutgoing(item);
}

function expireTxRetry(item,reason){
  item.status="expired"; item.outcome="expired"; item.txError=reason;
  item.retryUntilMs=0; item.retryQueueId=0;
  console.info("[js8-resend] dropped:",reason);
  renderActivity(); persistSession();
}

function outgoingItemById(id){
  return state.outgoingLog.find(item=>String(item.id)===String(id)) || null;
}

// A retry that ran out of time must not disappear without a word: the row says so, and a
// resend the operator asked for by hand hands its text back to the composer, because
// otherwise a minute of waiting quietly eats what they typed.
function noteTxQueueExpiry(event){
  const item=state.outgoingLog.find(entry=>entry.retryQueueId===event.id);
  if(!item)return;
  expireTxRetry(item,event.detail||"waited too long");
  if(item.manualResend&&dom.message&&!dom.message.value.trim()){
    dom.message.value=item.sourceText||(item.recipe&&item.recipe.text)||"";
    renderControls();
  }
}

// The operator asked for it, so it goes through the queue rather than straight at the
// encoder: mid-frame TxController.queue() throws "TX queue is busy" and would turn one
// click into a second fault. The queue also re-checks the recipient on the way out.
function resendOutgoing(id){
  const item=outgoingItemById(id);
  if(!item||!item.recipe)return false;
  if(item.retryQueueId)txQueue.remove(item.retryQueueId);
  item.manualResend=true;
  item.status="queued"; item.outcome=""; item.retryUntilMs=0;
  const source=(item.recipe.source==="relay"||item.recipe.source==="inbox")?item.recipe.source:"operator";
  const queued=txQueue.push({source,text:item.text,to:item.recipe.to||"",
    nowMs:js8Clock.now(),submode:selectedMode(),ttlMs:Js8TxQueue.resendTtlMs(selectedMode()),
    meta:{...(item.recipe.meta||{}),resendItem:item,manualResend:true}});
  if(!queued.queued){ item.status="fault"; item.txError=`resend refused (${queued.reason})`; renderActivity(); return false; }
  item.retryQueueId=queued.id;
  item.retryUntilMs=js8Clock.now()+Js8TxQueue.resendTtlMs(selectedMode());
  renderActivity(); persistSession();
  drainTxQueue(); renderTxQueue();
  return true;
}

// The countdown has to move without redrawing the stations, the map and every decode
// once a second, so the row renders an empty span and only its text is refreshed here.
function renderRetryCountdowns(){
  if(!dom.traffic)return;
  // Cheap exit on the ordinary path. This runs from renderActivity(), which fires on
  // every decode, so walking the feed when nothing is waiting would add DOM work to the
  // one second per slot in which the encoder cannot afford to be late.
  if(!state.outgoingLog.some(item=>Number(item.retryUntilMs)>0))return;
  const now=Date.now();
  for(const node of dom.traffic.querySelectorAll("[data-retry-until]")){
    const until=Number(node.dataset.retryUntil)||0;
    node.textContent=until>now?`retry ${Math.ceil((until-now)/1000)} s`:"";
  }
}

const OUTGOING_LOG_MAX=200;
let outgoingSequence=0;
// conversationCall routes the item into a chat thread; displayCall is only the
// label the recent-traffic feed shows. They differ for a group call such as
// @APRSIS, which is a real recipient but never a conversation.
// `recipe` is what a RESEND replays: the rendered text is a frame, not an intent, and a
// CQ row could never be rebuilt from it.
function queueOutgoing(messageText, conversationCall="", displayCall=conversationCall, recipe=null) {
  const item={direction:"outgoing",time:new Date().toISOString().slice(11,19),
    utcMs:Date.now(),to:displayCall,
    text:messageText,status:"queued",sentChars:0,activeFraction:0,txRenderKey:"",
    id:++outgoingSequence,recipe,attempts:1,txError:"",outcome:"",
    framesSent:0,frameCount:0,retryQueueId:0,retryUntilMs:0,
    frequencyHz:Number(state.activityFrequency)||Number(state.radio.frequency)||0};
  if(conversationCall){
    if(!state.conversations[conversationCall])state.conversations[conversationCall]=[];
    state.conversations[conversationCall].push(item);
  }
  // Same object reference the conversation/chat thread holds, so status updates from
  // updateOutgoingTxProgress flow straight through to the recent-traffic feed.
  state.outgoingLog.push(item);
  if(state.outgoingLog.length>OUTGOING_LOG_MAX)state.outgoingLog.shift();
  state.activeOutgoing=item;
  state.lastOutgoing=item;
  renderConversation();
  renderTxPayload();
  renderActivity();
  persistSession();
  // Sending our half of an SNR exchange may complete a QSO worth auto-logging.
  if(conversationCall)maybeAutoLogQsos();
  return item;
}

function failOutgoing(item,error) {
  state.txStatus="fault";
  dom.modemState.textContent=error.message;
  dom.modemState.className="modem-state error";
  item.status="fault";
  item.activeFraction=0;
  noteTxOutcome(item,"fault",error.message);
  if(state.activeOutgoing===item)state.activeOutgoing=null;
  renderControls();
  renderConversation();
  renderActivity();
  persistSession();
}

// A draft opening with @APRSIS carries its own recipient, so the group call is
// peeled off here instead of going through the Recipient field -- that field
// feeds state.selectedCall, which drives the chat thread, LOG QSO, the SNR
// preset and followSpeed, none of which a group call can serve.
function startTx(text, source="operator") {
  const aprs=Js8Aprs.splitForTx(text);
  if(aprs)return startTxTo(aprs.toCall, aprs.text, null, Js8Aprs.normalize(text), source);
  startTxTo(state.selectedCall, text, null, text, source);
}

// The rendered first-frame text for a recipe, rebuilt from the CURRENT settings on every
// attempt. That is the whole reason a recipe stores intent instead of frames: a message
// that failed because "My callsign" or the speed was wrong goes out corrected, not
// replayed with the same mistake.
function outgoingTextFor(recipe){
  const js8=currentJs8();
  if(recipe.kind==="cq")
    return Js8Protocol.buildCqFrames({myCall:js8.myCall,grid:js8.grid,cq:recipe.cq})[0].messageText;
  if(recipe.kind==="heartbeat")
    return Js8Protocol.buildHeartbeatFrames({myCall:js8.myCall,grid:js8.grid})[0].messageText;
  return Js8Protocol.formatDirectedMessage({myCall:js8.myCall,toCall:recipe.to,text:recipe.text});
}

function encodeForRecipe(recipe,item){
  const js8=currentJs8();
  if(recipe.kind==="cq"){
    activeEncoder.setToneOffset(js8.txOffsetHz).configure({myCall:js8.myCall,toCall:"",mode:selectedMode(),clockCorrectionMs:js8.clockCorrectionMs});
    driveEncoder(activeEncoder.encode("",{kind:"cq",cq:recipe.cq,grid:js8.grid,toneHz:js8.txOffsetHz}),error=>failOutgoing(item,error));
    return;
  }
  if(recipe.kind==="heartbeat"){
    const tone=Number.isFinite(recipe.toneHz)?recipe.toneHz:js8.txOffsetHz;
    activeEncoder.setToneOffset(tone).configure({myCall:js8.myCall,toCall:"",mode:selectedMode(),clockCorrectionMs:js8.clockCorrectionMs});
    driveEncoder(activeEncoder.encode("",{kind:"heartbeat",grid:js8.grid,toneHz:tone}),error=>failOutgoing(item,error));
    return;
  }
  // A reply to a group query carries its own offset, picked away from the other members
  // answering the same question in the same slot; everything else keys where the operator
  // put us. A resend replays recipe, so a second attempt stays on the announced offset.
  const tone=Number.isFinite(recipe.toneHz)?recipe.toneHz:js8.txOffsetHz;
  // grid rides along because an addressee that needs the compound pair puts our callsign
  // and locator in the first of the two frames; for a plain directed frame it is unused.
  activeEncoder.setToneOffset(tone).configure({myCall:js8.myCall,toCall:recipe.to,grid:js8.grid,mode:selectedMode(),clockCorrectionMs:js8.clockCorrectionMs});
  driveEncoder(activeEncoder.encode(recipe.text),error=>failOutgoing(item,error));
}

// First attempt: a new row in the feed.
function beginOutgoing(recipe){
  // A joined group now keeps a thread of its own -- its LOG QSO button is disabled
  // explicitly, so the old objection no longer holds and the operator can see what was
  // sent into the net. A gateway like @APRSIS is still not joinable, so its traffic
  // stays where it was: in the recent-traffic feed, like CQ and HB.
  const target=String(recipe.to||"");
  const conversationCall=recipe.kind==="directed"&&(!target.startsWith("@")||isMyGroup(target))
    ?recipe.to:"";
  const item=queueOutgoing(outgoingTextFor(recipe),conversationCall,recipe.to||"",recipe);
  item.sourceText=recipe.sourceText||recipe.text; // raw operator text, replayed verbatim by a resend
  item.txMeta=recipe.meta||null;
  encodeForRecipe(recipe,item);
  return item;
}

// Another attempt at the SAME row. One message never occupies more than one line
// whatever it takes to get it out: a flapping link would otherwise triple the own-TX
// rows and push real decodes out of the hundred the feed renders. The row's time moves
// to this attempt so a late success surfaces at the top instead of hiding in history.
function restartOutgoing(item,{manual=false}={}){
  const recipe=item.recipe;
  if(!recipe||!activeEncoder)return false;
  if(manual)item.manualResend=true;
  if(!item.firstUtcMs)item.firstUtcMs=Number(item.utcMs)||Date.now();
  item.attempts=(Number(item.attempts)||1)+1;
  item.utcMs=Date.now();
  item.time=new Date().toISOString().slice(11,19);
  item.text=outgoingTextFor(recipe);
  item.status="queued"; item.sentChars=0; item.activeFraction=0; item.txRenderKey="";
  item.txError=""; item.outcome=""; item.restored=false;
  item.retryQueueId=0; item.retryUntilMs=0;
  item.frequencyHz=Number(state.activityFrequency)||Number(state.radio.frequency)||0;
  state.activeOutgoing=item; state.lastOutgoing=item;
  encodeForRecipe(recipe,item);
  renderConversation(); renderTxPayload(); renderActivity(); persistSession();
  return true;
}

// Explicit recipient. An automatic answer goes to whoever asked, which is not
// necessarily the station the operator happens to have selected -- addressing it
// to the selection would send the reply to the wrong station, or fail outright
// when nothing is selected.
// sourceText is what a resend puts back in the composer. It defaults to the
// transmitted text, but an APRS command is split before it gets here, so the
// caller passes the whole draft to keep "@APRSIS " on the front.
function startTxTo(toCall, text, txMeta = null, sourceText = text, source = "operator") {
  const cq=cqType(text);
  if(cq)return beginOutgoing({kind:"cq",cq,to:"",text,sourceText,meta:txMeta,source});
  // The queue entry may carry an offset of its own (a group reply does); undefined
  // leaves encodeForRecipe on the operator's own TX offset.
  const toneHz=txMeta&&Number.isFinite(txMeta.toneHz)?txMeta.toneHz:undefined;
  beginOutgoing({kind:"directed",to:toCall,text,sourceText,meta:txMeta,source,toneHz});
}

function startHeartbeat(offsetHz, auto=false) {
  // Automatic beacons pick a random offset in the narrow HB band; the manual
  // button keeps using the operator's own TX offset.
  const tone=Number.isFinite(offsetHz)?offsetHz:currentJs8().txOffsetHz;
  // Only the scheduled beacon auto-retries on a fault; a manual button press does not.
  beginOutgoing({kind:"heartbeat",to:"",text:"",toneHz:tone,
    meta:auto?{heartbeatAuto:true}:null,source:"heartbeat"});
}

function toggleTune() {
  if(state.tuneActive){activeEncoder.abort();return;}
  const js8=currentJs8(), tone=js8.txOffsetHz;
  activeEncoder.setToneOffset(tone).configure({myCall:js8.myCall,toCall:"",mode:selectedMode(),clockCorrectionMs:js8.clockCorrectionMs});
  driveEncoder(activeEncoder.encode("",{kind:"tune",toneHz:tone,immediate:true}),error=>{
    state.tuneActive=false; state.txStatus="fault"; dom.modemState.textContent=error.message;
    dom.modemState.className="modem-state error"; renderControls();
  });
}

function closeMessagePresets() {
  dom.messagePresetsMenu.hidden=true;
  dom.messagePresetsButton.setAttribute("aria-expanded","false");
}

function messagePresetValue(key) {
  const station=state.activity.calls.find(item=>item.call===state.selectedCall);
  // Group C of docs/js8call-komunikacni-funkce.md: the short phrases that fit a
  // single directed frame with a standard callsign.
  return ({cq:"CQ CQ CQ",snr:station?`SNR ${formatJs8Snr(station.snr)}`:"",
    "snr-query":"SNR?","copy-query":"HW CPY?",rr:"RR",fb:"FB",qsl:"QSL",
    "qsl-query":"QSL?",yes:"YES",no:"NO",tu:"TU","dit-dit":"DIT DIT",
    "grid-query":"GRID?","info-query":"INFO?","status-query":"STATUS?",
    // Answered automatically by js8-autoreply.js when somebody asks US, and it is
    // what draws the green arrows between third-party dots on the stations map --
    // so asking it by hand is the one way to fill that map in on a quiet band.
    "hearing-query":"HEARING?",
    // Byte for byte what the auto-reply sends for INFO? (js8-autoreply.js): answering by
    // hand and answering automatically must not produce two different descriptions of the
    // same station.
    info:currentJs8().infoText?`INFO ${currentJs8().infoText}`:"",
    again:"AGN?","73":"73",sk:"SK",aprsis:`${Js8Aprs.GROUP} `})[key] || "";
}

// ---- @APRSIS command builder ------------------------------------------------
// docs/aprsis-implementace.md. The menu is a pure function of the composer text:
// on every render it re-derives which branch of the catalogue the draft is in,
// so a hand-edited command can never disagree with the menu that built it.

const aprsState={node:null,recent:Js8Aprs.loadRecent(localStorage)};
// Six frames is a minute and a half at NORMAL speed -- past that the operator is
// warned, never refused. The 67-character APRS limit is the only hard stop.
const APRS_FRAME_WARNING=6;
let presetMenuBase="";

function aprsDuration(seconds) {
  const whole=Math.round(seconds);
  return `${Math.floor(whole/60)}:${String(whole%60).padStart(2,"0")}`;
}

// buildReplyFrames() throws on an unpackable callsign, which is exactly the
// state a station has before My callsign is set. The cost line is advisory, so
// fall back to nothing rather than breaking the render.
function aprsFrameCount(payload) {
  const transport=Js8Aprs.splitForTx(payload);
  if(!transport)return 0;
  try {
    return Js8Protocol.buildReplyFrames({myCall:currentJs8().myCall,
      toCall:transport.toCall,text:transport.text,mode:selectedMode()}).length;
  } catch(_error) { return 0; }
}

function aprsCostText(payload,textLength) {
  const frames=aprsFrameCount(payload);
  if(!frames)return {text:"",long:false};
  const seconds=Js8Aprs.airtimeSeconds(frames,selectedMode());
  const long=frames>APRS_FRAME_WARNING;
  const size=textLength ? `${textLength}/${Js8Aprs.MESSAGE_TEXT_LIMIT} characters · ` : "";
  return {long, text:`${size}${frames} frame${frames===1?"":"s"} · ${aprsDuration(seconds)} at ${MODE_TO_SPEED[selectedMode()]||"?"}`+
    (long?" · long transmission, consider a faster speed":"")};
}

function renderSendHint(aprsDraft) {
  if(!aprsDraft){
    dom.sendHint.textContent="Enter sends";
    dom.sendHint.classList.remove("warn");
    return;
  }
  // The operator keeps their selected station through an APRS spot, so say out
  // loud that this particular message is not going to them.
  const where=state.selectedCall
    ? `Enter sends to ${Js8Aprs.GROUP}, not ${state.selectedCall}`
    : `Enter sends to ${Js8Aprs.GROUP}`;
  const check=Js8Aprs.validate(dom.message.value);
  const cost=check.ok?aprsCostText(dom.message.value,check.textLength):{text:"",long:false};
  dom.sendHint.textContent=cost.text?`${where} · ${cost.text}`:where;
  dom.sendHint.classList.toggle("warn",cost.long);
}

function aprsNodeById(id) {
  return [...Js8Aprs.COMMANDS,...Js8Aprs.MENU].find(node=>node.id===id) || null;
}

function aprsMenuHtml(aprs) {
  const crumbs=[{id:"root",label:"all"},...aprs.path].map(step=>
    `<button type="button" class="aprs-crumb" data-aprs-crumb="${esc(step.id)}">${esc(step.label)}</button>`)
    .join('<span class="aprs-crumb-sep">/</span>');
  const items=aprs.children.map(node=>
    `<button type="button" role="menuitem" data-aprs-node="${esc(node.id)}"><strong>${esc(node.label)}</strong><small>${esc(node.hint)}</small></button>`).join("");
  if(items)return `<header class="aprs-crumbs">${crumbs}</header>${items}`;
  // A finished leaf has nothing left to offer, so show what it will cost and
  // the way back into its parameters.
  const node=aprs.service || aprs.command;
  const check=Js8Aprs.validate(dom.message.value);
  const cost=check.ok?aprsCostText(dom.message.value,check.textLength):{text:check.reason,long:false};
  const edit=node&&node.params.length
    ? `<button type="button" role="menuitem" data-aprs-edit="${esc(node.id)}"><strong>EDIT</strong><small>Change the parameters</small></button>` : "";
  return `<header class="aprs-crumbs">${crumbs}</header>${edit}`+
    `<p class="aprs-status${cost.long||!check.ok?" warn":""}">${esc(cost.text)}</p>`;
}

// Swapping innerHTML detaches whatever was clicked, so every handler reads its
// dataset before calling this.
function renderMessagePresets() {
  const aprs=Js8Aprs.parse(dom.message.value);
  if(aprs){
    dom.messagePresetsMenu.dataset.mode="aprs";
    dom.messagePresetsMenu.innerHTML=aprsMenuHtml(aprs);
    return;
  }
  if(dom.messagePresetsMenu.dataset.mode!=="base"){
    dom.messagePresetsMenu.dataset.mode="base";
    dom.messagePresetsMenu.innerHTML=presetMenuBase;
  }
  const snrPreset=dom.messagePresetsMenu.querySelector('[data-message-preset="snr"]');
  if(!snrPreset)return;
  // Only a station decoded here has an SNR to report back; one we were merely told about
  // would insert somebody else's signal report.
  const snrStation=state.activity.calls.find(item=>item.call===state.selectedCall && item.heardDirectly!==false);
  snrPreset.disabled=!snrStation;
  snrPreset.title=snrStation ? `Insert SNR ${formatJs8Snr(snrStation.snr)}` : "Select a heard station first";
  // "INFO" without the question mark describes THIS station, so it has nothing to say until
  // the operator has written that description in SETTINGS. Refused the same way the
  // auto-reply refuses it, rather than sending a bare "INFO" that means nothing.
  const infoPreset=dom.messagePresetsMenu.querySelector('[data-message-preset="info"]');
  if(!infoPreset)return;
  const infoText=currentJs8().infoText;
  infoPreset.disabled=!infoText;
  infoPreset.title=infoText ? `Insert INFO ${infoText}` : "Fill in INFO answer in SETTINGS first";
}

function setMessageDraft(value) {
  dom.message.value=value;
  dom.message.dispatchEvent(new Event("input",{bubbles:true}));
  dom.message.focus({preventScroll:true});
  dom.message.setSelectionRange(value.length,value.length);
}

// Nodes without parameters extend the draft straight away; the rest open the
// popup, so the operator never sees a {placeholder} to overwrite by hand.
function pickAprsNode(id) {
  const node=aprsNodeById(id);
  if(!node)return;
  if(!node.params.length){setMessageDraft(Js8Aprs.compose(node,{}));return;}
  openAprsParams(node,null);
}

function editAprsNode(id) {
  const node=aprsNodeById(id), aprs=Js8Aprs.parse(dom.message.value);
  if(!node||!aprs)return;
  openAprsParams(node,node.fields(aprs.text,aprs.dest));
}

function aprsParamValues() {
  const values={};
  for(const input of dom.aprsParamGrid.querySelectorAll("[data-aprs-param]"))
    values[input.dataset.aprsParam]=input.value;
  return values;
}

function renderAprsRecent() {
  dom.aprsRecentCalls.innerHTML=aprsState.recent
    .map(call=>`<option value="${esc(call)}"></option>`).join("");
}

function renderAprsParams() {
  const node=aprsState.node;
  if(!node)return;
  const check=Js8Aprs.checkParams(node,aprsParamValues());
  dom.aprsParamPreview.textContent=check.payload || "Fill the fields to preview the exact radio payload.";
  dom.aprsParamError.textContent=check.errors.map(error=>error.reason).join(" · ");
  dom.aprsParamInsert.disabled=!check.ok;
  const cost=check.ok?aprsCostText(check.payload,check.textLength):{text:"",long:false};
  dom.aprsParamCost.textContent=cost.text;
  dom.aprsParamCost.classList.toggle("warn",cost.long);
}

function openAprsParams(node,values) {
  aprsState.node=node;
  const js8=currentJs8();
  const initial=values || Js8Aprs.prefill(node,{myCall:js8.myCall,grid:js8.grid,
    dialFrequencyHz:state.radio.frequency});
  dom.aprsParamTitle.textContent=`${node.label} — ${node.hint}`;
  renderAprsRecent();
  dom.aprsParamGrid.innerHTML=node.params.map(param=>{
    const list=param.recent?' list="aprsRecentCalls"':"";
    const optional=param.required?"":' <small>optional</small>';
    return `<label>${esc(param.label)}${optional} <input data-aprs-param="${esc(param.key)}"`+
      ` value="${esc(initial[param.key]||"")}" placeholder="${esc(param.placeholder||"")}"`+
      ` autocomplete="off" spellcheck="false"${list}></label>`;
  }).join("");
  renderAprsParams();
  dom.aprsParamDialog.showModal();
  dom.aprsParamGrid.querySelector("input")?.focus({preventScroll:true});
}

function insertAprsParams(event) {
  event.preventDefault();
  const node=aprsState.node;
  if(!node)return;
  const values=aprsParamValues();
  const check=Js8Aprs.checkParams(node,values);
  if(!check.ok)return;
  // Only the free-text destination is worth remembering; every other addressee
  // is already in the catalogue.
  if(node.destParam){
    aprsState.recent=Js8Aprs.saveRecent(localStorage,
      Js8Aprs.rememberCall(aprsState.recent,values[node.destParam]));
  }
  dom.aprsParamDialog.close();
  setMessageDraft(check.payload);
}

function insertMessagePreset(key) {
  const value=messagePresetValue(key);
  if(!value)return;
  // @APRSIS is the start of a command, not a finished message: leave the menu
  // open so the next level (GRID / CMD) is one click away.
  if(key!=="aprsis")closeMessagePresets();
  setMessageDraft(value);
}

function updateOutgoingTxProgress(txState) {
  const item=state.activeOutgoing;
  if(!item)return;
  const frames=txState.frames||[];
  let sent=Number(item.sentChars)||0;
  for(let index=0;index<Math.min(txState.frameIndex,frames.length);index+=1)
    sent=Math.max(sent,Number(frames[index].textEnd)||0);
  let activeFraction=0;
  const frame=frames[txState.frameIndex];
  const frameStart=Number(frame?.textStart)||0,frameEnd=Number(frame?.textEnd)||frameStart;
  if(frame&&frameEnd>frameStart&&txState.status==="transmitting"){
    const exact=frameStart+(frameEnd-frameStart)*Math.max(0,Math.min(1,Number(txState.frameProgress)||0));
    sent=Math.max(sent,Math.floor(exact));
    activeFraction=exact-Math.floor(exact);
  }else if(frame&&frameEnd>frameStart&&txState.status==="draining"){
    sent=Math.max(sent,frameEnd);
  }
  if(txState.status==="completed"){
    sent=item.text.length;
    const deliveryId=item.txMeta&&item.txMeta.inboxDeliveryId;
    if(deliveryId){
      item.txMeta.inboxDeliveryId=null; // completion may be reported more than once
      if(inbox.confirmDelivered(deliveryId)){renderInbox();syncInbox();}
    }
    // A CQ that got out re-arms the one rollback its schedule is allowed.
    if(item.recipe&&item.recipe.kind==="cq")cqRetryPending=false;
  }
  item.sentChars=Math.max(0,Math.min(item.text.length,sent));
  item.activeFraction=["aborted","fault","completed"].includes(txState.status)?0:activeFraction;
  item.status=txState.status;
  // Frames, not characters: sentChars cannot say how many keyings actually happened, and
  // txState does not survive a reload.
  item.frameCount=Number(txState.frameCount)||0;
  item.framesSent=Math.max(Number(item.framesSent)||0,Number(txState.frameIndex)||0);
  // The tone the encoder was actually configured with, captured here rather than read
  // from settings when the feed is drawn. Six call sites set it and they disagree on
  // purpose: a heartbeat picks its own tone inside the 500-1000 Hz sub-band, the email
  // gateway uses the gateway's, a file transfer its own. Reading txOffsetHz at render
  // time would draw every one of them at whatever the operator last typed.
  if(Number.isFinite(txState.toneHz))item.offsetHz=Number(txState.toneHz);
  if(Number.isFinite(txState.mode))item.submode=Number(txState.mode);
  // Before the render key, because the verdict may rewrite the status to "unconfirmed".
  if(["aborted","fault"].includes(txState.status))noteTxOutcome(item,txState.status,txState.error);
  const renderKey=`${item.status}|${item.sentChars}|${Math.round(item.activeFraction*20)}`;
  if(renderKey!==item.txRenderKey){
    // The feed only shows status (colour), so redraw it on status transitions
    // rather than every character of progress that redraws the chat thread.
    const statusChanged=String(item.txRenderKey).split("|")[0]!==item.status;
    item.txRenderKey=renderKey;
    renderConversation();renderTxPayload();
    if(statusChanged)renderActivity();
    persistSession();
  }
  // A scheduled beacon or CQ that faulted never reached the air; its schedule is moved
  // back by noteTxOutcome() above, which also covers a lost link (status "aborted") --
  // the case the old fault-only check here used to miss.
  if(["aborted","fault","completed"].includes(txState.status))state.activeOutgoing=null;
}

async function pollRadio() {
  if (radioPollInFlight) return;
  radioPollInFlight=true;
  try {
    const response=await fetch(RADIO_STATE_URL,{cache:"no-store"}); if (!response.ok) throw new Error();
    const next=await response.json();
    noteRadioLink(next);
    state.radio={...state.radio,...next,frequency:Number(next.frequency)||0};
    // The setup guide follows the radio, not the page: whatever model this reports
    // is the procedure the help dialog opens on. No-op when unchanged.
    if(root_TrxHelp())root_TrxHelp().setReportedModel(state.radio.radioName);
    const activityFrequencyChanged=selectActivityFrequency(state.radio.frequency);
    if (state.pendingFrequency && state.radio.frequency===state.pendingFrequency) state.pendingFrequency=null;
    noteRfKnob(); applyAutoRfPower();
    ensureAudio(); if(activityFrequencyChanged)renderActivity(); renderHeader(); renderControls();
  } catch (_error) {
    // Deliberately not through noteRadioLink(): a fetch that never arrived says
    // nothing about the radio, and counting it as a link drop would re-arm the
    // power write on every WiFi flutter between the browser and the ESP32.
    state.radio.connected=false; stopAudio(); renderHeader(); renderControls();
  }
  finally { radioPollInFlight=false; }
}

async function reconnectRadio() {
  if(state.reconnectPending)return;
  state.reconnectPending=true; renderHeader();
  try {
    const response=await fetch("/lan/reconnect",{method:"POST"});
    if(!response.ok)throw new Error(`Reconnect failed (HTTP ${response.status})`);
    state.radio.lanStatus="connecting";
  } catch(error) {
    dom.modemState.textContent=error.message;
    dom.modemState.className="modem-state error";
  } finally {
    state.reconnectPending=false; renderHeader();
  }
}

// The ICOM-LAN precondition itself lives in lan-gate.js, shared with the WSPR
// page so the two DATA sub-pages cannot disagree about whether the link is
// usable. This only lifts what JS8LAN needs out of the answer.
async function checkLanConfiguration() {
  const ready=await LanGate.gate();
  const config=LanGate.config()||{};
  // The same JSON carries the "Blocked DXCC" list; capture it so blocking
  // applies from the moment the page is ready. It only changes on a reboot.
  state.blockedDxccList=String(config.blockedDxcc||"").split("\n")
    .map(entry=>entry.trim().toLowerCase()).filter(Boolean);
  state.lanConfig={checked:true,...LanGate.result()};
  renderTrxSlotLabel();
  seedTrxHelpFromSetup();
  return ready;
}

// ---- Single-operator lock ---------------------------------------------------
// JS8LAN drives one radio through one AUD1 socket, so a second page open
// anywhere on the network is never a working configuration: the firmware hands
// the audio socket to whoever connected last, which used to mute the first
// operator without telling either of them. The ESP32 now owns a lease and this
// is its projection -- claim before the runtime starts, refresh while it lives,
// hand it back on the way out.
//
// The lease is what answers the other-computer and other-browser cases. It
// cannot answer a duplicated tab: browsers copy sessionStorage into the copy, so
// both tabs present the same token and the firmware rightly considers both the
// same session. A BroadcastChannel probe catches that one locally, before a
// token is ever sent, and doubles as an instant answer for a plain second tab.
const SESSION_TOKEN_KEY = "js8lan.session.token.v1";
const SESSION_PING_MS = 5000, SESSION_RETRY_MS = 3000, SESSION_PROBE_MS = 250;
let sessionTokenCache = null, sessionHeld = false, sessionConfirmed = false;
let sessionRetryTimer = null;
let sessionSince = 0;                       // when this page took the lock
let sessionLocalHolder = null;              // {id, since} of a live holder in this browser

// crypto.randomUUID() needs a secure context and the radio is plain http on a
// LAN address, so the token is built from getRandomValues, which is not gated.
// Hex only: the firmware validates the alphabet before echoing it into JSON.
function makeSessionToken() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random()*256);
  return Array.from(bytes, byte => byte.toString(16).padStart(2,"0")).join("");
}

// Per tab, and deliberately in sessionStorage rather than localStorage: the
// header tabs are full-page navigations, so the token has to survive the trip to
// SETUP and back, while a genuinely new tab must get a new one.
function sessionToken() {
  if (sessionTokenCache) return sessionTokenCache;
  const store = sessionStore();
  let token = store && store.getItem(SESSION_TOKEN_KEY);
  if (!token) { token = makeSessionToken(); if (store) { try { store.setItem(SESSION_TOKEN_KEY,token); } catch (_error) { /* private mode */ } } }
  sessionTokenCache = token;
  return token;
}

const pageId = makeSessionToken();
const sessionChannel = (() => { try { return new BroadcastChannel("js8lan.session"); } catch (_error) { return null; } })();
if (sessionChannel) sessionChannel.onmessage = event => {
  const message = event.data || {};
  if (message.id === pageId) return;
  if (message.type === "probe" && sessionHeld) sessionChannel.postMessage({type:"held", id:pageId, since:sessionSince});
  if (message.type === "held") sessionLocalHolder = {id:message.id, since:Number(message.since)||0};
  // A page that just closed frees the lock now, not at the next poll tick.
  if (message.type === "released" && !sessionHeld) scheduleSessionRetry(200);
  // Takeover across the network is the firmware's job, but a duplicated tab
  // shares the token, so the server would grant both. This is how the operator
  // gets the radio away from the other tab.
  if (message.type === "evict" && sessionHeld) yieldSession({lost:true});
};

function probeLocalHolder() {
  if (!sessionChannel) return Promise.resolve(null);
  sessionLocalHolder = null;
  sessionChannel.postMessage({type:"probe", id:pageId});
  return new Promise(resolve => setTimeout(() => resolve(sessionLocalHolder), SESSION_PROBE_MS));
}

// Whoever took the lock first keeps it, so a page opened later always steps
// aside; the id only breaks the tie when two pages start in the same
// millisecond, which is what stops a pair of duplicates reloading at each other
// forever.
function localHolderOutranks(holder) {
  if (!holder) return false;
  if (holder.since !== sessionSince) return holder.since < sessionSince;
  return holder.id < pageId;
}

// Only an explicit 409 is a refusal. A firmware without the lock, or a fetch
// that simply failed, must never leave the operator staring at a panel it has
// no way to dismiss.
async function sessionPost(path, extra) {
  try {
    const response = await fetch(path, {method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({token:sessionToken(), ...extra})});
    if (response.status !== 409) return {granted:true};
    const info = await response.json().catch(() => ({}));
    return {granted:false, owner:info.owner||"", ageMs:Number(info.ageMs)||0};
  } catch (_error) { return {granted:true}; }
}

function markSessionHeld(confirmed = false) {
  sessionHeld = true;
  sessionConfirmed = confirmed;
  sessionSince = Date.now();
  if (sessionRetryTimer) { clearTimeout(sessionRetryTimer); sessionRetryTimer = null; }
  document.body.classList.remove("session-busy-only");
  dom.sessionBusy.hidden = true;
}

// Stop driving the radio, then show the panel. Used whenever the lock is lost
// after the runtime already started, which the local probe can do 250 ms in.
function yieldSession(info) {
  if (activeEncoder) activeEncoder.abort();
  stopAudio();
  showSessionBusy(info);
}

function showSessionBusy(info) {
  sessionHeld = false;
  sessionConfirmed = false;
  document.body.classList.add("session-busy-only");
  dom.sessionBusy.hidden = false;
  dom.sessionBusyWhere.textContent = info.local ? "Open in another tab of this browser."
    : info.owner ? `Open on ${info.owner}.` : "Open on another device.";
  dom.sessionBusyDetail.textContent = info.lost
    ? "Another page took the session over."
    : info.ageMs ? `Last seen ${(info.ageMs/1000).toFixed(0)} s ago.` : "";
  scheduleSessionRetry(SESSION_RETRY_MS);
}

function scheduleSessionRetry(delayMs) {
  if (sessionRetryTimer) clearTimeout(sessionRetryTimer);
  sessionRetryTimer = setTimeout(retrySession, delayMs);
}

// Nothing was ever started while locked out, so a reload is both the simplest
// and the most honest way back in: it runs the whole startup path once, from a
// clean slate, exactly as if the page had just been opened.
async function retrySession() {
  sessionRetryTimer = null;
  // The local probe stays on this path: a duplicated tab shares the token, so
  // the firmware would happily grant the claim and the reload would come
  // straight back here.
  if (await probeLocalHolder()) { scheduleSessionRetry(SESSION_RETRY_MS); return; }
  const claim = await sessionPost("/js8/session/claim", {force:false});
  if (claim.granted) location.reload();
  else showSessionBusy(claim);
}

async function acquireJs8Session(force = false) {
  if (force && sessionChannel) sessionChannel.postMessage({type:"evict", id:pageId});
  const claim = await sessionPost("/js8/session/claim", {force});
  if (!claim.granted) { showSessionBusy(claim); return false; }
  // A forced takeover is already an explicit operator decision. An ordinary
  // claim remains unconfirmed until the same-browser duplicate probe finishes;
  // the rest of the UI may load meanwhile, but ensureAudio() stays gated.
  markSessionHeld(force);
  if (!force) probeLocalHolder().then(holder => {
    // No release here: a duplicate shares the token, so handing it back would
    // cancel the original page's lease instead of this page's.
    if (!sessionHeld) return;
    if (localHolderOutranks(holder)) yieldSession({local:true});
    else {
      sessionConfirmed = true;
      ensureAudio();
    }
  });
  return true;
}

// Losing the lease means another page is now driving the radio.
async function pingJs8Session() {
  if (!sessionHeld) return;
  const ping = await sessionPost("/js8/session/ping", {});
  if (!ping.granted) yieldSession({...ping, lost:true});
}

function releaseJs8Session() {
  if (!sessionHeld) return;
  sessionHeld = false;
  sessionConfirmed = false;
  if (sessionChannel) sessionChannel.postMessage({type:"released", id:pageId});
  const body = JSON.stringify({token:sessionToken()});
  // sendBeacon survives the unload a fetch would be cancelled in.
  try {
    if (navigator.sendBeacon && navigator.sendBeacon("/js8/session/release", new Blob([body],{type:"application/json"}))) return;
  } catch (_error) { /* fall through */ }
  try { fetch("/js8/session/release",{method:"POST",headers:{"Content-Type":"application/json"},body,keepalive:true}); } catch (_error) { /* leaving anyway */ }
}

// ---- bindings ---------------------------------------------------------------

function setJs8Setting(key,value) { currentJs8()[key]=value; persistSettings(); }
function confirmJs8Leave(event) {
  // Received data now survives the round-trip via the session snapshot, so a bare
  // navigation is silent. Confirm only when a transmission is actively going out:
  // leaving aborts the in-flight frame, which cannot resume mid-slot.
  const outgoing=state.activeOutgoing;
  if(!outgoing || !TX_LIVE_STATUSES.includes(outgoing.status))return;
  event.preventDefault();
  // Modern browsers intentionally replace custom text with their own warning,
  // but returnValue is still required to request the confirmation dialog.
  event.returnValue="A transmission is in progress and will be interrupted.";
  return event.returnValue;
}
function bind() {
  dom.modeSelect.addEventListener("change",()=>selectMode(dom.modeSelect.value));
  dom.trxHelpButton.addEventListener("click",()=>openTrxHelp("manual"));
  dom.trxReconnect.addEventListener("click",reconnectRadio);
  dom.trxHelpDialog.addEventListener("click",event=>{if(event.target===dom.trxHelpDialog)dom.trxHelpDialog.close();});
  dom.trxFrequency.addEventListener("click",()=>{const open=dom.frequencyMenu.hidden;dom.frequencyMenu.hidden=!open;dom.trxFrequency.setAttribute("aria-expanded",String(open));});
  dom.frequencyMenu.addEventListener("click",event=>{if(event.target.closest("[data-menu-close]")){closeFrequencyMenu();return;}const button=event.target.closest("[data-frequency]");if(button)requestFrequency(Number(button.dataset.frequency)).catch(()=>{});});
  dom.freqTimetableClose.addEventListener("click",closeTimetablePanel);
  dom.freqTimetableButton.addEventListener("click",()=>{if(!dom.freqTimetablePanel.hidden){closeTimetablePanel();return;}dom.freqTimetablePanel.hidden=false;dom.freqTimetableButton.setAttribute("aria-expanded","true");renderTimetableGrid();renderTimetableButton();});
  dom.freqTimetableEnable.addEventListener("click",()=>setTimetableEnabled(!timetable().enabled));
  dom.freqTimetableClear.addEventListener("click",clearTimetable);
  dom.freqTimetableGrid.addEventListener("click",event=>{const cell=event.target.closest("[data-slot]");if(!cell)return;const index=Number(cell.dataset.slot);if(ttRuntime.editSlot===index){closeTimetablePopover();return;}openTimetablePopover(index,cell);});
  dom.freqTimetablePopover.addEventListener("click",event=>{
    const band=event.target.closest("[data-band-hz]");
    if(band){setTimetableSlot(ttRuntime.editSlot,Number(band.dataset.bandHz),band.dataset.band);closeTimetablePopover();return;}
    if(event.target.closest("[data-tt-custom]")){const input=dom.freqTimetablePopover.querySelector("#ttCustom");const hz=Math.round((Number(input&&input.value)||0)*1000);if(hz>=Js8Settings.TIMETABLE_MIN_HZ&&hz<=Js8Settings.TIMETABLE_MAX_HZ){setTimetableSlot(ttRuntime.editSlot,hz,null);closeTimetablePopover();}else if(input)input.focus();return;}
    if(event.target.closest("[data-tt-clear-slot]")){clearTimetableSlot(ttRuntime.editSlot);closeTimetablePopover();return;}
  });
  dom.freqTimetablePopover.addEventListener("keydown",event=>{if(event.key!=="Enter"||event.target.id!=="ttCustom")return;event.preventDefault();const hz=Math.round((Number(event.target.value)||0)*1000);if(hz>=Js8Settings.TIMETABLE_MIN_HZ&&hz<=Js8Settings.TIMETABLE_MAX_HZ){setTimetableSlot(ttRuntime.editSlot,hz,null);closeTimetablePopover();}});
  document.addEventListener("click",event=>{if(dom.freqTimetablePopover.hidden)return;if(event.target.closest(".tt-popover")||event.target.closest("[data-slot]"))return;closeTimetablePopover();});
  dom.waterfall.addEventListener("click",event=>{const rect=dom.waterfall.getBoundingClientRect();setJs8Setting("txOffsetHz",Math.round(RX_LOW+(event.clientX-rect.left)/rect.width*(RX_HIGH-RX_LOW)));activeEncoder&&activeEncoder.setToneOffset(currentJs8().txOffsetHz);});
  // Same arithmetic as the click above, so what the preview promises is exactly what the
  // click delivers. Cleared on leave, and also whenever the click lands: the marker has
  // moved to that frequency by then and a second line on top of it says nothing.
  const previewFrom=event=>{const rect=dom.waterfall.getBoundingClientRect();
    setCollisionPreview(RX_LOW+(event.clientX-rect.left)/rect.width*(RX_HIGH-RX_LOW));};
  dom.waterfall.addEventListener("mousemove",event=>{previewFrom(event);showStationLabels();});
  dom.waterfall.addEventListener("mouseleave",()=>{clearStationLabels();setCollisionPreview(null);});
  // The @ used to be stripped here so that @APRSIS could never land in this field.
  // Joined groups now belong in it, so the guard moved into chooseCall(), where it is
  // both narrower and stronger: only a group we have joined is accepted, and a gateway
  // like @APRSIS cannot be joined at all. Without this the field would show @NET after
  // a click in the table and then destroy it on the first keystroke.
  dom.recipient.addEventListener("change",()=>chooseCall(dom.recipient.value.toUpperCase().replace(/[^A-Z0-9/@]/g,"")));
  dom.recipientClear.addEventListener("click",clearRecipient);
  dom.messagePresetsButton.addEventListener("click",()=>{
    const opening=dom.messagePresetsMenu.hidden;
    dom.messagePresetsMenu.hidden=!opening;
    dom.messagePresetsButton.setAttribute("aria-expanded",opening?"true":"false");
    if(opening)dom.messagePresetsMenu.querySelector("button:not(:disabled)")?.focus({preventScroll:true});
  });
  // The static markup is the root menu; renderMessagePresets() swaps it for the
  // @APRSIS branch and restores this copy on the way back.
  presetMenuBase=dom.messagePresetsMenu.innerHTML;
  dom.messagePresetsMenu.dataset.mode="base";
  dom.messagePresetsMenu.addEventListener("click",event=>{
    const button=event.target.closest("button");
    if(!button||button.disabled)return;
    // The render this triggers replaces innerHTML and detaches `button`, so the
    // dataset has to be read before anything else runs.
    const {messagePreset,aprsNode,aprsEdit,aprsCrumb}=button.dataset;
    if(messagePreset)insertMessagePreset(messagePreset);
    else if(aprsNode)pickAprsNode(aprsNode);
    else if(aprsEdit)editAprsNode(aprsEdit);
    else if(aprsCrumb!==undefined)setMessageDraft(Js8Aprs.truncateTo(dom.message.value,aprsCrumb));
  });
  dom.aprsParamGrid.addEventListener("input",renderAprsParams);
  dom.aprsParamForm.addEventListener("submit",insertAprsParams);
  dom.aprsParamDialog.querySelectorAll("[data-aprs-dialog-close]").forEach(button=>
    button.addEventListener("click",()=>dom.aprsParamDialog.close()));
  // Picking an @APRSIS node rebuilds the menu, which detaches the very button
  // that was clicked -- closest() would then walk an orphaned subtree, find no
  // .message-field and close the menu the operator is still working in.
  // composedPath() is captured at dispatch, so it still holds the real ancestors.
  document.addEventListener("click",event=>{
    if(event.composedPath().some(node=>node.classList?.contains("message-field")))return;
    closeMessagePresets();
  });
  dom.txSessionMode.addEventListener("change",()=>{state.txSessionMode=dom.txSessionMode.value;renderControls();});
  dom.emailAddress.addEventListener("input",renderControls);
  dom.emailMessage.addEventListener("input",renderControls);
  dom.emailGateway.addEventListener("change",()=>{emailState.selectedId=dom.emailGateway.value;emailState.status="Draft is not stored in message history.";renderControls();});
  dom.emailGatewayAdd.addEventListener("click",()=>openEmailGatewayDialog());
  dom.emailGatewayEdit.addEventListener("click",()=>{const gateway=selectedEmailGateway();if(gateway)openEmailGatewayDialog(gateway);});
  dom.emailGatewayDelete.addEventListener("click",deleteSelectedEmailGateway);
  dom.emailGatewayFormat.addEventListener("change",()=>{
    dom.emailGatewayTemplateRow.hidden=dom.emailGatewayFormat.value!=="template";
    if(dom.emailGatewayFormat.value==="aprs-email2"&&!emailState.editingId){dom.emailGatewayMaxBody.value="40";dom.emailGatewayPolicy.value="aprs";dom.emailGatewayTarget.value=dom.emailGatewayTarget.value||"@APRSIS";}
  });
  dom.emailGatewayForm.addEventListener("submit",saveEmailGateway);
  dom.emailGatewayDialog.querySelectorAll("[data-email-dialog-close]").forEach(button=>button.addEventListener("click",()=>dom.emailGatewayDialog.close()));
  dom.emailComposer.addEventListener("submit",event=>{event.preventDefault();if(!dom.emailSend.disabled)openEmailConfirmation();});
  dom.emailMessage.addEventListener("keydown",event=>{if(event.key==="Enter"&&event.ctrlKey&&!event.isComposing){event.preventDefault();if(!dom.emailSend.disabled)openEmailConfirmation();}});
  dom.emailConfirmDialog.querySelector('header button').addEventListener("click",()=>dom.emailConfirmDialog.close("cancel"));
  dom.emailConfirmDialog.addEventListener("close",()=>{if(dom.emailConfirmDialog.returnValue==="send")transmitPendingEmail();else emailState.pendingDraft=null;});
  dom.binRecipient.addEventListener("input",()=>{binState.peerDraft=dom.binRecipient.value.toUpperCase().replace(/[^A-Z0-9/]/g,"");renderControls();});
  dom.binFile.addEventListener("change",prepareSelectedFile);
  dom.binPeerExpected.addEventListener("change",renderControls);
  dom.binComposer.addEventListener("submit",event=>{event.preventDefault();if(!dom.binOffer.disabled)openBinConfirmation();});
  dom.binConfirmDialog.querySelector('header button').addEventListener("click",()=>dom.binConfirmDialog.close("cancel"));
  dom.binCopyHash.addEventListener("click",copyPreparedFileHash);
  dom.binConfirmDialog.addEventListener("close",()=>{if(dom.binConfirmDialog.returnValue==="send")beginPreparedTransfer();});
  dom.binIncomingDialog.querySelector('header button').addEventListener("click",()=>dom.binIncomingDialog.close("reject"));
  dom.binIncomingDialog.addEventListener("close",()=>{if(dom.binIncomingDialog.returnValue==="accept")acceptIncomingFileOffer();else rejectIncomingFileOffer("POLICY");});
  dom.binPause.addEventListener("click",pauseFileTransfer);
  dom.binResume.addEventListener("click",resumeFileTransfer);
  dom.binStop.addEventListener("click",stopFileTransfer);
  dom.binDownload.addEventListener("click",downloadReceivedFile);
  for (const container of [dom.traffic,dom.stationRows]) container.addEventListener("click",event=>{const node=event.target.closest("[data-call]");if(node)chooseCall(node.dataset.call);});
  dom.trafficFilter.addEventListener("click",event=>{const clearButton=event.target.closest("[data-traffic-clear]");if(clearButton){if(!clearButton.disabled)clearRecentTraffic();return;}
    // HIDE only moves a step counter: no re-render, so the feed does not flicker and
    // a live reception in progress is not interrupted by the columns changing.
    if(event.target.closest("[data-traffic-hide]")){state.trafficHide=(Number(state.trafficHide)||0)+1;renderTrafficHideButton();persistSession();return;}
    const button=event.target.closest("[data-traffic-filter]");if(!button||button.disabled)return;state.trafficFilter=button.dataset.trafficFilter;renderActivity();persistSession();});
  dom.stationHead.addEventListener("click",event=>{const button=event.target.closest("[data-station-sort]");if(!button)return;const key=button.dataset.stationSort;if(state.stationSort.key===key)state.stationSort.direction=state.stationSort.direction==="asc"?"desc":"asc";else state.stationSort={key,direction:"asc"};renderActivity();persistSession();});
  dom.txSpeed.addEventListener("change",()=>setJs8Setting("speed",dom.txSpeed.value));
  dom.txOffset.addEventListener("change",()=>setJs8Setting("txOffsetHz",Math.max(RX_LOW,Math.min(RX_HIGH,Number(dom.txOffset.value)||1500))));
  // Typing only updates the watts beside the box; nothing reaches the radio
  // until SET, which is what makes the number a stored choice.
  dom.rfPercent.addEventListener("input",()=>{rfDraft=dom.rfPercent.value;rfLastError="";renderHeader();});
  dom.rfPercentSet.addEventListener("click",setRfPowerFromField);
  dom.txGain.addEventListener("input",()=>{state.settingsDraft.txGain=dom.txGain.value;});
  dom.followSpeed.addEventListener("change",()=>setJs8Setting("followSpeed",dom.followSpeed.checked));
  dom.clockCorrection.addEventListener("change",()=>setJs8Setting("clockCorrectionMs",Number(dom.clockCorrection.value)||0));
  dom.autoTiming.addEventListener("change",()=>setJs8Setting("autoTiming",dom.autoTiming.checked));
  dom.infoText.addEventListener("change",()=>setJs8Setting("infoText",dom.infoText.value));
  dom.statusText.addEventListener("change",()=>{setJs8Setting("statusText",dom.statusText.value);renderControls();});
  // The menu IS the stored answer for every literal entry, so picking one writes it.
  // "Custom" restores the last text typed this session instead, which is what makes a
  // detour through a preset survivable rather than a way to lose the answer.
  dom.statusPreset.addEventListener("change",()=>{
    const value=dom.statusPreset.value;
    statusCustomOpen=value===Js8Settings.STATUS_CUSTOM;
    setJs8Setting("statusAuto",value===Js8Settings.STATUS_AUTO);
    if(statusCustomOpen){if(statusCustomDraft)setJs8Setting("statusText",statusCustomDraft);}
    else if(value!==Js8Settings.STATUS_AUTO)setJs8Setting("statusText",value);
    renderControls();
    if(statusCustomOpen)dom.statusText.focus();
  });
  dom.armHours.addEventListener("change",()=>{setJs8Setting("armHours",Number(dom.armHours.value)||1);if(currentJs8().auto)armUnattended("extend");});
  // The field ADDS to what is already joined; it never replaces it. Anything else would
  // mean that picking a second name from the autocomplete silently unjoins the first,
  // because a datalist completes the whole field value rather than the word being typed.
  dom.groupAddForm.addEventListener("submit",event=>{
    event.preventDefault();
    const typed=dom.groups.value.trim();
    if(!typed)return;
    // Only what was TYPED is held to the sendable list. Merging first would re-judge a
    // custom group that a stored profile is legitimately carrying and delete it the
    // moment the operator joined anything else.
    // No sendable list any more: stage 2 can transmit to any well-formed name, so the
    // only refusals left are bad syntax, a gateway, an always-joined name and the cap.
    const added=Js8Settings.validateGroups(typed);
    const merged=Js8Settings.validateGroups([...selectableGroups(),...added.groups]);
    setJs8Setting("groups",merged.groups);
    dom.groups.value="";
    renderGroupsHint({rejected:[...added.rejected,...merged.rejected]});
    renderGroupPanel(); renderActivity(); renderControls();
  });
  // One click joins, the same click again leaves.
  dom.groupPanelGrid.addEventListener("click",event=>{
    const pill=event.target.closest("[data-group]");
    if(!pill)return;
    const group=pill.dataset.group;
    if(pill.getAttribute("aria-pressed")==="true")leaveGroup(group); else joinGroup(group);
  });
  for(const button of [dom.groupsButton,dom.stationGroupsButton])
    button.addEventListener("click",()=>toggleGroupPanel(button));
  // Clicking away closes it, like the brand panel and the frequency menu.
  document.addEventListener("click",event=>{
    if(dom.groupPanel.hidden)return;
    if(event.target.closest("#groupPanel")||event.target.closest(".group-button"))return;
    closeGroupPanel();
  });
  dom.inboxRefresh.addEventListener("click",()=>{loadInbox();renderInbox();});
  dom.inboxQueryMsgs.addEventListener("click",queryStoredMessages);
  // One delegated handler: the rows are rebuilt on every decode, so per-row
  // listeners would be attached and thrown away several times a minute.
  dom.inboxRows.addEventListener("click",event=>{
    const action=event.target.closest("[data-msg-action]");
    const call=event.target.closest("[data-call]");
    // Mail another station holds for us: fetch it by hand (this works with AUTO
    // off -- the operator clicking IS the attendance) or drop the pointer.
    const pickup=event.target.closest("tr[data-pickup-key]");
    if(pickup){
      const entry=mailWaiting.get(pickup.dataset.pickupKey);
      if(!entry)return;
      if(action&&action.dataset.msgAction==="fetch"){
        const refused=fetchWaitingMail(entry.station,js8Clock.now(),{manual:true});
        if(refused)console.info("[msgbox] fetch refused:",refused);
      }else if(action&&action.dataset.msgAction==="forget"){
        clearMailWaiting(entry.station,entry.id);
      }else if(call)chooseCall(call.dataset.call);
      return;
    }
    const row=event.target.closest("tr[data-msg-id]");
    if(!row)return;
    const id=Number(row.dataset.msgId);
    if(action){
      if(action.dataset.msgAction==="delete")deleteMsg(id);
      else if(action.dataset.msgAction==="sendnow"){
        // Deferring is not a prison sentence: the operator can always overrule
        // the wait. Manual, so it does not need arming.
        const record=inboxStore.byId(id);
        if(record){
          const refused=sendDeferredTo(record.to,js8Clock.now(),{manual:true});
          if(refused)console.info("[msgbox] send now refused:",refused);
        }
      }
      else if(action.dataset.msgAction==="reply"){
        const record=inboxStore.byId(id);
        // chooseCall() also opens the reply section and focuses the message
        // field, which is the whole point of answering from here.
        if(record){markMsgRead(id);chooseCall(record.from);}
      }
      return;
    }
    // A click on the callsign selects the station like everywhere else; anywhere
    // else on the row is the read confirmation.
    markMsgRead(id);
    if(call)chooseCall(call.dataset.call);
  });
  if(dom.inboxFilters)dom.inboxFilters.addEventListener("click",event=>{
    const button=event.target.closest("[data-msgbox-filter]");
    if(!button)return;
    msgBoxFilter=button.dataset.msgboxFilter;
    renderInbox();
  });
  if(dom.inboxUndoButton)dom.inboxUndoButton.addEventListener("click",undoDeleteMsg);
  dom.cqRepeat.addEventListener("change",()=>{setJs8Setting("cqRepeatMin",Number(dom.cqRepeat.value)||0);renderCqState();});
  dom.hbEnabled.addEventListener("change",()=>{setJs8Setting("hb",dom.hbEnabled.checked);applyHeartbeatSettings();});
  dom.hbAck.addEventListener("change",()=>{setJs8Setting("hbAck",dom.hbAck.checked);applyHeartbeatSettings();});
  dom.hbMinutes.addEventListener("change",()=>{setJs8Setting("hbMinutes",Number(dom.hbMinutes.value)||60);applyHeartbeatSettings();});
  dom.autoReply.addEventListener("change",()=>{
    setJs8Setting("auto",dom.autoReply.checked);
    armUnattended(dom.autoReply.checked?"arm":"revoke");
  });
  if(dom.alertBeep)dom.alertBeep.addEventListener("change",()=>{
    setJs8Setting("alertBeep",dom.alertBeep.checked);
    // Ticking the box IS a user gesture, so this is the one moment the browser
    // will let audio start. Sounding it here doubles as the proof that it works,
    // instead of leaving the operator to wonder until the next call arrives.
    if(dom.alertBeep.checked)alertBeep();
  });
  dom.txGain.addEventListener("change",()=>{const value=state.settingsDraft.txGain===null?dom.txGain.value:state.settingsDraft.txGain;state.settingsDraft.txGain=null;setJs8Setting("txGain",Number(value)||.25);});
  dom.txSafety.addEventListener("change",()=>setJs8Setting("txSafetyAccepted",dom.txSafety.checked));
  dom.resetSettings.addEventListener("click",()=>{const reset=Js8Settings.reset(localStorage);settings=reset.settings;state.settingsDraft={txGain:null};state.activeMode=settings.activeModem;dom.storageState.textContent=reset.label;applySettingsToRuntime();renderActivity();renderControls();closeTimetablePopover();if(!dom.freqTimetablePanel.hidden)renderTimetableGrid();reconcileTimetable();});
  if(dom.promoteSettings)dom.promoteSettings.addEventListener("click",async()=>{
    dom.promoteSettings.disabled=true;
    dom.promoteState.textContent="Saving…";
    const ok=await promoteStationProfile();
    dom.promoteState.textContent=ok?"Saved — every device sees this now."
      :"Could not save it to the interface.";
    if(ok&&dom.promoteRow)dom.promoteRow.hidden=true;
    dom.promoteSettings.disabled=false;
  });
  dom.startupRetry.addEventListener("click",()=>location.reload());
  dom.heartbeat.addEventListener("click",()=>{if(!dom.heartbeat.disabled)startHeartbeat();});
  dom.tune.addEventListener("click",()=>{if(!dom.tune.disabled)toggleTune();});
  dom.composer.addEventListener("submit",event=>{event.preventDefault();const text=dom.message.value.trim();if (!text || dom.send.disabled)return;dom.message.value="";renderControls();startTx(text);});
  // A button, not a checkbox: a switch that survives one message is how the next
  // one gets parked by accident.
  if(dom.sendLater)dom.sendLater.addEventListener("click",()=>{
    const text=dom.message.value.trim();
    if(!text||dom.sendLater.disabled)return;
    const refused=deferMessage(state.selectedCall,text);
    if(refused){dom.sendLater.title=`Refused: ${refused}`;return;}
    dom.message.value="";
    renderControls();persistSession();
    if(dom.inboxSection)dom.inboxSection.open=true;
  });
  dom.message.addEventListener("input",()=>{renderControls();persistSession();});
  dom.message.addEventListener("keydown",event=>{if(event.key!=="Enter" || event.isComposing)return;event.preventDefault();if(!dom.send.disabled)dom.composer.requestSubmit();});
  // Resend a transmission that was interrupted by leaving mid-frame: restage the
  // raw text in the composer (never auto-transmit) so the operator sends it when
  // audio and the decoder are warm again.
  dom.chat.addEventListener("click",event=>{const send=event.target.closest("[data-resend-id]");if(send){resendOutgoing(send.dataset.resendId);return;}const button=event.target.closest("[data-resend-text]");if(!button)return;dom.message.value=button.dataset.resendText;renderControls();persistSession();dom.message.focus({preventScroll:true});const end=dom.message.value.length;dom.message.setSelectionRange(end,end);});
  // RESEND in the feed transmits; it does not merely restage the text. The row already
  // passed through the composer once, and the queue is what keeps the click from
  // colliding with a frame that is still on air.
  dom.traffic.addEventListener("click",event=>{
    // The button is a sibling of the <strong data-call>, not a child, so the
    // callsign handler registered earlier on this same element already ignores it.
    // stopPropagation is kept anyway, exactly as RESEND does: it costs nothing and
    // it stops a future ancestor handler from acting on a click that was a send.
    const answer=event.target.closest("[data-reply-call]");
    if(answer){event.stopPropagation();if(!answer.disabled)replyToCq(answer.dataset.replyCall,answer.dataset.replyText);return;}
    const button=event.target.closest("[data-resend-id]");if(!button)return;event.stopPropagation();resendOutgoing(button.dataset.resendId);});
  // The signal stripe's tooltip is written on hover rather than baked into the feed:
  // renderActivity() only runs when the decoder reports new activity, so on a dead band a
  // pre-rendered "4 min" would sit there for half an hour. A one-second tick rewriting a
  // hundred titles was the alternative, on the page whose encoder must not be kept waiting.
  // Hover is the only moment the text is read, so it is the only moment worth computing.
  dom.traffic.addEventListener("mouseover",event=>{
    const stripe=event.target.closest(".signal-stripe");
    if(!stripe)return;
    const offsetHz=Number(stripe.dataset.stripeOffset)||0;
    const widthHz=Number(stripe.dataset.stripeWidth)||0;
    const slotUtcMs=Number(stripe.dataset.stripeSlot)||0;
    const snr=stripe.dataset.stripeSnr;
    const parts=[`${offsetHz}–${offsetHz+widthHz} Hz`,`${widthHz} Hz wide`];
    if(slotUtcMs)parts.push(`${age(slotUtcMs)} ago`);
    // Own transmissions never carry an SNR: we do not hear ourselves. The field is left
    // out rather than shown as a dash, which would read as "measured, and it was nothing".
    if(snr!==undefined)parts.push(`SNR ${signed(Number(snr))} dB`);
    stripe.title=parts.join(" · ");
  });
  dom.abort.addEventListener("click",()=>activeEncoder&&activeEncoder.abort());
  dom.logQso.addEventListener("click",()=>{ if(dom.logQso.dataset.action==="view")openJs8Log(); else handleLogQso(); });
  window.addEventListener("focus",refreshJs8Log);
  document.querySelectorAll("details[data-section]").forEach(details=>details.addEventListener("toggle",()=>{settings.ui.disclosures[details.dataset.section]=details.open;persistSettings(false);}));
  // Blocked entities are hidden everywhere, so the on-demand render of the disclosure has
  // to filter exactly like renderActivity does.
  dom.stationMapSection.addEventListener("toggle",()=>{if(dom.stationMapSection.open)renderStationMap((state.activity.calls||[]).filter(item=>!isBlockedCall(item.call)));});
  dom.stationMapLinks.addEventListener("click",()=>{
    state.hearingLinksVisible=state.hearingLinksVisible===false;
    renderStationMap((state.activity.calls||[]).filter(item=>!isBlockedCall(item.call)));
    persistSession();
  });
  if(dom.stationMapLog)dom.stationMapLog.addEventListener("click",()=>{
    state.mapLogScale=state.mapLogScale!==true;
    renderStationMap((state.activity.calls||[]).filter(item=>!isBlockedCall(item.call)));
    persistSession();
  });
  window.addEventListener("resize",resizeWaterfall);
  window.addEventListener("beforeunload",confirmJs8Leave);
  dom.sessionTakeover.addEventListener("click",()=>{dom.sessionTakeover.disabled=true;acquireJs8Session(true).then(won=>{if(won)location.reload();else dom.sessionTakeover.disabled=false;});});
  window.addEventListener("pagehide",()=>{flushSession();if(activeEncoder)activeEncoder.abort();stopAudio();releaseJs8Session();});
  document.addEventListener("visibilitychange",()=>{if(document.hidden&&activeEncoder)activeEncoder.abort();});
  // Escape inside a modal belongs to that dialog. Without this guard, dismissing
  // the APRS parameter popup would also abort a transmission already on air.
  addEventListener("keydown",event=>{if(event.key==="Escape"){if(document.querySelector("dialog[open]"))return;if(activeEncoder)activeEncoder.abort();closeFrequencyMenu();closeMessagePresets();closeGroupPanel();closeTimetablePanel();}});
}

// Callsign and locator belong to the station, not to this browser. The interface
// wins; this browser's copy is a cache. The one exception is an interface that
// has never been given a callsign while this browser has one -- that is the
// operator's own setting from before identity moved, so it is pushed up rather
// than thrown away, and only ever into an empty station.
async function syncStationIdentity() {
  if(!window.StationIdentity)return;
  const local=()=>{const js8=currentJs8();return {call:js8.myCall,grid:js8.grid};};
  const apply=changes=>{
    if(changes.call!==undefined)setJs8Setting("myCall",changes.call);
    if(changes.grid!==undefined)setJs8Setting("grid",changes.grid);
    renderControls();renderActivity();
  };
  // Armed FIRST, and unconditionally. A page that booted while the interface was
  // briefly unreachable used to give up on the identity for the whole session --
  // and a page with no callsign is one that refuses to transmit, with no sign of
  // why once the link came back.
  //
  // Adopting once was true only for as long as nobody opened SETUP: change the
  // callsign there and this page went on transmitting the old one until somebody
  // reloaded it, with nothing on screen to say so.
  window.StationIdentity.watch(local,apply);
  const station=await window.StationIdentity.read();
  if(!station)return;
  if(!window.StationIdentity.adopt(station,local(),apply))
    await window.StationIdentity.promote(station,local());
}

// The station's operating profile wins over this browser's copy, with the two
// per-machine values (this computer's clock correction, which panels are open
// here) kept back. An EMPTY station is left alone: that is what the promote
// button in the settings panel is for, and silently uploading whatever this
// browser happened to have would make the first tablet to load the page decide
// the whole station's band schedule.
async function adoptStationProfile() {
  if(!window.StationProfile)return;
  const station=await window.StationProfile.read();
  if(window.StationProfile.isEmpty(station)){
    if(dom.promoteRow)dom.promoteRow.hidden=false;
    return;
  }
  const merged=window.StationProfile.forBrowser(station,"js8",settings);
  if(!merged)return;
  const saved=Js8Settings.save(localStorage,merged);
  settings=saved.settings;
  state.activeMode=settings.activeModem;
  applySettingsToRuntime();
}

// Offered, never automatic, and only into a station that has none: this is the
// operator's own setup from before the profile moved, and the station is empty
// exactly once.
async function promoteStationProfile() {
  if(!window.StationProfile)return false;
  const station=await window.StationProfile.read();
  if(!window.StationProfile.isEmpty(station))return false;
  return window.StationProfile.write("js8",settings);
}

async function init() {
  if(!await checkLanConfiguration())return;
  // The takeover button lives inside the lock-out panel, so bindings come first
  // and the gate second -- otherwise a locked-out page has no way back in.
  bind();
  if(!await acquireJs8Session())return;
  populateModes(); loadTxModule();
  await syncStationIdentity();
  await adoptStationProfile();
  if(!hasSeenTrxHelp())openTrxHelp("first");
  for (const details of document.querySelectorAll("details[data-section]"))
    if (Object.prototype.hasOwnProperty.call(settings.ui.disclosures,details.dataset.section)) details.open=settings.ui.disclosures[details.dataset.section];
  dom.storageState.textContent=loaded.label;
  if(!TEST_MODE)restoreSession(); // tests drive restore explicitly through __dataTest
  renderStartup(); selectMode(state.activeMode); resizeWaterfall(); renderActivity(); renderDiagnostics();
  if(sessionRestored){renderConversation();if(state.selectedCall)dom.reply.open=true;}
  restoreFileTransfers();
  refreshJs8Log();
  scheduler.every("sessionPing",SESSION_PING_MS,pingJs8Session);
  scheduler.every("utcClock",250,()=>{dom.utcClock.textContent=`UTC ${new Date().toISOString().slice(11,19)}`;});
  renderRhythm(); scheduler.every("rhythm",100,renderRhythm);
  // The station's calibration table. Read once here and re-read before every
  // write; a stale copy costs at most an older level or a false "not
  // calibrated", never a level in the wrong direction.
  createGainCal();
  // The plan lives in the same file as the table, so it arrives with it. reload()
  // adopts whatever the station stored -- or seeds a usable first plan, because an
  // empty grid has nothing to tick and RUN can then only refuse.
  gainStore.load().then(()=>{renderResolvedGain(); if(gainPlan)gainPlan.reload();});
  // The calibration carrier has its own pacing driver, so it needs its own pump
  // and its own meter feed. Both are no-ops unless it is keying.
  scheduler.every("gainCal",500,()=>{
    if(!gainCal)return;
    gainCal.tick();
    if(state.calRunning)
      gainCal.noteMeters({powerMeterRaw:state.radio.powerMeterRaw, swr:state.radio.swr});
    // The plan's own pump is driven by intents and by what the radio answers, never by
    // this timer -- a hidden tab throttles timers and a run must not care. tick() only
    // redraws, and only while a question is up, so the waited time stays honest without
    // rewriting the grid under the operator's fingers.
    if(gainPlan)gainPlan.tick();
  });
  pollRadio(); scheduler.every("pollRadio",500,pollRadio);
  scheduler.every("txQueue",1000,()=>{drainTxQueue();renderTxQueue();renderRetryCountdowns();});
  // Audio windows normally age out partial receptions inside the worker; when audio stops
  // for good no window is produced, and without this tick the torso would never reach
  // messages[] to be persisted. Only finalizations post an activity change, so a quiet
  // band costs one postMessage per second and no re-render.
  scheduler.every("reassembly",1000,()=>{
    if(activeDecoder && activeDecoder.expire)activeDecoder.expire(js8Clock.now());
  });
  scheduler.every("heartbeat",5000,()=>{checkHeartbeat();renderHeartbeatState();});
  // Group mail is the one record with a clock on it. A minute is often enough: the TTL is
  // a day, and expiring visibly is the point, not expiring promptly.
  scheduler.every("groupMail",60000,()=>{
    if(inbox.expireGroupMail(js8Clock.now())){renderInbox();syncInbox();}
  });
  scheduler.every("cqRepeat",5000,checkCqRepeat);
  pollUnattended().then(()=>reconcileUnattended("page load")); scheduler.every("unattended",5000,pollUnattended);
  renderTimetableButton(); scheduler.every("freqTimetable",5000,reconcileTimetable); reconcileTimetable();
  applyHeartbeatSettings();
  loadInbox();
  renderInbox();
  setMasterTick(TICK_IDLE_MS);
  if (TEST_MODE) self.__dataTest={
    // Read-only views the RF-power checks need: the stored choice and what
    // the poll last read back, neither of which is reachable from the DOM.
    js8Settings(){return currentJs8();},
    radioState(){return {...state.radio};},
    setActivity(activity){state.testActivityLocked=true;applyDecoderActivity(activity);renderActivity();},
    setRadioFrequency(frequency){state.radio.frequency=Number(frequency)||0;if(selectActivityFrequency(state.radio.frequency))renderActivity();renderHeader();renderControls();},
    setRadioConnection(connected,lanStatus=connected?"linked":"disconnected"){state.radio.connected=Boolean(connected);state.radio.lanStatus=lanStatus;renderHeader();renderControls();},
    setAudioLive(live){state.lastAudioMs=live?performance.now():0;renderHeader();},
    activityCounts(){return {messages:state.activity.messages.length,calls:state.activity.calls.length};},
    setRadioMode(mode){state.radio.mode=mode;renderHeader();},
    setRadioPower(rfPower,rfPowerSeen=true,radioName=""){state.radio.rfPower=Number(rfPower)||0;state.radio.rfPowerSeen=rfPowerSeen===true;state.radio.radioName=radioName;renderHeader();},
    setRadioTx(tx){state.radio.tx=Boolean(tx);renderHeader();},
    ttSlotNow(){return slotIndexNow();},
    ttSet(index,hz,band){setTimetableSlot(Number(index),Number(hz),band||null);},
    ttEnable(on){setTimetableEnabled(Boolean(on));},
    ttTick(){reconcileTimetable();},
    ttRuntime(){return {appliedSlotIndex:ttRuntime.appliedSlotIndex,appliedHz:ttRuntime.appliedHz,appliedBand:ttRuntime.appliedBand};},
    ttButton(){return {text:dom.freqTimetableValue.textContent,active:dom.freqTimetableButton.classList.contains("active")};},
    ttReset(){const tt=timetable();tt.slots={};tt.enabled=false;ttRuntime.appliedSlotIndex=null;ttRuntime.appliedHz=null;ttRuntime.appliedBand=null;state.pendingFrequency=null;persistTimetable();renderTimetableButton();renderHeader();},
    feedSpectrum(samples){ingestSpectrum(samples);},
    feedAudio(samples,metadata={}){onSamples(samples,AUDIO_RATE,metadata);},
    decoderPushes(){return testDecoderPushes;},
    spectrumState(){return waterfall.state();},
    // The labels are painted on canvas, so the DOM cannot be asked whether they are right.
    // dueInMs proves the dwell is armed and how long it is without the test having to wait.
    stationLabelState(){return {visible:state.stationLabelsVisible,
      labels:state.stationLabels.map(item=>({...item})),
      armedAtMs:state.stationLabelsArmedMs,
      dueInMs:scheduler.dueIn("stationLabels")};},
    // Startup failure injection. No harness can make the radio drop the worker
    // fetch, so it asks the page to treat the modem as stalled instead. `retry`
    // is off by default because the free retry re-fetches the JSC dictionary,
    // which other checks count.
    stallModem(reason="injected stall",{retry=false}={}){
      modemEverReady=!retry; modemRetried=!retry; failModem(reason);
      return this.modemStartup();},
    modemStartup(){return {label:state.startup.label, detail:state.startup.detail,
      progress:state.startup.progress, failed:state.startup.failed,
      retryVisible:!dom.startupRetry.hidden, status:state.decoderStatus,
      gateVisible:!dom.startup.hidden};},
    selectedCall(){return state.selectedCall;},
    feedDirected(frame){handleDirectedFrame({kind:"directed",...frame});},
    txQueueState(){return txQueue.snapshot(js8Clock.now());},
    heartbeatState(){return heartbeat.snapshot(js8Clock.now());},
    relayState(){return relay.snapshot(js8Clock.now());},
    inboxState(){return inbox.snapshot();},
    myGroups(){return myGroups();},
    chooseCall(call){chooseCall(call);},
    feedInbox(frame){handleDecodedFrame({kind:"directed",...frame});},
    feedAssembled(message){dispatchAssembledMessage(message);},
    txStatus(){return state.txStatus;},
    // Automatic TX gain. The limiter is driven by tx-level frames, which no
    // harness can make a real radio send, so the control path is fed directly --
    // through the same function the WebSocket calls, not around it.
    gainState(){return {resolved:resolvedGain(), frame:frameGain({}),
                        guard:{active:alcGuard.active, gain:alcGuard.gain},
                        trim:state.alcTrim||null,
                        text:dom.calResolved?dom.calResolved.textContent:"",
                        amber:Boolean(dom.calResolved&&dom.calResolved.classList.contains("uncalibrated"))};},
    gainReload(){return gainStore.load().then(()=>{renderResolvedGain();return gainStore.doc;});},
    alcBegin(){beginAlcGuard();return alcGuard.active;},
    alcFeed(message){onAudioControl({type:"tx-level",...message});return alcGuard.gain;},
    alcEnd(){endAlcGuard();return state.alcTrim||null;},
    // Failure injection. The harness cannot key a radio, and clicking ABORT produces an
    // OPERATOR abort -- precisely the one case that earns no RESEND -- so without these
    // hooks not a single resend path could be exercised in a browser.
    txFail(reason,status="fault"){
      const item=state.activeOutgoing||state.lastOutgoing;
      if(!item)return false;
      const text=String(reason||"injected fault");
      if(activeEncoder&&activeEncoder.abort)activeEncoder.abort(text);
      stopTxTicking();
      // The abort above may already have classified the failure; start from a clean slate
      // so the injected reason, not the abort, decides the verdict.
      if(item.retryQueueId){txQueue.remove(item.retryQueueId);item.retryQueueId=0;item.retryUntilMs=0;}
      state.txStatus=status==="aborted"?"aborted":"fault";
      item.status=status; item.activeFraction=0; item.outcome="";
      noteTxOutcome(item,status,text);
      state.activeOutgoing=null;
      renderControls();renderConversation();renderTxPayload();renderActivity();persistSession();
      return true;
    },
    txDropLink(){onAudioStatus({type:"closed"});return true;},
    outgoingRows(){return state.outgoingLog.map(item=>({id:item.id,status:item.status,
      outcome:item.outcome||"",attempts:Number(item.attempts)||1,text:item.text,to:item.to||"",
      kind:item.recipe?item.recipe.kind:"",frequencyHz:Number(item.frequencyHz)||0,
      retryUntilMs:Number(item.retryUntilMs)||0,resendable:txResendable(item)}));},
    resendRow(id){return resendOutgoing(id);},
    // Own-TX feed rows without going through the encoder, so a restored log -- including
    // one written before the transmit tone was recorded -- can be put on screen and read.
    setOutgoingLog(items){state.outgoingLog=items.map(item=>({...item}));renderActivity();},
    trafficTxRows(){return [...dom.traffic.querySelectorAll(".message-tx")].map(node=>({
      status:node.dataset.txStatus||"",attempts:Number(node.dataset.txAttempts)||1,
      emitted:node.classList.contains("tx-emitted"),
      resend:Boolean(node.querySelector("[data-resend-id]")),
      struck:Boolean(node.querySelector(".tx-copy-failed")),
      text:node.querySelector(".message-text")?.textContent||"",
      sent:node.querySelector(".tx-copy-sent")?.textContent||""}));},
    setItemFrequency(id,hz){const item=outgoingItemById(id);if(!item)return false;item.frequencyHz=Number(hz)||0;renderActivity();return true;},
    txQueueClear(){return txQueue.clear("test");},
    drainNow(){drainTxQueue();renderTxQueue();renderRetryCountdowns();return true;},
    feedRelay(frame){handleDecodedFrame({kind:"directed",command:">",...frame});},
    feedHeartbeat(frame){handleDecodedFrame({kind:"heartbeat",...frame});},
    resetAutoReplyLock(){autoReply.lastDirectedFrameMs=0;},
    txCaptured(){return txCaptured.slice();},
    clearTxCaptured(){txCaptured.length=0;},
    clearTxQueue(){const dropped=txQueue.clear("test");renderTxQueue();return dropped;},
    renderInboxNow(){renderInbox();},
    unattendedPoll(){return pollUnattended();},
    autoExpiry(){return state.autoExpiryAt;},
    // EMAIL has no entry in the Mode selector any more, so the composer can only
    // be reached from here -- the module still ships and stays under test.
    setTxSessionMode(mode){state.txSessionMode=mode;renderControls();},
    storeInboxDirect(rec){inboxStore.add({type:rec.type||"STORE",from:rec.from,to:rec.to,
      text:rec.text,atMs:Number(rec.atMs)||Date.now(),state:rec.state||"",delivered:false});renderInbox();},
    msgBoxState(){return {...msgBox.counts(),filter:msgBoxFilter,full:msgBoxFull,
      undo:msgBoxUndo?msgBoxUndo.id:0,title:document.title,
      waitingMail:[...mailWaiting.values()].map(item=>({station:item.station,id:item.id,
        attempts:(mailAttempts.entry(mailKey(item.station,item.id))||{attempts:0}).attempts}))};},
    msgBoxFetch(station){return fetchWaitingMail(String(station||"").toUpperCase(),
      js8Clock.now(),{manual:true});},
    msgBoxDefer(to,text){return deferMessage(to,text);},
    msgBoxSendDeferred(station,options){return sendDeferredTo(String(station||"").toUpperCase(),
      js8Clock.now(),options||{});},
    msgBoxDeferred(){return msgBox.items("waiting").map(item=>({id:item.id,to:item.to,
      text:item.text,state:item.state,attempts:Number(item.attempts)||0,via:item.via||""}));},
    msgBoxPushHeld(station,options){return pushHeldMailTo(String(station||"").toUpperCase(),
      js8Clock.now(),options||{});},
    msgBoxParkVia(station,options){return parkDeferredVia(String(station||"").toUpperCase(),
      js8Clock.now(),options||{});},
    msgBoxHeardBy(station){return stationsHeardBy(station,js8Clock.now());},
    msgBoxSetFilter(filter){msgBoxFilter=filter;renderInbox();},
    autoReplyState(){return {...autoReply.snapshot(),
      restrictions:restrictions.snapshot(js8Clock.now())};},
    fileProtocol(){return {prepared:binState.prepared,active:binState.active,lastProtocol:binState.lastProtocol};},
    receiveFileMessage(item){return handleFileActivityMessage(item);},
    snapshotBuild(){return buildSessionSnapshot();},
    snapshotWrite(){writeSessionSnapshot();},
    snapshotRestore(){const ok=restoreSession();renderStartup();renderActivity();renderConversation();return ok;},
    // JS8CALL log affordances (TEST_MODE only) — drive the auto/manual logging path.
    setMyCall(call){setJs8Setting("myCall",String(call||"").toUpperCase());renderActivity();renderConversation();},
    selectCallForLog(call){state.selectedCall=String(call||"").toUpperCase();renderConversation();},
    pushMessage(msg){state.activity.messages.push(msg);},
    pushOutgoing(call,text,status){const c=String(call||"").toUpperCase();(state.conversations[c]||(state.conversations[c]=[])).push({direction:"outgoing",time:"00:00:00",text,sourceText:text,status:status||"completed"});},
    autoLogSweep(){maybeAutoLogQsos();},
    logQsoManual(call){state.selectedCall=String(call||"").toUpperCase();return logQsoFor(state.selectedCall,{manual:true});},
    refreshJs8LogNow(){return refreshJs8Log();},
    // Seeds the per-band logged set the way a finished QSO would, without going
    // through IndexedDB. What it exercises is the RENDERING rule -- a worked call
    // is dimmed in the feed -- not the write path, which refreshJs8Log() owns and
    // which this does not touch.
    markLogged(call){state.loggedCalls.add(loggedKey(String(call||"").toUpperCase(),
      bandOf(state.radio.frequency)));renderActivity();},
    js8LogState(){return {log:state.js8Log?{id:state.js8Log.id,contestName:state.js8Log.contestName}:null,logged:[...state.loggedCalls],inFlight:[...state.autoLogInFlight]};},
    logButton(){return {text:dom.logQso.textContent,action:dom.logQso.dataset.action||"",disabled:dom.logQso.disabled,title:dom.logQso.title};},
    async logQsos(){const log=await findJs8Log();return log?await window.LogDB.getQsosForLog(log.id):[];}
  };
}

// init() is one long chain of awaits, and everything able to REPORT a fault sits
// at the end of it: renderStartup(), selectMode() -- which is what arms the modem
// stall watchdog -- and setMasterTick(), which starts the only clock that watchdog
// can ever fire on. So anything that threw or never resolved above them left the
// operator on the static "Loading JS8Call-ICOM modem" / "0%" markup in data.html
// for ever, with RETRY hidden, because no failure had been declared yet.
//
// That is precisely what a browser running a CACHED data.js against a freshly
// served data.html did on 2026-08-11: the older script looked up an element id
// the new page had renamed, and the page died between the session claim and the
// modem without a word on screen. The gate has to be able to speak for the whole
// of init(), not just for the part after the modem starts.
function failStartup(error) {
  const message = String((error && error.message) || error || "unknown error");
  console.error("[js8] startup failed:", error);
  state.startup = {ready:false, failed:true, progress:0,
    label:"JS8LAN could not start",
    // Naming the stale-script case earns its line: it is the one cause the
    // operator can clear unaided, and RETRY cannot -- an ordinary reload serves
    // the very script that just broke, straight back out of the browser cache.
    detail:`${message} — if this followed a firmware update, reload with Ctrl+Shift+R.`};
  // renderStartup() is the normal painter, but it leans on the cached elements
  // and, for a working RETRY, on bind() having run. A failure this early can
  // predate both, so fall back to painting the gate by hand.
  try { renderStartup(); }
  catch (_error) {
    document.body.classList.add("startup-pending");
    if (dom.startup) dom.startup.hidden = false;
    if (dom.startupLabel) dom.startupLabel.textContent = state.startup.label;
    if (dom.startupDetail) dom.startupDetail.textContent = state.startup.detail;
    if (dom.startupRetry) dom.startupRetry.hidden = false;
  }
  if (dom.startupRetry) dom.startupRetry.onclick = () => location.reload();
}

init().catch(failStartup);
