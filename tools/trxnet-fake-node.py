#!/usr/bin/env python3
"""
A bare TrxNet node for tests: joins discovery under a given name and records
every CoAP topic it is sent, one JSON object per line.

    tools/trxnet-fake-node.py --name OI3.77 --target 10.98.0.1:5683 --record oi3.jsonl

It sends a PROBE to --target at start, then an ANNOUNCE every --every seconds
(TrxNet ages a peer out after 95 s; tests want faster), answers PROBEs, and
ACKs CON packets so the sender does not retransmit. Used by
tools/host-status-native-check.sh as the OI3, as local-trx's LTX node and as
local-trx's FSK stand-in.
"""

import argparse
import json
import socket
import struct
import sys
import time

DISC_MAGIC, DISC_VERSION, DISC_PROBE, DISC_ANNOUNCE = 0xAA, 0x01, 0x01, 0x02
COAP_CON, COAP_NON, COAP_ACK, URI_PATH = 0, 1, 2, 11


def discovery(ptype, name, port):
    n = name.encode()
    return bytes([DISC_MAGIC, DISC_VERSION, ptype, len(n)]) + n + struct.pack(">H", port)


def parse_coap(data):
    mtype = (data[0] >> 4) & 0x03
    tkl = data[0] & 0x0F
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
    return mtype, msg_id, "/" + "/".join(segs), bytes(data[pos:])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--name", required=True)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=5683, help="own UDP port, announced")
    ap.add_argument("--target", required=True, help="host:port to PROBE/ANNOUNCE to")
    ap.add_argument("--every", type=float, default=2.0)
    ap.add_argument("--seconds", type=float, default=120)
    ap.add_argument("--record", help="JSON lines of received topics (default stdout)")
    args = ap.parse_args()

    host, port = args.target.rsplit(":", 1)
    target = (host, int(port))
    out = open(args.record, "a", buffering=1) if args.record else sys.stdout

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # The interface may still be coming up (a namespace being wired); retry.
    deadline = time.monotonic() + 10
    while True:
        try:
            sock.bind((args.bind, args.port))
            break
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.1)
    sock.settimeout(0.1)

    def send(pkt, dest):
        try:
            sock.sendto(pkt, dest)
        except OSError:
            pass    # no route yet

    send(discovery(DISC_PROBE, args.name, args.port), target)
    next_announce = time.monotonic() + args.every
    end = time.monotonic() + args.seconds
    while time.monotonic() < end:
        if time.monotonic() >= next_announce:
            send(discovery(DISC_ANNOUNCE, args.name, args.port), target)
            next_announce = time.monotonic() + args.every
        try:
            data, src = sock.recvfrom(2048)
        except socket.timeout:
            continue
        except OSError:
            continue
        if not data:
            continue
        if data[0] == DISC_MAGIC and len(data) >= 6:
            if data[2] == DISC_PROBE:
                n = data[3]
                their = struct.unpack_from(">H", data, 4 + n)[0] or 5683
                send(discovery(DISC_ANNOUNCE, args.name, args.port), (src[0], their))
            continue
        mtype, msg_id, path, payload = parse_coap(data)
        if mtype == COAP_ACK:
            continue
        if mtype == COAP_CON:
            send(bytes([(1 << 6) | (COAP_ACK << 4), 0x00]) + struct.pack(">H", msg_id), src)
        out.write(json.dumps({"t": time.time(), "from": f"{src[0]}:{src[1]}", "path": path,
                              "mtype": mtype, "hex": payload.hex()}) + "\n")


if __name__ == "__main__":
    main()
