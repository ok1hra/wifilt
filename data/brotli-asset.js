// Fetch a .br asset and expand it with js8-brotli.wasm -- shared by
// data/js8-worker.js (decoder WASM, JSC dictionary) and data/mercury-host-loader.js
// (mercury-host.wasm).
//
// Browsers advertise Brotli only over HTTPS, so on plain device HTTP the
// firmware never answers with Content-Encoding: br and these files arrive as
// opaque bytes. They are still worth it: q11 Brotli is ~140 kB smaller than
// the firmware's own gzip for these blobs, net of the 72 kB decoder.
//
// The .br copies are not in git: tools/gzip-assets.sh makes them, and a tree
// run straight from a checkout (`make -C native run`) has none. The plain
// files ARE in git, so a 404 on the .br falls back to them -- a bigger first
// load, but a modem that starts. Only when both are gone is it an error, and
// then it names the files and the command instead of "fetch failed: 404".
(function (root) {
  // The path the operator can look for in data/, without the ?v= cache key.
  const assetPath = url => String(url).split("?")[0];

  const fetchBytes = async (url, label) => {
    const response = await fetch(url);
    if (!response.ok) {
      const error = new Error(`${label} fetch failed: ${assetPath(url)} answered HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return new Uint8Array(await response.arrayBuffer());
  };

  // `fetch` is the caller's (url) -> bytes, so a caller with a progress bar
  // keeps its own; `onExpand` runs between download and decode.
  const fetchExpanded = async ({module, url, outputSize, label,
                                fetch = u => fetchBytes(u, label), onExpand}) => {
    let input;
    try {
      input = await fetch(url);
    } catch (error) {
      if (error.status !== 404) throw error;
      const plainUrl = String(url).replace(/\.br(?=\?|$)/, "");
      let plain;
      try {
        plain = await fetch(plainUrl);
      } catch (plainError) {
        if (plainError.status !== 404) throw plainError;
        throw new Error(`${label} is missing on the server: neither ${assetPath(url)} ` +
          `nor ${assetPath(plainUrl)} exists. The web folder (data/) is incomplete -- ` +
          "reinstall it, or from a source checkout run ./tools/gzip-assets.sh");
      }
      if (plain.length !== outputSize)
        throw new Error(`${label}: ${assetPath(plainUrl)} is ${plain.length} bytes, ` +
          `expected ${outputSize} -- the web folder (data/) is from another version`);
      return plain;
    }
    if (onExpand) onExpand(input.length);
    const inputPtr = module._malloc(input.length);
    const sizePtr = module._malloc(4);
    const outputPtr = module._malloc(outputSize);
    try {
      module.HEAPU8.set(input, inputPtr);
      module.HEAPU32[sizePtr >> 2] = outputSize;
      const result = module._BrotliDecoderDecompress(
        input.length, inputPtr, sizePtr, outputPtr);
      const written = module.HEAPU32[sizePtr >> 2];
      if (result !== 1 || written !== outputSize)
        throw new Error(`${label} Brotli decode failed (${result}, ${written}/${outputSize})`);
      return module.HEAPU8.slice(outputPtr, outputPtr + written);
    } finally {
      module._free(outputPtr); module._free(sizePtr); module._free(inputPtr);
    }
  };

  root.BrotliAsset = {assetPath, fetchBytes, fetchExpanded};
})(self);
