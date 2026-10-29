#!/usr/bin/env bash
set -euo pipefail

# Rebuild Mercury's browser-Worker WASM module from the checked-in source
# tree and harvest it into data/, the same pattern tools/build-js8-assets.sh
# uses for JS8's own WASM modem/decoder.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTOTYPE_DIR="${ROOT_DIR}/prototype/mercury-prototype"
MERCURY_DIR="${ROOT_DIR}/mercury"
DATA_DIR="${ROOT_DIR}/data"

required=(
  "${PROTOTYPE_DIR}/build-worker-wasm.sh"
  "${PROTOTYPE_DIR}/host-shim.c"
  "${PROTOTYPE_DIR}/host-stubs.c"
  "${MERCURY_DIR}/datalink_arq/arq_fsm.c"
  "${MERCURY_DIR}/modem/freedv/freedv_api.h"
)
for file in "${required[@]}"; do
  [[ -f "$file" ]] || { echo "ERROR: required Mercury source missing: $file" >&2; exit 1; }
done

"${PROTOTYPE_DIR}/toolchain/check-toolchain.sh"
"${PROTOTYPE_DIR}/build-worker-wasm.sh"

cp "${PROTOTYPE_DIR}/build-worker/mercury-host.js" "${DATA_DIR}/mercury-host.js"
cp "${PROTOTYPE_DIR}/build-worker/mercury-host.wasm" "${DATA_DIR}/mercury-host.wasm"

# The workers expand mercury-host.wasm.br (data/mercury-host-loader.js), and
# Brotli has to be told the output size up front; it moves with every rebuild.
loader="${DATA_DIR}/mercury-host-loader.js"
size_line='const MERCURY_HOST_WASM_BYTES = [0-9]*;'
grep -q "$size_line" "$loader" ||
  { echo "ERROR: no MERCURY_HOST_WASM_BYTES line in $loader" >&2; exit 1; }
sed -i "s/${size_line}/const MERCURY_HOST_WASM_BYTES = $(wc -c < "${DATA_DIR}/mercury-host.wasm");/" "$loader"

# The WASM blob just landed, so ASSET_REV and every ?v= have to be re-derived
# before anything is minified or compressed -- both later steps consume the
# files this rewrites (same ordering build-js8-assets.sh uses).
node "${ROOT_DIR}/tools/stamp-asset-versions.js" "$DATA_DIR"
"${ROOT_DIR}/tools/minify-spiffs-js.sh" "$DATA_DIR"
"${ROOT_DIR}/tools/gzip-assets.sh" "$DATA_DIR"

echo "==> Mercury browser assets rebuilt in ${DATA_DIR}"
