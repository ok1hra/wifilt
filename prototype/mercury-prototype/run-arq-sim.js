#!/usr/bin/env node
// Thin wrapper so build-arq-sim-wasm.sh's non-MODULARIZE build (a straight
// `main()` CLI, not a library) can run under Node. Same fetch workaround as
// run-loopback.js: emcc 3.1.6's glue branches on `typeof fetch`, not
// ENVIRONMENT_IS_NODE, and Node >=18's global fetch sends it down the
// browser fetch() path for a bare filesystem path.
"use strict";
delete global.fetch;
require(require("path").resolve(process.argv[2]));
