#!/usr/bin/env python3
"""Record a WIFILT's two RTTY decoders from TrxNet into two files, for analysis.

Grilled 2026-09-25. Built to run for days on a Linux PC other than the radio's:
it subscribes to /rtty1 (DEC 1) and /rtty2 (DEC 2) of ONE interface, keeps the
subscription alive, and writes each decoder to its own file, one JSON object per
line, so the two can be lined up afterwards by time.

  tools/rtty-stream-record.py                          # the one 705.* on the LAN
  tools/rtty-stream-record.py --iface 705.01 --dir ~/rtty-rec
  tools/rtty-stream-record.py --target 127.0.0.1:5683 --port 5690 --iface 705.01

Before it hears anything:
  - DATA / RTTY-ICOM / SETTINGS: the RTTY stream switch must be on;
  - SETUP / TrxNet / Priority prefixes: add RTY, or a full peer table evicts this
    recorder and its subscription goes nowhere (it is printed at start);
  - the RTTY page or the QRPlog palette must be open at the radio -- the decoders
    run in that browser, not in the interface;
  - the interface knows a sender by its IP address alone: run ONE listener per
    computer -- this or rtty-stream-listen.py, not both -- or the second one's
    subscription only renews the first's and it hears nothing.

Files, in --dir (UTC dates):
  2026-09-25_705.01_rtty1.jsonl    today's, written line by line (tail -f works)
  2026-09-24_705.01_rtty1.jsonl.gz earlier days, compressed at midnight and at start
A restart on the same day appends. Every line has "t", Unix time in seconds of
THIS computer's clock (keep it on NTP); a line is either a packet
  {"t":…, "seq":17, "gap":0, "text":"CQ TEST "}
or an event:
  {"ev":"open", "v":1, "iface", "ip", "me", "topic"}  file (re)opened, schema version
  {"ev":"tx", "seq", "gap", "text"}   what the station sent (/rtty-tx; the decoders
                                      are blanked while it transmits)
  {"ev":"tx-abort", "seq", "gap"}     that transmission was cut short
  {"ev":"iface", "ip"}                the interface moved to another address
  {"ev":"iface-restart"}              the interface rebooted; seq starts over
  {"ev":"idle", "since"}              --idle seconds without either decoder
  {"ev":"active", "silent_s"}         and the first packet after it
  {"ev":"close", "reason"}            stop signal or midnight rotation
gap = sequence numbers skipped since the last packet of the same topic: a lost UDP
packet, or characters the interface dropped because a buffer overflowed (it
skips one number for that). Characters stay exactly as decoded, \\r\\n included.

Reading it back:
  zcat -f 2026-09-2*_705.01_rtty2.jsonl* | jq -j 'select(.text and (.ev|not)) | .text'

The protocol functions below are a COPY of tools/rtty-stream-listen.py -- this
file is meant to be copied to another PC on its own. Change one, change both.
No dependencies beyond the standard library.
"""

import argparse, datetime, errno, fcntl, glob, gzip, json, os, re, shutil, signal
import socket, struct, sys, time

DISC_MAGIC, DISC_VERSION, DISC_PROBE, DISC_ANNOUNCE = 0xAA, 0x01, 0x01, 0x02
COAP_CON, COAP_NON, COAP_ACK = 0, 1, 2
COAP_POST, OPT_URI_PATH = 0x02, 11
RENEW_S = 30              # TrxNet's announce period; the subscription lease is 90 s
PICK_S = 2.0              # after a PROBE, how long the answers are collected
RETRY_BIND_S = 5
STATS_S = 3600
SCHEMA = 1
TYPE = "RTY"              # TrxNet device type, INTEGRATION.md §2
IFACE_TYPE = "705."       # a WIFILT's name, "705.<netid>"
RX = ("/rtty1", "/rtty2")


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


def parse_discovery(buf):
    """(kind, name, port) or None."""
    if len(buf) < 6 or buf[0] != DISC_MAGIC or buf[1] != DISC_VERSION:
        return None
    n = buf[3]
    if len(buf) < 4 + n + 2:
        return None
    name = buf[4:4 + n].decode("ascii", "replace")
    port = struct.unpack(">H", buf[4 + n:6 + n])[0] or 5683
    return buf[2], name, port


# Tests shift the clock to cross a UTC midnight without waiting for one.
CLOCK_OFFSET = float(os.environ.get("RTTY_REC_TEST_CLOCK_OFFSET", "0") or 0)


def now():
    return time.time() + CLOCK_OFFSET


def utc_day(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d")


def log(line):
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + line, file=sys.stderr, flush=True)


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def compress(path):
    """name.jsonl -> name.jsonl.gz. An existing .gz (a crash between the rename and
    the unlink, or a clock that went back) gets this one as a further gzip member,
    which zcat reads as one stream."""
    gz = path + ".gz"
    tmp = gz + ".tmp"
    with open(path, "rb") as src, gzip.open(tmp, "wb") as dst:
        shutil.copyfileobj(src, dst)
    if os.path.exists(gz):
        with open(gz, "ab") as out, open(tmp, "rb") as more:
            shutil.copyfileobj(more, out)
        os.unlink(tmp)
    else:
        os.replace(tmp, gz)
    os.unlink(path)


class Files:
    """The two decoders' files for one interface, rotated at UTC midnight."""

    def __init__(self, directory, iface, me):
        self.dir, self.iface, self.me = directory, iface, me
        self.day, self.out, self.ip = None, {}, ""

    def path(self, day, topic):
        return os.path.join(self.dir, f"{day}_{safe_name(self.iface)}_{topic.strip('/')}.jsonl")

    def compress_old(self, today):
        for path in sorted(glob.glob(os.path.join(self.dir, f"*_{safe_name(self.iface)}_rtty[12].jsonl"))):
            if os.path.basename(path)[:10] < today:
                try:
                    compress(path)
                    log(f"compressed {os.path.basename(path)}.gz")
                except OSError as error:
                    log(f"cannot compress {path}: {error}")

    def open(self, t):
        self.day = utc_day(t)
        for topic in RX:
            self.out[topic] = open(self.path(self.day, topic), "a", encoding="utf-8")
            self._write(topic, {"t": round(t, 3), "ev": "open", "v": SCHEMA, "iface": self.iface,
                                "ip": self.ip, "me": self.me, "topic": topic})
        self.compress_old(self.day)

    def close(self, t, reason):
        for topic, f in self.out.items():
            self._write(topic, {"t": round(t, 3), "ev": "close", "reason": reason})
            f.close()
        self.out = {}

    def rotate_if_needed(self, t):
        if self.out and utc_day(t) != self.day:
            self.close(t, "rotate")
            self.open(t)

    def _write(self, topic, obj):
        f = self.out[topic]
        f.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        f.flush()

    def write(self, topic, obj):
        self.rotate_if_needed(obj["t"])
        self._write(topic, obj)

    def both(self, obj):
        self.rotate_if_needed(obj["t"])
        for topic in RX:
            self._write(topic, obj)


class Recorder:
    def __init__(self, args):
        self.args = args
        self.me = f"{TYPE}.{args.netid:02x}"
        self.sock = None
        self.stop_reason = None
        self.msg_id = 1
        self.target = None
        if args.target:
            host, _, port = args.target.partition(":")
            self.target = (socket.gethostbyname(host), int(port) if port else 5683)
        self.iface = None          # name, once chosen
        self.iface_addr = None     # (ip, port)
        self.candidates = {}       # name -> (ip, port), while choosing
        self.pick_at = None
        self.next_renew = 0.0
        self.next_probe = 0.0
        self.files = None
        self.lock = None
        self.last_seq = {}
        self.last_rx = None
        self.files_opened = None
        self.idle = False
        self.started = time.monotonic()
        self.next_stats = self.started + STATS_S
        self.stats = {t: {"packets": 0, "gaps": 0, "last": None} for t in RX + ("/rtty-tx",)}
        self.others = set()
        self.send_errors = 0

    # ---- network ----------------------------------------------------------------
    def bind(self):
        while not self.stop_reason:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                sock.bind((self.args.bind, self.args.port))
                sock.settimeout(0.5)
                self.sock = sock
                return
            except OSError as error:
                sock.close()
                log(f"cannot bind udp/{self.args.port}: {error}; again in {RETRY_BIND_S} s")
                time.sleep(RETRY_BIND_S)

    def send(self, data, addr):
        try:
            self.sock.sendto(data, addr)
            self.send_errors = 0
        except OSError as error:
            self.send_errors += 1
            if self.send_errors in (1, 10) or self.send_errors % 100 == 0:
                log(f"send to {addr[0]}:{addr[1]} failed ({self.send_errors}x): {error}")

    def probe(self):
        self.send(discovery(self.me, DISC_PROBE, self.args.port),
                  self.target or (self.args.broadcast, 5683))

    def subscribe(self, on):
        if not self.iface_addr:
            return
        self.send(discovery(self.me, DISC_ANNOUNCE, self.args.port), self.iface_addr)
        self.send(coap("/s-rtty", bytes([1 if on else 0]), self.msg_id), self.iface_addr)
        self.msg_id += 1

    # ---- choosing the interface ---------------------------------------------------
    def wanted(self, name):
        if self.args.iface:
            return name == self.args.iface
        return self.target is not None or name.startswith(IFACE_TYPE)

    def choose(self, name, addr):
        self.iface, self.iface_addr = name, addr
        log(f"recording {name} at {addr[0]}:{addr[1]} as {self.me}")
        self.lock = open(os.path.join(self.args.dir, f".{safe_name(name)}.lock"), "w")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log(f"another recorder already writes {name} into {self.args.dir}")
            sys.exit(2)
        self.files = Files(self.args.dir, name, self.me)
        self.files.ip = addr[0]
        self.files.open(now())
        self.files_opened = now()
        self.subscribe(True)
        self.next_renew = time.monotonic() + RENEW_S

    def pick(self):
        """After the answers to our PROBE are in: exactly one interface, or say why not."""
        found = sorted(self.candidates)
        if len(found) == 1:
            self.choose(found[0], self.candidates[found[0]])
        elif len(found) > 1:
            log("more than one interface answers: " +
                ", ".join(f"{n} ({a[0]})" for n, a in sorted(self.candidates.items())) +
                " -- pick one with --iface")
            sys.exit(2)
        else:
            self.pick_at = None    # keep probing; the first one heard is taken
            log(f"no interface answered{' as ' + self.args.iface if self.args.iface else ''} "
                f"-- probing every {RENEW_S} s")

    def on_discovery(self, kind, name, port, ip):
        if name == self.me:
            return
        addr = (ip, port)
        if self.target and ip != self.target[0]:
            return
        if self.iface is None:
            if not self.wanted(name):
                return
            self.candidates[name] = addr
            if self.args.iface or self.pick_at is None:
                self.choose(name, addr)     # named, or the first heard after an empty round
            return
        if name != self.iface:
            if name.startswith(IFACE_TYPE) and name not in self.others:
                self.others.add(name)
                log(f"ignoring {name} at {ip} -- recording {self.iface}")
            return
        t = round(now(), 3)
        if addr != self.iface_addr:
            log(f"{name} moved {self.iface_addr[0]}:{self.iface_addr[1]} -> {ip}:{port}")
            self.iface_addr = addr
            self.files.ip = ip
            self.files.both({"t": t, "ev": "iface", "ip": ip})
            self.subscribe(True)
            self.next_renew = time.monotonic() + RENEW_S
        if kind == DISC_PROBE:
            # Sent only from TrxNet::begin(): it rebooted (or its WiFi came back), so
            # it has forgotten this recorder and its sequence numbers start over.
            log(f"{name} restarted -- subscribing again")
            self.last_seq.clear()
            self.files.both({"t": t, "ev": "iface-restart"})
            self.subscribe(True)
            self.next_renew = time.monotonic() + RENEW_S

    # ---- packets ------------------------------------------------------------------
    def on_packet(self, path, payload):
        if path not in self.stats or len(payload) < 2:
            return
        t = round(now(), 3)
        seq, body = payload[0], payload[1:]
        gap = (seq - self.last_seq[path] - 1) & 0xFF if path in self.last_seq else 0
        self.last_seq[path] = seq
        s = self.stats[path]
        s["packets"] += 1
        s["gaps"] += gap
        s["last"] = t
        if path == "/rtty-tx":
            if body == b"\x00":
                self.files.both({"t": t, "ev": "tx-abort", "seq": seq, "gap": gap})
            else:
                self.files.both({"t": t, "ev": "tx", "seq": seq, "gap": gap,
                                 "text": body.decode("ascii", "replace")})
            return
        if self.idle:
            self.idle = False
            silent = round(t - self.last_rx, 1) if self.last_rx else None
            self.files.both({"t": t, "ev": "active", "silent_s": silent})
            log(f"decoders active again after {silent} s")
        self.last_rx = t
        self.files.write(path, {"t": t, "seq": seq, "gap": gap,
                                "text": body.decode("ascii", "replace")})

    def check_idle(self):
        t = now()
        since = self.last_rx or self.files_opened
        if not self.idle and t - since >= self.args.idle:
            self.idle = True
            self.files.both({"t": round(t, 3), "ev": "idle", "since": round(since, 3)})
            log(f"nothing from either decoder for {self.args.idle:.0f} s -- is the RTTY page or "
                f"palette open at the radio, the stream switch on, {TYPE} in Priority prefixes?")

    def print_stats(self):
        parts = []
        for topic, s in self.stats.items():
            last = time.strftime("%H:%M:%S", time.gmtime(s["last"])) + "Z" if s["last"] else "never"
            parts.append(f"{topic} {s['packets']} pkts, {s['gaps']} lost, last {last}")
            s["packets"] = s["gaps"] = 0
        log("last hour: " + "; ".join(parts))

    # ---- main loop ----------------------------------------------------------------
    def on_signal(self, signum, _frame):
        self.stop_reason = signal.Signals(signum).name

    def run(self):
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, self.on_signal)
        os.makedirs(self.args.dir, exist_ok=True)
        log(f"{self.me}: add {TYPE} to WIFILT SETUP / TrxNet / Priority prefixes "
            f"(this device: {self.me})")
        self.bind()
        if self.target and self.args.iface:
            self.choose(self.args.iface, self.target)
        else:
            self.probe()
            self.pick_at = time.monotonic() + PICK_S
            self.next_probe = time.monotonic() + RENEW_S
        while not self.stop_reason:
            mono = time.monotonic()
            if self.iface is None:
                if self.pick_at is not None and mono >= self.pick_at:
                    self.pick()
                if self.iface is None and mono >= self.next_probe:
                    self.probe()
                    self.next_probe = mono + RENEW_S
            else:
                if mono >= self.next_renew:
                    self.subscribe(True)
                    self.next_renew = mono + RENEW_S
                self.files.rotate_if_needed(now())
                self.check_idle()
                if mono >= self.next_stats:
                    self.print_stats()
                    self.next_stats = mono + STATS_S
            try:
                buf, (ip, port) = self.sock.recvfrom(512)
            except socket.timeout:
                continue
            except OSError as error:
                if error.errno != errno.EINTR:
                    log(f"receive failed: {error}")
                    time.sleep(1)
                continue
            if not buf:
                continue
            if buf[0] == DISC_MAGIC:
                d = parse_discovery(buf)
                if d:
                    self.on_discovery(d[0], d[1], d[2], ip)
                continue
            if not self.iface_addr or ip != self.iface_addr[0]:
                continue
            packet = parse_coap(buf)
            if not packet:
                continue
            kind, mid, path, payload = packet
            if kind == COAP_CON:
                self.send(bytes([(1 << 6) | (COAP_ACK << 4), 0x00]) + struct.pack(">H", mid), (ip, port))
            self.on_packet(path, payload)
        if self.iface:
            self.subscribe(False)
            self.files.close(now(), self.stop_reason)
            log(f"{self.stop_reason}: unsubscribed from {self.iface}, files closed")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("\n", 2)[2])
    ap.add_argument("--iface", help="the interface's TrxNet name, e.g. 705.01 "
                    "(default: the only 705.* that answers)")
    ap.add_argument("--dir", default="./rtty-rec", help="where the files go (default ./rtty-rec)")
    ap.add_argument("--netid", type=lambda v: int(v, 16), default=0x01,
                    help=f"this recorder's NET_ID, hex (default 01 -> {TYPE}.01)")
    ap.add_argument("--idle", type=float, default=600,
                    help="seconds without either decoder before an idle event (default 600)")
    ap.add_argument("--port", type=int, default=5683, help="local UDP port (default 5683)")
    ap.add_argument("--bind", default="", help="local address to bind (default: all)")
    ap.add_argument("--target", help="host[:port] of the interface, unicast instead of broadcast; "
                    "on a port other than 5683 it cannot answer, so give --iface too")
    ap.add_argument("--broadcast", default="255.255.255.255")
    args = ap.parse_args()
    if not 1 <= args.netid <= 0xFF:
        ap.error("--netid is 01..ff (00 means disabled in TrxNet)")
    Recorder(args).run()


if __name__ == "__main__":
    main()
