#!/usr/bin/env python3
"""
The 16 kHz radio link (XARA FM Wide, docs/vara-implementace.md phase 6) end to
end against the native firmware and tools/icom-lan-fake-radio.py, which streams
a 1 kHz tone at whatever rate the stream request asked for and logs the size of
the TX audio packets it receives.

  1. link at 8 kHz: the hello offers only RX_ULAW/8000, the tone arrives;
  2. POST /vara-settings.json {"link16k":true}: the firmware drops the audio
     socket and reconnects the radio at 16 kHz;
  3. the hello now offers 16000 too, the stream still starts at 8 kHz (the
     firmware's half-band decimator -- the tone must survive it), rx.select
     16000 switches it: FIRST, firstSample 0, the tone at 16 kHz;
  4. a one-second AUD1 transmission drains, and reaches the radio as 320-byte
     (20 ms at 16 kHz) packets;
  5. back to 8 kHz: 160-byte TX packets again.

Run through tools/aud1-16k-native-check.sh (it sets up the network namespace,
the fake radio and the firmware):

  python3 tools/aud1-16k-native-check.py HTTP_PORT RADIO_LOG
"""

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
HTTP = "http://127.0.0.1:%s" % sys.argv[1]
RADIO_LOG = sys.argv[2]
failures = 0


def check(name, ok, detail=""):
    global failures
    print(("  ok   " if ok else "  FAIL ") + name + ("  " + detail if detail else ""), flush=True)
    if not ok:
        failures += 1


def ulaw_decode(byte):
    byte = ~byte & 0xFF
    sign, exponent, mantissa = byte & 0x80, (byte >> 4) & 0x07, byte & 0x0F
    value = (((mantissa << 3) + 0x84) << exponent) - 0x84
    return -value if sign else value


def http(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(HTTP + path, data=data, method="POST" if data else "GET",
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.read().decode()


def radio_log():
    with open(RADIO_LOG, errors="replace") as f:
        return f.read()


def wait_for(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


class Ws:
    """Just enough of a WebSocket client: masked frames out, frames in."""

    def __init__(self, token):
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock = socket.create_connection(("127.0.0.1", 83), timeout=6)
        self.sock.sendall((f"GET /audiows?token={token} HTTP/1.1\r\nHost: 127.0.0.1:83\r\n"
                           "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("closed during upgrade")
            head += chunk
        header, self.buf = head.split(b"\r\n\r\n", 1)
        self.buf = bytearray(self.buf)
        self.ok = header.split(b"\r\n")[0].find(b"101") >= 0
        self.closed = False

    def send(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        head = bytes([0x80 | opcode])
        head += bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def text(self, message):
        self.send(0x1, json.dumps(message).encode())

    def frames(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            while len(self.buf) >= 2:
                opcode, length, offset = self.buf[0] & 0x0F, self.buf[1] & 0x7F, 2
                if length == 126:
                    if len(self.buf) < 4:
                        break
                    length, offset = struct.unpack(">H", self.buf[2:4])[0], 4
                if len(self.buf) < offset + length:
                    break
                payload = bytes(self.buf[offset:offset + length])
                del self.buf[:offset + length]
                if opcode == 0x8:
                    self.closed = True
                    return
                yield opcode, payload
            self.sock.settimeout(0.2)
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                self.closed = True
                return
            if not chunk:
                self.closed = True
                return
            self.buf += chunk

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def collect(ws, seconds):
    """Text messages and RX audio frames for a while."""
    texts, frames = [], []
    for opcode, payload in ws.frames(seconds):
        if opcode == 0x1:
            texts.append(json.loads(payload.decode()))
        elif opcode == 0x2 and len(payload) > 40 and payload[5] == 1:
            flags, = struct.unpack(">H", payload[6:8])
            seq, rate = struct.unpack(">II", payload[16:24])
            first, = struct.unpack(">Q", payload[24:32])
            frames.append({"flags": flags, "seq": seq, "rate": rate, "first": first,
                           "samples": [ulaw_decode(b) for b in payload[40:]]})
    return texts, frames


def tone(samples, rate):
    window = samples[200:200 + rate // 2]
    if len(window) < rate // 4:
        return 0, 0
    crossings = sum(1 for a, b in zip(window, window[1:]) if (a < 0) != (b < 0))
    return crossings * rate / (2 * len(window)), max(abs(s) for s in window)


def transmit(ws, stream_id, tx_id):
    """One second of a 1500 Hz tone as an AUD1 transmission; True when it drains."""
    packets, per = 50, 960
    now = int(time.time() * 1000)
    ws.text({"type": "tx.prepare", "txId": tx_id, "sampleRate": 48000, "packetMs": 20,
             "samples": packets * per, "packets": packets, "prebufferSamples": 9600,
             "slotUtcMs": now + 400, "clientUtcMs": now, "mode": "TEST", "toneHz": 1500})
    for seq in range(packets):
        flags = (1 if seq == 0 else 0) | (2 if seq == packets - 1 else 0)
        head = b"AUD1" + bytes([1, 3]) + struct.pack(">HHHIIIQII", flags, 40, 0, stream_id, seq,
                                                      48000, seq * per, tx_id, per * 2)
        pcm = b"".join(struct.pack("<h", int(12000 * __import__("math").sin(
            2 * 3.141592653589793 * 1500 * (seq * per + i) / 48000))) for i in range(per))
        ws.send(0x2, head + pcm)
    states = []
    for opcode, payload in ws.frames(6):
        if opcode == 0x1:
            m = json.loads(payload.decode())
            states.append(m.get("type"))
            if m.get("type") in ("tx-drained", "tx-error"):
                break
    return "tx-drained" in states, states


def session():
    token = base64.b16encode(os.urandom(8)).decode().lower()
    granted = json.loads(http("/js8/session/claim", {"token": token}))
    return token, granted.get("state") in ("granted", "renewed")


def connected():
    return '"connected":true' in http("/state")


def main():
    token, ok = session()
    check("session granted", ok)

    # 1. the 8 kHz link
    ws = Ws(token)
    texts, frames = collect(ws, 2.5)
    hello = next((t for t in texts if t.get("type") == "hello"), {})
    check("8 kHz link: hello offers only 8000", [r.get("sampleRate") for r in hello.get("rx", [])] == [8000],
          json.dumps(hello.get("rx")))
    rates = {f["rate"] for f in frames}
    hz, peak = tone([s for f in frames for s in f["samples"]], 8000)
    check("8 kHz link: frames at 8000", rates == {8000}, str(rates))
    check("8 kHz link: 1 kHz tone", abs(hz - 1000) < 30 and peak > 8000, f"{hz:.0f} Hz, peak {peak}")
    sid = hello.get("streamId", 0)
    drained, states = transmit(ws, sid, 11)
    check("8 kHz link: a transmission drains", drained, ",".join(states))
    check("8 kHz link: TX reaches the radio as 160 B packets", "TX audio packets of 160 B" in radio_log())

    # 2. switch the link to 16 kHz
    http("/vara-settings.json", {"link16k": True})
    list(ws.frames(3))
    check("16 kHz setting: the firmware dropped the audio socket", ws.closed)
    ws.close()
    check("16 kHz setting: the radio was asked for 16 kHz", wait_for(lambda: "rx 16000 Hz" in radio_log(), 15))
    check("16 kHz setting: the radio is back", wait_for(connected, 20))
    time.sleep(1.0)

    # 3. the 16 kHz stream on request
    ws = Ws(token)
    texts, frames = collect(ws, 2.5)
    hello = next((t for t in texts if t.get("type") == "hello"), {})
    offered = [r.get("sampleRate") for r in hello.get("rx", [])]
    check("16 kHz link: hello offers 8000 and 16000", offered == [8000, 16000], json.dumps(hello.get("rx")))
    rates = {f["rate"] for f in frames}
    hz, peak = tone([s for f in frames for s in f["samples"]], 8000)
    check("16 kHz link: the stream starts at 8000", rates == {8000}, str(rates))
    check("16 kHz link: the tone survives the half-band decimator", abs(hz - 1000) < 30 and peak > 8000,
          f"{hz:.0f} Hz, peak {peak}")
    ws.text({"type": "rx.select", "sampleRate": 16000})
    texts, frames = collect(ws, 2.5)
    wide = [f for f in frames if f["rate"] == 16000]
    check("rx.select 16000: the stream switches", len(wide) > 10 and frames[-1]["rate"] == 16000,
          f"{len(wide)}/{len(frames)} frames at 16000")
    if wide:
        check("rx.select 16000: a new epoch (FIRST, firstSample 0)", wide[0]["flags"] & 1 and wide[0]["first"] == 0,
              f"flags {wide[0]['flags']} first {wide[0]['first']}")
        contiguous = all(b["first"] == a["first"] + len(a["samples"]) for a, b in zip(wide, wide[1:]))
        check("rx.select 16000: firstSample continuous", contiguous)
        hz, peak = tone([s for f in wide for s in f["samples"]], 16000)
        check("rx.select 16000: 1 kHz tone at 16 kHz", abs(hz - 1000) < 30 and peak > 8000, f"{hz:.0f} Hz, peak {peak}")
    sid = hello.get("streamId", 0)
    drained, states = transmit(ws, sid, 12)
    check("16 kHz link: a transmission drains", drained, ",".join(states))
    check("16 kHz link: TX reaches the radio as 320 B packets", "TX audio packets of 320 B" in radio_log())
    ws.text({"type": "rx.select", "sampleRate": 8000})
    texts, frames = collect(ws, 1.5)
    check("rx.select 8000: back to 8000", frames and frames[-1]["rate"] == 8000)

    # 4. and back to 8 kHz
    http("/vara-settings.json", {"link16k": False})
    list(ws.frames(3))
    ws.close()
    check("8 kHz again: the radio was asked for 8 kHz",
          wait_for(lambda: radio_log().rfind("rx 8000 Hz") > radio_log().rfind("rx 16000 Hz"), 15))
    check("8 kHz again: the radio is back", wait_for(connected, 20))
    time.sleep(1.0)
    ws = Ws(token)
    texts, frames = collect(ws, 1.5)
    hello = next((t for t in texts if t.get("type") == "hello"), {})
    check("8 kHz again: hello offers only 8000", [r.get("sampleRate") for r in hello.get("rx", [])] == [8000])
    ws.close()

    print("\nAUD1 16 kHz LINK " + ("PASS" if not failures else f"FAIL ({failures})"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
