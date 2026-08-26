// FT8 decode worker. Runs the CPU-heavy ft8ts decode (FFT + LDPC/OSD) off the
// main thread so the waterfall and UI stay smooth. The page (ft8.js) collects one
// UTC slot of 8 kHz audio and posts it here; we reply with the decoded messages.
//
// Classic worker (not a module) so it loads the vendored classic-global build with
// importScripts() — matching the rest of WIFILT's no-bundler asset pipeline. The
// ?v= cache-busting query is stamped into the importScripts URL by ft8.js at
// construction time and forwarded here via the init message, so the worker always
// pulls the same ft8ts.js revision the page was built against.

let ready = false;

function loadEngine(version) {
  if (ready) return;
  const query = version ? ('?v=' + version) : '';
  importScripts('/ft8ts.js' + query);
  ready = true;
}

onmessage = (event) => {
  const data = event.data || {};

  if (data.type === 'init') {
    try {
      loadEngine(data.version);
      postMessage({ type: 'ready' });
    } catch (error) {
      postMessage({ type: 'error', message: String(error && error.message || error) });
    }
    return;
  }

  if (data.type === 'decode') {
    const { slotUtcMs, samples, sampleRate } = data;
    try {
      loadEngine(data.version);
      const started = Date.now();
      const decodes = self.FT8TS.decodeFT8(samples, {
        sampleRate,
        freqLow: 200,
        freqHigh: 3000,
        depth: 2,
      });
      postMessage({
        type: 'decodes',
        slotUtcMs,
        elapsedMs: Date.now() - started,
        decodes: decodes.map((d) => ({
          msg: d.msg,
          snr: d.snr,
          dt: d.dt,
          freq: d.freq,
          sync: d.sync,
        })),
      });
    } catch (error) {
      postMessage({ type: 'error', slotUtcMs, message: String(error && error.message || error) });
    }
  }
};
