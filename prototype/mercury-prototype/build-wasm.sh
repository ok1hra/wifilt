#!/usr/bin/env bash
# Reproduces the trimmed-freedv WASM measurement in docs/mercury-implementace.md
# chapter 2.2 as a checked-in, re-runnable build instead of a one-off number in
# a markdown table. Builds two variants for comparison:
#   full    -- libfreedvdata.a, every mode enabled (voice + FSK + all DATAC)
#   trim    -- only datac1/3/4/13/16, via the official FREEDV_MODE_*_EN switches
#              from freedv_api.h -- no source surgery, no fork against upstream.
# Prints raw/gzip/brotli sizes for both so the doc's table can be re-derived
# and checked against reality on demand.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROTO_DIR="${ROOT_DIR}/prototype/mercury-prototype"
FD_DIR="${ROOT_DIR}/mercury/modem/freedv"
BUILD_DIR="${PROTO_DIR}/build-wasm"

[[ -d "$FD_DIR" ]] || { echo "ERROR: $FD_DIR missing -- is mercury/ (git@github.com:Rhizomatica/mercury.git, mercuryv2) checked out?" >&2; exit 1; }

"${PROTO_DIR}/toolchain/check-toolchain.sh"

mapfile -t SRCS < <(
  awk '/^OBJS_COMMON = /{flag=1} flag{print} flag && !/\\$/{exit}' "${FD_DIR}/Makefile" \
    | tr -d '\\' | tr ' ' '\n' | grep '\.o$' | sed 's/\.o$/.c/'
)
[[ ${#SRCS[@]} -gt 0 ]] || { echo "ERROR: could not parse OBJS_COMMON from ${FD_DIR}/Makefile" >&2; exit 1; }
SRC_PATHS=()
for f in "${SRCS[@]}"; do
  [[ -f "${FD_DIR}/${f}" ]] || { echo "ERROR: expected freedv source missing: ${FD_DIR}/${f}" >&2; exit 1; }
  SRC_PATHS+=("${FD_DIR}/${f}")
done

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

build_variant() {
  local name="$1"; shift
  local defines=("$@")
  echo "==> building ${name} ($(emcc --version | head -1))"
  emcc -Oz -flto -I"$FD_DIR" -DNDEBUG '-DGIT_HASH="wasm"' \
    "${defines[@]}" \
    "${PROTO_DIR}/shim.c" "${SRC_PATHS[@]}" \
    -o "${BUILD_DIR}/mercury-${name}.js" \
    -s MODULARIZE=1 -s EXPORT_NAME=createMercury \
    -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
    -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
    -s ENVIRONMENT=node \
    -s TOTAL_STACK=8388608
}

build_variant full -DFREEDV_MODE_EN_DEFAULT=1
build_variant trim  -DFREEDV_MODE_EN_DEFAULT=0 \
  -DFREEDV_MODE_DATAC1_EN=1 -DFREEDV_MODE_DATAC3_EN=1 \
  -DFREEDV_MODE_DATAC4_EN=1 -DFREEDV_MODE_DATAC13_EN=1 \
  -DFREEDV_MODE_DATAC15_EN=1 -DFREEDV_MODE_DATAC16_EN=1

node "${PROTO_DIR}/measure-sizes.js" "$BUILD_DIR"

echo "==> loopback (trim build)"
node "${PROTO_DIR}/run-loopback.js" "$BUILD_DIR"
