#!/usr/bin/env sh
set -eu
prototype_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_dir="$prototype_dir/build"
cmake -S "$prototype_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$build_dir" --target js8-aud1-ws-parser-smoke --parallel >/dev/null
exec "$build_dir/js8-aud1-ws-parser-smoke"
