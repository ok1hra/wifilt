#!/usr/bin/env node
"use strict";

const protocol = require("./protocol_runtime.js");

function decoded(request) {
  const frames = protocol.buildTxFrames(request);
  return {frames, decoded: frames.map((frame, index) => protocol.decodeFrame({
    ...frame, submode:0, offsetHz:1500, slotUtcMs:index * 15000,
    snr:0, dtMs:0, quality:1
  }))};
}

const snr = decoded({myCall:"OK1HRA", toCall:"K0OG", text:"SNR -12"});
if (snr.frames.length !== 1 || snr.frames[0].raw !== "TBx2Q-uJkbaJ" ||
    snr.frames[0].messageText !== "OK1HRA: K0OG SNR -12" ||
    snr.frames[0].textStart !== 0 ||
    snr.frames[0].textEnd !== snr.frames[0].messageText.length ||
    snr.decoded[0].command !== " SNR" || snr.decoded[0].number !== "-12")
  throw new Error(`SNR must be one directed command frame: ${JSON.stringify(snr)}`);

const shortCommands = new Map([
  ["SNR?", " SNR?"], ["HW CPY?", " HW CPY?"], ["RR", " RR"],
  ["FB", " FB"], ["QSL?", " QSL?"], ["QSL", " QSL"],
  ["AGN?", " AGN?"], ["73", " 73"], ["SK", " SK"]
]);
for (const [text, command] of shortCommands) {
  const result = decoded({myCall:"OK1HRA", toCall:"K0OG", text});
  if (result.frames.length !== 1 || result.decoded[0].command !== command ||
      result.frames[0].messageText !== `OK1HRA: K0OG ${text}`)
    throw new Error(`${text} command mismatch: ${JSON.stringify(result)}`);
}

const mixed = decoded({myCall:"OK1HRA", toCall:"K0OG", text:"SNR -12 TU 4 CALL"});
if (mixed.frames.length !== 2 || mixed.decoded[0].command !== " SNR" ||
    mixed.decoded[0].number !== "-12" || mixed.decoded[1].text !== " TU 4 CALL" ||
    mixed.frames[1].textStart !== "OK1HRA: K0OG SNR -12".length ||
    mixed.frames[1].textEnd !== "OK1HRA: K0OG SNR -12 TU 4 CALL".length)
  throw new Error(`directed command continuation mismatch: ${JSON.stringify(mixed)}`);

const free = decoded({myCall:"OK1HRA", toCall:"K0OG", text:"HELLO WORLD"});
if (free.frames.length !== 2 || free.decoded[0].command !== " " ||
    free.frames[0].messageText !== "OK1HRA: K0OG HELLO WORLD" ||
    free.frames[0].textEnd !== "OK1HRA: K0OG ".length ||
    free.frames[1].textEnd !== free.frames[0].messageText.length)
  throw new Error(`directed free text mismatch: ${JSON.stringify(free)}`);

const heartbeat = decoded({kind:"heartbeat", myCall:"OK1HRA", grid:"JO70"});
if (heartbeat.frames.length !== 1 || heartbeat.frames[0].raw !== "31-QkpgqOT6W" ||
    heartbeat.frames[0].messageText !== "OK1HRA: @HB JO70" ||
    heartbeat.frames[0].textEnd !== heartbeat.frames[0].messageText.length ||
    heartbeat.decoded[0].kind !== "heartbeat" ||
    heartbeat.decoded[0].command !== "HEARTBEAT" ||
    heartbeat.decoded[0].text !== "OK1HRA: @HB JO70 ")
  throw new Error(`heartbeat mismatch: ${JSON.stringify(heartbeat)}`);

const extendedHeartbeat = decoded({kind:"heartbeat", myCall:"OK1HRA", grid:"JO70AA"});
const emptyGridHeartbeat = decoded({kind:"heartbeat", myCall:"OK1HRA", grid:""});
if (extendedHeartbeat.frames[0].raw !== heartbeat.frames[0].raw ||
    extendedHeartbeat.frames[0].messageText !== "OK1HRA: @HB JO70" ||
    emptyGridHeartbeat.frames[0].messageText !== "OK1HRA: @HB" ||
    emptyGridHeartbeat.decoded[0].grid !== "")
  throw new Error(`heartbeat grid projection mismatch: ${JSON.stringify({extendedHeartbeat,emptyGridHeartbeat})}`);

console.log(`DIRECTED TX PASS snr=${snr.frames[0].raw} commands=${shortCommands.size} ` +
  `mixedFrames=${mixed.frames.length} heartbeat=${heartbeat.frames[0].raw}`);
