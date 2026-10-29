#!/usr/bin/env bash
#
# The real JTTY page against the real native firmware (docs/jtty-implementace.md
# §6): headless Chrome opens /jtty.html, live entry is driven with real key
# events, and it has to go out through tx.prepare/tx.extend and drain without a
# fault; then an F-key message. Nothing goes on the air -- the fake radio takes
# the audio. The browser half is tools/jtty-page-native-check.js.
#
#   tools/jtty-page-native-check.sh
#
# Needs no sudo: it re-runs itself in a fresh user+network namespace, where it is
# root of its own loopback and may bind ports 80-83 -- the AUD1 socket is fixed
# on 83, which a plain user cannot bind. The namespace also keeps every packet
# off the real network.

set -uo pipefail

if [[ $(id -u) -ne 0 ]]; then
  exec unshare -rn "$0" "$@"
fi
ip link set lo up
# The native WiFi shim reports "connected" only with a non-loopback address, and
# TrxNet does not run without it.
ip link add wifilt0 type dummy && ip addr add 10.99.0.1/24 dev wifilt0 && ip link set wifilt0 up

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT/native/build/wifilt"
RADIO_IP="127.0.0.2"
HTTP_PORT=8080
WORK="$(mktemp -d)"
FAKE_PID="" APP_PID=""

cleanup() {
  [[ -n "$APP_PID"  ]] && kill -TERM "$APP_PID"  2>/dev/null
  [[ -n "$FAKE_PID" ]] && kill -TERM "$FAKE_PID" 2>/dev/null
  wait "$APP_PID" "$FAKE_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

[[ -x "$BINARY" ]] || { echo "no native build -- make -C native first"; exit 1; }

python3 - "$WORK/eeprom.bin" <<'PYEOF'
import sys
image = bytearray(b'\xff' * 360)
image[0] = 0x00                                   # APmode off
open(sys.argv[1], "wb").write(bytes(image))
PYEOF

cat > "$WORK/radio-config.json" <<EOF
{"version":1,
 "trx1":{"enabled":true,"connection":"lan","civaddr":"A4","netid":"FF",
         "lanip":"$RADIO_IP","lanuser":"tester","lanpass":"secret","model":""},
 "trx2":{"enabled":false,"connection":"trxnet","civaddr":"00","netid":"FF",
         "lanip":"","lanuser":"","lanpass":"","model":""},
 "trx3":{"enabled":false,"connection":"trxnet","civaddr":"00","netid":"FF",
         "lanip":"","lanuser":"","lanpass":"","model":""}}
EOF

python3 "$ROOT/tools/icom-lan-fake-radio.py" --ip "$RADIO_IP" --mode 0x01 --seconds 120 \
  > "$WORK/radio.log" 2>&1 &
FAKE_PID=$!
sleep 1
"$BINARY" --port "$HTTP_PORT" --data-dir "$ROOT/data" --config-dir "$WORK" \
  > "$WORK/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 30); do
  sleep 1
  curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null | grep -q '"connected":true' && break
done

curl -s -m 3 -X POST -H 'Content-Type: application/json' -d '{"call":"OK1HRA","grid":"JO70"}' \
  "http://127.0.0.1:$HTTP_PORT/identity" > /dev/null
node --experimental-websocket "$ROOT/tools/jtty-page-native-check.js" "$HTTP_PORT" "$WORK/app.log" 2>&1 | grep -v ExperimentalWarning
STATUS=${PIPESTATUS[0]}
if [[ $STATUS -ne 0 ]]; then
  echo "--- app.log (AUD1) ---"; grep -E 'AUD1|LAN \|' "$WORK/app.log" | tail -30
fi
exit $STATUS
