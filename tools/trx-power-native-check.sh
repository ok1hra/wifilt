#!/usr/bin/env bash
#
# Wake / standby / power off of the LAN radio, end to end against the native
# build (trx_power.h, /cmd "power", /state radioPower). Nothing goes on the air.
#
#   tools/trx-power-native-check.sh
#
# The fake radio drops into remote-control standby a few seconds after login,
# exactly as an IC-705 switched off with "Power OFF Setting (for Remote
# Control) = Standby/Shutdown". Checked:
#   - /state: radioPower on -> standby, pwrCtl for the IC-705
#   - wake: 18 01, the radio boots, radioPower back to on
#   - standby: the menu written to Standby/Shutdown and read back, then 18 00
#   - power off: the menu written to Shutdown only, 18 00, the session dies;
#     a wake is then refused ("offline")
#   - local-trx: no power fields in /state, /cmd power refused
#
# Needs no sudo: it re-runs itself in a fresh user+network namespace, where it is
# root of its own loopback and may bind ports 80-83.

set -uo pipefail

if [[ $(id -u) -ne 0 ]]; then
  exec unshare -rn "$0" "$@"
fi
ip link set lo up
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
image = bytearray(b'\xff' * 424)
image[0] = 0x00                                   # APmode off
image[400] = 0x00                                 # remote CW key off
open(sys.argv[1], "wb").write(bytes(image))
PYEOF

write_config() {   # $1 = localtrx true|false
  cat > "$WORK/radio-config.json" <<EOF
{"version":1,
 "trx1":{"enabled":true,"connection":"lan","civaddr":"A4","netid":"FF",
         "lanip":"$RADIO_IP","lanuser":"tester","lanpass":"secret","model":"","localtrx":$1},
 "trx2":{"enabled":false,"connection":"trxnet","civaddr":"00","netid":"FF",
         "lanip":"","lanuser":"","lanpass":"","model":""},
 "trx3":{"enabled":false,"connection":"trxnet","civaddr":"00","netid":"FF",
         "lanip":"","lanuser":"","lanpass":"","model":""}}
EOF
}

start() {
  python3 "$ROOT/tools/icom-lan-fake-radio.py" --ip "$RADIO_IP" --standby-at "$1" --seconds 150 -v \
    > "$WORK/radio.log" 2>&1 &
  FAKE_PID=$!
  sleep 1
  "$BINARY" --port "$HTTP_PORT" --data-dir "$ROOT/data" --config-dir "$WORK" \
    > "$WORK/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null | grep -q '"lanStatus":"linked"' && break
  done
}

stop() {
  kill -TERM "$APP_PID" "$FAKE_PID" 2>/dev/null
  wait "$APP_PID" "$FAKE_PID" 2>/dev/null
  APP_PID="" FAKE_PID=""
}

write_config false
start 6

python3 - "$HTTP_PORT" "$WORK/radio.log" <<'PYEOF'
import json, re, sys, time, urllib.request, urllib.error

http_port, radio_log = sys.argv[1:3]
HTTP = f"http://127.0.0.1:{http_port}"
checks = []
def check(name, ok, detail=""):
    checks.append((name, bool(ok)))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" -- {detail}" if detail and not ok else ""))

def state():
    with urllib.request.urlopen(HTTP + "/state", timeout=5) as r:
        return json.loads(r.read().decode())

def power(target):
    req = urllib.request.Request(HTTP + "/cmd", method="POST",
                                 data=json.dumps({"type": "power", "state": target}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def wait_for(pred, seconds):
    end = time.time() + seconds
    last = {}
    while time.time() < end:
        try:
            last = state()
            if pred(last):
                return last
        except Exception:
            pass
        time.sleep(0.5)
    return last

def radio_log_has(text):
    return text in open(radio_log, errors="replace").read()

s = wait_for(lambda s: s.get("radioPower") == "on", 10)
check("/state: radioPower on, pwrCtl for the IC-705, no op",
      s.get("radioPower") == "on" and s.get("pwrCtl") is True and s.get("powerOp") == "", s)
s = wait_for(lambda s: s.get("radioPower") == "standby", 20)
check("radio drops to standby: radioPower standby, session still linked",
      s.get("radioPower") == "standby" and s.get("lanStatus") == "linked", s)

code, body = power("on")
check("wake accepted", code == 200 and body.get("ok"), (code, body))
s = state()
check("powerOp says wake while it boots", s.get("powerOp") == "wake", s)
s = wait_for(lambda s: s.get("radioPower") == "on" and s.get("powerOp") == "", 30)
check("radio woke: radioPower on", s.get("radioPower") == "on" and s.get("powerOp") == "", s)
check("the radio got 18 01", radio_log_has("-- 18 01: booting"))

code, body = power("standby")
check("standby accepted", code == 200, (code, body))
s = wait_for(lambda s: s.get("radioPower") == "standby" and s.get("powerOp") == "", 25)
check("radio in standby again", s.get("radioPower") == "standby" and s.get("powerOp") == "", s)
check("menu written to Standby/Shutdown before 18 00",
      radio_log_has("Power OFF Setting = Standby/Shutdown") and radio_log_has("-- radio STANDBY"))

code, body = power("off")
check("power off from standby accepted", code == 200, (code, body))
s = wait_for(lambda s: s.get("radioPower") == "off" or s.get("powerOp", "").startswith("failed"), 60)
check("radio shut down: radioPower off", s.get("radioPower") == "off", s)
check("woken first, menu set to Shutdown only, then 18 00",
      radio_log_has("Power OFF Setting = Shutdown only") and radio_log_has("radio SHUTDOWN"))

code, body = power("on")
check("wake after a shutdown refused: offline", code == 409 and body.get("error") == "offline", (code, body))
code, body = power("sideways")
check("unknown target refused", code == 409 and body.get("error") == "invalid_state", (code, body))

failed = [n for n, ok in checks if not ok]
print(("TRX POWER NATIVE FAIL (%d)" % len(failed)) if failed else "TRX POWER NATIVE PASS")
sys.exit(1 if failed else 0)
PYEOF
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  echo "--- app.log (tail) ---"; tail -30 "$WORK/app.log"
  echo "--- radio.log (tail) ---"; tail -30 "$WORK/radio.log"
fi
stop

# local-trx: the same LAN radio, but marked LOCAL-TRX in SETUP.
write_config true
start 0
python3 - "$HTTP_PORT" <<'PYEOF'
import json, sys, urllib.request, urllib.error
HTTP = f"http://127.0.0.1:{sys.argv[1]}"
with urllib.request.urlopen(HTTP + "/state", timeout=5) as r:
    s = json.loads(r.read().decode())
ok1 = s.get("lanStatus") == "linked" and "radioPower" not in s and "powerOp" not in s
print(f"  {'ok  ' if ok1 else 'FAIL'} local-trx: no power fields in /state")
req = urllib.request.Request(HTTP + "/cmd", method="POST",
                             data=b'{"type":"power","state":"on"}',
                             headers={"Content-Type": "application/json"})
try:
    urllib.request.urlopen(req, timeout=5)
    code, body = 200, {}
except urllib.error.HTTPError as e:
    code, body = e.code, json.loads(e.read().decode() or "{}")
ok2 = code == 409 and body.get("error") == "unsupported"
print(f"  {'ok  ' if ok2 else 'FAIL'} local-trx: /cmd power refused as unsupported")
sys.exit(0 if ok1 and ok2 else 1)
PYEOF
STATUS2=$?
[[ $STATUS -eq 0 && $STATUS2 -eq 0 ]]
