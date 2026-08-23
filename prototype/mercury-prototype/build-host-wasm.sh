#!/usr/bin/env bash
# Builds the real-modem ARQ host bench: arq_fsm.c/arq_protocol.c/arith.c/
# arq_timing.c (unmodified) + the trimmed freedv library (unmodified) +
# upstream's tests/sim/{sim_endpoint,sim_translate,sim_clock}.c (unmodified)
# + this prototype's host-stubs.c/host-shim.c, into one WASM module driven
# by run-host-bench.js. See host-shim.c's header comment for the design.
#
# Mode list: DATAC16 (control) + DATAC15 (ARQ_CONTROL startup floor, see
# arq_fsm.c's "Hold the initial DATAC15 payload mode during the startup
# window") + DATAC3 (the payload ladder's only rung while gear-shifting is
# off, docs/mercury-implementace.md decision #2) + DATAC4/DATAC1/DATAC13
# because build-wasm.sh already proved them and leaving them in costs
# nothing here. DATAC17/QAM16C2 are deliberately NOT built in --
# host-stubs.c's arq_bandwidth_allows_mode() gates the FSM away from ever
# requesting them, matching decision #2.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROTO_DIR="${ROOT_DIR}/prototype/mercury-prototype"
MERC_DIR="${ROOT_DIR}/mercury"
FD_DIR="${MERC_DIR}/modem/freedv"
BUILD_DIR="${PROTO_DIR}/build-host"

[[ -d "$MERC_DIR" ]] || { echo "ERROR: $MERC_DIR missing -- is mercury/ checked out?" >&2; exit 1; }

"${PROTO_DIR}/toolchain/check-toolchain.sh"

mapfile -t FD_SRCS < <(
  awk '/^OBJS_COMMON = /{flag=1} flag{print} flag && !/\\$/{exit}' "${FD_DIR}/Makefile" \
    | tr -d '\\' | tr ' ' '\n' | grep '\.o$' | sed 's/\.o$/.c/'
)
FD_SRC_PATHS=()
for f in "${FD_SRCS[@]}"; do
  [[ -f "${FD_DIR}/${f}" ]] || { echo "ERROR: expected freedv source missing: ${FD_DIR}/${f}" >&2; exit 1; }
  FD_SRC_PATHS+=("${FD_DIR}/${f}")
done

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
for f in "${SRCS[@]}"; do
  [[ -f "$f" ]] || { echo "ERROR: expected source missing: $f" >&2; exit 1; }
done

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "==> building mercury-host.wasm ($(emcc --version | head -1))"
emcc -O0 -g -std=gnu11 -D_GNU_SOURCE '-DGIT_HASH="wasm"' \
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
  -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
  -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
  -s ENVIRONMENT=node -s TOTAL_STACK=8388608

echo "==> running the two-session bench under Node"
node "${PROTO_DIR}/run-host-bench.js" "${BUILD_DIR}"
