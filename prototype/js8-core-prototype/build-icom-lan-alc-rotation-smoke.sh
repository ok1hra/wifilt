#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="${ROOT_DIR}/prototype/js8-core-prototype/build"

mkdir -p "${BUILD_DIR}"
g++ -std=c++17 -Wall -Wextra -Werror \
  -I"${ROOT_DIR}/prototype/js8-core-prototype/firmware/icom_lan_client_stubs" \
  "${ROOT_DIR}/prototype/js8-core-prototype/firmware/icom_lan_alc_rotation_smoke.cpp" \
  -o "${BUILD_DIR}/icom-lan-alc-rotation-smoke"
"${BUILD_DIR}/icom-lan-alc-rotation-smoke"
