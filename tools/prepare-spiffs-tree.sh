#!/usr/bin/env bash
set -euo pipefail

# Create a deployment tree containing compressed web assets without their
# uncompressed duplicates. Source files remain in data/ for review and tests.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:-${ROOT_DIR}/data}"
TARGET_DIR="${2:-${ROOT_DIR}/build/spiffs-data}"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "ERROR: data directory not found: $SOURCE_DIR" >&2
  exit 1
fi

# Before both: every ?v= is derived from the content it points at, and .html and
# data.js are what this rewrites -- so it has to run ahead of the minifier and
# the compressor that consume them. A page whose script tag still carries the
# previous version ships a browser cache entry that outlives the flash.
node "${ROOT_DIR}/tools/stamp-asset-versions.js" "$SOURCE_DIR"
"${ROOT_DIR}/tools/minify-spiffs-js.sh" "$SOURCE_DIR"
"${ROOT_DIR}/tools/gzip-assets.sh" "$SOURCE_DIR"

# Add-ons (addons/<name>/data/ -- an optional checkout beside the sketch, see
# "Add-ons" in wifilt.ino): their pages go through the same three steps, may
# reference the core's scripts, and are copied in after the core's files, so an
# add-on file of the same name (addon-tabs.json) replaces the core's.
# WIFILT_NO_ADDONS=1 builds the image without them.
ADDON_DIRS=()
if [[ "${WIFILT_NO_ADDONS:-0}" != 1 ]]; then
  for addon_data in "${ROOT_DIR}"/addons/*/data; do
    [[ -d "$addon_data" ]] || continue
    ADDON_DIRS+=("$addon_data")
    node "${ROOT_DIR}/tools/stamp-asset-versions.js" "$addon_data" "--lookup=${SOURCE_DIR}"
    "${ROOT_DIR}/tools/minify-spiffs-js.sh" "$addon_data"
    "${ROOT_DIR}/tools/gzip-assets.sh" "$addon_data"
  done
fi
mkdir -p "$TARGET_DIR"

# TARGET_DIR is a build directory. Remove only its previous files after both
# paths have been resolved and checked.
source_real="$(realpath "$SOURCE_DIR")"
target_real="$(realpath "$TARGET_DIR")"
if [[ "$target_real" == "$source_real" || "$target_real" == "/" ]]; then
  echo "ERROR: unsafe SPIFFS target: $target_real" >&2
  exit 1
fi
find "$TARGET_DIR" -mindepth 1 -depth -delete

copy_tree() {
local SOURCE_DIR="$1"
while IFS= read -r -d '' file; do
  relative="${file#${SOURCE_DIR}/}"
  # The WATCH viewer page (watch_hub.h) talks to /watchws, which only the PC
  # build has; on the box it would only cost flash. native/Makefile asks for it.
  case "$(basename "$file")" in
    watch.html*|watch.js*|watch.css*)
      [[ "${WIFILT_NATIVE_ASSETS:-0}" == 1 ]] || continue ;;
  esac
  case "$file" in
    */.minified-js.sha256) continue ;;
    # The complete Brotli MIT text is embedded in THIRD-PARTY-NOTICES.txt.
    # Keep the standalone build-source copy in data/, but avoid a duplicate
    # Avoid a duplicate license entry in the constrained filesystem image.
    */BROTLI-LICENSE.txt|*/BROTLI-LICENSE.txt.gz) continue ;;
    *.js.min) continue ;;
    *.br)
      case "$(basename "$file")" in
        js8-jsc.bin.br|js8-decoder.wasm.br|mercury-host.wasm.br) ;;
        *) [[ -f "${file%.br}.gz" ]] && continue ;;
      esac
      ;;
    *.gz)
      case "$(basename "$file")" in
        js8-jsc.bin.gz|js8-decoder.wasm.gz|mercury-host.wasm.gz) continue ;;
      esac
      ;;
    *.html|*.css|*.js|*.wasm|*.bin|*.txt)
      [[ -f "${file}.br" || -f "${file}.gz" ]] && continue
      ;;
  esac
  mkdir -p "$TARGET_DIR/$(dirname "$relative")"
  cp "$file" "$TARGET_DIR/$relative"
done < <(find "$SOURCE_DIR" -type f -print0 | sort -z)
}
copy_tree "$SOURCE_DIR"
for addon_data in ${ADDON_DIRS[@]+"${ADDON_DIRS[@]}"}; do
  copy_tree "$addon_data"
  echo "==> Add-on pages: ${addon_data#${ROOT_DIR}/}"
done

bytes="$(du -sb "$TARGET_DIR" | awk '{print $1}')"
echo "==> Filesystem deployment tree: $TARGET_DIR ($bytes bytes)"
