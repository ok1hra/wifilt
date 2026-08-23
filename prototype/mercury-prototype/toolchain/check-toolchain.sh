#!/usr/bin/env sh
set -eu

toolchain_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=toolchain.lock
. "$toolchain_dir/toolchain.lock"

fail() { echo "TOOLCHAIN FAIL $*" >&2; exit 1; }

command -v emcc >/dev/null 2>&1 || fail "emcc not found on PATH"
actual_emcc=$(emcc --version | awk 'NR == 1 {for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+$/) {print $i; exit}}')
[ "$actual_emcc" = "$EMSCRIPTEN_VERSION" ] ||
  fail "emcc=$actual_emcc expected=$EMSCRIPTEN_VERSION"

command -v node >/dev/null 2>&1 || fail "node not found on PATH"
actual_node=$(node --version | sed 's/^v//')
node_major=${actual_node%%.*}
case "$node_major" in *[!0-9]*|'') fail "invalid node version: $actual_node";; esac
[ "$node_major" -ge "$NODE_LOCAL_MIN_MAJOR" ] && [ "$node_major" -le "$NODE_LOCAL_MAX_MAJOR" ] ||
  fail "node=$actual_node supported=${NODE_LOCAL_MIN_MAJOR}-${NODE_LOCAL_MAX_MAJOR}.x"

# No brotli CLI on this host; the project already compresses .br assets via
# Node's built-in zlib (tools/brotli-js8-assets.js), so reuse that instead of
# adding a new binary dependency.
node -e 'if (typeof require("zlib").brotliCompressSync !== "function") process.exit(1)' ||
  fail "node zlib.brotliCompressSync not available"

echo "TOOLCHAIN OK emcc=$actual_emcc node=$actual_node"
