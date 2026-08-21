#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUTPUT_DIR="${ROOT_DIR}/build/gh-pages"
FIRMWARE_BIN="${ROOT_DIR}/wifilt.ino.esp32.bin"
DATA_DIR="${ROOT_DIR}/data"
SKETCH_FILE="${ROOT_DIR}/wifilt.ino"
GZIP_ASSETS_SCRIPT="${ROOT_DIR}/tools/gzip-assets.sh"

# Custom sketch-local partition layout (No OTA, coredump dropped, and a separate
# `cfg` partition the installer never writes). Geometry is read from
# partitions.csv further down, not repeated here.
PARTITIONS_CSV_NAME="custom"
# IMPORTANT: DIO, not QIO. These WIFILT interface boards ship a Zbit (0x5e) clone
# flash chip whose QIO reads are unreliable — a QIO bootloader makes the ROM loader
# read garbage after the first segment and the board never boots. DIO 80 MHz is
# stable. The bootloader's flash mode is baked in at elf2image time below (its
# SHA256 digest prevents patching the mode afterwards).
FLASH_MODE="dio"
FLASH_FREQ="80m"
FLASH_SIZE="4MB"

# Offsets from partitions.csv (sketch-local custom layout)
BOOTLOADER_OFFSET=0x1000
PARTITIONS_OFFSET=0x8000
BOOT_APP0_OFFSET=0xe000
APP_OFFSET=0x10000
# The asset filesystem's offset and size are DERIVED from partitions.csv below,
# never written down here. tools/upload-firmware-spiffs.sh and
# tools/upload-spiffs.sh already read them from the same file, so a copy in this
# script was the one place a layout change could go unnoticed -- and the failure
# it produced was an image written at the wrong address, not an error.
SPIFFS_OFFSET=""
SPIFFS_SIZE_DEC=""

ESP32_CORE_ROOT="${ESP32_CORE_ROOT:-}"
BOOTLOADER_BIN="${BOOTLOADER_BIN:-}"
BOOTLOADER_ELF="${BOOTLOADER_ELF:-}"
BOOT_APP0_BIN="${BOOT_APP0_BIN:-}"
GEN_PART_BIN="${GEN_PART_BIN:-}"
ESPTOOL_BIN="${ESPTOOL_BIN:-}"
MKLITTLEFS_BIN="${MKLITTLEFS_BIN:-}"

DO_PUBLISH=0
PUBLISH_BRANCH="gh-pages"
PUBLISH_REMOTE="origin"
PUBLISH_MESSAGE=""

# There used to be a --config-on-flash switch here, with three variants of "what
# this release does to your configuration", picked by hand at release time. It is
# gone, and nothing replaced it, because esp-web-tools already asks the operator
# the only question that decides the answer.
#
# With `new_install_improv_wait_time: 0` the dialog never runs improv, so it can
# never tell what is already on the board and always shows "Install WIFILT" ->
# an "Erase device" screen with the checkbox UNTICKED. Leaving it untied writes
# bootloader, partition table, firmware and the asset filesystem and touches
# neither `cfg` nor NVS; ticking it erases the whole chip. So the fate of the
# configuration is not a property of the release at all -- it is one checkbox,
# in front of the one person who knows which they want. The page explains that
# checkbox instead of guessing on their behalf.

usage() {
  cat <<'EOF'
Usage: tools/gh-pages.sh [options]

Build a GitHub Pages web flasher for WIFILT (blank ESP32 via USB).
Generates build/gh-pages/ with manifest.json and index.html for esp-web-tools.

Steps:
  1. Read firmware version from wifilt.ino
  2. Build LittleFS image from data/
  3. Generate partition table binary
  4. Create manifest.json and index.html
  5. Optionally publish to gh-pages branch

Options:
  --output-dir PATH      Output directory       (default: ./build/gh-pages)
  --firmware PATH        Firmware .bin file      (default: ./wifilt.ino.esp32.bin)
  --esp32-core PATH      ESP32 Arduino core root (auto-detected if not set)
  --bootloader PATH      Prebuilt bootloader .bin (skips ELF conversion)
  --bootloader-elf PATH  Bootloader ELF          (auto-detected; DIO .bin built from it)
  --boot-app0 PATH       boot_app0.bin           (auto-detected)
  --gen-part PATH        gen_esp32part.py        (auto-detected)
  --esptool PATH         esptool.py              (auto-detected)
  --mklittlefs PATH      mklittlefs binary       (auto-detected)
  --publish              Push build/gh-pages to gh-pages branch
  --branch NAME          Target Pages branch     (default: gh-pages)
  --remote NAME          Git remote to push to   (default: origin)
  --message TEXT         Publish commit message   (auto-generated if not set)
  -h, --help             Show this help

Examples:
  bash tools/gh-pages.sh
  bash tools/gh-pages.sh --publish
  bash tools/gh-pages.sh --publish --message "Release 20260509"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)   OUTPUT_DIR="$2";          shift 2 ;;
    --firmware)     FIRMWARE_BIN="$2";        shift 2 ;;
    --esp32-core)   ESP32_CORE_ROOT="$2";     shift 2 ;;
    --bootloader)     BOOTLOADER_BIN="$2";    shift 2 ;;
    --bootloader-elf) BOOTLOADER_ELF="$2";    shift 2 ;;
    --boot-app0)    BOOT_APP0_BIN="$2";       shift 2 ;;
    --gen-part)     GEN_PART_BIN="$2";        shift 2 ;;
    --esptool)      ESPTOOL_BIN="$2";         shift 2 ;;
    --mklittlefs)   MKLITTLEFS_BIN="$2";      shift 2 ;;
    --publish)      DO_PUBLISH=1;             shift ;;
    --branch)       PUBLISH_BRANCH="$2";      shift 2 ;;
    --remote)       PUBLISH_REMOTE="$2";      shift 2 ;;
    --message)      PUBLISH_MESSAGE="$2";     shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Auto-detect ESP32 Arduino core root
# ---------------------------------------------------------------------------

detect_esp32_core_root() {
  local candidates=()
  [[ -n "${ESP32_CORE_ROOT:-}" ]] && candidates+=("${ESP32_CORE_ROOT}")
  [[ -n "${HOME:-}" ]] && candidates+=(
    "${HOME}/Arduino/hardware/espressif/esp32"
    "${HOME}/.arduino15/packages/esp32/hardware/esp32"
  )

  # Marker file present inside the core across versions. (esptool.py used to
  # live here too, but core 2.x moved it to a separate package tool — see below.)
  local marker="tools/gen_esp32part.py"
  local dir version_dir
  for dir in "${candidates[@]}"; do
    if [[ -f "${dir}/${marker}" ]]; then
      echo "$dir"; return 0
    fi
    if [[ -d "$dir" ]]; then
      version_dir="$(find "$dir" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
      if [[ -n "$version_dir" && -f "${version_dir}/${marker}" ]]; then
        echo "$version_dir"; return 0
      fi
    fi
  done
  return 1
}

# In core 2.x, esptool.py and mklittlefs ship as separate package tools at
#   packages/esp32/tools/<subdir>/<version>/<file>
# The core lives at packages/esp32/hardware/esp32/<ver>, so the package tools
# dir is three levels up from the core root.
find_pkg_tool() {
  local subdir="$1" file="$2"
  local pkg_tools="${ESP32_CORE_ROOT}/../../../tools/${subdir}"
  [[ -d "$pkg_tools" ]] || return 1
  local ver_dir
  ver_dir="$(find "$pkg_tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
  [[ -n "$ver_dir" && -f "${ver_dir}/${file}" ]] && { echo "${ver_dir}/${file}"; return 0; }
  return 1
}

if [[ -z "$ESP32_CORE_ROOT" ]]; then
  ESP32_CORE_ROOT="$(detect_esp32_core_root || true)"
fi

# Core 2.0.14 ships only the bootloader ELF (not a .bin) in tools/sdk/esp32/bin.
# When no prebuilt --bootloader .bin is given, derive it from the matching ELF via
# elf2image (below) so the DIO flash mode is set in the header.
[[ -z "$BOOTLOADER_BIN" && -z "$BOOTLOADER_ELF" && -n "$ESP32_CORE_ROOT" ]] && \
  BOOTLOADER_ELF="${ESP32_CORE_ROOT}/tools/sdk/esp32/bin/bootloader_${FLASH_MODE}_${FLASH_FREQ}.elf"
[[ -z "$BOOT_APP0_BIN" && -n "$ESP32_CORE_ROOT" ]] && \
  BOOT_APP0_BIN="${ESP32_CORE_ROOT}/tools/partitions/boot_app0.bin"
[[ -z "$GEN_PART_BIN" && -n "$ESP32_CORE_ROOT" ]] && \
  GEN_PART_BIN="${ESP32_CORE_ROOT}/tools/gen_esp32part.py"
if [[ -z "$ESPTOOL_BIN" && -n "$ESP32_CORE_ROOT" ]]; then
  if [[ -f "${ESP32_CORE_ROOT}/tools/esptool.py" ]]; then
    ESPTOOL_BIN="${ESP32_CORE_ROOT}/tools/esptool.py"
  else
    ESPTOOL_BIN="$(find_pkg_tool esptool_py esptool.py || true)"
  fi
fi
if [[ -z "$MKLITTLEFS_BIN" && -n "$ESP32_CORE_ROOT" ]]; then
  if [[ -f "${ESP32_CORE_ROOT}/tools/mklittlefs/mklittlefs" ]]; then
    MKLITTLEFS_BIN="${ESP32_CORE_ROOT}/tools/mklittlefs/mklittlefs"
  else
    MKLITTLEFS_BIN="$(find_pkg_tool mklittlefs mklittlefs || true)"
  fi
fi

require_file() {
  local path="$1" label="$2"
  if [[ ! -f "$path" ]]; then
    echo "ERROR: $label not found: $path" >&2
    exit 1
  fi
}

require_file "$FIRMWARE_BIN"   "Firmware binary"
require_file "$SKETCH_FILE"    "Sketch file"
require_file "$BOOT_APP0_BIN"  "boot_app0.bin"
require_file "$GEN_PART_BIN"   "gen_esp32part.py"
require_file "$ESPTOOL_BIN"    "esptool.py"
require_file "$MKLITTLEFS_BIN" "mklittlefs"
# Bootloader: either a prebuilt --bootloader .bin, or the core ELF we convert below.
if [[ -n "$BOOTLOADER_BIN" ]]; then
  require_file "$BOOTLOADER_BIN" "Bootloader binary"
else
  require_file "$BOOTLOADER_ELF" "Bootloader ELF"
fi

# Refuse a release built from a stale Arduino export.
while IFS= read -r -d '' source; do
  if [[ "$source" -nt "$FIRMWARE_BIN" ]]; then
    echo "ERROR: exported firmware is stale; newer source: $source" >&2
    echo "       Run Sketch -> Export Compiled Binary again." >&2
    exit 1
  fi
done < <(find "$ROOT_DIR" -maxdepth 1 -type f \
  \( -name '*.ino' -o -name '*.h' -o -name '*.hpp' -o -name '*.cpp' \) -print0)

# A Pages release must always contain the complete DATA/JS8 runtime.
for asset in data.html data.css data.js dxcc.js js8-adapter.js js8-aud1.js \
  js8-audio.js js8-brotli.js js8-brotli.wasm js8-core.js js8-core.wasm \
  js8-decoder.js js8-decoder.wasm js8-jsc.bin js8-presets.js js8-protocol.js \
  js8-settings.js js8-timebase.js js8-tx.js js8-worker-runtime.js js8-worker.js \
  BROTLI-LICENSE.txt THIRD-PARTY-NOTICES.txt; do
  require_file "${DATA_DIR}/${asset}" "DATA/JS8 asset ${asset}"
done

# ---------------------------------------------------------------------------
# Read firmware version
# ---------------------------------------------------------------------------

FW_REV="$(
  awk '/#define REV / { print $3; exit }' "$SKETCH_FILE"
)"

if [[ -z "$FW_REV" ]]; then
  echo "ERROR: Could not read REV from $SKETCH_FILE" >&2
  exit 1
fi

echo "==> Firmware REV: $FW_REV"

# ---------------------------------------------------------------------------
# Locate partition CSV
# ---------------------------------------------------------------------------

# Sketch-local custom layout takes precedence (matches the ESP32 core prebuild
# hook and tools/upload-firmware-spiffs.sh); fall back to the core tree otherwise.
if [[ -f "${ROOT_DIR}/partitions.csv" ]]; then
  PARTITIONS_CSV="${ROOT_DIR}/partitions.csv"
else
  PARTITIONS_CSV="${ESP32_CORE_ROOT}/tools/partitions/${PARTITIONS_CSV_NAME}.csv"
fi
if [[ ! -f "$PARTITIONS_CSV" ]]; then
  echo "ERROR: Partition CSV not found: $PARTITIONS_CSV" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Derive the asset filesystem geometry from the partition table
# ---------------------------------------------------------------------------

partition_field() {
  local name="$1" column="$2"
  awk -F, -v wanted="$name" -v column="$column" '
    $1 ~ "^[[:space:]]*" wanted "[[:space:]]*$" {
      gsub(/[[:space:]]/, "", $column); print $column; exit
    }' "$PARTITIONS_CSV"
}

SPIFFS_OFFSET="$(partition_field spiffs 4)"
SPIFFS_SIZE_HEX="$(partition_field spiffs 5)"
[[ -n "$SPIFFS_OFFSET" && -n "$SPIFFS_SIZE_HEX" ]] || {
  echo "ERROR: no 'spiffs' partition in $PARTITIONS_CSV" >&2
  exit 1
}
SPIFFS_SIZE_DEC=$((SPIFFS_SIZE_HEX))
# For the installer page's hardware table. Written out because a hand-typed "2.56
# MB" beside a partition table that can change is a number nobody re-checks.
# Rounded to two decimals in integer arithmetic: +5000 is half of the 10 000 the
# division discards.
SPIFFS_SIZE_MB="$(( (SPIFFS_SIZE_DEC + 5000) / 1000000 )).$(printf '%02d' "$(( ((SPIFFS_SIZE_DEC + 5000) / 10000) % 100 ))")"

# The image is written at SPIFFS_OFFSET and is exactly SPIFFS_SIZE_DEC long, so
# an offset and a size that disagree with the flash chip do not fail loudly --
# they produce a bundle that bricks the board. Refuse instead.
FLASH_BYTES=$((4 * 1024 * 1024))
if (( SPIFFS_OFFSET + SPIFFS_SIZE_DEC > FLASH_BYTES )); then
  printf 'ERROR: asset filesystem runs past the end of a %s MB flash\n' \
    "$((FLASH_BYTES / 1024 / 1024))" >&2
  printf '       offset 0x%X + size 0x%X = 0x%X, chip ends at 0x%X\n' \
    "$SPIFFS_OFFSET" "$SPIFFS_SIZE_DEC" \
    "$((SPIFFS_OFFSET + SPIFFS_SIZE_DEC))" "$FLASH_BYTES" >&2
  exit 1
fi

# The configuration partition is NEVER part of a release bundle -- that is the
# whole point of it. Say so out loud, so adding it here has to be deliberate.
CFG_OFFSET="$(partition_field cfg 4)"
CFG_SIZE_KB=""
if [[ -n "$CFG_OFFSET" ]]; then
  CFG_SIZE_KB=$(( $(partition_field cfg 5) / 1024 ))
  printf '==> Configuration partition at %s is deliberately NOT flashed\n' "$CFG_OFFSET"
fi

OUTPUT_DIR="$(realpath -m "$OUTPUT_DIR")"
ROOT_REAL="$(realpath "$ROOT_DIR")"
case "${OUTPUT_DIR}/" in
  "${ROOT_REAL}/build/"*|/tmp/*) ;;
  *) echo "ERROR: --output-dir must be below ${ROOT_REAL}/build or /tmp: ${OUTPUT_DIR}" >&2; exit 1 ;;
esac
mkdir -p "$OUTPUT_DIR"
find "$OUTPUT_DIR" -mindepth 1 -depth -delete

# ---------------------------------------------------------------------------
# Bootloader binary (from ELF, with DIO flash mode baked into the header)
# ---------------------------------------------------------------------------

if [[ -z "$BOOTLOADER_BIN" ]]; then
  echo "==> Generating ${FLASH_MODE} bootloader from ELF"
  BOOTLOADER_BIN="${OUTPUT_DIR}/bootloader.bin"
  python3 "$ESPTOOL_BIN" --chip esp32 elf2image \
    --flash_mode "$FLASH_MODE" --flash_freq "$FLASH_FREQ" --flash_size "$FLASH_SIZE" \
    -o "$BOOTLOADER_BIN" "$BOOTLOADER_ELF"
fi

# ---------------------------------------------------------------------------
# Build partition table binary
# ---------------------------------------------------------------------------

echo "==> Generating partition table"
PARTITIONS_BIN="${OUTPUT_DIR}/partitions.bin"
python3 "$GEN_PART_BIN" "$PARTITIONS_CSV" "$PARTITIONS_BIN"

# ---------------------------------------------------------------------------
# Build LittleFS image from data/
# ---------------------------------------------------------------------------

SPIFFS_BIN="${OUTPUT_DIR}/spiffs.bin"
SPIFFS_DATA_DIR="${OUTPUT_DIR}/spiffs-data"

if [[ ! -x "${ROOT_DIR}/tools/prepare-spiffs-tree.sh" ]]; then
  echo "ERROR: filesystem staging helper not found" >&2
  exit 1
fi
"${ROOT_DIR}/tools/prepare-spiffs-tree.sh" "$DATA_DIR" "$SPIFFS_DATA_DIR"
staging_bytes="$(du -sb "$SPIFFS_DATA_DIR" | awk '{print $1}')"
runtime_reserve_bytes=$((256 * 1024))
metadata_budget_bytes=$((64 * 1024))
max_payload_bytes=$((SPIFFS_SIZE_DEC - runtime_reserve_bytes - metadata_budget_bytes))
[[ "$staging_bytes" -le "$max_payload_bytes" ]] || {
  echo "ERROR: LittleFS deployment leaves less than the required 256 KiB runtime reserve." >&2
  echo "       Payload: $staging_bytes B; limit: $max_payload_bytes B; partition: $SPIFFS_SIZE_DEC B." >&2
  exit 1
}
echo "==> Building LittleFS image from data/ (payload $staging_bytes / $max_payload_bytes B)"
"$MKLITTLEFS_BIN" -c "$SPIFFS_DATA_DIR" -b 4096 -p 256 -s "$SPIFFS_SIZE_DEC" "$SPIFFS_BIN"

# ---------------------------------------------------------------------------
# Copy binaries
# ---------------------------------------------------------------------------

echo "==> Copying binaries"
# BOOTLOADER_BIN may already be ${OUTPUT_DIR}/bootloader.bin (generated above).
[[ "$BOOTLOADER_BIN" -ef "${OUTPUT_DIR}/bootloader.bin" ]] || \
  cp "$BOOTLOADER_BIN" "${OUTPUT_DIR}/bootloader.bin"
cp "$BOOT_APP0_BIN"  "${OUTPUT_DIR}/boot_app0.bin"
cp "$FIRMWARE_BIN"   "${OUTPUT_DIR}/firmware.bin"

# ---------------------------------------------------------------------------
# Build merged binary (for manual esptool flashing)
# ---------------------------------------------------------------------------

echo "==> Building merged binary"
MERGE_ARGS=(
  --chip esp32 merge_bin
  -o "${OUTPUT_DIR}/wifilt-${FW_REV}-full.bin"
  --flash_mode "$FLASH_MODE"
  --flash_freq "$FLASH_FREQ"
  --flash_size "$FLASH_SIZE"
  "${BOOTLOADER_OFFSET}" "${OUTPUT_DIR}/bootloader.bin"
  "${PARTITIONS_OFFSET}" "${OUTPUT_DIR}/partitions.bin"
  "${BOOT_APP0_OFFSET}"  "${OUTPUT_DIR}/boot_app0.bin"
  "${APP_OFFSET}"        "${OUTPUT_DIR}/firmware.bin"
)
if [[ -n "$SPIFFS_BIN" ]]; then
  MERGE_ARGS+=("${SPIFFS_OFFSET}" "$SPIFFS_BIN")
fi
python3 "$ESPTOOL_BIN" "${MERGE_ARGS[@]}"

# ---------------------------------------------------------------------------
# Desktop archives (optional)
# ---------------------------------------------------------------------------
#
# The same source also builds a binary for a PC, for operators whose radio is on
# the network and who therefore need no hardware at all. Both carry the firmware
# REV in their name for exactly the reason the .bin does: one source must not be
# able to claim two version numbers.
#
# Optional on purpose. `make -C native dist` needs mingw-w64 for the Windows
# half, and a firmware release must not fail because a cross-compiler is
# missing. Whatever is present gets published; whatever is not is left out of
# the page.

DESKTOP_LINUX="${ROOT_DIR}/native/dist/wifilt-${FW_REV}-linux-x86_64.tar.gz"
DESKTOP_WIN="${ROOT_DIR}/native/dist/wifilt-${FW_REV}-windows-x64.zip"
DESKTOP_ARM64="${ROOT_DIR}/native/dist/wifilt-${FW_REV}-linux-arm64.tar.gz"
DESKTOP_LINUX_NAME=""
DESKTOP_WIN_NAME=""
DESKTOP_ARM64_NAME=""
DESKTOP_LINUX_SIZE=""
DESKTOP_WIN_SIZE=""
DESKTOP_ARM64_SIZE=""

human_size() {
  awk -v bytes="$1" 'BEGIN { printf "%.1f MB", bytes / 1048576 }'
}

DESKTOP_SUMS_NAME=""

if [[ -f "$DESKTOP_LINUX" ]]; then
  DESKTOP_LINUX_NAME="$(basename "$DESKTOP_LINUX")"
  DESKTOP_LINUX_SIZE="$(human_size "$(stat -c%s "$DESKTOP_LINUX")")"
  cp "$DESKTOP_LINUX" "${OUTPUT_DIR}/${DESKTOP_LINUX_NAME}"
  echo "==> Desktop archive: ${DESKTOP_LINUX_NAME} (${DESKTOP_LINUX_SIZE})"
fi
if [[ -f "$DESKTOP_WIN" ]]; then
  DESKTOP_WIN_NAME="$(basename "$DESKTOP_WIN")"
  DESKTOP_WIN_SIZE="$(human_size "$(stat -c%s "$DESKTOP_WIN")")"
  cp "$DESKTOP_WIN" "${OUTPUT_DIR}/${DESKTOP_WIN_NAME}"
  echo "==> Desktop archive: ${DESKTOP_WIN_NAME} (${DESKTOP_WIN_SIZE})"
fi
if [[ -f "$DESKTOP_ARM64" ]]; then
  DESKTOP_ARM64_NAME="$(basename "$DESKTOP_ARM64")"
  DESKTOP_ARM64_SIZE="$(human_size "$(stat -c%s "$DESKTOP_ARM64")")"
  cp "$DESKTOP_ARM64" "${OUTPUT_DIR}/${DESKTOP_ARM64_NAME}"
  echo "==> Desktop archive: ${DESKTOP_ARM64_NAME} (${DESKTOP_ARM64_SIZE})"
fi
# The page tells people to check the download against this, so it has to travel
# with the downloads rather than being left behind in native/dist.
if [[ -n "$DESKTOP_LINUX_NAME" || -n "$DESKTOP_WIN_NAME" || -n "$DESKTOP_ARM64_NAME" ]] \
   && [[ -f "${ROOT_DIR}/native/dist/SHA256SUMS" ]]; then
  DESKTOP_SUMS_NAME="SHA256SUMS"
  cp "${ROOT_DIR}/native/dist/SHA256SUMS" "${OUTPUT_DIR}/${DESKTOP_SUMS_NAME}"
fi
if [[ -z "$DESKTOP_LINUX_NAME" && -z "$DESKTOP_WIN_NAME" && -z "$DESKTOP_ARM64_NAME" ]]; then
  echo "==> No desktop archives for REV ${FW_REV} (run: make -C native dist)"
fi

# ---------------------------------------------------------------------------
# Generate manifest.json
# ---------------------------------------------------------------------------

echo "==> Generating manifest.json"

PARTS_JSON="        { \"path\": \"bootloader.bin\",  \"offset\": $((BOOTLOADER_OFFSET)) },
        { \"path\": \"partitions.bin\",  \"offset\": $((PARTITIONS_OFFSET)) },
        { \"path\": \"boot_app0.bin\",   \"offset\": $((BOOT_APP0_OFFSET)) },
        { \"path\": \"firmware.bin\",    \"offset\": $((APP_OFFSET)) }"

if [[ -n "$SPIFFS_BIN" ]]; then
  PARTS_JSON="${PARTS_JSON},
        { \"path\": \"spiffs.bin\",      \"offset\": $((SPIFFS_OFFSET)) }"
fi

cat > "${OUTPUT_DIR}/manifest.json" <<EOF
{
  "name": "WIFILT",
  "version": "${FW_REV}",
  "new_install_prompt_erase": true,
  "new_install_improv_wait_time": 0,
  "builds": [
    {
      "chipFamily": "ESP32",
      "parts": [
${PARTS_JSON}
      ]
    }
  ]
}
EOF

# ---------------------------------------------------------------------------
# Generate index.html
# ---------------------------------------------------------------------------

# The AP join QR needs an encoder. The device already ships one for the WiFi
# handoff screen, so this reuses that exact file instead of adding a dependency
# or pulling a CDN into a page whose whole job is to work on a strange computer.
QR_SRC="${DATA_DIR}/qrcode.min.js"
if [[ -f "$QR_SRC" ]]; then
  cp "$QR_SRC" "${OUTPUT_DIR}/qrcode.min.js"
else
  echo "WARNING: ${QR_SRC} not found - the AP join QR will be missing" >&2
fi

echo "==> Generating index.html"

cat > "${OUTPUT_DIR}/index.html" <<EOF
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>Firmware installer — WIFILT</title>
  <script type="module" src="https://unpkg.com/esp-web-tools@10.4.0/dist/web/install-button.js?module"></script>
  <style>
    :root {
      --accent: #3b82f6;
      --accent-glow: rgba(59, 130, 246, 0.22);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      color: #f1f5f9;
      background:
        radial-gradient(circle at top right, rgba(59, 130, 246, 0.25), transparent 30rem),
        linear-gradient(150deg, #0f172a 0%, #111827 50%, #1e293b 100%);
      min-height: 100vh;
    }
    main {
      width: min(44rem, calc(100% - 2rem));
      margin: 0 auto;
      padding: 3.5rem 0 5rem;
    }
    .card {
      background: rgba(15, 23, 42, 0.78);
      border: 1px solid rgba(59, 130, 246, 0.28);
      border-radius: 1.25rem;
      padding: 2rem 2rem 2.25rem;
      box-shadow: 0 2rem 4rem rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(14px);
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: clamp(1.8rem, 4vw, 2.8rem);
      line-height: 1.1;
    }
    .subtitle {
      margin: 0 0 1.75rem;
      color: #94a3b8;
      font-size: 1rem;
    }
    .subtitle code {
      background: rgba(148, 163, 184, 0.15);
      padding: 0.1rem 0.35rem;
      border-radius: 0.3rem;
      color: #93c5fd;
    }
    .divider {
      border: none;
      border-top: 1px solid rgba(59, 130, 246, 0.2);
      margin: 1.5rem 0;
    }
    h2 {
      margin: 0 0 0.6rem;
      font-size: 1.15rem;
      color: #93c5fd;
    }
    p, li {
      font-size: 0.97rem;
      line-height: 1.65;
      color: #cbd5e1;
    }
    ul, ol {
      margin: 0.5rem 0 0;
      padding-left: 1.35rem;
    }
    li { margin-bottom: 0.35rem; }
    .highlight { color: #fde68a; }
    .warn-box {
      background: rgba(220, 38, 38, 0.15);
      border: 2px solid #dc2626;
      border-radius: 0.75rem;
      padding: 1rem 1.25rem;
      margin-bottom: 1.5rem;
      color: #fca5a5;
    }
    .warn-box strong { color: #f87171; }
    .warn-box p { margin: 0; color: #fca5a5; font-size: 0.97rem; line-height: 1.6; }
    .warn-box p + p { margin-top: 0.4rem; }
    .hardware-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.65rem;
      margin: 0.85rem 0 0;
    }
    .hardware-item {
      margin: 0;
      padding: 0.8rem 0.9rem;
      border: 1px solid rgba(96, 165, 250, 0.22);
      border-radius: 0.65rem;
      background: rgba(30, 41, 59, 0.55);
    }
    .hardware-item dt {
      margin-bottom: 0.25rem;
      color: #93c5fd;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .hardware-item dd {
      margin: 0;
      color: #e2e8f0;
      font-size: 0.93rem;
      line-height: 1.45;
    }
    .compatibility-note { margin: 0.8rem 0 0; }
    @media (max-width: 34rem) {
      .hardware-grid { grid-template-columns: 1fr; }
    }
    [hidden] { display: none !important; }
    /* The five steps the device itself will ask for, shown greyed before the
       device exists. The operator meets the whole road first and then
       recognises the same list on the device's own screen. */
    .road { list-style: none; display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.9rem 0 0; padding: 0; }
    .road li { display: flex; align-items: center; gap: 0.45rem; margin: 0;
      padding: 0.35rem 0.75rem 0.35rem 0.4rem; border: 1px solid rgba(96, 165, 250, 0.18);
      border-radius: 999px; background: rgba(30, 41, 59, 0.4); color: #64748b; font-size: 0.85rem; }
    .road .road-n { display: grid; place-items: center; width: 1.35rem; height: 1.35rem;
      border-radius: 50%; background: rgba(148, 163, 184, 0.16); color: #94a3b8;
      font-size: 0.75rem; font-weight: 700; }
    .road .road-now { border-color: var(--accent); background: var(--accent-glow); color: #e2e8f0; }
    .road .road-now .road-n { background: var(--accent); color: #fff; }
    .choice { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 0.9rem 0 0; }
    .choice button { flex: 1 1 14rem; padding: 0.8rem 1rem; border: 1px solid rgba(96, 165, 250, 0.35);
      border-radius: 0.75rem; background: rgba(30, 41, 59, 0.6); color: #e2e8f0; font: inherit;
      font-size: 0.95rem; text-align: left; cursor: pointer; }
    .choice button:hover, .choice button:focus-visible { border-color: var(--accent);
      background: var(--accent-glow); outline: none; }
    .choice button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-glow); color: #fff; }
    .choice button span { display: block; margin-top: 0.2rem; color: #94a3b8; font-size: 0.82rem; }
    .choice button[aria-pressed="true"] span { color: #cbd5e1; }
    .fate dl { margin: 0.7rem 0 0; }
    .fate dt { color: #fecaca; font-weight: 700; font-size: 0.88rem; }
    .fate dd { margin: 0.15rem 0 0.7rem; color: #fca5a5; font-size: 0.92rem; line-height: 1.55; }
    .fate dd:last-child { margin-bottom: 0; }
    .gate[data-locked="1"] { opacity: 0.4; pointer-events: none; }
    .gate-note { margin: 0.6rem 0 0; color: #fbbf24; font-size: 0.88rem; }
    .qr-box { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin: 0.6rem 0 0; }
    .qr-box .qr { background: #fff; padding: 0.45rem; border-radius: 0.5rem; line-height: 0; }
    .qr-box p { margin: 0; flex: 1 1 12rem; }
    code {
      background: rgba(148, 163, 184, 0.15);
      padding: 0.1rem 0.35rem;
      border-radius: 0.3rem;
    }
    .cta {
      margin-top: 1.5rem;
    }
    esp-web-install-button {
      --esp-tools-button-color: var(--accent);
      --esp-tools-button-text-color: #fff;
      --esp-tools-button-border-radius: 999px;
    }
    .muted { color: #64748b; font-size: 0.88rem; margin-top: 0.75rem; }
    /* The tagline names Icom descriptively, so the trademark notice has to sit on
       the same page -- this is the project's public front door. */
    h1 .tagline {
      display: block;
      margin-top: 0.35rem;
      color: #94a3b8;
      font-size: 0.95rem;
      font-weight: 400;
    }
    .legal { margin-top: 1.75rem; font-size: 0.78rem; line-height: 1.5; }
    /* The platforms, collapsed. The page used to lay every road end to end, so
       every reader scrolled through the ones that were not theirs before
       reaching the one that was. The summary carries what actually decides the
       choice -- what the thing needs, and how big the download is -- so the
       click is informed rather than exploratory.
       Deliberately not an exclusive accordion (the name= attribute on details):
       that closes Linux the moment you open Windows, and comparing those two is
       a real thing to want. The ids are the anchors #esp32 / #linux / #raspberrypi /
       #windows, which browsers open on their own when a fragment targets them. */
    .platform {
      margin: 0.75rem 0 0;
      border: 1px solid rgba(96, 165, 250, 0.28);
      border-radius: 0.9rem;
      background: rgba(30, 41, 59, 0.45);
      overflow: hidden;
    }
    .platform > summary {
      list-style: none;
      cursor: pointer;
      padding: 0.95rem 1.15rem 0.95rem 2.45rem;
      position: relative;
    }
    .platform > summary::-webkit-details-marker { display: none; }
    /* Its own triangle rather than the .choice look. Opening a section and
       answering the new/upgrade question are different acts -- one reveals text,
       the other unlocks the flash button -- and they must not wear the same
       clothes on a page where the second one matters. */
    .platform > summary::before {
      content: "";
      position: absolute;
      left: 1.15rem;
      top: 1.3rem;
      width: 0;
      height: 0;
      border-left: 0.42rem solid var(--accent);
      border-top: 0.32rem solid transparent;
      border-bottom: 0.32rem solid transparent;
      transform-origin: 0.14rem 50%;
      transition: transform 0.15s ease;
    }
    .platform[open] > summary::before { transform: rotate(90deg); }
    .platform > summary:hover,
    .platform > summary:focus-visible { background: rgba(59, 130, 246, 0.12); outline: none; }
    .platform[open] > summary {
      background: var(--accent-glow);
      border-bottom: 1px solid rgba(96, 165, 250, 0.2);
    }
    .platform-name { display: block; color: #e2e8f0; font-size: 1.05rem; font-weight: 700; }
    .platform-sub { display: block; margin-top: 0.2rem; color: #94a3b8; font-size: 0.85rem; }
    .platform-body { padding: 0.4rem 1.15rem 1.4rem; }
    .platform-body h3 { margin: 1.6rem 0 0.5rem; color: #93c5fd; font-size: 1.1rem; }
    .platform-body > h3:first-child { margin-top: 0.7rem; }
    .platform-body pre {
      overflow-x: auto;
      margin: 0.8rem 0 0;
      padding: 0.8rem 0.9rem;
      border: 1px solid rgba(96, 165, 250, 0.18);
      border-radius: 0.6rem;
      background: rgba(15, 23, 42, 0.7);
    }
    .platform-body pre code { background: none; padding: 0; }
    .where p { margin: 0.6rem 0 0; }
    .dl-line { margin: 0.9rem 0 0; font-size: 1rem; }
    a { color: #60a5fa; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>WIFILT<span class="tagline">Web interface for Icom LAN Transceivers</span></h1>
      <p class="subtitle">
        Firmware installer &mdash; version <code>${FW_REV}</code> &nbsp;&bull;&nbsp;
        <a href="https://github.com/ok1hra/wifilt" target="_blank">GitHub</a>
      </p>

      <hr class="divider">

      <section aria-labelledby="road-title">
        <h2 id="road-title">The whole road, before you start</h2>
        <p>
          Installing is step zero, and it is the only step that differs between the three
          platforms below. Everything after it happens on the device's own
          <strong>SETUP</strong> page, in this order &mdash; each step only needs what the
          device cannot work out for itself.
        </p>
        <!-- Step 0 does not say "flash" any more. Three of the four platforms below
             flash nothing at all, and this list now stands above all four. -->
        <ol class="road">
          <li class="road-now"><span class="road-n">0</span> Install WIFILT</li>
          <li><span class="road-n">1</span> Network</li>
          <li><span class="road-n">2</span> Identity</li>
          <li><span class="road-n">3</span> Radio</li>
          <li><span class="road-n">4</span> Transmit check</li>
          <li><span class="road-n">5</span> This browser</li>
        </ol>
      </section>

      <hr class="divider">

      <section class="where" aria-labelledby="where-title">
        <h2 id="where-title">Where will it run?</h2>
        <p>
          One build, four places. Open the one that is yours &mdash; the others stay folded
          away.
        </p>
        <p>
          <strong>A radio already on your network</strong> &mdash; an IC-705, IC-7610 or
          IC-7300&nbsp;MK2 with <strong>Network&nbsp;Control</strong> switched on &mdash; needs no
          hardware at all. The program on your computer reaches it over IP, and it is the same
          software as the firmware, version <code>${FW_REV}</code>.
        </p>
        <p>
          <strong>The interface board adds what a computer cannot do</strong>: the CI-V serial
          bus, for radios that have no network port; FSK/RTTY keying and the band decoder on its
          GPIO pins; the switched 13.8&nbsp;V output and the status LED. And it runs on its own,
          day and night, with no computer switched on.
        </p>
      </section>

      <details class="platform" id="esp32">
        <summary>
          <span class="platform-name">ESP32 interface board</span>
          <span class="platform-sub">flash over USB &bull; runs on its own 24/7 &bull; CI-V, keying, band decoder</span>
        </summary>
        <div class="platform-body">

        <h3>Required hardware</h3>
        <dl class="hardware-grid">
          <div class="hardware-item">
            <dt>Processor</dt>
            <dd>Original Espressif ESP32 (Xtensa LX6), compatible with the <strong>ESP32 Dev Module</strong> target.</dd>
          </div>
          <div class="hardware-item">
            <dt>Flash memory</dt>
            <dd><strong>4 MB minimum</strong>, configured for DIO mode at 80 MHz.</dd>
          </div>
          <div class="hardware-item">
            <dt>RAM</dt>
            <dd>Standard ESP32 internal SRAM (520 KB). External PSRAM is not required.</dd>
          </div>
          <div class="hardware-item">
            <dt>Flash layout</dt>
            <dd>No OTA: 1.375 MB application and ${SPIFFS_SIZE_MB} MB LittleFS web assets$(if [[ -n "$CFG_OFFSET" ]]; then echo ", plus a
                separate ${CFG_SIZE_KB} kB configuration partition the installer never writes"; fi).</dd>
          </div>
        </dl>
        <p class="muted compatibility-note">
          This firmware image targets the original ESP32. It is not compatible with ESP32-C3,
          ESP32-S2, ESP32-S3, or other ESP32 chip families.
        </p>

        <h3>Flash firmware via USB</h3>
        <p>
          Open this page in <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong>
          (Web Serial is not supported in Firefox or Safari).
          Connect the ESP32 to your computer via USB.
        </p>

        <p><strong>Is this a new device, or one that is already working?</strong>
          This page cannot tell, and the answer decides one checkbox further on.</p>
        <div class="choice">
          <button type="button" id="choiceNew" aria-pressed="false">
            New device
            <span>Nothing on it yet &mdash; go straight to flashing.</span>
          </button>
          <button type="button" id="choiceUpgrade" aria-pressed="false">
            Upgrading a working device
            <span>It keeps its settings &mdash; as long as you leave one box unticked.</span>
          </button>
        </div>

        <div class="warn-box fate" id="backupPanel" hidden>
          <p><strong>Your configuration survives this &mdash; do not tick "Erase device".</strong>
            The installer asks <em>Do you want to erase the device before installing WIFILT?</em>
            with the box already unticked. That is the answer you want: leaving it alone writes
            the firmware and the web pages only.</p>
          <dl>
            <dt>Leave "Erase device" unticked</dt>
            <dd>The normal update. WiFi networks and passwords, callsign and locator, radio
                connections and credentials, LOG and JS8 settings,
                <strong>every TX audio gain calibration</strong>, CW and frequency memories, MSG BOX
                and band decoder rows all stay$(if [[ -n "$CFG_OFFSET" ]]; then echo " &mdash; they live in NVS and in the
                configuration partition at <code>${CFG_OFFSET}</code>, and the installer writes
                neither"; fi).</dd>
            <dt>Tick it only to start clean</dt>
            <dd>It erases the <strong>whole chip</strong>: everything above goes, including the
                WiFi credentials that let you reach the device at all. Use it for a board that will
                not boot, or when you are deliberately starting over &mdash; then restore from a backup
                file.</dd>
            <dt>Not affected either way</dt>
            <dd>Your <strong>QSO log</strong>. It is stored in your browser, not on the device,
                so flashing cannot touch it.</dd>
          </dl>
          <p style="margin-top:0.7rem">
            <strong>Coming from a release older than 20260808?</strong> Those builds kept the
            configuration inside the web-asset filesystem that this flash replaces, so it is lost
            whichever way you answer. Save a backup first and restore it afterwards:
            <a href="http://wifilt.local/config/download">download it now</a>, or open your
            device's address and use <strong>SETUP &rarr; Download config</strong>. This page
            cannot fetch it for you &mdash; it is served over HTTPS and your device over HTTP, so the
            browser blocks the request.
          </p>
          <p style="margin-top:0.5rem">
            One thing a backup file never carries: the <strong>MSG BOX</strong>. Stored messages
            cannot be exported, so anything still waiting there is lost by an erase &mdash; read or
            forward it first.
          </p>
        </div>

        <ul id="flashHints" hidden>
          <li>After connecting, select the correct <code>CP210x</code> / <code>CH340</code> / <code>JTAG</code> serial device.</li>
          <li>Choose <strong>Install WIFILT</strong>.</li>
          <li>The next screen asks <em>Do you want to erase the device before installing WIFILT?</em>
              &mdash; the <strong>Erase device</strong> box starts unticked. Leave it that way unless you
              mean to wipe the whole chip, then press <strong>Next</strong>.</li>
        </ul>

        <div class="cta gate" id="flashGate" data-locked="1">
          <esp-web-install-button manifest="manifest.json?v=${FW_REV}" baudrate="9600"></esp-web-install-button>
        </div>
        <p class="gate-note" id="gateNote">Answer the question above to continue.</p>

        <h3>Reach the board after flashing</h3>
        <!-- These steps assume a device with no WiFi credentials. An update that
             left NVS alone has them, so it rejoins the network by itself and never
             shows the hotspot -- sending that operator hunting for WIFILT-AP would
             be the page's own fault. -->
        <p class="muted" style="margin-top:0">
          <strong>Updated a working device without erasing it?</strong> It keeps its WiFi
          credentials, rejoins your network on its own and is back at the same address as before.
          Nothing below applies &mdash; the steps are for a device that has no WiFi yet: brand new, or
          just erased.
        </p>
        <ol>
          <li>
            <strong>Join the device's own WiFi.</strong> On its first boot it creates the network
            <code>WIFILT-AP</code>, password <code>remoteqth</code>. Scan this with a phone to join
            without typing either:
            <div class="qr-box">
              <div class="qr" id="apQr"></div>
              <p class="muted" style="margin:0">If the camera app does not offer to join,
                 pick <code>WIFILT-AP</code> from the WiFi list and type the password.</p>
            </div>
          </li>
          <li><strong>Open <code>http://192.168.4.1</code>.</strong> The setup page appears;
              some phones open it by themselves.</li>
          <li id="restoreStep" hidden><strong>Erased the device, or came from a release older
              than 20260808? Restore your backup first</strong> &mdash; <strong>Upload config</strong> at
              the bottom of the setup page &mdash; before setting anything by hand. Anything you type
              before restoring will be overwritten by the file.</li>
          <li><strong>Enter your WiFi network and password</strong>, then save. The device joins
              your network while its hotspot is still running and <strong>shows the address it was
              given, with a QR code</strong>. Scan or write it down: the hotspot closes when it restarts.</li>
          <li><strong>Reconnect your phone or computer to your normal WiFi</strong> and open that
              address. From there, <a href="#radio-title">connecting the radio</a> is the same on
              every platform.</li>
        </ol>
        <p class="muted">
          Lost the address? Try <code>http://wifilt.local/</code>, look in your router's DHCP client
          list, or open the serial console above at <code>9600 baud</code> and press
          <strong>Reset Device</strong> to read it from the boot log.
        </p>

        <p class="muted">
          The button above flashes: bootloader, partition table, boot_app0, firmware$(if [[ -n "$SPIFFS_BIN" ]]; then echo ", web assets"; fi).$(if [[ -n "$CFG_OFFSET" ]]; then echo "
          It does <strong>not</strong> write the configuration partition at <code>${CFG_OFFSET}</code>, which is what
          lets your settings survive an update."; fi)
        </p>
        <p class="muted">
          For manual flashing there is <code>wifilt-${FW_REV}-full.bin</code> at offset <code>0x0</code>
          with <code>esptool.py</code>. <strong>That one erases everything</strong> &mdash; it is a whole-chip
          image, so it overwrites the WiFi credentials in NVS$(if [[ -n "$CFG_OFFSET" ]]; then echo " and the configuration partition"; fi)
          as well. Use it to recover a board that will not boot, not to update a working one.
        </p>

        </div>
      </details>
$(if [[ -n "$DESKTOP_LINUX_NAME" ]]; then cat <<LINUX
      <details class="platform" id="linux">
        <summary>
          <span class="platform-name">Linux PC</span>
          <span class="platform-sub">radio on the network &bull; no hardware &bull; tar.gz, ${DESKTOP_LINUX_SIZE}</span>
        </summary>
        <div class="platform-body">
          <p class="dl-line">
            <a href="${DESKTOP_LINUX_NAME}"><strong>${DESKTOP_LINUX_NAME}</strong></a>
            &nbsp;&bull;&nbsp; Linux x86-64, ${DESKTOP_LINUX_SIZE}$(if [[ -n "$DESKTOP_SUMS_NAME" ]]; then echo "
            &nbsp;&bull;&nbsp; <a href=\"${DESKTOP_SUMS_NAME}\">SHA256SUMS</a>"; fi)
          </p>
          <pre><code>tar xzf ${DESKTOP_LINUX_NAME}
cd wifilt-linux-x86_64
sudo ./install.sh</code></pre>
          <p class="muted">
            The installer copies the program to <code>/opt/wifilt</code> and grants it permission to
            use port&nbsp;80. That permission is not optional: ports 80, 82 and 83 are all privileged,
            and port&nbsp;83 carries the audio, so without it JS8 and WSPR cannot work. It installs a
            service but deliberately does not enable it &mdash; starting a transmitter's control
            interface at boot should be your decision. To run it without installing:
            <code>sudo ./wifilt</code> from the unpacked folder.
          </p>
        </div>
      </details>
LINUX
fi)
$(if [[ -n "$DESKTOP_ARM64_NAME" ]]; then cat <<RASPBERRYPI
      <details class="platform" id="raspberrypi">
        <summary>
          <span class="platform-name">Raspberry Pi (64-bit)</span>
          <span class="platform-sub">radio on the network &bull; no hardware &bull; tar.gz, ${DESKTOP_ARM64_SIZE}</span>
        </summary>
        <div class="platform-body">
          <p class="dl-line">
            <a href="${DESKTOP_ARM64_NAME}"><strong>${DESKTOP_ARM64_NAME}</strong></a>
            &nbsp;&bull;&nbsp; Linux ARM64 (aarch64), ${DESKTOP_ARM64_SIZE}$(if [[ -n "$DESKTOP_SUMS_NAME" ]]; then echo "
            &nbsp;&bull;&nbsp; <a href=\"${DESKTOP_SUMS_NAME}\">SHA256SUMS</a>"; fi)
          </p>
          <p class="muted">
            Needs a <strong>64-bit</strong> Raspberry Pi OS (aarch64) &mdash; Pi&nbsp;3, 4, 5 or
            newer. The 32-bit (armhf) Raspberry Pi OS cannot run this build.
          </p>
          <pre><code>tar xzf ${DESKTOP_ARM64_NAME}
cd wifilt-linux-arm64
sudo ./install.sh</code></pre>
          <p class="muted">
            The installer copies the program to <code>/opt/wifilt</code> and grants it permission to
            use port&nbsp;80. That permission is not optional: ports 80, 82 and 83 are all privileged,
            and port&nbsp;83 carries the audio, so without it JS8 and WSPR cannot work. It installs a
            service but deliberately does not enable it &mdash; starting a transmitter's control
            interface at boot should be your decision. To run it without installing:
            <code>sudo ./wifilt</code> from the unpacked folder.
          </p>
        </div>
      </details>
RASPBERRYPI
fi)
$(if [[ -n "$DESKTOP_WIN_NAME" ]]; then cat <<WINDOWS
      <details class="platform" id="windows">
        <summary>
          <span class="platform-name">Windows PC</span>
          <span class="platform-sub">radio on the network &bull; no hardware &bull; zip, ${DESKTOP_WIN_SIZE}</span>
        </summary>
        <div class="platform-body">
          <p class="dl-line">
            <a href="${DESKTOP_WIN_NAME}"><strong>${DESKTOP_WIN_NAME}</strong></a>
            &nbsp;&bull;&nbsp; Windows x64, ${DESKTOP_WIN_SIZE}$(if [[ -n "$DESKTOP_SUMS_NAME" ]]; then echo "
            &nbsp;&bull;&nbsp; <a href=\"${DESKTOP_SUMS_NAME}\">SHA256SUMS</a>"; fi)
          </p>
          <p>
            Unpack the ZIP anywhere and run <code>wifilt.exe</code>. There is nothing to install and no
            runtime to add. Windows will ask once whether to allow it through the firewall &mdash; say
            yes, or other devices on your network will not reach it. Because the file is not
            code-signed, SmartScreen may warn on first run; choose <em>More info</em> &rarr;
            <em>Run anyway</em>.$(if [[ -n "$DESKTOP_SUMS_NAME" ]]; then echo " Verify the download against
            <code>SHA256SUMS</code> if you would rather not take that on trust."; fi)
          </p>
        </div>
      </details>
WINDOWS
fi)

      <hr class="divider">

      <!-- Lifted out of the ESP32 section on purpose. It is identical for all
           four platforms, and with the platforms folded away a reader who opens
           only "Linux PC" would otherwise never meet the one step that decides
           whether anything works at all. -->
      <section aria-labelledby="radio-title">
        <h2 id="radio-title">Connect your radio</h2>
        <p>
          Whichever of the four you installed, this part is the same &mdash; including the
          address:
          <a href="http://wifilt.local" target="_blank" rel="noopener">http://wifilt.local</a>.
          That the board and the computer answer to the same name is not a coincidence: your
          browser stores the QSO log per address, so keeping the name identical is what lets a
          log started on the board carry on unchanged on a computer.
        </p>
        <ol>
          <li><strong>Switch on Network Control in the radio.</strong> In the radio's own menu,
              set <code>Network Control</code> to <strong>ON</strong> and invent a network user
              name and password there.</li>
          <li><strong>Open SETUP &rarr; Radio</strong> and set TRX1 to <code>ICOM-LAN</code>, then
              enter the radio's address and the user name and password you just invented.</li>
          <li><strong>Press Test &amp; identify radio.</strong> The radio reports its own model
              back, and from then on power limits, menu paths and setup guidance follow whichever
              transceiver actually answered.</li>
        </ol>
        <p class="muted">
          The rest of the road above &mdash; identity, the transmit check, this browser's own
          settings &mdash; the SETUP page walks you through step by step. It works out on its own
          what is already done and asks only for what is missing.
        </p>
      </section>
      <p class="muted legal">
        Icom is a registered trademark of Icom Incorporated. WIFILT is an independent software
        project and is not affiliated with, endorsed by, or sponsored by Icom Incorporated.
      </p>
    </div>
  </main>
  <script src="qrcode.min.js"></script>
  <script>
    (function () {
      // The AP name and password are compiled into the firmware (ssidAP /
      // passwordAP in wifilt.ino), so they are a constant of this release --
      // there is no device to ask yet when this page is on screen.
      var AP_JOIN = "WIFI:S:WIFILT-AP;T:WPA;P:remoteqth;;";
      var qr = document.getElementById("apQr");
      if (qr && window.QRCode) {
        new window.QRCode(qr, { text: AP_JOIN, width: 132, height: 132 });
      } else if (qr && qr.parentNode) {
        // No encoder, no white square: the written instructions stand alone.
        qr.parentNode.removeChild(qr);
      }

      // Whether there is anything to back up is the one thing this page cannot
      // work out for itself -- so it asks once, and a new device is never
      // nagged about saving a configuration that does not exist.
      var asNew = document.getElementById("choiceNew");
      var asUpgrade = document.getElementById("choiceUpgrade");
      var panel = document.getElementById("backupPanel");
      var gate = document.getElementById("flashGate");
      var note = document.getElementById("gateNote");
      var hints = document.getElementById("flashHints");
      var restore = document.getElementById("restoreStep");
      var mode = null;

      // There used to be a second gate here -- a checkbox saying the backup was
      // saved -- because a flash really did destroy the configuration. It no
      // longer does, so demanding the acknowledgement every time would be
      // crying wolf, and a warning nobody believes is worse than none. The only
      // gate left is the question the page genuinely cannot answer for itself.
      function apply() {
        var locked = mode === null;
        gate.setAttribute("data-locked", locked ? "1" : "0");
        hints.hidden = locked;
        note.hidden = !locked;
        note.textContent = "Answer the question above to continue.";
        panel.hidden = mode !== "upgrade";
        restore.hidden = mode !== "upgrade";
        asNew.setAttribute("aria-pressed", mode === "new" ? "true" : "false");
        asUpgrade.setAttribute("aria-pressed", mode === "upgrade" ? "true" : "false");
      }

      asNew.addEventListener("click", function () { mode = "new"; apply(); });
      asUpgrade.addEventListener("click", function () { mode = "upgrade"; apply(); });
      apply();
    }());
  </script>
</body>
</html>
EOF

touch "${OUTPUT_DIR}/.nojekyll"

echo ""
echo "==> Build complete: ${OUTPUT_DIR}"
echo "    Firmware REV : ${FW_REV}"
echo "    Partitions   : ${PARTITIONS_CSV_NAME} (no OTA); assets $((SPIFFS_SIZE_DEC / 1024)) kB at ${SPIFFS_OFFSET}"
if [[ -n "$CFG_OFFSET" ]]; then
  echo "    Config       : kept at ${CFG_OFFSET} — a flash does not touch it"
fi
  echo "    Flash mode   : ${FLASH_MODE} ${FLASH_FREQ} (DIO required — Zbit clone flash)"
if [[ -n "$SPIFFS_BIN" ]]; then
  echo "    LittleFS     : included"
else
  echo "    LittleFS     : skipped"
fi
echo ""

# ---------------------------------------------------------------------------
# Publish to gh-pages
# ---------------------------------------------------------------------------

if [[ "$DO_PUBLISH" -eq 0 ]]; then
  echo "To publish to GitHub Pages, run:"
  echo "  bash tools/gh-pages.sh --publish"
  exit 0
fi

echo "==> Publishing to ${PUBLISH_REMOTE}/${PUBLISH_BRANCH}"

if ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: Not a git repository: $ROOT_DIR" >&2; exit 1
fi
if ! git -C "$ROOT_DIR" remote get-url "$PUBLISH_REMOTE" >/dev/null 2>&1; then
  echo "ERROR: Git remote not found: $PUBLISH_REMOTE" >&2; exit 1
fi

[[ -z "$PUBLISH_MESSAGE" ]] && \
  PUBLISH_MESSAGE="Publish WIFILT firmware ${FW_REV} — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

git init "$TMP_DIR" >/dev/null
git -C "$TMP_DIR" remote add "$PUBLISH_REMOTE" \
  "$(git -C "$ROOT_DIR" remote get-url "$PUBLISH_REMOTE")"

if git -C "$TMP_DIR" ls-remote --exit-code --heads \
    "$PUBLISH_REMOTE" "$PUBLISH_BRANCH" >/dev/null 2>&1; then
  git -C "$TMP_DIR" fetch --depth 1 "$PUBLISH_REMOTE" "$PUBLISH_BRANCH"
  git -C "$TMP_DIR" checkout -B "$PUBLISH_BRANCH" FETCH_HEAD
else
  git -C "$TMP_DIR" checkout --orphan "$PUBLISH_BRANCH"
fi

find "$TMP_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
for release_file in .nojekyll index.html manifest.json bootloader.bin partitions.bin \
  boot_app0.bin firmware.bin spiffs.bin "wifilt-${FW_REV}-full.bin"; do
  require_file "${OUTPUT_DIR}/${release_file}" "release artifact ${release_file}"
  cp "${OUTPUT_DIR}/${release_file}" "$TMP_DIR/${release_file}"
done

# The desktop archives are published only when they exist, so they are listed
# separately from the required set above. They must be here rather than relying
# on a copy into OUTPUT_DIR: this loop is an allowlist, and anything not named
# in it never reaches the branch -- which is how the download links 404'd while
# the files sat happily in build/gh-pages.
for optional_file in "$DESKTOP_LINUX_NAME" "$DESKTOP_WIN_NAME" "$DESKTOP_ARM64_NAME" "$DESKTOP_SUMS_NAME"; do
  [[ -n "$optional_file" ]] || continue
  require_file "${OUTPUT_DIR}/${optional_file}" "desktop artifact ${optional_file}"
  cp "${OUTPUT_DIR}/${optional_file}" "$TMP_DIR/${optional_file}"
done

git -C "$TMP_DIR" add --all

if git -C "$TMP_DIR" diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi

GIT_NAME="$(git -C "$ROOT_DIR" config user.name  2>/dev/null || echo "WIFILT Publisher")"
GIT_EMAIL="$(git -C "$ROOT_DIR" config user.email 2>/dev/null || echo "publish@example.invalid")"
git -C "$TMP_DIR" config user.name  "$GIT_NAME"
git -C "$TMP_DIR" config user.email "$GIT_EMAIL"

git -C "$TMP_DIR" commit -m "$PUBLISH_MESSAGE"

echo "Pushing to ${PUBLISH_REMOTE}/${PUBLISH_BRANCH}..."
git -C "$TMP_DIR" push "$PUBLISH_REMOTE" "$PUBLISH_BRANCH"

echo ""
echo "==> Published successfully."
echo "    Enable GitHub Pages on branch '${PUBLISH_BRANCH}' (root) in repository settings."
echo "    URL: https://ok1hra.github.io/wifilt/"
