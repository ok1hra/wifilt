#!/usr/bin/env python3
"""
Fake ICOM RS-BA1 radio — the server side of the LAN protocol.

WHY THIS EXISTS
    tools/icom-lan-login-test.py is the client half: it proves a PC can talk to
    a real IC-705. This is its mirror. It lets the LAN path be exercised with no
    radio on the bench, which is what makes the native build testable in CI:
    start this, start the binary pointed at it, and assert that /state reports a
    frequency.

    It answers the flow our firmware actually speaks, which is kappanhang's, not
    wfview's. The six IC-705 deviations are honoured deliberately (see
    docs/icom-lan-implementace.md section 2):
      1. the ready exchange (0x06) is answered on EVERY channel, not just control
      2. no resetcap 0x0798 is expected in auth packets
      3. the 0x05 auth gets its own 0x40 reply, which gates the stream request
      4. the client's local ports are 50001/50002/50003 and are not negotiated
      5. civ-open magic is 0x05, not wfview's 0x04
      6. the controller's CI-V address is 0xE1

WHY 127.0.0.2 BY DEFAULT
    The client binds local port 50001 and sends to the radio's port 50001. On one
    address that is a socket talking to itself, so the fake radio takes a
    different loopback address -- all of 127.0.0.0/8 is local on Linux.

USAGE
    python3 tools/icom-lan-fake-radio.py [--ip 127.0.0.2] [--freq 7035920]
                                         [--user hra] [--pass secret] [-v]

    Any username/password is accepted unless --user/--pass are given.

EXIT
    Runs until interrupted. Prints one line per protocol milestone so a test can
    grep for "CONNECTED".
"""

import argparse
import select
import socket
import struct
import sys
import time

CONTROL_PORT = 50001
CIV_PORT = 50002
AUDIO_PORT = 50003

# Packet types in the 16-byte control header.
T_IDLE = 0x00
T_RETRANSMIT = 0x01
T_AREYOUTHERE = 0x03
T_IAMHERE = 0x04
T_READY = 0x06
T_PING = 0x07
T_DISCONNECT = 0x05


def hexdump(data, limit=32):
    text = " ".join(f"{b:02x}" for b in data[:limit])
    return text + (" ..." if len(data) > limit else "")


def bcd_from_hz(hz):
    """5-byte little-endian BCD as ICOM sends frequencies."""
    digits = f"{hz:010d}"[::-1]          # least significant digit first
    out = bytearray()
    for i in range(0, 10, 2):
        out.append((int(digits[i + 1]) << 4) | int(digits[i]))
    return bytes(out)


class Channel:
    """One UDP channel: control, CI-V or audio. They share the handshake."""

    def __init__(self, ip, port, tag, verbose):
        self.tag = tag
        self.verbose = verbose
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((ip, port))
        self.my_id = 0x50000000 | (port & 0xFFFF)
        self.remote_id = 0
        self.peer = None
        self.send_seq = 0
        self.tx_buf = {}
        self.linked = False

    def log(self, message):
        print(f"[{self.tag}] {message}", flush=True)

    def vlog(self, message):
        if self.verbose:
            self.log(message)

    def send(self, data, label):
        if self.peer is None:
            return
        self.vlog(f"-> {label}: {hexdump(data)}")
        self.sock.sendto(data, self.peer)

    def send_control(self, ptype, seq, label):
        self.send(struct.pack("<IHHII", 0x10, ptype, seq, self.my_id, self.remote_id),
                  label)

    def send_tracked(self, packet, label):
        packet = bytearray(packet)
        struct.pack_into("<H", packet, 6, self.send_seq)
        self.tx_buf[self.send_seq] = bytes(packet)
        self.send_seq = (self.send_seq + 1) & 0xFFFF
        self.send(bytes(packet), label)

    def long_header(self, size, inner):
        """Header shared by every auth/capability packet the radio sends."""
        p = bytearray(size)
        struct.pack_into("<IHH", p, 0, size, 0, 0)
        struct.pack_into("<II", p, 8, self.my_id, self.remote_id)
        struct.pack_into(">I", p, 0x10, inner)
        return p

    def handle_common(self, data):
        """Handshake and keepalive. True when the packet was consumed here."""
        if len(data) < 16:
            return True
        ptype, seq = struct.unpack_from("<HH", data, 4)
        sender = struct.unpack_from("<I", data, 8)[0]

        if len(data) == 0x10 and ptype == T_AREYOUTHERE:
            self.remote_id = sender
            self.peer = self.peer or self.last_from
            self.send_control(T_IAMHERE, 0x00, "i-am-here")
            self.log(f"<- AreYouThere from 0x{sender:08x} -> I Am Here")
            return True

        if len(data) == 0x10 and ptype == T_READY:
            # Deviation 1: answered on every channel, including CI-V and audio.
            self.send_control(T_READY, 0x01, "ready")
            if not self.linked:
                self.linked = True
                self.log("<- AreYouReady -> Ready")
            return True

        if len(data) == 0x15 and ptype == T_PING:
            reply, stamp = struct.unpack_from("<BI", data, 0x10)
            if reply == 0x00:
                self.send(struct.pack("<IHHIIBI", 0x15, T_PING, seq,
                                      self.my_id, self.remote_id, 0x01, stamp),
                          "ping-reply")
            return True

        if len(data) == 0x10 and ptype == T_IDLE:
            return True

        if len(data) == 0x10 and ptype == T_RETRANSMIT:
            stored = self.tx_buf.get(seq)
            if stored:
                self.send(stored, "retransmit")
            return True

        if len(data) == 0x10 and ptype == T_DISCONNECT:
            self.log("<- Disconnect")
            self.linked = False
            return True

        return False

    def receive(self):
        try:
            data, addr = self.sock.recvfrom(4096)
        except BlockingIOError:
            return None
        self.last_from = addr
        if self.peer is None:
            self.peer = addr
        return data


class ControlChannel(Channel):
    def __init__(self, ip, verbose, radio_name, civ_addr, user, password):
        super().__init__(ip, CONTROL_PORT, "ctl", verbose)
        self.radio_name = radio_name
        self.civ_addr = civ_addr
        self.user = user
        self.password = password
        self.token = 0x0BADC0DE
        self.tok_request = 0
        self.logged_in = False
        self.streaming = False

    def handle(self, data):
        if self.handle_common(data):
            return
        n = len(data)

        if n == 0x80:
            self.on_login(data)
        elif n == 0x40:
            self.on_token(data)
        elif n == 0x90:
            self.on_stream_request(data)
        else:
            self.vlog(f"<- unhandled len=0x{n:02x}: {hexdump(data)}")

    def on_login(self, data):
        self.tok_request = struct.unpack_from("<H", data, 0x1A)[0]
        self.log(f"<- LOGIN (tokrequest=0x{self.tok_request:04x})")

        p = self.long_header(0x60, 0x50)
        p[0x14] = 0x02
        p[0x15] = 0x00
        struct.pack_into("<H", p, 0x1A, self.tok_request)
        struct.pack_into("<I", p, 0x1C, self.token)
        struct.pack_into("<I", p, 0x30, 0x00000000)   # 0xFEFFFFFF = rejected
        p[0x40:0x40 + 10] = b"fake-radio"
        self.send_tracked(p, "login-response")
        self.logged_in = True
        self.log(f"-> LOGIN OK token=0x{self.token:08x}")

        self.send_capabilities()
        self.send_conninfo()

    def send_capabilities(self):
        # One radio: 0x42 fixed header + 0x66 per entry. commoncap and the MAC
        # live inside the leading 16 bytes the client reads as a GUID.
        size = 0x42 + 0x66
        p = self.long_header(size, size - 0x10)
        p[0x14] = 0x02
        p[0x15] = 0x01
        struct.pack_into("<H", p, 0x1A, self.tok_request)
        struct.pack_into("<I", p, 0x1C, self.token)

        base = 0x42
        struct.pack_into("<H", p, base + 0x07, 0x8010)          # commoncap
        p[base + 0x0A:base + 0x10] = bytes([0x02, 0x00, 0xDE, 0xAD, 0xBE, 0xEF])
        name = self.radio_name.encode()[:0x20]
        p[base + 0x10:base + 0x10 + len(name)] = name
        p[base + 0x52] = self.civ_addr
        self.send_tracked(p, "capabilities")
        self.log(f"-> CAPABILITIES name={self.radio_name!r} civ=0x{self.civ_addr:02x}")

    def send_conninfo(self):
        p = self.long_header(0x90, 0x80)
        p[0x14] = 0x02
        p[0x15] = 0x02
        struct.pack_into("<H", p, 0x1A, self.tok_request)
        struct.pack_into("<I", p, 0x1C, self.token)
        name = self.radio_name.encode()[:0x20]
        p[0x40:0x40 + len(name)] = name
        struct.pack_into("<I", p, 0x60, 0)                      # busy = free
        self.send_tracked(p, "conninfo")
        self.log("-> CONNINFO (radio free)")

    def on_token(self, data):
        magic = data[0x15]
        self.vlog(f"<- token packet magic=0x{magic:02x}")
        # Deviation 3: the 0x05 auth must get its own reply -- that reply is what
        # gates the client's stream request. 0x02 is deliberately left unanswered,
        # exactly as the radio behaves.
        if magic != 0x05:
            return
        p = self.long_header(0x40, 0x30)
        p[0x14] = 0x02
        p[0x15] = 0x05
        struct.pack_into("<H", p, 0x1A, self.tok_request)
        struct.pack_into("<I", p, 0x1C, self.token)
        struct.pack_into("<I", p, 0x30, 0x00000000)
        self.send_tracked(p, "auth-0x05-reply")
        self.log("-> AUTH 0x05 acknowledged (stream request unblocked)")

    def on_stream_request(self, data):
        self.log("<- STREAM REQUEST")
        p = self.long_header(0x50, 0x40)
        p[0x14] = 0x02
        p[0x15] = 0x03
        struct.pack_into("<H", p, 0x1A, self.tok_request)
        struct.pack_into("<I", p, 0x1C, self.token)
        struct.pack_into("<I", p, 0x30, 0x00000000)             # error = none
        # Deviation 4: fixed ports, not negotiated.
        struct.pack_into(">H", p, 0x42, CIV_PORT)
        struct.pack_into(">H", p, 0x46, AUDIO_PORT)
        self.send_tracked(p, "stream-status")
        self.streaming = True
        self.log(f"-> STATUS civport={CIV_PORT} audioport={AUDIO_PORT}")


class CivChannel(Channel):
    CTRL = 0xE1                                                  # deviation 6

    def __init__(self, ip, verbose, civ_addr, freq_hz, mode):
        super().__init__(ip, CIV_PORT, "civ", verbose)
        self.civ_addr = civ_addr
        self.freq_hz = freq_hz
        self.mode = mode
        self.seq_b = 0
        self.opened = False
        self.answered = 0

    def send_civ(self, frame):
        p = bytearray(0x15)
        struct.pack_into("<I", p, 0, 0x15 + len(frame))
        struct.pack_into("<II", p, 8, self.my_id, self.remote_id)
        p[0x10] = 0xC1
        struct.pack_into("<H", p, 0x11, len(frame))
        struct.pack_into(">H", p, 0x13, self.seq_b)
        self.seq_b = (self.seq_b + 1) & 0xFFFF
        self.send_tracked(bytes(p) + frame, f"CIV {hexdump(frame)}")

    def handle(self, data):
        if self.handle_common(data):
            return
        n = len(data)

        if n == 0x16:
            # Deviation 5: the client opens the stream with magic 0x05.
            magic = data[0x15]
            if magic == 0x05 and not self.opened:
                self.opened = True
                self.log("<- civ-open (magic 0x05) -- CI-V stream up")
            elif magic == 0x00:
                self.opened = False
                self.log("<- civ-close")
            return

        if n > 0x15 and data[0x10] == 0xC1:
            length = struct.unpack_from("<H", data, 0x11)[0]
            self.on_civ_frame(bytes(data[0x15:0x15 + length]))
            return

        self.vlog(f"<- unhandled len=0x{n:02x}: {hexdump(data)}")

    def on_civ_frame(self, frame):
        if len(frame) < 5 or frame[0] != 0xFE or frame[1] != 0xFE:
            return
        to, sender, cmd = frame[2], frame[3], frame[4]
        if to != self.civ_addr:
            return
        body = frame[5:-1]
        self.vlog(f"<- CIV cmd=0x{cmd:02x} body={hexdump(body)}")

        def reply(payload):
            self.send_civ(bytes([0xFE, 0xFE, sender, self.civ_addr]) + payload + b"\xFD")
            self.answered += 1

        if cmd == 0x03:                      # read operating frequency
            reply(bytes([0x03]) + bcd_from_hz(self.freq_hz))
            if self.answered == 1:
                self.log(f"-> frequency {self.freq_hz} Hz")
        elif cmd == 0x04:                    # read operating mode
            reply(bytes([0x04, self.mode, 0x01]))
        elif cmd == 0x15:                    # meters (S-meter, SWR, power...)
            reply(bytes([0x15]) + bytes(body[:1]) + b"\x00\x00")
        elif cmd == 0x14:                    # levels
            reply(bytes([0x14]) + bytes(body[:1]) + b"\x00\x00")
        elif cmd == 0x1C:                    # TX state / tuner
            reply(bytes([0x1C]) + bytes(body[:1]) + b"\x00")
        else:
            # Everything else is acknowledged so the client's poll rotation keeps
            # turning instead of stalling on an unanswered command.
            reply(b"\xFB")


def ulaw_encode(sample):
    """16-bit signed PCM -> 8-bit mu-law (G.711), as the IC-705 streams."""
    BIAS, CLIP = 0x84, 32635
    sign = 0x80 if sample < 0 else 0x00
    if sample < 0:
        sample = -sample
    if sample > CLIP:
        sample = CLIP
    sample += BIAS
    exponent = 7
    mask = 0x4000
    while exponent > 0 and not (sample & mask):
        exponent -= 1
        mask >>= 1
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF


class AudioChannel(Channel):
    """Handshake plus a continuous RX stream, so the whole audio path can run.

    A real IC-705 sends 8 kHz mu-law in small packets. This sends a steady tone
    at the same rate: enough to drive the browser's waterfall and, more to the
    point, to keep the firmware's dedicated audio thread actually busy -- which
    is the only thing that exercises the FreeRTOS shim under load.
    """

    SAMPLE_RATE = 8000
    SAMPLES_PER_PACKET = 160          # 20 ms
    TONE_HZ = 1000

    def __init__(self, ip, verbose, tone=True):
        super().__init__(ip, AUDIO_PORT, "aud", verbose)
        self.tone = tone
        self.audio_seq = 0
        self.next_send = 0.0
        self.phase = 0
        self.packets_sent = 0

    def handle(self, data):
        if self.handle_common(data):
            return
        self.vlog(f"<- audio len={len(data)}: {hexdump(data)}")

    def tick(self, now):
        # Only once the client has completed the handshake on THIS channel --
        # deviation 1 again: the ready exchange happens per channel.
        if not self.tone or not self.linked or self.peer is None:
            return
        if now < self.next_send:
            return
        self.next_send = (now if self.next_send == 0 else self.next_send) + \
            self.SAMPLES_PER_PACKET / self.SAMPLE_RATE

        payload = bytearray()
        for _ in range(self.SAMPLES_PER_PACKET):
            import math
            value = int(12000 * math.sin(2 * math.pi * self.TONE_HZ *
                                         self.phase / self.SAMPLE_RATE))
            payload.append(ulaw_encode(value))
            self.phase += 1

        # 0x18-byte header. The client checks three things and ignores the rest:
        # the declared length must equal the datagram exactly, the type must not
        # be 0x01 (that is a retransmit request), and the audio sequence is a
        # BIG-endian 16-bit at 0x12 while everything around it is little-endian.
        total = 0x18 + len(payload)
        p = bytearray(total)
        struct.pack_into("<I", p, 0x00, total)
        struct.pack_into("<H", p, 0x04, 0x0000)
        struct.pack_into("<H", p, 0x06, self.send_seq)
        struct.pack_into("<I", p, 0x08, self.my_id)
        struct.pack_into("<I", p, 0x0C, self.remote_id)
        struct.pack_into(">H", p, 0x12, self.audio_seq)
        struct.pack_into("<H", p, 0x14, len(payload))
        p[0x18:] = payload

        self.audio_seq = (self.audio_seq + 1) & 0xFFFF
        self.send_seq = (self.send_seq + 1) & 0xFFFF
        self.send(bytes(p), "audio")
        self.packets_sent += 1
        if self.packets_sent == 1:
            self.log(f"-> streaming {self.TONE_HZ} Hz tone, "
                     f"{self.SAMPLES_PER_PACKET} samples/packet mu-law")


def main():
    parser = argparse.ArgumentParser(description="Fake ICOM RS-BA1 radio")
    parser.add_argument("--ip", default="127.0.0.2",
                        help="address to listen on (default 127.0.0.2, so the "
                             "client's own local port 50001 does not collide)")
    parser.add_argument("--freq", type=int, default=7035920, help="frequency in Hz")
    parser.add_argument("--mode", type=lambda v: int(v, 0), default=0x03,
                        help="CI-V mode byte (default 0x03 = CW)")
    parser.add_argument("--civ", type=lambda v: int(v, 0), default=0xA4,
                        help="radio CI-V address (default 0xA4 = IC-705)")
    parser.add_argument("--name", default="IC-705", help="radio name in capabilities")
    parser.add_argument("--user", default=None, help="expected username (any if unset)")
    parser.add_argument("--password", default=None, help="expected password (any if unset)")
    parser.add_argument("--seconds", type=float, default=0,
                        help="exit after this many seconds (0 = run forever)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    try:
        control = ControlChannel(args.ip, args.verbose, args.name, args.civ,
                                 args.user, args.password)
        civ = CivChannel(args.ip, args.verbose, args.civ, args.freq, args.mode)
        audio = AudioChannel(args.ip, args.verbose)
    except OSError as error:
        print(f"cannot bind on {args.ip}: {error}", file=sys.stderr)
        print("hint: ports 50001-50003 may already be taken by a real client",
              file=sys.stderr)
        return 1

    channels = [control, civ, audio]
    for channel in channels:
        channel.sock.setblocking(False)

    print(f"fake radio {args.name!r} on {args.ip}:{CONTROL_PORT}/{CIV_PORT}/{AUDIO_PORT}, "
          f"civ=0x{args.civ:02x}, freq={args.freq} Hz", flush=True)

    announced = False
    started = time.monotonic()
    while True:
        if args.seconds and time.monotonic() - started > args.seconds:
            print("time limit reached", flush=True)
            return 0

        # Short timeout: the audio stream has to be paced at 20 ms, so the loop
        # cannot sit in select() waiting for a packet that may not come.
        ready, _, _ = select.select([c.sock for c in channels], [], [], 0.005)
        for sock in ready:
            channel = next(c for c in channels if c.sock is sock)
            while True:
                data = channel.receive()
                if data is None:
                    break
                channel.handle(data)

        audio.tick(time.monotonic())

        if not announced and control.streaming and civ.opened:
            announced = True
            print("CONNECTED", flush=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", flush=True)
