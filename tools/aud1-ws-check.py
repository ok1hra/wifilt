#!/usr/bin/env python3
"""
Check the AUD1 audio WebSocket end to end and verify the samples survive.

Claims the single-operator session, opens ws://<host>:83/audiows, and measures
what comes back. Paired with tools/icom-lan-fake-radio.py -- which streams a
known tone -- this proves the whole chain: radio UDP -> the firmware's dedicated
audio thread -> ring buffer -> WebSocket framing -> browser.

Checking the tone rather than just counting bytes is the point: a shim that
drops or reorders samples still produces plenty of traffic.

  python3 tools/aud1-ws-check.py [--http http://127.0.0.1:8080]
                                 [--ws-port 83] [--seconds 5]
                                 [--expect-hz 1000]

Exit 0 when the stream arrives intact, 1 otherwise.
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import time
import urllib.request

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
AUD1_HEADER = 40          # payload starts here; see data/js8-aud1.js


def ulaw_decode(byte):
    byte = ~byte & 0xFF
    sign, exponent, mantissa = byte & 0x80, (byte >> 4) & 0x07, byte & 0x0F
    value = (((mantissa << 3) + 0x84) << exponent) - 0x84
    return -value if sign else value


def claim_session(http, token):
    request = urllib.request.Request(
        http + "/js8/session/claim",
        data=json.dumps({"token": token}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode() or "{}")


def read_frames(sock, initial, seconds):
    """Yield (opcode, payload) until the window closes."""
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
        sock.settimeout(0.3)
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            return
        buffer += chunk


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--http", default="http://127.0.0.1:8080")
    parser.add_argument("--ws-host", default="127.0.0.1")
    parser.add_argument("--ws-port", type=int, default=83)
    parser.add_argument("--seconds", type=float, default=5)
    parser.add_argument("--expect-hz", type=float, default=0,
                        help="verify the decoded tone is this frequency (0 = skip)")
    parser.add_argument("--min-samples", type=int, default=8000)
    args = parser.parse_args()

    # Token alphabet is UUID-only; anything else is refused with 400.
    token = base64.b16encode(os.urandom(8)).decode().lower()
    checks = []

    try:
        session = claim_session(args.http, token)
    except Exception as error:
        print(f"session claim failed: {error}")
        return 1
    checks.append(("session granted", session.get("state") in ("granted", "renewed")))

    key = base64.b64encode(os.urandom(16)).decode()
    expect = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()

    try:
        sock = socket.create_connection((args.ws_host, args.ws_port), timeout=6)
    except OSError as error:
        print(f"cannot reach ws://{args.ws_host}:{args.ws_port} -- {error}")
        return 1

    sock.sendall((
        f"GET /audiows?token={token} HTTP/1.1\r\n"
        f"Host: {args.ws_host}:{args.ws_port}\r\n"
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
    checks.append(("101 switching protocols", "101" in text.splitlines()[0]))
    checks.append(("Sec-WebSocket-Accept correct", accept == expect))

    hello, samples, sequences = None, [], []
    rates = set()
    for opcode, payload in read_frames(sock, rest, args.seconds):
        if opcode == 0x1:
            try:
                message = json.loads(payload.decode())
                if message.get("type") == "hello":
                    hello = message
            except Exception:
                pass
        elif opcode == 0x2 and len(payload) > AUD1_HEADER:
            sequences.append(struct.unpack(">I", payload[16:20])[0])
            rates.add(struct.unpack(">I", payload[20:24])[0])
            samples.extend(ulaw_decode(b) for b in payload[AUD1_HEADER:])
    sock.close()

    checks.append(("AUD1 hello received", hello is not None and hello.get("protocol") == "AUD1"))
    checks.append((f"at least {args.min_samples} samples", len(samples) >= args.min_samples))
    checks.append(("sample rate is 8000", rates == {8000} if rates else False))

    gaps = sum(1 for a, b in zip(sequences, sequences[1:]) if b - a != 1)
    checks.append(("sequence continuous (no dropped packets)", gaps == 0))

    if args.expect_hz and len(samples) > 4000:
        window = samples[400:4400]
        crossings = sum(1 for a, b in zip(window, window[1:]) if (a < 0) != (b < 0))
        measured = crossings * 8000 / (2 * len(window))
        peak = max(abs(s) for s in window)
        checks.append((f"tone is {args.expect_hz:.0f} Hz (measured {measured:.0f})",
                       abs(measured - args.expect_hz) < 40))
        checks.append((f"amplitude survived (peak {peak})", peak > 8000))

    failed = 0
    for name, ok in checks:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
        if not ok:
            failed += 1
    print(f"\nAUD1 {'PASS' if not failed else 'FAIL'} "
          f"({len(checks) - failed}/{len(checks)} checks, "
          f"{len(samples)} samples)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
