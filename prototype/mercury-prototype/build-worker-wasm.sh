#!/usr/bin/env bash
# Same host-shim.c/host-stubs.c bridge as build-host-wasm.sh, but built for a
# real browser Worker instead of Node: E2 (docs/mercury-implementace.md ch.4.2,
# "mercury-host.js ... Worker") needs to run this in an actual browser, and
# everything proven so far ran only under Node's ENVIRONMENT=node build (with
# its own fetch-vs-ENVIRONMENT_IS_NODE workaround -- see run-loopback.js --
# which is a Node-only bug and doesn't apply here). This build is the first
# check that the WASM module itself is fine outside Node, before any real page
# or firmware work.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROTO_DIR="${ROOT_DIR}/prototype/mercury-prototype"
MERC_DIR="${ROOT_DIR}/mercury"
FD_DIR="${MERC_DIR}/modem/freedv"
BUILD_DIR="${PROTO_DIR}/build-worker"

"${PROTO_DIR}/toolchain/check-toolchain.sh"

mapfile -t FD_SRCS < <(
  awk '/^OBJS_COMMON = /{flag=1} flag{print} flag && !/\\$/{exit}' "${FD_DIR}/Makefile" \
    | tr -d '\\' | tr ' ' '\n' | grep '\.o$' | sed 's/\.o$/.c/'
)
FD_SRC_PATHS=()
for f in "${FD_SRCS[@]}"; do FD_SRC_PATHS+=("${FD_DIR}/${f}"); done

SRCS=(
  "${PROTO_DIR}/host-shim.c"
  "${PROTO_DIR}/host-stubs.c"
  "${MERC_DIR}/tests/sim/sim_endpoint.c"
  "${MERC_DIR}/tests/sim/sim_translate.c"
  "${MERC_DIR}/tests/sim/sim_clock.c"
  "${MERC_DIR}/datalink_arq/arq_fsm.c"
  "${MERC_DIR}/common/virtual_clock.c"
  "${MERC_DIR}/datalink_arq/arq_protocol.c"
  "${MERC_DIR}/datalink_arq/arq_timing.c"
  "${MERC_DIR}/datalink_arq/arith.c"
  "${FD_SRC_PATHS[@]}"
)

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "==> building mercury-host.wasm for a real browser Worker ($(emcc --version | head -1))"
emcc -O2 -std=gnu11 -D_GNU_SOURCE -DNDEBUG '-DGIT_HASH="wasm"' \
  -DFREEDV_MODE_EN_DEFAULT=0 \
  -DFREEDV_MODE_DATAC1_EN=1 -DFREEDV_MODE_DATAC3_EN=1 -DFREEDV_MODE_DATAC4_EN=1 \
  -DFREEDV_MODE_DATAC13_EN=1 -DFREEDV_MODE_DATAC15_EN=1 -DFREEDV_MODE_DATAC16_EN=1 \
  -I"${MERC_DIR}/common" -I"${MERC_DIR}/modem" -I"${MERC_DIR}/datalink_arq" \
  -I"${MERC_DIR}/datalink_broadcast" -I"${MERC_DIR}/data_interfaces" \
  -I"${MERC_DIR}/gui_interface" -I"${MERC_DIR}/radio_io" -I"${MERC_DIR}/audioio/ffaudio" \
  -I"${MERC_DIR}/tests/sim" -I"${FD_DIR}" \
  "${SRCS[@]}" \
  -o "${BUILD_DIR}/mercury-host.js" \
  -s MODULARIZE=1 -s EXPORT_NAME=createMercuryHost \
  -s ENVIRONMENT=worker \
  -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
  -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
  -s TOTAL_STACK=8388608

echo "==> built ${BUILD_DIR}/mercury-host.js + .wasm"
