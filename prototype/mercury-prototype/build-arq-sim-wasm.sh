#!/usr/bin/env bash
# Compiles mercury/tests/sim/test_arq_sim.c -- the upstream two-FSM ARQ
# simulation harness (mercury/tests/sim/README.md) -- to WASM instead of a
# native binary, and runs it under Node. This is docs/mercury-implementace.md
# ch.10 E1's "tests/sim do WASM" deliverable.
#
# Why this is the right next step after build-wasm.sh: the harness already
# drives two real arq_session_t FSMs against each other through a lossy
# virtual channel with NO wall clock and NO threads (arq_test_stubs.c
# supplies a settable virtual uptime instead of hermes_uptime_ms(), and the
# ARQ FSM is sans-io -- common/virtual_clock.h -- so nothing here needs
# pthreads). That means arq_fsm.c/arq_protocol.c/arith.c/arq_timing.c
# compile to WASM completely unmodified, and upstream's own 13-test suite
# (thousands of randomized loss/SNR patterns via test_sim_fuzz*) becomes the
# port's regression check for free, instead of hand-written FSM tests.
#
# arq_channels.c and modem/framer.c are NOT linked here -- test_arq_sim
# doesn't need them (see mercury/tests/Makefile's test_arq_sim recipe).
# They port separately once something in this prototype actually needs them
# (arq_channels.c: multi-band bookkeeping; framer.c: frame header on/off the
# wire, which mercury-host.js will need once it talks to a real modem).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROTO_DIR="${ROOT_DIR}/prototype/mercury-prototype"
MERC_DIR="${ROOT_DIR}/mercury"
BUILD_DIR="${PROTO_DIR}/build-arq-sim"

[[ -d "$MERC_DIR" ]] || { echo "ERROR: $MERC_DIR missing -- is mercury/ checked out?" >&2; exit 1; }

"${PROTO_DIR}/toolchain/check-toolchain.sh"

SRCS=(
  "${MERC_DIR}/tests/sim/test_arq_sim.c"
  "${MERC_DIR}/tests/unity/unity.c"
  "${MERC_DIR}/tests/datalink_arq/arq_test_stubs.c"
  "${MERC_DIR}/tests/sim/sim_clock.c"
  "${MERC_DIR}/tests/sim/sim_channel.c"
  "${MERC_DIR}/tests/sim/sim_endpoint.c"
  "${MERC_DIR}/tests/sim/sim_translate.c"
  "${MERC_DIR}/tests/sim/sim_core.c"
  "${MERC_DIR}/tests/sim/sim_props.c"
  "${MERC_DIR}/datalink_arq/arq_fsm.c"
  "${MERC_DIR}/common/virtual_clock.c"
  "${MERC_DIR}/datalink_arq/arq_protocol.c"
  "${MERC_DIR}/datalink_arq/arq_timing.c"
  "${MERC_DIR}/datalink_arq/arith.c"
)
for f in "${SRCS[@]}"; do
  [[ -f "$f" ]] || { echo "ERROR: expected source missing: $f" >&2; exit 1; }
done

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "==> building arq-sim.wasm ($(emcc --version | head -1))"
emcc -O2 -std=gnu11 -D_GNU_SOURCE -DNDEBUG '-DGIT_HASH="wasm"' -DUNITY_SUPPORT_64 \
  -I"${MERC_DIR}/common" -I"${MERC_DIR}/modem" -I"${MERC_DIR}/datalink_arq" \
  -I"${MERC_DIR}/datalink_broadcast" -I"${MERC_DIR}/data_interfaces" \
  -I"${MERC_DIR}/gui_interface" -I"${MERC_DIR}/radio_io" -I"${MERC_DIR}/audioio/ffaudio" \
  -I"${MERC_DIR}/tests" -I"${MERC_DIR}/tests/unity" -I"${MERC_DIR}/tests/fff" \
  -I"${MERC_DIR}/tests/sim" -I"${MERC_DIR}/modem/freedv" \
  "${SRCS[@]}" \
  -o "${BUILD_DIR}/arq-sim.js" \
  -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
  -s TOTAL_STACK=8388608 -s EXIT_RUNTIME=1

echo "==> running under Node (compare against native: 13 Tests 0 Failures 0 Ignored)"
OUT="$(node "${PROTO_DIR}/run-arq-sim.js" "${BUILD_DIR}/arq-sim.js")"
echo "$OUT"
echo "$OUT" | grep -qE '^[0-9]+ Tests 0 Failures 0 Ignored[[:space:]]*$' || {
  echo "FAIL: expected N Tests 0 Failures 0 Ignored" >&2
  exit 1
}
echo "PASS: WASM arq_fsm/arq_protocol/arith/arq_timing match the native suite"
