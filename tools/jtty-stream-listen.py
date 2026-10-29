#!/usr/bin/env python3
"""Subscribe to a WIFILT's JTTY stream on TrxNet and print it.

The reference listener for jtty_stream.h (docs/jtty-implementace.md §8) -- a
copy of tools/rtty-stream-listen.py with JTTY's two topics; the TrxNet half is
the same, change one, change both. The pattern a real analyser follows:

  1. join TrxNet like any node -- a discovery PROBE and ANNOUNCE, repeated every
     30 s, so the interface keeps this device in its peer table (it resolves a
     packet's sender by IP, and a sender it does not know cannot subscribe);
  2. send /s-jtty = 1 to the interface, and again every 30 s -- the subscription
     lapses 90 s after the last one;
  3. receive /jtty-rx  [seq][msgId][flags: bit0 EOM][audioHz u16 LE][snr i8][ASCII]
     and /jtty-tx [seq][ASCII] ([seq][0x00] = aborted) as CoAP NON packets, and
     put each received message together by msgId until its EOM;
  4. send /s-jtty = 0 on the way out.

The switch in DATA / JTTY / SETTINGS must be on, or the interface ignores the
subscription. One listener per computer: the interface names a sender by
its IP alone, so a second one there only renews the first's subscription.

  tools/jtty-stream-listen.py                         # broadcast, find the interface
  tools/jtty-stream-listen.py --target 192.168.1.50   # talk to one interface only
  tools/jtty-stream-listen.py --target 127.0.0.1:5683 --port 5692 --seconds 20 --json

--target also lets this share a host with the native build: both want the
well-known port, so this one takes another (--port) and is seeded with the
interface's address, because TrxNet answers a probe on its own well-known port.
No dependencies beyond the standard library.
"""

import argparse, json, signal, socket, struct, sys, time

DISC_MAGIC, DISC_VERSION, DISC_PROBE, DISC_ANNOUNCE = 0xAA, 0x01, 0x01, 0x02
COAP_CON, COAP_NON, COAP_ACK = 0, 1, 2
COAP_POST, OPT_URI_PATH = 0x02, 11
RENEW_S = 30
TOPICS = ("/jtty-rx", "/jtty-tx")
COLOUR = {"/jtty-rx": "\033[32m", "/jtty-tx": "\033[31m"}


def discovery(name, kind, port):
    raw = name.encode("ascii")
    return bytes([DISC_MAGIC, DISC_VERSION, kind, len(raw)]) + raw + struct.pack(">H", port)


def coap(path, payload, msg_id, kind=COAP_NON):
    """The shape TrxNet::_buildCoAP writes: no token, one Uri-Path per segment."""
    out = bytearray([(1 << 6) | (kind << 4), COAP_POST]) + struct.pack(">H", msg_id & 0xFFFF)
    last = 0
    for segment in [s for s in path.split("/") if s]:
        raw = segment.encode("ascii")
        out.append(((OPT_URI_PATH - last) << 4) | len(raw))
        out += raw
        last = OPT_URI_PATH
    return bytes(out) + b"\xff" + payload


def parse_coap(buf):
    """(type, msg_id, path, payload) or None."""
    if len(buf) < 4 or buf[0] >> 6 != 1:
        return None
    kind, tkl = (buf[0] >> 4) & 3, buf[0] & 0x0F
    msg_id = struct.unpack(">H", buf[2:4])[0]
    pos, option, segments = 4 + tkl, 0, []
    while pos < len(buf) and buf[pos] != 0xFF:
        delta, length = buf[pos] >> 4, buf[pos] & 0x0F
        pos += 1
        for which in ("delta", "length"):
            value = delta if which == "delta" else length
            if value == 13:
                value, pos = buf[pos] + 13, pos + 1
            elif value == 14:
                value, pos = struct.unpack(">H", buf[pos:pos + 2])[0] + 269, pos + 2
            if which == "delta":
                delta = value
            else:
                length = value
        option += delta
        if option == OPT_URI_PATH:
            segments.append(buf[pos:pos + length].decode("ascii", "replace"))
        pos += length
    payload = buf[pos + 1:] if pos < len(buf) else b""
    return kind, msg_id, "/" + "/".join(segments), payload


def shown(text):
    return text.replace("\r", "␍").replace("\n", "␊")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--name", default="JTY.fe", help="this device's TrxNet name (type JTY, INTEGRATION.md §2)")
    ap.add_argument("--port", type=int, default=5683, help="local UDP port (default 5683)")
    ap.add_argument("--target", help="host[:port] of one interface; default: broadcast")
    ap.add_argument("--broadcast", default="255.255.255.255")
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (0 = until Ctrl+C)")
    ap.add_argument("--json", action="store_true", help="one JSON object per packet, for scripts")
    args = ap.parse_args()

    target = None
    if args.target:
        host, _, port = args.target.partition(":")
        target = (host, int(port) if port else 5683)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(("", args.port))
    sock.settimeout(0.5)

    peers = {}                     # name -> (ip, port); the interface is among them
    if target:
        peers["target"] = target
    msg_id = [1]
    last_seq = {}
    messages = {}                  # msgId -> text so far
    colour = sys.stdout.isatty() and not args.json

    def log(line):
        if not args.json:
            print(line, file=sys.stderr, flush=True)

    def send(data, addr):
        try:
            sock.sendto(data, addr)
        except OSError as error:
            log(f"send to {addr} failed: {error}")

    def announce(kind):
        send(discovery(args.name, kind, args.port), target or (args.broadcast, 5683))

    def subscribe(on):
        for addr in set(peers.values()):
            send(coap("/s-jtty", bytes([1 if on else 0]), msg_id[0]), addr)
            msg_id[0] += 1

    def stop(*_):
        subscribe(False)
        log(f"[{args.name}] unsubscribed")
        sys.exit(0)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)

    log(f"[{args.name}] udp/{args.port}, " +
        (f"target {target[0]}:{target[1]}" if target else f"broadcast {args.broadcast}"))
    announce(DISC_PROBE)
    announce(DISC_ANNOUNCE)
    started = time.monotonic()
    next_renew = started + 1.0     # give the interface a moment to take the announce

    while True:
        now = time.monotonic()
        if args.seconds and now - started >= args.seconds:
            stop()
        if now >= next_renew:
            announce(DISC_ANNOUNCE)
            subscribe(True)
            next_renew = now + RENEW_S
        try:
            buf, addr = sock.recvfrom(512)
        except socket.timeout:
            continue
        if not buf:
            continue
        if buf[0] == DISC_MAGIC:
            if len(buf) < 6 or buf[1] != DISC_VERSION:
                continue
            name = buf[4:4 + buf[3]].decode("ascii", "replace")
            if name == args.name:
                continue
            port = struct.unpack(">H", buf[4 + buf[3]:6 + buf[3]])[0] or 5683
            if not target and name not in peers:
                peers[name] = (addr[0], port)
                log(f"[{args.name}] discovered {name} at {addr[0]}:{port}")
                next_renew = min(next_renew, time.monotonic() + 0.2)
            if buf[2] == DISC_PROBE:
                send(discovery(args.name, DISC_ANNOUNCE, args.port), (addr[0], port))
            continue
        packet = parse_coap(buf)
        if not packet:
            continue
        kind, mid, path, payload = packet
        if kind == COAP_CON:
            send(bytes([(1 << 6) | (COAP_ACK << 4), 0x00]) + struct.pack(">H", mid), addr)
        if path not in TOPICS or len(payload) < 2:
            continue
        seq, body = payload[0], payload[1:]
        gap = 0
        if path in last_seq:
            gap = (seq - last_seq[path] - 1) & 0xFF
        last_seq[path] = seq
        record = {"t": round(time.time(), 3), "from": addr[0], "topic": path, "seq": seq, "gap": gap}
        if path == "/jtty-rx":
            if len(body) < 5:
                continue
            msg, eom, hz = body[0], bool(body[1] & 1), body[2] | (body[3] << 8)
            snr = body[4] - 256 if body[4] > 127 else body[4]
            text = body[5:].decode("ascii", "replace")
            messages[msg] = messages.get(msg, "") + text
            record.update(msg=msg, eom=eom, hz=hz, snr=snr, text=text, message=messages[msg])
            if eom:
                messages.pop(msg, None)
        else:
            abort = body == b"\x00"
            record.update(abort=abort, text="" if abort else body.decode("ascii", "replace"))
        if args.json:
            print(json.dumps(record), flush=True)
            continue
        stamp = time.strftime("%H:%M:%S")
        lost = f"  [{gap} lost]" if gap else ""
        if path == "/jtty-rx":
            what = f"{record['hz']:4d} Hz {record['snr']:+3d} dB  {shown(record['message'])}" + ("  ⏎" if record["eom"] else " …")
        else:
            what = "✖ TX ABORTED" if record["abort"] else shown(record["text"])
        if colour:
            what = COLOUR[path] + what + "\033[0m"
        print(f"{stamp} {path:<8} #{seq:03d}{lost}  {what}", flush=True)


if __name__ == "__main__":
    main()
