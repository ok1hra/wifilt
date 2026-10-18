#!/usr/bin/env bash
#
# The Paddle2IP remote CW key, end to end against the native build
# (rkey_server.h, rkey_net.h). Nothing goes on the air.
#
#   tools/rkey-native-check.sh
#
# paddle2ip's own tools/rkey_test.py plays the paddle (RKEY_TEST overrides where
# it is; default: a paddle2ip checkout next to this one). The fake radio sits in
# CW, and what it is sent over CI-V is checked:
#   - /rkey.json: listening, then the paddle's session
#   - the keyed text arrives as CI-V 0x17, word spaces included
#   - the radio's keyer speed is set to the paddle's WPM (14 0C)
#   - 20 % packet loss with 40 ms jitter changes nothing
#   - forged, modified, replayed and stale-nonce packets are all refused
#   - the settings travel in the config backup
#
# Needs no sudo: it re-runs itself in a fresh user+network namespace, where it is
# root of its own loopback and may bind ports 80-83. The namespace also keeps
# every packet off the real network.

set -uo pipefail

if [[ $(id -u) -ne 0 ]]; then
  exec unshare -rn "$0" "$@"
fi
ip link set lo up
ip link add wifilt0 type dummy && ip addr add 10.99.0.1/24 dev wifilt0 && ip link set wifilt0 up

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT/native/build/wifilt"
RKEY_TEST="${RKEY_TEST:-$ROOT/../paddle2ip/tools/rkey_test.py}"
RADIO_IP="127.0.0.2"
HTTP_PORT=8080
KEY="00112233445566778899aabbccddeeff"
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
[[ -f "$RKEY_TEST" ]] || { echo "no rkey_test.py at $RKEY_TEST -- set RKEY_TEST"; exit 1; }

python3 - "$WORK/eeprom.bin" "$KEY" <<'PYEOF'
import struct, sys
image = bytearray(b'\xff' * 424)
image[0] = 0x00                                   # APmode off
image[400] = 0x01                                 # remote CW key on, radio keyer (CI-V)
image[401:403] = struct.pack("<H", 5690)
image[403:405] = struct.pack("<H", 120)
image[405:421] = bytes.fromhex(sys.argv[2])
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

python3 "$ROOT/tools/icom-lan-fake-radio.py" --ip "$RADIO_IP" --mode 0x03 --seconds 120 -v \
  > "$WORK/radio.log" 2>&1 &
FAKE_PID=$!
sleep 1
"$BINARY" --port "$HTTP_PORT" --data-dir "$ROOT/data" --config-dir "$WORK" \
  > "$WORK/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 30); do
  sleep 1
  curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null | grep -q '"mode":"CW"' && break
done

python3 - "$HTTP_PORT" "$RKEY_TEST" "$KEY" "$WORK/radio.log" <<'PYEOF'
import json, re, subprocess, sys, time, urllib.request

http_port, rkey_test, key, radio_log = sys.argv[1:5]
HTTP = f"http://127.0.0.1:{http_port}"
checks = []
def check(name, ok, detail=""):
    checks.append((name, bool(ok)))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" -- {detail}" if detail and not ok else ""))

def get(path):
    with urllib.request.urlopen(HTTP + path, timeout=5) as r:
        return json.loads(r.read().decode() or "{}")

def paddle(*args):
    return subprocess.run([sys.executable, rkey_test, *args, "127.0.0.1", "--key", key],
                          capture_output=True, text=True, timeout=90)

def civ(cmd):
    """Bodies of the CI-V frames with this command the fake radio received."""
    out = []
    for line in open(radio_log, errors="replace"):
        m = re.search(r"<- CIV cmd=0x%02x body=([0-9a-f ]*)" % cmd, line)
        if m:
            out.append(bytes.fromhex(m.group(1).replace(" ", "")))
    return out

check("fake radio reports CW", get("/state").get("mode") == "CW")
st = get("/rkey.json")
check("/rkey.json: on, listening, radio keyer", st.get("enabled") and st.get("running")
      and st.get("output") == "civ" and not st.get("connected"), st)

TEXT = "CQ TEST DE OK1HRA"
r = paddle("send", "--text", TEXT, "--wpm", "25")
check("rkey_test.py send finished", r.returncode == 0, r.stdout + r.stderr)
check("the paddle saw a STATUS: CW mode, its own session, the radio's frequency",
      re.search(r"STATUS flags=\S*\bCW\b.* mode=0x03 f=7035920 Hz .*sess=ours", r.stdout), r.stdout)
time.sleep(0.5)
st = get("/rkey.json")
check("/rkey.json: connected peer, text decoded", st.get("peer", "").startswith("127.0.0.1:")
      and st.get("text", "").endswith(TEXT) and st.get("wpm") == 25, st)
check("no bad tags, nothing lost or undecodable",
      st.get("badTag") == 0 and st.get("lost") == 0 and st.get("undecoded") == 0, st)

sent = b"".join(civ(0x17)).decode("ascii", "replace")
check("the radio got the text as CI-V 0x17", sent == TEXT, repr(sent))
speed = civ(0x14)
check("the radio's keyer speed set to 25 WPM (14 0C 01 15)", any(b == bytes([0x0C, 0x01, 0x15]) for b in speed),
      [b.hex() for b in speed])

r = paddle("send", "--text", "5NN TU", "--wpm", "30", "--loss", "0.2", "--jitter", "40")
time.sleep(0.5)
sent = b"".join(civ(0x17)).decode("ascii", "replace")
check("20 % loss and 40 ms jitter: the next over arrives whole, without a stray space",
      r.returncode == 0 and sent == TEXT + "5NN TU", repr(sent))
TEXT += "5NN TU"

r = paddle("attack")
check("forged/modified/replayed/stale packets all refused", r.returncode == 0 and "all checks passed" in r.stdout,
      r.stdout + r.stderr)
check("and none of them keyed anything", b"".join(civ(0x17)).decode("ascii", "replace") == TEXT)

with urllib.request.urlopen(HTTP + "/config/download", timeout=5) as resp:
    raw = resp.read().decode()
backup = json.loads(raw)
check("the config backup carries the remote CW key",
      backup.get("rkeyenable") is True and backup.get("rkeykey") == key
      and backup.get("rkeyport") == 5690 and backup.get("rkeyoutput") == "civ", raw[:200])
setup = get("/setup-data.json")
check("so does /setup-data.json", setup.get("rkeykey") == key and setup.get("rkeyport") == "5690")

failed = [n for n, ok in checks if not ok]
print(("RKEY NATIVE FAIL (%d)" % len(failed)) if failed else "RKEY NATIVE PASS")
sys.exit(1 if failed else 0)
PYEOF
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  echo "--- app.log (tail) ---"; tail -30 "$WORK/app.log"
fi
exit $STATUS
