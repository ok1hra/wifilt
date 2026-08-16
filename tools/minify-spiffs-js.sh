#!/usr/bin/env bash
set -euo pipefail

# Generate checked-in release companions (*.js.min). Source JS remains readable;
# gzip-assets.sh consumes the companion and rejects it when it is stale.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${1:-${ROOT_DIR}/data}"
TERSER_BIN="${TERSER_BIN:-$(command -v terser || true)}"

[[ -n "$TERSER_BIN" && -f "$TERSER_BIN" ]] || {
  echo "ERROR: terser not found; install Debian package terser or set TERSER_BIN" >&2
  exit 1
}

MANIFEST="${DATA_DIR}/.minified-js.sha256"
: > "$MANIFEST"

find "$DATA_DIR" -maxdepth 1 -type f -name '*.js' -print0 | sort -z |
while IFS= read -r -d '' source; do
  case "$(basename "$source")" in
    qrcode.min.js|js8-core.js|js8-decoder.js|js8-brotli.js) continue ;;
  esac
  if [[ "$(basename "$source")" == "data.js" ]]; then
    # data.js is the largest application-owned script. Mangle its private
    # top-level bindings, but retain the documented extension API that
    # data-layer modules load against by name. This also preserves one SPIFFS
    # allocation unit.
    #
    # Everything after Encoder is the host contract compression.js binds against
    # (HOST_BINDINGS in that file). Drop one here and the module's hooks bind to
    # nothing in the minified build only -- but data-browser-smoke.js serves the
    # minified .gz and its compressionHostBindings check goes red, so the two
    # lists cannot silently drift. Keep them in sync.
    "$TERSER_BIN" --compress passes=3 \
      --mangle 'toplevel,reserved=[AudioSource,Modems,registerModem,Decoder,Encoder,state,currentJs8,startTxTo,applyDecoderActivity,dispatchAssembledMessage,buildSessionSnapshot,chooseCall,clearRecipient,presetHz,bandOf,radioTransmitting,requestFrequency,renderHeader,renderFrequencyMenu,selectedMode,isMyGroup,mailPathRefusal]' \
      --output "${source}.min" -- "$source"
  else
    "$TERSER_BIN" --compress --mangle --output "${source}.min" -- "$source"
  fi
  hash="$(sha256sum "$source" | awk '{print $1}')"
  printf '%s  %s\n' "$hash" "$(basename "$source")" >> "$MANIFEST"
  echo "    $(basename "${source}.min")"
done
