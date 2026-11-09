#!/usr/bin/env bash
#
# The radio's TX buffer, adapted to the jitter measured on the RX audio
# (lan_jitter.h, wifilt.ino lanTxBufferTick), against the real native firmware
# and the fake radio with --rx-stall (Wi-Fi style stalls and bursts). The checks
# are in tools/lan-txbuffer-native-check.py.
#
#   tools/lan-txbuffer-native-check.sh                     IC-705 (Wi-Fi): adapts
#   RADIO_NAME=IC-7610 tools/lan-txbuffer-native-check.sh  a wired radio: stays 150
#
# Needs no sudo: it re-runs itself in a fresh user+network namespace (ports
# 80-83, and no packet leaves the machine).
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

python3 "$ROOT/tools/icom-lan-fake-radio.py" --ip "$RADIO_IP" --mode 0x01 --seconds 200 --rx-stall 200 --name "${RADIO_NAME:-IC-705}" \
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

python3 "$ROOT/tools/lan-txbuffer-native-check.py" "$HTTP_PORT" "$WORK/radio.log" "$WORK" "$WORK/app.log" ${RADIO_NAME:+wired}
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  echo "--- app.log (AUD1/LAN) ---"; grep -E 'AUD1|LAN \||AUD \|' "$WORK/app.log" | tail -40
  echo "--- radio.log ---"; tail -20 "$WORK/radio.log"
fi
exit $STATUS
