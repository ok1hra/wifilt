#!/usr/bin/env bash
#
# End-to-end test of the native build, with no radio and nothing on the air.
#
# Starts the fake ICOM radio, starts the binary pointed at it, and asserts the
# whole chain works: the RS-BA1 handshake, CI-V reaching /state as a frequency,
# and -- when ports below 1024 can be bound -- the AUD1 audio WebSocket carrying
# an intact tone.
#
# This is what makes "CI builds both targets" mean something. CI has no IC-705,
# so without a fake one the entire LAN and audio path would be untested on every
# commit, which is exactly where a one-source port quietly rots.
#
#   tools/native-integration-test.sh
#
# Exit 0 on success. Skips the audio half (and says so) when the binary lacks
# CAP_NET_BIND_SERVICE, because port 83 cannot be bound without it.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT/native/build/wifilt"
RADIO_IP="127.0.0.2"        # not .1: the client binds local port 50001 itself
HTTP_PORT=8080
WORK="$(mktemp -d)"
FAKE_PID=""
DXC_PID=""
APP_PID=""
FAILURES=0

# SIGTERM, not SIGKILL: the binary handles it and shuts down cleanly, which also
# keeps the shell from printing a "Killed" line over the test result.
cleanup() {
  [[ -n "$APP_PID"  ]] && kill -TERM "$APP_PID"  2>/dev/null
  [[ -n "$FAKE_PID" ]] && kill -TERM "$FAKE_PID" 2>/dev/null
  [[ -n "$DXC_PID"  ]] && kill -TERM "$DXC_PID"  2>/dev/null
  wait "$APP_PID" "$FAKE_PID" "$DXC_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

check() {
  local name="$1" ok="$2"
  if [[ "$ok" == "1" ]]; then
    echo "  ok   $name"
  else
    echo "  FAIL $name"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "== building =="
make -C "$ROOT/native" >/dev/null || { echo "build failed"; exit 1; }

# The capability lives on the inode, so the build above just dropped it. Ports
# 80, 82 and 83 are all privileged and 83 carries the audio. Re-granting is
# attempted silently: it succeeds on CI (passwordless sudo) and is skipped on a
# workstation, where the audio half then reports itself as skipped rather than
# failing for a reason that has nothing to do with the code.
sudo -n setcap cap_net_bind_service=+ep "$BINARY" 2>/dev/null || true

# A fresh EEPROM image is all 0xFF, which the sketch reads as "start in AP mode".
# Byte 0 = 0 selects station mode. The DX-cluster fields follow the byte map
# documented at the top of wifilt.ino.
python3 - "$WORK/eeprom.bin" <<'PYEOF'
import struct, sys
image = bytearray(b'\xff' * 360)
image[0] = 0x00                                   # APmode off
host = b"127.0.0.1"
image[137:137 + len(host)] = host                 # 137-200 DXC host
struct.pack_into("<H", image, 201, 7300)          # 201-202 DXC port
call = b"OK1TEST"
image[203:203 + len(call)] = call                 # 203-218 DXC callsign
grid = b"JN79NX"
image[219:219 + len(grid)] = grid                 # 219-224 DXC locator
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

echo "== starting fake radio on $RADIO_IP =="
python3 "$ROOT/tools/icom-lan-fake-radio.py" --ip "$RADIO_IP" --seconds 120 \
  > "$WORK/radio.log" 2>&1 &
FAKE_PID=$!

echo "== starting fake DX cluster =="
python3 "$ROOT/tools/dxc-fake-cluster.py" --port 7300 --interval 1 --seconds 120 \
  > "$WORK/cluster.log" 2>&1 &
DXC_PID=$!
sleep 1

echo "== starting wifilt =="
"$BINARY" --port "$HTTP_PORT" --data-dir "$ROOT/data" --config-dir "$WORK" \
  > "$WORK/app.log" 2>&1 &
APP_PID=$!

echo "== waiting for the radio link =="
FREQ=0
for _ in $(seq 1 30); do
  sleep 1
  FREQ=$(curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null \
         | sed -n 's/.*"frequency":\([0-9]*\).*/\1/p')
  [[ "${FREQ:-0}" == "7035920" ]] && break
done

echo
echo "== results =="
check "HTTP answers /state"            "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/state" | grep -q 200 && echo 1 || echo 0)"
check "static assets served"           "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/setup" | grep -q 200 && echo 1 || echo 0)"
check "gzip content negotiation"       "$(curl -s -m 5 -I -H 'Accept-Encoding: gzip' "http://127.0.0.1:$HTTP_PORT/data.js" | grep -qi 'content-encoding: gzip' && echo 1 || echo 0)"
check "platform reported as pc"        "$(curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/setup-data.json" | grep -q '"platform":"pc"' && echo 1 || echo 0)"
check "RS-BA1 handshake completed"     "$(grep -q '^CONNECTED' "$WORK/radio.log" && echo 1 || echo 0)"
check "CI-V frequency reached /state"  "$([[ "${FREQ:-0}" == "7035920" ]] && echo 1 || echo 0)"

# TrxNet peer discovery, both directions: the device announces itself, and a
# hand-built announce has to land in its peer table. The packet layout is the
# one TrxNet::_sendDiscovery writes -- magic, version, type, name, port.
TRXNET_OK=$(python3 - "$HTTP_PORT" <<'PYEOF'
import socket, struct, sys, time, urllib.request
name = b"705.42"
packet = bytes([0xAA, 0x01, 0x02, len(name)]) + name + struct.pack(">H", 5683)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
sock.sendto(packet, ("127.0.0.1", 5683))
time.sleep(3)
try:
    body = urllib.request.urlopen(
        f"http://127.0.0.1:{sys.argv[1]}/trxnet-peers.json", timeout=5).read().decode()
    print("1" if b"705.42".decode() in body else "0")
except Exception:
    print("0")
PYEOF
)
check "TrxNet registers a peer"        "$TRXNET_OK"

# The "Audio WS server started" line is printed unconditionally by the sketch --
# begin() returns void, so it says that whether or not the bind worked. The only
# reliable signal is the failure the shim reports, which is why it reports one.
if ! grep -q "port 83: BIND FAILED" "$WORK/app.log"; then
  echo
  echo "== audio websocket =="
  if python3 "$ROOT/tools/aud1-ws-check.py" --http "http://127.0.0.1:$HTTP_PORT" \
       --seconds 5 --expect-hz 1000; then
    check "AUD1 stream intact" 1
  else
    check "AUD1 stream intact" 0
  fi
else
  echo
  echo "  SKIP audio websocket -- port 83 not bound"
  echo "       run: sudo make -C native setcap   (needed again after every build)"
fi

# The telnet link is opened lazily: DxcLoop() returns while no browser is
# attached, so nothing reaches the cluster until this connects.
if ! grep -q "port 82: BIND FAILED" "$WORK/app.log"; then
  echo
  echo "== dx cluster relay =="
  if python3 "$ROOT/tools/dxc-ws-check.py" --seconds 10; then
    check "DXC relay carries spots" 1
  else
    check "DXC relay carries spots" 0
  fi
  check "firmware logged in to the cluster" \
        "$(grep -q '^login' "$WORK/cluster.log" && echo 1 || echo 0)"
else
  echo
  echo "  SKIP dx cluster relay -- port 82 not bound (same setcap)"
fi

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "NATIVE INTEGRATION PASS"
  exit 0
fi
echo "NATIVE INTEGRATION FAIL ($FAILURES)"
echo "--- app log ---";   tail -25 "$WORK/app.log"
echo "--- radio log ---"; tail -25 "$WORK/radio.log"
exit 1
