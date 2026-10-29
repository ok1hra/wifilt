#!/usr/bin/env bash
#
# JTTY in the firmware, end to end against the native build
# (docs/jtty-implementace.md §5, §6, §8). Nothing goes on the air.
#
#   tools/jtty-native-check.sh
#
# The fake radio sits in USB. Checked:
#   - /jtty serves the JTTY page
#   - the TrxNet stream switch is off by default; on: /s-jtty registers
#     tools/jtty-stream-listen.py, /jtty-stream.json names it
#   - decoded JTTY over the AUD1 socket (jtty.stream) -> /jtty-rx
#   - a live-entry transmission: tx.prepare, two tx.extend while it plays, and
#     packets that only add up at the end -> keyed, drained, no tx-error, and
#     every segment's text on /jtty-tx
#   - a packet reaching the declared count without LAST is refused
#   - tx.extend past the 180 s cap aborts, and the abort reaches /jtty-tx
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

python3 - "$ROOT" "$HTTP_PORT" <<'PYEOF'
import base64, json, os, socket, struct, subprocess, sys, threading, time
import urllib.error, urllib.request, urllib.parse

root, http_port = sys.argv[1], sys.argv[2]
HTTP = f"http://127.0.0.1:{http_port}"
checks = []
def check(name, ok, detail=""):
    checks.append((name, bool(ok)))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" -- {detail}" if detail and not ok else ""))

def get(path, raw=False):
    try:
        with urllib.request.urlopen(HTTP + path, timeout=5) as r:
            body = r.read().decode()
    except urllib.error.HTTPError as error:   # /js8/session answers 409 to a non-holder
        body = error.read().decode()
    return body if raw else json.loads(body or "{}")
def post(path, form=None, body=None, ctype="application/x-www-form-urlencoded"):
    data = body if body is not None else urllib.parse.urlencode(form or {}).encode()
    req = urllib.request.Request(HTTP + path, data=data, headers={"Content-Type": ctype}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read().decode()

def listener(seconds):
    return subprocess.Popen([sys.executable, f"{root}/tools/jtty-stream-listen.py",
        "--target", "127.0.0.1:5683", "--port", "5692", "--json", "--seconds", str(seconds)],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

page = get("/jtty", raw=True)
check("/jtty serves the JTTY page", "<title>JTTY" in page and "/jtty.js" in page)
state = get("/state")
check("fake radio connected", state.get("connected") is True, state)

check("the stream switch is off by default", get("/log-config").get("jttyStream") is not True)
post("/log-config/jtty-stream", {"jttyStream": "1"})
check("the switch is stored", get("/log-config").get("jttyStream") is True)
check("and does not touch RTTY's", get("/log-config").get("rttyStream") is not True)
lis = listener(40)
subs = []
for _ in range(20):
    time.sleep(0.25)
    subs = get("/jtty-stream.json").get("subs", [])
    if subs: break
check("/s-jtty registers the listener", [s["name"] for s in subs] == ["JTY.fe"], subs)

token = base64.b16encode(os.urandom(8)).decode().lower()
post("/js8/session/claim", body=json.dumps({"token": token, "role": "jtty"}).encode(), ctype="application/json")
check("the session reports role jtty", get("/js8/session").get("role") == "jtty", get("/js8/session"))
key = base64.b64encode(os.urandom(16)).decode()
ws = socket.create_connection(("127.0.0.1", 83), timeout=6)
ws.sendall((f"GET /audiows?token={token} HTTP/1.1\r\nHost: 127.0.0.1:83\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
head = b""
while b"\r\n\r\n" not in head:
    head += ws.recv(4096)
check("AUD1 socket upgraded", b" 101 " in head.split(b"\r\n")[0], head[:60])
rest = head.split(b"\r\n\r\n", 1)[1]

events, lock = [], threading.Lock()
def reader():
    buf = bytearray(rest)
    ws.settimeout(0.5)
    while True:
        try:
            chunk = ws.recv(65536)
            if not chunk: return
            buf += chunk
        except socket.timeout:
            pass
        except OSError:
            return
        while len(buf) >= 2:
            op, ln, pos = buf[0] & 0x0F, buf[1] & 0x7F, 2
            if ln == 126:
                if len(buf) < 4: break
                ln, pos = struct.unpack(">H", buf[2:4])[0], 4
            elif ln == 127:
                if len(buf) < 10: break
                ln, pos = struct.unpack(">Q", buf[2:10])[0], 10
            if len(buf) < pos + ln: break
            payload = bytes(buf[pos:pos + ln]); del buf[:pos + ln]
            if op == 1:
                try:
                    with lock: events.append(json.loads(payload))
                except ValueError: pass
threading.Thread(target=reader, daemon=True).start()

send_lock = threading.Lock()
def frame(op, payload):
    mask = os.urandom(4)
    out = bytearray([0x80 | op])
    n = len(payload)
    if n < 126: out.append(0x80 | n)
    elif n < 65536: out += bytes([0x80 | 126]) + n.to_bytes(2, "big")
    else: out += bytes([0x80 | 127]) + n.to_bytes(8, "big")
    out += mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    with send_lock: ws.sendall(out)
def send_text(obj): frame(1, json.dumps(obj).encode())

def wait_event(pred, seconds):
    deadline = time.time() + seconds
    while True:
        with lock:
            for e in events:
                if pred(e): return e
        if time.time() >= deadline: return None
        time.sleep(0.05)

hello = wait_event(lambda e: e.get("type") == "hello", 5)
check("AUD1 hello", hello is not None, events[:3])
stream_id = (hello or {}).get("streamId", 0)

# ---- decoded JTTY -> /jtty-rx -----------------------------------------------
send_text({"type": "jtty.stream", "id": 3, "hz": 1512, "snr": -9, "eom": 0, "text": "CQ OK1ABC"})
send_text({"type": "jtty.stream", "id": 3, "hz": 1512, "snr": -9, "eom": 1, "text": " CQ"})

# ---- live entry: prepare, two extends, one continuous packet stream -----------
def packet(tx_id, seq, offset, count, first, last):
    hdr = bytearray(40)
    hdr[0:4] = b"AUD1"; hdr[4] = 1; hdr[5] = 3
    struct.pack_into(">HHH", hdr, 6, (1 if first else 0) | (2 if last else 0), 40, 0)
    struct.pack_into(">IIIQII", hdr, 12, stream_id, seq, 48000, offset, tx_id, count * 2)
    return bytes(hdr) + bytes(count * 2)

SEG = [48000, 24000, 24000]                 # samples: prepare, extend, extend
total = sum(SEG)
pk = lambda n: -(-n // 960)
now = int(time.time() * 1000)
send_text({"type": "tx.prepare", "txId": 21, "sampleRate": 48000, "samples": SEG[0], "packets": pk(SEG[0]),
           "mode": 0, "toneHz": 1500, "slotUtcMs": now + 800, "clientUtcMs": now, "alcFast": False,
           "prebufferSamples": 48000, "packetMs": 20, "jttyText": "CQ OK1HRA CQ"})
ready = wait_event(lambda e: e.get("type") == "tx-ready" and e.get("txId") == 21, 5)
check("tx.prepare accepted", ready is not None, events[-3:])
declared, sent, seq, ext = SEG[0], 0, 0, 1
start = time.time() - 0.55                  # 1350 ms of stream ahead of the 800 ms slot
while sent < total:
    if ext < len(SEG) and declared - sent < 24000:
        before = pk(declared); declared += SEG[ext]
        send_text({"type": "tx.extend", "txId": 21, "samples": SEG[ext], "packets": pk(declared) - before,
                   "jttyText": "" if ext == 2 else "DE OK1HRA"})
        ext += 1
    allowed = (int((time.time() - start) / 0.02) + 1) * 960
    if sent >= allowed:
        time.sleep(0.005); continue
    count = min(960, total - sent)
    frame(2, packet(21, seq, sent, count, seq == 0, sent + count == total))
    seq += 1; sent += count
drained = wait_event(lambda e: e.get("type") == "tx-drained" and e.get("txId") == 21, 8)
err = wait_event(lambda e: e.get("type") == "tx-error" and e.get("txId") == 21, 0.1)
check("keyed and drained through two extends", drained is not None and err is None, err or events[-4:])
keyed = wait_event(lambda e: e.get("type") == "tx-state" and e.get("txId") == 21 and e.get("ptt") is True, 0.1)
check("PTT went on", keyed is not None)

# ---- a packet past the declared end, without an extend ---------------------------
now = int(time.time() * 1000)
send_text({"type": "tx.prepare", "txId": 22, "sampleRate": 48000, "samples": 48000, "packets": 50,
           "mode": 0, "toneHz": 1500, "slotUtcMs": now + 5000, "clientUtcMs": now, "alcFast": False,
           "prebufferSamples": 48000, "packetMs": 20})
wait_event(lambda e: e.get("type") == "tx-ready" and e.get("txId") == 22, 5)
for s in range(50):
    frame(2, packet(22, s, s * 960, 960, s == 0, False))
refused = wait_event(lambda e: e.get("type") == "tx-error" and e.get("txId") == 22, 3)
check("the 50th of 50 packets without LAST is refused", refused is not None, events[-3:])

# ---- the cap ----------------------------------------------------------------------
now = int(time.time() * 1000)
send_text({"type": "tx.prepare", "txId": 23, "sampleRate": 48000, "samples": 48000, "packets": 50,
           "mode": 0, "toneHz": 1500, "slotUtcMs": now + 5000, "clientUtcMs": now, "alcFast": False,
           "prebufferSamples": 48000, "packetMs": 20, "jttyText": "TEST"})
wait_event(lambda e: e.get("type") == "tx-ready" and e.get("txId") == 23, 5)
send_text({"type": "tx.extend", "txId": 23, "samples": 180 * 48000, "packets": 9000})
capped = wait_event(lambda e: e.get("type") == "tx-error" and e.get("txId") == 23, 3)
check("tx.extend past 180 s aborts", capped is not None and "cap" in capped.get("reason", ""), capped)
errors_before = sum(1 for e in events if e.get("type") == "tx-error")
send_text({"type": "tx.extend", "txId": 23, "samples": 960, "packets": 1})
time.sleep(0.5)
check("an extend for a finished TX is ignored",
      sum(1 for e in events if e.get("type") == "tx-error") == errors_before)
time.sleep(1.5)

post("/log-config/jtty-stream", {"jttyStream": "0"})
check("switching off forgets the listener", get("/jtty-stream.json").get("subs") == [])
ws.close()
lis.terminate()
out, _ = lis.communicate(timeout=30)
packets = [json.loads(line) for line in out.splitlines() if line.strip()]
rx = [p for p in packets if p["topic"] == "/jtty-rx"]
tx = [("ABORT" if p.get("abort") else p["text"]) for p in packets if p["topic"] == "/jtty-tx"]
check("/jtty-rx: the message, put together by msgId, closed by EOM",
      len(rx) == 2 and rx[-1]["message"] == "CQ OK1ABC CQ" and rx[-1]["eom"] and rx[0]["hz"] == 1512 and rx[0]["snr"] == -9, rx)
check("/jtty-tx: the opening segment, the extended one, then the capped TX and its abort",
      tx == ["CQ OK1HRA CQ", "DE OK1HRA", "TEST", "ABORT"], tx)
check("seq without gaps", all(p["gap"] == 0 for p in packets), packets)

failed = [n for n, ok in checks if not ok]
print(("JTTY NATIVE FAIL (%d)" % len(failed)) if failed else "JTTY NATIVE PASS")
sys.exit(1 if failed else 0)
PYEOF
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  echo "--- app.log (tail) ---"; tail -40 "$WORK/app.log"
fi
exit $STATUS
