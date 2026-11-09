#!/usr/bin/env bash
set -euo pipefail

# Release upload after Arduino IDE: Sketch -> Export Compiled Binary.
# Builds LittleFS in the partition named "spiffs" and writes APP + filesystem in one
# esptool write session. Bootloader and partition table are deliberately
# untouched; the device partition table is verified before any write.
#
# One exception: a device on an older layout that still has a cfg partition
# (REV 20260808 .. 20261101: cfg between app0 and spiffs) is MIGRATED. Its cfg
# is read back first and saved under build/release-upload/, then the new
# partition table, firmware, assets and that same cfg image at its new offset
# go out in one write session (tools/flash-layout.py decides which case it is).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=""
FIRMWARE=""
EDITION=""
BAUD=921600
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage:
  tools/upload-firmware-spiffs.sh --port DEVICE [options]
  tools/upload-firmware-spiffs.sh --dry-run [options]

Options:
  --port DEVICE    Serial port, e.g. /dev/ttyUSB0 or /dev/serial/by-id/...
  --edition E      addons: firmware and pages with the add-ons from addons/
                   (wifilt.ino.esp32.addons.bin); public: without them
                   (wifilt.ino.esp32.bin). Default: addons when addons/addon.h
                   exists, public otherwise.
  --firmware FILE  Exported application binary (default: per edition)
  --baud RATE      Upload baud rate (default: 921600)
  --dry-run        Build and validate both images without writing flash
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --firmware) FIRMWARE="${2:-}"; shift 2 ;;
    --edition) EDITION="${2:-}"; shift 2 ;;
    --baud) BAUD="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done


if [[ -z "$EDITION" ]]; then
  [[ -f "${ROOT_DIR}/addons/addon.h" ]] && EDITION=addons || EDITION=public
fi
case "$EDITION" in
  public) export WIFILT_NO_ADDONS=1 ;;
  addons)
    [[ -f "${ROOT_DIR}/addons/addon.h" ]] || { echo "ERROR: --edition addons without addons/addon.h" >&2; exit 1; }
    export WIFILT_NO_ADDONS=0
    if [[ -z "$FIRMWARE" ]]; then
      FIRMWARE="${ROOT_DIR}/wifilt.ino.esp32.addons.bin"
      [[ -f "$FIRMWARE" ]] || { echo "ERROR: $FIRMWARE not found; run tools/export-compiled-binary.sh --edition addons" >&2; exit 1; }
    fi ;;
  *) echo "ERROR: --edition must be public or addons" >&2; exit 2 ;;
esac
echo "==> Edition: $EDITION"

if [[ -z "$FIRMWARE" ]]; then
  if [[ -f "${ROOT_DIR}/wifilt.ino.esp32.bin" ]]; then
    FIRMWARE="${ROOT_DIR}/wifilt.ino.esp32.bin"
  elif [[ -f "${ROOT_DIR}/wifilt.ino.bin" ]]; then
    FIRMWARE="${ROOT_DIR}/wifilt.ino.bin"
  else
    echo "ERROR: exported firmware not found; run Sketch -> Export Compiled Binary" >&2
    exit 1
  fi
else
  FIRMWARE="$(realpath "$FIRMWARE")"
fi
[[ -f "$FIRMWARE" ]] || { echo "ERROR: firmware not found: $FIRMWARE" >&2; exit 1; }
# The pages must match the firmware: add-on pages without their routes, or the
# routes without the pages, is a half-working device.
fw_marks="$(LC_ALL=C grep -a -c 'WIFILT-ADDONS' "$FIRMWARE" || true)"
if [[ "$EDITION" == public && "$fw_marks" != 0 ]]; then
  echo "ERROR: $(basename "$FIRMWARE") was built with add-ons; use --edition addons" >&2; exit 1
fi
if [[ "$EDITION" == addons && "$fw_marks" == 0 ]]; then
  echo "ERROR: $(basename "$FIRMWARE") has no add-ons; use --edition public" >&2; exit 1
fi

firmware_magic="$(od -An -t x1 -N1 "$FIRMWARE" | tr -d '[:space:]')"
[[ "$firmware_magic" == "e9" ]] || {
  echo "ERROR: $FIRMWARE is not an ESP32 application image (magic=$firmware_magic)" >&2
  exit 1
}

# Refuse an export older than any root-level firmware source file.
while IFS= read -r -d '' source; do
  if [[ "$source" -nt "$FIRMWARE" ]]; then
    echo "ERROR: exported firmware is stale; newer source: $source" >&2
    echo "       Run Sketch -> Export Compiled Binary again." >&2
    exit 1
  fi
done < <(find "$ROOT_DIR" -maxdepth 1 -type f \
  \( -name '*.ino' -o -name '*.h' -o -name '*.hpp' -o -name '*.cpp' \) -print0)

ARDUINO15_DIR="${ARDUINO15_DIR:-}"
if [[ -z "$ARDUINO15_DIR" ]]; then
  for candidate in "${HOME}/Arduino/libraries/.arduino15" "${HOME}/.arduino15"; do
    if [[ -d "$candidate/packages/esp32" ]]; then ARDUINO15_DIR="$candidate"; break; fi
  done
fi
[[ -n "$ARDUINO15_DIR" ]] || {
  echo "ERROR: ESP32 Arduino package directory not found; set ARDUINO15_DIR" >&2
  exit 1
}

ESP32_HW_ROOT="$(find "$ARDUINO15_DIR/packages/esp32/hardware/esp32" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
# Sketch-local custom layout (app0 / spiffs / cfg at the end, no coredump).
# The ESP32 core prebuild hook flashes this same file, so app/spiffs offsets and
# sizes below are read straight from it and stay in sync with the on-device table.
PARTITION_CSV="$ROOT_DIR/partitions.csv"
MKLITTLEFS_BIN="$(find "$ARDUINO15_DIR/packages/esp32/tools/mklittlefs" -type f -name mklittlefs -perm -u+x | sort -V | tail -1)"
ESPTOOL_PY="$(find "$ARDUINO15_DIR/packages/esp32/tools/esptool_py" -type f -name esptool.py | sort -V | tail -1)"
GEN_PARTITIONS="$ESP32_HW_ROOT/tools/gen_esp32part.py"
FLASH_LAYOUT="$ROOT_DIR/tools/flash-layout.py"
for required in "$PARTITION_CSV" "$MKLITTLEFS_BIN" "$ESPTOOL_PY" "$GEN_PARTITIONS" "$FLASH_LAYOUT"; do
  [[ -f "$required" ]] || { echo "ERROR: required tool/file missing: $required" >&2; exit 1; }
done

# ---- memory usage report helpers -------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_OFF=$'\033[0m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'
else
  C_OFF=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""
fi

fmt_num() { echo "$1" | rev | sed -E 's/([0-9]{3})/\1 /g' | rev | sed 's/^ *//'; }

pct_of() { awk -v u="$1" -v t="$2" 'BEGIN { printf "%.1f", (t > 0 ? u * 100 / t : 0) }'; }

# usage_line LABEL USED TOTAL  -> bar + percent + free, colour-coded by fill
usage_line() {
  local label="$1" used="$2" total="$3" width=32
  local pct filled colour i bar=""
  pct="$(pct_of "$used" "$total")"
  filled=$(awk -v p="$pct" -v w="$width" 'BEGIN { f = int(p * w / 100); if (f > w) f = w; print f }')
  if   awk -v p="$pct" 'BEGIN { exit !(p >= 90) }'; then colour="$C_RED"
  elif awk -v p="$pct" 'BEGIN { exit !(p >= 75) }'; then colour="$C_YELLOW"
  else colour="$C_GREEN"; fi
  for ((i = 0; i < width; i++)); do
    if ((i < filled)); then bar+="#"; else bar+="."; fi
  done
  printf '  %b%-19s%b %b%s%b %b%6s %%%b\n' \
    "$C_BOLD" "$label" "$C_OFF" "$colour" "$bar" "$C_OFF" "$C_BOLD$colour" "$pct" "$C_OFF"
  printf '  %-19s used %13s B   of %13s B   free %13s B\n' \
    "" "$(fmt_num "$used")" "$(fmt_num "$total")" "$(fmt_num $((total - used)))"
}

print_memory_report() {
  echo
  printf '%b' "$C_CYAN"
  echo "==============================================================================="
  printf '  %bFLASH MEMORY USAGE%b%b\n' "$C_BOLD" "$C_OFF" "$C_CYAN"
  echo "==============================================================================="
  printf '%b' "$C_OFF"
  usage_line "PROGRAM (app0)" "$FIRMWARE_SIZE" "$APP_SIZE_DEC"
  echo
  # Denominator is the GATE, not the partition. The 256 KiB runtime reserve is
  # held for device-written data and the payload can never occupy it -- gating
  # against SPIFFS_SIZE_DEC would put 327 680 unreachable bytes in the bar, show
  # ~10 points less fill than is true, and fire the yellow/red warning that much
  # too late. The partition figure stays on the detail line so nothing is hidden.
  usage_line "FILESYSTEM (spiffs)" "$staging_bytes" "$max_payload_bytes"
  printf '  %-19s %s files · partition %s B = gate + 256 KiB runtime reserve + 64 KiB metadata\n' \
    "" "$staging_files" "$(fmt_num "$SPIFFS_SIZE_DEC")"
  printf '%b' "$C_CYAN"
  echo "==============================================================================="
  printf '%b' "$C_OFF"
  echo
}
# ----------------------------------------------------------------------------

partition_field() {
  local name="$1" field="$2"
  awk -F, -v wanted="$name" -v column="$field" '
    $1 ~ "^[[:space:]]*" wanted "[[:space:]]*$" {
      gsub(/[[:space:]]/, "", $column); print $column; exit
    }' "$PARTITION_CSV"
}

APP_OFFSET="$(partition_field app0 4)"
APP_SIZE="$(partition_field app0 5)"
SPIFFS_OFFSET="$(partition_field spiffs 4)"
SPIFFS_SIZE="$(partition_field spiffs 5)"
[[ -n "$APP_OFFSET" && -n "$APP_SIZE" && -n "$SPIFFS_OFFSET" && -n "$SPIFFS_SIZE" ]] || {
  echo "ERROR: app0/SPIFFS layout missing in $PARTITION_CSV" >&2
  exit 1
}
APP_SIZE_DEC=$((APP_SIZE))
SPIFFS_SIZE_DEC=$((SPIFFS_SIZE))
FIRMWARE_SIZE="$(stat -c '%s' "$FIRMWARE")"
[[ "$FIRMWARE_SIZE" -le "$APP_SIZE_DEC" ]] || {
  echo "ERROR: firmware $FIRMWARE_SIZE B exceeds app0 partition $APP_SIZE_DEC B" >&2
  exit 1
}

BUILD_DIR="${ROOT_DIR}/build/release-upload"
STAGING_DIR="${BUILD_DIR}/data"
SPIFFS_IMAGE="${BUILD_DIR}/spiffs.bin"
EXPECTED_PARTITIONS="${BUILD_DIR}/expected-partitions.bin"
DEVICE_PARTITIONS="${BUILD_DIR}/device-partitions.bin"
mkdir -p "$BUILD_DIR"
"${ROOT_DIR}/tools/prepare-spiffs-tree.sh" "${ROOT_DIR}/data" "$STAGING_DIR"
staging_bytes="$(du -sb "$STAGING_DIR" | awk '{print $1}')"
staging_files="$(find "$STAGING_DIR" -type f | wc -l)"
runtime_reserve_bytes=$((256 * 1024))
metadata_budget_bytes=$((64 * 1024))
max_payload_bytes=$((SPIFFS_SIZE_DEC - runtime_reserve_bytes - metadata_budget_bytes))
if [[ "$staging_bytes" -gt "$max_payload_bytes" ]]; then
  echo "ERROR: LittleFS deployment leaves less than the required 256 KiB runtime reserve." >&2
  echo "       Payload: $staging_bytes B; limit: $max_payload_bytes B; partition: $SPIFFS_SIZE_DEC B." >&2
  exit 1
fi
if ! "$MKLITTLEFS_BIN" -c "$STAGING_DIR" -b 4096 -p 256 -s "$SPIFFS_SIZE_DEC" "$SPIFFS_IMAGE"; then
  echo "ERROR: LittleFS deployment does not fit after filesystem overhead." >&2
  echo "       Payload: $staging_bytes B in $staging_files files; partition: $SPIFFS_SIZE_DEC B." >&2
  echo "       Reduce or recompress web assets; increasing the image past the partition is unsafe." >&2
  exit 1
fi
python3 "$GEN_PARTITIONS" "$PARTITION_CSV" "$EXPECTED_PARTITIONS" >/dev/null
SPIFFS_IMAGE_SIZE="$(stat -c '%s' "$SPIFFS_IMAGE")"
[[ "$SPIFFS_IMAGE_SIZE" -eq "$SPIFFS_SIZE_DEC" ]] || {
  echo "ERROR: LittleFS image size $SPIFFS_IMAGE_SIZE != partition $SPIFFS_SIZE_DEC" >&2
  exit 1
}

echo "==> Partition map : $PARTITION_CSV"
echo "==> Firmware      : $FIRMWARE ($FIRMWARE_SIZE / $APP_SIZE_DEC bytes)"
echo "==> APP write     : $APP_OFFSET"
echo "==> LittleFS image: $SPIFFS_IMAGE ($SPIFFS_IMAGE_SIZE bytes)"
echo "==> Runtime reserve gate: $runtime_reserve_bytes bytes (payload $staging_bytes / $max_payload_bytes)"
echo "==> Filesystem write: $SPIFFS_OFFSET (partition label: spiffs)"
echo "==> Preserved     : bootloader, partition table, NVS and cfg"
echo "==> Safety check  : device partition table must match $(basename "$PARTITION_CSV"),"
echo "                    or be the previous layout, whose cfg is then carried over"

print_memory_report

if [[ "$DRY_RUN" == true ]]; then
  echo "==> Dry run complete; flash was NOT modified"
  exit 0
fi

[[ -n "$PORT" ]] || { echo "ERROR: upload requires --port DEVICE" >&2; exit 2; }
[[ -e "$PORT" ]] || { echo "ERROR: serial port does not exist: $PORT" >&2; exit 1; }
[[ "$BAUD" =~ ^[0-9]+$ ]] || { echo "ERROR: invalid baud rate: $BAUD" >&2; exit 2; }

PARTITION_TABLE_OFFSET=0x8000
PARTITION_TABLE_SIZE="$(stat -c '%s' "$EXPECTED_PARTITIONS")"
echo "==> Verifying the device partition table before writing"
python3 "$ESPTOOL_PY" --chip esp32 --port "$PORT" --baud "$BAUD" \
  --before default_reset --after no_reset read_flash \
  "$PARTITION_TABLE_OFFSET" "$PARTITION_TABLE_SIZE" "$DEVICE_PARTITIONS"
layout_plan="$(python3 "$FLASH_LAYOUT" plan "$DEVICE_PARTITIONS" "$EXPECTED_PARTITIONS")"
case "$layout_plan" in
  match)
    echo "==> Writing firmware + LittleFS on $PORT"
    python3 "$ESPTOOL_PY" --chip esp32 --port "$PORT" --baud "$BAUD" \
      --before default_reset --after hard_reset write_flash \
      "$APP_OFFSET" "$FIRMWARE" \
      "$SPIFFS_OFFSET" "$SPIFFS_IMAGE"
    ;;
  migrate\ *)
    read -r _ CFG_OLD_OFFSET CFG_SIZE CFG_NEW_OFFSET <<<"$layout_plan"
    # Kept, not a temp file: if the write below is interrupted this is the
    # operator's whole configuration, and the restore command is printed.
    CFG_SAVED="${BUILD_DIR}/cfg-backup-$(date +%Y%m%d-%H%M%S).bin"
    echo "==> Device has the previous layout; moving cfg $CFG_OLD_OFFSET -> $CFG_NEW_OFFSET"
    echo "==> Reading the configuration partition into $CFG_SAVED"
    python3 "$ESPTOOL_PY" --chip esp32 --port "$PORT" --baud "$BAUD" \
      --before default_reset --after no_reset read_flash \
      "$CFG_OLD_OFFSET" "$CFG_SIZE" "$CFG_SAVED"
    cfg_kind="$(python3 "$FLASH_LAYOUT" cfg "$CFG_SAVED")"
    # Step 1 puts cfg at its new offset, which the old layout spends on the tail
    # of the asset filesystem -- nothing of value is lost if the run stops here.
    # Step 2 then writes the new table, firmware and assets (the assets cover
    # the old cfg). Interrupted inside step 2, a re-run finds either the new
    # table ("match", cfg already in place) or the old one with its cfg already
    # overwritten -- the branch below then finds the carried copy and goes on.
    case "$cfg_kind" in
      littlefs)
        echo "==> Step 1/2: configuration -> $CFG_NEW_OFFSET"
        python3 "$ESPTOOL_PY" --chip esp32 --port "$PORT" --baud "$BAUD" \
          --before default_reset --after no_reset write_flash \
          "$CFG_NEW_OFFSET" "$CFG_SAVED" ;;
      empty)
        # Never configured: nothing to carry, the firmware formats cfg on its
        # first boot. Erased rather than left alone, so leftover asset blocks of
        # the old layout are never offered to LittleFS as a filesystem.
        echo "==> Step 1/2: no configuration yet; erasing $CFG_NEW_OFFSET"
        python3 "$ESPTOOL_PY" --chip esp32 --port "$PORT" --baud "$BAUD" \
          --before default_reset --after no_reset erase_region \
          "$CFG_NEW_OFFSET" "$CFG_SIZE" ;;
      *)
        CFG_CARRIED="${BUILD_DIR}/cfg-at-new-offset.bin"
        python3 "$ESPTOOL_PY" --chip esp32 --port "$PORT" --baud "$BAUD" \
          --before default_reset --after no_reset read_flash \
          "$CFG_NEW_OFFSET" "$CFG_SIZE" "$CFG_CARRIED"
        if [[ "$(python3 "$FLASH_LAYOUT" cfg "$CFG_CARRIED")" != littlefs ]]; then
          echo "ERROR: $CFG_OLD_OFFSET holds neither LittleFS nor erased flash," >&2
          echo "       and no configuration was carried to $CFG_NEW_OFFSET before." >&2
          echo "       Nothing was written. Saved copy: $CFG_SAVED" >&2
          exit 1
        fi
        CFG_SAVED="$CFG_CARRIED"
        cfg_kind="carried earlier"
        echo "==> Step 1/2: configuration already at $CFG_NEW_OFFSET (an earlier run was interrupted)" ;;
    esac
    echo "==> Step 2/2: partition table + firmware + LittleFS on $PORT"
    if ! python3 "$ESPTOOL_PY" --chip esp32 --port "$PORT" --baud "$BAUD" \
      --before default_reset --after hard_reset write_flash \
      "$PARTITION_TABLE_OFFSET" "$EXPECTED_PARTITIONS" \
      "$APP_OFFSET" "$FIRMWARE" \
      "$SPIFFS_OFFSET" "$SPIFFS_IMAGE"; then
      echo "ERROR: the migration write did not complete. Re-run this script:" >&2
      echo "       the configuration is already at $CFG_NEW_OFFSET, and a copy is" >&2
      echo "       kept in $CFG_SAVED." >&2
      exit 1
    fi
    echo "==> Layout migrated (cfg: $cfg_kind); copy kept at $CFG_SAVED"
    ;;
  *)
    echo "ERROR: device partition table does not match $PARTITION_CSV" >&2
    echo "       and cannot be migrated: ${layout_plan#refuse }." >&2
    echo "       Nothing was written. Do ONE full flash that rewrites the partition" >&2
    echo "       table first (Arduino IDE Upload, or the web installer) -- both use" >&2
    echo "       the sketch-local partitions.csv. That flash loses the configuration," >&2
    echo "       so back it up via /config/download beforehand and restore it with" >&2
    echo "       Upload config afterwards. After that this script works normally." >&2
    exit 1 ;;
esac

# Repeat the report after the long esptool output so it cannot be missed.
echo "==> Upload complete"
print_memory_report
