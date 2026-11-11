#!/usr/bin/env bash
# update-manifest.sh -- writes latest.json, the machine-readable "newest desktop
# build" document the native updater (native/update/) reads.
#
#   tools/update-manifest.sh DIST_DIR REV OUTPUT_FILE
#
# DIST_DIR holds the finished archives (wifilt-REV-linux-x86_64.tar.gz,
# wifilt-REV-linux-arm64.tar.gz, wifilt-REV-windows-x64.zip). Only the archives
# that exist are listed: a release without a cross toolchain simply has no
# entry for that platform, and the updater then says "no build for this
# platform" instead of offering a download that 404s.
#
# Size and SHA256 are taken from the files themselves, after any repacking
# (release.sh adds local-trx in place), so the updater can show a real progress
# bar and refuse a corrupted download.
#
# Format (stable; the updater ignores unknown keys):
#   { "rev": "20261110",
#     "assets": { "linux-x86_64": { "name": "...", "size": 123, "sha256": "..." },
#                 "linux-arm64":  { ... }, "windows-x64": { ... } } }
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 DIST_DIR REV OUTPUT_FILE" >&2
  exit 2
fi
dist="$1" rev="$2" out="$3"
[[ "$rev" =~ ^[0-9]{8}$ ]] || { echo "ERROR: REV '$rev' is not YYYYMMDD" >&2; exit 1; }

entries=()
for plat in linux-x86_64 linux-arm64 windows-x64; do
  ext=tar.gz
  [[ "$plat" == windows-* ]] && ext=zip
  name="wifilt-${rev}-${plat}.${ext}"
  file="${dist}/${name}"
  [[ -f "$file" ]] || continue
  size="$(stat -c%s "$file")"
  sum="$(sha256sum "$file" | awk '{ print $1 }')"
  entries+=("    \"${plat}\": { \"name\": \"${name}\", \"size\": ${size}, \"sha256\": \"${sum}\" }")
done

if [[ ${#entries[@]} -eq 0 ]]; then
  echo "ERROR: no desktop archive for REV ${rev} in ${dist}" >&2
  exit 1
fi

tmp="${out}.tmp"
{
  echo "{"
  echo "  \"rev\": \"${rev}\","
  echo "  \"assets\": {"
  for i in "${!entries[@]}"; do
    if (( i + 1 < ${#entries[@]} )); then echo "${entries[$i]},"; else echo "${entries[$i]}"; fi
  done
  echo "  }"
  echo "}"
} > "$tmp"
mv "$tmp" "$out"
echo "==> Update manifest: $(basename "$out") (${#entries[@]} platform(s), REV ${rev})"
