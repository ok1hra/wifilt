#!/usr/bin/env bash
set -euo pipefail

# Rebuild every JS8-derived browser asset from the checked-in source tree.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTOTYPE_DIR="${ROOT_DIR}/prototype/js8-core-prototype"
UPSTREAM_DIR="${ROOT_DIR}/JS8Call-improved-master"
DATA_DIR="${ROOT_DIR}/data"

required=(
  "${PROTOTYPE_DIR}/run.sh"
  "${PROTOTYPE_DIR}/protocol/build-jsc-map.js"
  "${UPSTREAM_DIR}/LICENSE"
  "${UPSTREAM_DIR}/JS8_Mode/JS8.cpp"
  "${UPSTREAM_DIR}/JS8_Mode/FrequencyTracker.cpp"
  "${UPSTREAM_DIR}/JS8_Mode/FrequencyTracker.h"
  "${UPSTREAM_DIR}/JS8_Mode/ldpc_feedback.h"
  "${UPSTREAM_DIR}/JS8_Mode/soft_combiner.h"
  "${UPSTREAM_DIR}/JS8_Mode/whitening_processor.h"
  "${UPSTREAM_DIR}/JS8_Include/commons.h"
  "${UPSTREAM_DIR}/JS8_JSC/JSC_map.cpp"
  "${UPSTREAM_DIR}/vendor/Eigen/Dense"
)
for file in "${required[@]}"; do
  [[ -f "$file" ]] || { echo "ERROR: required JS8 source missing: $file" >&2; exit 1; }
done

"${PROTOTYPE_DIR}/toolchain/check-toolchain.sh"
"${PROTOTYPE_DIR}/run.sh" --wasm
"${PROTOTYPE_DIR}/run.sh" --wasm-decoder --build-only

mkdir -p "${PROTOTYPE_DIR}/build-protocol"
node "${PROTOTYPE_DIR}/protocol/build-jsc-map.js" \
  "${UPSTREAM_DIR}/JS8_JSC/JSC_map.cpp" \
  "${PROTOTYPE_DIR}/build-protocol/jsc-map.bin"

cp "${PROTOTYPE_DIR}/build-wasm/js8-prototype.js" "${DATA_DIR}/js8-core.js"
cp "${PROTOTYPE_DIR}/build-wasm/js8-prototype.wasm" "${DATA_DIR}/js8-core.wasm"
cp "${PROTOTYPE_DIR}/build-decoder-wasm/js8-decoder.js" "${DATA_DIR}/js8-decoder.js"
cp "${PROTOTYPE_DIR}/build-decoder-wasm/js8-decoder.wasm" "${DATA_DIR}/js8-decoder.wasm"
cp "${PROTOTYPE_DIR}/build-protocol/jsc-map.bin" "${DATA_DIR}/js8-jsc.bin"

# First: the modem blobs just landed, so ASSET_REV and every ?v= have to be
# re-derived before anything is minified or compressed -- both later steps
# consume the files this rewrites.
node "${ROOT_DIR}/tools/stamp-asset-versions.js" "$DATA_DIR"
"${ROOT_DIR}/tools/minify-spiffs-js.sh" "$DATA_DIR"
"${ROOT_DIR}/tools/gzip-assets.sh" "$DATA_DIR"

echo "==> JS8 browser assets rebuilt in ${DATA_DIR}"
