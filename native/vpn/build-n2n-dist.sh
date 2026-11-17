#!/usr/bin/env bash
#
# Build the n2n edge that WIFILT's Linux archives carry (SOFTWARE.md section 1.9):
# n2n 3.1.1 for x86_64 and arm64, from the same pinned tag and checked commit as
# build-n2n.sh, with the resolver thread, stripped.
#
#   native/vpn/build-n2n-dist.sh [OUTDIR]     default: native/dist-n2n
#
# Run by tools/release.sh before `make dist-*`; the Makefile copies what it finds
# here into the archives (n2n/ next to install.sh) and the stand-alone downloads
# into dist/, which tools/gh-pages.sh publishes. Nothing is rebuilt while OUTDIR
# already holds this tag, commit and build.
#
# OUTDIR afterwards:
#   x86_64/edge  arm64/edge   the binaries (dynamically linked against glibc only)
#   LICENSE  SOURCE.txt       GPL-3.0, and where the source is and how it was built
#   n2n-3.1.1-source.tar.gz   `git archive` of the checked commit -- the very tree built
#   n2n-edge-3.1.1-linux-x86_64.tar.gz  n2n-edge-3.1.1-linux-arm64.tar.gz
#                             stand-alone downloads for a computer without WIFILT
#
# CMake, not the autotools of the manual's recipe: the release host needs no
# autoconf/automake/libtool, and the arm64 build is a plain cross compile. Same
# source, same option (N2N_OPTION_USE_PTHREAD is --enable-pthread), same edge.
# glibc: built here against the host's glibc, the edge asks for symbols up to
# GLIBC_2.34 (Debian 12, Ubuntu 22.04, Raspberry Pi OS bookworm and newer have
# them); a build needing more than GLIBC_MAX is refused rather than shipped.
#
# Needs: git, cmake, gcc, binutils (strip, strings, readelf), aarch64-linux-gnu-gcc
# and aarch64-linux-gnu-strip.
# Test overrides: WIFILT_N2N_REPO.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/../dist-n2n}"
GLIBC_MAX="2.34"

# One place for the version: build-n2n.sh, which the stations run.
N2N_TAG="$(sed -n 's/^N2N_TAG="\([^"]*\)"$/\1/p' "$HERE/build-n2n.sh")"
N2N_COMMIT="$(sed -n 's/^N2N_COMMIT="\([^"]*\)"$/\1/p' "$HERE/build-n2n.sh")"
[[ -n "$N2N_TAG" && -n "$N2N_COMMIT" ]] || { echo "ERROR: no N2N_TAG/N2N_COMMIT in build-n2n.sh" >&2; exit 1; }
REPO="${WIFILT_N2N_REPO:-https://github.com/ntop/n2n.git}"
BUILD_LINE="cmake -DCMAKE_BUILD_TYPE=Release -DN2N_OPTION_USE_PTHREAD=ON, target edge, stripped"
STAMP="# n2n $N2N_TAG $N2N_COMMIT | $BUILD_LINE"
ARCHES=(x86_64 arm64)
SRC_TGZ="n2n-${N2N_TAG}-source.tar.gz"

die() { echo "ERROR: $*" >&2; exit 1; }

up_to_date() {
  [[ "$(head -n1 "$OUT/SOURCE.txt" 2>/dev/null)" == "$STAMP" ]] || return 1
  [[ -f "$OUT/LICENSE" && -f "$OUT/$SRC_TGZ" ]] || return 1
  local a
  for a in "${ARCHES[@]}"; do
    [[ -x "$OUT/$a/edge" && -f "$OUT/n2n-edge-${N2N_TAG}-linux-$a.tar.gz" ]] || return 1
  done
}

if up_to_date; then
  echo "n2n $N2N_TAG edge in $OUT is up to date"
  exit 0
fi

for t in git cmake gcc strip strings readelf aarch64-linux-gnu-gcc aarch64-linux-gnu-strip; do
  command -v "$t" >/dev/null 2>&1 || die "$t is missing"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "n2n $N2N_TAG: downloading"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$N2N_TAG" "$REPO" "$WORK/git"
got="$(git -C "$WORK/git" rev-parse HEAD)"
[[ "$got" == "$N2N_COMMIT" ]] || die "tag $N2N_TAG of $REPO is $got, expected $N2N_COMMIT -- not building it"

# The published source is what gets built: extract the archive, no .git (the
# version then comes from the VERSION file -- "3.1.1", as from the tag).
mkdir -p "$WORK/out"
git -C "$WORK/git" archive --format=tar.gz --prefix="n2n-${N2N_TAG}/" -o "$WORK/out/$SRC_TGZ" HEAD
tar xzf "$WORK/out/$SRC_TGZ" -C "$WORK"
SRC="$WORK/n2n-${N2N_TAG}"
[[ "$(cat "$SRC/VERSION")" == "$N2N_TAG" ]] || die "VERSION in the source is not $N2N_TAG"

glibc_need() {   # the highest GLIBC_x.y the binary asks for
  readelf -V --wide "$1" 2>/dev/null | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -n1
}

for arch in "${ARCHES[@]}"; do
  case "$arch" in
    x86_64) cc="gcc"; strip="strip"; machine="X86-64"; cross=() ;;
    arm64)  cc=aarch64-linux-gnu-gcc; strip=aarch64-linux-gnu-strip; machine="AArch64"
            cross=(-DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64) ;;
  esac
  echo "n2n $N2N_TAG: building edge for $arch"
  b="$WORK/build-$arch"
  if ! { cmake -S "$SRC" -B "$b" -DCMAKE_BUILD_TYPE=Release -DN2N_OPTION_USE_PTHREAD=ON \
           -DCMAKE_C_COMPILER="$cc" "${cross[@]}" &&
         cmake --build "$b" --target edge -j"$(nproc 2>/dev/null || echo 2)"; } >"$WORK/build-$arch.log" 2>&1; then
    tail -n 30 "$WORK/build-$arch.log" >&2
    die "the $arch build failed"
  fi
  mkdir -p "$WORK/out/$arch"
  "$strip" -o "$WORK/out/$arch/edge" "$b/edge"
  chmod 0755 "$WORK/out/$arch/edge"
  e="$WORK/out/$arch/edge"

  readelf -h "$e" | grep -E "Machine:.*$machine" >/dev/null || die "$arch: not an $machine binary"
  grep -a pthread_create "$e" >/dev/null || die "$arch: built without the resolver thread"
  # The version is a string of its own (PACKAGE_VERSION); the banner is a format.
  strings -n 5 "$e" | grep -x -F "$N2N_TAG" >/dev/null || die "$arch: version $N2N_TAG not found in the binary"
  need="$(glibc_need "$e")"
  [[ -n "$need" ]] || die "$arch: cannot read the glibc versions it needs"
  [[ "$(printf '%s\n%s\n' "$need" "$GLIBC_MAX" | sort -V | tail -n1)" == "$GLIBC_MAX" ]] \
    || die "$arch: needs GLIBC_$need, more than GLIBC_$GLIBC_MAX -- it would not run on Debian 12 / Ubuntu 22.04"
  if [[ "$arch" == x86_64 && "$(uname -m)" == x86_64 ]]; then
    case "$("$e" -h 2>&1 | head -n3 | tr '\n' ' ' || true)" in
      *"n2n v.$N2N_TAG "*) ;;
      *) die "x86_64: edge -h does not say n2n v.$N2N_TAG" ;;
    esac
  fi
  echo "n2n $N2N_TAG: $arch edge $(stat -c %s "$e") B, needs GLIBC_$need"
done

cp "$SRC/LICENSE" "$WORK/out/LICENSE"
cat > "$WORK/out/SOURCE.txt" <<EOF
$STAMP

n2n edge $N2N_TAG, built unmodified for WIFILT (https://github.com/ok1hra/wifilt),
whose remote access over the internet it runs (SOFTWARE.md section 1.9).

Upstream   https://github.com/ntop/n2n -- tag $N2N_TAG, commit $N2N_COMMIT
Source     $SRC_TGZ, published next to the downloads on https://ok1hra.github.io/wifilt/
           (git archive of that commit: the very tree this was built from)
Build      $BUILD_LINE
           (N2N_OPTION_USE_PTHREAD is configure's --enable-pthread: without it the
           edge cannot register with a supernode given by name)
Needs      Linux with glibc $GLIBC_MAX or newer (Debian 12, Ubuntu 22.04, Raspberry Pi OS
           bookworm and newer); nothing else
Licence    GPL-3.0, see LICENSE
EOF

for arch in "${ARCHES[@]}"; do
  name="n2n-edge-${N2N_TAG}-linux-$arch"
  mkdir -p "$WORK/pkg/$name"
  cp "$WORK/out/$arch/edge" "$WORK/out/LICENSE" "$WORK/out/SOURCE.txt" "$WORK/pkg/$name/"
  cat > "$WORK/pkg/$name/README.txt" <<EOF
n2n edge $N2N_TAG for Linux $arch -- the client of WIFILT's remote access, for a
computer without WIFILT (a laptop). With WIFILT installed you do not need this:
its archive carries the same edge and SETUP -> Remote access runs it.

Install:
  sudo install -m 0755 edge /usr/local/sbin/edge

Join the VPN of your station -- the community and the key are in the station's
SETUP -> Remote access -> Advanced (after SHOW):
  sudo N2N_KEY=<key> /usr/local/sbin/edge -d wlvpn0 -c <community> -l remoteqth.com:82 -A4 -I LAPTOP -f

The station is then at its VPN address, http://10.x.y.z/ -- SETUP lists it.
Manual: https://github.com/ok1hra/wifilt/blob/main/SOFTWARE.md#19-remote-access-over-the-internet-pc-and-raspberry-pi
Source and licence: SOURCE.txt, LICENSE (GPL-3.0).
EOF
  tar czf "$WORK/out/$name.tar.gz" -C "$WORK/pkg" --owner=0 --group=0 "$name"
done

mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT.new"
mv "$WORK/out" "$OUT.new"
rm -rf "$OUT"
mv "$OUT.new" "$OUT"
echo "n2n $N2N_TAG edge for ${ARCHES[*]} -> $OUT"
