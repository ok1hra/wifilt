#!/usr/bin/env node
// Full software loopback for the communication layer.
//
// Every other gate tests one piece. This one closes the whole chain the way the
// page wires it, minus the radio:
//
//   incoming decoded frame
//     -> the production engines (restrictions, autoreply, relay, inbox, heartbeat)
//     -> the text they decide to transmit
//     -> the REAL WASM encoder -> 48 kHz PCM
//     -> the REAL WASM decoder -> decoded frame
//     -> assert the peer receives exactly what we meant to say
//
// If this passes, then on the actual IC-705 only the audio transport (AUD1 bytes
// over CI-V LAN) and PTT remain unverified -- the decode/decide/encode logic is
// proven end to end in software. Run:
//
//   node protocol/comms_loopback_smoke.js build-wasm/js8-prototype.js \
//        build-decoder-wasm/js8-decoder.js

const fs = require("fs");
const path = require("path");
const protocol = require("../protocol/protocol_runtime.js");
const {Js8Restrictions} = require("../../../data/js8-restrictions.js");
const {Js8AutoReply}    = require("../../../data/js8-autoreply.js");
const {Js8Relay}        = require("../../../data/js8-relay.js");
const {Js8Inbox}        = require("../../../data/js8-inbox.js");
const {Js8Heartbeat}    = require("../../../data/js8-heartbeat.js");

const MYCALL = "OK1HRA";
const MODE = 1;          // Fast: one 10 s period per frame, quick to decode
const TONE = 1500;
let failed = false;
function check(condition, what) {
  if (!condition) { console.error(`COMMS LOOPBACK FAIL: ${what}`); failed = true; }
  return condition;
}

async function loadModule(jsPath) {
  const absolute = path.resolve(jsPath);
  return require(absolute)({wasmBinary: fs.readFileSync(absolute.replace(/\.js$/, ".wasm"))});
}

// --- the page's routing, reproduced without the DOM -------------------------
// This is intentionally a copy of how data.js dispatches a decoded frame, so the
// loopback exercises the same decision path the browser uses.
function makeStation() {
  const restrictions = new Js8Restrictions();
  const autoReply = new Js8AutoReply({restrictions});
  const relay = new Js8Relay();
  const inbox = new Js8Inbox();
  const heartbeat = new Js8Heartbeat({restrictions});
  heartbeat.configure({enabled: true, ackEnabled: true, intervalMs: 15 * 60000}, 0);

  const INBOX_CMDS = new Set(["MSG", "MSG TO:", "QUERY MSGS", "QUERY MSG", "QUERY CALL"]);

  // Returns {to, text} for whatever the station would transmit, or null.
  function dispatch(decoded, ctxOver = {}) {
    const now = ctxOver.nowMs ?? 10 * 60000; // past the initial QSO lock
    const ctx = {nowMs: now, myCall: MYCALL, armed: true, auto: true,
      grid: "JO70AA", infoText: "50W VERT", statusText: "MONITORING",
      groups: ["@ALLCALL", "@HB"],
      hearing: [{call: "K0OG", snr: -12, lastSlotUtcMs: 9 * 60000},
        {call: "KD8SKZ", snr: -7, lastSlotUtcMs: 8 * 60000}],
      selectedCall: "", ...ctxOver};

    if (decoded.kind === "heartbeat") {
      const out = heartbeat.handleHeartbeat({from: decoded.from, snr: decoded.snr ?? -10},
        {...ctx, submode: decoded.submode ?? MODE});
      return out.action === "ack" ? {to: out.to, text: out.text} : null;
    }
    const command = String(decoded.command || "").trim().toUpperCase();
    if (decoded.kind === "directed" && command === ">") {
      const out = relay.handle({...decoded, complete: true}, ctx);
      if (out.action === "forward") return {to: out.to, text: out.text};
      if (out.action === "deliver" && out.ack) return {to: out.ack.to, text: out.ack.text};
      return null;
    }
    if (decoded.kind === "directed" && INBOX_CMDS.has(command)) {
      const out = inbox.handle({...decoded, complete: true}, ctx);
      // A duplicate is a lost ACK coming back: no second record, same answer.
      if ((out.action === "store" || out.action === "duplicate") && out.ack)
        return {to: out.ack.to, text: out.ack.text};
      if (out.action === "reply" || out.action === "deliver") return {to: out.to, text: out.text};
      return null;
    }
    const out = autoReply.handle({from: decoded.from, to: decoded.to, command: decoded.command,
      snr: decoded.snr ?? -12, complete: true}, ctx);
    return out.action === "reply" ? {to: out.to, text: out.text} : null;
  }

  return {dispatch, autoReply};
}

async function main() {
  const portable = await loadModule(process.argv[2]);
  const decoder = await loadModule(process.argv[3]);

  // Encode a directed message the way the TX path does: build frames, modulate
  // each to real 48 kHz PCM.
  function encodeMessage(toCall, text) {
    const frames = protocol.buildReplyFrames({myCall: MYCALL, toCall, text});
    return frames.map(frame => {
      const framePtr = portable._malloc(12);
      portable.HEAPU8.set(Buffer.from(frame.raw, "ascii"), framePtr);
      const need = portable._js8_proto_modulate_frame48k(framePtr, frame.frameType, MODE, TONE, 0.65, 0, 0);
      const pcmPtr = portable._malloc(need * 2);
      const count = portable._js8_proto_modulate_frame48k(framePtr, frame.frameType, MODE, TONE, 0.65, pcmPtr, need);
      const pcm = portable.HEAP16.slice(pcmPtr >> 1, (pcmPtr >> 1) + count);
      portable._free(pcmPtr); portable._free(framePtr);
      if (count !== need) throw new Error("modulator length mismatch");
      return {raw: frame.raw, pcm};
    });
  }

  const handle = decoder._js8_wasm_decoder_create();
  const eventPtr = decoder._malloc(44);
  // Decode one modulated frame back to its raw 12-character payload.
  function decodePcm(pcm48) {
    const pcm12 = new Int16Array(120000); // one Fast period at 12 kHz
    for (let i = 0; i * 4 + 3 < pcm48.length; i += 1) pcm12[i] = pcm48[i * 4 + 3];
    const pcmPtr = decoder._malloc(pcm12.byteLength);
    decoder.HEAP16.set(pcm12, pcmPtr >> 1);
    decoder._js8_wasm_decoder_run(handle, pcmPtr, pcm12.length, MODE, 0, 5000, TONE);
    decoder._free(pcmPtr);
    const raws = [];
    while (decoder._js8_wasm_decoder_next_event(handle, eventPtr)) {
      const bytes = decoder.HEAPU8.slice(eventPtr + 16, eventPtr + 29);
      const zero = bytes.indexOf(0);
      raws.push(Buffer.from(zero < 0 ? bytes : bytes.slice(0, zero)).toString("ascii"));
    }
    return raws;
  }

  // The full round trip for one scenario: an incoming frame arrives, the station
  // decides what to say, we encode and decode it, and check the peer sees the
  // right directed message addressed back to the asker.
  function roundTrip(label, incoming, ctxOver, expect) {
    const station = makeStation();
    const reply = station.dispatch(incoming, ctxOver);
    if (!check(reply, `${label}: station produced no reply`)) return;
    check(reply.to === expect.to, `${label}: reply addressed to ${reply.to}, expected ${expect.to}`);

    const encoded = encodeMessage(reply.to, reply.text);
    const decodedRaws = [];
    for (const frame of encoded) for (const raw of decodePcm(frame.pcm)) decodedRaws.push(raw);

    // Every frame we generated must decode back byte-for-byte.
    for (const frame of encoded)
      check(decodedRaws.includes(frame.raw),
        `${label}: frame ${frame.raw} did not survive encode->decode`);

    // The first frame, decoded as a protocol frame, must be the directed reply.
    const firstDecoded = protocol.decodeFrame({raw: encoded[0].raw, frameType: 3,
      submode: 0, slotUtcMs: 0, snr: 0, offsetHz: TONE});
    check(firstDecoded.from === MYCALL, `${label}: reply not from us (${firstDecoded.from})`);
    check(firstDecoded.to === expect.to, `${label}: reply not to ${expect.to} (${firstDecoded.to})`);
    if (expect.command)
      check(String(firstDecoded.command || "").trim() === expect.command,
        `${label}: command was ${JSON.stringify(firstDecoded.command)}, expected ${expect.command}`);
    console.log(`  ${label}: "${MYCALL}: ${reply.to} ${reply.text}" -> ` +
      `${encoded.length} frame(s), decoded ${firstDecoded.command ? firstDecoded.command.trim() : "text"} OK`);
  }

  function noReply(label, incoming, ctxOver = {}) {
    const station = makeStation();
    check(station.dispatch(incoming, ctxOver) === null,
      `${label}: reference-compatible station must stay silent`);
    console.log(`  ${label}: no reply OK`);
  }

  // --- the scenarios that must work on the air --------------------------------
  const from = "K0OG";
  roundTrip("SNR?",   {kind: "directed", from, to: MYCALL, command: " SNR?", snr: -12},
    {}, {to: from, command: "SNR"});
  roundTrip("GRID?",  {kind: "directed", from, to: MYCALL, command: " GRID?"},
    {}, {to: from, command: "GRID"});
  roundTrip("INFO?",  {kind: "directed", from, to: MYCALL, command: " INFO?"},
    {}, {to: from, command: "INFO"});
  noReply("@ALLCALL SNR?", {kind: "directed", from, to: "@ALLCALL",
    command: " SNR?", snr: -8});
  roundTrip("heartbeat ACK", {kind: "heartbeat", from, to: "@HB", command: "HEARTBEAT", snr: -15},
    {}, {to: from, command: "HEARTBEAT SNR"});
  roundTrip("MSG store ACK", {kind: "directed", from, to: MYCALL, command: " MSG", text: "SEE YOU SAT"},
    {}, {to: from});
  roundTrip("QUERY CALL", {kind: "directed", from, to: MYCALL,
    command: " QUERY CALL", text: "KD8SKZ"}, {}, {to: from, command: "YES"});
  roundTrip("relay forward", {kind: "directed", from, to: MYCALL, command: ">", text: "OH8STN>HELLO"},
    {}, {to: "OH8STN", command: ">"});

  decoder._free(eventPtr);
  decoder._js8_wasm_decoder_destroy(handle);

  if (failed) process.exit(1);
  console.log("COMMS LOOPBACK PASS chain=decode->decide->encode->decode " +
    "scenarios=8 (SNR?,GRID?,INFO?,ALLCALL-silence,HB-ACK,MSG,QUERY-CALL,relay)");
}

main().catch(error => { console.error("COMMS LOOPBACK FAIL", error); process.exit(1); });
