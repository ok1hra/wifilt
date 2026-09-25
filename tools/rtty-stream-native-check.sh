#!/usr/bin/env bash
#
# The RTTY text stream on TrxNet, end to end against the native build
# (rtty_stream.h, grilled 2026-09-25). Nothing goes on the air.
#
#   tools/rtty-stream-native-check.sh
#
# The fake radio sits in RTTY; tools/rtty-stream-listen.py subscribes the way a
# real analyser would, and what reaches it is checked:
#   - the switch is off by default, and a subscription is then ignored
#   - on: /s-rtty registers the listener, /rtty-stream.json names it
#   - decoded text over the AUD1 socket (rtty.stream) -> /rtty1 and /rtty2
#   - an AFSK transmission's text (tx.prepare rttyText) -> /rtty-tx, and its
#     abort -> [seq][0x00]
#   - an FSK transmission (/cmd sendCw in RTTY) -> /rtty-tx, from the firmware
#   - /s-rtty 0 ends it
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

python3 "$ROOT/tools/icom-lan-fake-radio.py" --ip "$RADIO_IP" --mode 0x04 --seconds 120 \
  > "$WORK/radio.log" 2>&1 &
FAKE_PID=$!
sleep 1
"$BINARY" --port "$HTTP_PORT" --data-dir "$ROOT/data" --config-dir "$WORK" \
  > "$WORK/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 30); do
  sleep 1
  curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null | grep -q '"mode":"RTTY"' && break
done

python3 - "$ROOT" "$HTTP_PORT" <<'PYEOF'
import base64, hashlib, json, os, socket, subprocess, sys, time, urllib.request, urllib.parse

root, http_port = sys.argv[1], sys.argv[2]
HTTP = f"http://127.0.0.1:{http_port}"
checks = []
def check(name, ok, detail=""):
    checks.append((name, bool(ok)))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" -- {detail}" if detail and not ok else ""))

def get(path):
    with urllib.request.urlopen(HTTP + path, timeout=5) as r:
        return json.loads(r.read().decode() or "{}")
def post(path, form=None, body=None, ctype="application/x-www-form-urlencoded"):
    data = body if body is not None else urllib.parse.urlencode(form or {}).encode()
    req = urllib.request.Request(HTTP + path, data=data, headers={"Content-Type": ctype}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read().decode()

def listener(seconds):
    return subprocess.Popen([sys.executable, f"{root}/tools/rtty-stream-listen.py",
        "--target", "127.0.0.1:5683", "--port", "5690", "--json", "--seconds", str(seconds)],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

state = get("/state")
check("fake radio reports RTTY", state.get("mode") == "RTTY", state.get("mode"))

# ---- off by default: the subscription is ignored ---------------------------
check("the switch is off by default", get("/log-config").get("rttyStream") is not True)
off = listener(4)
time.sleep(3)
check("an off switch ignores a subscription", get("/rtty-stream.json").get("subs") == [])
off.wait()

# ---- on ---------------------------------------------------------------------
post("/log-config/rtty-stream", {"rttyStream": "1"})
check("the switch is stored", get("/log-config").get("rttyStream") is True)
lis = listener(14)
subs = []
for _ in range(20):
    time.sleep(0.25)
    subs = get("/rtty-stream.json").get("subs", [])
    if subs: break
check("/s-rtty registers the listener", [s["name"] for s in subs] == ["RTTYMON.01"], subs)
check("with the 90 s lease", subs and 85 <= subs[0]["expiresS"] <= 90, subs)

# ---- AUD1: decoded text and an AFSK transmission ----------------------------
token = base64.b16encode(os.urandom(8)).decode().lower()
post("/js8/session/claim", body=json.dumps({"token": token, "role": "rtty"}).encode(), ctype="application/json")
key = base64.b64encode(os.urandom(16)).decode()
ws = socket.create_connection(("127.0.0.1", 83), timeout=6)
ws.sendall((f"GET /audiows?token={token} HTTP/1.1\r\nHost: 127.0.0.1:83\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
head = b""
while b"\r\n\r\n" not in head:
    head += ws.recv(4096)
check("AUD1 socket upgraded", b" 101 " in head.split(b"\r\n")[0], head[:60])

def send_text(obj):
    payload = json.dumps(obj).encode()
    mask = os.urandom(4)
    frame = bytearray([0x81])
    if len(payload) < 126: frame.append(0x80 | len(payload))
    else: frame += bytes([0x80 | 126]) + len(payload).to_bytes(2, "big")
    frame += mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    ws.sendall(frame)

time.sleep(0.5)
send_text({"type": "rtty.stream", "r1": "CQ TEST DE", "r2": "CQ TEXT DE"})
send_text({"type": "rtty.stream", "r1": " OK1HRA\r\n", "r2": ""})
now = int(time.time() * 1000)
send_text({"type": "tx.prepare", "txId": 7, "sampleRate": 48000, "samples": 48000, "packets": 50,
           "mode": 0, "toneHz": 1500, "slotUtcMs": now + 5000, "clientUtcMs": now,
           "alcFast": False, "prebufferSamples": 48000, "packetMs": 20,
           "rttyText": "\r\nOK1HRA TU 599 001 "})
time.sleep(1.0)
send_text({"type": "tx.abort", "txId": 7, "reason": "operator"})
time.sleep(1.0)
LONG = "\r\n" + " ".join(["CQ TEST OK1HRA"] * 10) + " "
now = int(time.time() * 1000)
send_text({"type": "tx.prepare", "txId": 8, "sampleRate": 48000, "samples": 48000, "packets": 50,
           "mode": 0, "toneHz": 1500, "slotUtcMs": now + 5000, "clientUtcMs": now,
           "alcFast": False, "prebufferSamples": 48000, "packetMs": 20, "rttyText": LONG})
time.sleep(1.0)
send_text({"type": "tx.abort", "txId": 8, "reason": "operator"})
time.sleep(1.0)

# ---- FSK: the firmware publishes what it keys ---------------------------------
post("/cmd", body=json.dumps({"type": "sendCw", "text": "\r\nFSK K "}).encode(), ctype="application/json")
time.sleep(2.0)

post("/log-config/rtty-stream", {"rttyStream": "0"})
check("switching off forgets the listener", get("/rtty-stream.json").get("subs") == [])
ws.close()

out, _ = lis.communicate(timeout=30)
packets = [json.loads(line) for line in out.splitlines() if line.strip()]
by = lambda topic: [p for p in packets if p["topic"] == topic]
rx1, rx2, tx = by("/rtty1"), by("/rtty2"), by("/rtty-tx")
check("/rtty1 carries DEC 1's text", "".join(p["text"] for p in rx1) == "CQ TEST DE OK1HRA\r\n", rx1)
check("/rtty2 carries DEC 2's text", "".join(p["text"] for p in rx2) == "CQ TEXT DE", rx2)
check("seq counts per topic, no gaps", [p["seq"] for p in rx1][:1] == [0] and all(p["gap"] == 0 for p in packets), packets)
tx_texts = [("ABORT" if p["abort"] else p["text"]) for p in tx]
long_parts = tx_texts[2:-2]
check("/rtty-tx: the AFSK text, then the abort",
      tx_texts[:2] == ["\r\nOK1HRA TU 599 001 ", "ABORT"], tx_texts)
check("a 152-character message arrives in 63-character pieces, whole",
      [len(t) for t in long_parts] == [63, 63, 26] and "".join(long_parts) == LONG, long_parts)
check("then its abort, then the FSK text keyed by the firmware itself",
      tx_texts[-2:] == ["ABORT", "\r\nFSK K "], tx_texts)
check("every packet fits TrxNet's 64 bytes", all(len(p["text"]) <= 63 for p in packets))

# ---- a listener that leaves says so ------------------------------------------
post("/log-config/rtty-stream", {"rttyStream": "1"})
bye = listener(3)
time.sleep(2)
had = [s["name"] for s in get("/rtty-stream.json").get("subs", [])]
bye.wait()
time.sleep(0.5)
check("/s-rtty 0 on the way out ends the subscription",
      had == ["RTTYMON.01"] and get("/rtty-stream.json").get("subs") == [], had)
post("/log-config/rtty-stream", {"rttyStream": "0"})

failed = [n for n, ok in checks if not ok]
print(("RTTY STREAM NATIVE FAIL (%d)" % len(failed)) if failed else "RTTY STREAM NATIVE PASS")
sys.exit(1 if failed else 0)
PYEOF
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  echo "--- app.log (tail) ---"; tail -30 "$WORK/app.log"
fi
exit $STATUS
