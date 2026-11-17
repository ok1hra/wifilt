#!/usr/bin/env bash
#
# Integration test of remote access (SETUP -> Remote access) in network
# namespaces, no sudo. A real n2n 3.1.1 supernode and two stations:
#
#   station A  wifilt (native build) + its edge started by the root helper
#   station B  only an edge -- the laptop that reaches A through the VPN
#
# Both are paired the way pi-setup does it (wifilt --vpn-pair), the edges are
# started with `wifilt-vpn run` exactly as wifilt-vpn.service does, and B talks
# to A's wifilt over A's VPN address.
#
#   N2N_BIN=<dir with edge and supernode> tools/vpn-native-check.sh
#
# N2N_BIN defaults to /usr/local/sbin (native/vpn/build-n2n.sh). Without n2n 3
# the test says SKIP and passes: CI has no n2n.

set -uo pipefail

if [[ $(id -u) -ne 0 ]]; then
  exec unshare -rn "$0" "$@"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT/native/build/wifilt"
HELPER="$ROOT/native/vpn/wifilt-vpn.sh"
N2N_BIN="${N2N_BIN:-/usr/local/sbin}"
[[ -x "$BINARY" ]] || { echo "no native build -- make -C native first"; exit 1; }
if [[ ! -x "$N2N_BIN/edge" || ! -x "$N2N_BIN/supernode" ]]; then
  echo "SKIP: no n2n 3 edge/supernode in $N2N_BIN (set N2N_BIN)"
  exit 0
fi
case "$("$N2N_BIN/edge" -h 2>&1 | head -n3 | tr '\n' ' ')" in
  *"n2n v.3."*) ;;
  *) echo "SKIP: $N2N_BIN/edge is not n2n 3"; exit 0 ;;
esac

WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill -TERM "$p" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

ip link set lo up
ip link add br0 type bridge && ip addr add 10.97.0.1/24 dev br0 && ip link set br0 up

declare -A NS
n=2
for s in A B; do
  unshare -n sleep 600 >/dev/null 2>&1 &
  NS[$s]=$!
  PIDS+=("$!")
  sleep 0.2
  ip link add "vh$n" type veth peer name "vn$n"
  ip link set "vh$n" master br0 && ip link set "vh$n" up
  ip link set "vn$n" netns "${NS[$s]}"
  nsenter -t "${NS[$s]}" -n sh -c "ip link set lo up; ip link set vn$n name eth0; \
    ip addr add 10.97.0.$n/24 dev eth0; ip link set eth0 up; ip route add default via 10.97.0.1"
  n=$((n + 1))
done

# The supernode, with the same community filter as server/supernode/README.md.
printf '%s\n' '# wifilt' 'wl-\w\w\w\w\w\w\w\w' > "$WORK/community.list"
"$N2N_BIN/supernode" -p 7654 -c "$WORK/community.list" -f -u 0 -g 0 > "$WORK/sn.log" 2>&1 &
PIDS+=("$!")

for s in A B; do
  mkdir -p "$WORK/$s/cfg" "$WORK/$s/state/req"
  printf 'PREFIX=%s\nRUN_USER=root\nCONF_DIR=%s\n' "$ROOT/native" "$WORK/$s/cfg" > "$WORK/$s/vpn.conf"
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$WORK/$s/machine-id"
done
# Station A's EEPROM: AP mode off, callsign OK1TST (wifilt.ino map: 203..218).
python3 - "$WORK/A/cfg/eeprom.bin" <<'PYEOF'
import sys
image = bytearray(b'\xff' * 360)
image[0] = 0x00
image[203:209] = b'OK1TST'
image[209] = 0
open(sys.argv[1], "wb").write(bytes(image))
PYEOF

station_env() {
  echo "WIFILT_VPN_CONF=$WORK/$1/vpn.conf WIFILT_VPN_STATE=$WORK/$1/state" \
       "WIFILT_VPN_EDGE=$N2N_BIN/edge WIFILT_VPN_AS_SELF=1" \
       "WIFILT_VPN_MACHINE_ID=$WORK/$1/machine-id"
}

# Pair as pi-setup does: A creates the network, B joins with A's code.
# shellcheck disable=SC2046
CODE="$(env $(station_env A) "$BINARY" --config-dir "$WORK/A/cfg" --vpn-pair new --vpn-enable)"
# shellcheck disable=SC2046
env $(station_env B) "$BINARY" --config-dir "$WORK/B/cfg" --vpn-pair "$CODE" --vpn-enable \
  --vpn-desc TEST-B >/dev/null
# Test only: the supernode is the local one.
sed -i 's/remoteqth\.com:82/10.97.0.1:7654/' "$WORK/A/cfg/vpn.json" "$WORK/B/cfg/vpn.json"

CONDITION=()
for s in A B; do
  # shellcheck disable=SC2046
  env $(station_env "$s") "$HELPER" condition
  CONDITION+=("$?")
  # shellcheck disable=SC2046
  nsenter -t "${NS[$s]}" -n env $(station_env "$s") WIFILT_VPN_EDGE_EXTRA="-u 0 -g 0" \
    "$HELPER" run > "$WORK/$s/edge.log" 2>&1 &
  PIDS+=("$!")
done
sleep 5

vpn_ip() { nsenter -t "${NS[$1]}" -n ip -4 -br addr show wlvpn0 2>/dev/null | awk '{print $3}' | cut -d/ -f1; }
IP_A="$(vpn_ip A)"
IP_B="$(vpn_ip B)"

# shellcheck disable=SC2046
nsenter -t "${NS[A]}" -n env $(station_env A) WIFILT_HOST_LABEL=RPI \
  "$BINARY" --data-dir "$ROOT/data" --config-dir "$WORK/A/cfg" > "$WORK/A/app.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 30); do
  sleep 1
  nsenter -t "${NS[A]}" -n curl -s -m 2 http://127.0.0.1/state >/dev/null 2>&1 && break
done
sleep 4   # the management thread's first round

nsenter -t "${NS[B]}" -n python3 - "$WORK" "$IP_A" "$IP_B" "$CODE" "${CONDITION[*]}" \
  "${NS[A]}" <<'PYEOF'
import json, os, socket, subprocess, sys, time, urllib.request

work, ip_a, ip_b, code, condition, ns_a = sys.argv[1:7]
checks = []

def check(name, ok, detail=""):
    checks.append(ok)
    print(("  ok   " if ok else "  FAIL ") + name + (("  -- " + detail) if (detail and not ok) else ""))

def http(url, body=None, timeout=4):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def local_a(path, body=None):
    # A asking itself (not through the VPN): run curl inside A's namespace.
    cmd = ["nsenter", "-t", ns_a, "-n", "curl", "-s", "-m", "4"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "--data-binary", json.dumps(body)]
    cmd.append("http://127.0.0.1" + path)
    return subprocess.run(cmd, capture_output=True, text=True).stdout

print("== pairing and edges")
check("pairing code from --vpn-pair new", code.startswith("WL-") and len(code) == 39, code)
check("helper condition says start on both stations", condition == "0 0", condition)
check("A got a VPN address from the supernode", ip_a.startswith("10."), ip_a)
check("B got one in the same /24", ip_b.rsplit(".", 1)[0] == ip_a.rsplit(".", 1)[0], ip_a + " " + ip_b)
vpn_a = json.load(open(os.path.join(work, "A", "cfg", "vpn.json")))
check("vpn.json mode 0600", (os.stat(os.path.join(work, "A", "cfg", "vpn.json")).st_mode & 0o777) == 0o600)
check("A's device name from its callsign (CLI read the EEPROM)", vpn_a.get("desc") == "OK1TST-PC", vpn_a.get("desc"))

print("== B reaches A's wifilt through the VPN")
st, body = http("http://%s/vpn/status" % ip_a)
check("GET /vpn/status over the VPN", st == 200, str(st))
s = json.loads(body) if st == 200 else {}
check("mode ok", s.get("mode") == "ok", s.get("mode", "") + " " + s.get("reason", ""))
check("paired and enabled", s.get("paired") is True and s.get("enabled") is True)
check("A sees its supernode", isinstance(s.get("sn"), dict) and s["sn"].get("age", 999) < 60, str(s.get("sn")))
peers = s.get("peers") or []
check("A lists B (TEST-B) in its devices", any(p.get("desc") == "TEST-B" for p in peers), str(peers))
check("B's address in that list", any(p.get("ip", "").split("/")[0] == ip_b for p in peers), str(peers))
check("the request is recognised as coming through the VPN", s.get("viaVpn") is True)
check("A's own VPN address in the status", s.get("ip", "").split("/")[0] == ip_a, s.get("ip", ""))
st, body = http("http://%s/setup-data.json" % ip_a)
check("SETUP data says caps.vpn", st == 200 and json.loads(body).get("caps", {}).get("vpn") is True)

print("== A's own view")
s = json.loads(local_a("/vpn/status") or "{}")
check("a local request is not 'through the VPN'", s.get("viaVpn") is False)
c = json.loads(local_a("/vpn/code") or "{}")
check("/vpn/code gives the code back", c.get("code") == code, c.get("code", ""))
check("  ... with community and key for other clients", c.get("community", "").startswith("wl-") and len(c.get("key", "")) == 20)

print("== settings changes reach the helper")
req = os.path.join(work, "A", "state", "req", "apply.json")
for f in (req,):
    if os.path.exists(f): os.remove(f)
out = local_a("/vpn/set", {"desc": "test-a2"})
check("local rename accepted", '"ok":true' in out, out)
check("  ... stored upper case", json.load(open(os.path.join(work, "A", "cfg", "vpn.json"))).get("desc") == "TEST-A2")
r = open(req).read() if os.path.exists(req) else ""
check("  ... apply requested, nobody to watch", '"action":"apply"' in r and '"watch":""' in r, r)
check("previous settings kept for a revert", os.path.exists(os.path.join(work, "A", "cfg", "vpn.prev.json")))
os.remove(req) if os.path.exists(req) else None
st, out = http("http://%s/vpn/set" % ip_a, {"supernode": "10.97.0.1:7654"})
r = open(req).read() if os.path.exists(req) else ""
check("a change from B through the VPN watches B", ('"watch":"%s"' % ip_b) in r, r)
st, out = http("http://%s/vpn/set" % ip_a, {"supernode": "bad host;rm:1"})
check("a bad supernode is refused", st == 400, str(st) + " " + out)
st, out = http("http://%s/vpn/pair" % ip_a, {"action": "join", "code": code[:-1] + ("0" if code[-1] != "0" else "1")})
check("a mistyped code is refused", st == 400, str(st))

print("== configuration backup")
backup = local_a("/config/download")
check("Download config carries the pairing code", ('"vpn":{' in backup) and (code in backup))
out = local_a("/vpn/leave", {})
check("leave", '"ok":true' in out, out)
s = json.loads(local_a("/vpn/status") or "{}")
check("  ... not paired any more", s.get("paired") is False)
upload = subprocess.run(["nsenter", "-t", ns_a, "-n", "curl", "-s", "-m", "8", "-H", "Content-Type: application/json",
                         "--data-binary", "@-", "http://127.0.0.1/config/upload"],
                        input=backup, capture_output=True, text=True).stdout
check("Upload config accepted", '"ok":true' in upload or upload.strip() == "" or "error" not in upload, upload[:200])
c = json.loads(local_a("/vpn/code") or "{}")
check("  ... and the station is paired again with the same code", c.get("code") == code, c.get("code", ""))

print("== TrxNet stays off the VPN")
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("0.0.0.0", 5683))
sock.settimeout(1.0)
lan, vpn = 0, 0
end = time.time() + 40   # TrxNet announces itself every ~30 s
while time.time() < end:
    try:
        _, src = sock.recvfrom(2048)
    except socket.timeout:
        continue
    if src[0].startswith("10.97.0."): lan += 1
    elif src[0] == ip_a: vpn += 1
if lan == 0:
    print("  WARN no TrxNet datagram from A at all in 40 s -- the VPN check proves nothing")
else:
    check("no TrxNet broadcast from A's VPN address (%d on the LAN)" % lan, vpn == 0, "%d via VPN" % vpn)

print()
print("%d/%d checks passed" % (sum(checks), len(checks)))
sys.exit(0 if all(checks) else 1)
PYEOF
RC=$?
if [[ $RC -ne 0 ]]; then
  echo "--- A app.log (tail)"; tail -20 "$WORK/A/app.log"
  echo "--- A edge.log (tail)"; tail -10 "$WORK/A/edge.log"
  echo "--- B edge.log (tail)"; tail -10 "$WORK/B/edge.log"
fi
exit $RC
