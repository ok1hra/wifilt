#!/usr/bin/env node
"use strict";
// XARA host protocol (data/vara-host.js) against x0rro/xara: the command parser
// and reply text (crates/xara-host/tests/{command,response}.rs) and the whole
// TNC + station + phy chain (crates/xara/tests/host_protocol.rs): two HfStations
// joined by a perfect audio wire, driven by in-memory host clients instead of
// TCP. Needs the pinned checkout in xara/ (XARA_DIR overrides).
// docs/vara-implementace.md §4 phase 2.
//
//   node tools/vara-host-test.js                all groups
//   node tools/vara-host-test.js command        only the named groups

const fs = require("fs");
const path = require("path");
const M = require("../data/vara-modem.js");
const H = require("../data/vara-host.js");

const XARA = process.env.XARA_DIR || path.join(__dirname, "..", "xara");
const VEC = path.join(XARA, "vectors");
if (!fs.existsSync(VEC)) {
  console.error("missing " + VEC + " -- clone x0rro/xara at the commit in third_party/xara/README.md");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? "  " + detail : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const vector = rel => JSON.parse(fs.readFileSync(path.join(VEC, rel), "utf8"));
const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
const groups = {};

// ───────────────────────── command.rs
groups.command = () => {
  const P = H.parse, mycall = calls => ({kind: "mycall", calls}), retries = n => ({kind: "retries", n});
  const tune = d => ({kind: "tune", drive: d}), db = v => ({kind: "db", db: v});
  const cases = [
    ["MYCALL N0CALL", mycall(["N0CALL"])], ["MYCALL n0call n0call-1", mycall(["N0CALL", "N0CALL-1"])],
    ["MYCALL N0CALL1R", mycall(["N0CALL1-R"])], ["MYCALL N0/CALL", mycall(null)],
    ["CONNECT N0CALL n1call", {kind: "connect", mycall: "N0CALL", remote: "N1CALL"}],
    ["BW2300", {kind: "bw", hz: 2300}], ["LISTEN ON", {kind: "listen", on: true}], ["LISTEN CQ", {kind: "chat", on: true}],
    ["CHAT OFF", {kind: "chat", on: false}], ["COMPRESSION ON", {kind: "compression", comp: M.COMP.TEXT}],
    ["WINLINK SESSION", {kind: "winlinkSession"}], ["ABORT", {kind: "abort"}],
    ["RETRIES 3", retries(3)], ["RETRIES abc", retries(0)], ["RETRIES 300", retries(null)], ["RETRIES -1", retries(null)],
    ["RETRIES 1E1", retries(10)], ["RETRIES 2.5e+1", retries(25)], ["RETRIES 1D1", retries(10)], ["RETRIES 1.5d+1", retries(15)],
    ["RETRIES 3E", retries(3)], ["RETRIES 3D+", retries(3)], ["TUNE -12dB", tune(db(-12))], ["RETRIES 3e-x", retries(3)],
    ["RETRIES 1 2", retries(12)], ["RETRIES 1\t2　3", retries(123)], ["RETRIES 1\u000b2", retries(1)],
    ["RETRIES &H1F", retries(31)], ["RETRIES &o17", retries(15)], ["RETRIES &HFFFF", retries(null)],
    ["RETRIES &H1FFFF", retries(null)], ["RETRIES E5", retries(0)], ["TUNE ?", {kind: "tuneQuery"}], ["TUNE -6", tune(db(-6))],
  ];
  for (const [line, want] of cases) check("parse " + JSON.stringify(line), eq(P(line), want), JSON.stringify(P(line)));
  for (const bad of ["", "CONNECT N0CALL", "LISTEN MAYBE", "BW1000", "MYCALL", "FOO BAR", "version", "VERSION ", "BUFFER"])
    check("parse bad " + JSON.stringify(bad), P(bad) === null, JSON.stringify(P(bad)));
  const r = vector("host/commands.json").call_rules;
  for (const c of r.valid) check("valid call " + c, H.validCall(H.fixSuffix(c)) !== null);
  for (const c of r.invalid) check("invalid call " + c, H.validCall(H.fixSuffix(c)) === null);
  check("call -01", H.validCall("N0CALL-01") === "N0CALL-01");
  check("call suffixes", H.validCall("N0CALL-X") && H.validCall("N0CALL-16") && H.validCall("N0CALL-1A") === null);
  const oor = {kind: "outOfRange"}, nn = {kind: "notNumeric"};
  const tcases = [
    ["TUNE -6", tune(db(-6))], ["TUNE 0", tune(db(0))], ["TUNE -30", tune(db(-30))], ["TUNE -5.5", tune(db(-6))],
    ["TUNE -0.5", tune(db(0))], ["TUNE  -12dB", tune(db(-12))], ["TUNE -30.4", tune(oor)], ["TUNE 1", tune(oor)],
    ["TUNE ON", tune(nn)], ["TUNE ", tune(nn)], ["TUNE -", tune(nn)], ["TUNE -1e1", tune(db(-10))], ["TUNE -3E+2", tune(oor)],
    ["TUNE &HFFFF", tune(db(-1))], ["TUNE &HFFFE0", tune(oor)], ["TUNE .", tune(nn)], ["TUNE OFF", {kind: "tuneOff"}],
    ["TUNE off", {kind: "tuneOff"}], ["TUNE OFF ", {kind: "tuneOff"}], ["TUNE  OFF", {kind: "tuneOff"}], ["TUNE Off\t", {kind: "tuneOff"}],
    ["TUNE ? ", {kind: "tuneQuery"}], ["TUNE  ?", {kind: "tuneQuery"}], ["DRIVELEVEL -12", {kind: "driveLevel", drive: db(-12)}],
    ["DRIVELEVEL -45", {kind: "driveLevel", drive: oor}], ["DRIVELEVEL x", {kind: "driveLevel", drive: nn}],
  ];
  for (const [line, want] of tcases) {
    const got = P(line);
    // -0 vs 0 is not a difference here
    check("parse " + JSON.stringify(line), eq(JSON.parse(JSON.stringify(got)), want), JSON.stringify(got));
  }
  for (const bad of ["TUNE", "DRIVELEVEL", "tune -5", "drivelevel -5"]) check("parse bad " + bad, P(bad) === null);
};

// ───────────────────────── response.rs
groups.response = () => {
  const R = H.R;
  const cases = [
    [R.ok(), "OK"], [R.wrong(), "WRONG"], [R.busy(true), "BUSY ON"], [R.busy(false), "BUSY OFF"], [R.ptt(true), "PTT ON"],
    [R.ptt(false), "PTT OFF"], [R.bitrate(4, 566, true), "BITRATE (4)  566 bps TX"], [R.bitrate(1, 47, false), "BITRATE (1)  47 bps RX"],
    [R.pending(), "PENDING"], [R.cancelPending(), "CANCELPENDING"], [R.disconnected(), "DISCONNECTED"],
    [R.linkRegistered(true), "LINK REGISTERED"], [R.linkRegistered(false), "LINK UNREGISTERED"], [R.buffer(1234), "BUFFER 1234"],
    [R.sn(-3.25), "SN -3.2"], [R.sn(12.0), "SN 12.0"], [R.sn(0.15), "SN 0.1"], [R.sn(2.75), "SN 2.8"], [R.iAmAlive(), "IAMALIVE"],
    [R.registered(null), "REGISTERED"], [R.registered(["N0CALL", "N0CALL-5"]), "REGISTERED N0CALL N0CALL-5"],
    [R.registered(["N0\u0007CALL"]), "REGISTERED N0?CALL"], [R.encryptionDisabled(), "ENCRYPTION DISABLED"],
    [R.unencryptedLink(), "UNENCRYPTED LINK"], [R.tune(-5), "TUNE -5"], [R.tune(0), "TUNE 0"],
    [R.cleanTxBuffer(true), "CLEANTXBUFFER BUFFEREMPTY"], [R.cleanTxBuffer(false), "CLEANTXBUFFER FAILED "],
    [R.version("VERSION VARA HF v4.9.0"), "VERSION VARA HF v4.9.0"], [R.line("CQFRAME N0CALL-5"), "CQFRAME N0CALL-5"],
  ];
  for (const [got, want] of cases) check("reply " + want, got === want, got);
  const conn = (vias, w) => R.connected("N0CALL", "N1CALL-5", vias, w);
  check("connected 2300", conn([], "2300") === "CONNECTED N0CALL N1CALL-5 2300");
  check("connected via", conn(["N2CALL", "N3CALL"], "WIDE") === "CONNECTED N0CALL N1CALL-5 VIA N2CALL N3CALL WIDE");
  check("shown -R", H.shownCall("N0CALLA-R") === "N0CALLAR" && H.shownCall("N0CALL-R") === "N0CALL-R" && H.shownCall("N0CALLA-5") === "N0CALLA-5");
  const air = String.fromCharCode(0xE9, 65, 65, 65, 65, 0xE9, 65);
  check("shown non-ascii", H.shownCall(air) === "?AAAA?A");
  check("no injection", R.connected("N0CALL\rPTT OFF", "N1 CALL", ["N2\nCALL"], "NARROW") === "CONNECTED N0CALL?PTT?OFF N1?CALL VIA N2?CALL NARROW");
  check("no injection line", R.line("CQFRAME A\rDISCONNECTED\u007fé") === "CQFRAME A?DISCONNECTED??");
};

// ───────────────────────── host_protocol.rs: Lab of TNCs on an audio wire
class Client {
  constructor(lab, i) { this.lab = lab; this.i = i; this.lines = []; this.bytes = []; }
  send(s) { this.raw(s + "\r"); }
  raw(s) { this.lab.tnc[this.i].cmdBytes(ascii(s)); }
  write(b) { this.lab.tnc[this.i].dataBytes(typeof b === "string" ? ascii(b) : b); }
  close() { const h = this.lab.hosts[this.i]; if (h.client === this) { h.client = null; this.lab.tnc[this.i].clientClosed(); } }
  saw(s) { return this.lines.includes(s); }
  count(s) { return this.lines.filter(l => l === s).length; }
  since(i) { return this.lines.slice(i); }
}
const DEFAULT_OPTS = {driveDb: -5};
const mkTnc = (cfg, host) => new H.Tnc(new M.HfStation(cfg, DEFAULT_OPTS), host);
class Lab {
  constructor(cfgs) {
    this.hosts = cfgs.map(() => {
      const h = {client: null};
      h.line = s => { if (h.client) h.client.lines.push(s); };
      h.data = b => { if (h.client) for (const x of b) h.client.bytes.push(x); };
      h.hasCmdClient = () => !!h.client;
      h.hasDataClient = () => !!h.client;
      return h;
    });
    this.tnc = cfgs.map((c, i) => mkTnc(c, this.hosts[i]));
    this.wire = cfgs.map(() => [new Float64Array(480), new Float64Array(480)]);
    this.deaf = cfgs.map(() => false);
  }
  static of(n) { return new Lab(["XX0A", "XX0B"].slice(0, n).map(c => M.hfConfig(M.BW500, c))); }
  attach(i) {
    const c = new Client(this, i);
    this.hosts[i].client = c;
    this.tnc[i].clientConnected();
    this.tnc[i].clientConnected();
    this.sync();
    return c;
  }
  now() { return this.tnc[0].station.now / 48000; }
  sync() { for (const t of this.tnc) while (t.input.length) t.service(); }
  step() {
    const n = this.tnc.length;
    for (let i = 0; i < n; i++) {
      let input = new Float64Array(480);
      if (n === 2) { const b = this.wire[1 - i].shift(); if (!this.deaf[i]) input = b; }
      const out = new Float64Array(480);
      this.tnc[i].process(input, out);
      this.wire[i].push(out);
    }
  }
  runUntil(secs, done) {
    const end = this.tnc[0].station.now + Math.trunc(secs * 48000);
    for (;;) {
      this.sync();
      if (done(this)) return true;
      if (this.tnc[0].station.now >= end) return false;
      this.step();
    }
  }
  settle() { this.runUntil(0.1, () => false); }
}
function ask(lab, c, raw, n) {
  const start = c.lines.length, replies = () => c.lines.slice(start).filter(H.isReply);
  c.raw(raw);
  lab.runUntil(2.0, () => replies().length >= n);
  lab.settle();
  return replies();
}
function solo() {
  const lab = Lab.of(1), c = lab.attach(0);
  lab.settle();
  check("solo mycall", eq(ask(lab, c, "MYCALL N0CALL\r", 1), ["OK"]));
  return [lab, c];
}
const tokenMatches = (w, g) => w === g || (w.startsWith("{") && w.endsWith("}") && g.length > 0) ||
  (w === "(l)" && g.startsWith("(") && g.endsWith(")")) || (w === "b" && /^\d+$/.test(g));
const lineMatches = (w, g) => { const a = w.split(" "), b = g.split(" "); return a.length === b.length && a.every((x, i) => tokenMatches(x, b[i])); };
const quiet = l => l.startsWith("BUSY ") || ["IAMALIVE", "REGISTERED", "ENCRYPTION DISABLED"].includes(l);
function checkSequence(name, events, lines) {
  const got = lines.filter(l => !quiet(l));
  let pos = 0;
  for (const e of events) {
    const want = e.lines;
    if (!want.length || want.some(quiet)) continue;
    let at = null;
    for (let i = pos; i <= Math.max(got.length - want.length, 0); i++)
      if (got.length >= i + want.length && want.every((w, k) => lineMatches(w, got[i + k]))) { at = i; break; }
    if (at === null) { check(name + ": " + e.event, false, JSON.stringify(want) + " after line " + pos + "\n" + got.join(" | ")); return; }
    pos = at + want.length;
  }
  check(name, true);
}
const scenario = name => vector("host/messages.json").sequences[name].events.map(e => ({event: e.event, lines: e.lines}));
function link(lab, a, b) {
  lab.settle();
  for (const c of ["MYCALL N0CALL", "BW2300", "CHAT OFF", "COMPRESSION OFF"]) a.send(c);
  for (const c of ["MYCALL N1CALL", "BW2300", "CHAT OFF", "LISTEN ON"]) b.send(c);
  lab.settle();
  a.send("CONNECT N0CALL N1CALL");
  const want = "CONNECTED N0CALL N1CALL 2300";
  const ok = lab.runUntil(30, () => a.saw(want) && b.saw(want));
  check("link up", ok, "A: " + a.lines.join(" | ") + "\nB: " + b.lines.join(" | "));
  return ok;
}

groups.idle = () => {
  const cases = [];
  for (const v of vector("host/commands.json").vectors) if (v.state === "idle") cases.push([v.line + "\r", v.expect]);
  for (const t of vector("host/command_replies.json").table) {
    if (t.state !== "idle" || t.replies.length !== 1 || t.sent.startsWith("CLEANTXBUFFER") || !t.sent.endsWith("\r")) continue;
    cases.push([t.sent, t.replies[0].split(" | ")]);
  }
  check("idle case count", cases.length > 120, cases.length);
  for (const [sent, want] of cases) {
    const [lab, c] = solo();
    const got = ask(lab, c, sent, want.length);
    check("idle " + JSON.stringify(sent), eq(got, want), JSON.stringify(got));
  }
};

groups.framing = () => {
  let [lab, c] = solo();
  check("frame lf", ask(lab, c, "VERSION\n", 1).length === 0);
  check("frame cr", eq(ask(lab, c, "\r", 1), ["VERSION VARA HF v4.9.0"]));
  check("frame empty", eq(ask(lab, c, "\r", 1), ["WRONG"]));
  check("frame crlf", eq(ask(lab, c, "VERSION\r\n", 1), ["VERSION VARA HF v4.9.0"]));
  check("frame joined", eq(ask(lab, c, "LISTEN ON\nVERSION\r", 1), ["WRONG"]));
  check("frame clean", eq(ask(lab, c, "CLEANTXBUFFER\r", 1), ["CLEANTXBUFFER BUFFEREMPTY"]));
  c.write("hello");
  lab.sync();
  check("frame buffered", lab.tnc[0].station.buffered() === 5);
  check("frame abort", eq(ask(lab, c, "ABORT\r", 1), ["OK"]));
  check("frame disconnect", eq(ask(lab, c, "DISCONNECT\r", 1), ["OK"]));
  check("frame clean failed", eq(ask(lab, c, "CLEANTXBUFFER\r", 1), ["CLEANTXBUFFER FAILED "]));

  [lab, c] = solo();
  const r = lab => lab.tnc[0].station.config().host.retries;
  for (const [cmd, want] of [["RETRIES 5", 5], ["RETRIES 7", 7], ["RETRIES 0", 5], ["RETRIES 300", 5], ["RETRIES -1", 5]]) {
    check("retries " + cmd, eq(ask(lab, c, cmd + "\r", 1), ["OK"]) && r(lab) === want, r(lab));
  }
  [lab, c] = solo();
  ask(lab, c, "RETRIES 2\r", 1);
  ask(lab, c, "RETRIES abc\r", 1);
  check("retries abc", r(lab) === 15);

  [lab, c] = solo();
  ask(lab, c, "P2P SESSION\r", 1);
  let cfg = lab.tnc[0].station.config();
  check("p2p", cfg.p2p && !cfg.host.chat);
  ask(lab, c, "CHAT ON\r", 1);
  check("chat on", lab.tnc[0].station.config().host.chat);
  ask(lab, c, "WINLINK SESSION\r", 1);
  cfg = lab.tnc[0].station.config();
  check("winlink", !cfg.p2p && cfg.host.chat);
};

groups.linked = () => {
  const lab = Lab.of(2), a = lab.attach(0), b = lab.attach(1);
  if (!link(lab, a, b)) return;
  lab.runUntil(8, () => false);
  const last = ["LISTEN ON", "LISTEN OFF", "DISCONNECT", "ABORT", "MYCALL N0CALL-5", "CLEANTXBUFFER"];
  for (const v of vector("host/commands.json").vectors) {
    if (v.state !== "linked" || last.includes(v.line)) continue;
    const got = ask(lab, a, v.line + "\r", v.expect.length);
    check("linked " + v.line, eq(got, v.expect) && lab.tnc[0].station.state !== "Listen", JSON.stringify(got));
  }
  check("linked bw", lab.tnc[0].station.bandwidth() === M.BW2300);
  check("linked clean", eq(ask(lab, a, "CLEANTXBUFFER\r", 1), ["CLEANTXBUFFER BUFFEREMPTY"]));
  check("linked mycall deferred", eq(ask(lab, a, "MYCALL N0CALL-5\r", 1), ["WRONG"]));
  check("linked mycall bad", eq(ask(lab, b, "MYCALL N1CALL-0\r", 1), ["WRONG"]));
  const start = a.lines.length;
  check("linked listen on", eq(ask(lab, a, "LISTEN ON\r", 1), ["OK"]));
  check("linked dropped", lab.runUntil(10, () => a.saw("DISCONNECTED")));
  const tail = a.since(start).filter(l => !l.startsWith("BUSY"));
  check("linked tail", eq(tail, ["OK", "PTT ON", "PTT OFF", "DISCONNECTED"]), JSON.stringify(tail));
  check("linked registered", lab.runUntil(6, () => a.since(start).includes("REGISTERED")), JSON.stringify(a.since(start)));
  check("linked new mycall", eq(lab.tnc[0].station.config().host.mycalls, ["N0CALL-5"]));
  check("linked ok count", a.count("OK") === 10, a.count("OK"));
  check("linked peer gone", lab.runUntil(90, () => b.saw("DISCONNECTED")), JSON.stringify(b.lines));
  const i = b.lines.indexOf("DISCONNECTED");
  check("linked peer wrong", b.lines[i - 1] === "WRONG" && eq(lab.tnc[1].station.config().host.mycalls, ["N1CALL"]));
};

groups.session = () => {
  const lab = Lab.of(2), a = lab.attach(0), b = lab.attach(1);
  lab.settle();
  const a0 = a.lines.length, b0 = b.lines.length;
  if (!link(lab, a, b)) return;
  const msg = Uint8Array.from({length: 1500}, (_, i) => (i * 7) % 251);
  a.write(msg);
  check("session delivered", lab.runUntil(400, () => b.bytes.length >= msg.length) && eq(b.bytes, Array.from(msg)), b.bytes.length);
  check("session idle", lab.runUntil(30, l => l.tnc[0].station.state === "Idle"));
  a.send("DISCONNECT");
  check("session gone", lab.runUntil(40, () => a.saw("DISCONNECTED") && b.saw("DISCONNECTED")));
  lab.runUntil(3, () => false);
  let at = a.since(a0).filter(l => !H.isReply(l) || l === "OK");
  at = at.slice(at.findIndex(l => l.startsWith("PTT")) - 1);
  const bt = b.since(b0);
  checkSequence("caller sequence", scenario("caller_session_chatoff"), at);
  checkSequence("answerer sequence", scenario("answerer_session_chatoff"), bt);
  const sn = bt.filter(l => l.startsWith("SN ")).length, rx = bt.filter(l => l.startsWith("BITRATE") && l.endsWith("RX")).length;
  check("session sn/bitrate", rx > sn && sn > 3, sn + " " + rx);
  check("session link lines", !at.some(l => l.startsWith("LINK ")) && bt.filter(l => l.startsWith("LINK ")).length === 1);
  const buffers = at.filter(l => l.startsWith("BUFFER ")).map(l => +l.slice(7));
  check("session buffers", buffers[buffers.length - 1] === 0 && buffers.every((x, i) => i === 0 || x < buffers[i - 1]), JSON.stringify(buffers));
  for (const t of [at, bt]) {
    const i = t.lastIndexOf("DISCONNECTED");
    check("session ptt off before disc", t[i - 1] === "PTT OFF");
    check("session busy off after", eq(t.slice(i + 1).filter(l => l.startsWith("BUSY")), ["BUSY OFF"]), JSON.stringify(t.slice(i + 1)));
  }
};

groups.failed = () => {
  const lab = Lab.of(2), a = lab.attach(0), b = lab.attach(1);
  lab.settle();
  for (const c of ["MYCALL N0CALL", "BW2300", "RETRIES 2"]) a.send(c);
  lab.settle();
  const a0 = a.lines.length;
  a.send("CONNECT N0CALL N1CALL");
  check("failed call gone", lab.runUntil(30, () => a.saw("DISCONNECTED")));
  const t0 = lab.now();
  check("failed busy clears", lab.runUntil(3, l => !l.tnc[0].station.busy()));
  const hang = lab.now() - t0;
  check("failed hang", hang >= 1.40 && hang < 1.52, hang);
  lab.settle();
  const at = a.since(a0);
  check("failed start", eq(at.slice(0, 3), ["OK", "PTT ON", "BUSY ON"]), JSON.stringify(at.slice(0, 3)));
  checkSequence("failed_call", scenario("failed_call"), at);
  check("failed attempts", at.filter(l => l === "PTT ON").length === 3, JSON.stringify(at));

  for (const c of ["MYCALL N1CALL", "BW2300", "LISTEN ON"]) b.send(c);
  a.send("RETRIES 1");
  lab.settle();
  lab.deaf[0] = true;
  const b0 = b.lines.length;
  a.send("CONNECT N0CALL N1CALL");
  check("failed incoming cancel", lab.runUntil(40, () => b.since(b0).includes("CANCELPENDING")), JSON.stringify(b.since(b0)));
  lab.runUntil(3, () => false);
  const bt = b.since(b0);
  checkSequence("failed_incoming", scenario("failed_incoming"), bt);
  const i = bt.indexOf("CANCELPENDING");
  check("failed incoming quiet", !bt.some(l => l === "DISCONNECTED" || l.startsWith("CONNECTED")) && !bt.slice(i).some(l => l.startsWith("PTT")),
    JSON.stringify(bt));
};

groups.registered = () => {
  let lab = Lab.of(1), c = lab.attach(0);
  lab.settle();
  for (const l of ["MYCALL N0CALL", "MYCALL N0CALL-0", "MYCALL N0CALL-1"]) { c.send(l); lab.runUntil(1, () => false); }
  const t = lab.now();
  check("registered after 4 s", lab.runUntil(8, () => c.saw("REGISTERED")) && Math.abs(lab.now() - t - 4) < 0.1, lab.now() - t);
  lab.settle();
  const i = c.lines.indexOf("REGISTERED");
  check("registered then encryption", c.lines[i + 1] === "ENCRYPTION DISABLED" && c.count("REGISTERED") === 1);
  check("iamalive", lab.runUntil(60, () => c.saw("IAMALIVE")) && Math.abs(lab.now() - 60) < 0.1, lab.now());

  const cfg = M.hfConfig(M.BW500, "XX0A");
  cfg.host.registered = true;
  lab = new Lab([cfg]);
  c = lab.attach(0);
  lab.settle();
  check("registered calls ok", eq(ask(lab, c, "MYCALL N0CALL N0CALL-5\r", 1), ["OK"]));
  check("registered calls", lab.runUntil(8, () => c.lines.some(l => l.startsWith("REGISTERED"))));
  lab.settle();
  const k = c.lines.findIndex(l => l.startsWith("REGISTERED"));
  check("registered lists calls", eq(c.lines.slice(k, k + 2), ["REGISTERED N0CALL N0CALL-5", "ENCRYPTION DISABLED"]));
};

groups.drop = () => {
  const lab = Lab.of(2), a = lab.attach(0), b = lab.attach(1);
  lab.settle();
  check("drop version", eq(ask(lab, a, "VERSION\r", 1), ["VERSION VARA HF v4.9.0"]));
  b.write("queued before the link");
  if (!link(lab, a, b)) return;
  check("drop queued delivered", lab.runUntil(120, () => a.bytes.length >= 22) && Buffer.from(a.bytes).toString() === "queued before the link");
  lab.runUntil(5, () => false);
  a.close();
  lab.runUntil(1, () => false);
  check("drop to listen", lab.runUntil(10, l => l.tnc[0].station.state === "Listen"));
  check("drop chat off", !lab.tnc[0].station.config().host.chat);
  check("drop peer not yet", !b.saw("DISCONNECTED"));
  check("drop peer times out", lab.runUntil(90, () => b.saw("DISCONNECTED")));
  check("drop busy clears", lab.runUntil(5, l => !l.tnc[0].station.busy()));
  const a2 = lab.attach(0);
  lab.settle();
  check("drop reattach busy", eq(a2.lines.slice(0, 2), ["BUSY ON", "BUSY OFF"]), JSON.stringify(a2.lines));
  a2.write("lost at link end");
  lab.sync();
  check("drop buffered", lab.tnc[0].station.buffered() === 16);
  for (const c of ["RETRIES 1", "LISTEN ON"]) a2.send(c);
  b.send("LISTEN OFF");
  lab.settle();
  a2.send("CONNECT N0CALL N1CALL");
  check("drop no answer", lab.runUntil(30, () => a2.saw("DISCONNECTED")));
  check("drop buffer emptied", eq(ask(lab, a2, "CLEANTXBUFFER\r", 1), ["CLEANTXBUFFER BUFFEREMPTY"]) && !a2.lines.some(l => l.startsWith("BUFFER")));
};

groups.tune = () => {
  {
    const lab = Lab.of(1), a = lab.attach(0);
    lab.settle();
    a.send("IGNOREKISSDCD ON");
    a.send("CQFRAME N0CALL 2300");
    check("cq keyed", lab.runUntil(5, l => l.tnc[0].keyed), JSON.stringify(a.lines));
    lab.settle();
    const start = a.lines.length;
    lab.tnc[0].forcePttOff(true);
    check("cq unkeyed", lab.runUntil(15, l => !l.tnc[0].keyed));
    lab.tnc[0].forcePttOff(false);
    lab.settle();
    check("forced ptt once", eq(a.since(start).filter(l => l.startsWith("PTT")), ["PTT OFF"]));
  }
  let [lab, c] = solo();
  const drive = l => l.tnc[0].station.opts.driveDb, tuning = l => l.tnc[0].station.tuning();
  check("tune -40", eq(ask(lab, c, "TUNE -40\r", 1), ["OK"]) && !tuning(lab) && drive(lab) === -5);
  check("drive -12", eq(ask(lab, c, "DRIVELEVEL -12\r", 1), ["OK"]) && !tuning(lab));
  check("tune ?", eq(ask(lab, c, "TUNE ?\r", 1), ["TUNE -12"]));
  for (const junk of ["DRIVELEVEL abc\r", "DRIVELEVEL 3\r"]) check("drive junk", eq(ask(lab, c, junk, 1), ["OK"]));
  check("drive kept", drive(lab) === -12);
  check("tune on", eq(ask(lab, c, "TUNE ON\r", 1), ["OK"]) && tuning(lab) && drive(lab) === -12 && c.saw("PTT ON"));
  check("tune -8", eq(ask(lab, c, "TUNE -8\r", 1), ["OK"]) && tuning(lab) && drive(lab) === -8);
  check("drive -9.5", eq(ask(lab, c, "DRIVELEVEL -9.5\r", 1), ["OK"]) && tuning(lab) && drive(lab) === -10);
  check("tune off", eq(ask(lab, c, "TUNE OFF\r", 1), ["OK"]) && !tuning(lab) && c.saw("PTT OFF"));
  check("tune off again", eq(ask(lab, c, "TUNE OFF\r", 1), ["OK"]));
  check("tune bare", eq(ask(lab, c, "TUNE\r", 1), ["WRONG"]));
  check("tune lower", eq(ask(lab, c, "tune -5\r", 1), ["WRONG"]));
  check("tune -5.5", eq(ask(lab, c, "TUNE -5.5\r", 1), ["OK"]) && tuning(lab) && drive(lab) === -6);
  const t = lab.now();
  check("tune limit", lab.runUntil(70, l => !l.tnc[0].station.tuning()) && Math.abs(lab.now() - t - 60) < 0.2, lab.now() - t);

  [lab, c] = solo();
  check("host tune", eq(ask(lab, c, "TUNE -10\r", 1), ["OK"]) && tuning(lab));
  c.close();
  check("host gone stops tune", lab.runUntil(2, l => !l.tnc[0].station.tuning()) && lab.runUntil(2, l => !l.tnc[0].keyed));

  [lab, c] = solo();
  check("calling", eq(ask(lab, c, "CONNECT N0CALL N1CALL\r", 1), ["OK"]) && lab.tnc[0].station.state === "Calling");
  check("tune while calling", eq(ask(lab, c, "TUNE -7\r", 1), ["OK"]) && !tuning(lab) && drive(lab) === -7);
};

// ── run
const want = process.argv.slice(2);
for (const [name, fn] of Object.entries(groups)) {
  if (want.length && !want.includes(name)) continue;
  const t0 = Date.now(), f0 = fail;
  try { fn(); } catch (e) { fail++; console.log("FAIL " + name + " threw: " + (e.stack || e)); }
  console.log((fail === f0 ? "ok   " : "FAIL ") + name + " (" + (Date.now() - t0) + " ms)");
}
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
