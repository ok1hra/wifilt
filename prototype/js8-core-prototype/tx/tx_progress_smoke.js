#!/usr/bin/env node
"use strict";

const protocol = require("../protocol/protocol_runtime.js");
const {CaptureTxSink, TxController} = require("./tx_runtime.js");

const text = "THIS IS A LONG JS8 MESSAGE";
const frames = protocol.buildReplyFrames({myCall:"OK1HRA", toCall:"K0OG", text});
const dataFrames = frames.filter(frame => frame.role === "data");
const messageText = "OK1HRA: K0OG THIS IS A LONG JS8 MESSAGE";
if (frames.length !== 3 || frames[0].textStart !== 0 ||
    frames[0].textEnd !== "OK1HRA: K0OG ".length ||
    frames[0].messageText !== messageText ||
    dataFrames[0].textStart !== frames[0].textEnd || dataFrames[0].textEnd <= 0 ||
    dataFrames[1].textStart !== dataFrames[0].textEnd || dataFrames[1].textEnd !== messageText.length)
  throw new Error(`TX text ranges missing or discontinuous: ${JSON.stringify(frames)}`);

const sink = new CaptureTxSink();
const tx = new TxController({buildFrames:protocol.buildReplyFrames,
  encoder:() => new Int16Array(48000), sink, prebufferMs:100});
let now = 1000;
tx.queue({myCall:"OK1HRA", toCall:"K0OG", text, mode:8, toneHz:1500}, now);
tx.prepare(now);

function advanceUntil(predicate) {
  for (let step = 0; step < 5000; step += 1) {
    const state = tx.snapshot();
    if (predicate(state)) return state;
    now = state.status === "waiting-slot" && now < state.prebufferStartUtcMs
      ? state.prebufferStartUtcMs : now + 20;
    tx.tick(now);
  }
  throw new Error(`TX progress timeout: ${JSON.stringify(tx.snapshot())}`);
}

const headerMid = advanceUntil(state => state.frameIndex === 0 &&
  state.status === "transmitting" && state.frameProgress >= .4);
if (headerMid.frameProgress < .4 || headerMid.frameProgress >= .7)
  throw new Error(`Directed-header progress invalid: ${JSON.stringify(headerMid)}`);

const firstDataWaiting = advanceUntil(state => state.frameIndex === 1 &&
  state.status === "waiting-slot");
if (firstDataWaiting.frameProgress !== 0)
  throw new Error(`Progress advanced between slots: ${JSON.stringify(firstDataWaiting)}`);

const firstDataMid = advanceUntil(state => state.frameIndex === 1 &&
  state.status === "transmitting" && state.frameProgress >= .4);
if (firstDataMid.frameProgress < .4 || firstDataMid.frameProgress >= .7)
  throw new Error(`First data-frame progress invalid: ${JSON.stringify(firstDataMid)}`);

const secondDataWaiting = advanceUntil(state => state.frameIndex === 2 &&
  state.status === "waiting-slot");
if (secondDataWaiting.frameProgress !== 0)
  throw new Error(`Progress did not pause before second data slot: ${JSON.stringify(secondDataWaiting)}`);

console.log(`TX PROGRESS PASS frames=${frames.length} ranges=${dataFrames.map(frame =>
  `${frame.textStart}-${frame.textEnd}`).join(",")} pausedFrame=${secondDataWaiting.frameIndex}`);
