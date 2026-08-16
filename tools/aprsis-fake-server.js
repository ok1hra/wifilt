#!/usr/bin/env node
"use strict";

// A fake APRS-IS server, so the whole chain -- browser, HTTP, firmware, TCP --
// can be checked without a radio and without putting anything on the real
// network. Point the gate's server setting at this machine and watch the exact
// bytes the interface emits.
//
//   node tools/aprsis-fake-server.js
//   node tools/aprsis-fake-server.js --unverified      refuse the login
//   node tools/aprsis-fake-server.js --expect-grid JN79NX --expect-from OK2ABC \
//        --expect-snr -7 --expect-freq 14079200 --expect-call N0CALL-10
//
// With the --expect flags it does more than print: it builds the frame from
// data/js8-aprs-gate.js -- the oracle the firmware's C++ has to agree with --
// and diffs it against what actually arrived. That comparison is the only thing
// that catches a rounding or padding bug in the C++ conversion, because both
// implementations otherwise produce something that merely LOOKS like a position.
//
// What this cannot prove: that the real APRS-IS accepts the packet. It answers
// "verified" to whatever passcode matches, and a real server silently drops bad
// or duplicate packets even on a verified connection. See
// docs/aprsis-igate-implementace.md, "Co zůstane neověřené".

const net = require("net");
const Gate = require("../data/js8-aprs-gate.js");

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
};

const port = Number(option("port", 14580));
const forceUnverified = flag("unverified");
const serverName = option("server", "T2FAKE");
const expect = {
  grid: option("expect-grid", ""),
  from: option("expect-from", ""),
  call: option("expect-call", ""),
  snr: Number(option("expect-snr", 0)),
  freq: Number(option("expect-freq", 0)),
  text: option("expect-text", "")
};
const expecting = Boolean(expect.grid || expect.text);

let connections = 0, packets = 0, failures = 0;
const stamp = () => new Date().toISOString().slice(11, 23);

// The frame the firmware should have produced for these fields. Built by the
// same module the browser uses, which is the whole point of the comparison.
function expectedFrame() {
  const config = {enabled: true, call: expect.call, passcode: Gate.passcode(expect.call),
    host: "fake", port};
  return Gate.frame({kind: expect.grid ? "grid" : "cmd", from: expect.from,
    grid: expect.grid, text: expect.text, snrDb: expect.snr, freqHz: expect.freq}, config);
}

// APRS-IS is line based and a client may split a line across TCP segments, so
// the buffer is drained by newline and never by packet boundary.
function handleLine(socket, line, session) {
  if (!line) return;
  if (line.startsWith("#")) {
    console.log(`${stamp()} #${session.id} comment  ${line}`);
    return;
  }
  if (!session.loggedIn) {
    console.log(`${stamp()} #${session.id} login    ${line}`);
    const match = /^user\s+(\S+)\s+pass\s+(\S+)/i.exec(line);
    if (!match) {
      socket.write("# logresp unknown unverified, server " + serverName + "\r\n");
      failures += 1;
      console.log(`${stamp()} #${session.id} FAIL     login line is not "user … pass …"`);
      return;
    }
    const [, call, pass] = match;
    const valid = !forceUnverified && Gate.passcodeValid(call, pass);
    session.loggedIn = true;
    session.call = call;
    socket.write(`# logresp ${call} ${valid ? "verified" : "unverified"}, `
      + `server ${serverName}\r\n`);
    console.log(`${stamp()} #${session.id} logresp  ${call} `
      + `${valid ? "verified" : "unverified"}`
      + (valid ? "" : ` (expected pass ${Gate.passcode(call)})`));
    return;
  }

  packets += 1;
  console.log(`${stamp()} #${session.id} packet   ${line}`);

  // Shape first: source, tocall, q construct, information field. A packet that
  // fails here would be dropped by a real server without a word.
  const shape = /^([A-Z0-9-]{1,9})>([A-Z0-9]{1,6}),(q[A-Z]{2}),([A-Z0-9-]{1,9}):(.+)$/.exec(line);
  if (!shape) {
    failures += 1;
    console.log(`${stamp()} #${session.id} FAIL     not an APRS-IS packet`);
    return;
  }
  const [, source, tocall, qConstruct, igate, info] = shape;
  const notes = [];
  if (tocall !== Gate.TOCALL) notes.push(`tocall ${tocall} (expected ${Gate.TOCALL})`);
  if (qConstruct !== "qAR") notes.push(`${qConstruct} (an IGate injecting from RF sends qAR)`);
  if (igate !== session.call) notes.push(`igate ${igate} but logged in as ${session.call}`);
  if (info.startsWith("=")) {
    const position = /^=(\d{4}\.\d{2})([NS])(.)(\d{5}\.\d{2})([EW])(.)(.*)$/.exec(info);
    if (!position) notes.push("position field is malformed");
    else {
      if (Number(position[1].slice(2)) >= 60) notes.push(`latitude minutes ${position[1]}`);
      if (Number(position[4].slice(3)) >= 60) notes.push(`longitude minutes ${position[4]}`);
      if (position[6] !== "G") notes.push(`symbol ${position[3]}${position[6]} (expected /G)`);
      if (position[7].length > 43) notes.push(`comment ${position[7].length} characters`);
    }
  } else if (info.startsWith(":")) {
    // Nine characters, exactly, or the gateway routes the message nowhere.
    const message = /^:(.{9}):(.+)$/.exec(info);
    if (!message) notes.push("addressee is not exactly nine characters");
    else if (message[2].length > Gate.MESSAGE_TEXT_LIMIT)
      notes.push(`message text ${message[2].length} characters`);
  } else {
    notes.push(`unknown APRS data type ${info[0]}`);
  }
  if (source.length < 3) notes.push(`source callsign ${source}`);

  if (expecting) {
    const want = expectedFrame();
    if (want && line !== want) {
      notes.push("frame differs from the oracle");
      console.log(`${stamp()}          expected ${want}`);
    } else if (want) {
      console.log(`${stamp()} #${session.id} MATCH    byte-identical to data/js8-aprs-gate.js`);
    }
  }

  if (notes.length) {
    failures += 1;
    for (const note of notes) console.log(`${stamp()} #${session.id} FAIL     ${note}`);
  } else {
    console.log(`${stamp()} #${session.id} OK       shape accepted`);
  }
}

const server = net.createServer(socket => {
  connections += 1;
  const session = {id: connections, loggedIn: false, call: "", buffer: ""};
  console.log(`${stamp()} #${session.id} connect  ${socket.remoteAddress}`);
  socket.write("# aprsc 2.1.10-gc4c1c9d fake\r\n");
  socket.on("data", chunk => {
    session.buffer += chunk.toString("latin1");
    let index = session.buffer.indexOf("\n");
    while (index >= 0) {
      handleLine(socket, session.buffer.slice(0, index).replace(/\r$/, ""), session);
      session.buffer = session.buffer.slice(index + 1);
      index = session.buffer.indexOf("\n");
    }
  });
  socket.on("close", () => console.log(`${stamp()} #${session.id} close    `
    + `${packets} packet(s), ${failures} failure(s) so far`));
  socket.on("error", error => console.log(`${stamp()} #${session.id} error    ${error.message}`));
});

server.listen(port, () => {
  console.log(`fake APRS-IS on port ${port}`
    + `${forceUnverified ? " (refusing every login)" : ""}`);
  if (expecting) console.log(`expecting: ${expectedFrame()}`);
  console.log("point the gate's APRS-IS server at this machine and transmit\n");
});

process.on("SIGINT", () => {
  console.log(`\n${packets} packet(s), ${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
});
