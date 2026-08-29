"use strict";

// JS8Call page controller. Modem DSP lives in a Worker; this file owns only the
// public modem contracts, radio/audio adapters and DOM projection.

const PAGE_PARAMS = new URLSearchParams(location.search);
const TEST_MODE = PAGE_PARAMS.has("test");
const ASSET_REV = "66104543";
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
// Every request this page makes carries an abort deadline. A fetch with no
// timeout can sit on a half-open connection for many minutes after a WiFi
// burst loss; each poller then parks one of the browser's ~6 connections per
// origin until the pool is full and even a reload queues behind dead requests
// -- the blinking OFFLINE that only closing the tab fixed. The deadline must
// clear the longest LEGITIMATE server delay: port 80 is deliberately deferred
// for up to ~5 s around a TX slot (txCriticalNow), so 4 s would fake a radio
// disconnect on every transmission. Flash-writing POSTs get a longer leash
// because LittleFS appends are themselves deferred out of TX windows.
const FETCH_TIMEOUT_MS = 8000, FETCH_FLASH_TIMEOUT_MS = 12000;
const fetchDeadline = (ms = FETCH_TIMEOUT_MS) => AbortSignal.timeout(ms);
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
  gpsBeacon:$("gpsBeaconButton"), gpsBeaconGrid:$("gpsBeaconGrid"),
  tune:$("tuneButton"), tuneLabel:$("tuneLabel"), tuneOffset:$("tuneOffset"),
  sessionCall:$("sessionCall"), sessionMeta:$("sessionMeta"), abort:$("abortButton"), logQso:$("logQsoButton"),
  txSessionMode:$("txSessionMode"), txSessionModeHint:$("txSessionModeHint"),
  txPayload:$("txPayload"),
  chatSession:$("chatSession"), emailSession:$("emailSession"), binSession:$("binSession"),
  chat:$("chatThread"), composer:$("composer"), message:$("messageInput"), send:$("sendButton"),
  viaRoutes:$("viaRoutes"), viaBadge:$("viaBadge"), viaDetails:$("viaDetails"),
  viaSummary:$("viaSummary"), viaList:$("viaList"),
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
  aprsTrackingRow:$("aprsTrackingRow"), aprsTracking:$("aprsTracking"),
  aprsRecentCalls:$("aprsRecentCalls"),
  traffic:$("traffic"), trafficSummary:$("trafficSummary"), stationRows:$("stationRows"),
  trafficHistogram:$("trafficHistogram"),
  trafficSection:document.querySelector('[data-section="traffic"]'),
  trafficFilter:document.querySelector(".traffic-filter"),
  trafficClear:document.querySelector("[data-traffic-clear]"),
  trafficHide:document.querySelector("[data-traffic-hide]"),
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
  txQueueState:$("txQueueState"), alcTrimState:$("alcTrimState"),
  hbEnabled:$("hbEnabled"), hbMinutes:$("hbMinutes"), hbAck:$("hbAck"), hbState:$("hbState"),
  groups:$("groups"), groupNames:$("groupNames"), groupsHint:$("groupsHint"),
  groupsButton:$("groupsButton"), stationGroupsButton:$("stationGroupsButton"),
  groupPanel:$("groupPanel"), groupPanelGrid:$("groupPanelGrid"), groupAddForm:$("groupAddForm"),
  cqRepeat:$("cqRepeat"), cqState:$("cqState"),
  infoText:$("infoText"), statusText:$("statusText"), statusPreset:$("statusPreset"),
  statusPreview:$("statusPreview"), autoReply:$("autoReply"), alertBeep:$("alertBeep"),
  aprsGate:$("aprsGate"), aprsGateCall:$("aprsGateCall"), aprsGatePass:$("aprsGatePass"),
  aprsGateHost:$("aprsGateHost"), aprsGatePort:$("aprsGatePort"), aprsGateState:$("aprsGateState"),
  inboxRows:$("inboxRows"), inboxSummary:$("inboxSummary"), inboxQueryMsgs:$("inboxQueryMsgs"), inboxRefresh:$("inboxRefresh"),
  inboxFilters:$("msgBoxFilters"), inboxUndo:$("msgBoxUndo"), inboxUndoButton:$("msgBoxUndoButton"),
  inboxHint:$("msgBoxHint"), inboxSection:document.querySelector('[data-section="inbox"]'),
  msgBoxAlert:$("msgBoxAlert"), msgBoxAlertText:$("msgBoxAlertText"), msgBoxAlertPreview:$("msgBoxAlertPreview"),
  sendLater:$("sendLaterButton"),
  armHours:$("armHours"), autoState:$("autoState"),
  resetSettings:$("resetSettings"), settingsSummary:$("settingsSummary"), settingsFlags:$("settingsFlags"),
  diagnosticSummary:$("diagnosticSummary"), diagnostics:$("diagnostics"),
  decodeTelemetry:$("decodeTelemetry"),
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
  fetch("/msgbox", {method: "POST", signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS),
    headers: {"Content-Type": "text/plain"}, body})
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
  fetch("/msgbox", {cache: "no-store", signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS)})
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
// The JS8 -> APRS-IS gate. Everything it decides is logged: the exact frame that
// left the station is otherwise invisible the moment the row scrolls away, and
// "why did OK2ABC not appear on aprs.fi" has to be answerable afterwards.
const aprsGate = new Js8AprsGate.Js8AprsGate({storage: localStorage,
  onEvent: event => console.info("[js8-aprs-gate]", event.type,
    event.entry ? `${event.entry.from} ${event.entry.kind}` : "", event.detail || "")});
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
  // The chosen route through an intermediary, and the display order frozen when the
  // list was opened. Both are deliberately ephemeral: they are read from traffic that
  // keeps moving, so a route restored after a reload would be a recommendation made
  // from evidence nobody has re-checked. A pinned route lives in the MSG BOX record.
  viaRoute:null,   // {target, via, chosenAtMs}
  viaOrder:[],     // callsigns, in the order the open panel first showed them
  viaOpen:null,    // operator's manual open/close, null = derive it
  viaDropped:"",   // route a self-addressed draft displaced, so the hint can say so
  txSessionMode:"CHAT", audioDb:-90, tuneActive:false, spectrumWasTransmitting:false,
  help:{incompatibleActive:false},
  lanConfig:{checked:false, ready:false, detail:"", slot:0},
  ownCallAttention:{call:"", messages:new Set()},
  // Rows addressed to us, so the beep fires once per message. `seeded` keeps the
  // first render after a reload silent: everything on screen is history, and a
  // burst of tones for messages that arrived while the tab was shut is noise.
  answerAttention:{call:"", messages:new Set(), seeded:false},
  activeOutgoing:null, lastOutgoing:null, outgoingLog:[],
  blockedDxccList:[],
  settingsDraft:{txGain:null}, reconnectPending:false,
  js8Log:null, loggedCalls:new Set(), autoLogInFlight:new Set(),
  autoExpiryAt:null, // epoch ms when unattended arming lapses (null = unknown/disarmed)
  // RX audio datagrams the radio sent and the LAN client never got, straight from
  // the firmware's own counter. It rides in on the /unattended poll the page already
  // makes; null means that firmware does not report it. It is the only thing that
  // separates loss on the radio->ESP32 hop from loss on the ESP32->browser one,
  // because both reach the browser looking identical: a jump in the sample counter.
  audioRxDropped:null,
  // Link-latency diagnostics (read-only, see renderWebRttRow/renderRadioRttRow): browser-measured
  // /state fetch time and AUD1 application-ping RTT. null until first sample.
  pageRttMs:null, aud1PingRttMs:null,
};
let audioSource = null, activeDecoder = null, activeEncoder = null;
// Whether the modem ever came up in this page's life, and whether the one free
// retry has been spent. Both are per page load: a retry loop would hide the
// failure it is retrying.
let modemEverReady = false, modemRetried = false;
let radioPollInFlight = false;
// Consecutive /state poll failures. One failed poll must not flip the page
// OFFLINE, and above all must not tear down a healthy AUD1 socket: stopAudio()
// forces a new stream and a new media epoch, which resets the decoder and costs
// 15-30 s of RX -- a far bigger loss than the 500 ms of stale telemetry a
// missed poll leaves behind. And while samples are arriving, the device is
// provably alive no matter what HTTP says, so fresh audio vetoes the teardown
// entirely and failures only count toward the threshold.
let radioPollFailures = 0;
const RADIO_POLL_OFFLINE_FAILURES = 3;
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

// Chat rows saved before they carried an absolute stamp kept only the UTC clock.
// Rebuild the stamp from the moment the snapshot was written: that time-of-day belongs
// to the save's day, or to the day before when it reads later than the save itself.
// Nothing older than 24 h is recoverable this way and nothing needs to be -- a snapshot
// is written on the way out of the page and read back on the way in.
function restoreConversationItem(item, savedAtMs) {
  const copy = {...item};
  if (Number(copy.utcMs) > 0 || !savedAtMs) return copy;
  const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(copy.time || ""));
  if (!clock) return copy;
  const saved = new Date(savedAtMs);
  let stamp = Date.UTC(saved.getUTCFullYear(), saved.getUTCMonth(), saved.getUTCDate(),
    Number(clock[1]), Number(clock[2]), Number(clock[3]));
  if (stamp > savedAtMs) stamp -= 86400000;
  copy.utcMs = stamp;
  return copy;
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
      const savedAtMs = Number(snapshot.savedAtMs) || 0;
      for (const [call, items] of Object.entries(snapshot.conversations))
        if (Array.isArray(items)) conversations[call] = items.map(item => restoreConversationItem(item, savedAtMs));
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
const gainPlanStore = new TxGainPlanStore.PlanStore({
  profile: TxGainPlanStore.PROFILE_TONE,
  bands: () => WsprCore.PRESETS.map(preset => ({band:preset.band, hz:preset.hz})),
});
// One JS8 message is several frames, each keyed separately and each with its
// level already baked in by the modulator -- so the limiter gets one reduction
// per frame and re-reads the ALC at every frame boundary. See the flag's comment
// in tx-alc-guard.js; the WSPR beacon, one streamed transmission, leaves it off.
const alcGuard = new TxAlcGuard.TxAlcGuard({levelBakedPerFrame:true});

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
    model:() => liveRadioModel(),
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
    setMode:mode => fetch(RADIO_CMD_URL,{method:"POST", signal:fetchDeadline(),
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
    resultStore:gainStore,
    planStore:gainPlanStore,
    cal:gainCal,
    model:() => liveRadioModel(),
    modelNumber:() => IcomModels.modelNumber(liveRadioModel()),
    radio:() => state.radio,
    send:async payload => {
      const response = await fetch(RADIO_CMD_URL,{method:"POST", signal:fetchDeadline(),
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
      await fetch(RADIO_CMD_URL,{method:"POST", signal:fetchDeadline(),
        headers:{"Content-Type":"application/json"},
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
      const post = payload => fetch(RADIO_CMD_URL,{method:"POST", signal:fetchDeadline(),
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
    // The plan UI's own requests inherit the deadline too; both result and plan
    // documents land on flash, so they get the longer one. A caller-supplied
    // signal still wins.
    fetchImpl:(url, options = {}) =>
      fetch(url, {signal:fetchDeadline(FETCH_FLASH_TIMEOUT_MS), ...options}),
    setModeFilter:(mode, filter) => fetch(RADIO_CMD_URL,{method:"POST", signal:fetchDeadline(),
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
  if (!outcome) return;
  // A clean message clears the indicator for the same reason it clears the
  // guard's witness: it is evidence that the level holds. Leaving the last trim
  // on screen would keep accusing a setup that has since behaved.
  if (!outcome.reduced) { state.alcTrim = null; renderControls(); return; }
  state.alcTrim = {key:outcome.key, gain:outcome.gain, startGain:outcome.startGain,
                   witnesses:outcome.witnesses,
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

// The limiter takes level off the air without asking, and it used to say so only
// through calResolved -- which sits inside a settings section nobody has open
// while transmitting, and only after a trim was written to the table, which takes
// two separate messages. A single dB, the common case, was invisible: a quieter
// second frame and no reason given. This says it beside ABORT, while it happens.
function alcTrimDb(gain, reference) {
  return gain > 0 && reference > 0 && gain < reference
    ? 20 * Math.log10(gain / reference) : 0;
}

function renderAlcTrim() {
  if (!dom.alcTrimState) return;
  const resolved = resolvedGain();
  // In flight the guard is the truth; afterwards the last outcome is, until the
  // next message replaces or clears it. The reference differs too: the guard was
  // begun from the table as it stood, and a persisted trim has since moved it.
  const live = alcGuard.active;
  const trim = state.alcTrim && state.alcTrim.key === resolved.key ? state.alcTrim : null;
  const gain = live ? alcGuard.gain : (trim ? trim.gain : 0);
  const reference = live ? resolved.gain : (trim ? trim.startGain : 0);
  const db = alcTrimDb(gain, reference);
  if (!db) { dom.alcTrimState.hidden = true; return; }
  const amount = `${Math.abs(db).toFixed(1)} dB`;
  dom.alcTrimState.textContent = `ALC -${amount}${live ? "" : " last msg"}`;
  dom.alcTrimState.title = live
    ? `The ALC limiter has taken ${amount} off the calibrated ${reference}. JS8 bakes the ` +
      `level into a whole frame, so this reaches the air from the next frame onwards.`
    : `The last message finished ${amount} below the calibrated ${reference}. ` +
      (trim && trim.needsRecalibration
        ? "Six dB down and the ALC was still acting -- recalibrate this band and power."
        : `Two messages agreeing rewrite the stored level; this was witness ` +
          `${trim ? trim.witnesses : 1} of 2. A clean message clears it.`);
  dom.alcTrimState.hidden = false;
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
  // Diagnostic RTT reply for the AUD1 ping loop (js8-aud1.js _schedulePing).
  // Recomputed here rather than read off the session object: message.t and
  // performance.now() are the same clock WsAudioSource hands the session
  // (monotonicNow), so this needs no extra plumbing through that wrapper.
  if (message && message.type === "pong") {
    state.aud1PingRttMs = performance.now() - message.t;
    return;
  }
  // One socket, two drivers, never at once. WsprTx acts on tx-ready/tx-state/
  // tx-error without checking txId, so handing every frame to both would let one
  // run's abort fault the other's idle driver.
  if (gainCal && gainCal.running) { gainCal.onControl(message); return; }
  if (!message || message.type !== "tx-level" || !alcGuard.active) return;
  const before = alcGuard.gain;
  // txId matters as much as the readings do: the firmware restarts consumed and
  // alcSeq at every frame, and without it the guard discards frame two onward.
  const after = alcGuard.noteLevel({txId:message.txId, consumed:message.consumed,
                                    alc:message.alc, alcSeq:message.alcSeq});
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
  // Propagation on the new band has nothing to do with the route chosen on the old one.
  clearViaRoute();
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

function resetSpectrumAnalyzer() { waterfall.reset(); lastSlotIndex=null; spectrumTimeline.epoch=null; }

// Pause only the visual analyser while transmitting: a monitored carrier would
// poison its AGC. RX samples must still reach the JS8 decoder because the radio
// and UI can report the RX transition late after PTT release.
//
// The waterfall used to draw only the samples that ARRIVED, so a hole in the
// stream silently closed up: the picture stayed seamless and optimistic while
// the decoder was fed silence, and the operator had no way to see why a station
// "visible in the waterfall" never decoded. Track the sample timeline the AUD1
// metadata already carries and hand every hole to the waterfall as marked gap
// rows. An epoch change is a timeline restart (WS reconnect or a wall-clock
// jump); its length in samples is unknowable across the restart, so it gets a
// fixed two-row seam rather than a fake duration. TX resets the timeline
// because the analyser is deliberately paused then -- resuming must not paint
// the pause as loss.
const spectrumTimeline = {epoch:null, nextSample:0};
function ingestSpectrum(samples, metadata) {
  if(radioTransmitting()){spectrumTimeline.epoch=null;return;}
  const first=Number(metadata ? metadata.firstSample : NaN);
  if(Number.isFinite(first)){
    const epoch=metadata.mediaEpoch;
    if(spectrumTimeline.epoch===epoch){
      const gap=first-spectrumTimeline.nextSample;
      if(gap>0)waterfall.gap(gap);
    }else if(spectrumTimeline.epoch!==null){
      waterfall.gap(HOP_SIZE*2);
    }
    spectrumTimeline.epoch=epoch;
    spectrumTimeline.nextSample=first+samples.length;
  }
  waterfall.ingest(samples);
}

// Inserted silence, split by what this station was doing while it went missing. The
// worker keeps one cumulative figure, so the split is made here: sample that figure
// once a second and put the increment in the bucket the radio was in. Any packet seen
// under PTT sends the WHOLE increment to the transmit bucket -- the split exists to
// keep our own transmissions out of the receive figure, so where it cannot tell it
// errs against TX, and a receive figure that stays large is then evidence and not an
// artefact of the operator's duty cycle.
const silenceSplit = {baseline:null, rxMs:0, txMs:0, txSeen:false};
function sampleSilenceSplit() {
  const telemetry = activeDecoder && activeDecoder.telemetry ? activeDecoder.telemetry() : null;
  const inserted = telemetry && telemetry.audio
    ? Number(telemetry.audio.insertedGapSamples8k) : NaN;
  if (!Number.isFinite(inserted)) return;
  // A counter that went backwards is a new media epoch -- the worker restarted it at
  // zero -- and carrying the old buckets across would describe two different runs as
  // one. Restart with it.
  if (silenceSplit.baseline === null || inserted < silenceSplit.baseline) {
    silenceSplit.baseline = inserted;
    silenceSplit.rxMs = 0; silenceSplit.txMs = 0; silenceSplit.txSeen = false;
    return;
  }
  const deltaMs = (inserted - silenceSplit.baseline) / 8;
  silenceSplit.baseline = inserted;
  if (silenceSplit.txSeen) silenceSplit.txMs += deltaMs;
  else silenceSplit.rxMs += deltaMs;
  silenceSplit.txSeen = false;
}

function onSamples(samples, rate, metadata) {
  state.lastAudioMs = performance.now();
  let sum=0;
  for (const value of samples) sum += value * value;
  if (radioTransmitting()) silenceSplit.txSeen = true;
  ingestSpectrum(samples, metadata);
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

// The dial frequency a band preset resolves to. Plain identity by default; an
// extended profile may substitute a per-band table shift here, which is why the
// menu, the off-dial check, the header and the timetable all read presets
// through this one accessor rather than the frozen `frequencyHz` directly, so
// the whole band table moves together or not at all.
function presetHz(preset) { return preset ? preset.frequencyHz : 0; }

// The dial frequency a timetable slot resolves to. A band slot follows the
// active preset table (so a profile shift carries it too); a custom kHz slot is
// an absolute frequency the operator typed and is left exactly as entered.
function slotDialHz(slot) {
  if (slot && slot.band) {
    const preset = Js8TrxPresets.PRESETS.find(item => item.band === slot.band);
    if (preset) return presetHz(preset);
  }
  return slot ? slot.hz : 0;
}

// A dial on none of the presets the menu offers is a band nobody is listening
// on. The menu already answers half of that by highlighting the matching preset;
// this is the other half, for the button that is on screen when the menu is not.
// Exact equality on purpose -- the same test as the `current` class below, so
// the two can never disagree about which preset the radio is on. A preset still
// being written counts as arrived: pendingFrequency is only ever one of them.
function offDialFrequency() {
  const hz=state.pendingFrequency || state.radio.frequency;
  if(!hz)return false;
  return !Js8TrxPresets.PRESETS.some(item => presetHz(item)===hz);
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
    `<button class="frequency-preset${presetHz(item)===selected?" current":""}" data-frequency="${presetHz(item)}" type="button"><strong>${item.band}</strong><span>${formatFrequency(presetHz(item))}</span></button>`).join("")}</div><footer>Dial frequencies from the bundled JS8Call source</footer>`;
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
  const dialHz=slotDialHz(slot);
  if (index===ttRuntime.appliedSlotIndex && dialHz===ttRuntime.appliedHz) {
    renderTimetableButton();
    return;
  }
  if (radioTransmitting() || !state.radio.connected) { renderTimetableButton(); return; }
  ttRuntime.appliedSlotIndex=index; ttRuntime.appliedHz=dialHz; ttRuntime.appliedBand=slot.band||null;
  renderTimetableButton();
  requestFrequency(dialHz).catch(()=>{});
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

// See IcomModels.liveRadioModel()'s own comment for why this guard exists
// (the ~1s stale-radio-name window on a live LAN-slot model swap, confirmed
// against both an IC-705 and an IC-7610). Shared with wspr.js/mercury.js so
// the fix cannot regress in one page while staying fixed in the others.
function liveRadioModel() {
  return IcomModels.liveRadioModel(state.radio);
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
  const model=liveRadioModel();
  const reported=WsprCore.fullPowerWatts(model);
  return reported ? {watts:reported, source:`reported as ${model}`} : {watts:null, source:""};
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
  // Round the same way the title below does (Math.round(percent)), so the
  // segment count and the printed number never disagree -- ceil(percent/10)
  // used to overshoot by a whole segment for almost any non-multiple-of-25.5
  // raw level (e.g. IC-7610 at 128/255=50.196% showed "50%" but lit 6/10
  // segments). Floor of 1 lit segment is kept for any power at all, so a
  // radio left on the WSPR beacon's 1 % still doesn't read as a dead
  // transmitter.
  const lit=seen && percent>0 ? Math.max(1,Math.min(10,Math.round(percent/10))) : 0;
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
// operator happens to have on the antenna socket. No TX-safety-pledge gate on
// the write itself, though (2026-08-23, operator request, for consistency with
// WSPR's own applyAutoPower() and Mercury's applyAutoTuningPower()): writing a
// power level is not transmitting. WSPR keeps its own 10 W ceiling -- that is
// WSPR's legal band limit, not a general safety cap -- JS8 and Mercury
// deliberately have none.
//
// The engine itself (auto-apply on load/reconnect, knob detection, write+
// confirm, the empty-field guard) is shared with RTTY-ICOM now
// (data/rf-power-auto.js, code-review 2026-08-28 -- this used to be a hand-
// copy independent of RTTY-ICOM's own, see that module's own header for why
// WSPR/Mercury are not callers of it). This page supplies only what is
// genuinely page-specific: JS8's own per-mode rfPercent storage, and this
// page's own radioTransmitting()/state.calRunning/state.planRunning for
// "don't write right now". data.js had no reusable command()/waitForState()
// helpers of its own (unlike rtty.js), so the two adapters below reproduce
// this page's own original fetch/poll shape exactly, just now confined to
// this one config object instead of spread across the functions this
// replaces.
const rfPowerAuto = RfPowerAuto.create({
  dom: {input: dom.rfPercent, set: dom.rfPercentSet,
        watts: dom.rfPercentWatts, state: dom.rfPercentState, field: dom.rfPowerField},
  targetPercent: () => {
    const stored = currentJs8().rfPercent;
    return Number.isFinite(Number(stored)) && Number(stored) >= 1 ? Number(stored) : null;
  },
  radio: () => state.radio,
  fullWatts: () => fullPowerScale().watts,
  formatWatts,
  blocked: () => state.calRunning || state.planRunning,
  transmitting: radioTransmitting,
  command: payload => fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
    headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)}),
  waitForState: (predicate, timeoutMs) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate(state.radio)) { clearInterval(timer); resolve(); }
      else if (Date.now() - started >= timeoutMs) { clearInterval(timer); reject(new Error("timed out")); }
    }, 100);
  }),
  onWrite: percent => setJs8Setting("rfPercent", percent),
  render: () => { renderHeader(); renderControls(); },
});

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
  renderTrxPower(connected,rfPowerAuto.renderField());
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
  reasons.push(...viaBlockReasons(needsRecipient));
  return reasons;
}

// Extension point for data-layer modules: a reason this addressee's traffic cannot go
// through the MAIL path -- store-and-forward, whether parked here or handed to a third
// station -- or "" when nothing objects. The base page never objects.
//
// A module that gives a station its own encoding does object, for two reasons that both
// stand alone. Mail is written by the mail path, not the composer, so it reaches the
// queue as source "msgbox" and the module's transmit hook never sees it. And a parked
// message is stored as it was typed in `/msgbox.jsonl` on the device, which the firmware
// serves to anyone on the LAN without authentication -- so "warn and continue" is not an
// option here, because no warning un-writes that file.
function mailPathRefusal(_target) { return ""; }

// Only the hard obstacles block a chosen route (decision 9). Stale evidence does NOT
// appear here on purpose: the reports simply stopped being renewed, which is not proof
// the path is gone, and the badge already says how old it is.
function viaBlockReasons(needsRecipient) {
  const route=needsRecipient?state.viaRoute:null;
  if(!route)return [];
  const js8=currentJs8();
  const reasons=[];
  const blockedCountry=blockedCountryForCall(route.via);
  if(blockedCountry)reasons.push(`${route.via} is blocked (${blockedCountry})`);
  if(sameCall(route.via,route.target))reasons.push("the route is the addressee");
  if(sameCall(route.via,js8.myCall))reasons.push("the route is my own station");
  if(!Js8Inbox.isCallsign(route.via))reasons.push(`${route.via} cannot be addressed in a directed frame`);
  if(String(route.target||"").startsWith("@"))reasons.push("a group cannot be reached through an intermediary");
  const refusal=mailPathRefusal(route.target);
  if(refusal)reasons.push(refusal);
  // One open mail exchange per station is what makes an ACK readable at all: it carries
  // no message id, so a second transaction would make the answer ambiguous. Asked without
  // pruning: this runs on every render and must not retire a transaction as a side effect.
  if(mailTransactionOpen(route.via,js8Clock.now(),{prune:false}))
    reasons.push(`an exchange with ${route.via} is in progress`);
  const draft=dom.message.value.trim();
  if(draft.length>Js8MsgBox.DEFAULTS.maxTextLength)
    reasons.push(`${draft.length} characters, limit ${Js8MsgBox.DEFAULTS.maxTextLength} through an intermediary`);
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
  {key:"ACK",  label:"Heartbeat acknowledgements", on:js8=>js8.hbAck!==false, needsTx:true},
  // Deliberately without needsTx: the gate carries other stations to the internet
  // and never keys the transmitter, so Radio TX being off must not grey it out.
  // The count is of VERIFIED packets against the hourly cap -- a gate delivering
  // nothing because of a bad passcode has to read as 0, not as a busy station.
  {key:"IGATE", label:"APRS-IS gate", on:()=>Js8AprsGate.readiness(aprsGateConfig()).ready,
    detail:()=>aprsGateCountLabel(), inline:true,
    tip:()=>`${aprsGateConfig().call} at ${aprsGateConfig().host}`}
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
  renderAlcTrim();
  dom.txSafety.checked=js8.txSafetyAccepted;
  if(document.activeElement!==dom.infoText)dom.infoText.value=js8.infoText;
  renderStatusAnswer(js8);
  dom.autoReply.checked=js8.auto===true;
  if(dom.alertBeep)dom.alertBeep.checked=js8.alertBeep===true;
  renderAprsGate(js8);
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
  // startTx peels an @APRSIS draft off BEFORE it ever looks at the recipient, so a route
  // left standing here would be overridden without a word. Drop it while the operator is
  // still typing and remember what was dropped, so the hint can say it out loud.
  if(aprsDraft||cqType(dom.message.value)){
    if(state.viaRoute)state.viaDropped=state.viaRoute.via;
    clearViaRoute();
  } else state.viaDropped="";
  // A route that no longer points at the selected station is a recommendation for
  // somebody else's conversation.
  if(state.viaRoute&&state.viaRoute.target!==String(state.selectedCall||"").toUpperCase())
    clearViaRoute();
  const txBlocks=txBlockReasons(!cqType(dom.message.value)&&!aprsDraft), heartbeatBlocks=txBlockReasons(false), tuneBlocks=txBlockReasons(false);
  if(state.txSessionMode!=="CHAT")txBlocks.push(`${state.txSessionMode} uses its own form`);
  // A half-built command costs the same airtime as a whole one and the gateway
  // has nothing to do with it, so it never reaches the encoder.
  if(aprsDraft){
    const check=Js8Aprs.validate(dom.message.value);
    if(!check.ok)txBlocks.push(check.reason);
  }
  renderSendHint(aprsDraft);
  renderViaRoutes();
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
    // Parking is the mail path too: the text is stored as typed and goes out later
    // through the automation, so whatever refuses a route refuses this as well.
    if(target)reasons.push(...[mailPathRefusal(target)].filter(Boolean));
    dom.sendLater.disabled=reasons.length>0;
    dom.sendLater.title=reasons.length?reasons.join("; ")
      :state.viaRoute
        ?`Hold this message and park it at ${state.viaRoute.via} when that station shows up`
        :`Hold this message and send it when ${target} shows up on the band`;
  }
  dom.heartbeat.disabled=heartbeatBlocks.length>0; dom.heartbeat.title=heartbeatBlocks.join("; ");
  dom.heartbeatOffset.textContent=`${js8.txOffsetHz} Hz`;
  renderGpsButton(heartbeatBlocks);
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
// it while it arrives, exactly as openTrafficForNewOwnCall does. Without that a
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

// Only Recent traffic pops open, never Stations. A message addressed to us puts our own
// callsign into the station table as heard-about-only (js8-protocol.js registers every
// callsign named in a frame), so the Stations section used to unfold on every single
// message for MYCALL -- twice the movement for one reception, and the second one showed
// nothing the operator came for: the text is in the traffic feed. Stations now stays
// exactly where the operator left it.
function openTrafficForNewOwnCall(messages) {
  const own=currentJs8().myCall;
  const previous=state.ownCallAttention;
  // Keyed by channel identity where there is one: a growing reception changes its text and
  // therefore its message key with every frame, which would re-open a section the operator
  // has just collapsed, every few seconds. The identity also survives finalization, so one
  // reception pops the section open exactly once.
  const messageKeys=new Set(messages.filter(item=>!item.outgoing && messageMentionsCall(item,own))
    .map(item=>item.id ? `channel|${item.id}` : activityMessageKey(item)));
  const sameOperator=previous.call===own;
  if(messageKeys.size && (!sameOperator || [...messageKeys].some(key=>!previous.messages.has(key))))
    dom.trafficSection.open=true;
  state.ownCallAttention={call:own,messages:messageKeys};
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
  // A route is a conclusion drawn from the traffic that was just wiped, so it goes with
  // it -- exactly like the hearing links on the map, which are re-derived from nothing.
  clearViaRoute();
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
    // group are never "worked"; the amber own-callsign rule wins by !important
    // anyway, which is why an operator's own row can never dim.
    const workedHere=!ownCall && call && !call.startsWith("@")
      && state.loggedCalls.has(loggedKey(call,workedBand));
    const senderClass=[ownCall?"own-callsign":"",workedHere?"worked":""].filter(Boolean).join(" ");
    // An APRS-IS answer to one of our own commands is addressed to the group, so
    // nothing else in the row would tell the operator it came back for them.
    const aprsReply=Js8Aprs.replyForMe(message,currentJs8().myCall)
      ? '<span class="aprs-badge" title="APRS-IS reply to your command">APRS</span>' : "";
    // The other direction: what THIS station carried to APRS-IS on somebody
    // else's behalf, and whether the network took it.
    const igate=aprsGateBadge(message);
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
    // Two classes, two different questions. has-reply-slot: the button was rendered at
    // all, so the row needs the fourth grid track that holds it beside the text instead
    // of underneath it -- true for a disabled REPLY too. has-reply: the button can fire,
    // which is what lifts the row out of the .48 operational dim.
    const classes=`message${operational?" operational":""}${aprsReply?" aprs-reply":""}`
      +(forMe?" message-for-me":"")
      +(reply?" has-reply-slot":"")
      +(reply&&reply.enabled?" has-reply":"")
      +(message.partial&&message.live?" message-receiving":"")
      +(status==="incomplete"?" message-incomplete":"")+(status==="bad crc"?" message-badcrc":"");
    return divider+`<article class="${classes}"${status?` data-rx-state="${esc(status)}"`:""}><span class="message-meta"><span class="meta-time">${when}</span><span class="meta-speed">${MODE_TO_SPEED[message.submode]||"?"}</span><span class="meta-hz">${Math.round(message.offsetHz)} Hz</span>${snrText?`<span class="meta-snr" title="Signal report this row was decoded at">${snrText} dB</span>`:""}${status?`<span class="rx-state">${esc(status)}</span>`:""}</span><strong${sender.clickable?` data-call="${esc(call)}"`:""}${senderClass?` class="${senderClass}"`:""}${ownCall?' data-own-call="true"':""}${workedHere?` title="${esc(call)} already logged on ${esc(workedBand||"this band")}"`:""}>${esc(call || "JS8")}</strong><span class="message-text">${forMe?'<span class="forme-badge" title="Addressed to your callsign">TO YOU</span>':""}${aprsReply}${igate}${renderReceivedText(message,currentJs8().myCall)}${ended?'<span class="rx-eot" title="End of message confirmed">♢</span>':""}</span>${replyButton}${renderSignalStripe(message)}</article>`;
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
  openTrafficForNewOwnCall(recent);
  renderStationSort();
  renderStationMap(calls,responders);
  renderConversation();
  // Routes are read from the traffic that just changed, so they follow a decode instead
  // of waiting for the next radio poll to repaint the composer. The order stays frozen
  // while the panel is open; only the numbers and the ages move.
  renderViaRoutes();
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

// Both derivations below walk the whole message buffer (200 per frequency), and one
// decode now asks for them from the stations map, the route panel and the composer --
// three or four full passes on the path the encoder cannot afford to be late on. The
// answers only move when the traffic does, so they are cached for a second: against a
// sixty-minute evidence window that is not a staleness anyone can observe, and it turns
// the repeats into a map lookup. Keyed on the bucket identity as well as its length,
// because switching bands swaps the array wholesale.
const derivedCache={key:"",links:null,responders:null};
function derivedKey(nowMs){
  const messages=state.activity.messages||[];
  return `${state.activityFrequency}|${messages.length}|${currentJs8().myCall}|${Math.floor(nowMs/1000)}`;
}
function hearingLinksNow(nowMs){
  const key=derivedKey(nowMs);
  if(derivedCache.key!==key){derivedCache.key=key;derivedCache.links=null;derivedCache.responders=null;}
  if(!derivedCache.links)
    derivedCache.links=hearingLinks(state.activity.messages||[],currentJs8().myCall,nowMs);
  return derivedCache.links;
}
function respondingCallsNow(nowMs){
  const key=derivedKey(nowMs);
  if(derivedCache.key!==key){derivedCache.key=key;derivedCache.links=null;derivedCache.responders=null;}
  if(!derivedCache.responders)derivedCache.responders=respondingCalls();
  return derivedCache.responders;
}

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

// ---- routes through an intermediary ----------------------------------------
// When I cannot hear the addressee, the traffic already knows who can. These are the
// candidates for parking mail: stations I decode myself that have proved, inside the
// hearing-link window, that they copy the target.
//
// Three different edges matter here and only one of them is the threshold:
//
//   1. the intermediary hears ME       -- so my MSG TO: arrives at all
//   2. the TARGET hears the intermediary -- so the target ever picks the mail up
//   3. the intermediary hears the TARGET -- strictly an indication of propagation
//
// Delivery rests on edge 2, but edge 3 is the threshold (decision 3): a two-way pair
// between two remote stations is rare inside the hour, and requiring it would empty
// the list in most situations. Edges 1 and 2 are therefore shown, not filtered -- they
// are exactly what the operator weighs up when choosing. This mirrors what
// parkDeferredVia has always done; the difference is that here it is said out loud.
const VIA_ROUTE_LIMIT=5;
// A direct decode older than this means the addressee is not obviously present, which is
// when the route list is worth opening by itself.
const VIA_DIRECT_STALE_MS=15*60000;
// Amber, not gone. hearingLinks already drops everything past its own hour, so a route
// that aged out simply disappears from the list -- the warning has to fire while the
// evidence is still there but getting old, which is half the window. Past the hour the
// row vanishes and the badge says it has no fresh evidence, and Enter still sends
// (decision 9): reports that stopped being renewed are not proof the path is gone.
const VIA_EVIDENCE_AGING_MS=HEARING_LINK_MAX_AGE_MS/2;

// A hearing-link detail carries a number only when the evidence was a report
// (" SNR", " HEARTBEAT SNR"); an "ack"/"hearing"/"qsl" proves copy without one.
function viaDetailSnr(detail){
  const match=/^([+-]?\d+)\s*dB$/.exec(String(detail||"").trim());
  return match ? Number(match[1]) : null;
}

// The route list for one addressee, newest evidence per station, best first.
// Derived per call from state.activity -- no new persistent state, exactly like the
// hearing links on the map, so it survives reload and resets with CLEAR.
function viaCandidates(target, nowMs){
  const call=String(target||"").toUpperCase().trim();
  const js8=currentJs8();
  if(!call || call.startsWith("@") || sameCall(call,js8.myCall)) return [];
  const links=hearingLinksNow(nowMs);
  const responders=respondingCallsNow(nowMs);
  // Edge 2 lookup: what the TARGET has reported about each station.
  const fromTarget=new Map();
  for(const link of links) if(link.to===call) fromTarget.set(link.from,link);
  const rows=[];
  for(const link of links){
    if(link.from!==call) continue;          // edge 3: this station copies the target
    const via=link.to;
    if(sameCall(via,call) || sameCall(via,js8.myCall) || isBlockedCall(via)) continue;
    // A directed frame packs the recipient into 28 bits. A callsign that does not fit is
    // one we could never address, so offering it would be a route that cannot be taken --
    // and defer() would silently drop the pin behind it.
    if(!Js8Inbox.isCallsign(via)) continue;
    // A station known only from somebody else's HEARING list has never been decoded here,
    // so I have no signal of my own and no reason to believe it would hear me. Transmitting
    // at it would be a shot in the dark -- the same rule the SNR preset already applies.
    const mine=(state.activity.calls||[]).find(item=>item.call===via && item.heardDirectly!==false);
    if(!mine) continue;
    const back=fromTarget.get(via)||null;
    rows.push({via,
      mySnr:Number(mine.snr),
      myAtMs:Number(mine.lastSlotUtcMs)||0,
      toTargetSnr:viaDetailSnr(link.detail),
      toTargetDetail:link.detail,
      toTargetAtMs:link.atMs,
      fromTargetSnr:back?viaDetailSnr(back.detail):null,
      fromTargetDetail:back?back.detail:"",
      hearsMe:stationReacted(responders,via),
      stale:nowMs-link.atMs>VIA_EVIDENCE_AGING_MS});
  }
  // A route is only as good as its worst hop, so the key is the weaker of the two numbers.
  // Evidence without a number cannot be compared to a signal report at all, so it sorts
  // after everything numeric rather than being given an invented value (decision 5).
  rows.sort((left,right)=>{
    const lhs=left.toTargetSnr, rhs=right.toTargetSnr;
    if(lhs===null && rhs!==null) return 1;
    if(rhs===null && lhs!==null) return -1;
    if(lhs!==null && rhs!==null){
      const diff=Math.min(right.mySnr,rhs)-Math.min(left.mySnr,lhs);
      if(diff) return diff;
    }
    return right.toTargetAtMs-left.toTargetAtMs;
  });
  return rows.slice(0,VIA_ROUTE_LIMIT);
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
// A chat row's `time` is a bare UTC clock with no date in it, so ordering the thread by
// that string files yesterday 06:00 ahead of today 05:00 as soon as a session outlives
// midnight -- exactly when the thread is long enough for the order to matter. Every row
// carries an absolute stamp instead; rows restored from a snapshot written before this
// existed get theirs rebuilt in restoreConversationItem().
function conversationTimeMs(item){ return Number(item && item.utcMs) || 0; }
function utcDayKey(ms){ return ms>0 ? new Date(ms).toISOString().slice(0,10) : ""; }
// Today needs no heading; older days are named, so an hour on screen is never ambiguous.
function conversationDayLabel(ms){
  const key=utcDayKey(ms);
  if(key===utcDayKey(Date.now()))return "today";
  if(key===utcDayKey(Date.now()-86400000))return "yesterday";
  return key;
}
function conversationItems() {
  // `from` matters only for a group thread, where every bubble may have a different
  // sender; on a station thread it is always the selected call anyway.
  const received=(state.activity.messages||[]).filter(messageBelongsToConversation).map(message=>({direction:"incoming",from:senderOf(message).call,time:new Date(message.lastSlotUtcMs||0).toISOString().slice(11,19),utcMs:Number(message.lastSlotUtcMs)||0,text:message.text,status:"received"}));
  return [...received,...(state.conversations[state.selectedCall]||[])].sort((a,b)=>conversationTimeMs(a)-conversationTimeMs(b));
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
  // The bubble clock is a time of day, so a thread that outlived midnight would repeat
  // the same hour with nothing saying which day it belongs to. One divider per day
  // change names it; a thread that is entirely today's gets none.
  let lastDay="";
  dom.chat.innerHTML=items.length ? items.map(item=>{
    const day=utcDayKey(conversationTimeMs(item));
    let dayDivider="";
    if(day && day!==lastDay){
      if(lastDay || day!==utcDayKey(Date.now()))
        dayDivider=`<div class="chat-row day"><div class="chat-day">${esc(conversationDayLabel(conversationTimeMs(item)))}</div></div>`;
      lastDay=day;
    }
    if(item.direction==="system")return dayDivider+`<div class="chat-row system"><div class="chat-system">${esc(item.text)}</div></div>`;
    // Same word, same meaning as in the traffic feed: it sends. A conversation restored
    // from a snapshot is detached from the outgoing log, so those rows keep the older
    // behaviour of restaging the text in the composer rather than offering a dead button.
    const resend=item.direction!=="outgoing" ? ""
      : txResendable(item) ? `<button type="button" class="chat-resend" data-resend-id="${esc(String(item.id))}">↻ resend</button>`
      : item.status==="interrupted" ? `<button type="button" class="chat-resend" data-resend-text="${esc(item.sourceText||item.text)}">↻ resend</button>` : "";
    return dayDivider+`<div class="chat-row ${item.direction}"><article class="chat-bubble" data-message-status="${esc(item.status)}"><header><strong>${item.direction==="incoming"?esc(item.from||state.selectedCall):esc(currentJs8().myCall)}</strong><time>${esc(item.time)}</time></header><div class="chat-message">${item.direction==="outgoing"?renderOutgoingText(item):esc(item.text)}</div><footer>${esc(item.status)}${resend}</footer></article></div>`;
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
  state.conversations[call].push({direction:"system",time:new Date().toISOString().slice(11,19),utcMs:Date.now(),text,status:"info"});
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

// Link latency: read-only diagnostics, no alerting. Two separate rows, because
// they measure two separate legs -- web app <-> backend, and backend <-> TRX --
// and merging them into one line made it impossible to tell which was which.
//
// Each figure is shown as "value/risk ms": risk is not a guessed alarm level,
// it is the actual code constant at which that particular number stops being
// just slow and starts being a different (already-handled) failure mode. That
// lets the operator see the margin, not just a bare number with no context for
// whether it is fine. Sources:
//   pageRttMs      FETCH_TIMEOUT_MS (data.js)        -- /state fetch aborts
//   aud1PingRttMs  readyTimeoutMs (js8-aud1.js)       -- tx-ready wait gives up
//   pingRttCtrlMs  \ 500ms ping/retry cadence          -- round trips start
//   pingRttCivMs   /  (icomLanClient.h)                   overlapping the next one
//   pingRttAudioMs AUDIO_RTX_HOLD_MS (icomLanClient.h) -- a lost audio packet can
//                                                          no longer be chased down
//   civRttLanMs    civSilent threshold (icomLanClient.h) -- triggers the
//                                                            health-probe/recovery cascade
//   civRttSerialMs CIV_REPLY_TIMEOUT_MS (wifilt.ino)   -- the request is already
//                                                          counted a miss at this point
// Warn (bold) once any figure crosses half its own risk threshold -- a single
// shared threshold across metrics this different in kind would be meaningless.
const RTT_WARN_FRACTION = 0.5;

// Web app <-> backend: measured by this browser tab. "page" = fetch()+TCP
// handshake time (every /state reply is Connection: close, so this is not pure
// server latency); "audio-ws" = application-level ping/pong on the always-open
// AUD1 socket (native WebSocket ping/pong is invisible to page JS, hence the
// JSON round-trip in js8-aud1.js's _schedulePing).
const WEB_RTT_RISK = {pageRttMs:FETCH_TIMEOUT_MS, aud1PingRttMs:3000};
function renderWebRttRow() {
  const values = {pageRttMs:state.pageRttMs, aud1PingRttMs:state.aud1PingRttMs};
  const labels = {pageRttMs:"page", aud1PingRttMs:"audio-ws"};
  const parts = []; let worstFraction = 0;
  for (const key of Object.keys(labels)) {
    const value = values[key];
    if (!Number.isFinite(value)) continue;
    const risk = WEB_RTT_RISK[key];
    parts.push(`${labels[key]} ${Math.round(value)}/${risk} ms`);
    worstFraction = Math.max(worstFraction, value / risk);
  }
  if (!parts.length) return "";
  const warn = worstFraction >= RTT_WARN_FRACTION;
  return `<span>Web RTT</span><code>${warn?"<strong>":""}${parts.join(" · ")}${warn?"</strong>":""}</code>`;
}

// Backend <-> TRX: the firmware's own, already-flowing ping/pong and CI-V
// request timing (icomLanClient.h) -- it used to compute these as flow-control
// internals and silently discard them. Only the fields for the transport TRX1
// actually uses come back nonzero (LAN ctrl/civ/audio need a LAN radio, CAT
// serial needs serial CI-V; TrxNet is not covered yet), so this row stays empty
// on a TrxNet-only setup. txDefer suppresses the warn state during the ~3s
// window the firmware itself defers best-effort work around a TX slot --
// expected slowness, not a fault.
const RADIO_RTT_RISK = {pingRttCtrlMs:500, pingRttCivMs:500, pingRttAudioMs:240,
  civRttLanMs:2000, civRttSerialMs:250};
function renderRadioRttRow() {
  const r = state.radio || {};
  const labels = {pingRttCtrlMs:"LAN ctrl", pingRttCivMs:"LAN civ",
    pingRttAudioMs:"LAN audio", civRttLanMs:"CAT", civRttSerialMs:"CAT serial"};
  const parts = []; let worstFraction = 0;
  for (const key of Object.keys(labels)) {
    const value = r[key];
    if (!value) continue;
    const risk = RADIO_RTT_RISK[key];
    parts.push(`${labels[key]} ${value}/${risk} ms`);
    worstFraction = Math.max(worstFraction, value / risk);
  }
  if (!parts.length) return "";
  const warn = !r.txDefer && worstFraction >= RTT_WARN_FRACTION;
  return `<span>Radio RTT</span><code>${warn?"<strong>":""}${parts.join(" · ")}` +
    `${r.txDefer?" · TX slot (expected)":""}${warn?"</strong>":""}</code>`;
}

function renderDiagnostics() {
  const tb=audioSource ? audioSource.state().timebase : null;
  const linkRows=renderWebRttRow()+renderRadioRttRow();
  if (!tb) { dom.diagnosticSummary.textContent="Audio link unavailable"; dom.diagnostics.innerHTML=`<span>Transport</span><code>Waiting for ICOM-LAN audio</code>${linkRows}`; return; }
  dom.diagnosticSummary.textContent=`${tb.clock.status} · ${tb.media.status} · gaps ${tb.transport.sequenceGaps}`;
  dom.diagnostics.innerHTML=`<span>Audio WebSocket</span><code>${esc(state.audioStatus)}</code>${linkRows}<span>Browser/system clock</span><code>${esc(tb.clock.status)} · epoch ${tb.clock.epoch} · jumps ${tb.clock.jumps} <button id="confirmClock" type="button">Confirm synchronized</button></code><span>Media epoch</span><code>${tb.media.epoch} · ${esc(tb.media.reason)} · ${esc(tb.media.status)}</code><span>Packets</span><code>${tb.transport.acceptedPackets} accepted · ${tb.transport.duplicatePackets} duplicate · ${tb.transport.sequenceGaps} gaps</code><span>Timing correction</span><code>manual ${signed(tb.correction.manualMs)} ms · auto ${signed(tb.correction.autoMs)} ms · ${esc(tb.correction.status)} <button id="resetTiming" type="button">Reset</button></code>`;
  $("confirmClock").addEventListener("click",()=>{audioSource.confirmClock();renderDiagnostics();renderHeader();});
  $("resetTiming").addEventListener("click",()=>{audioSource.resetTiming();renderDiagnostics();renderHeader();});
  renderDecodeTelemetry();
}

// What the decoder did with the audio, as opposed to what came out of it. A station
// that is plainly visible in the waterfall and never decodes leaves no other trace:
// the frame list stays empty whether the decoder found nothing, never ran, or ran on
// a window cut in the wrong place — and those three want three different fixes.
// Everything here is measured elsewhere already and was simply never surfaced.
const dbfs = value => Number(value) > 0 ? `${(20*Math.log10(Number(value))).toFixed(1)} dBFS` : "−∞";
function renderDecodeTelemetry() {
  if (!dom.decodeTelemetry) return;
  const telemetry = activeDecoder && activeDecoder.telemetry ? activeDecoder.telemetry() : null;
  const tb = audioSource ? audioSource.state().timebase : null;
  if (!telemetry || !tb) { dom.decodeTelemetry.innerHTML=""; return; }
  const audio = telemetry.audio || {};
  const decode = telemetry.decode || {};
  const rows = [];

  // Peak and RMS are cumulative since the anchor, not a live level (the header
  // already shows that), so this is a clipping test: a peak pinned at full scale
  // means the audio was already ruined before the decoder saw it.
  const clipped = Number(audio.peak) >= 0.999;
  rows.push(["Audio since anchor",
    `peak ${dbfs(audio.peak)} · rms ${dbfs(audio.rms)}${clipped?" · <strong>CLIPPING</strong>":""}`]);

  // The hole the waterfall cannot show. A radio datagram the LAN client missed, and a
  // WS frame the firmware could not queue, both advance the firmware's sample counter
  // without carrying audio, so the browser fills that media time with silence to keep
  // the timeline honest. The waterfall draws only the samples that DID arrive, so it
  // closes the gap and stays beautiful — while the decoder gets the same transmission
  // with pieces punched out of it. This ratio is the difference between the two views.
  const timelineMs = (Number(audio.producedSamples12k)||0)/12;
  const silenceMs = (Number(audio.insertedGapSamples8k)||0)/8;
  if (timelineMs > 0) {
    const share = 100*silenceMs/timelineMs;
    const dropped = state.audioRxDropped;
    rows.push(["Audio continuity",
      `${share>=5?"<strong>":""}${Math.round(silenceMs/1000)} s silent of ${Math.round(timelineMs/1000)} s (${share.toFixed(1)} %)${share>=5?"</strong>":""}` +
      ` · ${Number(audio.discontinuities)||0} breaks` +
      (dropped===null?"":` · ${dropped} dropped by the radio link`)]);
    // Which half of that is self-inflicted. The unattributed remainder is silence
    // from before this page began sampling the counter, and is named rather than
    // quietly folded into one of the two buckets.
    const attributed = silenceSplit.rxMs + silenceSplit.txMs;
    if (attributed > 0)
      rows.push(["Silence attribution",
        `receiving ${Math.round(silenceSplit.rxMs/1000)} s · transmitting ${Math.round(silenceSplit.txMs/1000)} s` +
        (silenceMs - attributed >= 1000
          ? ` · ${Math.round((silenceMs-attributed)/1000)} s before counting began` : "")]);
  }

  // The anchor maps sample 0 to UTC and never moves again. Late means every decode
  // dt carries that offset, and the 15 s window has only ~1.9 s of slack for it.
  const late = Number(tb.media.anchorLateMs)||0;
  rows.push(["Anchor", tb.media.status!=="locked"
    ? `${esc(tb.media.status)} · ${tb.media.anchorCandidates} of 5 packets`
    : `${late>0?`late by ${Math.round(late)} ms (${tb.media.anchorProofs} proofs)`:"no proof of lateness yet"}` +
      ` · jitter ${Math.round(Number(audio.maxArrivalJitterMs)||0)} ms`]);

  const byMode=Object.entries(telemetry.windowsByMode||{})
    .filter(([,count])=>count>0)
    .map(([mode,count])=>`${MODE_TO_SPEED[Number(mode)]||"?"} ${count}`).join(" ");
  const skip=decode.lastSkip;
  rows.push(["Decode windows",
    `${Number(telemetry.windows)||0} cut${byMode?` · ${byMode}`:""} · ${Number(decode.skippedWindows)||0} skipped` +
    (skip?` (${esc(skip.reason)}, ${skip.missingMs} ms)`:"")]);

  const events=Number(decode.events)||0;
  rows.push(["Decodes", events
    ? `${events} frames from ${Number(decode.decodedWindows)||0} windows`
    : "<strong>no frame decoded in this epoch</strong>"]);

  // The bias every station shares is the anchor or the clock; a spread means the
  // stations themselves, and then timing is not what is wrong.
  const recent=(decode.recent||[]);
  if (recent.length) {
    const mean=recent.reduce((sum,item)=>sum+Number(item.dtMs||0),0)/recent.length;
    rows.push(["Recent dt", `mean ${signed(Math.round(mean))} ms · ` + recent.slice(-4).reverse()
      .map(item=>`${signed(Math.round(Number(item.dtMs)||0))} ms ${MODE_TO_SPEED[Number(item.submode)]||"?"} ${Math.round(Number(item.offsetHz)||0)} Hz`)
      .join(" · ")]);
  }
  dom.decodeTelemetry.innerHTML=rows.map(([label,value])=>`<span>${label}</span><code>${value}</code>`).join("");
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
    const response=await fetch(RADIO_CMD_URL,{method:"POST", signal:fetchDeadline(),
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({type:"setFrequency",frequency:String(frequency)})});
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
  try { await fetch(RADIO_CMD_URL,{method:"POST", signal:fetchDeadline(),
    headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"civ.raw",data})}); }
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
  return fetch("/unattended", {method: "POST", signal: fetchDeadline(),
    headers: {"Content-Type": "application/json"},
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
  const dropped = Number(result && result.audioRxDropped);
  state.audioRxDropped = Number.isFinite(dropped) ? dropped : null;
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
// In-flight guard, same shape as pollRadio's: without it every 5 s tick opened
// a NEW request while the previous one still hung, and a single WiFi burst
// stacked enough of them to exhaust the browser's connection pool for good.
let unattendedPollInFlight = false;
async function pollUnattended() {
  if (unattendedPollInFlight) return;
  unattendedPollInFlight = true;
  try {
    const response = await fetch("/unattended", {cache: "no-store", signal: fetchDeadline()});
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
  finally { unattendedPollInFlight = false; }
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
  // A beacon is a transmission too, so it displaces whatever AGN? would have
  // returned -- the same reason a directed message to somebody else does.
  if (decoded.kind === "heartbeat" || decoded.kind === "cq")
    noteRepeatTransmission(decoded.from, `it sent a ${decoded.kind} since`);
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
  // The APRS-IS gate runs FIRST and outside the identity guard below. It acts on
  // traffic addressed to @APRSIS -- a group this station is not in and cannot
  // join -- so carrying somebody else's position to the internet needs the
  // APRS-IS login, not our own callsign. It makes its own judgement about an
  // incomplete or checksum-failed reception, for the same reasons the code below
  // does, and the two must not be tangled together.
  gateToAprsIs(message);
  const js8 = currentJs8();
  if (!js8.myCall) return;
  const now = js8Clock.now();
  // Never act on a reception that never ended. The CRC would refuse it anyway (the check
  // bytes ride at the very end), but relaying half of somebody else's traffic under my
  // callsign is bad enough to deserve its own guard. Broken mail addressed to US is the
  // one case where dropping it silently is wrong -- the sender cannot tell.
  if (message.incomplete) {
    console.info("[js8-reassembly] incomplete, display only", message.directed.command);
    requestRepeat(message, now, "incomplete");
    return;
  }
  if (message.checksumOk === false) {
    console.info("[js8-reassembly] checksum failed, dropping", message.directed.command);
    requestRepeat(message, now, "bad crc");
    return;
  }
  // A message we were waiting to hear again either arrived, or was displaced by
  // whatever this station is sending now.
  noteRepeatOutcome(message);
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
  " GRID", " INFO", " STATUS", " HEARING", " YES", " NO", " RR", " QSL", " QSL?",
  " 73", " SK", " FB", " AGN?", " DIT DIT", " HW CPY?", " CMD", " QUERY",
  " QUERY MSGS", " QUERY MSGS?", " QUERY CALL", " SNR?", " GRID?", " INFO?",
  " STATUS?", " HEARING?"]);
// The same judgement for text that arrived THROUGH a relay: the relay hop
// swallowed the command (everything reaches us as command " "), so the machine
// filter has to look at the words instead. Longest token first, or "SNR +05"
// would be read as free text starting with the callsign "SNR".
const MSGBOX_MACHINE_TOKENS = [...MSGBOX_MACHINE_COMMANDS]
  .map(command => command.trim()).filter(Boolean)
  .sort((left, right) => right.length - left.length);
function isMachineText(text) {
  const clean = String(text || "").trim().toUpperCase();
  return MSGBOX_MACHINE_TOKENS.some(token =>
    clean === token || clean.startsWith(`${token} `));
}
function fileIncomingMessage(directed, payload, now, {via = ""} = {}) {
  const js8 = currentJs8();
  const text = String(payload || "").trim();
  if (!text || !js8.myCall) return;
  if (!sameCall(directed.to, js8.myCall)) return;   // group traffic is not mail
  if (MSGBOX_MACHINE_COMMANDS.has(directed.command)) return;
  if (isBlockedCall(directed.from)) return;
  const outcome = inbox.fileIncoming({from: directed.from, to: directed.to, text, via},
    {nowMs: now, myCall: js8.myCall});
  if (outcome.action === "store") { syncInbox(); renderInbox(); }
}

// ---- APRS-IS gate -----------------------------------------------------------
//
// When a station asks @APRSIS to put its position on the network, some IGate has
// to hear it and carry it. From here on this station is that IGate.
//
// The judgement lives in data/js8-aprs-gate.js, which knows nothing about the
// DOM and can be run in node; what is here is the wiring: the two facts only
// this page has (which callsigns are blocked, what the radio is tuned to), the
// queue pump, and the badge. The firmware builds and signs the frame -- see
// docs/aprsis-igate-implementace.md for why a finished line never crosses that
// boundary.
const APRS_GATE_TICK_MS = 3000;
// How long a written packet is still worth asking the firmware about. It keeps a
// single last result, so once a newer packet has overwritten the slot the verdict
// is gone for good; after this the badge simply stays on "sent" rather than
// claiming an outcome nobody observed.
const APRS_GATE_VERDICT_MS = 60000;
let aprsGatePumping = false;

// Station level, beside freqTimetable and not inside modems.js8call: there is one
// gate for the station, and settingsSnapshot()/normalize() only carry what the
// schema declares -- a copy parked on the modem object would be dropped on the
// next save without a word.
function aprsGateConfig() {
  return Js8AprsGate.normalizeConfig(settings.aprsis);
}

// Blocked on the air, blocked to the internet: the same list that hides a station
// from the feed and refuses to answer it also refuses to gate it.
function aprsGateBlockedReason(call) {
  const country = blockedCountryForCall(call);
  return country ? `blocked DXCC: ${country}` : "";
}

function gateToAprsIs(message) {
  const entry = aprsGate.consider(message, {nowMs: js8Clock.now(),
    config: aprsGateConfig(), blockedReason: aprsGateBlockedReason,
    // What the sender's signal was actually on: dial plus its place in the
    // passband, which is what the APRS comment reports.
    freqHz: (Number(state.radio.frequency) || 0) + Math.round(Number(message.offsetHz) || 0)});
  // Fire and forget, but never unhandled: this is called from the decode path,
  // and a rejected promise there would take the whole page's error handler with
  // it over a packet that can simply be retried on the next tick.
  if (entry && entry.state === "queued")
    pumpAprsGate().catch(error => console.info("[js8-aprs-gate] pump failed", error));
  return entry;
}

// Which HTTP answers mean "not now" rather than "no". The interface refuses to
// open a socket while the transmitter is keyed and while a previous packet is
// still on the wire; in a 15-second JS8 cycle that is routine, and counting it
// as a failed attempt used to spend the whole retry ladder in under two minutes
// on a packet nothing had actually refused.
const APRS_GATE_TRANSIENT = new Set(["tx", "busy", "backoff", "offline",
  "timeout", "unreachable", "http 503"]);

async function pumpAprsGate() {
  if (aprsGatePumping) return;
  const config = aprsGateConfig();
  const now = js8Clock.now();
  if (!Js8AprsGate.readiness(config).ready) { aprsGate.expire(now); return; }
  aprsGatePumping = true;
  const countBefore = aprsGate.sentLastHour(now);
  try {
    // The verdict FIRST. The interface remembers one result, so sending another
    // packet before collecting the previous one's answer overwrites it -- and on
    // a band where somebody beacons every fifteen seconds, nothing would ever
    // reach "verified", the hourly cap would never engage, and the header would
    // read 0/30 while packets were going out.
    await pollAprsGateVerdict();
    // Then one packet per tick, so a burst of decodes cannot become a burst of
    // connects in a firmware that is also feeding the radio its audio.
    const [entry] = aprsGate.due(js8Clock.now());
    if (entry) {
      aprsGate.markSending(entry, js8Clock.now());
      let result;
      try {
        // Every fetch on this page carries a timeout: a request left hanging
        // costs one of the browser's six connections to this origin, and six of
        // those is a page that looks dead for reasons nobody can see.
        const response = await fetch("/aprsis/spot", {method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(aprsGate.body(entry, config)),
          signal: AbortSignal.timeout(8000)});
        const data = await response.json().catch(() => ({}));
        const error = data.error || `http ${response.status}`;
        // 409 is the interface saying this exact frame already went out -- our
        // own timed-out POST, or another browser, now that the login lives in
        // the station profile. It is on the network either way.
        if (response.status === 409) {
          aprsGate.noteDuplicate(entry, {seq: data.seq, nowMs: js8Clock.now()});
          result = null;
        } else {
          result = {ok: response.ok && data.ok === true, seq: data.seq, sent: data.sent,
            error, transient: APRS_GATE_TRANSIENT.has(error)};
        }
      } catch (error) {
        // A timeout here does NOT mean the packet was not written: the interface
        // parks it and answers before the socket work happens. The duplicate
        // check on the device is what keeps the retry from publishing it twice.
        result = {ok: false, transient: true,
          error: error.name === "TimeoutError" ? "timeout" : "unreachable"};
      }
      if (result) aprsGate.noteSend(entry, {...result, nowMs: js8Clock.now()});
      renderActivity();
    }
  } finally {
    aprsGatePumping = false;
    // Only when the count it displays actually moved: this runs every three
    // seconds and rebuilding the pill row for nothing is work on the 500 ms
    // render path's budget.
    if (aprsGate.sentLastHour(js8Clock.now()) !== countBefore)
      renderSettingsFlags(currentJs8());
  }
}

// "The bytes left the box" and "APRS-IS took them" are different claims. Only the
// server's `# logresp ... verified` supports the second one, and a wrong passcode
// is indistinguishable from success without it -- the server drops packets from
// an unverified connection in silence.
async function pollAprsGateVerdict() {
  const now = js8Clock.now();
  // Anchored on when the packet was actually written, not when the message was
  // decoded: retries push the send out by up to 105 s, and a window measured
  // from the decode had already closed by then -- so exactly the packets that
  // had trouble were the ones whose verdict was never collected.
  const waiting = aprsGate.awaiting()
    .filter(entry => now - Number(entry.sentMs || entry.createdMs) < APRS_GATE_VERDICT_MS);
  if (!waiting.length) return;
  let data;
  try {
    const response = await fetch("/aprsis/status",
      {cache: "no-store", signal: AbortSignal.timeout(4000)});
    if (!response.ok) return;
    data = await response.json();
  } catch (_error) { return; }
  for (const entry of waiting) {
    // The firmware remembers one result. A mismatched seq means this packet's
    // verdict has been overwritten by a later one; the badge stays where it is,
    // because reporting somebody else's outcome under this row would be a lie.
    if (Number(data.seq) !== Number(entry.seq)) continue;
    aprsGate.noteStatus(entry, {state: data.state, server: data.server,
      line: data.line, nowMs: now});
  }
  renderActivity();
}

// Called once per row, up to two hundred rows, on every 500 ms render. It must
// therefore be a key lookup and nothing else: the previous version fell back to
// a full describe() regex pass on the miss, which is the common case -- every
// row that is not @APRSIS traffic at all.
function aprsGateEntryFor(message) {
  if (!message || !message.id) return null;
  return aprsGate.entryFor(message.id);
}

// Five states, not two, because "sent" and "accepted" are not the same fact and
// the difference is exactly what a silent gate looks like from the outside.
const APRS_GATE_MARKS = {
  queued:     {mark: "…", word: "queued"},
  sending:    {mark: "…", word: "sending"},
  sent:       {mark: "↑", word: "written, waiting for the server"},
  verified:   {mark: "✓", word: "accepted by APRS-IS"},
  unverified: {mark: "✗", word: "APRS-IS refused the login"},
  failed:     {mark: "✗", word: "not delivered"},
  skipped:    {mark: "–", word: "not gated"}
};

function aprsGateBadge(message) {
  const entry = aprsGateEntryFor(message);
  if (!entry) return "";
  const look = APRS_GATE_MARKS[entry.state] || {mark: "–", word: entry.state};
  // The frame itself goes in the tooltip. Nothing else on this page ever shows
  // the bytes that were published under this station's callsign.
  const title = [`IGATE: ${look.word}`, entry.reason, entry.sent,
    entry.server ? `server ${entry.server}` : ""].filter(Boolean).join(" · ");
  // A row gated by another browser (or by our own retry) has no frame of its own
  // to show, so the tooltip is all it has.
  const text = `IGATE ${look.mark}`;
  if (entry.state === "verified") {
    // Straight to the raw packet view: the only page that can prove the position
    // really is on the network, path and all.
    const call = encodeURIComponent(Js8AprsGate.sourceCall(entry.from));
    return `<a class="igate-badge verified" href="https://aprs.fi/?c=raw&call=${call}"`
      + ` target="_blank" rel="noopener noreferrer" title="${esc(title)}">${esc(text)}</a>`;
  }
  return `<span class="igate-badge ${esc(entry.state)}" title="${esc(title)}">${esc(text)}</span>`;
}

function aprsGateCountLabel() {
  return `${aprsGate.sentLastHour(js8Clock.now())}/${aprsGateConfig().maxPerHour}`;
}

function renderAprsGate(js8) {
  if (!dom.aprsGate) return;
  const config = aprsGateConfig();
  const ready = Js8AprsGate.readiness(config);
  dom.aprsGate.checked = config.enabled;
  // The same focus guard every field on this panel needs: renderControls runs on
  // the 500 ms radio poll and would otherwise eat a keystroke at a time.
  if (document.activeElement !== dom.aprsGateCall) dom.aprsGateCall.value = config.call;
  if (document.activeElement !== dom.aprsGatePass) dom.aprsGatePass.value = config.passcode;
  if (document.activeElement !== dom.aprsGateHost) dom.aprsGateHost.value = config.host;
  if (document.activeElement !== dom.aprsGatePort) dom.aprsGatePort.value = String(config.port);
  // A proposal, never a silent write: -10 is the IGate convention, but the
  // operator may already have that SSID connected from somewhere else.
  dom.aprsGateCall.placeholder = Js8AprsGate.suggestCall(js8.myCall) || "OK1ABC-10";
  const hourly = aprsGateCountLabel();
  dom.aprsGateState.textContent = !config.enabled ? "off"
    : ready.ready ? `passcode matches ${config.call} · ${hourly} gated this hour`
    : ready.reason;
  dom.aprsGateState.dataset.state = !config.enabled ? "off" : ready.ready ? "ok" : "bad";
}

// ---- asking for a broken message again --------------------------------------
// Upstream simply drops what it cannot reassemble, which is survivable when a
// human is watching the waterfall and can type AGN? themselves. Unattended it
// means a message addressed to this station is lost with nobody the wiser at
// either end. So we ask, and we keep asking -- knowing that a message exists is
// a standing reason, not a one-off event.
//
// WHAT we ask matters more than how often, because the two available questions
// fail differently when a question collides with the other station's slot:
//
//   QUERY MSGS -> YES MSG ID n -> QUERY MSG n     addressed, stateful, resumable
//   AGN?                                          returns their LAST transmission
//
// Upstream answers AGN? with `m_lastTxMessage` (processCommandActivity.cpp) --
// whatever it sent last, not what it sent us. So a collided AGN? is not merely a
// lost turn: by the time we ask again the answer has usually been replaced by a
// heartbeat or somebody else's reply, and the message can never be recovered
// that way. QUERY MSGS is answered from the store (`getNextMessageIdForCallsign`)
// and is therefore just as valid an hour later, which is exactly the property a
// question needs when transmissions overlap. So it is asked FIRST, and AGN? is
// the fallback for when the station holds nothing -- upstream only files mail it
// was explicitly asked to store, so "NO" is a real and common answer.
//
// The backoff is dense at the start because that is when AGN? can still work,
// and the collision guards below are what keep the question out of the other
// station's transmission in the first place.
const REPEAT_BACKOFF_MS = [60000, 120000, 300000, 600000, 1200000, 1800000];
// Two unanswered QUERY MSGS is enough to conclude the station is not answering
// queries at all (upstream needs autoreply enabled to answer one).
const REPEAT_QUERY_TRIES = 2;
// A station we have not decoded in this long is not there to ask. The request is
// only paused -- it resumes from noteStationAppearance() the moment it is heard.
const REPEAT_HEARD_MS = 30 * 60000;
// After a day the band, the operator and probably the message have all moved on.
// The row stays and ASK still works; only the automatic asking stops.
const REPEAT_AUTO_MS = 24 * 3600000;
// station -> {station, atMs, attempts, phase, phaseTries, lastMs, reason,
//             command, stale}
// phase: "query" -> asking QUERY MSGS | "pickup" -> it said YES and the mail
// pickup path owns it now | "agn" -> it holds nothing, fall back to AGN?
const repeatWaiting = new Map();

function requestRepeat(message, now, reason) {
  const js8 = currentJs8();
  const directed = message.directed || {};
  const from = String(directed.from || "").toUpperCase();
  // Whoever transmitted it is who can repeat it -- the relay, if it came through
  // one. Nothing else about the message is trustworthy at this point: half of it
  // is missing or its checksum failed.
  if (!from || !js8.myCall) return;
  if (!sameCall(directed.to, js8.myCall)) return;   // not ours to chase
  if (sameCall(from, js8.myCall)) return;           // our own transmission, heard back
  if (isBlockedCall(from)) return;
  // The addressee of a directed frame is packed into 28 bits, so a callsign we
  // cannot pack is one we can never ask (packDirectedHeader throws).
  if (!Js8Inbox.isCallsign(from)) return;
  const existing = repeatWaiting.get(from);
  // A second broken reception from the same station is the same request, not a
  // new one -- but it does prove the message is still what they are sending, so
  // the "they have moved on" verdict is lifted.
  repeatWaiting.set(from, {station: from, atMs: existing ? existing.atMs : now,
    attempts: existing ? existing.attempts : 0, lastMs: existing ? existing.lastMs : 0,
    phase: existing ? existing.phase : "query",
    phaseTries: existing ? existing.phaseTries : 0,
    reason, command: String(directed.command || "").trim(), stale: false});
  // heardNow: the station is transmitting at this very moment -- we just failed
  // to read what it said. The heard-recently gate is for the retries that come
  // later, not for this one.
  const refused = askRepeat(from, now, {heardNow: true});
  if (refused) console.info("[js8-repeat] not asking", from, "--", refused);
  renderInbox();
}

// Same shape as fetchWaitingMail: the reason it did not transmit, or "" when the
// question went out. Decision 13 -- silence with no reason is not allowed.
function askRepeat(station, now, {manual = false, probe = false, heardNow = false} = {}) {
  const js8 = currentJs8();
  const call = String(station || "").toUpperCase();
  const entry = repeatWaiting.get(call);
  if (!entry) return "nothing to ask for";
  if (!js8.txSafetyAccepted || !activeEncoder) return "tx not enabled";
  if (!manual && js8.auto !== true) return "waiting for AUTO";
  // Once the station has said YES, the pickup path owns the exchange: asking
  // anything else would open a second transaction with a station that is already
  // sending us the message. But a pickup can end WITHOUT delivering -- it gives
  // up after five tries, and the operator can drop it by hand -- and a request
  // parked in this phase would then wait for a fetch that is never coming. So
  // this phase is driven, not merely observed: the tick pushes the fetch along,
  // and when the pickup is gone the request goes back to asking for itself.
  if (entry.phase === "pickup") {
    if (mailPending.has(call)) return "collecting the message";
    const pickup = [...mailWaiting.values()].find(item => item.station === call);
    if (pickup && !mailAttempts.exhausted(mailKey(call, pickup.id)))
      return fetchWaitingMail(call, now, {manual, probe});
    // A probe answers questions, it never changes anything -- renderInbox() calls
    // this for every row on every paint. Leaving the phase change here made the
    // render undo the phase in the instant between "it said YES" and the pickup
    // being registered, which is exactly when the panel repaints.
    if (probe) return pickup ? "pickup gave up" : "waiting for the pickup";
    setRepeatPhase(entry, "query", pickup ? "pickup gave up" : "pickup is gone");
  }
  // Never transmit into somebody else's turn. A question that lands on top of
  // the answer costs both -- and the whole reason this station is asking is that
  // a transmission was already lost once.
  if (hasActiveReassembly(now)) return "a message is still arriving";
  if (autoReply.qsoLockRemainingMs(now) > 0)
    return `conversation in progress, ${Math.ceil(autoReply.qsoLockRemainingMs(now) / 1000)} s`;
  // The operator clicking IS the attendance, and they may know something we do
  // not -- so a manual ASK ignores the backoff and the staleness verdict.
  if (!manual) {
    // Staleness only disqualifies AGN?. QUERY MSGS is answered from the store,
    // so it stays valid however much the station has transmitted since.
    if (entry.stale && entry.phase === "agn")
      return `${call} has transmitted since -- AGN? would fetch that`;
    if (now - entry.atMs > REPEAT_AUTO_MS) return "asked for a day, ASK to keep trying";
    const wait = REPEAT_BACKOFF_MS[Math.min(entry.attempts, REPEAT_BACKOFF_MS.length - 1)];
    if (entry.attempts && now - entry.lastMs < wait) return "waiting for the retry window";
    if (!heardNow && !stationHeardSince(call, now - REPEAT_HEARD_MS))
      return "not heard recently";
  }
  if (probe) return "";

  const text = entry.phase === "agn" ? "AGN?" : "QUERY MSGS";
  entry.attempts += 1;
  entry.phaseTries += 1;
  entry.lastMs = now;
  console.info("[js8-repeat]", text, "to", call,
    `(${entry.reason}, try ${entry.attempts})`);
  txQueue.push({source: "msgbox", text, to: call, nowMs: now,
    submode: selectedMode(), meta: {command: text, msgboxRepeat: call}});
  // A station that never answers the query is either not answering queries at
  // all or not hearing us; either way the addressed route is spent and AGN? is
  // what is left.
  if (entry.phase === "query" && entry.phaseTries >= REPEAT_QUERY_TRIES)
    setRepeatPhase(entry, "agn", "no answer to QUERY MSGS");
  drainTxQueue(); renderTxQueue(); renderInbox();
  return "";
}

function setRepeatPhase(entry, phase, detail) {
  if (!entry || entry.phase === phase) return;
  entry.phase = phase;
  entry.phaseTries = 0;
  console.info("[js8-repeat]", entry.station, "->", phase, `(${detail})`);
}

function stationHeardSince(call, sinceMs) {
  const station = (state.activity.calls || []).find(item => item && item.call === call);
  return Boolean(station) && Number(station.lastSlotUtcMs || 0) >= sinceMs;
}

// Anything else the station puts on the air overwrites what AGN? would return,
// so the automatic asking stops here rather than at a try count. A heartbeat
// counts: it is a transmission like any other.
function noteRepeatTransmission(call, detail) {
  const from = String(call || "").toUpperCase();
  const entry = repeatWaiting.get(from);
  if (!entry || entry.stale) return;
  entry.stale = true;
  console.info("[js8-repeat] no more automatic asks to", from, "--", detail);
  renderInbox();
}

// A complete reception from a station we are chasing answers the question one
// way or the other: the message itself, and we are done -- the answer to our
// query, which steers what we ask next -- or traffic for somebody else, which
// means AGN? has nothing left to fetch for us.
function noteRepeatOutcome(message) {
  const from = String(message.directed && message.directed.from || "").toUpperCase();
  const entry = repeatWaiting.get(from);
  if (!entry) return;
  if (!sameCall(message.directed.to, currentJs8().myCall))
    return noteRepeatTransmission(from, "it has transmitted to somebody else since");
  const command = String(message.directed.command || "");
  // "NO" and "YES MSG ID n" are the two answers to QUERY MSGS. Neither is the
  // message, so neither ends the request -- they decide how it continues.
  if (command.trim() === "NO") {
    setRepeatPhase(entry, "agn", "station holds nothing for us");
    renderInbox();
    return;
  }
  if (command.trim() === "YES" && Js8MsgBox.parseMailAdvert(message.payload)) {
    // noteMailAdvert (further down this same dispatch) turns it into a pickup
    // and asks for the message by id, which is the addressed route working. It
    // repaints the panel itself once the pickup exists -- painting here would
    // show a phase whose pickup has not been created yet.
    setRepeatPhase(entry, "pickup", "station named the message id");
    return;
  }
  // Any other machine answer is not the message either, but it IS a
  // transmission, so it displaces what AGN? could return.
  if (MSGBOX_MACHINE_COMMANDS.has(command))
    return noteRepeatTransmission(from, "it has sent other traffic since");
  repeatWaiting.delete(from);
  console.info("[js8-repeat] got it from", from, "after", entry.attempts, "asks");
  renderInbox();
}

// The backoff is measured in minutes, so nothing would retry on its own without
// a tick: a request would only advance when the station happened to be decoded
// again. Cheap -- almost every call returns a refusal string.
function tickRepeatRequests(now) {
  if (!repeatWaiting.size) return;
  for (const entry of [...repeatWaiting.values()]) {
    if (isBlockedCall(entry.station)) { repeatWaiting.delete(entry.station); continue; }
    askRepeat(entry.station, now);
  }
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
// `prune` retires an entry that has run out of time, which is right when an attempt is
// about to be made and wrong everywhere else. The render path asks this question several
// times a second merely to draw a tooltip; letting it close a transaction as a side
// effect would drop an ACK arriving in the same tick, silently and without the "too late"
// log line that makes such a loss readable.
function mailTransactionOpen(station, now, {prune = true} = {}) {
  const open = mailPending.get(station);
  if (!open) return false;
  if (now - open.sinceMs > Js8TxQueue.resendTtlMs(selectedMode())) {
    if (prune) mailPending.delete(station);
    return false;
  }
  return true;
}

// The window measuring an answer can only start when an answer becomes possible:
// at the END of our transmission, not when the message was queued. Mail is
// multi-frame -- "MSG TO:<call> <text>" is four frames, a full minute of keying
// in Normal -- so a window opened at enqueue time had already run out before the
// other station could key up, and every ACK was thrown away as too late. Seen on
// the air 2026-08-13: parked at M9LOV 19:38:30, its ACK at 19:39:45, the record
// still "waiting" afterwards.
//
// Only a transmission that reached the antenna moves the window. One that failed
// closes the transaction instead: nothing went out, so nothing can acknowledge
// it, and keeping the station blocked for another four periods would only delay
// the next attempt.
function noteMailTxSettled(item, status) {
  const meta = item && item.txMeta;
  if (!meta) return;
  if (!meta.msgboxDeferredId && !meta.msgboxHandoffId && !meta.msgboxHeldId &&
      !meta.msgboxFetch) return;
  const call = String(item.to || "").toUpperCase();
  const open = mailPending.get(call);
  if (!open) return;
  if (!["completed", "unconfirmed"].includes(status)) { mailPending.delete(call); return; }
  if (open.txDoneMs) return;   // completion may be reported more than once
  open.txDoneMs = js8Clock.now();
  open.sinceMs = open.txDoneMs;
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

function deferMessage(toCall, text, pinnedVia = "") {
  const js8 = currentJs8();
  const now = js8Clock.now();
  // Backstop behind the disabled button: nothing may write this addressee's text into
  // the store, because the store is what ends up on the device in the clear.
  const refusal = mailPathRefusal(String(toCall || "").toUpperCase());
  if (refusal) return refusal;
  const outcome = msgBox.defer({to: toCall, text, nowMs: now, myCall: js8.myCall, pinnedVia});
  if (outcome.refused) return outcome.refused;
  if (isBlockedCall(toCall)) { msgBox.remove(outcome.id); return "blocked"; }
  syncInbox(); renderInbox();
  console.info("[msgbox] deferred", outcome.id, "for", outcome.to,
    outcome.pinnedVia ? `via ${outcome.pinnedVia}` : "");
  return "";
}

// Send a message the operator wrote to somebody else's inbox, right now, through the
// route they picked from the list. Everything below the record is the machinery that
// already carries automatic parking -- the same frame, the same pending entry, the same
// ACK path -- so this adds a way in, not a second state machine.
//
// The record is filed against the ADDRESSEE, because that is who the message is for.
// It stays WAITING until an ACK proves storage; without one the automation may later
// deliver it directly or park it elsewhere, which is the point of leaving it there.
function sendMessageVia(target, text, via) {
  const js8 = currentJs8();
  const now = js8Clock.now();
  const call = String(target || "").toUpperCase();
  const hop = String(via || "").toUpperCase();
  const outcome = msgBox.defer({to: call, text, nowMs: now, myCall: js8.myCall});
  if (outcome.refused) return outcome.refused;
  if (isBlockedCall(call) || isBlockedCall(hop)) { msgBox.remove(outcome.id); return "blocked"; }

  deferredAttempts.note(`via-${outcome.id}`, now);
  mailPending.set(hop, {id: outcome.id, sinceMs: now, handoff: true});
  // conversationCall makes the bubble land in the ADDRESSEE's thread while the traffic
  // feed still shows who was actually keyed -- queueOutgoing has kept those two apart
  // since @APRSIS needed it. Only a route the operator picked sets it; automatic parking
  // keeps filing its bubble under the intermediary, where it has always been.
  txQueue.push({source: "msgbox", text: viaMessageText(call, text), to: hop,
    nowMs: now, submode: selectedMode(),
    meta: {command: "MSG TO:", msgboxHandoffId: outcome.id, conversationCall: call}});
  drainTxQueue(); renderTxQueue(); syncInbox(); renderInbox();
  console.info("[msgbox] sending", outcome.id, "for", call, "through", hop);
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
  // A station that went away with our question unanswered is worth asking again
  // the moment it is back -- that is what "keep asking" means on a band where
  // the other end is absent most of the time.
  if (repeatWaiting.has(station)) askRepeat(station, now);
  if (mailWaiting.size) fetchWaitingMail(station, now);
  sendDeferredTo(station, now);
  pushHeldMailTo(station, now);
  parkDeferredVia(station, now);
}

// Stations this one is currently copying, from the same evidence the map draws
// its arrows with: a signal report, an answer that only makes sense as a
// reaction, or a HEARING list. Nothing older than the hour -- propagation moves.
function stationsHeardBy(listener, now) {
  const links = hearingLinksNow(now);
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
    .filter(item => (item.state || "waiting") === "waiting" && item.to !== call)
    // A pinned route is the operator naming the one station this message may be left
    // at. Direct delivery is untouched by it (sendDeferredTo never reads this): a pin
    // narrows who may hold the mail, it does not stand in the way of the addressee.
    .filter(item => !item.pinnedVia || item.pinnedVia === call);
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
    if (record) {
      console.info("[msgbox] parked", record.id, "for", record.to, "at", call);
      // The whole story of one message belongs in one place, next to the person it was
      // written for -- the raw exchange with the intermediary is still in its own
      // thread. Storage is all this ACK can mean, so that is all the line claims.
      pushSystemMessage(record.to, `parked at ${call} — stored, not yet delivered`);
    }
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

// The same fact in the status bar, which is on screen even when MSG BOX is
// collapsed -- which is how it sits most of the time. Red bar plus who wrote and
// what it says; the bar is the alarm, the button is the answer to "from whom".
const MSGBOX_ALERT_PREVIEW = 64;
function renderMsgBoxAlert(unreadItems) {
  if (dom.radioBar) dom.radioBar.classList.toggle("has-mail", unreadItems.length > 0);
  if (!dom.msgBoxAlert) return;
  dom.msgBoxAlert.hidden = unreadItems.length === 0;
  if (!unreadItems.length) return;
  // Newest first: with several unread the one that just landed is the one the
  // operator has not seen at all.
  const newest = unreadItems.reduce((best, item) =>
    (Number(item.atMs) || 0) > (Number(best.atMs) || 0) ? item : best);
  const from = String(newest.from || "?").toUpperCase();
  const text = String(newest.text || "").trim();
  dom.msgBoxAlertText.textContent = unreadItems.length > 1
    ? `${unreadItems.length} NEW MSG · ${from}` : `NEW MSG · ${from}`;
  if (dom.msgBoxAlertPreview) dom.msgBoxAlertPreview.textContent = text
    ? (text.length > MSGBOX_ALERT_PREVIEW ? `${text.slice(0, MSGBOX_ALERT_PREVIEW)}…` : text) : "";
  dom.msgBoxAlert.title = text ? `${from}: ${text}` : `New message from ${from}`;
}

function renderInbox() {
  if (!dom.inboxRows) return;
  // Hide messages to/from a blocked DXCC entity, like everywhere else in JS8LAN.
  const visible = item => !isBlockedCall(item.from) && !isBlockedCall(item.to);
  const all = msgBox.items("all").filter(visible);
  const items = msgBox.items(msgBoxFilter).filter(visible);
  const unreadItems = all.filter(item => item.type === "UNREAD");
  const unread = unreadItems.length;
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
  renderMsgBoxAlert(unreadItems);

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

  // A message we know exists but could not read. It is not mail yet, so it rides
  // with the pickups -- and it says out loud when the asking has stopped being
  // automatic, because an operator who is never told will assume it is still
  // trying.
  const repeats = (msgBoxFilter === "all" || msgBoxFilter === "mine")
    ? [...repeatWaiting.values()].filter(item => !isBlockedCall(item.station))
      .sort((left, right) => left.atMs - right.atMs)
    : [];
  const repeatRows = repeats.map(item => {
    const held = askRepeat(item.station, js8Clock.now(), {probe: true});
    const tries = item.attempts === 1 ? "1 ask" : `${item.attempts} asks`;
    // What it is doing right now, in the station's own vocabulary -- the point
    // of the row is that the operator can tell asking from waiting from stuck.
    const state = item.phase === "pickup" ? "collecting"
      : item.phase === "agn" && item.stale ? "operator"
      : item.phase === "agn" ? "asking AGN?" : "asking";
    return `<tr class="msgbox-row msgbox-repeat" data-repeat-call="${esc(item.station)}">` +
      `<td>—</td>` +
      `<td class="msgbox-state">${state}</td>` +
      `<td class="call" data-call="${esc(item.station)}">${esc(item.station)}</td>` +
      `<td class="inbox-text">Unreadable ${esc(item.command || "message")} from ` +
        `${esc(item.station)} (${esc(item.reason)}) · ${tries}` +
        `${held ? ` · ${esc(held)}` : ""}</td>` +
      `<td>${age(item.atMs)}</td>` +
      `<td class="msgbox-actions"><button type="button" data-msg-action="ask">ASK</button>` +
      `<button type="button" data-msg-action="dropask">DEL</button></td></tr>`;
  }).join("");

  dom.inboxRows.innerHTML = repeatRows + pickupRows + (items.length
    ? items.map(item => {
        const type = item.type || "STORE";
        const mine = type === "UNREAD" || type === "READ";
        // The other station: whoever wrote to me, or whoever the message is for.
        const peer = mine ? item.from : item.to;
        // Mail that came the roundabout way can usually only be answered the same
        // way, so the intermediary belongs on the row. Without it the box shows a
        // callsign that may never have been on the band at all.
        const via = mine && item.via && !sameCall(item.via, peer) ? String(item.via) : "";
        // "waiting" alone hides the difference between a message any station may carry
        // and one pinned to a single intermediary that may never turn up. `via` is the
        // station that DID take it, `pinnedVia` the only one allowed to -- different
        // facts, so they read differently.
        const label = type === "DEFERRED"
          ? (item.state === "handed" ? `via ${esc(item.via || "?")}`
            : item.state === "attention" ? "attention"
            : item.pinnedVia ? `waiting for ${esc(item.pinnedVia)}` : "waiting")
          : MSGBOX_STATE_LABEL[type] || type.toLowerCase();
        return `<tr class="msgbox-row msgbox-${type.toLowerCase()}" data-msg-id="${item.id}">` +
          `<td>${item.id}</td>` +
          `<td class="msgbox-state">${label}</td>` +
          `<td class="call" data-call="${esc(peer)}">${esc(peer)}` +
            (via ? `<span class="msgbox-via" title="Relayed by ${esc(via)}">via ${esc(via)}</span>` : "") +
          `</td>` +
          `<td class="inbox-text">${esc(item.text)}</td>` +
          `<td>${age(item.atMs)}</td>` +
          `<td class="msgbox-actions">` +
            (mine ? `<button type="button" data-msg-action="reply" title="${via
              ? `Answer ${esc(item.from)} -- it reached us through ${esc(via)}, so a direct reply may not get there`
              : `Answer ${esc(item.from)}`}">REPLY</button>` : "") +
            (type === "DEFERRED" ? `<button type="button" data-msg-action="sendnow" title="Send it now instead of waiting for ${esc(item.to)} to show up">SEND NOW</button>` : "") +
            `<button type="button" data-msg-action="delete" title="Delete this message">DEL</button>` +
          `</td></tr>`;
      }).join("")
    : (pickupRows || repeatRows ? "" : `<tr><td colspan="6" class="inbox-empty">${
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
// A command that reached us through a relay must be answered the way it came:
// the originator is not on the band -- the intermediary is -- so the answer is
// wrapped as a relay hop back through it. Upstream does the same thing, sending
// "<relayPath> ACK" rather than a bare one (processCommandActivity.cpp, MSG).
function routeReplyVia(send, relayCtx) {
  const via = relayCtx && String(relayCtx.via || "").toUpperCase();
  if (!via || sameCall(via, send.to)) return send;
  return {to: via, text: `>${send.to}>${send.text}`};
}

function handleInboxAssembled(directed, norm, now, relayCtx = null) {
  const js8 = currentJs8();
  if (!js8.myCall) return;
  // Only stations decoded here may be offered as heard -- a callsign we merely saw named
  // in someone else's frame must never be relayed on air as one we copy.
  const heard = (state.activity.calls || []).filter(item => item && item.call && item.heardDirectly !== false);
  const text = unwrapDeliveredMail(directed.from, norm, now);
  const outcome = inbox.handle(
    {from: directed.from, to: directed.to, command: norm.command,
     text, complete: true, via: relayCtx ? relayCtx.via : ""},
    // Groups make a command addressed to @NET as much ours as one addressed to our
    // callsign; the inbox needs the list to tell that from somebody else's net.
    {nowMs: now, myCall: js8.myCall, groups: myGroups(), armed: js8.auto === true,
     hearing: heard});

  if (outcome.action === "skip") {
    if (outcome.nack && js8.txSafetyAccepted && activeEncoder) {
      const nack = routeReplyVia(outcome.nack, relayCtx);
      txQueue.push({source: "inbox", text: nack.text, to: nack.to,
        nowMs: now, meta: {command: "NACK"}});
      drainTxQueue(); renderTxQueue();
    }
    return;
  }
  syncInbox();
  renderInbox();
  const send = outcome.ack || (outcome.action === "reply" || outcome.action === "deliver"
    ? {to: outcome.to, text: outcome.text} : null);
  if (!send) return;
  if (!js8.txSafetyAccepted || !activeEncoder) {
    console.info("[js8-inbox] cannot answer: tx-not-enabled");
    return;
  }
  const routed = routeReplyVia(send, relayCtx);
  // A question put to a group is heard by every member in the same slot, so the
  // members that DO have an answer have to spread out -- otherwise the only
  // stations that should reply are precisely the ones that collide. Same rule
  // and same offset picker as the auto-reply path.
  const groupTone = isMyGroup(directed.to) ? groupReplyToneHz() : null;
  txQueue.push({source: "inbox", text: routed.text, to: routed.to, nowMs: now,
    meta: groupTone === null
      ? {command: norm.command, inboxDeliveryId: outcome.deliveryId || null}
      : {command: norm.command, inboxDeliveryId: outcome.deliveryId || null,
         toneHz: groupTone}});
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
    if (relayed) {
      // MSG, MSG TO: and the QUERYs are multi-frame commands owned by the
      // ASSEMBLED path -- the per-frame engines have no handler for them at all.
      // Sending them down the per-frame path is how a relayed MSG used to vanish
      // between the two engines: no ACK, no MSG BOX entry, display only.
      const norm = Js8Protocol.normalizeAssembledCommand(relayed.command, relayed.text);
      if (norm && norm.kind === "inbox") {
        handleInboxAssembled({from: relayed.from, to: js8.myCall, command: relayed.command},
          norm, now, {via: directed.from});
        return;
      }
      // Not a live appearance: the relay is on the band, the originator may not be.
      handleDecodedFrame(relayed, {live: false});
      return;
    }
    // Mail for us arrives regardless of unattended mode; only the ACK needs a
    // working transmitter.
    appendRelayMessage(directed.from, outcome.text);
    // A relayed message is somebody writing to us the hard way -- it belongs in
    // the MSG BOX for exactly the same reason a direct one does. It is filed
    // against the ORIGINATOR, with the intermediary kept beside it: filing it
    // against the relay names somebody who never wrote a word of it. Machine
    // chatter is the exception -- a relayed ACK or signal report stays in the
    // conversation but is not mail (upstream skips a relayed ACK outright); the
    // usual command filter cannot catch it because the relay hop reduced every
    // command to " ".
    const {origin, body} = splitRelayOrigin(outcome.text, directed.from);
    if (!isMachineText(body))
      fileIncomingMessage({from: origin, to: js8.myCall, command: " "}, body, now,
        sameCall(origin, directed.from) ? {} : {via: directed.from});
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

// Attribution as it is actually written on the air. JS8Call marks the originator
// with "*DE*" (asterisks included) and the older/manual forms "DE" and "VIA" also
// occur -- js8-relay.js has always read all three, this side used to read a bare
// "DE" only. The cost of the mismatch was invisible and total: the originator
// fell back to the relay, so the ACK never left the intermediary and the MSG BOX
// credited the message to a station that only carried it.
const RELAY_ORIGIN_RE = /(?:^|\s)(?:\*DE\*|DE|VIA)\s+([A-Z0-9/]+)\s*$/i;
function splitRelayOrigin(text, fallbackFrom) {
  const clean = String(text || "").trim();
  const match = RELAY_ORIGIN_RE.exec(clean);
  if (!match) return {origin: String(fallbackFrom || "").toUpperCase(), body: clean};
  return {origin: match[1].toUpperCase(), body: clean.slice(0, match.index).trim()};
}

function parseRelayedCommand(text, fallbackFrom) {
  const {origin, body} = splitRelayOrigin(text, fallbackFrom);
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
    utcMs: Date.now(), text: `${from}: ${text}`, status: "relayed"};
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
  // Unconditional: a CQ or a heartbeat has no addressee, but it is still the
  // "last transmission" an AGN? asks us to repeat.
  autoReply.noteSent(entry.to || "", entry.text);
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
  autoReply.noteSent(entry.to||"",entry.text);
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
  // Encoding never even started, so no ACK can be coming: close the mail
  // transaction instead of leaving the station blocked for four periods.
  noteMailTxSettled(item,item.status);
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
  // Every @APRSIS GRID leaving the station feeds the tracking lockout, whatever
  // initiated it -- the GPS window, the tracking tick, or a hand-typed draft.
  noteGridBeaconSent(text);
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
  // Mail sent through a route the operator chose is addressed to the intermediary but
  // belongs to the conversation with the addressee, so the recipe may name the thread
  // explicitly. Everything else keeps deriving it from who is being keyed.
  const routed=recipe.meta&&recipe.meta.conversationCall
    ?String(recipe.meta.conversationCall).toUpperCase():"";
  const conversationCall=routed||(recipe.kind==="directed"&&(!target.startsWith("@")||isMyGroup(target))
    ?recipe.to:"");
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

// gpsMode: the same dialog serves two flows -- Insert into the composer (preset
// menu) and Send straight away (GPS button). The flag decides which submit runs.
const aprsState={node:null,recent:Js8Aprs.loadRecent(localStorage),gpsMode:false};
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

// ---- routes through an intermediary: composing and drawing -------------------
// The wire text of a parked message. The composed draft DOES carry the "TO:" prefix;
// the frame payload does not, because the encoder splits " MSG TO:" off as the command
// token and only "<call> <text>" goes on the air (see js8-inbox.js). Getting that
// backwards is a mistake this codebase has already made once, in both directions.
function viaMessageText(target,text){
  return `MSG TO:${String(target||"").toUpperCase()} ${String(text||"").trim()}`;
}

// What a route costs, in the same words the @APRSIS builder uses -- counted over the
// WHOLE frame, prefix included, because that is what gets keyed.
//
// Counting it means a full pack-and-split, and renderControls runs on every keystroke
// AND on the 500 ms radio poll. So the answer is cached against its inputs (the poll
// then costs nothing) and recomputed 200 ms after typing stops, which is the same
// bargain the @APRSIS cost line strikes. The stale figure stays on screen meanwhile
// rather than blinking out -- it is advisory either way.
const viaCost={key:"",text:"",timer:0};
function viaCostText(target,text){
  const js8=currentJs8(), via=state.viaRoute?state.viaRoute.via:"";
  const key=`${js8.myCall}|${via}|${target}|${selectedMode()}|${String(text||"").trim()}`;
  if(viaCost.key===key)return viaCost.text;
  if(viaCost.timer)clearTimeout(viaCost.timer);
  viaCost.timer=setTimeout(()=>{
    viaCost.timer=0;
    viaCost.key=key;
    viaCost.text=viaCostCompute(target,text,via);
    renderSendHint(Js8Aprs.isDraft(dom.message.value));
  },200);
  return viaCost.text;
}
function viaCostCompute(target,text,via){
  try {
    const frames=Js8Protocol.buildReplyFrames({myCall:currentJs8().myCall,toCall:via,
      text:viaMessageText(target,text),mode:selectedMode()}).length;
    if(!frames)return "";
    const seconds=Js8Aprs.airtimeSeconds(frames,selectedMode());
    return `${frames} frame${frames===1?"":"s"} · ${aprsDuration(seconds)}`;
  } catch(_error) { return ""; }   // unpackable callsign: the cost line is advisory
}

// The evidence for one hop, as text. Evidence without a number is still evidence --
// an ACK proves copy -- so it is spelled out rather than shown as a missing value.
function viaEvidence(snr,detail){
  if(snr!==null && snr!==undefined)return formatJs8Snr(snr);
  return String(detail||"").trim()||"—";
}

function viaRow(row,chosen){
  const numbers=[`me ${formatJs8Snr(row.mySnr)}`,
    `hears ${viaEvidence(row.toTargetSnr,row.toTargetDetail)}`,
    row.fromTargetSnr!==null||row.fromTargetDetail
      ? `back ${viaEvidence(row.fromTargetSnr,row.fromTargetDetail)}` : "",
    row.hearsMe?"<em>hears me</em>":"",
    row.stale?`<i>${esc(age(row.toTargetAtMs))}</i>`:esc(age(row.toTargetAtMs))]
    .filter(Boolean);
  return `<button type="button" data-via="${esc(row.via)}" aria-pressed="${chosen?"true":"false"}">`+
    `<b>${esc(row.via)}</b><span>${numbers.join(" · ")}</span></button>`;
}

// The direct path competes in the same list as the routes, so "through nobody" is a
// visible choice rather than the absence of one. It is never disabled: a station I do
// not hear may well hear me, and refusing to try would be our opinion, not a fact.
function viaDirectRow(target){
  const station=(state.activity.calls||[]).find(item=>item.call===target && item.heardDirectly!==false);
  const detail=station
    ? `me ${formatJs8Snr(station.snr)} · ${esc(age(station.lastSlotUtcMs))}`
    : "not heard here";
  return `<button type="button" data-via="" aria-pressed="${state.viaRoute?"false":"true"}">`+
    `<b>DIRECT</b><span>${detail}</span></button>`;
}

// Why the list is empty, in the terms of the actual obstacle. "0 routes" would be
// misleading for a group, where the question itself does not apply.
function viaEmptyReason(target){
  if(!target)return "";
  if(target.startsWith("@"))return `${target} is a group — a route makes no sense`;
  if(!Js8Inbox.isCallsign(target))return `${target} cannot be addressed in a directed frame`;
  const known=(state.activity.calls||[]).some(item=>item.call===target);
  return known
    ? `nobody I hear has copied ${target} — try SEND LATER`
    : `${target} unknown on this band — try SEND LATER`;
}

// Order is frozen while the panel is open (decision 14): the numbers stay honest but
// rows never jump under the cursor between the operator deciding and clicking. A new
// candidate joins at the end instead of pushing its way to the top.
function viaOrdered(rows){
  if(!dom.viaDetails.open){state.viaOrder=rows.map(row=>row.via);return rows;}
  const known=new Map(rows.map(row=>[row.via,row]));
  const ordered=state.viaOrder.map(call=>known.get(call)).filter(Boolean);
  const seen=new Set(ordered.map(row=>row.via));
  for(const row of rows) if(!seen.has(row.via)) ordered.push(row);
  state.viaOrder=ordered.map(row=>row.via);
  return ordered;
}

// `<details>` fires `toggle` for a programmatic open too, and asynchronously, so a naive
// listener would read our own auto-open as the operator's decision and latch it for the
// rest of the session. The value we wrote is parked here and the listener consumes it.
let viaAutoOpen=null;
let viaRenderedTarget="";

function renderViaRoutes() {
  if(!dom.viaRoutes)return;
  const now=js8Clock.now();
  const target=String(state.selectedCall||"").toUpperCase();
  // The auto-open heuristic is per addressee: a panel the operator collapsed for one
  // station must not stay collapsed for the next one, whose situation is a fresh
  // question. Changing who we write to also drops the frozen order.
  if(target!==viaRenderedTarget){viaRenderedTarget=target;state.viaOpen=null;state.viaOrder=[];}
  // A draft that carries its own recipient is going somewhere else entirely, so the
  // whole question is moot -- and the route has already been dropped by then.
  const ownRecipient=Js8Aprs.isDraft(dom.message.value)||Boolean(cqType(dom.message.value));
  dom.viaRoutes.hidden=!target||state.txSessionMode!=="CHAT"||ownRecipient;
  if(dom.viaRoutes.hidden){state.viaOrder=[];return;}
  // A module may own how this addressee is written to; then there is nothing to offer,
  // because a third station does not share it.
  const refusal=mailPathRefusal(target);
  const rows=refusal?[]:viaOrdered(viaCandidates(target,now));
  const reason=rows.length?"":(refusal||viaEmptyReason(target));

  // Open by itself when a route is what the operator plainly needs: the addressee is
  // not being decoded here, or the last decode is old enough to be history.
  const station=(state.activity.calls||[]).find(item=>item.call===target && item.heardDirectly!==false);
  const needsRoute=!station||now-Number(station.lastSlotUtcMs||0)>VIA_DIRECT_STALE_MS;
  if(state.viaOpen===null){
    const want=Boolean(rows.length)&&needsRoute;
    if(dom.viaDetails.open!==want){viaAutoOpen=want;dom.viaDetails.open=want;}
  }

  dom.viaSummary.innerHTML=rows.length
    ? `${rows.length} route${rows.length===1?"":"s"} via an intermediary`+
      (state.viaRoute?` <span class="via-summary-hint">· using ${esc(state.viaRoute.via)}</span>`:"")
    : `<span class="via-summary-hint">${esc(reason)}</span>`;
  dom.viaList.innerHTML=rows.length
    ? viaDirectRow(target)+rows.map(row=>viaRow(row,Boolean(state.viaRoute&&state.viaRoute.via===row.via))).join("")
    : `<p class="via-empty">${esc(reason)}</p>`;
  renderViaBadge(rows);
}

function renderViaBadge(rows) {
  const route=state.viaRoute;
  dom.viaBadge.hidden=!route;
  if(!route)return;
  const row=(rows||[]).find(item=>item.via===route.via)||null;
  // A route whose evidence has aged out is not a route that has gone away: propagation
  // reports simply stop being renewed. It goes amber and says how old it is, and Enter
  // still sends (decision 9) -- 61 minutes is not proof of anything.
  const stale=!row||row.stale;
  const detail=row
    ? `me ${formatJs8Snr(row.mySnr)} · hears ${viaEvidence(row.toTargetSnr,row.toTargetDetail)} · ${age(row.toTargetAtMs)}`
    : "no fresh evidence for this route";
  dom.viaBadge.classList.toggle("warn",stale);
  dom.viaBadge.innerHTML=`via <b>${esc(route.via)}</b><small>${esc(detail)}</small>`+
    `<button type="button" id="viaClear" aria-label="Clear route" title="Send directly instead">×</button>`;
}

function chooseViaRoute(via) {
  const call=String(via||"").toUpperCase().trim();
  const target=String(state.selectedCall||"").toUpperCase();
  state.viaRoute=call&&target ? {target, via:call, chosenAtMs:Date.now()} : null;
  renderControls();
  // The route is prefilled, the words are not: the message is still the operator's to
  // write, so the caret goes where the typing happens.
  dom.message.focus({preventScroll:true});
}

// The route belongs to one addressee. Anything that changes who we are writing to, or
// wipes the evidence it was derived from, drops it rather than quietly re-pointing it.
// The frozen display order is deliberately left alone: it belongs to the open panel, not
// to the choice, and re-sorting the rows under a hand that just cleared a badge is the
// misclick decision 14 exists to prevent. Stale entries fall out of viaOrdered by
// themselves once the stations behind them are gone.
function clearViaRoute() {
  if(!state.viaRoute)return;
  state.viaRoute=null;
}

function renderSendHint(aprsDraft) {
  // A chosen route sends to somebody other than the addressee, which is the same
  // class of surprise the @APRSIS line already guards against -- so it is said in
  // the same words, with the cost of the WHOLE frame, prefix included.
  if(!aprsDraft && state.viaRoute){
    const cost=viaCostText(state.viaRoute.target,dom.message.value);
    dom.sendHint.textContent=`Enter sends to ${state.viaRoute.via} for ${state.viaRoute.target}`+
      (cost?` · ${cost}`:"");
    dom.sendHint.classList.remove("warn");
    return;
  }
  // A draft carrying its own recipient wins over a chosen route (decision 15), but the
  // route must not vanish in silence -- that is precisely the class of bug the audits
  // of this page keep turning up.
  const dropped=state.viaDropped?` — route via ${state.viaDropped} dropped`:"";
  if(!aprsDraft){
    dom.sendHint.textContent=dropped?`Enter sends${dropped}`:"Enter sends";
    dom.sendHint.classList.toggle("warn",Boolean(dropped));
    return;
  }
  // The operator keeps their selected station through an APRS spot, so say out
  // loud that this particular message is not going to them.
  const where=(state.selectedCall
    ? `Enter sends to ${Js8Aprs.GROUP}, not ${state.selectedCall}`
    : `Enter sends to ${Js8Aprs.GROUP}`)+dropped;
  const check=Js8Aprs.validate(dom.message.value);
  const cost=check.ok?aprsCostText(dom.message.value,check.textLength):{text:"",long:false};
  dom.sendHint.textContent=cost.text?`${where} · ${cost.text}`:where;
  dom.sendHint.classList.toggle("warn",cost.long||Boolean(dropped));
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
  if(aprsState.gpsMode){gpsBeaconSubmit();return;}
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

// ---- GPS position beacon ----------------------------------------------------
// docs/gps-poloha-implementace.md. The radio's own GPS (CI-V 23 00, surfaced by
// the firmware in /state as gpsGrid + gpsFixAgeMs + gpsSel) feeds a button next
// to HB: one press opens the familiar GRID window prefilled with the live
// 8-character locator and its confirm transmits straight away. A Tracking
// checkbox in that window re-beacons whenever the first 6 characters change.
//
// Freshness is the firmware's stamp-movement age, never the browser clock. The
// button unlocks only on a live fix with GPS Select = ON (01) -- a manual
// position (03) is a valid locator but not a position report worth beaconing.
const GPS_FRESH_MS=30000;
const GPS_TRACK_MIN_INTERVAL_MS=600000;   // one GRID beacon per 10 min, any origin
// Session-only by decision: no persistence, a reload turns tracking off.
const gpsTrack={enabled:false,lastSentPrefix:"",lastBeaconAtMs:0};

function gpsRadio() {
  const grid=typeof state.radio.gpsGrid==="string" ? state.radio.gpsGrid : null;
  const ageMs=Number(state.radio.gpsFixAgeMs);
  const sel=Number(state.radio.gpsSel);
  return {grid,ageMs:Number.isFinite(ageMs)?ageMs:null,sel:Number.isFinite(sel)?sel:null};
}

// "Current" in the sense the interview fixed: live fix (stamp moved within 30 s)
// AND the position actually comes from the GPS receiver.
function gpsCurrent(g=gpsRadio()) {
  return Boolean(g.grid) && g.sel===1 && g.ageMs!==null && g.ageMs<GPS_FRESH_MS;
}

// The 10-minute lockout counts from the last @APRSIS GRID that left this page,
// manual or automatic -- one hook in startTx() catches every path, including a
// hand-typed beacon in the composer. Stamped at initiation, not completion:
// under-beaconing on a faulted TX is safer than double-beaconing.
function noteGridBeaconSent(text) {
  const match=/^@APRSIS\s+GRID\s+([A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?)\s*$/i
    .exec(String(text||"").trim());
  if(!match)return;
  gpsTrack.lastSentPrefix=match[1].toUpperCase().slice(0,6);
  gpsTrack.lastBeaconAtMs=Date.now();
}

// The dialog's GPS flavour, reset on every path that leaves it. dialog.close()
// fires its "close" event on a QUEUED task, so anything that must be true the
// moment the dialog is gone -- the preset menu reopening it plain -- cannot
// wait for that event alone; the open path and the close buttons reset too.
function resetGpsDialogChrome() {
  aprsState.gpsMode=false;
  dom.aprsTrackingRow.hidden=true;
  dom.aprsParamInsert.textContent="Insert";
}

function openGpsBeaconDialog() {
  const g=gpsRadio();
  if(!gpsCurrent(g))return;
  aprsState.gpsMode=true;
  openAprsParams(Js8Aprs.GRID,{locator:g.grid});
  dom.aprsParamTitle.textContent="GPS position — beacon your locator to APRS-IS";
  dom.aprsTrackingRow.hidden=false;
  dom.aprsTracking.checked=gpsTrack.enabled;
  dom.aprsParamInsert.textContent="Send";
}

function gpsBeaconSubmit() {
  const check=Js8Aprs.checkParams(aprsState.node,aprsParamValues());
  if(!check.ok)return;
  // The same gate SEND sits behind. Checked at the moment of firing because the
  // dialog may sit open across a slot boundary or a link drop.
  const blocks=txBlockReasons(false);
  if(blocks.length){dom.aprsParamError.textContent=`Cannot transmit now: ${blocks.join("; ")}`;return;}
  const track=dom.aprsTracking.checked;
  dom.aprsParamDialog.close();
  startTx(check.payload,"gps");
  gpsTrack.enabled=track;
  renderControls();
}

// Patient by decision: every blocked condition simply defers to a later 500 ms
// poll tick -- a square crossed during the lockout beacons when it expires, a
// lost fix pauses (never disarms) tracking, a busy or gated TX waits its turn.
function gpsTrackTick() {
  if(!gpsTrack.enabled)return;
  const g=gpsRadio();
  if(!gpsCurrent(g))return;
  if(g.grid.slice(0,6)===gpsTrack.lastSentPrefix)return;
  if(Date.now()-gpsTrack.lastBeaconAtMs<GPS_TRACK_MIN_INTERVAL_MS)return;
  if(state.activeOutgoing)return;
  if(txBlockReasons(false).length)return;
  const check=Js8Aprs.checkParams(Js8Aprs.GRID,{locator:g.grid});
  if(!check.ok)return;
  startTx(check.payload,"gps");   // the startTx hook stamps prefix + lockout
  renderControls();
}

// txBlocks is the HB gate -- txBlockReasons(false), passed in by renderControls
// rather than recomputed, so the two buttons can never disagree about whether
// the station may transmit.
function renderGpsButton(txBlocks=txBlockReasons(false)) {
  if(!dom.gpsBeacon)return;
  const g=gpsRadio();
  const supported=g.grid!==null;
  // While tracking runs the button must stay reachable even through a radio
  // reconnect that briefly hides the GPS fields -- it is the only off switch.
  dom.gpsBeacon.hidden=!supported&&!gpsTrack.enabled;
  dom.gpsBeacon.classList.toggle("active",gpsTrack.enabled);
  dom.gpsBeaconGrid.textContent=g.grid?g.grid.slice(0,6):"--";
  const reasons=[];
  if(!supported)reasons.push("radio not answering GPS queries");
  else if(g.sel===3)reasons.push("radio position is entered manually (GPS Select: Manual)");
  else if(g.sel===0)reasons.push("GPS Select is OFF in the radio menu");
  else if(!g.grid)reasons.push("waiting for a GPS fix");
  else if(!gpsCurrent(g))reasons.push("GPS fix lost — position not current");
  // A position beacon is a transmission, so it sits behind exactly the same gate
  // as HB -- "Enable radio TX" above all. Without this the button invited a click
  // that the submit path would then refuse, which is a worse way to say no.
  reasons.push(...txBlocks);
  dom.gpsBeacon.disabled=!gpsTrack.enabled&&reasons.length>0;
  dom.gpsBeacon.title=gpsTrack.enabled
    ?(reasons.length?`Tracking on but paused: ${reasons.join("; ")} — click to turn off`
      :"Tracking on — beacons @APRSIS GRID when the first 6 locator characters change (at most every 10 min). Click to turn off.")
    :(reasons.length?`Position beacon locked: ${reasons.join("; ")}`
      :"Send my GPS position to APRS-IS — opens the GRID window");
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
  // The mail ACK window opens at the END of the transmission, not when the message
  // was queued (noteMailTxSettled). Read item.status rather than txState: the verdict
  // above may have turned a fault into "unconfirmed", which means the carrier did go
  // out and an ACK is still to be expected.
  if(["aborted","fault","completed","unconfirmed"].includes(item.status))
    noteMailTxSettled(item,item.status);
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
  const pollStartMs=performance.now();
  try {
    const response=await fetch(RADIO_STATE_URL,{cache:"no-store", signal:fetchDeadline()});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next=await response.json();
    // "Page RTT": fetch + TCP handshake (every /state reply is Connection: close)
    // + body. Not comparable to the firmware's own link-latency fields in `next`
    // -- this measures the browser<->backend leg, they measure backend<->radio.
    state.pageRttMs=performance.now()-pollStartMs;
    radioPollFailures=0;
    state.radio={...state.radio,...next,frequency:Number(next.frequency)||0};
    // The merge above keeps keys the reply no longer carries. For GPS that is a
    // trap: absence IS the answer (radio reconnected, support re-probing), and a
    // frozen gpsFixAgeMs from minutes ago would keep looking "fresh" forever.
    if(!("gpsGrid" in next)){delete state.radio.gpsGrid;delete state.radio.gpsFixAgeMs;delete state.radio.gpsSel;}
    // The setup guide follows the radio, not the page: whatever model this reports
    // is the procedure the help dialog opens on. No-op when unchanged. Must be
    // liveRadioModel(), not the raw radioName -- see liveRadioModel()'s own
    // comment on the ~1s stale-name window after a live LAN-slot model swap.
    if(root_TrxHelp())root_TrxHelp().setReportedModel(liveRadioModel());
    const activityFrequencyChanged=selectActivityFrequency(state.radio.frequency);
    if (state.pendingFrequency && state.radio.frequency===state.pendingFrequency) state.pendingFrequency=null;
    rfPowerAuto.onPollSuccess(); gpsTrackTick();
    ensureAudio(); if(activityFrequencyChanged)renderActivity(); renderHeader(); renderControls();
  } catch (error) {
    // Deliberately not through rfPowerAuto.onPollSuccess(): a fetch that never
    // arrived says nothing about the radio, and counting it as a link drop
    // would re-arm the power write on every WiFi flutter between the browser
    // and the ESP32.
    // Named in the console because this path is otherwise invisible: it leaves
    // no serial-log trace, only the OFFLINE blink whose trigger (timeout vs
    // refused connection vs error status) is exactly what error.name/message say.
    radioPollFailures++;
    console.warn(`pollRadio: /state failed (${radioPollFailures} in a row)`, error);
    const audioFresh=state.lastAudioMs>0 && performance.now()-state.lastAudioMs<1500;
    if (!audioFresh && radioPollFailures>=RADIO_POLL_OFFLINE_FAILURES) {
      state.radio.connected=false; stopAudio(); renderHeader(); renderControls();
    }
  }
  finally { radioPollInFlight=false; }
}

async function reconnectRadio() {
  if(state.reconnectPending)return;
  state.reconnectPending=true; renderHeader();
  try {
    const response=await fetch("/lan/reconnect",{method:"POST", signal:fetchDeadline(FETCH_FLASH_TIMEOUT_MS)});
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
    const response = await fetch(path, {method:"POST", cache:"no-store", signal:fetchDeadline(),
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
  const claim = await sessionPost("/js8/session/claim", {force:false, role:"js8"});
  if (claim.granted) location.reload();
  else showSessionBusy(claim);
}

async function acquireJs8Session(force = false) {
  if (force && sessionChannel) sessionChannel.postMessage({type:"evict", id:pageId});
  const claim = await sessionPost("/js8/session/claim", {force, role:"js8"});
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
  const ping = await sessionPost("/js8/session/ping", {role:"js8"});
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
// One nested object, so it is patched rather than assigned key by key -- and
// normalised on the way in, because these fields are typed by hand and the next
// thing that reads them is a TCP connection carrying this station's callsign.
function setAprsGateSetting(patch) {
  settings.aprsis=Js8AprsGate.normalizeConfig({...aprsGateConfig(),...patch});
  persistSettings();
  renderAprsGate(currentJs8());
  renderSettingsFlags(currentJs8());
}
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
  // Takes the operator to the mail, nothing more: the message stays unread until
  // its own row is clicked, so the bar cannot clear itself by being looked at.
  if(dom.msgBoxAlert)dom.msgBoxAlert.addEventListener("click",()=>{
    if(!dom.inboxSection)return;
    dom.inboxSection.open=true;
    dom.inboxSection.scrollIntoView({behavior:"smooth",block:"start"});
  });
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
    button.addEventListener("click",()=>{dom.aprsParamDialog.close();resetGpsDialogChrome();}));
  // Escape and form-submit close without touching the buttons above; the queued
  // "close" event catches those. See resetGpsDialogChrome() for why it is not
  // the only reset site.
  dom.aprsParamDialog.addEventListener("close",resetGpsDialogChrome);
  dom.gpsBeacon.addEventListener("click",()=>{
    if(dom.gpsBeacon.disabled)return;
    // The same button that armed tracking is the one that disarms it -- without
    // reopening the window, so the off switch works even mid-lockout.
    if(gpsTrack.enabled){gpsTrack.enabled=false;renderControls();return;}
    openGpsBeaconDialog();
  });
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
  dom.rfPercent.addEventListener("input",()=>rfPowerAuto.noteDraft());
  dom.rfPercentSet.addEventListener("click",()=>rfPowerAuto.setFromField());
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
    // A message we could not read: ask again by hand (manual overrules both the
    // backoff and the "they have moved on" verdict -- the operator may know the
    // station is still repeating it), or give up on it.
    const repeatRow=event.target.closest("tr[data-repeat-call]");
    if(repeatRow){
      const station=repeatRow.dataset.repeatCall;
      if(action&&action.dataset.msgAction==="ask"){
        const refused=askRepeat(station,js8Clock.now(),{manual:true});
        if(refused)console.info("[js8-repeat] ask refused:",refused);
      }else if(action&&action.dataset.msgAction==="dropask"){
        repeatWaiting.delete(station);renderInbox();
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
  if(dom.aprsGate){
    dom.aprsGate.addEventListener("change",()=>{
      const js8=currentJs8(), config=aprsGateConfig();
      // Switching the gate on with no callsign fills in the -10 proposal, because
      // that is the moment it stops being a guess and becomes a decision. It is
      // never written behind the operator's back before that.
      const call=config.call || (dom.aprsGate.checked
        ? Js8AprsGate.suggestCall(js8.myCall) : "");
      setAprsGateSetting({enabled:dom.aprsGate.checked, call});
    });
    dom.aprsGateCall.addEventListener("change",()=>setAprsGateSetting({call:dom.aprsGateCall.value}));
    dom.aprsGatePass.addEventListener("change",()=>setAprsGateSetting({passcode:dom.aprsGatePass.value}));
    dom.aprsGateHost.addEventListener("change",()=>setAprsGateSetting({host:dom.aprsGateHost.value}));
    dom.aprsGatePort.addEventListener("change",()=>setAprsGateSetting({port:dom.aprsGatePort.value}));
  }
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
  dom.composer.addEventListener("submit",event=>{
    event.preventDefault();
    const text=dom.message.value.trim();
    if (!text || dom.send.disabled)return;
    // A chosen route sends the message as mail to somebody else's inbox instead of
    // straight at the addressee. The route is consumed by the send: it was picked from
    // evidence that will have moved on by the next message.
    const route=state.viaRoute;
    if(route){
      const refused=sendMessageVia(route.target,text,route.via);
      if(refused){dom.sendHint.textContent=`Refused: ${refused}`;dom.sendHint.classList.add("warn");return;}
      dom.message.value="";
      clearViaRoute();
      renderControls();persistSession();
      return;
    }
    dom.message.value="";renderControls();startTx(text);
  });
  // Clicking a route arms it; clicking DIRECT (data-via="") disarms it. The list is
  // rebuilt by renderControls, which detaches the clicked node, so the dataset is read
  // before anything renders.
  if(dom.viaList)dom.viaList.addEventListener("click",event=>{
    const button=event.target.closest("[data-via]");
    if(!button)return;
    chooseViaRoute(button.dataset.via);
  });
  if(dom.viaBadge)dom.viaBadge.addEventListener("click",event=>{
    if(!event.target.closest("#viaClear"))return;
    chooseViaRoute("");
  });
  // Remember the operator's own open/close so the derived default stops fighting it,
  // and freeze the display order from whatever is on screen at that moment.
  if(dom.viaDetails)dom.viaDetails.addEventListener("toggle",()=>{
    // Our own auto-open, coming back asynchronously: consume it and keep the heuristic
    // alive. Only a real click records an opinion.
    if(viaAutoOpen!==null&&dom.viaDetails.open===viaAutoOpen){viaAutoOpen=null;return;}
    viaAutoOpen=null;
    state.viaOpen=dom.viaDetails.open;
    if(!dom.viaDetails.open)state.viaOrder=[];
  });
  // A button, not a checkbox: a switch that survives one message is how the next
  // one gets parked by accident.
  if(dom.sendLater)dom.sendLater.addEventListener("click",()=>{
    const text=dom.message.value.trim();
    if(!text||dom.sendLater.disabled)return;
    // A route chosen here is a WISH, not an attempt: nothing is transmitted, the
    // message is simply narrowed to the one intermediary the operator picked and waits
    // for that station to show up.
    const pin=state.viaRoute?state.viaRoute.via:"";
    const refused=deferMessage(state.selectedCall,text,pin);
    if(refused){dom.sendLater.title=`Refused: ${refused}`;return;}
    dom.message.value="";
    clearViaRoute();
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
  // Load the station-wide plan, importing a legacy plan still embedded in the
  // single-tone result table when this is the first run after an upgrade.
  gainPlanStore.loadAndMigrate([
    {profile:TxGainPlanStore.PROFILE_TONE, store:gainStore},
  ]).then(()=>{renderResolvedGain(); if(gainPlan)gainPlan.reload();});
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
  // Retries and the server's verdict. A new packet pumps itself the moment it is
  // queued; this tick is what carries one that was refused because the station
  // was transmitting, and it is why the queue survives a quiet band.
  scheduler.every("aprsGate",APRS_GATE_TICK_MS,()=>pumpAprsGate());
  // Audio windows normally age out partial receptions inside the worker; when audio stops
  // for good no window is produced, and without this tick the torso would never reach
  // messages[] to be persisted. Only finalizations post an activity change, so a quiet
  // band costs one postMessage per second and no re-render.
  scheduler.every("reassembly",1000,()=>{
    if(activeDecoder && activeDecoder.expire)activeDecoder.expire(js8Clock.now());
  });
  // Repainted only while the operator is looking at it. The numbers ride in on a
  // state message that arrives with every audio packet, so a closed panel must not
  // cost a render per second for something nobody can see.
  scheduler.every("decodeTelemetry",1000,()=>{
    // Sampled whether or not anybody is looking: the split is built from increments,
    // so a closed panel would leave a hole in it that no later render could fill.
    sampleSilenceSplit();
    const panel=dom.decodeTelemetry && dom.decodeTelemetry.closest("details");
    if(panel && panel.open)renderDecodeTelemetry();
  });
  scheduler.every("heartbeat",5000,()=>{checkHeartbeat();renderHeartbeatState();});
  // Messages that arrived unreadable: the retry windows are minutes long, and
  // the collision guards mean a due attempt is routinely postponed, so the
  // request needs a clock of its own rather than the next decode from that
  // station.
  scheduler.every("repeatAsk",15000,()=>tickRepeatRequests(js8Clock.now()));
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
  let mailRefusalBase=null;   // original mailPathRefusal, kept so mailSetRefusal can restore it
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
    // The APRS-IS gate. Configuration goes in through the same setter the panel
    // uses, and the entries come out raw, because what the harness has to be able
    // to assert is the decision -- gated or refused, and why.
    aprsGateSet(patch){setAprsGateSetting(patch);},
    aprsGateConfig(){return aprsGateConfig();},
    aprsGateEntries(){return aprsGate.entries.map(entry=>({...entry}));},
    aprsGateSentLastHour(){return aprsGate.sentLastHour(js8Clock.now());},
    aprsGateReset(){aprsGate.clear();renderActivity();renderSettingsFlags(currentJs8());},
    // Brings a queued retry forward. Without it a harness would have to sit out
    // the real backoff, and a check that waits fifteen seconds is a check that
    // gets deleted.
    aprsGateDue(){for(const entry of aprsGate.entries)
      if(entry.state==="queued")entry.nextMs=js8Clock.now();},
    async aprsGatePump(){await pumpAprsGate();},
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
    // GPS beacon + tracking. setGps writes the same state.radio fields the
    // /state poll does (the next poll overwrites them from the fixture, so a
    // test mutates and asserts inside one synchronous block); gpsTick runs the
    // very tick the poll runs, not a copy of it.
    setGps(fields){state.radio={...state.radio,...fields};renderControls();},
    gpsTick(){gpsTrackTick();return {...gpsTrack};},
    gpsSetTrack(fields){Object.assign(gpsTrack,fields);renderControls();return {...gpsTrack};},
    gpsState(){return {...gpsTrack,hidden:dom.gpsBeacon.hidden,disabled:dom.gpsBeacon.disabled,
      active:dom.gpsBeacon.classList.contains("active"),label:dom.gpsBeaconGrid.textContent,
      title:dom.gpsBeacon.title};},
    feedDirected(frame){handleDirectedFrame({kind:"directed",...frame});},
    txQueueState(){return txQueue.snapshot(js8Clock.now());},
    heartbeatState(){return heartbeat.snapshot(js8Clock.now());},
    relayState(){return relay.snapshot(js8Clock.now());},
    inboxState(){return inbox.snapshot();},
    repeatState(){return [...repeatWaiting.values()].map(item=>({...item,
      pending:mailPending.has(item.station)}));},
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
                        trimBadge:dom.alcTrimState&&!dom.alcTrimState.hidden
                          ?dom.alcTrimState.textContent:"",
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
    // The other half of the same problem: no browser can key a radio, so a
    // transmission can never SUCCEED here either. Completion is reported through
    // the very function the modem calls, which is where the mail ACK window opens.
    txComplete(){
      const item=state.activeOutgoing;
      if(!item)return false;
      updateOutgoingTxProgress({status:"completed",frames:[],frameIndex:0,
        frameCount:Number(item.frameCount)||1});
      return true;
    },
    // Mail exchanges are minutes long and their windows are counted in slot
    // periods, so the only way to test them is to move the clock. The swap is the
    // one the page is built for (see js8Clock); clockShift(0) puts it back.
    clockShift(ms){
      const shift=Number(ms)||0;
      js8Clock.now=shift?()=>Date.now()+shift:()=>Date.now();
      return shift;
    },
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
    msgBoxDefer(to,text,pinnedVia){return deferMessage(to,text,pinnedVia||"");},
    // Routes through an intermediary. viaState reports what the panel is showing, not
    // what viaCandidates computes, so a check reads the same thing the operator sees.
    viaCandidates(target){return viaCandidates(String(target||"").toUpperCase(),Date.now())
      .map(row=>({via:row.via,mySnr:row.mySnr,toTargetSnr:row.toTargetSnr,
        toTargetDetail:row.toTargetDetail,fromTargetSnr:row.fromTargetSnr,
        hearsMe:row.hearsMe,stale:row.stale}));},
    viaState(){return {hidden:dom.viaRoutes.hidden,open:dom.viaDetails.open,
      summary:dom.viaSummary.textContent,badge:dom.viaBadge.hidden?"":dom.viaBadge.textContent,
      route:state.viaRoute?state.viaRoute.via:"",
      rows:[...dom.viaList.querySelectorAll("[data-via]")].map(node=>node.dataset.via),
      empty:(dom.viaList.querySelector(".via-empty")||{textContent:""}).textContent,
      hint:dom.sendHint.textContent};},
    viaChoose(via){chooseViaRoute(via);},
    viaSetOpen(open){dom.viaDetails.open=Boolean(open);state.viaOpen=Boolean(open);renderControls();},
    viaOpenState(){return state.viaOpen;},
    viaBlocked(){return viaBlockReasons(true);},
    // Wraps the extension point exactly the way a data-layer module does, so the check
    // exercises the seam itself and not a test-only branch inside it.
    mailSetRefusal(call){
      const want=String(call||"").toUpperCase();
      if(!mailRefusalBase)mailRefusalBase=mailPathRefusal;
      mailPathRefusal=want
        ?(target=>String(target||"").toUpperCase()===want?`${want} test refusal`:mailRefusalBase(target))
        :mailRefusalBase;
      renderControls();
    },
    msgBoxSendDeferred(station,options){return sendDeferredTo(String(station||"").toUpperCase(),
      js8Clock.now(),options||{});},
    msgBoxDeferred(){return msgBox.items("waiting").map(item=>({id:item.id,to:item.to,
      text:item.text,state:item.state,attempts:Number(item.attempts)||0,via:item.via||"",
      pinnedVia:item.pinnedVia||""}));},
    msgBoxPushHeld(station,options){return pushHeldMailTo(String(station||"").toUpperCase(),
      js8Clock.now(),options||{});},
    msgBoxParkVia(station,options){return parkDeferredVia(String(station||"").toUpperCase(),
      js8Clock.now(),options||{});},
    msgBoxHeardBy(station){return stationsHeardBy(station,js8Clock.now());},
    msgBoxSetFilter(filter){msgBoxFilter=filter;renderInbox();},
    // Cleanup between checks: a record left waiting would turn up in the parking
    // checks further down as a message they never parked.
    msgBoxDelete(id){const record=msgBox.remove(Number(id));syncInbox();renderInbox();return Boolean(record);},
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
    pushOutgoing(call,text,status){const c=String(call||"").toUpperCase();(state.conversations[c]||(state.conversations[c]=[])).push({direction:"outgoing",time:new Date().toISOString().slice(11,19),utcMs:Date.now(),text,sourceText:text,status:status||"completed"});},
    // Seeds a chat row with an explicit age: the thread's order across a midnight
    // boundary cannot be checked by waiting for one to go past.
    pushConversationAt(call,item){const c=String(call||"").toUpperCase();
      const utcMs=Number(item&&item.utcMs)||Date.now();
      (state.conversations[c]||(state.conversations[c]=[])).push({direction:"outgoing",
        status:"completed",...item,utcMs,time:new Date(utcMs).toISOString().slice(11,19)});
      renderConversation();},
    clearConversation(call){delete state.conversations[String(call||"").toUpperCase()];renderConversation();},
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
