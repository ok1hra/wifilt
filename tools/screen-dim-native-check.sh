#!/usr/bin/env bash
#
# IC-705 screen dimming by mode, end to end against the native build
# (screen_dim.h, /state "scr", /cmd "screen", EEPROM 242-245 + 423). Nothing
# goes on the air.
#
#   tools/screen-dim-native-check.sh
#
# The fake radio keeps SET > Display 1A 05 01 36..39 and a mode the test turns
# through --mode-file. Checked:
#   - USB: icon "normal", nothing written to the radio
#   - USB-D: dimmed (backlight 0, auto off, saver 1 min / 1 min), originals in EEPROM
#   - QRPlog in front (/state?scrhold=1 polls): normal while it polls, "qrplog"
#     in /state; dark again once the polls stop and the hold lapses
#   - a reboot while dimmed: still dark, originals still in EEPROM
#   - CW: the originals written back, EEPROM slot cleared
#   - the icon in CW: dims, the choice lands in EEPROM 423; and back
#   - an IC-7610: no "scr" in /state, /cmd screen refused
#
# Needs no sudo: it re-runs itself in a fresh user+network namespace.

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

write_config() {   # $1 = CI-V address
  cat > "$WORK/radio-config.json" <<EOF
{"version":1,
 "trx1":{"enabled":true,"connection":"lan","civaddr":"$1","netid":"FF",
         "lanip":"$RADIO_IP","lanuser":"tester","lanpass":"secret","model":"","localtrx":false},
 "trx2":{"enabled":false,"connection":"trxnet","civaddr":"00","netid":"FF",
         "lanip":"","lanuser":"","lanpass":"","model":""},
 "trx3":{"enabled":false,"connection":"trxnet","civaddr":"00","netid":"FF",
         "lanip":"","lanuser":"","lanpass":"","model":""}}
EOF
}

start_radio() {   # $1 = CI-V address
  python3 "$ROOT/tools/icom-lan-fake-radio.py" --ip "$RADIO_IP" --civ "$1" \
    --mode-file "$WORK/mode" --seconds 200 -v > "$WORK/radio.log" 2>&1 &
  FAKE_PID=$!
  sleep 1
}

start_app() {
  "$BINARY" --port "$HTTP_PORT" --data-dir "$ROOT/data" --config-dir "$WORK" \
    >> "$WORK/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null | grep -q '"lanStatus":"linked"' && break
  done
}

stop_app() {
  kill -TERM "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""
}
stop_all() {
  stop_app
  kill -TERM "$FAKE_PID" 2>/dev/null; wait "$FAKE_PID" 2>/dev/null; FAKE_PID=""
}

CHECK_PY="$WORK/check.py"
cat > "$CHECK_PY" <<'PYEOF'
import json, re, sys, time, urllib.request, urllib.error

HTTP = "http://127.0.0.1:8080"
WORK = sys.argv[1]
step = sys.argv[2]
checks = []
def check(name, ok, detail=""):
    checks.append(bool(ok))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" -- {detail}" if detail and not ok else ""))

def state():
    with urllib.request.urlopen(HTTP + "/state", timeout=5) as r:
        return json.loads(r.read().decode())

def screen(dim):
    req = urllib.request.Request(HTTP + "/cmd", method="POST",
                                 data=json.dumps({"type": "screen", "dim": dim}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def wait_for(pred, seconds):
    end, last = time.time() + seconds, {}
    while time.time() < end:
        try:
            last = state()
            if pred(last):
                return last
        except Exception:
            pass
        time.sleep(0.5)
    return last

def display():
    # The fake radio's SET > Display as its log last wrote it, from the start value.
    value = {"36": "01 28", "37": "01", "38": "04", "39": "00"}
    for m in re.finditer(r"-- Display 01 (3[6-9]) = ([0-9a-f ]+)", open(WORK + "/radio.log").read(), re.I):
        value[m.group(1)] = m.group(2).strip().lower()
    return value

def writes():
    return len(re.findall(r"-- Display 01", open(WORK + "/radio.log").read()))

def eeprom(at, n=1):
    return list(open(WORK + "/eeprom.bin", "rb").read()[at:at + n])

def set_mode(mode, data):
    open(WORK + "/mode", "w").write(f"{mode} {data}\n")

ORIGINAL = {"36": "01 28", "37": "01", "38": "04", "39": "00"}
DARK = {"36": "00 00", "37": "00", "38": "01", "39": "01"}

if step == "first":
    s = wait_for(lambda s: s.get("scr") == "normal", 15)
    check("USB: scr normal", s.get("scr") == "normal", s)
    time.sleep(4)
    check("USB: nothing written to the radio", writes() == 0, writes())
    set_mode("0x01", 1)
    s = wait_for(lambda s: s.get("mode") == "USB-D", 10)
    check("/state mode follows to USB-D", s.get("mode") == "USB-D", s.get("mode"))
    s = wait_for(lambda s: s.get("scr") == "dark" and display() == DARK, 15)
    check("USB-D: dimmed", s.get("scr") == "dark" and display() == DARK, (s.get("scr"), display()))
    check("USB-D: originals in EEPROM 242-245", eeprom(242, 4) == [128, 1, 4, 0], eeprom(242, 4))
    # QRPlog in front: its poll carries ?scrhold=1 every 5 s.
    def hold_poll():
        with urllib.request.urlopen(HTTP + "/state?scrhold=1", timeout=5) as r:
            return json.loads(r.read().decode())
    end, held = time.time() + 12, {}
    while time.time() < end:
        held = hold_poll()
        if held.get("scr") == "qrplog" and display() == ORIGINAL:
            break
        time.sleep(1)
    check("QRPlog in front: restored, scr qrplog", held.get("scr") == "qrplog" and display() == ORIGINAL,
          (held.get("scr"), display()))
    for _ in range(4):                               # keeps holding while it polls
        time.sleep(4); held = hold_poll()
    check("QRPlog keeps it normal while it polls", held.get("scr") == "qrplog" and display() == ORIGINAL,
          (held.get("scr"), display()))
    s = wait_for(lambda s: s.get("scr") == "dark" and display() == DARK, 30)
    check("QRPlog gone: dark again after the hold lapses", s.get("scr") == "dark" and display() == DARK,
          (s.get("scr"), display()))
elif step == "reboot":
    w = writes()
    s = wait_for(lambda s: s.get("scr") == "dark", 15)
    time.sleep(6)
    check("reboot: still dark, originals kept",
          state().get("scr") == "dark" and display() == DARK and eeprom(242, 4) == [128, 1, 4, 0],
          (display(), eeprom(242, 4)))
    set_mode("0x03", 0)
    s = wait_for(lambda s: s.get("scr") == "normal" and display() == ORIGINAL, 15)
    check("CW: originals written back", display() == ORIGINAL and s.get("scr") == "normal", (s.get("scr"), display()))
    time.sleep(1)
    check("CW: EEPROM slot cleared", eeprom(243) == [0xff], eeprom(242, 4))
    code, body = screen(True)
    check("icon in CW accepted", code == 200, (code, body))
    s = wait_for(lambda s: s.get("scr") == "dark" and display() == DARK, 10)
    check("icon in CW: dimmed", display() == DARK, display())
    check("icon in CW: choice in EEPROM 423 (digital + others)", eeprom(423) == [3], eeprom(423))
    code, body = screen(False)
    s = wait_for(lambda s: s.get("scr") == "normal" and display() == ORIGINAL, 10)
    check("icon in CW again: back to normal", display() == ORIGINAL and eeprom(423) == [1], (display(), eeprom(423)))
elif step == "ic7610":
    s = wait_for(lambda s: s.get("radioPower") == "on", 15)
    check("IC-7610: no scr in /state", s.get("radioPower") == "on" and "scr" not in s, s)
    code, body = screen(True)
    check("IC-7610: /cmd screen refused", code == 409 and body.get("error") == "unsupported", (code, body))

sys.exit(0 if all(checks) else 1)
PYEOF

STATUS=0
echo "0x01 0" > "$WORK/mode"
write_config A4
start_radio 0xA4
start_app
python3 "$CHECK_PY" "$WORK" first || STATUS=1
stop_app
start_app
python3 "$CHECK_PY" "$WORK" reboot || STATUS=1
stop_all

write_config 98
start_radio 0x98
start_app
python3 "$CHECK_PY" "$WORK" ic7610 || STATUS=1

if [[ $STATUS -ne 0 ]]; then
  echo "--- app.log (SCR) ---"; grep -a "SCR|" "$WORK/app.log" | tail -20
  echo "--- radio.log (tail) ---"; grep -a -- "-- " "$WORK/radio.log" | tail -20
fi
stop_all
echo $([[ $STATUS -eq 0 ]] && echo "SCREEN DIM NATIVE PASS" || echo "SCREEN DIM NATIVE FAIL")
exit $STATUS
