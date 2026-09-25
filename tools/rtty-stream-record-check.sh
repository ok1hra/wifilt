#!/usr/bin/env bash
#
# tools/rtty-stream-record.py against simulated interfaces (grilled 2026-09-25).
# No firmware, no radio: this plays a WIFILT's TrxNet side byte for byte the way
# TrxNet.cpp does -- it answers a PROBE with a unicast ANNOUNCE to the sender's
# 5683, sends [seq][ASCII] NON packets, and a reboot is a fresh PROBE.
#
#   tools/rtty-stream-record-check.sh
#
# Checked: discovery and the choice of one interface (and the refusal of two),
# the subscription and its renewal, the two files and what goes into each, seq
# gaps, /rtty-tx into both, packets from anyone else ignored, a CON acknowledged,
# idle/active, the interface rebooting and moving to another address, the lock
# against a second recorder, SIGHUP ending it cleanly with /s-rtty 0, and the UTC
# midnight: rotation, compression of earlier days, an existing .gz appended to.
#
# The real end to end against the native build is in rtty-stream-native-check.sh.
# Runs in its own user+network namespace, like that one: nothing reaches the LAN.

set -uo pipefail

if [[ $(id -u) -ne 0 ]]; then
  exec unshare -rn "$0" "$@"
fi
ip link set lo up
ip link add rec0 type dummy
for a in 1 2 3 4; do ip addr add 10.99.0.$a/24 brd + dev rec0; done
ip link set rec0 up

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 - "$ROOT/tools/rtty-stream-record.py" "$WORK" <<'PYEOF'
import datetime, glob, gzip, json, os, signal, socket, struct, subprocess, sys, time

RECORDER, WORK = sys.argv[1], sys.argv[2]
ME_IP, BCAST = "10.99.0.1", "10.99.0.255"
checks = []
def check(name, ok, detail=""):
    checks.append((name, bool(ok)))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" -- {detail}" if detail and not ok else ""))

def disc(name, kind, port=5683):
    raw = name.encode()
    return bytes([0xAA, 0x01, kind, len(raw)]) + raw + struct.pack(">H", port)

def coap(path, payload, mid=1, kind=1):
    out = bytearray([0x40 | (kind << 4), 0x02]) + struct.pack(">H", mid)
    last = 0
    for seg in [s for s in path.split("/") if s]:
        out.append(((11 - last) << 4) | len(seg)); out += seg.encode(); last = 11
    return bytes(out) + b"\xff" + payload

def parse(buf):
    """('disc', kind, name) | ('coap', type, path, payload) | ('ack', mid)"""
    if buf[0] == 0xAA:
        return ("disc", buf[2], buf[4:4 + buf[3]].decode())
    kind = (buf[0] >> 4) & 3
    if kind == 2:
        return ("ack", struct.unpack(">H", buf[2:4])[0])
    pos, segs = 4, []
    while pos < len(buf) and buf[pos] != 0xFF:
        n = buf[pos] & 0x0F; segs.append(buf[pos + 1:pos + 1 + n].decode()); pos += 1 + n
    return ("coap", kind, "/" + "/".join(segs), buf[pos + 1:])

class Iface:
    """One simulated WIFILT: its own address, TrxNet's well-known port."""
    def __init__(self, name, ip):
        self.name, self.ip = name, ip
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((ip, 5683))
        self.sock.settimeout(0.05)
        self.got = []
    def pump(self):
        while True:
            try:
                buf, addr = self.sock.recvfrom(512)
            except socket.timeout:
                return
            p = parse(buf)
            self.got.append(p)
            if p[0] == "disc" and p[1] == 0x01:                 # PROBE -> unicast ANNOUNCE
                self.sock.sendto(disc(self.name, 0x02), (addr[0], 5683))
    def send(self, data):
        self.sock.sendto(data, (ME_IP, 5683))
    def subs(self):
        return [p[3][0] for p in self.got if p[0] == "coap" and p[2] == "/s-rtty"]

bcast = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)       # where PROBEs arrive
bcast.bind((BCAST, 5683))
bcast.settimeout(0.05)
ifaces = []
def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            buf, addr = bcast.recvfrom(512)
            p = parse(buf)
            if p[0] == "disc" and p[1] == 0x01:
                for i in ifaces:
                    i.sock.sendto(disc(i.name, 0x02), (addr[0], 5683))
        except socket.timeout:
            pass
        for i in ifaces:
            i.pump()

def recorder(dirname, *extra, env=None):
    return subprocess.Popen([sys.executable, RECORDER, "--bind", ME_IP, "--broadcast", BCAST,
                             "--dir", os.path.join(WORK, dirname), *extra],
                            stderr=subprocess.PIPE, text=True, env={**os.environ, **(env or {})})

def lines(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt") as f:
        return [json.loads(l) for l in f if l.strip()]

today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")

# ---- 1. one interface: discovery, subscription, the two files -------------------
a = Iface("705.01", "10.99.0.2"); ifaces[:] = [a]
rec = recorder("one", "--idle", "3")
pump(3.0)
check("the only 705.* is chosen and subscribed to", a.subs() == [1], a.got)
check("an ANNOUNCE precedes the subscription",
      any(p[0] == "disc" and p[1] == 0x02 and p[2] == "RTY.01" for p in a.got), a.got)

stranger = Iface("705.99", "10.99.0.3")
a.send(coap("/rtty1", b"\x00CQ TEST "))
a.send(coap("/rtty2", b"\x00CQ TEXT "))
a.send(coap("/rtty1", b"\x01DE OK1"))
a.send(coap("/rtty1", b"\x03HRA\r\n"))                         # seq 2 lost
stranger.send(coap("/rtty1", b"\x00NOT MINE"))
a.send(coap("/rtty-tx", b"\x00\r\nOK1HRA TU "))
a.send(coap("/rtty-tx", b"\x01\x00"))
a.send(coap("/rtty2", b"\x01K", mid=0x1234, kind=0))            # CON
pump(0.5)
check("a CON is acknowledged", ("ack", 0x1234) in a.got, a.got)

pump(3.5)                                                        # idle after 3 s
a.send(coap("/rtty2", b"\x02 NW"))
pump(0.3)

# the interface reboots: a PROBE, its seq starts over
a.got.clear()
a.send(disc("705.01", 0x01))
pump(0.3)
check("a restarted interface is subscribed to at once", a.subs() == [1], a.got)
a.send(coap("/rtty1", b"\x00AFTER"))

# it comes back on another address
b = Iface("705.01", "10.99.0.4")
b.send(disc("705.01", 0x02))
ifaces.append(b)
pump(0.3)
check("an interface that moved is followed", b.subs() == [1], b.got)
b.send(coap("/rtty1", b"\x01 MOVED"))
a.send(coap("/rtty1", b"\x09OLD ADDRESS"))
pump(0.3)

second = recorder("one", "--port", "5684", "--target", "10.99.0.4", "--iface", "705.01")
try:
    err2 = second.communicate(timeout=5)[1]
except subprocess.TimeoutExpired:
    second.kill(); err2 = second.communicate()[1]
check("a second recorder on the same interface and directory is refused",
      second.returncode == 2 and "another recorder" in err2, (second.returncode, err2))

b.got.clear()
rec.send_signal(signal.SIGHUP)
try:
    err = rec.communicate(timeout=5)[1]
except subprocess.TimeoutExpired:
    rec.kill(); err = rec.communicate()[1]
pump(0.3)
check("SIGHUP ends it cleanly", rec.returncode == 0, (rec.returncode, err))
check("with /s-rtty 0 on the way out", b.subs() == [0], b.got)
check("the Priority prefixes hint is printed", "Priority prefixes" in err and "RTY" in err, err)

r1 = lines(os.path.join(WORK, "one", f"{today}_705.01_rtty1.jsonl"))
r2 = lines(os.path.join(WORK, "one", f"{today}_705.01_rtty2.jsonl"))
pk = lambda ls: [l for l in ls if "ev" not in l]
ev = lambda ls: [l["ev"] for l in ls if "ev" in l]
check("each file opens with the schema header",
      r1[0].get("ev") == "open" and r1[0].get("v") == 1 and r1[0].get("iface") == "705.01"
      and r1[0].get("me") == "RTY.01" and r1[0].get("topic") == "/rtty1"
      and r2[0].get("topic") == "/rtty2", (r1[:1], r2[:1]))
check("/rtty1 holds DEC 1's text, CR LF kept",
      "".join(l["text"] for l in pk(r1)) == "CQ TEST DE OK1HRA\r\nAFTER MOVED", pk(r1))
check("/rtty2 holds DEC 2's text", "".join(l["text"] for l in pk(r2)) == "CQ TEXT K NW", pk(r2))
check("a skipped seq is a gap", [l["gap"] for l in pk(r1)] == [0, 0, 1, 0, 0], pk(r1))
check("packets from another interface or the old address are dropped",
      not any("NOT MINE" in l.get("text", "") or "OLD" in l.get("text", "") for l in r1))
tx = [l for l in r1 if l.get("ev", "").startswith("tx")]
check("/rtty-tx and its abort go into both files",
      [(l["ev"], l.get("text")) for l in tx] == [("tx", "\r\nOK1HRA TU "), ("tx-abort", None)]
      and [l for l in r2 if l.get("ev", "").startswith("tx")] == tx, tx)
check("idle, then active", ev(r1).count("idle") == 1 and ev(r1).index("idle") < ev(r1).index("active")
      and ev(r2) == ev(r1), ev(r1))
check("the reboot and the new address are marked",
      "iface-restart" in ev(r1) and any(l.get("ev") == "iface" and l.get("ip") == "10.99.0.4" for l in r1),
      ev(r1))
check("and the close, with the signal", r1[-1] == {**r1[-1], "ev": "close", "reason": "SIGHUP"}
      and r2[-1].get("ev") == "close", r1[-1])
check("times are in order", all(x["t"] <= y["t"] for x, y in zip(r1, r1[1:])))
for i in ifaces + [stranger]:
    i.sock.close()

# ---- 2. two interfaces answer: refuse to guess -----------------------------------
ifaces[:] = [Iface("705.01", "10.99.0.2"), Iface("705.02", "10.99.0.3")]
rec = recorder("two")
pump(3.0)
try:
    err = rec.communicate(timeout=3)[1]
except subprocess.TimeoutExpired:
    rec.kill(); err = rec.communicate()[1]
check("two interfaces and no --iface: it stops and names them",
      rec.returncode == 2 and "705.01" in err and "705.02" in err, (rec.returncode, err))
rec = recorder("two", "--iface", "705.02")
pump(3.0)
check("--iface picks one of them", ifaces[1].subs() == [1] and ifaces[0].subs() == [], ifaces[0].got)
rec.terminate(); rec.wait(5)
for i in ifaces:
    i.sock.close()

# ---- 3. none yet: the first to appear is taken --------------------------------------
ifaces[:] = []
rec = recorder("late")
pump(3.0)
late = Iface("705.07", "10.99.0.2")
late.send(disc("705.07", 0x02))
ifaces.append(late)
pump(0.5)
check("an interface that turns up later is taken", late.subs() == [1], late.got)
rec.terminate(); rec.wait(5)
late.sock.close()

# ---- 4. UTC midnight -------------------------------------------------------------------
mid = os.path.join(WORK, "midnight")
os.makedirs(mid)
t = time.time()
midnight = (int(t) // 86400 + 1) * 86400
offset = midnight - t - 4.0                     # the recorder's clock: 4 s before 00:00Z
day0 = datetime.datetime.fromtimestamp(midnight - 1, datetime.timezone.utc).strftime("%Y-%m-%d")
day1 = datetime.datetime.fromtimestamp(midnight + 1, datetime.timezone.utc).strftime("%Y-%m-%d")
open(os.path.join(mid, "2020-01-01_705.01_rtty1.jsonl"), "w").write('{"t":1,"seq":0,"gap":0,"text":"OLD"}\n')
open(os.path.join(mid, "2020-01-02_705.01_rtty2.jsonl"), "w").write('{"t":3,"seq":1,"gap":0,"text":"B"}\n')
with gzip.open(os.path.join(mid, "2020-01-02_705.01_rtty2.jsonl.gz"), "wt") as f:
    f.write('{"t":2,"seq":0,"gap":0,"text":"A"}\n')
open(os.path.join(mid, "2020-01-01_705.02_rtty1.jsonl"), "w").write("{}\n")   # not ours
a = Iface("705.01", "10.99.0.2"); ifaces[:] = [a]
rec = recorder("midnight", "--iface", "705.01",
               env={"RTTY_REC_TEST_CLOCK_OFFSET": repr(offset)})
pump(1.0)
a.send(coap("/rtty1", b"\x00BEFORE"))
pump(5.0)
a.send(coap("/rtty1", b"\x01AFTER"))
pump(0.5)
rec.terminate(); rec.wait(5)
names = sorted(os.listdir(mid))
check("earlier days are compressed at start",
      "2020-01-01_705.01_rtty1.jsonl.gz" in names and "2020-01-01_705.01_rtty1.jsonl" not in names, names)
check("an existing .gz gets the rest appended, readable as one",
      [l["text"] for l in lines(os.path.join(mid, "2020-01-02_705.01_rtty2.jsonl.gz"))] == ["A", "B"]
      and "2020-01-02_705.01_rtty2.jsonl" not in names, names)
check("another interface's files are left alone", "2020-01-01_705.02_rtty1.jsonl" in names, names)
check("at midnight the day just ended is compressed",
      f"{day0}_705.01_rtty1.jsonl.gz" in names and f"{day0}_705.01_rtty1.jsonl" not in names
      and f"{day0}_705.01_rtty2.jsonl.gz" in names, names)
old, new = lines(os.path.join(mid, f"{day0}_705.01_rtty1.jsonl.gz")), \
           lines(os.path.join(mid, f"{day1}_705.01_rtty1.jsonl"))
check("it ends with a rotate close, holding what came before",
      [l.get("text") for l in pk(old)] == ["BEFORE"] and old[-1].get("reason") == "rotate", old)
check("and the new day opens with a header and goes on",
      new[0].get("ev") == "open" and [l.get("text") for l in pk(new)] == ["AFTER"]
      and new[-1].get("reason") == "SIGTERM", new)
a.sock.close()

failed = [n for n, ok in checks if not ok]
print(("RTTY RECORDER FAIL (%d)" % len(failed)) if failed else f"RTTY RECORDER PASS ({len(checks)})")
sys.exit(1 if failed else 0)
PYEOF
