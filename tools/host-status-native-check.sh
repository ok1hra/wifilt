#!/usr/bin/env bash
#
# /wl-host (host_status.h) end to end against the native build: what the OI3's
# "RPI" menu is fed. Nothing leaves the machine.
#
#   tools/host-status-native-check.sh
#
# wifilt plays a Raspberry Pi (WIFILT_HOST_LABEL=RPI). Around it:
#   - a real OI3, OI3.77, in a namespace of its own behind a veth pair, so its
#     address is truly not this machine's
#   - local-trx's FSK stand-in, OI3.10, on wifilt's own address
#   - local-trx's TrxNet node, LTX.42, also on the own address, started late
# Checked:
#   - nothing is sent before LTX.* shows up
#   - then /wl-host reaches OI3.77 at once: version 1, RUN, LTX set, the address
#   - again after ~5 s; never to the stand-in on the own address
#   - an update in the updater's status file -> UPDATE with its percentage
#   - POST /restart -> RESTART before the re-exec, then RUN again
#   - SIGTERM -> STOP
#
# Needs no sudo: it re-runs itself in a fresh user+network namespace (as the
# other *-native-check.sh scripts do).

set -uo pipefail

if [[ $(id -u) -ne 0 ]]; then
  exec unshare -rn "$0" "$@"
fi
ip link set lo up
# The native WiFi shim reports "connected" only with a non-loopback address, and
# TrxNet does not run without it.
ip link add wifilt0 type dummy && ip addr add 10.99.0.1/24 dev wifilt0 && ip link set wifilt0 up
ip link add vethA type veth peer name vethB
ip addr add 10.98.0.1/24 dev vethA && ip link set vethA up

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT/native/build/wifilt"
NODE="$ROOT/tools/trxnet-fake-node.py"
HTTP_PORT=8080
WORK="$(mktemp -d)"
PIDS=()

cleanup() {
  for p in "${PIDS[@]}"; do kill -TERM "$p" 2>/dev/null; done
  wait 2>/dev/null
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
mkdir -p "$WORK/upd"
echo '{"state":"idle"}' > "$WORK/upd/status.json"

# The OI3, in a network namespace of its own. unshare execs python, so $! is it.
unshare -n python3 "$NODE" --name OI3.77 --target 10.98.0.1:5683 --every 2 --seconds 150 \
  --record "$WORK/oi3.jsonl" &
OI3_PID=$!
PIDS+=("$OI3_PID")
sleep 0.3
ip link set vethB netns "$OI3_PID"
nsenter -t "$OI3_PID" -n sh -c 'ip link set lo up; ip addr add 10.98.0.2/24 dev vethB; ip link set vethB up'

# local-trx's FSK stand-in: same kind of name, but this machine's address.
python3 "$NODE" --name OI3.10 --bind 10.99.0.1 --port 5685 --target 10.99.0.1:5683 --every 2 \
  --seconds 150 --record "$WORK/own.jsonl" &
PIDS+=("$!")

WIFILT_HOST_LABEL=RPI WIFILT_UPDATE_STATE="$WORK/upd" \
  "$BINARY" --port "$HTTP_PORT" --data-dir "$ROOT/data" --config-dir "$WORK" \
  > "$WORK/app.log" 2>&1 &
APP_PID=$!
PIDS+=("$APP_PID")

for _ in $(seq 1 30); do
  sleep 1
  curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/state" >/dev/null 2>&1 && break
done

python3 - "$WORK" "$HTTP_PORT" "$NODE" "$APP_PID" <<'PYEOF'
import json, os, signal, subprocess, sys, time, urllib.request

work, http_port, node, app_pid = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
checks = []
def check(name, ok, detail=""):
    checks.append(bool(ok))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" -- {detail}" if detail and not ok else ""))

def packets(fname):
    out = []
    try:
        for line in open(os.path.join(work, fname)):
            e = json.loads(line)
            if e["path"] == "/wl-host":
                out.append((e["t"], bytes.fromhex(e["hex"]), e["mtype"]))
    except FileNotFoundError:
        pass
    return out

def decode(b):
    n = b[10]
    return {"ver": b[0], "state": b[1], "flags": b[2], "rssi": b[3] - 256 if b[3] > 127 else b[3],
            "pct": b[4], "ip": ".".join(str(x) for x in b[6:10]), "ssid": b[11:11 + n].decode()}

def wait_for(pred, seconds):
    end = time.time() + seconds
    while time.time() < end:
        got = [p for p in packets("oi3.jsonl") if pred(p)]
        if got:
            return got
        time.sleep(0.1)
    return []

def set_update(body):
    tmp = os.path.join(work, "upd", "status.json.tmp")
    # compact, as the updater writes it (printf, no spaces)
    open(tmp, "w").write(json.dumps(body, separators=(",", ":")))
    os.replace(tmp, os.path.join(work, "upd", "status.json"))

# -- nothing before local-trx is seen -------------------------------------------
time.sleep(7)
check("no /wl-host while LTX.* has not been seen", not packets("oi3.jsonl"),
      f"{len(packets('oi3.jsonl'))} packets")

ltx = subprocess.Popen([sys.executable, node, "--name", "LTX.42", "--bind", "10.99.0.1",
                        "--port", "5684", "--target", "10.99.0.1:5683", "--every", "2",
                        "--seconds", "150", "--record", os.devnull])
t_ltx = time.time()
first = wait_for(lambda p: True, 5)
check("/wl-host reaches the OI3 once LTX.* is there", first)
if first:
    s = decode(first[0][1])
    check("  within 2 s", first[0][0] - t_ltx < 2.5, f"{first[0][0] - t_ltx:.1f} s")
    check("  TRX_NON", first[0][2] == 1, first[0][2])
    check("  version 1, RUN", s["ver"] == 1 and s["state"] == 0, s)
    check("  LTX flag set", s["flags"] & 0x10, s)
    check("  no WiFi here: address marked as wired, no RSSI, no SSID",
          (s["flags"] & 0x40) and not (s["flags"] & 0x0C) and s["rssi"] == 0 and s["ssid"] == "", s)
    check("  the address is one of this machine's", s["ip"] in ("10.99.0.1", "10.98.0.1"), s)
    check("  not locked, no fslock", not (s["flags"] & 0x03), s)
    t1 = first[0][0]
    second = wait_for(lambda p: p[0] > t1 + 0.5, 8)
    check("periodic: again after ~5 s", second and 4.0 <= second[0][0] - t1 <= 6.5,
          f"{second[0][0] - t1:.1f} s" if second else "none")
check("never to the OI3.* on this machine's own address", not packets("own.jsonl"),
      f"{len(packets('own.jsonl'))} packets")

# -- an update in progress --------------------------------------------------------
t0 = time.time()
set_update({"state": "running", "pct": 42, "ts": int(time.time())})
upd = wait_for(lambda p: p[0] > t0 and decode(p[1])["state"] == 4, 4)
check("updater running -> UPDATE at once", upd)
if upd:
    check("  with its percentage", decode(upd[0][1])["pct"] == 42, decode(upd[0][1]))
t0 = time.time()
set_update({"state": "running", "pct": 42, "ts": int(time.time()) - 3600})
stale = wait_for(lambda p: p[0] > t0 and decode(p[1])["state"] == 0, 4)
check("a status file nobody updated for an hour is not an update", stale)
set_update({"state": "done", "pct": 100, "ts": int(time.time())})

# -- restart -----------------------------------------------------------------------
time.sleep(1.5)
t0 = time.time()
try:
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{http_port}/restart",
                           data=b"", method="POST"), timeout=5).read()
except Exception as e:
    print(f"  (POST /restart: {e})")
down = wait_for(lambda p: p[0] > t0 and decode(p[1])["state"] == 1, 8)
check("POST /restart -> RESTART", down, "")
if down:
    time.sleep(0.5)     # the second copy follows 50 ms later
    copies = [p for p in packets("oi3.jsonl") if p[0] > t0 and decode(p[1])["state"] == 1]
    check("  sent twice (NON may be lost)", len(copies) >= 2, len(copies))
    back = wait_for(lambda p: p[0] > down[-1][0] + 0.5 and decode(p[1])["state"] == 0, 20)
    check("RUN again after the restart", back)

# -- stop ----------------------------------------------------------------------------
time.sleep(1.5)
t0 = time.time()
os.kill(app_pid, signal.SIGTERM)
stop = wait_for(lambda p: p[0] > t0 and decode(p[1])["state"] in (2, 3), 6)
check("SIGTERM -> STOP", stop and decode(stop[0][1])["state"] == 2,
      decode(stop[0][1]) if stop else "none")

ltx.terminate()
print(f"{sum(checks)}/{len(checks)} checks passed")
sys.exit(0 if all(checks) else 1)
PYEOF
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "--- app.log (tail)"; tail -n 40 "$WORK/app.log"
fi
exit $rc
