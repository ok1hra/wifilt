#!/usr/bin/env python3
"""
Audio-channel-only client for local-trx (bod 2, fáze 2: RX audio direction).

WHY THIS EXISTS
    wifilt's own LAN client only opens its audio channel once a browser is
    attached to AUD1 (icomLanClient.h: `if (AudioWsClient.connected() &&
    !client->rxAudioActive()) client->startRxAudio();`) -- so proving
    local-trx's AudioChannel actually streams real captured audio correctly
    needs a client that talks to port 50003 directly, the same way
    tools/icom-lan-login-test.py talks to the control/CI-V ports directly
    instead of going through wifilt. This is the audio-channel equivalent.

    wifilt's own AUD1-WebSocket forwarding (needs CAP_NET_BIND_SERVICE on
    port 83, i.e. `sudo setcap`) is NOT exercised by this script -- it only
    proves local-trx's own protocol behaviour, which is what actually
    determines whether that forwarding would have real audio to work with.

    --check-tx-gap additionally tests the TX direction (client->server, bod:
    fáze 3) on this SAME socket/connection rather than a second one -- purely
    to avoid a second handshake/process, not because a second one would fail
    (AudioChannel's peer_ does re-target on a fresh AreYouThere, see
    tools/local-trx-tx-audio-check.py's own header for that story). Also
    avoids a real trap the standalone script has to work around itself: this
    channel keeps streaming a real captured-audio packet every 20ms
    throughout, so anything waiting on a bare socket-recv timeout to notice
    "no more retransmit requests coming" would never actually see that
    timeout fire.

USAGE
    python3 tools/local-trx-audio-check.py [--ip 127.0.0.3] [--packets 5]
                                            [--check-tx-gap]

Exit codes:
  0  handshake completed, the requested number of well-formed audio packets
     arrived, and (with --check-tx-gap) the injected gap produced exactly
     the expected retransmit requests
  2  no reply to AreYouThere (audio channel not listening)
  3  handshake stalled after AreYouThere
  4  no audio packets arrived (capture device likely not configured/opened)
  5  a received packet failed the wire-format checks
  6  (--check-tx-gap) retransmit requests did not match the injected gap
"""

import argparse
import socket
import struct
import sys
import time

from local_trx_wire import build_audio_packet, hdr16


def check_tx_gap(sock, ip, port, my_id, remote_id):
    """Fáze 3: inject a deliberate gap on the SAME already-handshaken socket
    and confirm AudioChannel::onTxAudio() asks for exactly the missing
    packets back. Returns 0 on success, 6 on mismatch."""
    payload = bytes([0xFF]) * 160   # silence in µ-law
    # Sequence numbers here are independent of the RX side's own outer/inner
    # counters above (this direction has its own, per icom_lan_audio_tx.h's
    # layout) -- start high enough that they cannot collide with anything
    # already exchanged on this socket.
    sock.sendto(build_audio_packet(my_id, remote_id, 100, 100, payload), (ip, port))
    sock.sendto(build_audio_packet(my_id, remote_id, 101, 101, payload), (ip, port))
    sock.sendto(build_audio_packet(my_id, remote_id, 104, 104, payload), (ip, port))   # gap: 102,103 "lost"

    # A fixed WALL-CLOCK deadline, not a per-recv socket timeout: local-trx's
    # own RX side (--check-tx-gap always runs after the RX check above, on
    # the same connected socket) keeps streaming a 184-byte audio packet
    # every 20ms throughout, so a bare `sock.settimeout()` loop would see a
    # non-matching packet well within any window and never actually expire.
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

    print(f"TX gap check: retransmit requests received for outer seq: {got}")
    if got != [102, 103]:
        print(f"FAIL expected [102, 103], got {got}", file=sys.stderr)
        return 6
    print("TX gap of 2 correctly produced retransmit requests for exactly the missing packets. OK")
    return 0


def main():
    parser = argparse.ArgumentParser(description="local-trx audio-channel-only check")
    parser.add_argument("--ip", default="127.0.0.3")
    parser.add_argument("--port", type=int, default=50003)
    parser.add_argument("--packets", type=int, default=5, help="how many to require")
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--check-tx-gap", action="store_true",
                        help="also test fáze 3's TX gap detection on this same connection")
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 0))
    sock.settimeout(args.timeout)

    my_id = 0x12345678
    sock.sendto(hdr16(0x03, 0, my_id, 0), (args.ip, args.port))   # AreYouThere
    try:
        data, _ = sock.recvfrom(4096)
    except socket.timeout:
        print("no reply to AreYouThere -- audio channel not listening", file=sys.stderr)
        return 2
    _, ptype, _, remote_id, _ = struct.unpack_from("<IHHII", data, 0)
    if ptype != 0x04:
        print(f"unexpected reply type=0x{ptype:x} to AreYouThere", file=sys.stderr)
        return 3
    print(f"I-Am-Here: remote_id=0x{remote_id:08x}")

    sock.sendto(hdr16(0x06, 0, my_id, remote_id), (args.ip, args.port))   # AreYouReady
    try:
        data, _ = sock.recvfrom(4096)
    except socket.timeout:
        print("no reply to AreYouReady -- handshake stalled", file=sys.stderr)
        return 3
    print("Ready.")

    print(f"waiting for {args.packets} audio packet(s)...")
    got = 0
    last_outer = last_inner = None
    while got < args.packets:
        try:
            data, _ = sock.recvfrom(4096)
        except socket.timeout:
            break
        if len(data) < 0x18:
            continue   # a stray handshake/keepalive packet, not audio
        total, = struct.unpack_from("<I", data, 0)
        ptype, = struct.unpack_from("<H", data, 4)
        outer_seq, = struct.unpack_from("<H", data, 6)
        my_id_field, remote_id_field = struct.unpack_from("<II", data, 8)
        inner_seq, = struct.unpack_from(">H", data, 0x12)
        paylen, = struct.unpack_from("<H", data, 0x14)
        payload = data[0x18:]

        ok = (total == len(data) and ptype == 0 and my_id_field == remote_id
              and paylen == len(payload) and len(payload) > 0)
        if not ok:
            print(f"FAIL malformed audio packet: total={total} actual={len(data)} "
                  f"type={ptype} my_id_field=0x{my_id_field:08x} paylen={paylen} "
                  f"payload_bytes={len(payload)}", file=sys.stderr)
            return 5
        if last_outer is not None and (outer_seq - last_outer) & 0xFFFF != 1:
            print(f"FAIL outer sequence gap: {last_outer} -> {outer_seq}", file=sys.stderr)
            return 5
        if last_inner is not None and (inner_seq - last_inner) & 0xFFFF != 1:
            print(f"FAIL inner (content) sequence gap: {last_inner} -> {inner_seq}", file=sys.stderr)
            return 5
        last_outer, last_inner = outer_seq, inner_seq
        got += 1
        print(f"  ok  packet {got}: {paylen} bytes uLaw, outer_seq={outer_seq}, "
              f"inner_seq={inner_seq}")

    if got < args.packets:
        print(f"only {got}/{args.packets} packets arrived -- capture device likely "
              "not configured/opened", file=sys.stderr)
        return 4

    print(f"\n{got} well-formed audio packet(s), sequential, byte-exact wire format. OK")

    if args.check_tx_gap:
        return check_tx_gap(sock, args.ip, args.port, my_id, remote_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
