// SPDX-License-Identifier: GPL-3.0-or-later
// TS-480 panel AF in the browser: RX audio from local-trx's sound card is
// played here, and while PTT is held the microphone goes back. Both ways the
// wire format is local-trx's own: 8 kHz mono G.711 µ-law in WebSocket binary
// frames (ts480_ws.h). Shared by the palette (qrplog.js) and the full panel
// (panel.html).
//
//   const audio = new Ts480Audio(bytes => ws.send(bytes));
//   await audio.startRx();      // inside a click: browsers start audio only on a gesture
//   audio.pushRx(arrayBuffer);  // each binary frame from the WebSocket
//   await audio.startMic();     // getUserMedia: https or localhost only
//   audio.setTx(true|false);    // microphone frames flow only while true
(function () {
  "use strict";
  if (window.Ts480Audio) return;

  const RATE = 8000;
  const FRAME = 160;          // 20 ms
  const LEAD = 0.25;          // jitter buffer, s
  const MAX_AHEAD = 0.8;      // more queued than this: drop, keep latency down

  const DECODE = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xFF, sign = u & 0x80, exponent = (u >> 4) & 7, mantissa = u & 0x0F;
    let s = ((mantissa << 3) + 0x84) << exponent;
    s -= 0x84;
    DECODE[i] = (sign ? -s : s) / 32768;
  }
  function ulawEncode(x) {   // x: -1..1
    let s = Math.max(-32635, Math.min(32635, Math.round(x * 32767)));
    const sign = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    s += 0x84;
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && !(s & mask); mask >>= 1) exponent--;
    const mantissa = (s >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }

  // Collects microphone blocks on the audio thread and hands them over.
  const WORKLET = `
class Ts480Mic extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("ts480-mic", Ts480Mic);`;

  class Ts480Audio {
    constructor(sendBinary) {
      this.sendBinary = sendBinary;
      this.ctx = null;
      this.gain = null;
      this.next = 0;
      this.rxOn = false;
      this.tx = false;
      this.mic = null;
      this.micNode = null;
      this.micSource = null;
      this.acc = 0;            // decimator phase
      this.sum = 0;
      this.count = 0;
      this.out = [];
    }

    // Microphone needs a secure context (https or localhost).
    static canMic() {
      return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
        window.AudioWorkletNode);
    }

    async ensureContext() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return this.ctx;
    }

    // True when the browser still refuses to play (no user gesture yet).
    get blocked() { return !!(this.ctx && this.ctx.state !== "running" && this.rxOn); }

    async startRx() {
      await this.ensureContext();
      this.rxOn = true;
      this.next = 0;
    }

    stopRx() {
      this.rxOn = false;
      this.next = 0;
    }

    pushRx(data) {
      if (!this.rxOn || !this.ctx || this.ctx.state !== "running") return;
      const bytes = new Uint8Array(data);
      if (!bytes.length) return;
      const now = this.ctx.currentTime;
      if (this.next < now) this.next = now + LEAD;               // underrun: rebuild the lead
      if (this.next - now > MAX_AHEAD) return;                   // too far behind: drop this chunk
      const buffer = this.ctx.createBuffer(1, bytes.length, RATE);
      const ch = buffer.getChannelData(0);
      for (let i = 0; i < bytes.length; i++) ch[i] = DECODE[bytes[i]];
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.start(this.next);
      this.next += buffer.duration;
    }

    async startMic() {
      if (this.mic) return;
      if (!Ts480Audio.canMic()) throw new Error("microphone needs https or localhost");
      const ctx = await this.ensureContext();
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      this.micSource = ctx.createMediaStreamSource(this.mic);
      this.micNode = new AudioWorkletNode(ctx, "ts480-mic");
      this.micNode.port.onmessage = e => this.onMic(e.data);
      this.micSource.connect(this.micNode);
      // A worklet only runs when connected towards the destination; muted.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      this.micNode.connect(mute).connect(ctx.destination);
    }

    stopMic() {
      this.setTx(false);
      if (this.micSource) this.micSource.disconnect();
      if (this.micNode) this.micNode.disconnect();
      if (this.mic) this.mic.getTracks().forEach(t => t.stop());
      this.mic = this.micNode = this.micSource = null;
    }

    // RX is muted while transmitting: the speaker must not feed the microphone.
    setTx(on) {
      this.tx = !!on;
      this.out = [];
      this.acc = this.sum = this.count = 0;
      if (this.gain) this.gain.gain.value = this.tx ? 0 : 1;
    }

    onMic(block) {
      if (!this.tx) return;
      // Box-filter decimation to 8 kHz: averaging each output period is a
      // crude low-pass, enough for SSB voice.
      const step = RATE / this.ctx.sampleRate;
      for (let i = 0; i < block.length; i++) {
        this.sum += block[i];
        this.count++;
        this.acc += step;
        if (this.acc >= 1) {
          this.acc -= 1;
          this.out.push(ulawEncode(this.sum / this.count));
          this.sum = this.count = 0;
          if (this.out.length >= FRAME) {
            this.sendBinary(new Uint8Array(this.out).buffer);
            this.out = [];
          }
        }
      }
    }

    close() {
      this.stopMic();
      this.stopRx();
      if (this.ctx) this.ctx.close();
      this.ctx = null;
    }
  }

  window.Ts480Audio = Ts480Audio;
})();
