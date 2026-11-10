#!/usr/bin/env node
// PROTOTYPE — actual WASM TX audio, AUD1 packets, loopback decode and fail-safe.

const fs = require("fs");
const path = require("path");
const protocol = require("../protocol/protocol_runtime.js");
const {CaptureTxSink, TxController} = require("./tx_runtime.js");

async function loadModule(jsPath) {
  const absolute = path.resolve(jsPath);
  return require(absolute)({wasmBinary: fs.readFileSync(absolute.replace(/\.js$/, ".wasm"))});
}

async function main() {
  const portable = await loadModule(process.argv[2]);
  const decoder = await loadModule(process.argv[3]);
  const heartbeat = protocol.buildTxFrames({kind:"heartbeat", myCall:"OK1HRA", grid:"JO70"});
  const heartbeatDecoded = protocol.decodeFrame({...heartbeat[0], submode:0,
    slotUtcMs:0, snr:0, offsetHz:750});
  if (heartbeat.length !== 1 || heartbeat[0].frameType !== 3 ||
      heartbeatDecoded.kind !== "heartbeat" || heartbeatDecoded.from !== "OK1HRA" ||
      heartbeatDecoded.grid !== "JO70")
    throw new Error(`heartbeat frame mismatch: ${JSON.stringify(heartbeatDecoded)}`);
  const cq = protocol.buildTxFrames({kind:"cq", myCall:"OK1HRA", grid:"JO70", cq:"CQ CQ CQ"});
  const cqDecoded = protocol.decodeFrame({...cq[0], submode:0,
    slotUtcMs:0, snr:0, offsetHz:1500});
  if (cq.length !== 1 || cq[0].frameType !== 3 || cq[0].role !== "cq" ||
      cqDecoded.kind !== "cq" || cqDecoded.from !== "OK1HRA" ||
      cqDecoded.command !== "CQ CQ CQ" || cqDecoded.grid !== "JO70")
    throw new Error(`CQ frame mismatch: ${JSON.stringify(cqDecoded)}`);
  const generated = [];
  function driveUntil(controller, predicate, initialNow = 1000) {
    let now = initialNow;
    for (let step = 0; step < 10000; step += 1) {
      const state = controller.snapshot();
      if (predicate(state)) return state;
      now = state.status === "waiting-slot" ? state.prebufferStartUtcMs : now + 20;
      controller.tick(now);
    }
    throw new Error(`TX driver timeout: ${JSON.stringify(controller.snapshot())}`);
  }
  const encode = (frame, mode, toneHz) => {
    const framePtr = portable._malloc(12);
    portable.HEAPU8.set(Buffer.from(frame.raw, "ascii"), framePtr);
    const required = portable._js8_proto_modulate_frame48k(
      framePtr, frame.frameType, mode, toneHz, 0.65, 0, 0);
    const pcmPtr = portable._malloc(required * 2);
    const count = portable._js8_proto_modulate_frame48k(
      framePtr, frame.frameType, mode, toneHz, 0.65, pcmPtr, required);
    const pcm = portable.HEAP16.slice(pcmPtr >> 1, (pcmPtr >> 1) + count);
    portable._free(pcmPtr); portable._free(framePtr);
    if (count !== required) throw new Error("WASM TX modulator length mismatch");
    generated.push({frame, mode, pcm});
    return pcm;
  };

  const sink = new CaptureTxSink();
  const tx = new TxController({buildFrames: protocol.buildReplyFrames,
    encoder: encode, sink});
  tx.queue({myCall:"OK1HRA", toCall:"K0OG", text:"HELLO WORLD",
            mode:1, toneHz:1500}, 1000);
  tx.prepare(1000);
  driveUntil(tx, state => state.status === "completed");
  if (sink.ptt || sink.sessions.length !== 2 || tx.snapshot().status !== "completed")
    throw new Error("completed TX did not return to PTT OFF");
  if (!tx.snapshot().transitions.some(item => item.status === "prebuffering" &&
      item.detail.includes("PTT OFF")) ||
      !sink.events.some(item => item.type === "audio-start" && item.ptt === false))
    throw new Error("TX did not prebuffer with PTT OFF");

  const handle = decoder._js8_wasm_decoder_create();
  const eventPtr = decoder._malloc(44);
  const decoded = [];
  for (const item of generated) {
    const periodSamples = 120000; // Fast mode, 10 seconds at 12 kHz.
    const pcm12 = new Int16Array(periodSamples);
    for (let i = 0; i * 4 + 3 < item.pcm.length; i += 1) pcm12[i] = item.pcm[i * 4 + 3];
    const pcmPtr = decoder._malloc(pcm12.byteLength);
    decoder.HEAP16.set(pcm12, pcmPtr >> 1);
    decoder._js8_wasm_decoder_run(handle, pcmPtr, pcm12.length, item.mode, 0, 5000, 1500);
    decoder._free(pcmPtr);
    while (decoder._js8_wasm_decoder_next_event(handle, eventPtr)) {
      const bytes = decoder.HEAPU8.slice(eventPtr + 16, eventPtr + 29);
      const zero = bytes.indexOf(0);
      decoded.push(Buffer.from(zero < 0 ? bytes : bytes.slice(0, zero)).toString("ascii"));
    }
  }
  decoder._free(eventPtr); decoder._js8_wasm_decoder_destroy(handle);
  const expected = tx.snapshot().frames.map(frame => frame.raw);
  if (!expected.every(raw => decoded.includes(raw)))
    throw new Error(`TX loopback mismatch expected=${expected} decoded=${decoded}`);

  const abortSink = new CaptureTxSink();
  const abortTx = new TxController({buildFrames: protocol.buildReplyFrames,
    encoder: encode, sink: abortSink});
  abortTx.queue({myCall:"OK1HRA", toCall:"K0OG", text:"ABORT ME",
                 mode:1, toneHz:1600}, 1000);
  abortTx.prepare(1000);
  driveUntil(abortTx, state => state.ptt);
  abortTx.abort("operator", abortTx.snapshot().nextSlotUtcMs + 100);
  if (abortSink.ptt || abortTx.snapshot().status !== "aborted")
    throw new Error("abort did not force PTT OFF");

  const disconnectSink = new CaptureTxSink();
  const disconnectTx = new TxController({buildFrames: protocol.buildReplyFrames,
    encoder: encode, sink: disconnectSink});
  disconnectTx.queue({myCall:"OK1HRA", toCall:"K0OG", text:"LINK LOSS",
                      mode:1, toneHz:1600}, 1000);
  disconnectTx.prepare(1000);
  driveUntil(disconnectTx, state => state.ptt);
  disconnectTx.disconnect(disconnectTx.snapshot().nextSlotUtcMs + 100);
  if (disconnectSink.ptt || disconnectTx.snapshot().status !== "aborted")
    throw new Error("disconnect did not force PTT OFF");

  const watchdogSink = new CaptureTxSink({drainReady:false});
  const watchdogTx = new TxController({buildFrames: protocol.buildReplyFrames,
    encoder: encode, sink: watchdogSink});
  watchdogTx.queue({myCall:"OK1HRA", toCall:"K0OG", text:"WATCHDOG",
                    mode:1, toneHz:1600}, 1000);
  watchdogTx.prepare(1000);
  driveUntil(watchdogTx, state => state.status === "fault");
  if (watchdogSink.ptt || watchdogTx.snapshot().status !== "fault")
    throw new Error("drain watchdog did not force PTT OFF");

  const pacingSink = new CaptureTxSink();
  const pacingTx = new TxController({buildFrames: protocol.buildReplyFrames,
    encoder: encode, sink: pacingSink});
  pacingTx.queue({myCall:"OK1HRA", toCall:"K0OG", text:"NO BURST",
                  mode:1, toneHz:1600}, 1000);
  pacingTx.prepare(1000);
  pacingTx.tick(pacingTx.snapshot().nextSlotUtcMs);
  if (pacingSink.ptt || pacingTx.snapshot().status !== "fault" ||
      !pacingTx.snapshot().error.includes("pacing"))
    throw new Error("missed pacing window did not fail with PTT OFF");

  // Mobile browsers can pause the main thread for a few hundred milliseconds.
  // A normal 400 ms pause near the start of prebuffering must still leave enough
  // time to fill the radio ring before the slot, without keying early.
  const jitterSink = new CaptureTxSink();
  const jitterTx = new TxController({buildFrames: protocol.buildReplyFrames,
    encoder: encode, sink: jitterSink});
  jitterTx.queue({myCall:"OK1HRA", toCall:"K0OG", text:"JITTER",
                  mode:1, toneHz:1600}, 1000);
  jitterTx.prepare(1000);
  const delayedTick = jitterTx.snapshot().prebufferStartUtcMs + 400;
  jitterTx.tick(delayedTick);
  driveUntil(jitterTx, state => state.status === "completed", delayedTick);
  if (jitterSink.ptt || jitterTx.snapshot().status !== "completed")
    throw new Error("400 ms browser pause caused a TX prebuffer failure");

  const timingClock = [100, 1300];
  const timingTx = new TxController({buildFrames:()=>[{role:"timing"}],
    encoder:()=>new Int16Array(48000), sink:new CaptureTxSink(),
    monotonicNow:()=>timingClock.shift()});
  timingTx.queue({mode:0,toneHz:1500},14000);
  timingTx.prepare(14000);
  if(timingTx.snapshot().nextSlotUtcMs!==30000)
    throw new Error(`TX slot ignored modulation time or safety lead: ${timingTx.snapshot().nextSlotUtcMs}`);

  const tuneSink = new CaptureTxSink();
  const tuneTx = new TxController({buildFrames:()=>[{role:"tune", durationSeconds:1}],
    encoder:()=>new Int16Array(48000), sink:tuneSink});
  tuneTx.queue({kind:"tune", immediate:true, mode:0, toneHz:1750},1000);
  tuneTx.prepare(1000);
  // 250 ms prebuffer + 200 ms stream lead + 100 ms margin: keyed ~0.55 s after the press.
  if(tuneTx.snapshot().nextSlotUtcMs<1550 || tuneTx.snapshot().nextSlotUtcMs>=1600 ||
     !tuneTx.snapshot().immediate)
    throw new Error("TUNE was not scheduled immediately");
  driveUntil(tuneTx,state=>state.ptt,1000);
  tuneTx.abort("operator",tuneTx.snapshot().nextSlotUtcMs+100);
  if(tuneSink.ptt || tuneTx.snapshot().status!=="aborted")
    throw new Error("TUNE stop did not force PTT OFF");

  console.log(`TX PASS frames=${expected.length} decoded=${JSON.stringify(decoded)} ` +
              `sessions=${sink.sessions.length} packets=${sink.sessions.reduce((n,s)=>n+s.packets.length,0)} ` +
              `final_ptt=${sink.ptt} abort_ptt=${abortSink.ptt} ` +
              `disconnect_ptt=${disconnectSink.ptt} watchdog_ptt=${watchdogSink.ptt} ` +
              `pacing_ptt=${pacingSink.ptt} jitter_ptt=${jitterSink.ptt} ` +
              `tune_ptt=${tuneSink.ptt}`);
  console.log(`TX STATE ${JSON.stringify(tx.snapshot())}`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
