#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="${ROOT_DIR}/prototype/js8-core-prototype/build"

mkdir -p "${BUILD_DIR}"
g++ -std=c++17 -Wall -Wextra -Werror \
  "${ROOT_DIR}/prototype/js8-core-prototype/firmware/icom_lan_audio_tx_smoke.cpp" \
  -o "${BUILD_DIR}/icom-lan-audio-tx-smoke"
"${BUILD_DIR}/icom-lan-audio-tx-smoke"
