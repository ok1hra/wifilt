#!/usr/bin/env sh
# The prototype gates exercise their own copy of two production runtimes. Those
# copies are maintained by hand, so a production edit that is not mirrored makes
# every gate green while testing dead code. Fail loudly instead.
#
# Only genuinely byte-identical pairs belong here. transport/aud1_websocket_session.js
# and transport/ws_audio_source.js are deliberately NOT listed: production has
# grown past them (clientUtcMs, configure/observeDecode/confirmClock) and they
# are kept as an older isolated fork.
set -eu
prototype_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(CDPATH= cd -- "$prototype_dir/../.." && pwd)

status=0
check() {
  if ! cmp -s "$1" "$2"; then
    echo "RUNTIME SYNC FAIL: $1 differs from $2" >&2
    diff -u "$1" "$2" | head -40 >&2
    status=1
  fi
}

check "$prototype_dir/tx/tx_runtime.js"             "$repository_dir/data/js8-tx.js"
check "$prototype_dir/protocol/protocol_runtime.js" "$repository_dir/data/js8-protocol.js"

if [ "$status" -ne 0 ]; then
  echo "RUNTIME SYNC FAIL: copy the production file over the prototype one" >&2
  exit 1
fi
echo "RUNTIME SYNC PASS tx_runtime.js protocol_runtime.js"
