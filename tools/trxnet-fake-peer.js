#!/usr/bin/env node
"use strict";

// A pretend TrxNet device, so the TELEMETRY panel can be exercised end to end
// without a real weather head on the bench.
//
// It announces itself by UDP broadcast the way every node on this network does,
// then publishes a few topics with values that drift. That is enough to walk the
// whole chain the feature depends on: onAnyTopic() in the library, the topic
// table in the firmware, /trxnet-topics.json, the source tree in the browser, and
// the "nothing changed, stay quiet" rule -- which needs values that sometimes do
// NOT move, so --hold freezes them on demand.
//
//   node tools/trxnet-fake-peer.js --target 127.0.0.1:59321 --port 59322
//   node tools/trxnet-fake-peer.js --name PA.98 --target 127.0.0.1:59321
//   node tools/trxnet-fake-peer.js --hold             # publish, but never change
//   node tools/trxnet-fake-peer.js --once             # one round, then exit
//
// --target aims at ONE instance and sends no broadcast at all. Prefer it: it is
// how two TrxNet nodes share a host (both want the same well-known UDP port, and
// only one of them can have it), and it keeps a test off the real network, where
// a stray announce would be added to live devices' peer tables -- and on a board
// with a four-entry table, could evict something real.
//
// Wire format is CoAP NON with the topic as Uri-Path options, matching
// TrxNet::_buildCoAP. Discovery is the 0xAA 0x01/0x02 PROBE/ANNOUNCE pair.

const dgram = require("dgram");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--")
    ? args[at + 1] : fallback;
};
const has = name => args.includes(`--${name}`);

const NAME = flag("name", "WX.99");
const PORT = Number(flag("port", 5000));
const HOLD = has("hold");
const ONCE = has("once");
const BROADCAST = flag("broadcast", "255.255.255.255");
// "host:port" of a single instance to talk to instead of broadcasting.
const TARGET = (() => {
  const raw = flag("target", null);
  if (!raw) return null;
  const [address, port] = String(raw).split(":");
  return {address, port: Number(port) || PORT};
})();

// Matches TRXNET_ANNOUNCE_MS; the peer timeout is 95 s, so anything slower makes
// the device drop out of the interface's table between announces.
const ANNOUNCE_MS = 30000;
const PUBLISH_MS = Number(flag("interval", 5000));

const DISC_PROBE = 0x01, DISC_ANNOUNCE = 0x02, DISC_MAGIC = 0xAA, DISC_VERSION = 0x01;

// Topics this fake head publishes, with the encodings INTEGRATION.md specifies.
// `drift` is per round, in raw units, so /temp moving by 3 is 0.03 °C -- below one
// decimal place, which is exactly the jitter the unchanged-check must swallow.
const TOPICS = [
  {path: "/temp",    width: 2, signed: true,  value: 2134, drift: 3,  min: -3000, max: 5000},
  {path: "/hum",     width: 2, signed: false, value: 5500, drift: 25, min: 0,     max: 10000},
  {path: "/press",   width: 2, signed: false, value: 10131, drift: 2, min: 9000,  max: 11000},
  {path: "/windavg", width: 2, signed: false, value: 320,  drift: 40, min: 0,     max: 4000},
  // Not in the browser's catalogue on purpose: the panel has to stay usable for a
  // home-built board, which means an unknown topic must still be selectable with a
  // hand-set type and divisor.
  {path: "/vbat",    width: 2, signed: false, value: 1262, drift: 4,  min: 1000,  max: 1500}
];

const socket = dgram.createSocket({type: "udp4", reuseAddr: true});

function encodeValue(topic) {
  const buffer = Buffer.alloc(topic.width);
  if (topic.width === 2) {
    if (topic.signed) buffer.writeInt16LE(topic.value, 0);
    else buffer.writeUInt16LE(topic.value, 0);
  } else buffer.writeUInt8(topic.value & 0xff, 0);
  return buffer;
}

// CoAP: version 1, type NON (1), no token; Uri-Path (option 11) once per segment,
// then the 0xFF payload marker. Option deltas are relative, so every segment after
// the first carries a delta of 0 -- the same shape _buildCoAP produces.
function buildCoAP(path, payload, msgId) {
  const header = Buffer.alloc(4);
  header[0] = (1 << 6) | (1 << 4);          // ver 1, type NON, token length 0
  header[1] = 0x02;                          // POST
  header.writeUInt16BE(msgId & 0xffff, 2);
  const parts = [header];
  let lastOption = 0;
  for (const segment of String(path).split("/").filter(Boolean)) {
    const bytes = Buffer.from(segment, "ascii");
    if (bytes.length > 12) throw new Error(`segment too long: ${segment}`);
    const delta = 11 - lastOption;
    lastOption = 11;
    parts.push(Buffer.from([(delta << 4) | bytes.length]), bytes);
  }
  parts.push(Buffer.from([0xff]), payload);
  return Buffer.concat(parts);
}

// [0] magic  [1] protocol version  [2] PROBE/ANNOUNCE  [3] name length
// [4..] name  then the sender's port, BIG-endian (TrxNet.cpp:259 and
// _sendDiscovery). The version byte and that byte order are both load-bearing:
// _processDiscovery drops anything whose buf[1] is not DISC_VERSION, silently.
function buildDiscovery(kind) {
  const name = Buffer.from(NAME, "ascii");
  return Buffer.concat([
    Buffer.from([DISC_MAGIC, DISC_VERSION, kind, name.length]), name,
    Buffer.from([(PORT >> 8) & 0xff, PORT & 0xff])
  ]);
}

const peers = new Map();      // name -> {address, port}
let msgId = 1;

function send(buffer, address, port) {
  socket.send(buffer, 0, buffer.length, port, address, error => {
    if (error) console.error(`send to ${address}:${port} failed: ${error.message}`);
  });
}

function announce(kind = DISC_ANNOUNCE) {
  if (TARGET) send(buildDiscovery(kind), TARGET.address, TARGET.port);
  else send(buildDiscovery(kind), BROADCAST, PORT);
}

// publish() in the library is a unicast copy to every known peer, not a broadcast.
// That is precisely why the interface can see topics it never subscribed to -- and
// why this has to do the same, or the catch-all hook would never fire.
function publish() {
  for (const topic of TOPICS) {
    if (!HOLD) {
      const step = Math.round((Math.random() * 2 - 1) * topic.drift);
      topic.value = Math.max(topic.min, Math.min(topic.max, topic.value + step));
    }
    const packet = buildCoAP(topic.path, encodeValue(topic), msgId++);
    for (const peer of peers.values()) send(packet, peer.address, peer.port);
  }
  const shown = TOPICS.map(t => `${t.path}=${t.value}`).join(" ");
  console.log(`[${NAME}] -> ${peers.size} peer(s)  ${shown}${HOLD ? "  (held)" : ""}`);
}

socket.on("message", (buffer, from) => {
  if (buffer.length < 4 || buffer[0] !== DISC_MAGIC || buffer[1] !== DISC_VERSION) return;
  const kind = buffer[2], nameLen = buffer[3];
  if (buffer.length < 4 + nameLen + 2) return;
  const name = buffer.toString("ascii", 4, 4 + nameLen);
  if (name === NAME) return;                      // our own broadcast coming back
  const port = (buffer[4 + nameLen] << 8) | buffer[5 + nameLen];
  const known = peers.has(name);
  peers.set(name, {address: from.address, port: port || PORT});
  if (!known) console.log(`[${NAME}] discovered ${name} at ${from.address}:${port}`);
  // A PROBE means that node just started and is asking who is out there; answering
  // it is what puts this device into its table without waiting for an announce.
  if (kind === DISC_PROBE) send(buildDiscovery(DISC_ANNOUNCE), from.address, port || PORT);
});

socket.on("error", error => {
  console.error(`socket error: ${error.message}`);
  process.exit(1);
});

socket.bind(PORT, () => {
  if (!TARGET) socket.setBroadcast(true);
  console.log(`[${NAME}] listening on udp/${PORT}, announcing to ` +
    (TARGET ? `${TARGET.address}:${TARGET.port}` : `${BROADCAST} (broadcast)`));
  console.log(`[${NAME}] topics: ${TOPICS.map(t => t.path).join(" ")}`);
  // In targeted mode the destination is seeded as a known peer rather than waited
  // for. It has to be: _sendDiscovery answers to the SENDER'S ADDRESS but always on
  // its own well-known port, so a node sharing a host with the instance under test
  // never hears the reply -- which is the same reason the two cannot both bind that
  // port in the first place.
  if (TARGET) peers.set("target", {address: TARGET.address, port: TARGET.port});
  announce(DISC_PROBE);                            // "who is out there?"
  announce(DISC_ANNOUNCE);
  if (ONCE) {
    // Give the interface a moment to answer the probe before publishing once.
    setTimeout(() => { publish(); setTimeout(() => process.exit(0), 200); }, 1500);
    return;
  }
  setInterval(() => announce(DISC_ANNOUNCE), ANNOUNCE_MS);
  setInterval(publish, PUBLISH_MS);
});

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => { socket.close(); process.exit(0); });
