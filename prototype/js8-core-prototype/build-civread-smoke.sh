#!/usr/bin/env sh
# The CI-V read capture, built out of the sketch's own text.
#
# Two functions, eight lines, and everything the MOD-level calibration decides
# rests on them answering "did the radio confirm THIS address". The extraction is
# deliberately fragile: rename or reformat them in the sketch and this build fails
# with the signature it could not find, instead of testing a stale copy.
#
# See docs/tx-audio-gain-plan-implementace.md, decision 5.
set -eu

prototype_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(CDPATH= cd -- "$prototype_dir/../.." && pwd)
build_dir="$prototype_dir/build-civread"
mkdir -p "$build_dir"

echo "==> Extracting the sketch's CI-V read capture"
python3 "$prototype_dir/firmware/extract_sketch_functions.py" \
  "$repository_dir/wifilt.ino" \
  "$build_dir/sketch_civ_read.inc" \
  "void civReadArm(const uint8_t *prefix, size_t prefixLen)" \
  "void civReadCapture(const uint8_t *frame, size_t len)"

echo "==> Building the native harness"
${CXX:-g++} -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter \
  -I"$prototype_dir/firmware" -I"$build_dir" \
  -o "$build_dir/civread" \
  "$prototype_dir/firmware/civ_read_smoke.cpp"

echo "==> Running"
exec "$build_dir/civread"
