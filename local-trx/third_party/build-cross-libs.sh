#!/usr/bin/env bash
#
# Fetches and cross-compiles hamlib + libserialport (static libs) for
# local-trx's two non-native targets (bod 13, Dávka 3): aarch64-linux-gnu
# (Raspberry Pi / 64-bit ARM Linux) and x86_64-w64-mingw32 (Windows). Linux
# x86_64 itself never runs this -- it uses the system -dev packages via
# pkg-config (libhamlib-dev, libserialport-dev), same as always.
#
# WHY A BUILD SCRIPT, NOT VENDORED BINARIES
#   miniaudio/doctest are vendored as SOURCE (third_party/miniaudio,
#   third_party/doctest) because they are small, single-header/amalgamated
#   files. hamlib's own static lib is 25-40MB per target -- committing that
#   into git would bloat the repository forever, so this script rebuilds it
#   on demand instead. Output goes to third_party/cross/<lib>-<target>/,
#   gitignored (see local-trx/.gitignore), not committed.
#
# WHY UPSTREAM RELEASE TARBALLS, NOT `apt-get source`
#   Both were tried live (2026-09-01). `apt-get source` pulls Debian's
#   patched tree, whose autotools-generated files (aclocal.m4, configure,
#   every Makefile.in) come out of dpkg-source with INCONSISTENT mtimes --
#   `make` then tries to re-run aclocal-1.16/automake-1.16 to "fix" them,
#   which are not installed here (or on most dev machines), and the whole
#   build fails before it starts. A plain upstream release tarball's files
#   keep the release's own consistent timestamps, so this never triggers.
#   Also Debian-independent: works on any Linux with the cross-compilers
#   installed, not just apt-based distros with deb-src enabled.
#
# USAGE
#   third_party/build-cross-libs.sh [arm64|win|all]      (default: all)
#
# Requires the same cross-compiler packages native/Makefile's own win:/
# arm64: targets already need:
#   aarch64-linux-gnu-gcc/g++, x86_64-w64-mingw32-gcc-posix/g++-posix
#
# hamlib is built WITHOUT libusb/readline/INDI/C++ binding (--without-*) --
# only the core CAT-over-serial library this project actually uses, so
# cross-building never needs libusb-1.0 (or readline) cross-compiled too.
# This does drop hamlib's handful of USB-native-only backends (bod 10's
# "whole list, no curation" is about MODELS, not transports -- local-trx's
# whole architecture already assumes a serial CAT adapter, see bod 6/7, so
# a USB-native rig was never in scope regardless of this flag).
#
# The Windows build's tests/ utilities (rigctl.exe etc.) fail to link
# (undefined reference to async_pipe_*, a real upstream mingw gap in
# hamlib 4.5.x's daemon-mode pipe code, unrelated to anything local-trx
# uses) -- this script installs directly from src/+include/ for that
# target instead of running the top-level `make install`, which needs
# those utilities to link first. Confirmed live: local-trx itself only
# ever links against libhamlib.a, never those command-line tools.

set -euo pipefail

HAMLIB_VERSION=4.5.5
LIBSERIALPORT_VERSION=0.1.2
HAMLIB_URL="https://github.com/Hamlib/Hamlib/releases/download/${HAMLIB_VERSION}/hamlib-${HAMLIB_VERSION}.tar.gz"
LIBSERIALPORT_URL="https://sigrok.org/download/source/libserialport/libserialport-${LIBSERIALPORT_VERSION}.tar.gz"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/third_party/.cross-build-work"
OUT="$ROOT/third_party/cross"
JOBS="$(nproc 2>/dev/null || echo 2)"

TARGET="${1:-all}"

log() { echo "== $* =="; }

build_libserialport() {
  local triplet="$1" cc="$2" outname="$3"
  local src="$WORK/libserialport-$outname"
  local out="$OUT/libserialport-$outname"

  log "libserialport for $triplet -> $out"
  rm -rf "$src"
  mkdir -p "$src"
  tar xzf "$WORK/libserialport-${LIBSERIALPORT_VERSION}.tar.gz" -C "$src" --strip-components=1

  ( cd "$src" && ./configure --host="$triplet" --prefix="$out" \
      --enable-static --disable-shared CC="$cc" && make -j"$JOBS" && make install )
}

build_hamlib() {
  local triplet="$1" cc="$2" cxx="$3" outname="$4"
  local src="$WORK/hamlib-$outname"
  local out="$OUT/hamlib-$outname"

  log "hamlib for $triplet -> $out (this is the slow one, ~200 backends)"
  rm -rf "$src"
  mkdir -p "$src"
  tar xzf "$WORK/hamlib-${HAMLIB_VERSION}.tar.gz" -C "$src" --strip-components=1

  ( cd "$src" && ./configure --host="$triplet" --prefix="$out" \
      --enable-static --disable-shared \
      --without-libusb --without-readline --without-indi --without-cxx-binding \
      CC="$cc" CXX="$cxx" )

  if ( cd "$src" && make -j"$JOBS" ); then
    ( cd "$src" && make install )
  else
    # Windows-only fallback -- see file header comment. install just the
    # library + headers, which already built fine before tests/ failed.
    log "full 'make install' would need tests/ utilities that failed to link -- installing src/+include/ directly (library itself already built)"
    ( cd "$src" && make -C include install && make -C src install )
    mkdir -p "$out/lib/pkgconfig"
    cp "$src/hamlib.pc" "$out/lib/pkgconfig/"
  fi
}

mkdir -p "$WORK" "$OUT"

log "fetching sources"
[[ -f "$WORK/hamlib-${HAMLIB_VERSION}.tar.gz" ]] || curl -sL --fail -o "$WORK/hamlib-${HAMLIB_VERSION}.tar.gz" "$HAMLIB_URL"
[[ -f "$WORK/libserialport-${LIBSERIALPORT_VERSION}.tar.gz" ]] || curl -sL --fail -o "$WORK/libserialport-${LIBSERIALPORT_VERSION}.tar.gz" "$LIBSERIALPORT_URL"

if [[ "$TARGET" == "arm64" || "$TARGET" == "all" ]]; then
  build_libserialport aarch64-linux-gnu aarch64-linux-gnu-gcc arm64
  build_hamlib aarch64-linux-gnu aarch64-linux-gnu-gcc aarch64-linux-gnu-g++ arm64
fi

if [[ "$TARGET" == "win" || "$TARGET" == "all" ]]; then
  build_libserialport x86_64-w64-mingw32 x86_64-w64-mingw32-gcc-posix win
  build_hamlib x86_64-w64-mingw32 x86_64-w64-mingw32-gcc-posix x86_64-w64-mingw32-g++-posix win
fi

log "done -- static libs under $OUT"
