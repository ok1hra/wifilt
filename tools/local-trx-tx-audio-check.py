#!/usr/bin/env python3
"""
TX audio (client->server, bod: Dávka 2 fáze 3) gap-detection check for local-trx.

WHY THIS EXISTS
    Talks straight to local-trx's audio port, injecting synthetic audio
    packets shaped exactly like wifilt's own TX-audio wire format (the same
    0x18-byte header tools/local-trx-audio-check.py's RX side produces, now
    sent IN rather than read back) with a deliberate gap in the sequence.
    Proves AudioChannel::onTxAudio()'s gap detection actually asks the peer
    to resend the missing packets via a real T_RETRANSMIT (outer LE16 seq),
    not just that it decodes -- wifilt's own IcomLanAudioTx keeps a bounded
    replay history specifically to answer such a request.

    Does not exercise wifilt's own TX-sending side (AUD1_TX_STREAM, needs the
    browser's tx.prepare/tx.start dance) -- this is the same "test local-trx
    directly" split as the other tools/local-trx-*-check.py scripts.

    Can run against a local-trx another client already talked to: sending a
    fresh AreYouThere legitimately re-targets AudioChannel's peer_ to this
    script (discovered needed live -- otherwise a real wifilt reconnect from
    a new ephemeral port would leave local-trx stuck answering a dead
    socket). tools/local-trx-integration-test.sh still prefers
    local-trx-audio-check.py's own --check-tx-gap instead of chaining this
    script after it, purely to avoid a second handshake/process, not because
    chaining would fail.

USAGE
    python3 tools/local-trx-tx-audio-check.py [--ip 127.0.0.3]

Exit codes:
  0  handshake completed and the gap produced exactly the expected
     retransmit requests
  2  no reply to AreYouThere on the audio port
  3  handshake stalled
  4  retransmit requests did not match what the injected gap should produce
"""

import argparse
import socket
import struct
import sys
import time

from local_trx_wire import build_audio_packet, hdr16


def main():
    parser = argparse.ArgumentParser(description="local-trx TX-audio gap-detection check")
    parser.add_argument("--ip", default="127.0.0.3")
    parser.add_argument("--port", type=int, default=50003)
    parser.add_argument("--timeout", type=float, default=3.0)
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 0))
    sock.settimeout(args.timeout)
    my_id = 0x99887766

    sock.sendto(hdr16(0x03, 0, my_id, 0), (args.ip, args.port))   # AreYouThere
    try:
        data, _ = sock.recvfrom(4096)
    except socket.timeout:
        print("no reply to AreYouThere -- audio channel not listening", file=sys.stderr)
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
    print(f"handshake done, remote_id=0x{remote_id:08x}")

    payload = bytes([0xFF]) * 160   # silence in µ-law
    # seq 0, 1, then jump to 4 -- a gap of 2 (packets 2 and 3 "lost").
    sock.sendto(build_audio_packet(my_id, remote_id, 0, 0, payload), (args.ip, args.port))
    sock.sendto(build_audio_packet(my_id, remote_id, 1, 1, payload), (args.ip, args.port))
    sock.sendto(build_audio_packet(my_id, remote_id, 4, 4, payload), (args.ip, args.port))

    # A fixed WALL-CLOCK deadline, not a per-recv socket timeout: if a
    # capture device happens to be configured on this local-trx too, its RX
    # side keeps streaming a non-matching packet well within any window,
    # which would keep a bare `sock.settimeout()` loop from ever expiring.
    got = []
    sock.settimeout(0.2)
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        try:
            data, _ = sock.recvfrom(4096)
        except socket.timeout:
            continue
        if len(data) == 16:
            pt, seq = struct.unpack_from("<HH", data, 4)
            if pt == 0x01:   # T_RETRANSMIT
                got.append(seq)

    print(f"retransmit requests received for outer seq: {got}")
    if got != [2, 3]:
        print(f"FAIL expected [2, 3], got {got}", file=sys.stderr)
        return 4

    print("Gap of 2 correctly produced retransmit requests for exactly the missing packets. OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
