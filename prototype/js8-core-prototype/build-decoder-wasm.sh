#!/usr/bin/env sh
set -eu

prototype_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(CDPATH= cd -- "$prototype_dir/../.." && pwd)
deps_dir="$prototype_dir/build-wasm-deps"
fftw_dir="$deps_dir/fftw3-3.3.10"
output_dir="$prototype_dir/build-decoder-wasm"
native_build_dir="$prototype_dir/build"
run_smoke=true

if [ "${1:-}" = "--build-only" ]; then
  run_smoke=false
  shift
fi

if [ "$run_smoke" = true ] && { [ "$#" -lt 2 ] || [ $(( $# % 2 )) -ne 0 ]; }; then
  echo "usage: $0 [--build-only] [WAV SUBMODE ...]" >&2
  exit 2
fi

command -v emconfigure >/dev/null
command -v emmake >/dev/null
command -v em++ >/dev/null
command -v node >/dev/null
test -d /usr/include/boost

mkdir -p "$deps_dir" "$output_dir" "$deps_dir/include"

# FFTW is statically linked into js8-decoder.wasm, which we distribute, so its
# source is part of our Corresponding Source under GPLv2 section 3. It is
# therefore vendored in the repository rather than fetched: `apt-get source`
# needed the network, a Debian mirror and deb-src entries, and its checksum gate
# was skipped entirely whenever the archive was absent -- which was every clean
# build. The tarball here is byte-identical to Debian's fftw3 3.3.10-1 orig.
fftw_archive="$repository_dir/third_party/fftw/fftw3_3.3.10.orig.tar.gz"
expected_fftw_sha=56c932549852cddcfafdab3820b0200c7742675be92179e59e6215b340e26467

[ -f "$fftw_archive" ] || {
  echo "ERROR: vendored FFTW source missing: $fftw_archive" >&2
  exit 1
}
actual_fftw_sha=$(sha256sum "$fftw_archive" | awk '{print $1}')
if [ "$actual_fftw_sha" != "$expected_fftw_sha" ]; then
  echo "ERROR: unexpected FFTW source archive: $actual_fftw_sha" >&2
  exit 1
fi

# The archive's own root is fftw-3.3.10; $fftw_dir keeps the fftw3-3.3.10 name
# `apt-get source` used to produce, so the strip is what makes the two agree.
if [ ! -d "$fftw_dir" ]; then
  mkdir -p "$fftw_dir"
  tar xzf "$fftw_archive" -C "$fftw_dir" --strip-components=1
fi

if [ ! -f "$fftw_dir/.libs/libfftw3f.a" ]; then
  (cd "$fftw_dir" && emconfigure ./configure \
    --host=wasm32 --enable-float --disable-shared --enable-static \
    --disable-fortran --disable-threads --disable-openmp >/dev/null)
  (cd "$fftw_dir" && emmake make -j4 libfftw3f.la >/dev/null)
fi

ln -sfn /usr/include/boost "$deps_dir/include/boost"

cmake -S "$prototype_dir" -B "$native_build_dir" \
  -DCMAKE_BUILD_TYPE=Release >/dev/null

generated="$native_build_dir/generated/js8_reference_core.cpp"
common_flags="-std=c++20 -O3 -I$deps_dir/include -I$fftw_dir/api -I$prototype_dir/decoder_shim -I$repository_dir/JS8Call-improved-master -I$repository_dir/JS8Call-improved-master/JS8_Mode"

# shellcheck disable=SC2086
em++ $common_flags -c "$generated" -o "$output_dir/reference.o"
# shellcheck disable=SC2086
em++ $common_flags -c \
  "$repository_dir/JS8Call-improved-master/JS8_Mode/FrequencyTracker.cpp" \
  -o "$output_dir/frequency.o"
# shellcheck disable=SC2086
em++ $common_flags -c "$prototype_dir/decoder_shim/qt_shim.cpp" \
  -o "$output_dir/shim.o"
# shellcheck disable=SC2086
em++ $common_flags -I"$prototype_dir/wasm" -c \
  "$prototype_dir/wasm/decoder_wasm_api.cpp" -o "$output_dir/wasm-api.o"

em++ -O3 "$output_dir/reference.o" "$output_dir/frequency.o" \
  "$output_dir/shim.o" "$output_dir/wasm-api.o" \
  "$fftw_dir/.libs/libfftw3f.a" \
  --no-entry -sMODULARIZE=1 -sEXPORT_NAME=createJs8DecoderProbe \
  -sENVIRONMENT=node,web,worker -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=41943040 -sFILESYSTEM=0 \
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_js8_wasm_decoder_create','_js8_wasm_decoder_destroy','_js8_wasm_decoder_run','_js8_wasm_decoder_next_event']" \
  -o "$output_dir/js8-decoder.js"

raw_bytes=$(wc -c < "$output_dir/js8-decoder.wasm")
gzip_bytes=$(gzip -9 -c "$output_dir/js8-decoder.wasm" | wc -c)
js_bytes=$(wc -c < "$output_dir/js8-decoder.js")
echo "DECODER WASM raw_bytes=$raw_bytes gzip_bytes=$gzip_bytes js_bytes=$js_bytes"

if [ "$run_smoke" = true ]; then
  node "$prototype_dir/wasm/decoder_smoke.js" \
    "$output_dir/js8-decoder.js" "$@"
fi
