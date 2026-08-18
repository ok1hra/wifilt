#!/usr/bin/env bash
set -euo pipefail

# Sketch -> Export Compiled Binary, without the IDE window.
#
# The Arduino IDE 1.8 has a headless command line: "--verify" compiles, and
# "Export Compiled Binary" is nothing more than the copy that platform.txt
# describes in recipe.output.save_file -- for the ESP32 core that is
# {project_name}.bin -> {project_name}.{variant}.bin, i.e.
# wifilt.ino.bin -> wifilt.ino.esp32.bin. This script does the compile and that
# copy, so a release can be built from a terminal (and from a script) with the
# same toolchain, core and board options the IDE would have used.
#
# Two things it deliberately does NOT share with the IDE:
#
#   * its own settings folder (build/arduino-settings). "--preferences-file"
#     also moves Arduino's settings folder to that file's directory, so the
#     folder gets a "packages" symlink back to the real core installation. The
#     point is that nothing here can rewrite the preferences of an open IDE --
#     and an open IDE cannot change what this builds.
#
#   * its own build path (build/arduino), kept between runs so a rebuild is
#     incremental. --clean throws it away.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARDUINO15_DIR="${ARDUINO15_DIR:-$HOME/.arduino15}"
BUILD_DIR="${ROOT_DIR}/build/arduino"
SETTINGS_DIR="${ROOT_DIR}/build/arduino-settings"

# The same FQBN the CI job compiles (.github/workflows/build.yml). Every menu
# option left out here takes the board default, and for ESP32 Dev Module those
# defaults are already what BUILD.md asks for: 240 MHz, 4 MB flash at 80 MHz,
# no PSRAM, debug level none. Only these two differ from the defaults:
#   PartitionScheme=no_ota  the app0 size the linker checks against
#   FlashMode=dio           the Zbit clone flash on the RemoteQTH boards will
#                           not boot from a QIO image (see BUILD.md)
FQBN="${FQBN:-esp32:esp32:esp32:PartitionScheme=no_ota,FlashMode=dio}"
SKETCH=""
CLEAN=false
VERBOSE=false

usage() {
  cat <<'EOF'
Usage:
  tools/export-compiled-binary.sh [options]

Compiles the sketch and writes the exported application image next to it,
exactly as Sketch -> Export Compiled Binary does.

Options:
  --sketch FILE   Sketch to build     (default: the .ino next to this repo root)
  --fqbn FQBN     Board and options   (default: $FQBN)
  --clean         Discard the incremental build directory first
  --verbose       Show the full compiler output instead of the summary
  -h, --help      This text

Environment:
  ARDUINO_IDE     Arduino 1.8.x installation directory or its "arduino" launcher
  ARDUINO15_DIR   Core installation   (default: ~/.arduino15)
  FQBN            Same as --fqbn
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sketch)  SKETCH="${2:-}"; shift 2 ;;
    --fqbn)    FQBN="${2:-}"; shift 2 ;;
    --clean)   CLEAN=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- the IDE ----
# ARDUINO_IDE may name the launcher itself or the directory holding it.
ARDUINO_BIN=""
if [[ -n "${ARDUINO_IDE:-}" ]]; then
  if [[ -x "$ARDUINO_IDE" && ! -d "$ARDUINO_IDE" ]]; then
    ARDUINO_BIN="$ARDUINO_IDE"
  elif [[ -x "${ARDUINO_IDE}/arduino" ]]; then
    ARDUINO_BIN="${ARDUINO_IDE}/arduino"
  else
    echo "ERROR: ARDUINO_IDE=$ARDUINO_IDE holds no executable 'arduino'" >&2
    exit 1
  fi
else
  for candidate in \
    "$HOME/inst/arduino-1.8.19/arduino" \
    "$HOME/arduino-1.8.19/arduino" \
    "/opt/arduino-1.8.19/arduino" \
    "/usr/local/arduino-1.8.19/arduino" \
    "$(command -v arduino || true)"
  do
    [[ -n "$candidate" && -x "$candidate" ]] && { ARDUINO_BIN="$candidate"; break; }
  done
fi
[[ -n "$ARDUINO_BIN" ]] || {
  echo "ERROR: no Arduino 1.8.x launcher found; set ARDUINO_IDE=/path/to/arduino-1.8.19" >&2
  exit 1
}

# --------------------------------------------------------------- the sketch --
if [[ -z "$SKETCH" ]]; then
  mapfile -t inos < <(find "$ROOT_DIR" -maxdepth 1 -name '*.ino' | sort)
  [[ ${#inos[@]} -eq 1 ]] || {
    echo "ERROR: expected exactly one .ino in $ROOT_DIR, found ${#inos[@]}; use --sketch" >&2
    exit 1
  }
  SKETCH="${inos[0]}"
fi
SKETCH="$(realpath "$SKETCH")"
[[ -f "$SKETCH" ]] || { echo "ERROR: sketch not found: $SKETCH" >&2; exit 1; }
SKETCH_DIR="$(dirname "$SKETCH")"
PROJECT_NAME="$(basename "$SKETCH")"          # wifilt.ino -- the build.project_name

# ------------------------------------------------------------- the variant --
# recipe.output.save_file is {project_name}.{variant}.bin, so the exported name
# depends on build.variant of the board, not on the board id. Read it from the
# core rather than assuming the two are spelled the same.
BOARD_ID="$(awk -F: '{print $3}' <<<"$FQBN" | cut -d, -f1)"
VARIANT=""
BOARDS_TXT="$(find "$ARDUINO15_DIR/packages/esp32/hardware/esp32" -mindepth 2 -maxdepth 2 \
                -name boards.txt 2>/dev/null | sort -V | tail -1)"
if [[ -n "$BOARDS_TXT" ]]; then
  VARIANT="$(sed -n "s/^${BOARD_ID}\.build\.variant=//p" "$BOARDS_TXT" | head -1)"
fi
VARIANT="${VARIANT:-$BOARD_ID}"
EXPORT_BIN="${SKETCH_DIR}/${PROJECT_NAME}.${VARIANT}.bin"

# ------------------------------------------------------ the settings folder --
[[ -d "$ARDUINO15_DIR/packages" ]] || {
  echo "ERROR: no core installation at $ARDUINO15_DIR/packages" >&2
  exit 1
}
mkdir -p "$SETTINGS_DIR"
# Copy the operator's preferences so the sketchbook (and with it the TrxNet
# library) is found, then point the isolated folder back at the real cores.
if [[ -f "$ARDUINO15_DIR/preferences.txt" ]]; then
  cp -f "$ARDUINO15_DIR/preferences.txt" "$SETTINGS_DIR/preferences.txt"
else
  : > "$SETTINGS_DIR/preferences.txt"
  echo "sketchbook.path=$HOME/Arduino" >> "$SETTINGS_DIR/preferences.txt"
fi
ln -sfn "$ARDUINO15_DIR/packages" "$SETTINGS_DIR/packages"

# -------------------------------------------------------------- the compile --
if $CLEAN; then
  echo "==> Removing $BUILD_DIR"
  rm -rf "$BUILD_DIR"
fi
mkdir -p "$BUILD_DIR"

REV="$(sed -n 's/^#define[[:space:]]\+REV[[:space:]]\+\([0-9]\+\).*/\1/p' "$SKETCH" | head -1)"
echo "==> Sketch  : $SKETCH${REV:+  (REV $REV)}"
echo "==> Board   : $FQBN"
echo "==> Build   : $BUILD_DIR"

LOG="${BUILD_DIR}/export.log"
set +e
"$ARDUINO_BIN" --verify \
  --preferences-file "${SETTINGS_DIR}/preferences.txt" \
  --board "$FQBN" \
  --pref "build.path=${BUILD_DIR}" \
  $( $VERBOSE && echo --verbose ) \
  "$SKETCH" >"$LOG" 2>&1
status=$?
set -e

# The IDE's board discovery runs even headless and floods the log with JmDNS
# stack traces whenever a network interface is busy or absent. They say nothing
# about the build, so they stay in export.log and out of the terminal.
filter_noise() {
  grep -v -E 'jmdns|JmDNS|Picked up JAVA_TOOL_OPTIONS|^[[:space:]]+at (java|javax)\.|^java\.(net|io)\.' "$1" || true
}

if [[ $status -ne 0 ]]; then
  filter_noise "$LOG" >&2
  echo "ERROR: compilation failed (exit $status); full log: $LOG" >&2
  exit $status
fi
if $VERBOSE; then
  filter_noise "$LOG"
else
  filter_noise "$LOG" | grep -E 'Sketch uses|Global variables|WARNING|warning:' || true
fi

# --------------------------------------------------------------- the export --
BUILT_BIN="${BUILD_DIR}/${PROJECT_NAME}.bin"
[[ -f "$BUILT_BIN" ]] || { echo "ERROR: the build produced no $BUILT_BIN" >&2; exit 1; }

magic="$(od -An -t x1 -N1 "$BUILT_BIN" | tr -d '[:space:]')"
[[ "$magic" == "e9" ]] || {
  echo "ERROR: $BUILT_BIN is not an ESP32 application image (magic=$magic)" >&2
  exit 1
}

# Byte 2 of the image header is the SPI mode: 0 QIO, 1 QOUT, 2 DIO, 3 DOUT. A
# QIO image is unusable on the RemoteQTH boards, and nothing later in the
# release chain looks at it -- so it is checked here, where it can still be
# fixed by changing one word of the FQBN.
mode_byte="$(od -An -t x1 -j2 -N1 "$BUILT_BIN" | tr -d '[:space:]')"
case "$mode_byte" in
  02) : ;;
  *) echo "ERROR: image flash mode byte is 0x${mode_byte}, expected 0x02 (DIO); see BUILD.md" >&2
     exit 1 ;;
esac

# The menu partition scheme decides the size the linker checks against, but the
# sketch-local partitions.csv is what lands on the device -- and its app0 is the
# smaller of the two. "Sketch uses 47%" above is therefore measured against the
# wrong number; measure it again against the partition table being shipped.
if [[ -f "${SKETCH_DIR}/partitions.csv" ]]; then
  if ! cmp -s "${SKETCH_DIR}/partitions.csv" "${BUILD_DIR}/partitions.csv"; then
    echo "WARNING: the build did not pick up the sketch-local partitions.csv" >&2
  fi
  app0_size="$(awk -F',' '$1 ~ /^app0[[:space:]]*$/ {gsub(/[[:space:]]/,"",$5); print $5}' \
                 "${SKETCH_DIR}/partitions.csv" | head -1)"
  if [[ -n "$app0_size" ]]; then
    app0_bytes=$(( app0_size ))
    bin_bytes=$(stat -c %s "$BUILT_BIN")
    pct=$(( bin_bytes * 100 / app0_bytes ))
    printf '==> app0    : %d of %d bytes (%d%%), %d bytes free\n' \
      "$bin_bytes" "$app0_bytes" "$pct" "$(( app0_bytes - bin_bytes ))"
    if (( bin_bytes >= app0_bytes )); then
      echo "ERROR: the image does not fit the app0 partition of partitions.csv" >&2
      exit 1
    fi
  fi
fi

cp -f "$BUILT_BIN" "$EXPORT_BIN"
echo "==> Exported: $EXPORT_BIN"
echo
echo "Next: tools/upload-firmware-spiffs.sh --port /dev/ttyUSB0"
