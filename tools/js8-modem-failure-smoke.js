#!/usr/bin/env node
"use strict";

// A modem worker whose script never loads posts no message at all -- it raises
// `error` and nothing else. The page's whole startup display is driven by worker
// messages, so before this contract existed the JS8 page sat on "Loading
// JS8Call-ICOM modem 0%" for ever, with the RETRY button hidden because nothing
// had declared a failure. These checks pin the two orders the failure can arrive
// in, the second of which is the real one: the constructor creates the worker and
// onEvent() is chained on afterwards, so the first error has nobody to tell yet.

const path = require("path");
const {createJs8ModemAdapter} = require(path.resolve(__dirname, "../data/js8-adapter.js"));

class DecoderBase {
  constructor(sampleRate) { this.sampleRate = sampleRate; }
  onText(callback) { this._emit = callback; return this; }
}
class EncoderBase { constructor(sampleRate) { this.sampleRate = sampleRate; } }

function makeAdapter() {
  const worker = {posted: [], postMessage(value) { this.posted.push(value); }, terminate() {}};
  const adapter = createJs8ModemAdapter({
    DecoderBase, EncoderBase,
    createWorker: () => worker,
    createTxController: () => ({}),
    workerInit: {runtimeJs: "/js8-worker-runtime.js"},
  });
  return {adapter, worker};
}

const failure = {message: "Failed to load script", filename: "/js8-worker.js?v=1", lineno: 0,
  preventDefault() { this.defaultPrevented = true; }};

const checks = {};

// The order that actually happens on the page.
{
  const {adapter, worker} = makeAdapter();
  const decoder = new adapter.Decoder(8000);
  checks.initPosted = worker.posted.length === 1 && worker.posted[0].type === "init";
  worker.onerror({...failure, preventDefault: failure.preventDefault});
  const events = [];
  decoder.onText(() => {}).onEvent(event => events.push(event));
  checks.bufferedUntilListener = events.length === 1 && events[0].type === "error";
  checks.bufferedNamesTheScript = Boolean(events[0] && /js8-worker\.js/.test(events[0].message));
  checks.bufferedDeliveredOnce = (() => {
    const before = events.length;
    decoder.onEvent(event => events.push(event));
    return events.length === before;   // handed over, not kept for every listener
  })();
}

// A listener already attached takes the failure straight away.
{
  const {adapter, worker} = makeAdapter();
  const events = [];
  new adapter.Decoder(8000).onText(() => {}).onEvent(event => events.push(event));
  worker.onerror({...failure, preventDefault: failure.preventDefault});
  checks.liveListener = events.length === 1 && events[0].type === "error";
  worker.onmessageerror({});
  checks.messageError = events.length === 2 && /undecodable/.test(events[1].message);
}

// The browser's default action for a worker error is a console-level report the
// page cannot see; the adapter cancels it because it reports the failure itself.
{
  const {adapter, worker} = makeAdapter();
  new adapter.Decoder(8000).onText(() => {}).onEvent(() => {});
  const event = {...failure, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }};
  worker.onerror(event);
  checks.defaultPrevented = event.defaultPrevented === true;
}

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
const report = `JS8 MODEM FAILURE ${failed.length ? "FAIL" : "PASS"} ${JSON.stringify(checks)}`;
(failed.length ? console.error : console.log)(report);
if (failed.length) process.exitCode = 1;
