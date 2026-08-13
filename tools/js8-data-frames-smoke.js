#!/usr/bin/env node
"use strict";

// JS8 has two data-frame forms: the 2-bit-header one and the headerless "fast" one that
// uses all 72 bits. Upstream picks by submode (Varicode.cpp:2148), but the RECEIVER picks
// by the transmitted type bit (DecodedText::tryUnpackFastData tests `bits_ & JS8CallData`),
// so both are legal everywhere and the choice can be made on what actually fits.
//
// The golden vector below is not from our own encoder: it is a frame captured off the air
// from the real JS8Call, which is the only thing that can catch a mistake our decoder
// would make in the same direction as our encoder.

const fs = require("fs");
const path = require("path");
const Js8Protocol = require("../data/js8-protocol.js");

const dictionary = new Js8Protocol.JscDictionary(
  fs.readFileSync(path.join(__dirname, "..", "data", "js8-jsc.bin")));

// Captured 2026-08-06 from js8call --rig-name=WIFILT transmitting "@OK HELLO NET" on
// submode Fast, demodulated with prototype/js8-core-prototype js8-reference-decoder.
const CAPTURED_FAST_DATA = "UBXQW2V+++++";
const CAPTURED_COMPOUND = "B1-TZPV6OTT0";
const CAPTURED_COMPOUND_DIRECTED = "KneYZeBcO+N8";

const LONG = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AND KEEPS RUNNING FOR A WHILE";
const SUBMODES = [0, 1, 2, 4, 8];

function framesFor(mode, text = LONG) {
  return Js8Protocol.buildReplyFrames({myCall: "OK1RAK", toCall: "OK2XYZ", text, mode});
}

function roundTrip(mode, text = LONG) {
  const store = new Js8Protocol.ActivityStore(dictionary);
  let emitted = [];
  framesFor(mode, text).forEach((frame, index) => {
    emitted = emitted.concat(store.push({...frame, slotUtcMs: 1000 + index * 15000,
      submode: mode, offsetHz: 1500, snr: 0, dtMs: 0}));
  });
  const message = emitted.filter(item => item.type === "message").pop();
  return message && message.message;
}

const counts = Object.fromEntries(SUBMODES.map(mode => [mode, framesFor(mode).length]));

const checks = {
  // The type bit is load-bearing, not decoration: decode a data frame with the flag it
  // carries and with the other one, and only the carried flag gives the text back.
  typeBitIsLoadBearing: SUBMODES.every(mode =>
    framesFor(mode).filter(frame => frame.role === "data").every(frame => {
      const carried = (frame.frameType & 4) === 4;
      const asCarried = Js8Protocol.decodeFrame(
        {raw: frame.raw, frameType: carried ? 6 : 2}, dictionary).text;
      const asOther = Js8Protocol.decodeFrame(
        {raw: frame.raw, frameType: carried ? 2 : 6}, dictionary).text;
      return asCarried.length > 0 && asCarried !== asOther;
    })),
  // Normal stays exactly on upstream's rule: never the headerless form.
  normalNeverFast: framesFor(0).every(frame => (frame.frameType & 4) === 0),
  // Outside Normal the headerless form is used where it earns its place.
  fastUsedOutsideNormal: SUBMODES.filter(mode => mode !== 0)
    .every(mode => framesFor(mode).some(frame => (frame.frameType & 4) === 4)),
  // ...but never at the cost of a longer message. Copying upstream's rule blindly cost
  // three extra frames here, because the fast form has no Huffman variant.
  neverLongerThanNormal: SUBMODES.every(mode => counts[mode] <= counts[0]),
  payloadSurvivesEverySubmode: SUBMODES.every(mode => roundTrip(mode).payload === LONG),
  // Golden vector from the original, decoded by us.
  readsCapturedFastData:
    Js8Protocol.decodeFrame({raw: CAPTURED_FAST_DATA, frameType: 6}, dictionary)
      .text === "HELLO NET",
  // And the compound pair the same transmission opened with.
  readsCapturedCompoundPair: (() => {
    const store = new Js8Protocol.ActivityStore(dictionary);
    let emitted = [];
    [[CAPTURED_COMPOUND, 1], [CAPTURED_COMPOUND_DIRECTED, 0], [CAPTURED_FAST_DATA, 6]]
      .forEach(([raw, frameType], index) => {
        emitted = emitted.concat(store.push({raw, frameType: index === 2 ? 6 : frameType,
          slotUtcMs: 1000 + index * 10000, submode: 1, offsetHz: 1500, snr: 27, dtMs: 0}));
      });
    const message = emitted.filter(item => item.type === "message").pop().message;
    return message.directed.from === "OK1RAK" && message.directed.to === "@OK" &&
      message.payload === "HELLO NET";
  })(),
  // Our encoder still reproduces the original's compound pair bit for bit.
  matchesCapturedCompoundPair: (() => {
    const frames = Js8Protocol.buildReplyFrames({myCall: "OK1RAK", grid: "JO60WA",
      toCall: "@OK", text: "HELLO NET", mode: 1});
    return frames[0].raw === CAPTURED_COMPOUND &&
      frames[1].raw === CAPTURED_COMPOUND_DIRECTED;
  })(),
  // "MSG TO:OK1BT HI" must pack as the " MSG TO:" command (10) with the target
  // as the FIRST PAYLOAD WORD -- JS8Call's wire shape (its regex reads `MSG
  // TO[:]` with no space before the target). The old tokenizer required a space
  // after every token, fell through to " MSG", and left "TO:OK1BT HI" in the
  // data frames; a JS8Call intermediary then filed the whole thing as its own
  // operator's mail and the message was never stored for the third party.
  msgToWireShape: (() => {
    const frames = Js8Protocol.buildTxFrames({myCall: "OK1HRA", toCall: "HB9BV",
      text: "MSG TO:OK1BT HELLO", dictionary});
    const store = new Js8Protocol.ActivityStore(dictionary);
    let message = null;
    frames.forEach((frame, index) => {
      for (const event of store.push({raw: frame.raw, frameType: frame.frameType,
          submode: 0, offsetHz: 1500, snr: 0, dtMs: 0, slotUtcMs: index * 15000}))
        if (event.type === "message") message = event.message;
    });
    return Boolean(message) && message.directed.command === " MSG TO:" &&
      message.payload === "OK1BT HELLO" && message.checksumOk === true;
  })()
};

const pass = Object.values(checks).every(Boolean);
console.log(`JS8 DATA FRAMES ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)} frames=${JSON.stringify(counts)}`);
if (!pass) process.exitCode = 1;
