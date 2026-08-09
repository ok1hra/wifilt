#!/usr/bin/env node
"use strict";

// Stage 1 of docs/js8-skupiny-implementace.md: joining groups and choosing where to
// answer a query that was addressed to one. Both are pure functions on purpose --
// the offset choice in particular has to be reproducible, which is the whole reason
// it hashes the callsign instead of drawing a random slot.

const Js8Settings = require("../data/js8-settings.js");
const Js8Protocol = require("../data/js8-protocol.js");

const builtins = Js8Protocol.SPECIAL_CALLS.filter(call => call.startsWith("@")
  && !Js8Settings.RESERVED_GROUPS.includes(call)
  && !Js8Settings.ALWAYS_GROUPS.includes(call));

const reasonFor = (result, value) =>
  (result.rejected.find(item => item.value === value) || {}).reason || "";

const typed = Js8Settings.validateGroups("@net, @emcomm @APRSIS @ALLCALL @ARESGA !!");
const stored = Js8Settings.validateGroups(["@NET", "@APRSIS", "@ARESGA"]);
const tooMany = Js8Settings.validateGroups(
  ["@NET", "@EMCOMM", "@ARES", "@RACES", "@SOTA", "@POTA", "@QRP", "@QRO", "@IOTA"], builtins);

// Two stations looking at the same empty band must not pick the same slot: that is the
// collision the whole mechanism exists to prevent.
const emptyBand = {frames: [], submode: 0, nowMs: 1000};
const mine = Js8Protocol.pickGroupReplyOffsetHz({...emptyBand, myCall: "OK1ABC"});
const theirs = Js8Protocol.pickGroupReplyOffsetHz({...emptyBand, myCall: "OK2XYZ"});

// A busy band: everything except one 50 Hz slot at 2000 Hz is occupied by a recent frame.
const occupied = [];
for (let hz = 1000; hz + 50 <= 2700; hz += 50)
  if (hz !== 2000) occupied.push({offsetHz: hz, submode: 0, slotUtcMs: 1000});
const onlyFree = Js8Protocol.pickGroupReplyOffsetHz(
  {frames: occupied, myCall: "OK1ABC", submode: 0, nowMs: 1000});

// The same band, but the frames are older than the horizon: nothing is busy any more.
const stale = Js8Protocol.pickGroupReplyOffsetHz(
  {frames: occupied, myCall: "OK1ABC", submode: 0, nowMs: 1000 + 15000 * 5});

// Nothing free at all has to be reported, not papered over with a made-up offset.
const full = [];
for (let hz = 1000; hz + 50 <= 2700; hz += 50) full.push({offsetHz: hz, submode: 0, slotUtcMs: 1000});
const noneFree = Js8Protocol.pickGroupReplyOffsetHz(
  {frames: full, myCall: "OK1ABC", submode: 0, nowMs: 1000});

// Stage 2: an addressee that does not fit the 28-bit callsign field travels as a pair --
// compound(MYCALL GRID) + compound-directed(@GROUP CMD) -- and the ordinary directed
// frame is not sent at all. Push the frames through the receive store to prove the pair
// comes back out as one directed message; a message with no addressee is invisible to
// every engine downstream.
// Data frames are JSC-compressed, so a store without the dictionary decodes them to an
// empty string -- a trap that once made reassembly look broken when it was not. Load the
// real dictionary so the payload check means something.
const dictionary = new Js8Protocol.JscDictionary(
  require("fs").readFileSync(require("path").join(__dirname, "..", "data", "js8-jsc.bin")));

function roundTrip(toCall, text) {
  const frames = Js8Protocol.buildReplyFrames(
    {myCall: "OK1HRA", grid: "JN79", toCall, text});
  const store = new Js8Protocol.ActivityStore(dictionary);
  let emitted = [];
  frames.forEach((frame, index) => {
    emitted = emitted.concat(store.push({...frame, slotUtcMs: 1000 + index * 15000,
      submode: 0, offsetHz: 1500, snr: -5, dtMs: 0, quality: 1}));
  });
  const message = emitted.filter(item => item.type === "message").pop();
  return {frames, message: message && message.message};
}

const custom = roundTrip("@ARESGA", "SNR?");
const builtin = roundTrip("@NET", "SNR?");
const compoundCall = roundTrip("PA/OK1ABC", "SNR?");
const freeText = roundTrip("@ARESGA", "HELLO NET");
const withSnr = roundTrip("@ARESGA", "SNR -12");

const checks = {
  // Case and a missing @ are typing, not an error.
  normalisesTyping: typed.groups.includes("@NET") && typed.groups.includes("@EMCOMM"),
  // A gateway is refused with a reason rather than dropped in silence.
  refusesGateway: /gateway/.test(reasonFor(typed, "@APRSIS")),
  refusesAlwaysJoined: /always joined/.test(reasonFor(typed, "@ALLCALL")),
  refusesGarbage: /not a group name/.test(reasonFor(typed, "@!!")) ||
    typed.rejected.some(item => /not a group name/.test(item.reason)),
  // Since stage 2 a custom name is joinable: it just costs a second frame.
  acceptsCustom: typed.groups.includes("@ARESGA"),
  storedKeepsCustom: stored.groups.includes("@ARESGA"),
  storedStillRefusesGateway: !stored.groups.includes("@APRSIS"),
  capped: tooMany.groups.length === Js8Settings.MAX_GROUPS &&
    tooMany.rejected.some(item => /at most/.test(item.reason)),
  // normalize() must agree with validateGroups(), or a saved profile would differ from
  // what the field accepted.
  normalizeDropsGateway:
    !Js8Settings.normalize({modems: {js8call: {groups: ["@APRSIS", "@NET"]}}})
      .modems.js8call.groups.includes("@APRSIS"),

  offsetInRange: mine >= 1000 && mine + 50 <= 2700,
  // The point of hashing the callsign: same band, different station, different slot.
  offsetDiffersPerStation: mine !== theirs,
  // Same input, same answer, every run.
  offsetDeterministic:
    Js8Protocol.pickGroupReplyOffsetHz({...emptyBand, myCall: "OK1ABC"}) === mine,
  offsetAvoidsOccupied: onlyFree === 2000,
  offsetIgnoresStaleFrames: stale !== null && stale !== undefined,
  offsetReportsNoneFree: noneFree === null,

  // A built-in name still costs exactly one frame — stage 2 must not make everything
  // expensive.
  builtinStaysOneFrame: builtin.frames.length === 1 &&
    !Js8Protocol.needsCompoundTo("@NET") && Js8Protocol.needsCompoundTo("@ARESGA"),
  customCostsTwoFrames: custom.frames.length === 2,
  // The pair comes back as one directed message with a real addressee.
  customReassembles: custom.message.directed.from === "OK1HRA" &&
    custom.message.directed.to === "@ARESGA" &&
    custom.message.directed.command === " SNR?" &&
    custom.message.text === "OK1HRA: @ARESGA SNR?" &&
    custom.message.complete === true,
  // Both callsigns land in the list, sender first, so the chat thread and the stations
  // table read a compound message exactly like a plain directed one.
  customCallsignOrder: custom.message.callsigns.join(" ") === "OK1HRA @ARESGA",
  // The same machinery carries a compound CALLSIGN, which used to decode to <....>.
  compoundCallsignReassembles: compoundCall.frames.length === 2 &&
    compoundCall.message.directed.to === "PA/OK1ABC" &&
    compoundCall.message.directed.from === "OK1HRA",
  // Free text to a group: pair plus data frames, and the payload survives intact.
  freeTextToGroup: freeText.frames.length > 2 &&
    freeText.message.directed.to === "@ARESGA" &&
    freeText.message.payload === "HELLO NET",
  // An SNR report is packed into the compound frame's number field, not dropped.
  snrSurvivesCompound: withSnr.message.directed.command === " SNR" &&
    withSnr.message.text.includes("-12")
};


// ---- stage 3: the group mailbox ------------------------------------------------------
// Group mail is the one record that survives its own delivery: every member may still
// come for it. That is why it keeps its STORE type and records WHO has had it, instead of
// flipping to DELIVERED the way personal mail does.
const Js8Inbox = require("../data/js8-inbox.js");

function freshBox() {
  const box = new Js8Inbox.Js8Inbox({});
  const ctx = {nowMs: 1000, myCall: "OK1HRA", groups: ["@NET"], armed: true};
  box.handle({from: "OK2AAA", to: "OK1HRA", command: "MSG TO:",
    text: "TO:@NET NET AT 1800", complete: true}, ctx);
  return {box, ctx};
}

const heldForNet = freshBox();
const strangerGroup = new Js8Inbox.Js8Inbox({}).handle(
  {from: "OK2AAA", to: "OK1HRA", command: "MSG TO:", text: "TO:@OTHER HELLO", complete: true},
  {nowMs: 1000, myCall: "OK1HRA", groups: ["@NET"], armed: true});

// Two different members each collect the same message once; a third attempt by the first
// is refused, and the sender never gets their own message back.
const both = freshBox();
const idFor = box => box.snapshot().items.find(i => i.to === "@NET").id;
const firstId = idFor(both.box);
const toB = both.box.handle({from: "OK3BBB", to: "@NET", command: "QUERY MSG",
  text: String(firstId), complete: true}, both.ctx);
both.box.confirmDelivered(firstId, "OK3BBB");
const toC = both.box.handle({from: "OK4CCC", to: "@NET", command: "QUERY MSG",
  text: String(firstId), complete: true}, both.ctx);
both.box.confirmDelivered(firstId, "OK4CCC");
const againToB = both.box.handle({from: "OK3BBB", to: "@NET", command: "QUERY MSG",
  text: String(firstId), complete: true}, both.ctx);
const backToSender = both.box.handle({from: "OK2AAA", to: "@NET", command: "QUERY MSG",
  text: String(firstId), complete: true}, both.ctx);

// QUERY MSGS addressed to the group answers from the group pool.
const asked = freshBox();
const groupQuery = asked.box.handle({from: "OK3BBB", to: "@NET", command: "QUERY MSGS",
  text: "", complete: true}, asked.ctx);

// Expiry is visible: the type changes and an event is emitted.
const events = [];
const ageing = new Js8Inbox.Js8Inbox({onEvent: event => events.push(event)});
const ageCtx = {nowMs: 1000, myCall: "OK1HRA", groups: ["@NET"], armed: true};
ageing.handle({from: "OK2AAA", to: "OK1HRA", command: "MSG TO:",
  text: "TO:@NET OLD NEWS", complete: true}, ageCtx);
const expiredCount = ageing.expireGroupMail(1000 + 25 * 3600000);
const expiredItem = ageing.snapshot().items.find(i => i.to === "@NET");
const afterExpiry = ageing.handle({from: "OK3BBB", to: "@NET", command: "QUERY MSG",
  text: String(expiredItem.id), complete: true}, ageCtx);

const stage3 = {
  storesGroupMail: heldForNet.box.snapshot().items.some(i => i.to === "@NET" && i.type === "STORE"),
  // Deliberate deviation from upstream, which accepts mail for any @NAME at all.
  refusesForeignGroup: strangerGroup.action === "skip" &&
    strangerGroup.reason === "not-my-group" && Boolean(strangerGroup.nack),
  deliversToFirstMember: toB.action === "deliver" && /TO @NET/.test(toB.text),
  survivesFirstDelivery: toC.action === "deliver",
  recordsWhoHadIt: both.box.snapshot().items
    .find(i => i.id === firstId).deliveredTo.join(" ") === "OK3BBB OK4CCC",
  refusesSecondHelping: againToB.action === "skip",
  neverBackToSender: backToSender.action === "skip",
  groupQueryAnswers: groupQuery.action === "reply" && /^YES MSG ID/.test(groupQuery.text),
  expiresVisibly: expiredCount === 1 && expiredItem.type === "EXPIRED" &&
    events.some(event => event.type === "expired"),
  expiredIsNotDelivered: afterExpiry.action === "skip" && afterExpiry.reason === "expired"
};
Object.assign(checks, stage3);

const pass = Object.values(checks).every(Boolean);
console.log(`JS8 GROUPS ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
if (!pass) process.exitCode = 1;
