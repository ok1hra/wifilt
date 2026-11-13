#!/usr/bin/env bash
# build-oi3-hex.sh -- the OI3 firmware images the Linux packages carry, so the
# web updater can bring the OI3 up to date along with WIFILT
# (native/update/wifilt-update.sh, phase "oi3").
#
#   tools/build-oi3-hex.sh [OUT_DIR]
#
# OI3_DIR (default ~/Arduino/hra/ok1hra/oi3) is a checkout of
# github.com/ok1hra/oi3; its own build.sh compiles both board revisions.
# OUT_DIR (default native/dist-oi3, which native/Makefile copies into the
# archives as oi3/) receives:
#   PCB_3_1415_oi3.ino.hex  PCB_3_141_oi3.ino.hex   flash images, no bootloader
#   VERSION                                          REV from oi3.ino (YYYYMMDD)
#   SOURCE                                           commit, "-dirty" when uncommitted
#
# The updater flashes only when VERSION is newer than what this Pi last flashed,
# so a firmware change must come with a REV bump in oi3.ino.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OI3_DIR="${OI3_DIR:-$HOME/Arduino/hra/ok1hra/oi3}"
OUT="${1:-$ROOT/native/dist-oi3}"

if [[ ! -f "$OI3_DIR/oi3.ino" || ! -f "$OI3_DIR/build.sh" ]]; then
  echo "ERROR: no OI3 source in $OI3_DIR (set OI3_DIR)" >&2
  exit 1
fi
fw="$(sed -n 's/^const char\* *REV *= *"\([0-9]\{8\}\)".*/\1/p' "$OI3_DIR/oi3.ino" | head -n1)"
[[ -n "$fw" ]] || { echo "ERROR: no REV = \"YYYYMMDD\" in $OI3_DIR/oi3.ino" >&2; exit 1; }

src="-"
if git -C "$OI3_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  src="$(git -C "$OI3_DIR" rev-parse --short=12 HEAD)"
  if [[ -n "$(git -C "$OI3_DIR" status --porcelain --untracked-files=no)" ]]; then
    src="${src}-dirty"
    echo "WARNING: $OI3_DIR has uncommitted changes -- the images are not reproducible from GitHub" >&2
  fi
fi

echo "==> OI3 firmware $fw ($src): building in $OI3_DIR"
( cd "$OI3_DIR" && bash ./build.sh )

rm -rf "$OUT"
mkdir -p "$OUT"
for rev in 3_141 3_1415; do
  hex="$OI3_DIR/out/$rev/PCB_${rev}_oi3.ino.hex"
  [[ -s "$hex" ]] || { echo "ERROR: the build did not produce $hex" >&2; exit 1; }
  cp "$hex" "$OUT/"
done
echo "$fw" > "$OUT/VERSION"
echo "$src" > "$OUT/SOURCE"
echo "==> OI3 firmware $fw -> $OUT"
