#!/usr/bin/env sh
# Layer 3 of docs/wspr-majak-implementace.md. Extracts the sketch's AUD1 TX
# functions verbatim, builds the native harness around them, and runs the
# co-simulation against the real browser driver in data/wspr-tx.js.
#
# The extraction step is deliberately fragile: if the sketch's TX path is
# reformatted or renamed, the build fails with the missing signature instead of
# testing a stale copy. That is the whole point -- see the header comment in
# firmware/extract_sketch_aud1.py.
set -eu

prototype_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(CDPATH= cd -- "$prototype_dir/../.." && pwd)
build_dir="$prototype_dir/build-wspr-pacing"
mkdir -p "$build_dir"

echo "==> Extracting the sketch's AUD1 TX path"
python3 "$prototype_dir/firmware/extract_sketch_aud1.py" \
  "$repository_dir/wifilt.ino" \
  "$build_dir/sketch_aud1_tx.inc"

echo "==> Building the native harness"
${CXX:-g++} -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter \
  -I"$repository_dir" -I"$prototype_dir/firmware" -I"$build_dir" \
  -o "$build_dir/wspr-tx-pacing" \
  "$prototype_dir/firmware/wspr_tx_pacing_smoke.cpp"

echo "==> Running the co-simulation (110.592 s of transmission, six scenarios)"
exec node "$repository_dir/tools/wspr-tx-pacing-smoke.js" "$build_dir/wspr-tx-pacing"
