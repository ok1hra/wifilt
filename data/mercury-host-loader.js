// Instantiates mercury-host.wasm from its .br copy, for both Mercury workers
// (mercury-worker.js, mercury-cal-worker.js). They load mercury-host.js,
// js8-brotli.js and brotli-asset.js first; see brotli-asset.js for why .br,
// and why a 404 falls back to the plain mercury-host.wasm.
//
// MERCURY_HOST_WASM_BYTES is rewritten by tools/build-mercury-assets.sh:
// Brotli needs the output size up front, and a mismatch is how a data/ tree
// from another build shows up -- as a named error, not a module that fails to
// instantiate.
(function (root) {
  const MERCURY_HOST_WASM_BYTES = 247509;

  // `query` is the worker's own ?v= (self.location.search): the blobs are
  // cached for an hour like every static file, and must move with the glue.
  root.loadMercuryHost = async (query = "") => {
    const brotli = await root.createJs8Brotli({locateFile: () => `js8-brotli.wasm${query}`});
    const wasmBinary = await root.BrotliAsset.fetchExpanded({
      module: brotli, url: `mercury-host.wasm.br${query}`,
      outputSize: MERCURY_HOST_WASM_BYTES, label: "Mercury modem WASM",
    });
    return root.createMercuryHost({wasmBinary});
  };
})(self);
