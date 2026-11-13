#!/usr/bin/env bash
# update-manifest.sh -- writes latest.json, the machine-readable "newest desktop
# build" document the native updater (native/update/) reads.
#
#   tools/update-manifest.sh DIST_DIR VERSION OUTPUT_FILE
#
# VERSION is REV ("20261113") or REV.BUILD ("20261113.1", a same-day release).
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
#   { "rev": "20261110", "build": 1, "version": "20261110.1",
#     "oi3": { "fw": "20261112" },
#     "assets": { "linux-x86_64": { "name": "...", "size": 123, "sha256": "..." },
#                 "linux-arm64":  { ... }, "windows-x64": { ... } } }
# "rev" stays the bare 8-digit date: updaters from before REV_BUILD read exactly
# eight digits there and would fail on "20261110.1". They see the same rev as
# installed and simply do not offer a same-day build; "build" and "version"
# are for the updaters that know them.
# "oi3" is the OI3 firmware the Linux archives carry (oi3/VERSION, see
# tools/build-oi3-hex.sh), read from the archives themselves so the page can
# say before the download that the update brings the OI3 new firmware. Left
# out when no archive carries one.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 DIST_DIR VERSION OUTPUT_FILE" >&2
  exit 2
fi
dist="$1" version="$2" out="$3"
[[ "$version" =~ ^([0-9]{8})(\.([0-9]+))?$ ]] || { echo "ERROR: VERSION '$version' is not YYYYMMDD[.N]" >&2; exit 1; }
rev="${BASH_REMATCH[1]}" build="${BASH_REMATCH[3]:-0}"
build=$((10#$build))

entries=()
oi3_fw=""
for plat in linux-x86_64 linux-arm64 windows-x64; do
  ext=tar.gz
  [[ "$plat" == windows-* ]] && ext=zip
  name="wifilt-${version}-${plat}.${ext}"
  file="${dist}/${name}"
  [[ -f "$file" ]] || continue
  size="$(stat -c%s "$file")"
  sum="$(sha256sum "$file" | awk '{ print $1 }')"
  entries+=("    \"${plat}\": { \"name\": \"${name}\", \"size\": ${size}, \"sha256\": \"${sum}\" }")
  if [[ -z "$oi3_fw" && "$ext" == tar.gz ]]; then
    oi3_fw="$(tar -xzOf "$file" --wildcards '*/oi3/VERSION' 2>/dev/null | tr -dc '0-9' || true)"
    [[ "$oi3_fw" =~ ^[0-9]{8}$ ]] || oi3_fw=""
  fi
done

if [[ ${#entries[@]} -eq 0 ]]; then
  echo "ERROR: no desktop archive for ${version} in ${dist}" >&2
  exit 1
fi

tmp="${out}.tmp"
{
  echo "{"
  echo "  \"rev\": \"${rev}\", \"build\": ${build}, \"version\": \"${version}\","
  [[ -n "$oi3_fw" ]] && echo "  \"oi3\": { \"fw\": \"${oi3_fw}\" },"
  echo "  \"assets\": {"
  for i in "${!entries[@]}"; do
    if (( i + 1 < ${#entries[@]} )); then echo "${entries[$i]},"; else echo "${entries[$i]}"; fi
  done
  echo "  }"
  echo "}"
} > "$tmp"
mv "$tmp" "$out"
echo "==> Update manifest: $(basename "$out") (${#entries[@]} platform(s), ${version}${oi3_fw:+, OI3 ${oi3_fw}})"
