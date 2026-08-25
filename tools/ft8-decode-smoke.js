// FT8 decode round-trip smoke test for the vendored data/ft8ts.js.
//
// Proves the receive path WIFILT actually uses: the radio delivers 8000 Hz audio
// over AUD1, and we hand it straight to decodeFT8(samples, {sampleRate: 8000}),
// which resamples internally to 12000 Hz before the FFT/LDPC stage. Encoding a
// valid 8 kHz FT8 waveform here (samplesPerSymbol scaled to the rate) and decoding
// it back confirms that path without needing a radio.
//
// Run: node tools/ft8-decode-smoke.js

global.self = global; // data/ft8ts.js targets a browser/worker global
require(require('path').join(__dirname, '..', 'data', 'ft8ts.js'));
const { encodeFT8, decodeFT8 } = global.FT8TS;

// FT8 symbol duration is 0.16 s, so samplesPerSymbol tracks the sample rate:
//   12000 Hz -> 1920 (library default), 8000 Hz -> 1280.
const SPS_12K = 1920;
const spsFor = rate => Math.round(SPS_12K * rate / 12000);

function trial(msg, sampleRate, baseHz) {
  const sps = spsFor(sampleRate);
  const samples = encodeFT8(msg, { sampleRate, samplesPerSymbol: sps, baseFrequency: baseHz });
  const dec = decodeFT8(samples, { sampleRate, freqLow: 200, freqHigh: 3000, depth: 2 });
  const hit = dec.find(d => d.msg.trim() === msg);
  const detail = hit
    ? `OK "${hit.msg}" snr=${hit.snr.toFixed(1)} freq=${hit.freq.toFixed(1)} dt=${hit.dt.toFixed(2)}`
    : 'MISS';
  console.log(`  rate=${sampleRate} sps=${sps} base=${baseHz}Hz  ${(samples.length / sampleRate).toFixed(2)}s  decodes=${dec.length}  ${detail}`);
  return !!hit;
}

const messages = ['CQ OK1ABC JN79', 'OK1ABC OK1CDJ -12', 'OK1CDJ OK1ABC RR73'];
let ok = true;
console.log('== baseline 12000 Hz ==');
for (const m of messages) ok = trial(m, 12000, 1500) && ok;
console.log('== RX path 8000 Hz (as delivered over AUD1) ==');
for (const m of messages) ok = trial(m, 8000, 1500) && ok;

console.log(ok ? '\nPASS: all FT8 round-trips decoded' : '\nFAIL: missing decodes');
process.exit(ok ? 0 : 1);
