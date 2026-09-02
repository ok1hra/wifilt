#!/usr/bin/env python3
"""
CI-V 0x1C (PTT) check for local-trx (bod: Dávka 2 fáze 3).

WHY THIS EXISTS
    Talks straight to local-trx's CI-V port, the same way
    tools/icom-lan-login-test.py and tools/local-trx-audio-check.py talk
    directly to their own channels instead of going through wifilt. Proves
    civ_router.cpp's 0x1C handling and its wiring into KeyRunner::
    setAudioPtt() -- the exact bytes audioPttOn()/audioPttOff() send
    ({0x1C,0x00,0x01} / {0x1C,0x00,0x00}, wifilt.ino:9427,9436) -- reach the
    keying subsystem and get acknowledged with the resulting state.

USAGE
    python3 tools/local-trx-ptt-check.py [--ip 127.0.0.3] [--civaddr A6]

Exit codes:
  0  handshake completed and all three PTT exchanges (on/read/off) matched
  2  no reply to AreYouThere on the CI-V port
  3  handshake stalled
  4  a PTT exchange got no reply or an unexpected one
"""

import argparse
import socket
import struct
import sys

from local_trx_wire import hdr16

CTRL_ADDR = 0xE1   # deviation 6, docs/icom-lan-implementace.md


def main():
    parser = argparse.ArgumentParser(description="local-trx CI-V 0x1C (PTT) check")
    parser.add_argument("--ip", default="127.0.0.3")
    parser.add_argument("--port", type=int, default=50002)
    parser.add_argument("--civaddr", default="A6", help="local-trx's identity.civAddress, hex")
    parser.add_argument("--timeout", type=float, default=3.0)
    args = parser.parse_args()
    civ_addr = int(args.civaddr, 16)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 0))
    sock.settimeout(args.timeout)
    my_id = 0xAABBCCDD

    sock.sendto(hdr16(0x03, 0, my_id, 0), (args.ip, args.port))   # AreYouThere
    try:
        data, _ = sock.recvfrom(4096)
    except socket.timeout:
        print("no reply to AreYouThere -- CI-V channel not listening", file=sys.stderr)
        return 2
    _, ptype, _, remote_id, _ = struct.unpack_from("<IHHII", data, 0)
    if ptype != 0x04:
        print(f"unexpected reply type=0x{ptype:x}", file=sys.stderr)
        return 3

    sock.sendto(hdr16(0x06, 0, my_id, remote_id), (args.ip, args.port))   # AreYouReady
    try:
        sock.recvfrom(4096)
    except socket.timeout:
        print("no reply to AreYouReady -- handshake stalled", file=sys.stderr)
        return 3

    # civ-open, magic 0x05 (deviation 5) -- a 0x16-byte long-header packet.
    p = bytearray(0x16)
    struct.pack_into("<I", p, 0, 0x16)
    struct.pack_into("<II", p, 8, my_id, remote_id)
    p[0x15] = 0x05
    sock.sendto(bytes(p), (args.ip, args.port))

    seq_b = [0]

    def send_civ(frame):
        p = bytearray(0x15)
        struct.pack_into("<I", p, 0, 0x15 + len(frame))
        struct.pack_into("<II", p, 8, my_id, remote_id)
        p[0x10] = 0xC1
        struct.pack_into("<H", p, 0x11, len(frame))
        struct.pack_into(">H", p, 0x13, seq_b[0])
        seq_b[0] += 1
        sock.sendto(bytes(p) + frame, (args.ip, args.port))

    def recv_civ_reply():
        for _ in range(5):
            try:
                data, _ = sock.recvfrom(4096)
            except socket.timeout:
                return None
            if len(data) > 0x15 and data[0x10] == 0xC1:
                length = struct.unpack_from("<H", data, 0x11)[0]
                return bytes(data[0x15:0x15 + length])
        return None

    def check(label, body, expect):
        send_civ(bytes([0xFE, 0xFE, civ_addr, CTRL_ADDR]) + bytes(body) + bytes([0xFD]))
        reply = recv_civ_reply()
        expected = bytes([0xFE, 0xFE, CTRL_ADDR, civ_addr]) + bytes(expect) + bytes([0xFD])
        ok = reply == expected
        print(f"  {'ok' if ok else 'FAIL'}  {label}: {reply.hex() if reply else None}")
        return ok

    all_ok = True
    all_ok &= check("PTT ON  (audioPttOn's own bytes)", [0x1C, 0x00, 0x01], [0x1C, 0x00, 0x01])
    all_ok &= check("PTT read (subcommand only)", [0x1C, 0x00], [0x1C, 0x00, 0x01])
    all_ok &= check("PTT OFF (audioPttOff's own bytes)", [0x1C, 0x00, 0x00], [0x1C, 0x00, 0x00])

    if not all_ok:
        return 4
    print("\nAll CI-V 0x1C exchanges matched. OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
