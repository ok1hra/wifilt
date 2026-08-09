#!/usr/bin/env node
"use strict";

// Real multi-frame RX reassembly, end to end, with the production JSC dictionary.
//
// This is the test the earlier browser hooks could not be: it builds real
// multi-frame checksummed commands, feeds the frames through the production
// ActivityStore, and checks that the assembled message yields a clean,
// checksum-verified payload which the inbox/relay engines then act on correctly.
// No synthetic clean text is injected -- the payload only exists if reassembly
// works.

const fs = require("fs");
const path = require("path");
const protocol = require("../../../data/js8-protocol.js");
const {Js8Inbox} = require("../../../data/js8-inbox.js");
const {Js8Relay} = require("../../../data/js8-relay.js");

const JSC = path.resolve(__dirname, "../../../data/js8-jsc.bin");
let failed = false;
function check(condition, what) {
  if (!condition) { console.error(`REASSEMBLY FAIL: ${what}`); failed = true; }
  return condition;
}

const dictionary = new protocol.JscDictionary(fs.readFileSync(JSC));

// Build a directed message, feed every frame through a fresh ActivityStore, and
// return the completed message (with directed/payload/checksumOk).
function assemble(text, {tamper = null} = {}) {
  const store = new protocol.ActivityStore(dictionary);
  const frames = protocol.buildTxFrames({myCall: "K0OG", toCall: "OK1HRA", text});
  if (tamper) tamper(frames);
  let message = null;
  frames.forEach((frame, index) => {
    for (const event of store.push({raw: frame.raw, frameType: frame.frameType,
      submode: 1, slotUtcMs: index * 10000, snr: -10, offsetHz: 1500, dtMs: 0, quality: 1}))
      if (event.type === "message") message = event.message;
  });
  return {message, frames};
}

const ctx = {nowMs: 2 * 60000, myCall: "OK1HRA", armed: true,
  hearing: [{call: "OH8STN", snr: -8, lastSlotUtcMs: 60000}]};

// --- the store yields a clean, checksum-verified payload --------------------
{
  const {message} = assemble("MSG HELLO WORLD LONGER");
  check(message.checksumOk === true, "a valid MSG must verify its checksum");
  check(message.payload === "HELLO WORLD LONGER",
    `payload must be clean, got ${JSON.stringify(message.payload)}`);
  check(message.directed.from === "K0OG" && message.directed.to === "OK1HRA",
    "structured from/to must survive assembly");
}

// --- a corrupted frame fails the checksum -----------------------------------
{
  const bad = protocol.buildTxFrames({myCall: "K0OG", toCall: "OK1HRA", text: "MSG GOODBYE CRUEL WORLD"});
  const {message} = assemble("MSG HELLO WORLD LONGER", {tamper: frames => { frames[1] = bad[1]; }});
  check(message.checksumOk === false, "a tampered payload must fail the checksum");
}

// --- command normalisation matches the engines ------------------------------
{
  const cases = [
    [">OH8STN>HELLO JULIAN", {kind: "relay", text: "OH8STN>HELLO JULIAN"}],
    ["MSG SEE YOU SATURDAY", {kind: "inbox", command: "MSG", text: "SEE YOU SATURDAY"}],
    ["MSG TO:OH8STN QRV TONIGHT", {kind: "inbox", command: "MSG TO:", text: "TO:OH8STN QRV TONIGHT"}],
    ["QUERY MSG 5", {kind: "inbox", command: "QUERY MSG", text: "5"}],
    ["QUERY CALL OH8STN", {kind: "inbox", command: "QUERY CALL", text: "OH8STN"}],
  ];
  for (const [text, expect] of cases) {
    const {message} = assemble(text);
    const norm = protocol.normalizeAssembledCommand(message.directed.command, message.payload);
    check(norm && norm.kind === expect.kind, `${text}: kind ${norm && norm.kind}`);
    if (expect.command) check(norm.command === expect.command, `${text}: command ${norm && norm.command}`);
    check(norm && norm.text === expect.text, `${text}: text ${JSON.stringify(norm && norm.text)}`);
  }
}

// --- inbox acts on the reassembled payload ----------------------------------
{
  const inbox = new Js8Inbox();

  // MSG stored for us, ACK uses the one-frame reference command.
  let m = assemble("MSG SEE YOU SATURDAY").message;
  let n = protocol.normalizeAssembledCommand(m.directed.command, m.payload);
  let out = inbox.handle({from: m.directed.from, to: m.directed.to, command: n.command,
    text: n.text, complete: true}, ctx);
  check(out.action === "store" && out.record.text === "SEE YOU SATURDAY",
    "MSG must store the reassembled body");
  check(out.ack.text === "ACK", "MSG must use a plain ACK");

  // MSG TO: filed for a third station.
  m = assemble("MSG TO:OH8STN QRV TONIGHT").message;
  n = protocol.normalizeAssembledCommand(m.directed.command, m.payload);
  out = inbox.handle({from: m.directed.from, to: m.directed.to, command: n.command,
    text: n.text, complete: true}, ctx);
  check(out.action === "store" && out.record.to === "OH8STN" && out.record.text === "QRV TONIGHT",
    `MSG TO: must file under OH8STN, got ${JSON.stringify(out.record)}`);

  // QUERY MSG delivers it.
  m = assemble("QUERY MSG 1").message;
  n = protocol.normalizeAssembledCommand(m.directed.command, m.payload);
  out = inbox.handle({from: "OH8STN", to: m.directed.to, command: n.command,
    text: n.text, complete: true}, {...ctx, myCall: "OK1HRA"});
  // message 1 is addressed to K0OG (the MSG above), not OH8STN
  check(out.reason === "not-yours", "QUERY MSG must not hand over another station's mail");

  // QUERY CALL answered from the heard list.
  m = assemble("QUERY CALL OH8STN").message;
  n = protocol.normalizeAssembledCommand(m.directed.command, m.payload);
  out = inbox.handle({from: "K0OG", to: m.directed.to, command: n.command,
    text: n.text, complete: true}, ctx);
  check(out.text === "YES -08 (1m)",
    "QUERY CALL must confirm a heard station with SNR and age");
}

// --- relay acts on the reassembled path -------------------------------------
{
  const relay = new Js8Relay();
  const m = assemble(">OH8STN>HELLO JULIAN").message;
  const n = protocol.normalizeAssembledCommand(m.directed.command, m.payload);
  const out = relay.handle({from: m.directed.from, to: m.directed.to, text: n.text, complete: true}, ctx);
  check(out.action === "forward" && out.to === "OH8STN" && out.text === ">HELLO JULIAN DE K0OG",
    `relay must forward with attribution, got ${JSON.stringify(out)}`);
}

// --- partial receptions: nothing decoded is ever dropped silently ------------
//
// Every way a reassembly can end badly, driven by really withholding frames so a missed
// slot is a slot gap and not a synthetic flag. Submode 1 means a 10 s period, and the
// frames sit on consecutive slots, exactly as they arrive off the air.
const PERIOD_MS = 10000;
function receive(text, {drop = [], expireAtMs = null, discontinuity = false, then = null} = {}) {
  const store = new protocol.ActivityStore(dictionary);
  const frames = protocol.buildTxFrames({myCall: "K0OG", toCall: "OK1HRA", text});
  const push = (frame, index) => store.push({raw: frame.raw, frameType: frame.frameType,
    submode: 1, slotUtcMs: index * PERIOD_MS, snr: -10, offsetHz: 1500, dtMs: 0, quality: 1});
  frames.forEach((frame, index) => { if (!drop.includes(index)) push(frame, index); });
  if (then) then.frames.forEach((frame, index) => push(frame, then.startIndex + index));
  if (discontinuity) store.discontinuity();
  if (expireAtMs !== null) store.expire(expireAtMs);
  return {store, frames, messages: store.snapshot().messages,
          channels: store.snapshot().channels};
}

// A lost final frame is the one case that used to be invisible: the channel stayed in the
// reassembly map forever and no row was ever shown.
{
  const text = "MSG HELLO WORLD LONGER";
  const whole = receive(text);
  const last = whole.frames.length - 1;
  const lastSlot = (last - 1) * PERIOD_MS;

  const pending = receive(text, {drop: [last]});
  check(pending.messages.length === 0, "without its final frame a message must not complete");
  check(pending.channels.length === 1, "the partial reception must stay open");
  check(pending.channels[0].text.length > 0, "the partial must carry the text that arrived");

  const early = receive(text, {drop: [last], expireAtMs: lastSlot + 4 * PERIOD_MS - 1});
  check(early.messages.length === 0, "a reassembly must survive 3 missed slots");

  const aged = receive(text, {drop: [last], expireAtMs: lastSlot + 4 * PERIOD_MS});
  check(aged.messages.length === 1, "4 periods without a frame must finalize the torso");
  check(aged.messages[0].incomplete === true && aged.messages[0].complete === false,
    "the torso must be flagged incomplete");
  check(aged.messages[0].text === pending.channels[0].text.trimEnd(),
    "the torso must keep exactly the text that arrived");
  check(aged.channels.length === 0, "a finalized reception must leave the channel map");
}

// A frame lost in the middle: the slot gap says how many and where, and the checksum
// refuses the payload so nothing acts on it.
{
  const {messages} = receive("MSG HELLO WORLD LONGER", {drop: [1]});
  check(messages.length === 1, "the EOT frame still completes the message");
  const message = messages[0];
  check(message.complete === true, "a message whose last frame arrived is complete");
  check(message.gaps.length === 1 && message.gaps[0].frames === 1,
    `one lost frame must be recorded, got ${JSON.stringify(message.gaps)}`);
  check(message.gaps[0].slotUtcMs === PERIOD_MS,
    `the gap must name the missed slot, got ${message.gaps[0].slotUtcMs}`);
  check(message.gaps[0].textIndex > 0 && message.gaps[0].textIndex <= message.text.length,
    `the gap must sit inside the text, got ${message.gaps[0].textIndex}`);
  check(message.checksumOk === false, "a hole in the payload must fail the checksum");
}

// Tuned in mid-message: the header, and with it from/to/command, never arrived.
{
  const {messages} = receive("MSG HELLO WORLD LONGER", {drop: [0]});
  check(messages.length === 1 && messages[0].headerMissing === true,
    "a reception opened by a later frame must be flagged headerMissing");
  check(messages[0].directed === null, "without the first frame there is no directed header");
  check(messages[0].gaps.length === 0,
    "a missing header is not a slot gap: it is reported on its own");
}

// A new message taking the same channel used to overwrite the old text.
{
  const other = protocol.buildTxFrames({myCall: "OH8STN", toCall: "OK1HRA", text: "MSG SECOND MESSAGE HERE"});
  const {messages} = receive("MSG HELLO WORLD LONGER",
    {drop: [2], then: {frames: other, startIndex: 6}});
  check(messages.length >= 1 && messages[0].incomplete === true,
    "a superseded reception must be finalized, not overwritten");
  check(messages[0].text.length > 0, "the superseded torso must keep its text");
}

// A stream reset is exactly when frames are being lost, so it must not throw text away.
{
  const {messages, channels} = receive("MSG HELLO WORLD LONGER", {drop: [2],
    discontinuity: true});
  check(messages.length === 1 && messages[0].incomplete === true,
    "discontinuity must finalize what was already received");
  check(channels.length === 0, "discontinuity must leave no open reception");
}

// Regression anchor: gaps live beside the text, never inside it. If this ever fails, the
// inbox, relay, file transfer, APRS parsing and the dedup key are all affected.
{
  const {messages} = receive("MSG HELLO WORLD LONGER");
  const message = messages[0];
  check(message.text === "K0OG: OK1HRA MSG HELLO WORLD LONGER " + protocol.checksum16("HELLO WORLD LONGER"),
    `an intact message must keep byte-identical text, got ${JSON.stringify(message.text)}`);
  check(message.payload === "HELLO WORLD LONGER", "an intact payload must stay clean");
  check(message.complete === true && message.incomplete === false, "an intact message is complete");
  check(message.gaps.length === 0 && message.headerMissing === false,
    "an intact message has no gaps and no missing header");
}

// The finished message must carry the SNR of its LAST frame, not the first and not a
// mean: every other number on the row (timestamp, age) is the last slot too. Feeding a
// rising SNR proves the field is refreshed per frame rather than captured at channel
// construction, which is the mistake that would leave a five-frame message reporting the
// conditions it opened in.
{
  const store = new protocol.ActivityStore(dictionary);
  const frames = protocol.buildTxFrames({myCall: "K0OG", toCall: "OK1HRA",
    text: "MSG HELLO WORLD LONGER"});
  check(frames.length >= 3, `this check needs a multi-frame message, got ${frames.length}`);
  let message = null;
  frames.forEach((frame, index) => {
    for (const event of store.push({raw: frame.raw, frameType: frame.frameType,
      submode: 1, slotUtcMs: index * 10000, snr: -20 + index, offsetHz: 1500,
      dtMs: 0, quality: 1}))
      if (event.type === "message") message = event.message;
  });
  check(message.snr === -20 + frames.length - 1,
    `message must carry the last frame's SNR, got ${message.snr}`);
}

// Occupied width per submode, against the same arithmetic the C++ core uses:
// bandwidthHz() = 8 tones x 12000/samplesPerSymbol12k, with samplesPerSymbol12k from
// kSubmodes in js8_core.cpp. Hard-coding the products here is what lets the browser draw
// a signal's width without loading the wasm, so the two must be checked against each
// other rather than against a second copy of the same table.
{
  const samplesPerSymbol12k = {0: 1920, 1: 1200, 2: 600, 4: 3840, 8: 384};
  for (const [submode, samples] of Object.entries(samplesPerSymbol12k))
    check(protocol.bandwidthHz(Number(submode)) === 8 * 12000 / samples,
      `submode ${submode} width must be 8 x 12000/${samples}, got ${protocol.bandwidthHz(Number(submode))}`);
  check(protocol.bandwidthHz(99) === 50, "an unknown submode falls back to the Normal width");
}

if (failed) process.exit(1);
console.log("REASSEMBLY PASS multi-frame MSG/MSG TO:/QUERY MSG/QUERY CALL/relay " +
  "assembled+checksum-verified+dispatched; tamper rejected; " +
  "lost EOT/middle/header frame, supersede and discontinuity all finalize with markers; " +
  "message carries last-frame SNR; submode widths match the C++ derivation");
