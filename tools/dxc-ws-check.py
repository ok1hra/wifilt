#!/usr/bin/env python3
"""
Check the DX-cluster relay: browser WebSocket on port 82 <-> firmware <-> telnet.

Pair with tools/dxc-fake-cluster.py. The telnet connection is opened lazily --
DxcLoop() returns immediately while no WebSocket client is attached -- so
nothing happens until something connects here, which is the whole reason this
tool exists rather than a plain "is it connected" probe.

  python3 tools/dxc-ws-check.py [--host 127.0.0.1] [--port 82] [--seconds 12]

Exit 0 when spots arrive over the WebSocket.
"""

import argparse
import base64
import hashlib
import os
import socket
import struct
import sys
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def read_frames(sock, initial, seconds):
    buffer = bytearray(initial)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        while len(buffer) >= 2:
            opcode, length, offset = buffer[0] & 0x0F, buffer[1] & 0x7F, 2
            if length == 126:
                if len(buffer) < 4: break
                length, offset = struct.unpack(">H", buffer[2:4])[0], 4
            elif length == 127:
                if len(buffer) < 10: break
                length, offset = struct.unpack(">Q", buffer[2:10])[0], 10
            if len(buffer) < offset + length: break
            yield opcode, bytes(buffer[offset:offset + length])
            del buffer[:offset + length]
        sock.settimeout(0.4)
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            return
        buffer += chunk


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=82)
    parser.add_argument("--path", default="/dxcws")
    parser.add_argument("--seconds", type=float, default=12)
    args = parser.parse_args()

    key = base64.b64encode(os.urandom(16)).decode()
    expect = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()

    try:
        sock = socket.create_connection((args.host, args.port), timeout=6)
    except OSError as error:
        print(f"cannot reach ws://{args.host}:{args.port} -- {error}")
        return 1

    sock.sendall((
        f"GET {args.path} HTTP/1.1\r\nHost: {args.host}:{args.port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())

    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(4096)
        if not chunk:
            print("server closed during upgrade")
            return 1
        head += chunk
    header, rest = head.split(b"\r\n\r\n", 1)
    text = header.decode(errors="replace")
    accept = next((line.split(":", 1)[1].strip() for line in text.splitlines()
                   if line.lower().startswith("sec-websocket-accept:")), "")

    checks = [
        ("101 switching protocols", "101" in text.splitlines()[0]),
        ("Sec-WebSocket-Accept correct", accept == expect),
    ]

    lines = []
    for opcode, payload in read_frames(sock, rest, args.seconds):
        if opcode == 0x1:
            lines.extend(l for l in payload.decode(errors="replace").splitlines() if l.strip())
    sock.close()

    greeted = any("cluster" in l.lower() or "call" in l.lower() for l in lines)
    spots = [l for l in lines if l.startswith("DX de")]

    checks.append(("cluster greeting relayed", greeted))
    checks.append(("DX spots relayed", len(spots) > 0))

    failed = 0
    for name, ok in checks:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
        if not ok:
            failed += 1
    if spots:
        print(f"       first spot: {spots[0][:70]}")
    print(f"\nDXC {'PASS' if not failed else 'FAIL'} "
          f"({len(checks) - failed}/{len(checks)} checks, {len(lines)} lines)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
