#!/usr/bin/env python3
"""
CI-V category (b)/(d) extras check for local-trx (bod 11, Dávka 2 fáze 7).

WHY THIS EXISTS
    Same "talk straight to local-trx's CI-V port" pattern as
    tools/local-trx-ptt-check.py, extended to fáze 7's additions:
      - 0x14 0x0A  RF power setting (read+write, wire-identical to AF/RF gain)
      - 0x15       meters: power/SWR/supply-voltage answered, S-meter/ALC never
                   (no verified raw-scale reference to invert -- see
                   src/rig_backend.h's MeterKind comment)
      - 0x11       attenuator engaged (bare read only)
      - 0x16 0x47  VOX engaged (0x16 0x02 preamp is deliberately never
                   answered -- dB<->index has no rig-independent rule)
      - 0x00/0x01  transceive broadcast: an unsolicited push after a CI-V
                   frequency WRITE, not just the write's own ack reply

    Runs against local-trx's hamlib Dummy backend, which reliably grants
    RFPOWER_METER/VD_METER/SWR (verified live 2026-09-01, reproduced across 8
    separate process runs -- see src/hamlib_bridge.cpp's own comment on
    getMeter()) -- so all three meters below are asserted as answered, with a
    live simulated value each time. S-meter/ALC stay asserted UNANSWERED
    regardless of backend: that is civ_router.cpp's own switch never routing
    to rig.getMeter() for them at all (no verified raw-scale reference to
    invert -- see src/rig_backend.h's MeterKind comment), independent of
    anything hamlib/Dummy grants. Real-hardware verification of the actual
    numbers these represent stays open, same as every other
    hamlib-backend-quality item in docs/local-trx-implementace.md's
    "Zbývá ověřit".

USAGE
    python3 tools/local-trx-civ-extras-check.py [--ip 127.0.0.3] [--civaddr A6]

Exit codes:
  0  every exchange (answered and deliberately-unanswered alike) matched
  2  no reply to AreYouThere on the CI-V port
  3  handshake stalled
  4  at least one exchange did not match what fáze 7's implementation promises
"""

import argparse
import socket
import struct
import sys

from local_trx_wire import hdr16

CTRL_ADDR = 0xE1   # deviation 6, docs/icom-lan-implementace.md


def bcd_from_hz(hz):
    # Mirrors civ_router.cpp's bcdFromHz() -- LSB-first packed BCD, 5 bytes.
    s = f"{hz:010d}"
    out = bytearray(5)
    for i in range(5):
        hi, lo = 8 - i * 2, 8 - i * 2 + 1
        out[i] = (int(s[hi]) << 4) | int(s[lo])
    return bytes(out)


def decode_civ_level(b0, b1):
    # Mirrors civ_router.cpp's decodeCivLevel(): b0 is a PLAIN 0-2 hundreds
    # digit (not two BCD nibbles -- the value never exceeds 255), b1 is
    # BCD-packed tens|units.
    return b0 * 100 + (b1 >> 4) * 10 + (b1 & 0x0F)


def main():
    parser = argparse.ArgumentParser(description="local-trx CI-V category (b)/(d) extras check")
    parser.add_argument("--ip", default="127.0.0.3")
    parser.add_argument("--port", type=int, default=50002)
    parser.add_argument("--civaddr", default="A6", help="local-trx's identity.civAddress, hex")
    parser.add_argument("--timeout", type=float, default=3.0)
    args = parser.parse_args()
    civ_addr = int(args.civaddr, 16)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 0))
    sock.settimeout(args.timeout)
    my_id = 0x11223344

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

    p = bytearray(0x16)   # civ-open, magic 0x05 (deviation 5)
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

    def recv_civ_frame(timeout):
        sock.settimeout(timeout)
        try:
            data, _ = sock.recvfrom(4096)
        except socket.timeout:
            return None
        if len(data) > 0x15 and data[0x10] == 0xC1:
            length = struct.unpack_from("<H", data, 0x11)[0]
            return bytes(data[0x15:0x15 + length])
        return None

    def send_and_wait(body, timeout=2.0):
        send_civ(bytes([0xFE, 0xFE, civ_addr, CTRL_ADDR]) + bytes(body) + bytes([0xFD]))
        return recv_civ_frame(timeout)

    all_ok = True

    def expect_exact(label, body, expect_payload):
        frame = send_and_wait(body)
        expected = bytes([0xFE, 0xFE, CTRL_ADDR, civ_addr]) + bytes(expect_payload) + bytes([0xFD])
        ok = frame == expected
        print(f"  {'ok' if ok else 'FAIL'}  {label}: {frame.hex() if frame else None}")
        return ok

    def expect_no_reply(label, body):
        frame = send_and_wait(body, timeout=0.6)
        ok = frame is None
        print(f"  {'ok' if ok else 'FAIL'}  {label}: expected no reply, got {frame.hex() if frame else None}")
        return ok

    def expect_answered_prefix(label, body, cmd, sub):
        frame = send_and_wait(body)
        ok = frame is not None and len(frame) >= 6 and frame[4] == cmd and frame[5] == sub
        extra = decode_civ_level(frame[6], frame[7]) if ok and len(frame) >= 8 else None
        print(f"  {'ok' if ok else 'FAIL'}  {label}: {frame.hex() if frame else None}"
              + (f"  (decoded {extra})" if extra is not None else ""))
        return ok

    # --- 0x14 0x0A RF power: read/write round trip, same shape as AF/RF gain.
    # A write acks bare {0xFB} (civ_router.cpp's ack(), same as AF/RF gain
    # writes) -- it does not echo the value back the way 0x1C PTT does.
    all_ok &= expect_answered_prefix("RF power read", [0x14, 0x0A], 0x14, 0x0A)
    all_ok &= expect_exact("RF power write -> 100", [0x14, 0x0A, 0x01, 0x00], [0xFB])
    all_ok &= expect_answered_prefix("RF power read-back after write", [0x14, 0x0A], 0x14, 0x0A)

    # --- 0x15 meters: power/SWR/supply all reliably answered against Dummy
    # (see module docstring). S-meter/ALC are asserted unanswered regardless
    # of backend: civ_router.cpp's own switch never routes to rig.getMeter()
    # for them at all.
    all_ok &= expect_answered_prefix("power meter (0x15 0x11)", [0x15, 0x11], 0x15, 0x11)
    all_ok &= expect_answered_prefix("SWR meter (0x15 0x12)", [0x15, 0x12], 0x15, 0x12)
    all_ok &= expect_answered_prefix("supply voltage (0x15 0x15)", [0x15, 0x15], 0x15, 0x15)
    all_ok &= expect_no_reply("S-meter (0x15 0x02) -- no verified raw scale, never guessed", [0x15, 0x02])
    all_ok &= expect_no_reply("ALC (0x15 0x13) -- no verified raw scale, never guessed", [0x15, 0x13])

    # --- 0x11 attenuator: bare read, Dummy reports off ---
    all_ok &= expect_exact("attenuator read (off on Dummy)", [0x11], [0x11, 0x00])
    all_ok &= expect_no_reply("attenuator write -- wifilt never sends this shape", [0x11, 0x00])

    # --- 0x16: VOX answered, preamp deliberately never (dB<->index guess) ---
    all_ok &= expect_exact("VOX read (off on Dummy)", [0x16, 0x47], [0x16, 0x47, 0x00])
    all_ok &= expect_no_reply("preamp (0x16 0x02) -- dB<->index has no rig-independent rule", [0x16, 0x02])

    # --- 0x00/0x01 transceive broadcast: write freq, then wait for the
    # UNSOLICITED push (to=broadcast, not to=our own address) on the next
    # CivChannel::tick() cycle (kCivBroadcastPollMs=300ms), separate from the
    # write's own immediate ack.
    new_freq = 14200000
    ack = send_and_wait([0x05] + list(bcd_from_hz(new_freq)))
    ok_ack = ack is not None and ack[4] == 0xFB
    print(f"  {'ok' if ok_ack else 'FAIL'}  freq write ack: {ack.hex() if ack else None}")
    all_ok &= ok_ack

    broadcast = recv_civ_frame(1.0)
    ok_broadcast = (broadcast is not None and len(broadcast) >= 10
                     and broadcast[2] == 0x00        # to = broadcast address, not us
                     and broadcast[4] == 0x00         # CMD_TRANS_FREQ
                     and broadcast[5:10] == bcd_from_hz(new_freq))
    print(f"  {'ok' if ok_broadcast else 'FAIL'}  unsolicited transceive broadcast (bod 11d): "
          f"{broadcast.hex() if broadcast else None}")
    all_ok &= ok_broadcast

    # This CI-V write left hamlib's Dummy backend's shared, process-wide rig
    # state on new_freq -- restore it (unconditionally, pass or fail above)
    # so a caller chaining more checks against the SAME local-trx process
    # (tools/local-trx-integration-test.sh's own frequency assertion) sees
    # Dummy's normal 145000000 default, not whatever this script last wrote.
    restore = send_and_wait([0x05] + list(bcd_from_hz(145000000)))
    if restore is None or restore[4] != 0xFB:
        print("  WARNING: failed to restore frequency to Dummy's default 145000000 -- "
              "a caller expecting that default next will see a stale value", file=sys.stderr)
    recv_civ_frame(1.0)   # drain the matching broadcast for the restore write, if any

    if not all_ok:
        return 4
    print("\nAll CI-V category (b)/(d) exchanges matched. OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
