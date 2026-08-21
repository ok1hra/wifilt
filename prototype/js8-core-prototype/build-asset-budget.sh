#!/usr/bin/env sh
set -eu

# Pre-flight asset-budget check: answers "would tools/upload-firmware-spiffs.sh
# accept this tree?" without a device attached.
#
# It must mirror the deployment gate exactly, or it is worse than useless.
# Two earlier defects, both of which produced a FAIL on trees that flashed fine:
#
#   1. It measured with mkspiffs. Deployment builds the image with mklittlefs;
#      SPIFFS fragments on this tree and reports far less usable space, so the
#      verdict did not describe the artefact that actually ships.
#   2. The partition size was hardcoded (1966080). partitions.csv has moved
#      twice since -- once for the custom layout, once when the "cfg" partition
#      was carved out -- so the number silently went stale. It is read from the
#      file now, like the upload script does.
#
# The gate is partition - 256 KiB runtime reserve - 64 KiB metadata. The reserve
# is deliberately kept free for device-written data and the payload may never
# occupy it, so it is not counted as headroom here either.

prototype_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(CDPATH= cd -- "$prototype_dir/../.." && pwd)
build_dir="$prototype_dir/build-budget"
partition_csv="$repository_dir/partitions.csv"

runtime_reserve_bytes=$((256 * 1024))
metadata_budget_bytes=$((64 * 1024))
# Exceeding the gate is a FAIL because deployment refuses it. This threshold is
# only an early warning about creeping growth; it never fails the build.
warn_percent=${ASSET_BUDGET_WARN_PERCENT:-90}

[ -f "$partition_csv" ] || { echo "ERROR: partitions.csv not found: $partition_csv" >&2; exit 1; }

partition_bytes=$(awk -F, '
  $1 ~ /^[[:space:]]*spiffs[[:space:]]*$/ { gsub(/[[:space:]]/, "", $5); print $5; exit }
' "$partition_csv")
[ -n "$partition_bytes" ] || { echo "ERROR: no 'spiffs' row in $partition_csv" >&2; exit 1; }
partition_bytes=$((partition_bytes))

max_payload_bytes=$((partition_bytes - runtime_reserve_bytes - metadata_budget_bytes))

# Same discovery order as tools/upload-firmware-spiffs.sh, so both scripts agree
# on which toolchain they are describing.
arduino15_dir=${ARDUINO15_DIR:-}
if [ -z "$arduino15_dir" ]; then
  for candidate in "$HOME/Arduino/libraries/.arduino15" "$HOME/.arduino15"; do
    [ -d "$candidate/packages/esp32" ] || continue
    arduino15_dir="$candidate"; break
  done
fi
[ -n "$arduino15_dir" ] || { echo "ERROR: ESP32 package dir not found; set ARDUINO15_DIR" >&2; exit 1; }

mklittlefs=${MKLITTLEFS_BIN:-}
if [ -z "$mklittlefs" ]; then
  mklittlefs=$(find "$arduino15_dir/packages/esp32/tools/mklittlefs" \
    -type f -name mklittlefs -perm -u+x 2>/dev/null | sort -V | tail -n 1)
fi
if [ -z "$mklittlefs" ] || [ ! -x "$mklittlefs" ]; then
  echo "ERROR: mklittlefs not found; set MKLITTLEFS_BIN" >&2
  exit 1
fi

mkdir -p "$build_dir"
stage_dir=$(mktemp -d "$build_dir/stage.XXXXXX")
trap 'rm -rf "$stage_dir"' EXIT HUP INT TERM

"$repository_dir/tools/prepare-spiffs-tree.sh" \
  "$repository_dir/data" "$stage_dir" >/dev/null

payload=$(du -sb "$stage_dir" | awk '{print $1}')
files=$(find "$stage_dir" -type f | wc -l | tr -d ' ')
free=$((max_payload_bytes - payload))
used_percent=$(awk -v u="$payload" -v t="$max_payload_bytes" \
  'BEGIN { printf "%.1f", (t > 0 ? u * 100 / t : 0) }')

printf 'ASSET BUDGET payload=%s files=%s gate=%s free=%s used=%s%% partition=%s\n' \
  "$payload" "$files" "$max_payload_bytes" "$free" "$used_percent" "$partition_bytes"

if [ "$payload" -gt "$max_payload_bytes" ]; then
  echo "ASSET BUDGET FAIL payload exceeds gate by $((payload - max_payload_bytes)) B" >&2
  exit 1
fi

# The gate is necessary but not sufficient: LittleFS metadata overhead depends on
# file count and sizes, so pack it for real and let mklittlefs be the last word.
image="$build_dir/littlefs-candidate.bin"
if ! "$mklittlefs" -c "$stage_dir" -b 4096 -p 256 -s "$partition_bytes" "$image" >/dev/null 2>&1; then
  echo "ASSET BUDGET FAIL mklittlefs could not pack $payload B in $files files" >&2
  exit 1
fi

awk -v used="$used_percent" -v warn="$warn_percent" \
  'BEGIN { if (used + 0 >= warn + 0) exit 1 }' \
  || echo "ASSET BUDGET WARN over ${warn_percent}% of the gate" >&2

echo "ASSET BUDGET PASS image=$image"
