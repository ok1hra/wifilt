#!/usr/bin/env python3
"""
local-trx with CAT / CW / PTT over TrxNet, end to end (no radio, no OI3).

WHY THIS EXISTS
    cat.backend, keying.cwBackend and keying.pttBackend "trxnet" send
    everything but audio to a TrxNet device (local-trx/src/trxnet_link.h).
    This plays that device -- a fake OI3 speaking TrxNet's discovery + CoAP on
    loopback -- starts local-trx against it, and drives local-trx's ICOM-LAN
    CI-V port the way wifilt does (same handshake as local-trx-ptt-check.py).

    Discovery is started by the fake with a UNICAST PROBE announcing its own
    port, so no broadcast is needed (sandboxes often have no route for one),
    and the reply proves TrxNet 1.08's "answer at the prober's announced
    port" -- an older library answers at its own port, i.e. itself.

CHECKS
    discovery    local-trx answers the PROBE at the fake's port, as LTX.<id>
    CAT read     /hz + /mode from the fake reach CI-V 0x03 / 0x04
    CAT write    CI-V 0x05 / 0x06 become /s-hz / /s-mode
    CW           CI-V 0x17 text becomes one /s-cw (CON, gathered)
    PTT lease    CI-V 0x1C on -> /s-ptt 1 at once and renewed ~every 300 ms;
                 off -> /s-ptt 0 three times, then silence
    shutdown     SIGTERM while keyed -> /s-ptt 0 before local-trx exits

USAGE
    python3 tools/local-trx-trxnet-check.py [--bin local-trx/build/local-trx]

Exit 0 when every check passed, 1 otherwise, 2 when local-trx never came up.
"""

import argparse
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

from local_trx_wire import hdr16

CTRL_ADDR = 0xE1
FAKE_NAME = "OI3.77"
LTX_ID = 0x42
FAKE_PORT = 56830      # plays the network port
LTX_PORT = 56840       # local-trx's own, as beside a native wifilt
LAN_IP = "127.0.0.3"

DISC_MAGIC, DISC_VERSION, DISC_PROBE, DISC_ANNOUNCE = 0xAA, 0x01, 0x01, 0x02
COAP_CON, COAP_NON, COAP_ACK, COAP_POST, URI_PATH = 0, 1, 2, 0x02, 11


# ---- TrxNet wire (TrxNet.cpp _sendDiscovery / _buildCoAP / _processCoAP) ----

def discovery(ptype, name, port):
    n = name.encode()
    return bytes([DISC_MAGIC, DISC_VERSION, ptype, len(n)]) + n + struct.pack(">H", port)


def coap(path, payload, mtype, msg_id):
    out = bytearray([(1 << 6) | (mtype << 4), COAP_POST]) + struct.pack(">H", msg_id)
    prev = 0
    for seg in [s for s in path.split("/") if s]:
        seg = seg.encode()
        delta = URI_PATH - prev
        prev = URI_PATH
        assert delta < 13 and len(seg) < 13
        out.append((delta << 4) | len(seg))
        out += seg
    out.append(0xFF)
    return bytes(out + payload)


def parse_coap(data):
    mtype = (data[0] >> 4) & 0x03
    tkl = data[0] & 0x0F
    code = data[1]
    msg_id = struct.unpack_from(">H", data, 2)[0]
    pos, opt, segs = 4 + tkl, 0, []
    while pos < len(data) and data[pos] != 0xFF:
        delta, length = data[pos] >> 4, data[pos] & 0x0F
        pos += 1
        if delta == 13:
            delta = 13 + data[pos]; pos += 1
        if length == 13:
            length = 13 + data[pos]; pos += 1
        opt += delta
        if opt == URI_PATH:
            segs.append(data[pos:pos + length].decode(errors="replace"))
        pos += length
    if pos < len(data) and data[pos] == 0xFF:
        pos += 1
    return mtype, code, msg_id, "/" + "/".join(segs), bytes(data[pos:])


# What OI3 publishes back on /mode after an /s-mode (k3ng_keyer.ino
# civModeToOi3() then oi3ModeToCiv()): its own keyer mode, rounded.
OI3_MODE_ECHO = {0x00: 0x01, 0x01: 0x01, 0x02: 0x01, 0x03: 0x03, 0x04: 0x04,
                 0x05: 0x05, 0x06: 0x01, 0x07: 0x03, 0x08: 0x04}


class FakeOi3(threading.Thread):
    """Records every topic local-trx sends it, ACKs CON, echoes /s-hz and
    /s-mode the way OI3 does, answers /s-ptt with /ptt."""

    def __init__(self):
        super().__init__(daemon=True)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", FAKE_PORT))
        self.sock.settimeout(0.05)
        self.events = []          # (t, path, payload, mtype)
        self.announces = []       # (t, name, announced port, src)
        self.lock = threading.Lock()
        self.ltx = None           # (ip, port) learned from its ANNOUNCE
        self.msg_id = 1000
        self.ptt_echo = True
        self.stop = False

    def send_topic(self, path, payload, mtype=COAP_NON):
        if not self.ltx:
            return
        self.msg_id += 1
        self.sock.sendto(coap(path, payload, mtype, self.msg_id), self.ltx)

    def run(self):
        while not self.stop:
            try:
                data, src = self.sock.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                return
            now = time.monotonic()
            if data and data[0] == DISC_MAGIC and len(data) >= 6:
                n = data[3]
                name = data[4:4 + n].decode(errors="replace")
                port = struct.unpack_from(">H", data, 4 + n)[0]
                with self.lock:
                    self.announces.append((now, name, port, src))
                    if name.startswith("LTX."):
                        self.ltx = (src[0], port)
                if data[2] == DISC_PROBE:
                    self.sock.sendto(discovery(DISC_ANNOUNCE, FAKE_NAME, FAKE_PORT), (src[0], port))
                continue
            mtype, code, msg_id, path, payload = parse_coap(data)
            if mtype == COAP_ACK:
                continue
            if mtype == COAP_CON:
                self.sock.sendto(bytes([(1 << 6) | (COAP_ACK << 4), 0x00]) + struct.pack(">H", msg_id), src)
            with self.lock:
                self.events.append((now, path, payload, mtype))
            if path == "/s-ptt" and self.ptt_echo and payload:
                self.send_topic("/ptt", bytes([payload[0]]))
            elif path == "/s-hz" and len(payload) >= 4:
                self.send_topic("/hz", payload[:4])
            elif path == "/s-mode" and payload:
                self.send_topic("/mode", bytes([OI3_MODE_ECHO.get(payload[0], 0x01)]))

    def topics(self, path, since=0.0):
        with self.lock:
            return [e for e in self.events if e[1] == path and e[0] >= since]


# ---- ICOM-LAN CI-V client (local-trx-ptt-check.py's handshake) ----------------

class Civ:
    def __init__(self, ip, port, civ_addr, timeout=2.0):
        self.addr = (ip, port)
        self.civ = civ_addr
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))
        self.sock.settimeout(timeout)
        self.my_id = 0xAABBCC11
        self.remote_id = 0
        self.seq = 0

    def open(self):
        self.sock.sendto(hdr16(0x03, 0, self.my_id, 0), self.addr)
        data, _ = self.sock.recvfrom(4096)
        self.remote_id = struct.unpack_from("<IHHII", data, 0)[3]
        self.sock.sendto(hdr16(0x06, 0, self.my_id, self.remote_id), self.addr)
        self.sock.recvfrom(4096)
        p = bytearray(0x16)
        struct.pack_into("<I", p, 0, 0x16)
        struct.pack_into("<II", p, 8, self.my_id, self.remote_id)
        p[0x15] = 0x05
        self.sock.sendto(bytes(p), self.addr)

    def exchange(self, body, timeout=1.5):
        frame = bytes([0xFE, 0xFE, self.civ, CTRL_ADDR]) + bytes(body) + bytes([0xFD])
        p = bytearray(0x15)
        struct.pack_into("<I", p, 0, 0x15 + len(frame))
        struct.pack_into("<II", p, 8, self.my_id, self.remote_id)
        p[0x10] = 0xC1
        struct.pack_into("<H", p, 0x11, len(frame))
        struct.pack_into(">H", p, 0x13, self.seq)
        self.seq += 1
        self.sock.sendto(bytes(p) + frame, self.addr)
        # Skip unsolicited transceive frames (CivChannel::tick) and keepalives:
        # the reply is the one addressed to us whose command is ours or an ack.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data, _ = self.sock.recvfrom(4096)
            except socket.timeout:
                return None
            if len(data) > 0x15 and data[0x10] == 0xC1:
                n = struct.unpack_from("<H", data, 0x11)[0]
                reply = bytes(data[0x15:0x15 + n])
                if len(reply) >= 6 and reply[2] == CTRL_ADDR and reply[4] in (body[0], 0xFB, 0xFA):
                    return reply[4:-1]
        return None


def bcd_to_hz(b):
    hz, mult = 0, 1
    for byte in b:
        hz += (byte & 0x0F) * mult + (byte >> 4) * mult * 10
        mult *= 100
    return hz


def hz_to_bcd(hz):
    out = []
    for _ in range(5):
        two = hz % 100
        out.append(((two // 10) << 4) | (two % 10))
        hz //= 100
    return out


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--bin", default=os.path.join(root, "local-trx", "build", "local-trx"))
    args = parser.parse_args()

    results = []

    def check(label, ok, detail=""):
        results.append(ok)
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}{(' -- ' + detail) if detail else ''}")

    fake = FakeOi3()
    fake.start()

    workdir = tempfile.mkdtemp(prefix="local-trx-trxnet-")
    config = {
        "enabled": True,
        "listenIp": LAN_IP,
        "audio": {"inputDevice": "", "outputDevice": ""},
        "cat": {"backend": "trxnet"},
        "keying": {"cwBackend": "trxnet", "pttBackend": "trxnet", "port": "", "fskNetId": 0x5e},
        "trxnet": {"peer": FAKE_NAME, "netId": LTX_ID, "localPort": LTX_PORT, "networkPort": FAKE_PORT},
    }
    with open(os.path.join(workdir, "config.json"), "w") as f:
        json.dump(config, f)
    log = open(os.path.join(workdir, "local-trx.log"), "w")
    proc = subprocess.Popen([args.bin, "--config-dir", workdir, "--web-port", "0"],
                            stdout=log, stderr=subprocess.STDOUT)
    try:
        time.sleep(0.8)
        if proc.poll() is not None:
            print("local-trx exited at startup, see " + log.name, file=sys.stderr)
            return 2

        # -- discovery: unicast PROBE, announcing our port -------------------
        fake.sock.sendto(discovery(DISC_PROBE, FAKE_NAME, FAKE_PORT), ("127.0.0.1", LTX_PORT))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not fake.ltx:
            time.sleep(0.05)
        check("discovery: local-trx answers at the prober's announced port",
              fake.ltx is not None and fake.ltx[1] == LTX_PORT,
              f"got {fake.ltx}" if fake.ltx else "no ANNOUNCE from LTX.*")
        names = {a[1] for a in fake.announces}
        check("discovery: it is LTX.42", f"LTX.{LTX_ID:02x}" in names, ", ".join(sorted(names)))
        if not fake.ltx:
            return 1

        civ = Civ(LAN_IP, 50002, 0xA6)
        civ.open()

        # -- CAT read ---------------------------------------------------------
        fake.send_topic("/hz", struct.pack("<I", 14074000))
        fake.send_topic("/mode", bytes([0x03]))
        time.sleep(0.3)
        r = civ.exchange([0x03])
        hz = bcd_to_hz(r[1:6]) if r and len(r) >= 6 else None
        check("CAT read: /hz 14074000 -> CI-V 0x03", hz == 14074000, f"got {hz}")
        r = civ.exchange([0x04])
        check("CAT read: /mode CW -> CI-V 0x04", bool(r) and len(r) >= 2 and r[1] == 0x03,
              f"got {r.hex() if r else None}")

        # -- CAT write --------------------------------------------------------
        t0 = time.monotonic()
        r = civ.exchange([0x05] + hz_to_bcd(7074000))
        time.sleep(0.3)
        got = [struct.unpack("<I", e[2][:4])[0] for e in fake.topics("/s-hz", t0) if len(e[2]) >= 4]
        check("CAT write: CI-V 0x05 -> /s-hz 7074000", got == [7074000], f"got {got}, reply {r.hex() if r else None}")
        t0 = time.monotonic()
        civ.exchange([0x06, 0x01, 0x01])
        time.sleep(0.3)
        got = [e[2][0] for e in fake.topics("/s-mode", t0) if e[2]]
        check("CAT write: CI-V 0x06 USB -> /s-mode 0x01", got == [0x01], f"got {got}")
        r = civ.exchange([0x04])
        check("CAT read: wifilt's USB survives the device's mode echo", bool(r) and r[1] == 0x01,
              f"got {r.hex() if r else None}")
        t0 = time.monotonic()
        civ.exchange([0x26, 0x00, 0x01, 0x01, 0x01])   # JS8: USB-D
        time.sleep(0.3)
        got = [e[2][0] for e in fake.topics("/s-mode", t0) if e[2]]
        r = civ.exchange([0x26, 0x00])
        check("CAT write: CI-V 0x26 USB-D -> /s-mode 0x01, USB-D reads back after the echo",
              got == [0x01] and r == bytes([0x26, 0x00, 0x01, 0x01, 0x01]),
              f"sent {got}, read {r.hex() if r else None}")
        fake.send_topic("/mode", bytes([0x03]))   # operator turns the keyer to CW
        time.sleep(0.2)
        r = civ.exchange([0x26, 0x00])
        check("CAT read: a mode change at the device replaces it", bool(r) and r[2] == 0x03 and r[3] == 0x00,
              f"got {r.hex() if r else None}")

        # -- CW ---------------------------------------------------------------
        t0 = time.monotonic()
        civ.exchange([0x17] + list(b"CQ TEST "))
        civ.exchange([0x17] + list(b"DE OK1HRA"))
        time.sleep(0.4)
        got = [(e[2], e[3]) for e in fake.topics("/s-cw", t0)]
        check("CW: two CI-V 0x17 frames -> one /s-cw, CON",
              got == [(b"CQ TEST DE OK1HRA", COAP_CON)], f"got {got}")

        # -- PTT lease --------------------------------------------------------
        t0 = time.monotonic()
        r = civ.exchange([0x1C, 0x00, 0x01])
        check("PTT: CI-V 0x1C on acknowledged", r == bytes([0x1C, 0x00, 0x01]) or r == bytes([0xFB]),
              f"got {r.hex() if r else None}")
        time.sleep(1.3)
        on = [e for e in fake.topics("/s-ptt", t0) if e[2][:1] == b"\x01"]
        first = (on[0][0] - t0) if on else None
        gaps = [b[0] - a[0] for a, b in zip(on, on[1:])]
        check("PTT: /s-ptt 1 sent at once", first is not None and first < 0.2,
              f"after {first:.3f} s" if first is not None else "never")
        check("PTT: renewed every ~300 ms (lease 1500 ms)",
              len(on) >= 4 and all(0.2 < g < 0.45 for g in gaps),
              f"{len(on)} sends, gaps {[round(g, 3) for g in gaps]}")
        check("PTT: all TRX_NON (a CON retransmit could re-key)",
              all(e[3] == COAP_NON for e in fake.topics("/s-ptt", t0)))
        t1 = time.monotonic()
        civ.exchange([0x1C, 0x00, 0x00])
        time.sleep(0.8)
        after = fake.topics("/s-ptt", t1)
        offs = [e for e in after if e[2][:1] == b"\x00"]
        check("PTT: off -> /s-ptt 0 three times within 300 ms, no 1 after",
              len(offs) == 3 and all(e[2][:1] == b"\x00" for e in after)
              and offs[-1][0] - offs[0][0] < 0.3,
              f"{[(round(e[0] - t1, 3), e[2].hex()) for e in after]}")

        # -- shutdown while keyed ----------------------------------------------
        civ.exchange([0x1C, 0x00, 0x01])
        time.sleep(0.5)
        t2 = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)
        time.sleep(0.2)
        offs = [e for e in fake.topics("/s-ptt", t2) if e[2][:1] == b"\x00"]
        check("shutdown: SIGTERM while keyed sends /s-ptt 0", len(offs) >= 1, f"{len(offs)} zeros")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        fake.stop = True
        log.close()

    with open(log.name) as f:
        text = f.read()
    check("log: no 'no /ptt' warning (the fake confirmed)", "no /ptt from" not in text)
    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} checks passed (log: {log.name})")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
