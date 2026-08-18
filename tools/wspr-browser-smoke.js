#!/usr/bin/env node
"use strict";

// Test layer 4 of docs/wspr-majak-implementace.md: serves the production WSPR
// assets plus a firmware fixture, then drives the real page in headless Chrome.
// No radio and no ESP32 involved.
//
// The fixture answers /state, /cmd and the session endpoints, and records what
// the page asked for, so the assertions are about what actually went to the
// firmware rather than about what the page rendered.

const http = require("http"), fs = require("fs"), path = require("path");
const crypto = require("crypto");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");

let radioName = "IC-705";
// The LAN health counters the header reports. Mutable so the page can be checked
// in both states: silent while the link is clean, spelled out once it is not.
const lanHealth = {drops: 0, stalls: 0, filled: 0};
const commands = [];
const session = {token: "", claims: 0, pings: 0, releases: 0};
let finished = false, chrome = null, timer = null;

function stateJson() {
  return {
    connected: currentConnected, catHealthy: true, audioReady: true,
    lanStatus: "linked", btStatus: "LAN linked", wifiStatus: "WiFi STA",
    radioTransport: "lan", fullCat: true, tuneSupported: true,
    wifiRssi: -55, fwRev: "20260726", bdSupported: false, power: true,
    frequency: currentFrequency, mode: currentMode, filter: 1,
    radioAddress: "0xA4", transceiverType: "ICOM-LAN", radioName,
    tx: false, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 118,
    afGain: 100, keySpeed: 20, rfPower: currentRfPower, rfPowerSeen: true,
    supplyVolts: 13.8, swr: 1.2, preamp: 0, vox: 0,
    lanDrops: lanHealth.drops, lanStalls: lanHealth.stalls, lanFilled: lanHealth.filled,
    dxcConnected: false,
  };
}

let currentFrequency = 14074000, currentMode = "USB", currentRfPower = 128;
// The station's own identity, which is where the beacon's callsign comes from
// now. Mutable, because "somebody changed it in SETUP while this page was open"
// is the case the page has to survive.
const identity = {call: "OK1HRA", grid: "JN79QI"};
const pageErrors = [], progress = [];
let currentConnected = true;

const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

const DEBUG = process.env.WSPR_SMOKE_DEBUG === "1";
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (DEBUG) console.error(`  <- ${request.method} ${url.pathname}`);
  const body = [];
  request.on("data", chunk => body.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(body).toString();
    const json = value => {
      response.writeHead(200, {"Content-Type": "application/json", "Cache-Control": "no-store"});
      response.end(JSON.stringify(value));
    };

    if (url.pathname === "/state") return json(stateJson());

    // lan-gate.js reads this before the page boots at all. The default answer
    // puts a fully configured ICOM-LAN on TRX1; ?lanFixture=trx2 moves it, which
    // is the case that used to break silently because the page asked the primary
    // radio instead of the LAN slot, and ?lanFixture=missing closes the gate.
    if (url.pathname === "/setup-data.json") {
      const fixture = url.searchParams.get("fixture");
      const missing = fixture === "missing";
      const onTrx2 = fixture === "trx2";
      const creds = {lanip: "192.168.1.60", lanuser: "operator", lanpass: "secret123"};
      const blank = {lanip: "", lanuser: "", lanpass: ""};
      const slot = (index, transport, values) => ({
        [`trx${index}transport`]: transport,
        [`trx${index}lanip`]: values.lanip,
        [`trx${index}lanuser`]: values.lanuser,
        [`trx${index}lanpass`]: values.lanpass,
      });
      return json({
        fwRev: 20260727, blockedDxcc: "",
        ...slot(1, missing ? "trxnet" : onTrx2 ? "civ" : "lan", missing || onTrx2 ? blank : creds),
        ...slot(2, onTrx2 ? "lan" : "trxnet", onTrx2 ? creds : blank),
        ...slot(3, "trxnet", blank),
      });
    }

    // Two strings out of the interface's EEPROM. Its own route because
    // /setup-data.json is two kilobytes and three filesystem reads for the same
    // answer, and the pages re-read this one every minute.
    if (url.pathname === "/identity") {
      if (request.method === "POST") {
        const wanted = JSON.parse(text || "{}");
        if (wanted.call !== undefined) identity.call = String(wanted.call).toUpperCase();
        if (wanted.grid !== undefined) identity.grid = String(wanted.grid).toUpperCase();
      }
      return json({ok: true, call: identity.call, grid: identity.grid});
    }

    if (url.pathname === "/cmd" && request.method === "POST") {
      const command = JSON.parse(text || "{}");
      commands.push(command);
      // Behave like the radio: apply the change so the page's readback waits
      // actually resolve, which is what makes the verify-don't-assume path
      // testable at all.
      if (command.type === "setFrequency") currentFrequency = Number(command.frequency);
      if (command.type === "civ.raw" && String(command.data).startsWith("2600")) currentMode = "USB-D";
      // 14 0A WITH a payload sets the power; 14 0A alone is a READ request, and a real
      // radio answers it without changing anything. The fixture used to decode the
      // empty payload as zero, so every read poke silently set the power to 0 % and no
      // confirmation could ever match -- a fixture bug that would have looked exactly
      // like the radio refusing the write.
      if (command.type === "civ.raw" && String(command.data).startsWith("140A") &&
          String(command.data).length > 4) {
        currentRfPower = decodeCivBcd(String(command.data).slice(4));
      }
      // A MOD level write, the one setting this tool changes inside the radio. The
      // fixture stores it because the simulated knee DEPENDS on it: a plan that
      // wrote the level and then measured against the old sensitivity would produce
      // a matrix that is uniformly wrong, and nothing else could catch that.
      for (const [command4, address] of Object.entries(CIV_SETTINGS)) {
        if (command.type !== "civ.raw" || !String(command.data).startsWith(command4)) continue;
        civSettings[command4] = address.bytes === 1
          ? parseInt(String(command.data).slice(8, 10), 16)
          : decodeCivBcd(String(command.data).slice(8));
      }
      // civ.read arms a prefix exactly as the firmware does, and answers only if
      // this radio has that address. Absence is the signal for everything else.
      if (command.type === "civ.read") {
        const asked = String(command.data).toUpperCase();
        const before = civRead.seq;
        civRead.cmd = asked;
        civRead.reply = "";
        const known = CIV_SETTINGS[asked];
        if (known && !civReadSilent) {
          const value = civSettings[asked];
          civRead.reply = asked + (known.bytes === 1
            ? value.toString(16).toUpperCase().padStart(2, "0")
            : encodeCivBcd(value));
          civRead.seq++;
        }
        return json({ok: true, seq: before});
      }
      return json({ok: true});
    }

    // Deliberately NOT an empty-but-valid document: a firmware without this
    // endpoint 404s, and that is how the page tells "flash the firmware" from "the
    // radio never answered". ?civread=missing is that older firmware.
    // What the fixture's own knee is at this instant, so an assertion can compare a
    // measurement against the radio's truth instead of a number typed into the test.
    // A hardcoded knee stopped being possible when the knee became a function -- and
    // that is the point: the formula is what proves the plan retuned and set power.
    // A page error used to be invisible: the injected script's try/catch cannot see
    // one thrown by the page's OWN script, so the only symptom was the harness
    // timeout four minutes later, with every check failing for no stated reason.
    // Where the page got to. The check list is posted in ONE go at the very end, so a
    // page that hangs used to report nothing at all -- every server-side check failed
    // and the message named none of them. This is the breadcrumb trail.
    if (url.pathname === "/progress" && request.method === "POST") {
      progress.push(text.slice(0, 120));
      if (DEBUG) console.error("  .. " + text.slice(0, 120));
      return json({ok: true});
    }

    if (url.pathname === "/oops" && request.method === "POST") {
      pageErrors.push(text.slice(0, 400));
      console.error("  page error: " + text.slice(0, 400));
      return json({ok: true});
    }

    if (url.pathname === "/knee")
      return json({knee: currentKnee(), band: bandOfHz(currentFrequency),
                   percent: Math.round(currentRfPower * 100 / 255),
                   modLevel: civSettings["1A050117"], frequency: currentFrequency});

    if (url.pathname === "/civ-settings") return json({...civSettings});

    if (url.pathname === "/civread") {
      if (civReadMissing) {
        response.writeHead(404, {"Content-Type": "text/plain"});
        response.end("Not found");
        return;
      }
      return json({seq: civRead.seq, cmd: civRead.cmd, reply: civRead.reply, ageMs: 10});
    }

    if (url.pathname.startsWith("/js8/session/")) {
      const parsed = JSON.parse(text || "{}");
      if (url.pathname.endsWith("claim")) { session.token = parsed.token; session.claims++; }
      if (url.pathname.endsWith("ping")) session.pings++;
      if (url.pathname.endsWith("release")) session.releases++;
      return json({ok: true, owner: "192.168.1.99", ageMs: 100, leaseMs: 15000});
    }

    // Lets the page assert that a gated load claimed nothing.
    if (url.pathname === "/claims") return json({claims: session.claims});

    // What the page last asked the firmware for. The alcFast flag is invisible
    // from the page side once sent, and it is the difference between a search
    // that gets fifteen steps out of a carrier and one that gets seven.
    if (url.pathname === "/prepares")
      return json(aud1.prepares[aud1.prepares.length - 1] || {});

    // The station's calibration table, exactly as the firmware serves it: a blob
    // it never looks inside, and a missing file that reads as an empty document
    // rather than a 404.
    if (url.pathname === "/txgain.json") {
      if (request.method === "POST") { txgainDoc = text; return json({ok: true}); }
      response.writeHead(200, {"Content-Type": "application/json", "Cache-Control": "no-store"});
      return response.end(txgainDoc);
    }

    if (url.pathname === "/result" && request.method === "POST") {
      response.writeHead(204).end();
      return finish(JSON.parse(text));
    }

    if (url.pathname === "/setModel" && request.method === "POST") {
      radioName = text;
      return json({ok: true});
    }

    // The knob on the radio, as far as this fixture is concerned. The page is
    // supposed to follow it rather than command it, so the test needs to be able
    // to turn it -- including past the ten-watt ceiling.
    if (url.pathname === "/setRfPower" && request.method === "POST") {
      currentRfPower = Math.max(0, Math.min(255, Number(text) || 0));
      return json({ok: true});
    }

    // The VFO knob, for the same reason: an operator can turn the radio off a
    // WSPR dial frequency without the page having sent anything, and that is the
    // state the dial warning exists for.
    if (url.pathname === "/setDialFrequency" && request.method === "POST") {
      currentFrequency = Number(text) || 0;
      return json({ok: true});
    }

    // The radio's link, so the automatic power write can be tested at the only
    // moment it is supposed to fire. Note this is the FIRMWARE saying the radio
    // is gone, which is a different thing from /state not answering at all --
    // the page treats only the former as a reconnect.
    if (url.pathname === "/setConnected" && request.method === "POST") {
      currentConnected = text === "true";
      return json({ok: true});
    }

    // Lets the browser side assert on what the page did or did not send.
    if (url.pathname === "/setLanHealth") {
      lanHealth.drops = Number(url.searchParams.get("drops") || 0);
      lanHealth.stalls = Number(url.searchParams.get("stalls") || 0);
      lanHealth.filled = Number(url.searchParams.get("filled") || 0);
      return json({ok: true});
    }

    if (url.pathname === "/commands") return json(commands);

    const file = url.pathname === "/wspr.html" || url.pathname === "/"
      ? path.join(data, "wspr.html") : path.join(data, path.basename(url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
      return response.end(fs.readFileSync(file));
    }
    response.writeHead(404).end("not found");
  });
});


// ---- AUD1 WebSocket fixture -------------------------------------------------
//
// Enough of the firmware's port-83 endpoint to exercise the page's TX path: the
// hello, tx-ready for a prepare, and then tx-state / tx-level so the credit loop
// in wspr-tx.js actually has a clock to run on. A full 110 s transmission is
// layer 3's job; here the point is that the page drives the socket at all.
const aud1 = {sockets: 0, prepares: [], packets: 0, pings: 0, aborts: 0, keyed: false,
              identityFailures: 0};

// ---- the simulated ALC ------------------------------------------------------
//
// The fixture receives the very PCM16 the page produces, so it can answer the
// one question the gain search asks: is the level the radio is playing RIGHT NOW
// above the knee? Both halves of that matter.
//
//  * "the level" is read from the audio, not from anything the page told us. A
//    search that converged because the page and the test agreed on a number
//    would prove nothing.
//  * "right now" means at `consumed`, not at the head of the queue. The browser
//    runs half a second ahead; answering from the newest packet would hide the
//    entire latency problem this design is built around, and the byte accounting
//    would never be tested at all.
//
// The meter also decays: one stale non-zero reading after the drive drops. That
// is what makes the asymmetric settle in tx-gain-cal.js a tested rule rather
// than a comment.
// ---- the simulated radio's sensitivity --------------------------------------
//
// The knee is not a constant any more: it is
//
//     knee = K(band) x percent / modLevel
//
// which is the physics the whole design rests on (the audio level at which the
// radio starts limiting scales with how much RF it is asked for and inversely with
// how sensitive its network input is). Making the fixture obey it turns two
// otherwise untestable claims into assertions:
//
//   * a plan that forgets to retune, or to set the power, measures against the
//     wrong knee -- so the numbers it stores no longer match the formula, and the
//     harness says so. Nothing else can catch that: the page would look busy and
//     the table would look full.
//   * a plan that writes the MOD level and then keeps its earlier measurements is
//     wrong by exactly the ratio it just changed. Here that shows up as a knee that
//     does not move when it should.
//
// 40 m is deliberately the hungriest band, so it is the one that must end up owning
// the MOD level.
// Scaled so the scenario the single-shot test runs -- 80 m at 50 % with the MOD level
// at 128 -- lands on 0.31, which is what this fixture's knee used to be before it
// became a function. 40 m is the hungriest band on purpose: it is the one the MOD
// level must end up serving.
const KNEE_K = {"160m": 1.05, "80m": 0.79, "60m": 0.85, "40m": 1.10, "30m": 0.75,
                "20m": 0.70, "17m": 0.62, "15m": 0.55, "12m": 0.50, "10m": 0.46,
                "6m": 0.40, "2m": 0.35};
const ALC_KNEE = 0.31;                  // the single-shot tests' fixed radio

// The 1A 05 settings this simulated radio HAS. Anything else gets no reply at all,
// which is how a real radio refuses an address -- the firmware does not parse NG.
const CIV_SETTINGS = {
  "1A050117": {bytes: 2, what: "WLAN MOD level"},
  "1A050119": {bytes: 1, what: "DATA MOD input"},
};
const civSettings = {"1A050117": 128, "1A050119": 3};   // 3 = WLAN
const civRead = {seq: 0, cmd: "", reply: ""};
let civReadMissing = false, civReadSilent = false;

// The knee the radio would show RIGHT NOW, from what it is actually tuned and set
// to. Read from the fixture's own state, never from what the page asked for.
function currentKnee() {
  const band = bandOfHz(currentFrequency);
  const percent = Math.round(currentRfPower * 100 / 255);
  const k = KNEE_K[band];
  const modLevel = civSettings["1A050117"];
  if (!k || !percent || !modLevel) return ALC_KNEE;
  return k * percent / modLevel;
}

// Same edges as tx-gain-cal.js bandOf(), so the fixture and the page agree about
// which band a dial is on -- if they disagreed, every assertion below would be
// comparing two different cells.
const FIXTURE_BANDS = [
  [1800000, 2000000, "160m"], [3500000, 4000000, "80m"], [5250000, 5450000, "60m"],
  [7000000, 7300000, "40m"], [10100000, 10150000, "30m"], [14000000, 14350000, "20m"],
  [18068000, 18168000, "17m"], [21000000, 21450000, "15m"], [24890000, 24990000, "12m"],
  [28000000, 29700000, "10m"], [50000000, 54000000, "6m"], [144000000, 148000000, "2m"],
];
const bandOfHz = hz => (FIXTURE_BANDS.find(([low, high]) => hz >= low && hz <= high) || [])[2] || "";

const decodeCivBcd = hex => {
  let out = 0;
  for (let at = 0; at + 1 < hex.length; at += 2) {
    const byte = parseInt(hex.slice(at, at + 2), 16);
    out = out * 100 + (byte >> 4) * 10 + (byte & 0x0f);
  }
  return out;
};
const encodeCivBcd = value => {
  const level = Math.max(0, Math.min(255, Math.round(value)));
  const pair = number => number.toString(16).toUpperCase().padStart(2, "0");
  return pair(Math.floor(level / 100)) + pair((((level / 10) | 0) % 10) * 16 + (level % 10));
};

const ULAW_BYTES_PER_PACKET = 160;      // 960 samples at 48 kHz, decimated 6:1
let txgainDoc = '{}';

function packetPeak(payload) {
  let peak = 0;
  for (let at = 40; at + 1 < payload.length; at += 2) {
    const sample = Math.abs(payload.readInt16LE(at));
    if (sample > peak) peak = sample;
  }
  return peak / 32767;
}

// Deliberately not 0x53505752. That value used to be both this fixture's hello
// and WsprTx's hardcoded default, so the page could ship a stream identity the
// firmware rejects (aud1AcceptTxPacket compares against the hello it minted with
// esp_random) and this harness would still pass. A value the page cannot guess
// is the whole point.
const HELLO_STREAM_ID = 0xd2c5f9da;

function wsFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return body.length < 126
    ? Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
    : Buffer.concat([Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]), body]);
}

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname !== "/audiows") return socket.destroy();
  const key = request.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
               "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  aud1.sockets++;

  const streamId = HELLO_STREAM_ID;
  socket.write(wsFrame(1, JSON.stringify({type: "hello", protocol: "AUD1", version: 1, streamId})));

  let consumed = 0, levelTimer = null;
  let input = Buffer.alloc(0);
  const peaks = [];          // one entry per 20 ms packet, in arrival order
  let alcSeq = 0, alcTick = 0, alcDecay = 0;
  socket.on("data", chunk => {
    input = Buffer.concat([input, chunk]);
    for (;;) {
      if (input.length < 2) return;
      let at = 2, length = input[1] & 127;
      if (length === 126) { if (input.length < 4) return; length = input.readUInt16BE(2); at = 4; }
      else if (length === 127) return socket.destroy();
      const masked = Boolean(input[1] & 128);
      if (masked) at += 4;
      if (input.length < at + length) return;
      const opcode = input[0] & 15, maskAt = at - 4;
      const payload = Buffer.from(input.subarray(at, at + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= input[maskAt + (i % 4)];
      input = input.subarray(at + length);

      if (opcode === 1) {
        const message = JSON.parse(payload.toString());
        if (message.type === "wspr.ping") aud1.pings++;
        if (message.type === "tx.abort") aud1.aborts++;
        if (message.type === "tx.prepare") {
          aud1.prepares.push(message);
          // Every transmission starts its byte accounting from zero, exactly as
          // aud1TxResetState does in the firmware. Carrying a socket-lifetime
          // counter across transmissions used to make the second one read its
          // ALC from the first one's audio -- which is precisely the confusion
          // the alcSeq/consumed design exists to prevent, reproduced inside the
          // test meant to catch it.
          if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
          consumed = 0; peaks.length = 0; alcSeq = 0; alcTick = 0; alcDecay = 0;
          aud1.keyed = false;
          socket.write(wsFrame(1, JSON.stringify({type: "tx-ready", txId: message.txId, ptt: false})));
        }
      } else if (opcode === 2) {
        aud1.packets++;
        // The firmware refuses a TX packet whose stream identity is not the one
        // it minted (wifilt.ino, aud1AcceptTxPacket). Mirroring that
        // here is what turns "the radio aborts every transmission" into a
        // failing test instead of an on-air surprise.
        if (payload.readUInt32BE(12) !== streamId) aud1.identityFailures++;
        peaks.push(packetPeak(payload));
        if (!aud1.keyed) {
          aud1.keyed = true;
          const txId = payload.readUInt32BE(32);
          socket.write(wsFrame(1, JSON.stringify({type: "tx-state", txId, ptt: true})));
          // Drain at real time (8 mu-law bytes per ms) so the credit loop keeps
          // opening room, exactly as aud1TxTick does.
          levelTimer = setInterval(() => {
            consumed += 1600;
            // The level the radio is playing at this byte, not the newest one
            // the browser has written.
            const live = peaks[Math.floor(consumed / ULAW_BYTES_PER_PACKET)] ?? 0;
            // alcFast asks for 2 Hz; the fixture obliges only when the page
            // asked for it, so a run that forgot the flag reads half as often
            // and the harness notices in the step count.
            const fast = aud1.prepares.length > 0 &&
                         aud1.prepares[aud1.prepares.length - 1].alcFast === true;
            let alc = 0;
            if (++alcTick % (fast ? 2 : 5) === 0) {
              alcSeq++;
              if (live > currentKnee()) { alc = 40; alcDecay = 1; }
              else if (alcDecay > 0) { alc = 20; alcDecay--; }
            }
            if (process.env.CALDEBUG) console.error("  tick consumed=" + consumed +
              " idx=" + Math.floor(consumed / ULAW_BYTES_PER_PACKET) +
              " live=" + live.toFixed(4) + " peaks=" + peaks.length + " alc=" + alc);
            socket.write(wsFrame(1, JSON.stringify({type: "tx-level", txId,
              used: 8000, capacity: 12288, consumed, alc, alcSeq, ptt: true})));
          }, 200);
        }
      } else if (opcode === 8) {
        socket.destroy();
      }
    }
  });
  socket.on("close", () => { if (levelTimer) clearInterval(levelTimer); });
  socket.on("error", () => { if (levelTimer) clearInterval(levelTimer); });
});

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();

  const checks = result.checks || [];
  // Fixture-side assertions: what the page actually sent to the firmware.
  // Not `find`: the test also tunes a band by hand from the dial menu, so the
  // first setFrequency is the operator's, not the schedule's.
  const tuned = commands.filter(command => command.type === "setFrequency")
                        .find(command => Number(command.frequency) === 14095600);
  checks.push(["claimed the session lock", session.claims > 0, `${session.claims}`]);
  checks.push(["tuned the scheduled band", Boolean(tuned),
               commands.filter(command => command.type === "setFrequency")
                       .map(command => command.frequency).join(",") || "no setFrequency"]);
  checks.push(["switched to USB-D via civ.raw",
               commands.some(c => c.type === "civ.raw" && String(c.data).startsWith("260001")), ""]);
  // Not `find`: the page writes power by itself on load and after a reconnect
  // now, so the FIRST 140A is the automation's 1 % and the operator's SET is
  // somewhere behind it. 37 dBm on a 10 W IC-705 is 5.01 W = 50.1 % = level 128
  // = BCD 01 28.
  const powerWrites = commands.filter(c => c.type === "civ.raw" &&
                                      String(c.data).startsWith("140A"));
  checks.push(["set power as 140A0128 (37 dBm on a 10 W radio)",
               powerWrites.some(c => c.data === "140A0128"),
               powerWrites.map(c => c.data).join(",") || "no power command"]);
  // Everything the page wrote by itself is 1 % of a 10 W radio, and nothing else:
  // the automation applies the target, so a level that is neither the operator's
  // 37 dBm nor the 20 dBm proposal would mean it invented one.
  // 140A0018 is 7 % -- the one power the batch plan's own scenario asks for. The plan
  // is the one thing on this page allowed to write a level the WSPR menu never
  // offered, because the operator ticked it in the grid; every OTHER level still has
  // to come from the menu, which is what this check exists for.
  // Reads are not writes: a bare 14 0A asks the radio what it is set to, which the
  // plan does after every power write rather than waiting for the poll rotation.
  const realPowerWrites = powerWrites.filter(c => String(c.data).length > 4);
  checks.push(["the page only ever wrote levels from its own menu, or the plan's grid",
               realPowerWrites.every(c => ["140A0003", "140A0128", "140A0102"].includes(c.data)),
               realPowerWrites.map(c => c.data).join(",")]);
  checks.push(["and it asks the radio to confirm rather than waiting to be told",
               powerWrites.some(c => String(c.data) === "140A"),
               String(powerWrites.length) + " power frames"]);

  // AUD1-side assertions: the page really drove the audio socket.
  const prepare = aud1.prepares[0];
  checks.push(["opened the AUD1 socket", aud1.sockets > 0, String(aud1.sockets)]);
  checks.push(["every TX packet carried the hello stream identity",
               aud1.packets > 0 && aud1.identityFailures === 0,
               `packets=${aud1.packets} rejected=${aud1.identityFailures}`]);
  checks.push(["sent the liveness keepalive", aud1.pings > 0, String(aud1.pings)]);
  checks.push(["tx.prepare declares the full WSPR frame",
               Boolean(prepare) && prepare.samples === 5308416 && prepare.packets === 5530 &&
               prepare.sampleRate === 48000 && prepare.packetMs === 20 &&
               prepare.prebufferSamples === 48000,
               prepare ? JSON.stringify({samples: prepare.samples, packets: prepare.packets,
                 prebuffer: prepare.prebufferSamples}) : "no tx.prepare"]);
  checks.push(["tx.prepare slot is one second past an even minute",
               Boolean(prepare) && new Date(prepare.slotUtcMs).getUTCSeconds() === 1 &&
               new Date(prepare.slotUtcMs).getUTCMinutes() % 2 === 0,
               prepare ? new Date(prepare.slotUtcMs).toISOString() : ""]);
  // Decision 9 is unattended:false. Aud1WebSocketSession does not forward the
  // flag, so what must hold is that the firmware never sees a TRUE one -- absent
  // reads as false there, and the flag can only restrict, never unlock.
  checks.push(["tx.prepare never claims unattended operation (decision 9)",
               Boolean(prepare) && prepare.unattended !== true,
               prepare ? String(prepare.unattended) : "no tx.prepare"]);
  checks.push(["streamed audio packets after keying", aud1.packets > 60, String(aud1.packets)]);

  let failures = 0;
  for (const [name, pass, detail] of checks) {
    if (pass) continue;
    failures++;
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
  if (process.env.WSPR_DUMP) for (const [name] of checks) console.log(`CHECK ${name}`);
  console.log(`${checks.length - failures}/${checks.length} checks passed`);
  process.exitCode = failures ? 1 : 0;
}

// ---- the page-side script --------------------------------------------------

const PAGE_SCRIPT = `
// Reported rather than swallowed: an error in the page's own script is invisible to
// the try/catch below, and without this it only ever showed up as a timeout.
addEventListener("error", event => {
  try { fetch("/oops", {method: "POST", body: String((event.error && event.error.stack) ||
    event.message || "unknown page error")}); } catch (_error) {}
});
addEventListener("unhandledrejection", event => {
  try { fetch("/oops", {method: "POST", body: "unhandled rejection: " +
    String((event.reason && event.reason.stack) || event.reason)}); } catch (_error) {}
});

(async () => {
  const checks = [];
  const check = (name, pass, detail = "") => {
    checks.push([name, Boolean(pass), String(detail)]);
    // A breadcrumb, not a result: the list above is posted in one go at the end, so
    // without this a page that hangs mid-scenario reports nothing about where.
    try { fetch("/progress", {method: "POST", body: (pass ? "ok " : "FAIL ") + name}); }
    catch (_error) {}
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (test, ms = 6000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await test()) return true; await sleep(100); }
    return false;
  };
  // What the page has actually sent to the radio, read back from the fixture.
  const commandsSeen = async () => (await fetch("/commands")).json();
  const $ = id => document.getElementById(id);
  const set = (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event("input", {bubbles: true}));
    element.dispatchEvent(new Event("change", {bubbles: true}));
  };

  try {
    // Booting is now behind lan-gate.js, so __wspr appears one round trip to
    // /setup-data.json later rather than synchronously.
    check("page booted", await wait(() => Boolean(globalThis.__wspr), 10000));

    // The keeper starts on every load. This harness browses 127.0.0.1, which IS a
    // secure context, so navigator.wakeLock exists here and the branch taken is
    // the real API -- or the video, when headless Chrome rejects the request for
    // want of a screen. Both are healthy, so both are accepted. The fallback that
    // production actually runs is pinned down elsewhere: data-browser-smoke.js
    // browses the named host wifilt.test, which is insecure like the radio, and
    // asserts the video branch exactly.
    await wait(() => $("wakeLockDot") && !$("wakeLockDot").hidden, 8000);
    const wakeDot = $("wakeLockDot");
    check("wake lock dot is in the topbar", Boolean(wakeDot),
          wakeDot ? "found" : "missing");
    check("wake lock holds the display",
          Boolean(wakeDot) && ["wake-lock", "video"].indexOf(wakeDot.dataset.wakelockState) >= 0,
          wakeDot ? wakeDot.dataset.wakelockState : "missing");
    check("the dot puts no words on the page",
          Boolean(wakeDot) && wakeDot.textContent === "",
          wakeDot ? JSON.stringify(wakeDot.textContent) : "missing");
    check("the explanation lives in the hover panel",
          Boolean(wakeDot) && String(wakeDot.getAttribute("data-tip")).length > 20,
          wakeDot ? String(wakeDot.getAttribute("data-tip")) : "missing");

    // The page starts polling /state and claiming the lock at load; this script
    // runs synchronously right after it, so everything below has to wait for the
    // first round trip or it asserts against the pre-boot defaults.
    const booted = await wait(() => globalThis.__wspr.state.radio.connected &&
                                    globalThis.__wspr.sessionHeld, 15000);
    check("radio state and session lock settled", booted,
          "connected=" + globalThis.__wspr.state.radio.connected +
          " held=" + globalThis.__wspr.sessionHeld);

    check("LAN transport detected", globalThis.__wspr.state.radio.transceiverType === "ICOM-LAN",
          globalThis.__wspr.state.radio.transceiverType);
    check("LAN gate absent on a configured radio",
          !$("lanGate") && !document.body.classList.contains("lan-gate-blocked"));
    check("DATA sub-nav marks WSPR-Beacon and offers JS8Call-ICOM",
          document.querySelector(".subtabs .subtab-active")?.getAttribute("href") === "/wspr.html" &&
          document.querySelector(".subtabs .subtab-active")?.textContent.trim() === "WSPR-Beacon" &&
          document.querySelector('.subtabs a[href="/data"]')?.textContent.trim() === "JS8Call-ICOM" &&
          !document.querySelector(".subtabs a[target]") &&
          !document.querySelector('.tabs a[href="/wspr.html"]'));
    check("primary nav says DATA",
          document.querySelector('.tabs a[href="/data"]')?.textContent.trim() === "DATA");
    // The brand mark stays inside the row height the text tabs set, so the bar
    // never grows a second line on its account.
    const brandBox = document.querySelector(".tabs")?.firstElementChild;
    const brandSvg = brandBox?.querySelector("summary svg");
    const firstTextTab = document.querySelector('.tabs a[href="/log"]');
    check("brand mark fits the existing bar height",
          brandBox?.tagName === "DETAILS" &&
          Boolean(brandSvg?.querySelector("path")) &&
          Math.round(brandSvg.getBoundingClientRect().height) === 26 &&
          brandBox.getBoundingClientRect().height <= firstTextTab.getBoundingClientRect().height,
          brandBox ? brandBox.getBoundingClientRect().height + " vs tab " +
                     firstTextTab.getBoundingClientRect().height : "missing");
    // Opens under its own trigger and an outside click puts it away, exactly
    // like the timetable panel two rows below it.
    check("About panel opens under the mark and closes on an outside click",
          (() => {
            const panel = brandBox?.querySelector("div");
            if (!panel) return false;
            // A closed <details> still gives its content a box, so only
            // checkVisibility can tell the two states apart -- and it reads
            // cached style, hence the rect read in front of it to flush layout.
            const visible = () => {
              panel.getBoundingClientRect();
              return panel.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true });
            };
            if (brandBox.open || visible()) return false;
            brandBox.querySelector("summary").click();
            const opened = brandBox.open &&
                           panel.getBoundingClientRect().top >= brandBox.getBoundingClientRect().bottom &&
                           visible() &&
                           panel.querySelector('a[href="https://remoteqth.com"]')?.textContent.trim() === "by RemoteQTH.com";
            document.querySelector(".tabs").click();
            return opened && !brandBox.open && !visible();
          })());

    // The fixture parks the radio on a JS8 frequency in plain USB, which is
    // neither a data mode nor within 500 Hz of any WSPR dial frequency -- the
    // state the setup card exists for. It must open by itself.
    check("an unusable radio opens the setup help by itself",
          await wait(() => $("trxHelpDialog").open, 6000),
          "open=" + $("trxHelpDialog").open);
    check("and the card says why", !$("trxHelpModeWarning").hidden);
    $("trxHelpDialog").close();

    check("the TRX button names the LAN slot",
          $("trxSlotLabel").textContent.trim() === "TRX 1", $("trxSlotLabel").textContent);
    check("the frequency is grouped in threes like JS8Call",
          $("trxFrequencyValue").textContent === "14.074.000",
          $("trxFrequencyValue").textContent);
    // Same fixture dial, read the other way: 14.074 is not a WSPR preset, so the
    // button that offers the presets has to say so on sight.
    check("a dial off the WSPR presets marks the frequency button",
          $("trxFrequency").classList.contains("off-dial"),
          $("trxFrequency").className);

    check("the six-minute per-band rule is fixed rather than another control",
          !$("periodFrames") && !$("randomizeFrame") &&
          $("periodHint").textContent.includes("6 minutes"),
          $("periodHint").textContent);
    check("activity opens on six hours",
          $("activityDays").value === "6h" && globalThis.__wspr.state.activityRange === "6h",
          $("activityDays").value);

    // Shell parity with JS8Call: the operator should not have to re-learn the
    // page. Same disclosure sections, same topbar schedule, same footer, same
    // setup help affordance.
    check("sections are collapsible disclosures like JS8Call",
          ["spectrum", "tx-session", "activity", "settings"].every(name =>
            document.querySelector('details.compact-section[data-section="' + name + '"]')));
    check("waterfall and the TX buttons share the spectrum section",
          Boolean(document.querySelector('[data-section="spectrum"] #waterfallCanvas')) &&
          Boolean(document.querySelector('[data-section="spectrum"] #startStop')) &&
          Boolean(document.querySelector('[data-section="spectrum"] #tuneButton')));
    check("the schedule moved into the topbar",
          Boolean(document.querySelector(".radio-bar #freqTimetablePanel #scheduleList")));

    // ---- ordered change points -----------------------------------------------
    $("freqTimetableButton").click();
    $("scheduleClose").click();
    check("the schedule panel has a CLOSE and it closes it",
          $("freqTimetablePanel").hidden &&
          $("freqTimetableButton").getAttribute("aria-expanded") === "false");
    $("freqTimetableButton").click();
    check("the timetable starts as an empty change list",
          document.querySelectorAll("#scheduleList [data-change-slot]").length === 0 &&
          $("scheduleList").textContent.includes("No sequence"));

    $("scheduleAdd").click();
    set(document.querySelector("#schedulePopover [data-change-time]"), "17");
    for (const band of ["20m", "15m", "10m"])
      document.querySelector('#schedulePopover [data-add-band="' + band + '"]').click();
    const settings = globalThis.__wspr.settings;
    const sameSchedule = (actual, expected) =>
      JSON.stringify(actual) === JSON.stringify(expected);
    check("08:30 stores the selected on-air order",
          sameSchedule(settings.timetable, [{slot: 17, bands: ["20m", "15m", "10m"]}]),
          JSON.stringify(settings.timetable));

    $("scheduleAdd").click();
    set(document.querySelector("#schedulePopover [data-change-time]"), "40");
    for (const band of ["160m", "80m", "40m"])
      document.querySelector('#schedulePopover [data-add-band="' + band + '"]').click();
    check("a second row changes the schema at 20:00",
          sameSchedule(settings.timetable, [
            {slot: 17, bands: ["20m", "15m", "10m"]},
            {slot: 40, bands: ["160m", "80m", "40m"]},
          ]), JSON.stringify(settings.timetable));
    check("the list shows both daily ranges and their ordered sequences",
          document.querySelectorAll("#scheduleList [data-change-slot]").length === 2 &&
          $("scheduleList").textContent.includes("08:30–20:00") &&
          $("scheduleList").textContent.includes("20:00–08:30"),
          $("scheduleList").textContent);

    const dayStart = Date.UTC(2026, 6, 30, 8, 30, 1);
    check("the core uses the exact sequence order",
          WsprCore.plannedFrames(dayStart, 0.2, globalThis.__wspr.scheduleView())
            .slice(0, 3).map(frame => frame.slot.band).join(",") === "20m,15m,10m");

    document.querySelector('#scheduleList [data-change-slot="17"]').click();
    document.querySelector('#schedulePopover [data-move-band="1"][data-direction="-1"]').click();
    check("bands can be reordered without rebuilding a matrix",
          sameSchedule(settings.timetable[0].bands, ["15m", "20m", "10m"]),
          settings.timetable[0].bands.join(","));
    check("UNDO is offered for an edit", !$("scheduleUndo").hidden);
    $("scheduleUndo").click();
    check("UNDO restores the previous sequence order",
          sameSchedule(settings.timetable[0].bands, ["20m", "15m", "10m"]));

    // The preview is the answer to which two-minute frame keys, from the same
    // prediction function the countdown uses.
    check("the panel previews the next six hours at frame resolution",
          document.querySelectorAll("#previewGrid .tt-preview-row").length === 6 &&
          document.querySelectorAll("#previewGrid .tt-frame").length === 180,
          document.querySelectorAll("#previewGrid .tt-frame").length + " frames");
    check("the preview marks exactly one 'now' edge",
          document.querySelectorAll("#previewGrid .tt-frame.edge").length === 1);
    const plannedInStrip = document.querySelectorAll("#previewGrid .tt-frame.planned").length;
    const futureInStrip = document.querySelectorAll("#previewGrid .tt-frame:not(.past)").length;
    check("a three-band sequence plans essentially every frame",
          plannedInStrip >= futureInStrip - 2 && plannedInStrip <= futureInStrip,
          plannedInStrip + " of " + futureInStrip + " future frames");
    const countdownNext = globalThis.__wspr.nextTransmission();
    check("the preview agrees with the countdown's own next transmission",
          Boolean(countdownNext) && $("previewNext").textContent.includes(
            new Date(countdownNext.slotUtcMs).toISOString().slice(11, 16)),
          $("previewNext").textContent + " vs " + (countdownNext
            ? new Date(countdownNext.slotUtcMs).toISOString().slice(11, 16) : "no next"));
    check("a stopped beacon is not dressed up as what is going to happen",
          $("previewTitle").textContent.startsWith("would transmit") &&
          $("previewTitle").classList.contains("hypothetical"),
          $("previewTitle").textContent);
    // No regex literal here: this script is injected as source and escape
    // sequences inside it do not survive the trip.
    const countText = $("previewCount").textContent;
    check("the preview counts the transmissions",
          countText.endsWith(" TX") && Number.parseInt(countText, 10) === plannedInStrip,
          countText + " vs " + plannedInStrip + " marked");

    // The activity block continues the same axis into the future -- and it has to
    // do that by itself. No renderActivity() call here on purpose: this harness
    // used to make one, which is exactly what hid the bug where a freshly filled
    // schedule showed no planned cells until the operator switched the range.
    check("filling the schedule redraws the predicted tail without a range switch",
          document.querySelectorAll("#activityGrid .activity-cell.planned").length > 0,
          document.querySelectorAll("#activityGrid .activity-cell.planned").length + " planned");
    check("activity extends six hours past now in the slot views",
          document.querySelectorAll("#activityGrid .activity-row").length === 12,
          document.querySelectorAll("#activityGrid .activity-row").length + " rows");
    check("the future is drawn hollow on the activity axis",
          document.querySelectorAll("#activityGrid .activity-cell.planned").length > 0 &&
          document.querySelectorAll("#activityGrid .activity-cell.edge").length === 1,
          document.querySelectorAll("#activityGrid .activity-cell.planned").length + " planned");
    check("the totals name the planned transmissions",
          $("activityTotals").textContent.includes("planned"), $("activityTotals").textContent);
    check("the planned legend is shown where planned cells exist",
          !$("plannedLegend").hidden);
    set($("activityDays"), "7d");
    check("the 7-day view predicts nothing and says nothing about planned",
          document.querySelectorAll("#activityGrid .activity-cell.planned").length === 0 &&
          !$("activityTotals").textContent.includes("planned") && $("plannedLegend").hidden,
          $("activityTotals").textContent);
    set($("activityDays"), "6h");

    // Three bands key continuously while each individual band waits six minutes.
    const inAnHour = Date.now() + 3600000;
    const rotating = WsprCore.plannedFrames(inAnHour, 1, globalThis.__wspr.scheduleView());
    check("three bands at the three-frame gap key every frame of the hour",
          rotating.length >= 29, rotating.length + " of 30");
    check("and never twice running on the same band",
          new Set(rotating.slice(0, 3).map(frame => frame.slot.band)).size === 3,
          rotating.slice(0, 3).map(frame => frame.slot.band).join(","));
    check("and the footer says what that produces",
          $("periodHint").textContent.includes("100 %") &&
          $("periodHint").textContent.includes("exact order"),
          $("periodHint").textContent.slice(0, 120));

    // A cell of the activity grid now holds several bands and the worst status
    // wins its colour, so a band that never works has to be inspectable alone.
    const plannedAll = document.querySelectorAll("#activityGrid .activity-cell.planned").length;
    check("the activity block offers a chip per band plus ALL",
          document.querySelectorAll("#activityBands [data-filter-band]").length === 7,
          document.querySelectorAll("#activityBands [data-filter-band]").length + " chips");
    const activeFilterBand = globalThis.__wspr.nextTransmission().slot.band;
    document.querySelector('#activityBands [data-filter-band="' + activeFilterBand + '"]').click();
    const planned20 = document.querySelectorAll("#activityGrid .activity-cell.planned").length;
    check("filtering narrows the predicted tail to that band alone",
          planned20 > 0 && planned20 < plannedAll, planned20 + " of " + plannedAll);
    document.querySelector('#activityBands [data-filter-band=""]').click();
    // One frame boundary may pass while these run, which moves the six-hour tail
    // by a cell; the filter must restore the view, not the wall clock.
    const plannedBack = document.querySelectorAll("#activityGrid .activity-cell.planned").length;
    check("and ALL brings the rest back", Math.abs(plannedBack - plannedAll) <= 1,
          plannedBack + " vs " + plannedAll);
    // The chips sit outside the timetable panel, and a click outside it closes it.
    if ($("freqTimetablePanel").hidden) $("freqTimetableButton").click();

    // Clear remains recoverable.
    $("scheduleClear").click();
    check("Clear empties the schedule", settings.timetable.length === 0);
    check("and Clear is undoable", !$("scheduleUndo").hidden);
    $("scheduleUndo").click();
    check("undoing Clear brings the changes back", settings.timetable.length === 2);
    $("scheduleClear").click();
    $("freqTimetableButton").click();
    check("closing the panel drops the undo offer",
          $("freqTimetablePanel").hidden && $("scheduleUndo").hidden);
    check("an empty schedule says so in the topbar",
          $("freqTimetableValue").textContent === "NO SCHEDULE",
          $("freqTimetableValue").textContent);
    check("the page carries the shared footer",
          document.querySelector('.js8-page-footer a[href="/THIRD-PARTY-NOTICES.txt"]')
            ?.textContent.trim() === "Licenses");
    check("setup help is reachable", Boolean($("trxHelpButton")) && Boolean($("trxHelpDialog")));
    check("the waterfall is running", Boolean(globalThis.__wspr.waterfall));
    // The radio measures forward power and SWR only while it is keyed -- off key it
    // keeps reporting whatever it read last, so showing that would present the
    // previous transmission as a live measurement. The fixture reports tx:false
    // with swr 1.2 and powerMeterRaw 118, which is precisely the stale case.
    check("no SWR is shown while the radio is not transmitting",
          $("swr").textContent === "--", $("swr").textContent);
    check("and no forward power either", $("powerMeter").textContent === "--",
          $("powerMeter").textContent);
    globalThis.__wspr.state.radio.tx = true;
    globalThis.__wspr.render();
    // The scale travels with the number: "118" alone reads like watts, and this
    // page is used on a phone where a tooltip is not reachable.
    check("both meters read out once the radio is keyed",
          $("swr").textContent === "1.2" && $("powerMeter").textContent === "118/255",
          $("swr").textContent + " / " + $("powerMeter").textContent);
    check("both meters say what their numbers mean",
          ($("powerMeter").closest(".inline-status")?.title || "").includes("not watts") &&
          ($("tuneReference").closest(".inline-status")?.title || "")
            .includes("power unconfirmed"),
          ($("powerMeter").closest(".inline-status")?.title || "").slice(0, 40));
    globalThis.__wspr.state.radio.tx = false;
    globalThis.__wspr.render();
    check("and go blank again the moment it drops out of TX",
          $("swr").textContent === "--" && $("powerMeter").textContent === "--",
          $("swr").textContent + " / " + $("powerMeter").textContent);

    check("the beacon state under the waterfall is labelled",
          $("beaconState").closest(".inline-status")?.textContent.trim().startsWith("Beacon"),
          $("beaconState").closest(".inline-status")?.textContent.trim());
    check("the spot maps open in a new tab",
          [...document.querySelectorAll(".spot-links a")].length === 2 &&
          [...document.querySelectorAll(".spot-links a")].every(link =>
            link.target === "_blank" && link.rel.includes("noopener") &&
            link.href.startsWith("https://")),
          [...document.querySelectorAll(".spot-links a")].map(link => link.href).join(" "));

    // The dial menu is back, with WSPR frequencies rather than JS8's.
    $("trxFrequency").click();
    check("the dial menu opens with the WSPR bands",
          !$("frequencyMenu").hidden &&
          document.querySelectorAll("#frequencyMenu [data-frequency]").length === 12 &&
          Boolean(document.querySelector('#frequencyMenu [data-frequency="14095600"]')),
          document.querySelectorAll("#frequencyMenu [data-frequency]").length + " presets");
    check("a hand-tuned band is offered while the beacon is stopped",
          ![...document.querySelectorAll("#frequencyMenu [data-frequency]")].some(b => b.disabled));
    // Every pop-out in this bar is dismissed the same way. Escape and a second
    // click on the button that opened it both work, but neither is discoverable
    // on a tablet -- and CAL PLAN already had the button the other two lacked.
    document.querySelector("#frequencyMenu [data-menu-close]").click();
    check("the dial menu has a CLOSE and it closes it",
          $("frequencyMenu").hidden &&
          $("trxFrequency").getAttribute("aria-expanded") === "false");
    $("trxFrequency").click();
    document.querySelector('#frequencyMenu [data-frequency="10138700"]').click();
    check("choosing a band tunes the radio and sets USB-D",
          await wait(async () => {
            const sent = await commandsSeen();
            return sent.some(command => command.type === "setFrequency" &&
                             Number(command.frequency) === 10138700) &&
                   sent.some(command => command.type === "civ.raw" &&
                             String(command.data).startsWith("2600"));
          }, 8000),
          JSON.stringify(await commandsSeen()));
    check("and the off-dial mark clears once the radio is on a preset",
          await wait(() => !$("trxFrequency").classList.contains("off-dial"), 4000),
          $("trxFrequency").className);
    check("radio model shown", $("radioModel").textContent.includes("IC-705"),
          $("radioModel").textContent);


    // Nothing keys until the shared pledge is accepted. It gates TUNE as well as
    // the beacon, and it is the same flag the JS8Call page writes -- so this
    // ticks the real control rather than poking localStorage.
    check("the TX pledge blocks the beacon",
          globalThis.__wspr.blockingReason().includes("Enable radio TX"),
          globalThis.__wspr.blockingReason());
    check("TUNE is locked until the pledge is accepted", $("tuneButton").disabled);
    $("txSafety").click();
    check("the pledge lands in the shared Js8Settings blob",
          (JSON.parse(localStorage.getItem("wifilt.data.js8-settings")) || {})
            .modems.js8call.txSafetyAccepted === true);
    check("TUNE unlocked by the pledge", !$("tuneButton").disabled);

    // The identity is the STATION's. This page shows it and cannot edit it: one
    // beacon left running for days must not be transmitting one browser's idea of
    // the callsign, and three editable copies is how the locator got wiped by a
    // typo on a different page.
    check("the callsign is shown, not offered as a field",
          $("callsign").tagName === "OUTPUT" && $("locator").tagName === "OUTPUT",
          $("callsign").tagName + "/" + $("locator").tagName);
    check("the station's identity is what the page shows",
          $("callsign").textContent === "OK1HRA" && $("locator").textContent === "JN79QI",
          $("callsign").textContent + " · " + $("locator").textContent);
    check("transmitted locator truncated to four", $("locatorTransmitted").textContent === "JN79",
          $("locatorTransmitted").textContent);
    check("and it says where it can be changed",
          Boolean(document.querySelector('.identity-note a[href="/setup#identitySection"]')));
    check("locator persisted into the shared Js8Settings blob",
          (JSON.parse(localStorage.getItem("wifilt.data.js8-settings")) || {})
            .modems.js8call.grid === "JN79QI");

    // Changed in SETUP while this page is open. Adopting once at load was true
    // only until somebody did exactly that, and the beacon then went on keying
    // the old callsign with nothing on screen to say so.
    await fetch("/identity", {method: "POST", headers: {"Content-Type": "application/json"},
                              body: JSON.stringify({call: "OK2XYZ", grid: "JO70FB"})});
    await globalThis.__wspr.identityWatch.sync();
    check("an identity changed in SETUP reaches an open beacon page",
          $("callsign").textContent === "OK2XYZ" && $("locator").textContent === "JO70FB",
          $("callsign").textContent + " · " + $("locator").textContent);
    check("and it is what the next transmission would encode",
          (JSON.parse(localStorage.getItem("wifilt.data.js8-settings")) || {})
            .modems.js8call.myCall === "OK2XYZ");
    await fetch("/identity", {method: "POST", headers: {"Content-Type": "application/json"},
                              body: JSON.stringify({call: "OK1HRA", grid: "JN79QI"})});
    await globalThis.__wspr.identityWatch.sync();

    check("full power taken from the reported model", $("fullPowerWatts").textContent === "10 W",
          $("fullPowerWatts").textContent);

    // A beacon's opening bid is one percent of the transmitter, not a fixed dBm.
    // On a 10 W radio that is 0.1 W, which is exactly a legal WSPR level.
    check("the target defaults to 1 % of the transmitter",
          globalThis.__wspr.targetDbm() === 20 && $("powerDbm").value === "20",
          globalThis.__wspr.targetDbm() + " / " + $("powerDbm").value);
    check("a hundred watt radio defaults to 30 dBm, not the same absolute level",
          globalThis.__wspr.defaultPowerDbm(100) === 30,
          String(globalThis.__wspr.defaultPowerDbm(100)));

    // The menu is the radio's, not the protocol's. Everything below one percent
    // of the transmitter is dropped because the radio cannot be set to it: its
    // smallest step is one percent, so 17 dBm on a 10 W radio (50 mW = 0.5 %)
    // would be written as some neighbouring level and the message would announce
    // a power that never left the antenna.
    const levelsNow = () => [...$("powerDbm").options].map(option => Number(option.value));
    check("the menu starts at the radio's one percent step",
          globalThis.__wspr.offeredLevels().join() === "20,23,27,30,33,37,40" &&
          levelsNow().join() === "20,23,27,30,33,37,40",
          levelsNow().join());
    // Two traps in one line. The backslashes are doubled because this whole
    // browser script is a template literal on the Node side -- a single \d
    // arrives as a literal "d" and the test passes or fails for the wrong
    // reason. And the middot is left out of the pattern because the harness
    // serves its page without a charset, so a non-ASCII literal here and the
    // same character in the page are not guaranteed to be the same code point.
    check("and every line says which percent it is",
          [...$("powerDbm").options].every(option => /\\d+\\s*%\\s*$/.test(option.textContent)) &&
          /\\b1\\s*%\\s*$/.test($("powerDbm").options[0].textContent),
          [...$("powerDbm").options].map(option => option.textContent).join(" | "));

    // The fixture parks the radio at 128/255 = 50 % = 5 W. Opening the page is
    // now itself a write: the target has to reach the radio without anyone
    // pressing SET, which is the whole point of the change.
    check("opening the page applies the target to the radio",
          await wait(async () => (await commandsSeen()).some(
            command => command.type === "civ.raw" && command.data === "140A0003"), 8000),
          JSON.stringify(await commandsSeen()));
    check("and the radio is confirmed to have taken it",
          await wait(() => globalThis.__wspr.state.radio.rfPower === 3, 4000),
          String(globalThis.__wspr.state.radio.rfPower));
    check("so nothing is flagged as unapplied",
          await wait(() => !$("powerField").classList.contains("mismatch") &&
                           $("powerMismatch").hidden &&
                           !$("settingsSummary").classList.contains("mismatch"), 4000),
          $("settingsSummary").textContent);
    check("the automation records what it wrote",
          globalThis.__wspr.autoPower.appliedPercent === 1 &&
          !globalThis.__wspr.autoPower.knobTouched,
          JSON.stringify(globalThis.__wspr.autoPower));

    // A hand on the front panel outranks the automation. The page can tell,
    // because it knows the percent it last wrote and confirmed.
    //
    // Turning it up to 128/255 also restores the state the next three checks are
    // about: whatever the automation writes, the radio stays the authority on
    // what the MESSAGE claims. The page reads rfPower back (128 of 255 on a 10 W
    // radio = 5.02 W) and reports the nearest legal WSPR level -- it does not
    // report the level it wrote and hope the radio agreed.
    await fetch("/setRfPower", {method: "POST", body: "128"});
    check("power read back from the radio",
          await wait(() => $("powerWatts").textContent.startsWith("5.0"), 4000),
          $("powerWatts").textContent);
    check("reported as the nearest legal WSPR level",
          $("powerPercent").textContent.includes("37 dBm"), $("powerPercent").textContent);
    check("the reading matches the level exactly", globalThis.__wspr.radioPower().dbm === 37 &&
          Math.abs(globalThis.__wspr.radioPower().errorDb) < 0.05,
          JSON.stringify(globalThis.__wspr.radioPower()));
    check("turning the knob is noticed",
          await wait(() => globalThis.__wspr.autoPower.knobTouched, 4000),
          JSON.stringify(globalThis.__wspr.autoPower));
    check("and shows up as a mismatch again",
          $("powerField").classList.contains("mismatch") && !$("powerMismatch").hidden,
          $("powerMismatch").textContent);
    check("the collapsed header carries the mismatch",
          $("settingsSummary").textContent.includes("target 20 dBm not applied") &&
          $("settingsSummary").classList.contains("mismatch"),
          $("settingsSummary").textContent);
    // But it must never stop a transmission: what goes on the air is the radio's
    // own level, so one turn of the knob may not silence the beacon.
    check("a mismatch does not block the beacon",
          !globalThis.__wspr.blockingReason().includes("target") &&
          !globalThis.__wspr.blockingReason().includes("applied"),
          globalThis.__wspr.blockingReason());

    // A reconnect normally re-applies the target -- but not over a knob the
    // operator has just turned. This is the case that decides whether the page
    // is a tool or an argument.
    const beforeKnobReconnect = (await commandsSeen()).length;
    await fetch("/setConnected", {method: "POST", body: "false"});
    await wait(() => !globalThis.__wspr.state.radio.connected, 4000);
    await fetch("/setConnected", {method: "POST", body: "true"});
    await wait(() => globalThis.__wspr.state.radio.connected, 4000);
    await new Promise(resolve => setTimeout(resolve, 2000));   // room for a write
    check("a reconnect does not overrule the knob",
          !(await commandsSeen()).slice(beforeKnobReconnect).some(
            command => command.type === "civ.raw" && String(command.data).startsWith("140A")) &&
          globalThis.__wspr.state.radio.rfPower === 128,
          globalThis.__wspr.state.radio.rfPower + " / " +
          JSON.stringify((await commandsSeen()).slice(beforeKnobReconnect)));

    // A radio that lost the setting while it was away is the case the automation
    // exists for, and it is distinguishable: the level changed while the page
    // could not see it, so it is not evidence of a hand on the panel. Pressing
    // SET first clears the knob flag, which is what re-arms the automation.
    $("powerSet").click();
    await wait(() => globalThis.__wspr.state.radio.rfPower === 3, 6000);
    check("SET stands the automation back up",
          !globalThis.__wspr.autoPower.knobTouched &&
          globalThis.__wspr.autoPower.appliedPercent === 1,
          JSON.stringify(globalThis.__wspr.autoPower));
    const beforeForgetful = (await commandsSeen()).length;
    await fetch("/setConnected", {method: "POST", body: "false"});
    await wait(() => !globalThis.__wspr.state.radio.connected, 4000);
    await fetch("/setRfPower", {method: "POST", body: "255"});     // radio forgot
    await fetch("/setConnected", {method: "POST", body: "true"});
    // Asserted on the command log rather than on rfPower. The page's last poll
    // before the link returned still holds the OLD reading, so an rfPower === 3
    // test is already true the instant this line runs -- it would pass without
    // the automation ever having done anything. (No backticks in this comment:
    // the whole browser script is a template literal on the Node side.)
    check("a radio that came back forgetful is put right",
          await wait(async () => (await commandsSeen()).slice(beforeForgetful).some(
            command => command.type === "civ.raw" && command.data === "140A0003"), 10000),
          JSON.stringify((await commandsSeen()).slice(beforeForgetful)));
    check("and the readback confirms the level landed",
          await wait(() => globalThis.__wspr.state.radio.rfPower === 3, 4000),
          String(globalThis.__wspr.state.radio.rfPower));

    // TX audio gain drives the same MOD input as JS8Call, so it is the same
    // setting -- and a number field, not a slider.
    check("TX audio gain is a number field", $("txGain").type === "number",
          $("txGain").type);
    set($("txGain"), "0.35");
    check("TX audio gain persists into the shared Js8Settings blob",
          (JSON.parse(localStorage.getItem("wifilt.data.js8-settings")) || {})
            .modems.js8call.txGain === 0.35 && globalThis.__wspr.txGain() === 0.35,
          String(globalThis.__wspr.txGain()));
    // A clean link says nothing: LINKED and AUD1 already cover it, and three
    // bare numbers had no legend on the page at all.
    check("a healthy LAN link shows no counters",
          $("lanHealth").hidden && $("lanHealth").textContent === "",
          String($("lanHealth").hidden) + " " + $("lanHealth").textContent);
    await fetch("/setLanHealth?drops=2&stalls=1&filled=3");
    await sleep(2500);
    check("LAN trouble reaches the bar, and names itself",
          !$("lanHealth").hidden
            && /drop 2/.test($("lanHealth").textContent)
            && /stall 1/.test($("lanHealth").textContent)
            && /fill 3/.test($("lanHealth").textContent),
          $("lanHealth").textContent);
    await fetch("/setLanHealth?drops=0&stalls=0&filled=0");
    check("the audio link has its own indicator",
          $("aud1State").classList.contains("up"), $("aud1State").textContent);

    // Above ten watts the beacon refuses to key. It never turns the radio down
    // by itself: every level the automation can write is already under the cap,
    // so a radio found above it was put there by hand, and reaching for the knob
    // in reply would be the page arguing with its operator.
    const beforeCeiling = (await commandsSeen()).length;
    await fetch("/setModel", {method: "POST", body: "IC-7610"});
    await fetch("/setRfPower", {method: "POST", body: "255"});
    await wait(() => globalThis.__wspr.radioPower().watts > 90, 4000);
    check("above the ceiling the beacon refuses",
          globalThis.__wspr.blockingReason().includes("above the 10 W ceiling"),
          globalThis.__wspr.blockingReason());
    // Scoped to what happened AFTER the ceiling was exceeded: opening the page
    // legitimately writes power now, so an absolute "never wrote" would only be
    // testing that the page had not started yet.
    check("refusing does not write to the radio",
          !(await commandsSeen()).slice(beforeCeiling).some(
            command => command.type === "civ.raw" && String(command.data).startsWith("140A")),
          JSON.stringify((await commandsSeen()).slice(beforeCeiling)));
    // Same menu code, different radio: one percent of 100 W is 1 W, so the four
    // lowest levels an IC-705 offers are gone -- that radio cannot be set to any
    // of them. 20 dBm was the stored choice and is silently not honoured here,
    // rather than being written as something the radio would round elsewhere.
    check("a hundred watt radio gets a shorter menu",
          globalThis.__wspr.offeredLevels().join() === "30,33,37,40" &&
          levelsNow().join() === "30,33,37,40", levelsNow().join());
    check("and the target falls to what this radio can do",
          globalThis.__wspr.targetDbm() === 30 && globalThis.__wspr.settings.powerDbm === 20,
          globalThis.__wspr.targetDbm() + " / " + globalThis.__wspr.settings.powerDbm);
    await fetch("/setModel", {method: "POST", body: "IC-705"});
    await fetch("/setRfPower", {method: "POST", body: "128"});
    await wait(() => Math.abs(globalThis.__wspr.radioPower().watts - 5.02) < 0.1, 4000);

    // SET is still the only thing that turns a proposal into a stored choice.
    // The automation applies a target; it never decides one.
    set($("powerDbm"), "37");
    $("powerSet").click();
    check("SET writes the level into the radio",
          await wait(async () => (await commandsSeen()).some(
            command => command.type === "civ.raw" && command.data === "140A0128"), 6000),
          JSON.stringify(await commandsSeen()));
    // Once the radio agrees with the target the amber has to go, and pressing
    // SET is what turns the 1 % proposal into the operator's own choice.
    globalThis.__wspr.render();
    check("writing the target clears the mismatch",
          !$("powerField").classList.contains("mismatch") && $("powerMismatch").hidden &&
          !$("settingsSummary").classList.contains("mismatch"),
          $("settingsSummary").textContent);
    check("SET records the level as chosen, so 1 % no longer applies",
          globalThis.__wspr.settings.powerDbm === 37 && globalThis.__wspr.targetDbm() === 37,
          String(globalThis.__wspr.settings.powerDbm));

    // An unknown model must block the beacon, not fall back to a guess.
    await fetch("/setModel", {method: "POST", body: "FT-991"});
    await wait(() => globalThis.__wspr.fullPower().watts === null);
    check("unknown model yields no power curve", globalThis.__wspr.fullPower().watts === null);
    check("unknown model blocks starting",
          globalThis.__wspr.blockingReason().includes("model is unknown"),
          globalThis.__wspr.blockingReason());
    // With no scale there is no honest list of levels either -- offering the raw
    // WSPR grid would invite a choice the page cannot convert into a percent.
    check("unknown model empties and locks the power menu",
          await wait(() => $("powerDbm").disabled && $("powerDbm").options.length === 0, 4000),
          $("powerDbm").options.length + " options, disabled=" + $("powerDbm").disabled);
    await fetch("/setModel", {method: "POST", body: "IC-705"});
    await wait(() => globalThis.__wspr.fullPower().watts === 10);
    check("a known model brings the menu back",
          await wait(() => !$("powerDbm").disabled && levelsNow().join() === "20,23,27,30,33,37,40", 4000),
          levelsNow().join());

    // Schedule: empty means the beacon cannot start.
    check("empty schedule blocks starting",
          globalThis.__wspr.blockingReason().includes("schedule is empty"),
          globalThis.__wspr.blockingReason());

    // Fill the current schema with three bands. Rotate the array so the next
    // frame is 20 m; this keeps the browser smoke short while still exercising
    // the fixed six-minute per-band rule.
    const now = new Date();
    const slotIndex = now.getUTCHours() * 2 + (now.getUTCMinutes() >= 30 ? 1 : 0);
    // Where "20m" has to sit in the sequence depends on which frame is next RIGHT
    // NOW, so it is recomputed rather than computed once. The checks between here
    // and START take real seconds, and crossing a two-minute frame boundary would
    // hand the first slot to a different band -- a failure that looks like a
    // scheduler bug and is nothing but the test having taken too long.
    const armQuickSchedule = () => {
      const at = new Date();
      const slot = at.getUTCHours() * 2 + (at.getUTCMinutes() >= 30 ? 1 : 0);
      const nextFrame = Math.ceil((at.getUTCHours() * 3600 +
        at.getUTCMinutes() * 60 + at.getUTCSeconds() - 1) / 120);
      const bands = ["15m", "10m", "80m"];
      bands[((nextFrame - slot * 15) % 3 + 3) % 3] = "20m";
      globalThis.__wspr.settings.timetable = [{slot, bands}];
      globalThis.__wspr.render();
    };
    armQuickSchedule();
    check("schedule no longer blocks", globalThis.__wspr.blockingReason() === "",
          globalThis.__wspr.blockingReason());
    globalThis.__wspr.renderSchedule();
    check("the topbar now shows the band and the countdown",
          /^20m · (\\d+ s|\\d+:\\d\\d)$/.test($("freqTimetableValue").textContent),
          $("freqTimetableValue").textContent);

    // A sparse schedule can put the next transmission-most of a day away, which
    // the old mm:ss formatter rendered as "720:00". Nothing may show more than
    // 59 minutes without an hour field.
    globalThis.__wspr.settings.timetable = [
      {slot: slotIndex, bands: []},
      {slot: (slotIndex + 20) % 48, bands: ["40m"]},
      {slot: (slotIndex + 21) % 48, bands: []},
    ];
    globalThis.__wspr.render();
    check("a distant slot is not rendered as 720:00",
          /^40m · \\d+:\\d\\d:\\d\\d$/.test($("freqTimetableValue").textContent),
          $("freqTimetableValue").textContent);
    // The countdown belongs to the timer beside START now; TX SESSION states the
    // slot time instead, so the two clocks cannot drift apart on screen.
    check("TX SESSION states the slot time, not a countdown",
          /^next slot \\d\\d:\\d\\d:\\d\\d UTC$/.test($("nextSession").textContent) &&
          !$("nextSession").textContent.includes(" in "),
          $("nextSession").textContent);
    armQuickSchedule();
    // A disabled button swallows click(), so waiting for the guard to clear is
    // part of the test rather than an accident of timing.
    check("START enabled once nothing blocks", await wait(() => !$("startStop").disabled, 4000),
          "disabled=" + $("startStop").disabled);

    // Turning the VFO off the WSPR presets behind the page's back is the case
    // the dial warning is for: START has to refuse, because the first slot would
    // otherwise fail ten seconds before it keyed, while TUNE keeps working --
    // setting the drive level on whatever the radio is on is a legitimate thing
    // to be doing at that moment.
    await fetch("/setDialFrequency", {method: "POST", body: "14200000"});
    check("an off-dial VFO disables START",
          await wait(() => $("startStop").disabled, 4000),
          "disabled=" + $("startStop").disabled);
    check("and says why, on the button that fixes it",
          $("trxFrequency").classList.contains("off-dial") &&
          $("beaconError").textContent.includes("WSPR dial frequency"),
          $("trxFrequency").className + " · " + $("beaconError").textContent);
    check("TUNE stays available off dial", !$("tuneButton").disabled);
    $("trxFrequency").click();
    check("the dial menu explains the refusal",
          $("frequencyMenu").textContent.includes("START stays disabled"),
          $("frequencyMenu").textContent.slice(-140));
    $("trxFrequency").click();
    await fetch("/setDialFrequency", {method: "POST", body: "10138700"});
    check("back on a preset START comes back",
          await wait(() => !$("startStop").disabled &&
                           !$("trxFrequency").classList.contains("off-dial"), 4000),
          "disabled=" + $("startStop").disabled);

    const next = globalThis.__wspr.nextTransmission();
    check("next transmission is planned", Boolean(next));
    check("next slot is one second past an even minute",
          next && new Date(next.slotUtcMs).getUTCSeconds() === 1 &&
          new Date(next.slotUtcMs).getUTCMinutes() % 2 === 0,
          next ? new Date(next.slotUtcMs).toISOString() : "");

    // Start, and let the beacon reach the point where it tunes the radio. The
    // sequence is re-armed here because the dial checks above may have crossed a
    // frame boundary since it was last computed.
    armQuickSchedule();
    $("startStop").click();
    check("beacon armed", globalThis.__wspr.state.beacon !== "stopped",
          globalThis.__wspr.state.beacon);
    check("START became STOP", $("startStop").textContent === "STOP");
    check("a green countdown appears beside START",
          !$("slotTimer").hidden && $("slotTimer").classList.contains("waiting") &&
          /^\\d\\d:\\d\\d$/.test($("slotTimer").textContent),
          $("slotTimer").className + " " + $("slotTimer").textContent);

    // While the beacon runs the schedule owns the band, so the menu still opens
    // but nothing in it can be pressed -- a hand-tuned band would be undone a
    // few seconds before the next slot anyway.
    $("trxFrequency").click();
    check("the dial menu still opens while the beacon runs", !$("frequencyMenu").hidden);
    check("but its presets are locked",
          [...document.querySelectorAll("#frequencyMenu [data-frequency]")].every(b => b.disabled) &&
          $("frequencyMenu").textContent.includes("Stop the beacon"),
          $("frequencyMenu").textContent.slice(0, 80));
    $("trxFrequency").click();

    // Slots are 120 s apart, so the next natural preparation window can be up to
    // two minutes away.
    const tuned = await wait(() => globalThis.__wspr.state.beacon === "transmitting" ||
                                   globalThis.__wspr.state.beacon === "stopped" ||
                                   globalThis.__wspr.state.lastError, 150000);
    check("beacon tuned and queued a transmission", tuned &&
          globalThis.__wspr.state.beacon === "transmitting",
          globalThis.__wspr.state.lastError || globalThis.__wspr.state.beacon);

    // Let the prebuffer burst and the first credit rounds actually go out.
    const streamed = await wait(() => globalThis.__wspr.tx &&
      ["prebuffering", "streaming"].includes(globalThis.__wspr.tx.state), 40000);
    check("reached the prebuffer/stream phase", streamed,
          globalThis.__wspr.tx ? globalThis.__wspr.tx.state : "no tx");
    await sleep(3000);
    check("PTT reported by the firmware",
          Boolean(globalThis.__wspr.tx && globalThis.__wspr.tx.ptt),
          globalThis.__wspr.tx ? globalThis.__wspr.tx.state : "");
    check("the countdown turns red while radiating",
          !$("slotTimer").hidden && $("slotTimer").classList.contains("transmitting"),
          $("slotTimer").className + " " + $("slotTimer").textContent);
    // The browser runs a second or more ahead of the radio, so a bar fed from
    // sent samples was already part full the moment it appeared. This one counts
    // what the firmware has clocked out.
    check("the progress bar measures radiated audio",
          $("sessionProgress").value <= Math.round(globalThis.__wspr.tx.consumedUlaw / 8) + 1 &&
          $("sessionProgress").value < globalThis.__wspr.tx.sentSamples / 48,
          $("sessionProgress").value + " of sent " +
          Math.round(globalThis.__wspr.tx.sentSamples / 48));
    check("ring estimate stays under capacity",
          Boolean(globalThis.__wspr.tx) && globalThis.__wspr.tx.peakRingEstimate <= 12288,
          globalThis.__wspr.tx ? String(globalThis.__wspr.tx.peakRingEstimate) : "");

    $("startStop").click();
    check("stop returns to stopped", globalThis.__wspr.state.beacon === "stopped",
          globalThis.__wspr.state.beacon);
    check("stopping the beacon leaves the audio socket open",
          Boolean(globalThis.__wspr.tx), "tx gone with the socket");

    // TUNE is a toggle with a cap. The first press keys, the second releases --
    // and it must not leave the beacon armed behind it, which is what the old
    // "tune finished" abort did by falling through the failure policy.
    $("tuneButton").click();
    check("TUNE keys and turns into STOP",
          await wait(() => globalThis.__wspr.state.beacon === "tuning" &&
                           $("tuneButton").textContent === "STOP", 8000),
          globalThis.__wspr.state.beacon + " / " + $("tuneButton").textContent);
    check("START is locked out while tuning", $("startStop").disabled);
    // The clock beside the button has to count down the watchdog that ends the
    // tune, not the 110 s frame the carrier is queued as. 12.5 s of lead plus
    // cap means it can never show 00:13 or more, and the old code showed 01:5x.
    const tuneClock = $("slotTimer").textContent;
    const tuneSeconds = Number(tuneClock.split(":")[1]);
    check("the timer counts down the tune watchdog, not the frame",
          !$("slotTimer").hidden && tuneClock.startsWith("00:") &&
          tuneSeconds > 0 && tuneSeconds <= 13 &&
          $("slotTimer").title.includes("TUNE"), tuneClock);
    check("and it is anchored to the watchdog the page actually armed",
          Math.abs(globalThis.__wspr.state.tuneEndsAtMs - Date.now() - tuneSeconds * 1000) < 1500,
          String(globalThis.__wspr.state.tuneEndsAtMs - Date.now()));
    $("tuneButton").click();
    check("the second press stops the tune and does not arm the beacon",
          globalThis.__wspr.state.beacon === "stopped" &&
          $("tuneButton").textContent === "TUNE",
          globalThis.__wspr.state.beacon + " / " + $("tuneButton").textContent);
    check("stopping the tune disarms the watchdog clock too",
          globalThis.__wspr.state.tuneEndsAtMs === 0 && $("slotTimer").hidden,
          String(globalThis.__wspr.state.tuneEndsAtMs));


    // ---- activity grid and failure policy ---------------------------------
    //
    // Driven through the page's real recording and event paths rather than by
    // poking the DOM, so what is checked is the behaviour the beacon will show
    // after a night of running, not a rendering of hand-made fixtures.
    await WsprLog.clear();
    const hour = new Date().getUTCHours();
    const slotAt = minute => {
      const now = new Date();
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
                      hour, minute, 1);
    };
    const logOne = async (minute, outcome) => {
      globalThis.__wspr.state.currentSession = {
        slotUtcMs: slotAt(minute), band: "20m", dialHz: 14095600, offsetHz: 1500,
        callsign: "OK1HRA", locator: "JN79", dbm: 37,
        powerSamples: outcome.powerSamples || [],
      };
      await globalThis.__wspr.recordSession(outcome);
    };

    // Filed per band and per level, so a tune on 20 m says nothing about 40 m.
    globalThis.__wspr.storeReference("20m", 37, 118);
    await logOne(2, {completed: true, powerSamples: [118]});               // sent
    await logOne(4, {completed: true, powerSamples: [40]});                // suspect
    await logOne(6, {completed: false, afterKeying: false, reason: "TX prebuffer missed slot"});
    await logOne(8, {completed: false, afterKeying: true, reason: "TX buffer underrun"});

    const records = await WsprLog.all();
    check("every attempt is stored, including the ones that never keyed",
          records.length === 4, String(records.length));
    const byStatus = {};
    for (const record of records) byStatus[record.status] = (byStatus[record.status] || 0) + 1;
    check("power at the reference is logged as sent", byStatus.sent === 1, JSON.stringify(byStatus));
    check("power far off the reference is logged as suspect", byStatus.suspect === 1, "");
    check("a pre-key failure is logged as missed", byStatus.missed === 1, "");
    check("a post-key failure is logged as broken", byStatus.broken === 1, "");

    // The whole point of filing per band: a tune on 20 m must not condemn 40 m,
    // where the meter legitimately reads something else. No reference means no
    // check, not an accusation. Same for a level the reference was not taken at.
    const logOther = async (minute, band, dbm, samples) => {
      globalThis.__wspr.state.currentSession = {
        slotUtcMs: slotAt(minute), band, dialHz: 7038600, offsetHz: 1500,
        callsign: "OK1HRA", locator: "JN79", dbm, powerSamples: samples,
      };
      await globalThis.__wspr.recordSession({completed: true});
      return (await WsprLog.all()).find(record => record.slotUtcMs === slotAt(minute));
    };
    check("an untuned band is not accused, it is simply unchecked",
          (await logOther(10, "40m", 37, [40])).status === "sent",
          (await WsprLog.all()).length + " records");
    check("a level the reference was not taken at is unchecked too",
          (await logOther(12, "20m", 30, [40])).status === "sent", "");
    globalThis.__wspr.storeReference("40m", 37, 40);
    check("once that band is tuned, the check applies there as well",
          (await logOther(14, "40m", 37, [200])).status === "suspect", "");
    // Rendered first on purpose: Clear is disabled while nothing is on file, and
    // a click on a disabled button is silently dropped. Asserting the count and
    // the enabled state before pressing is what tells the two failures apart.
    globalThis.__wspr.render();
    check("measured bands are counted and Clear becomes available",
          $("referenceCount").textContent === "2 bands measured" &&
          !$("referenceClear").disabled, $("referenceCount").textContent);
    $("referenceClear").click();
    check("Clear forgets every band at once",
          globalThis.__wspr.referenceFor("20m", 37) === 0 &&
          globalThis.__wspr.referenceFor("40m", 37) === 0 &&
          $("referenceCount").textContent === "no bands measured" &&
          $("referenceClear").disabled,
          $("referenceCount").textContent);
    check("the firmware reason is kept verbatim",
          records.some(record => record.reason === "TX buffer underrun"), "");

    // The long range aggregates to the hour: row = UTC hour, column = day.
    globalThis.__wspr.state.activityRange = "7d";
    globalThis.__wspr.renderActivity();
    const cells = [...document.querySelectorAll(".activity-cell")];
    const todayCell = [...document.querySelectorAll(".activity-row")][hour]
      .querySelector(".activity-cell:last-child");
    check("the day grid has 24 rows of cells",
          document.querySelectorAll(".activity-row").length === 24,
          String(document.querySelectorAll(".activity-row").length));
    check("seven days, not twenty-eight", cells.length === 24 * 7, String(cells.length));
    // The whole point of the aggregated grid: one broken transmission must not
    // hide behind three good ones in the same hour.
    check("the worst status colours the hour", todayCell.classList.contains("broken"),
          todayCell.className);
    check("totals are reported",
          $("activityTotals").textContent.includes("1 broken"), $("activityTotals").textContent);

    todayCell.click();
    check("clicking a cell lists the individual transmissions", !$("activityDetail").hidden);
    check("the detail shows the firmware reason",
          $("activityDetail").textContent.includes("TX buffer underrun"), "");
    // Four from the status block above plus the three per-band reference cases.
    check("the detail lists every attempt in the cell",
          $("activityDetail").querySelectorAll("tbody tr").length === 7,
          String($("activityDetail").querySelectorAll("tbody tr").length));

    // The short ranges are why the second resolution exists: four transmissions
    // in one hour have to appear as four separate cells, or the operator cannot
    // see WHICH slots were lost -- which is the question a beacon raises.
    globalThis.__wspr.state.selectedCell = null;
    $("activityDetail").hidden = true;
    set($("activityDays"), "24h");
    // 24 hours of history plus the six-hour planned tail, which is why the row
    // count is not the range on the selector.
    check("the slot grid still has one row per hour",
          document.querySelectorAll(".activity-row").length === 24 + 6,
          String(document.querySelectorAll(".activity-row").length));
    check("thirty two-minute slots in a row",
          document.querySelectorAll(".activity-cell").length === (24 + 6) * 30,
          String(document.querySelectorAll(".activity-cell").length));
    const slotCells = [...[...document.querySelectorAll(".activity-row")][23]
      .querySelectorAll(".activity-cell")];
    check("each transmission gets its own slot cell",
          slotCells[1].classList.contains("sent") &&
          slotCells[2].classList.contains("suspect") &&
          slotCells[3].classList.contains("missed") &&
          slotCells[4].classList.contains("broken"),
          slotCells.slice(1, 5).map(cell => cell.className).join(" | "));

    // Failure policy: pre-key failures never stop the beacon; three post-key
    // failures in a row do.
    globalThis.__wspr.state.beacon = "armed";
    globalThis.__wspr.state.consecutiveBroken = 0;
    for (let index = 0; index < 5; index++)
      globalThis.__wspr.onTxEvent({type: "failed", afterKeying: false, reason: "missed"});
    check("missed slots never pause the beacon",
          globalThis.__wspr.state.beacon === "armed", globalThis.__wspr.state.beacon);

    globalThis.__wspr.state.consecutiveBroken = 0;
    for (let index = 0; index < 2; index++)
      globalThis.__wspr.onTxEvent({type: "failed", afterKeying: true, reason: "TX watchdog"});
    check("two broken transmissions do not pause yet",
          globalThis.__wspr.state.beacon === "armed", globalThis.__wspr.state.beacon);
    globalThis.__wspr.onTxEvent({type: "failed", afterKeying: true, reason: "TX watchdog"});
    check("three broken transmissions in a row pause the beacon",
          globalThis.__wspr.state.beacon === "paused", globalThis.__wspr.state.beacon);

    // The banner has to describe the beacon now, not the worst thing it ever
    // saw. It used to keep whichever reason arrived first and was never cleared
    // on success, so the first underrun stayed up for the rest of the night.
    // Counter back to zero on purpose: at three the pause branch overwrites the
    // message unconditionally, so a check run there would pass with the old
    // code too and prove nothing about which reason wins.
    globalThis.__wspr.state.beacon = "armed";
    globalThis.__wspr.state.consecutiveBroken = 0;
    globalThis.__wspr.onTxEvent({type: "failed", afterKeying: true, reason: "TX watchdog"});
    check("a failure is reported to the operator",
          !$("beaconError").hidden && $("beaconError").textContent.includes("TX watchdog"),
          $("beaconError").textContent);
    globalThis.__wspr.onTxEvent({type: "failed", afterKeying: false, reason: "TX buffer underrun"});
    check("and the newest reason replaces the older one",
          $("beaconError").textContent.includes("TX buffer underrun"),
          $("beaconError").textContent);

    globalThis.__wspr.state.beacon = "armed";
    globalThis.__wspr.state.consecutiveBroken = 2;
    // Recorded through the real event path, so this also proves the log and the
    // grid are written by a transmission rather than by the harness.
    const cellsBefore = document.querySelectorAll("#activityGrid .activity-cell.sent").length;
    globalThis.__wspr.state.currentSession = {
      slotUtcMs: slotAt(16), band: "20m", dialHz: 14095600, offsetHz: 1500,
      callsign: "OK1HRA", locator: "JN79", dbm: 37, powerSamples: [118],
    };
    globalThis.__wspr.onTxEvent({type: "completed"});
    check("a good transmission resets the counter",
          globalThis.__wspr.state.consecutiveBroken === 0,
          String(globalThis.__wspr.state.consecutiveBroken));
    // Gone, not merely different: an armed beacon with nothing wrong shows no
    // banner at all, and asserting only the absence of one word would pass on
    // any other stale message that happened to be left behind.
    check("a good transmission clears the previous failure from the banner",
          $("beaconError").hidden && $("beaconError").textContent === "",
          JSON.stringify($("beaconError").textContent));
    check("and ACTIVITY gains the transmission without any manual redraw",
          await wait(() =>
            document.querySelectorAll("#activityGrid .activity-cell.sent").length > cellsBefore,
            4000),
          document.querySelectorAll("#activityGrid .activity-cell.sent").length +
            " sent cells, was " + cellsBefore);
    globalThis.__wspr.state.beacon = "stopped";

    // ---- the gate, in a frame so the live page keeps its session -------------
    //
    // Two cases the beacon used to get wrong. Without ICOM-LAN anywhere it must
    // show the same card JS8LAN shows and start nothing at all -- in particular
    // it must not claim the single-operator lease, which would lock a working
    // JS8LAN out of a radio this page cannot drive anyway. And with LAN on TRX2
    // it must boot and follow that slot; the old code asked the primary radio,
    // so it would have refused to key a perfectly good configuration.
    const load = async query => {
      const frame = document.createElement("iframe");
      frame.style.display = "none";
      frame.src = "/wspr.html?test=1&" + query;
      document.body.appendChild(frame);
      await new Promise(resolve => frame.addEventListener("load", resolve, {once: true}));
      return frame;
    };

    const claimCount = async () => (await (await fetch("/claims")).json()).claims;
    const claimsBefore = await claimCount();
    const blocked = await load("lanFixture=missing");
    const bd = blocked.contentDocument;
    await wait(() => bd.getElementById("lanGate"), 8000);
    check("no ICOM-LAN closes the WSPR page",
          Boolean(bd.getElementById("lanGate")) &&
          bd.body.classList.contains("lan-gate-blocked") &&
          !blocked.contentWindow.__wspr);
    // Present in the DOM is not the same as on the screen. A CSS specificity
    // slip once left <main> at display:none, so this card -- the only thing
    // telling the operator why the page had stopped -- was itself invisible and
    // every other assertion here still passed.
    // The ancestor chain, not the card alone: the slip that made this necessary
    // left <main> at display:none while the card still computed to block.
    const shownThrough = (node) => {
      for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
        const st = blocked.contentWindow.getComputedStyle(n);
        if (st.display === "none" || st.visibility === "hidden") return false;
        if (n.tagName === "BODY") break;
      }
      return true;
    };
    check("the card explaining the closure is actually visible",
          shownThrough(bd.getElementById("lanGate")));
    check("the closed WSPR page shows the JS8LAN wording",
          bd.querySelector("#lanGate h1")?.textContent.trim() === "DATA requires a TRX over ICOM-LAN" &&
          bd.getElementById("lanGateDetail")?.textContent.trim() === "no TRX connection is set to ICOM-LAN");
    check("the closed page still offers the way back to JS8LAN",
          getComputedStyle(bd.querySelector(".subtabs")).display !== "none" &&
          Boolean(bd.querySelector('.subtabs a[href="/data"]')));
    check("the beacon interface is blanked, not merely hidden",
          getComputedStyle(bd.getElementById("beaconInterface")).display === "none" &&
          getComputedStyle(bd.querySelector(".radio-bar")).display === "none");
    check("a page with no LAN never claims the radio",
          (await claimCount()) === claimsBefore);

    const audioPort = new URLSearchParams(location.search).get("audioPort") || "";
    const onTrx2 = await load("lanFixture=trx2&audioPort=" + audioPort);
    await wait(() => onTrx2.contentWindow.__wspr, 10000);
    check("LAN on TRX2 boots the beacon", Boolean(onTrx2.contentWindow.__wspr));
    await wait(() => onTrx2.contentWindow.__wspr &&
                     onTrx2.contentWindow.__wspr.state.radio.connected, 10000);
    check("LAN on TRX2 is not mistaken for a missing transport",
          onTrx2.contentWindow.__wspr.blockingReason() !==
            "the primary radio is not on the ICOM-LAN transport",
          onTrx2.contentWindow.__wspr.blockingReason());
    blocked.remove();
    onTrx2.remove();

    // ---- automatic TX gain -------------------------------------------------
    //
    // The whole search, against a fixture that decides ALC from the audio it
    // actually receives and answers from the level the radio is playing at
    // consumed rather than the newest packet. Everything expensive about this
    // feature -- a 20 s carrier, a real transceiver, an antenna -- is exactly
    // what makes an on-air-only test useless as a regression guard.
    // Visible in SETTINGS without a hash. It used to be hidden until #autogain, which
    // meant an operator who opened /wspr saw no calibration at all -- and the hash was
    // never a safety gate: showing a panel transmits nothing, the carrier waits for a
    // click either way.
    const plan0 = globalThis.__wspr.gainPlan;
    check("the calibration panel is present without any hash", !$("calField").hidden);
    // The plan is a WINDOW, in the same shape as the TIMETABLE beside it: closed
    // until its topbar button is pressed, and the button carries its state.
    check("the plan is a topbar window, closed until asked for",
          Boolean($("planButton")) && $("planField").hidden === true &&
          $("planField").classList.contains("freq-timetable-panel"),
          $("planField").className);
    check("and the button says what is in it, or that nothing is calibrated",
          ["CELLS", "EMPTY", "NOT CALIBRATED", "NOT FOR THIS BAND"]
            .some(word => $("planButtonValue").textContent.includes(word)),
          $("planButtonValue").textContent);
    const beforeOpen = $("planField").hidden;
    let openError = "";
    try { plan0.open(); } catch (error) { openError = String(error && error.message || error); }
    check("open() unhides the window", $("planField").hidden === false,
          "before=" + beforeOpen + " after=" + $("planField").hidden +
          " error=" + openError + " hasDom=" + Boolean(plan0.dom));
    plan0.close();
    $("planButton").click();
    check("pressing it opens the window", !$("planField").hidden,
          "expanded=" + $("planButton").getAttribute("aria-expanded"));
    check("the window has a header and a way out",
          Boolean($("planField").querySelector("header strong")) &&
          Boolean($("planField").querySelector('[data-plan="close"]')));
    document.body.click();
    check("an outside click closes it, as the timetable does", $("planField").hidden);
    $("planButton").click();
    location.hash = "#autogain";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    check("#autogain opens the settings section it is in",
          $("calField").closest("details").open === true);
    check("but arriving at the URL does not key anything",
          globalThis.__wspr.state.beacon === "stopped" && !globalThis.__wspr.gainCal.cal,
          globalThis.__wspr.state.beacon);
    // Whichever band the earlier scenarios left the dial on: the point is that
    // the panel says what it is about to measure, not that it is 20 m.
    const calBand = globalThis.__wspr.gainCal.identity().band;
    check("the panel names the band and power it is about to measure",
          $("calTarget").textContent.includes(calBand) &&
          $("calTarget").textContent.includes("%"),
          $("calTarget").textContent);

    const percentBefore = globalThis.__wspr.state.radio.rfPower;
    const frequencyBefore = globalThis.__wspr.state.radio.frequency;
    $("calStart").click();
    // The beacon state is deliberately NOT part of this: the calibration runs on
    // its own driver and must leave the beacon's state machine alone.
    check("the calibration keys a carrier",
          await wait(() => globalThis.__wspr.gainCal.running &&
                           $("calStart").textContent === "STOP", 8000),
          "running=" + globalThis.__wspr.gainCal.running +
          " beacon=" + globalThis.__wspr.state.beacon);
    check("it asked the firmware for fast ALC metering",
          await wait(() => ["prebuffering", "streaming"]
                             .includes(globalThis.__wspr.gainCal.tx.state), 8000) &&
          (await (await fetch("/prepares")).json()).alcFast === true,
          globalThis.__wspr.gainCal.tx.state + " " +
          JSON.stringify((await (await fetch("/prepares")).json())));
    // The thinner ring is the reason a step costs about a second instead of two,
    // and it belongs to the calibration's OWN driver: the beacon's stays at its
    // full depth, because a calibration must not change how the next slot is paced.
    check("the calibration runs a halved ring of its own",
          globalThis.__wspr.gainCal.tx.targetFillBytes === 4000 &&
          globalThis.__wspr.tx.targetFillBytes === 8000,
          globalThis.__wspr.gainCal.tx.targetFillBytes + " / " +
          globalThis.__wspr.tx.targetFillBytes);

    const finished = await wait(() => Boolean(globalThis.__wspr.gainCal.run.result) ||
                                      Boolean(globalThis.__wspr.gainCal.run.message), 40000);
    const result = globalThis.__wspr.gainCal.run.result;
    check("the search finished inside one carrier", finished && Boolean(result),
          globalThis.__wspr.gainCal.run.message || "no result");
    // The bracket-and-bisect stops when the clean and dirty levels are 0.375 dB
    // apart, so anything worse than half a dB means the search is being fooled -- by
    // the decaying meter, by a stale reading, or by measuring the wrong end of the
    // ring.
    // Asked of the fixture rather than typed in: the simulated knee is a function of
    // band, power and MOD level now, so a literal here would be a second, drifting
    // definition of the radio.
    const trueKnee = (await (await fetch("/knee")).json()).knee;
    const errorDb = result ? Math.abs(20 * Math.log10(result.knee / trueKnee)) : 99;
    check("it converged on the radio's real knee", errorDb <= 0.5,
          result ? "knee " + result.knee + " (" + errorDb.toFixed(2) + " dB off)" : "none");
    check("the stored level is the measured one, with no margin",
          Boolean(result) && Math.abs(result.gain - result.knee) < 1e-6,
          result ? result.gain + " vs " + result.knee : "none");
    // A ceiling result must never reach the table: 0.8 stored as a measured level is a
    // failed search dressed as a green number, and a radio whose MOD level has been
    // driven to silence produces a whole table of them.
    const tableNow = await (await fetch("/txgain.json", {cache: "no-store"})).json();
    check("a ceiling result is never stored as a calibration",
          !result || result.reachedCeiling === false ||
          !tableNow.entries[globalThis.__wspr.gainCal.identity().key],
          "reachedCeiling=" + (result ? result.reachedCeiling : "no result"));
    check("it did not simply run to the ceiling",
          Boolean(result) && result.reachedCeiling === false && result.gain < 0.8,
          result ? String(result.gain) : "none");

    const stored = await (await fetch("/txgain.json", {cache: "no-store"})).json();
    const storedKey = globalThis.__wspr.gainCal.identity().key;
    check("the result went into the station's table, not into this browser",
          Boolean(stored.entries[storedKey]) &&
          Math.abs(stored.entries[storedKey].gain - result.gain) < 5e-4,
          JSON.stringify(stored.entries));
    // The band and the power are in the KEY -- model|band|percent -- and since
    // 2026-08-08 the record no longer repeats them: three strings stored twice
    // per cell is what stopped a full band-by-power matrix fitting the file.
    // So the check is that the key carries them and the record does not.
    check("the key carries the band and power it was measured at",
          storedKey.split("|")[1] === calBand &&
          Number(storedKey.split("|")[2]) === globalThis.__wspr.gainCal.identity().percent,
          storedKey);
    check("the record does not repeat what the key already says",
          !("band" in stored.entries[storedKey]) && !("percent" in stored.entries[storedKey])
          && !("model" in stored.entries[storedKey]),
          JSON.stringify(stored.entries[storedKey]));
    check("and the forward-power reference for that band came with it",
          globalThis.__wspr.referenceFor(calBand, globalThis.__wspr.radioPower().dbm) > 0,
          String(globalThis.__wspr.referenceFor(calBand, globalThis.__wspr.radioPower().dbm)));

    // The promise the whole design rests on: a calibration measures the radio as
    // the operator set it up. If this page had written its own power target or
    // retuned the dial, the entry would be filed under a state the radio was
    // never in -- and the JS8 case, which is the reason calibration happens here
    // at all, would be impossible.
    check("the calibration left the radio's power alone",
          globalThis.__wspr.state.radio.rfPower === percentBefore,
          percentBefore + " -> " + globalThis.__wspr.state.radio.rfPower);
    check("and left the dial alone",
          globalThis.__wspr.state.radio.frequency === frequencyBefore,
          frequencyBefore + " -> " + globalThis.__wspr.state.radio.frequency);
    check("the carrier is down and the beacon was never touched",
          globalThis.__wspr.state.beacon === "stopped" &&
          globalThis.__wspr.gainCal.running === false &&
          $("calStart").textContent === "START CALIBRATION",
          globalThis.__wspr.state.beacon + " / running=" + globalThis.__wspr.gainCal.running);
    check("the measured MOD-level advice is shown, not a recommended number",
          $("calResult").textContent.includes("knee") &&
          /MOD level is [0-9.]+ dB too (high|low)|MOD level is about right/
            .test($("calResult").textContent),
          $("calResult").textContent);
    check("the resolved level is reported beside the manual field",
          $("calResolved").textContent.includes("calibrated") &&
          !$("calResolved").classList.contains("uncalibrated"),
          $("calResolved").textContent);
    // It is a sentence, not a value. Inside the settings grid a <small> that
    // wraps lands in the 130 px label column and reads as a squeezed fragment
    // against the left edge, which is how the operator found it. Measured, not
    // asserted from the stylesheet: only a real layout can say it spans the row.
    const resolvedWidth = $("calResolved").getBoundingClientRect().width;
    const labelWidth = $("calResolved").closest("label").getBoundingClientRect().width;
    check("and it spans the settings row instead of the label column",
          resolvedWidth > labelWidth * 0.8,
          Math.round(resolvedWidth) + " of " + Math.round(labelWidth) + " px");
    // The manual field must still read what it always read: the calibrated value
    // cannot be expressed in its 0.05 steps, so writing it there would round the
    // measurement away on the operator's first click.
    check("the manual gain field was not overwritten with the measurement",
          Math.abs(Number($("txGain").value) - globalThis.__wspr.txGain()) < 1e-9,
          $("txGain").value);

    // ---- the batch plan ----------------------------------------------------
    //
    // One band, one power, so this is three carriers rather than thirty: the survey,
    // the verification after the MOD level moves, and the clean measurement. What is
    // being tested is not the search (that is above) but everything the plan adds --
    // the antenna question, the radio driving, the MOD level loop, the restore.
    //
    // The fixture's knee is K(band) x percent / modLevel, so a plan that failed to
    // retune, failed to set the power, or kept measurements from before the MOD write
    // would produce numbers that no longer match the formula. That is the only way to
    // catch those three from outside.
    const plan = globalThis.__wspr.gainPlan;
    plan.open();
    check("nothing about showing the plan keys anything",
          plan.running === false && globalThis.__wspr.state.beacon === "stopped");
    // It draws itself. Before this the panel showed only its static markup -- an empty
    // frame with an empty grid and an empty estimate -- because nothing called render()
    // until a question came up.
    check("the plan draws itself on arrival",
          $("planField").querySelector('[data-plan="estimate"]').textContent.length > 0,
          $("planField").querySelector('[data-plan="estimate"]').textContent);
    // Two axes, two rows, each labelled. One shared line read as if the percentage
    // belonged to the band being added.
    check("bands and powers are edited on separate rows",
          $("planField").querySelectorAll(".plan-axis").length === 2 &&
          Boolean($("planField").querySelector('[data-plan="addpower"]')) &&
          Boolean($("planField").querySelector('[data-plan="add"]')));
    // Adding a power is a visible act with a visible result.
    const columnsBefore = $("planField").querySelectorAll(".plan-chip").length;
    $("planField").querySelector('[data-plan="newpower"]').value = "33";
    $("planField").querySelector('[data-plan="addpower"]').click();
    await sleep(200);
    check("a power can be added, and shows up as a column",
          $("planField").querySelectorAll(".plan-chip").length === columnsBefore + 1 &&
          plan.plan.powers.includes(33),
          JSON.stringify(plan.plan.powers));
    check("and removed again",
          (() => {
            const chip = $("planField").querySelector('[data-remove-power="33"]');
            if (chip) chip.click();
            return !plan.plan.powers.includes(33);
          })(), JSON.stringify(plan.plan.powers));

    // Clicking a cell is the whole point of the grid, and it had no test -- which is
    // exactly how two methods with the same name (one for the window, one for a cell)
    // coexisted in the class with only the later one surviving. No backticks in this
    // file, not even in a comment: they end the template literal this script lives in.
    plan.plan = {powers: [7], rows: [{band: "40m", hz: 7040000, cells: [0]}]};
    plan.render();
    const gridCell = $("planField").querySelector("[data-cell]");
    check("a cell is there to click", Boolean(gridCell));
    if (gridCell) gridCell.click();
    await sleep(150);
    check("clicking a cell ticks it, and only it",
          plan.plan.rows[0].cells[0] === 1 && !$("planField").hidden,
          JSON.stringify(plan.plan.rows[0].cells) + " windowOpen=" + !$("planField").hidden);
    const cellAgain = $("planField").querySelector("[data-cell]");
    if (cellAgain) cellAgain.click();
    await sleep(150);
    check("and clicking it again unticks it", plan.plan.rows[0].cells[0] === 0,
          JSON.stringify(plan.plan.rows[0].cells));

    // Whose turn it is, said out loud. "Maybe I am supposed to press RUN and do not
    // know it" is what a panel that only describes ITSELF produces.
    check("the panel always says whose turn it is",
          $("planField").querySelector('[data-plan="todo"]').textContent
            .startsWith("Your turn:"),
          $("planField").querySelector('[data-plan="todo"]').textContent);
    // No question, no CONTINUE. It must not merely be hidden: a button that exists can
    // be clicked and reads as an invitation, and this one stayed on screen for the
    // length of a carrier while the plan was busy measuring.
    check("there is no CONTINUE button while nothing is being asked",
          !$("planField").querySelector('[data-answer="ok"]'));

    // Red BY ITSELF. The warning belongs to the moment the radio moves to a band with
    // nothing measured for it, not to the moment someone opens the panel -- which is
    // where it used to appear, because only a full render redrew the button.
    {
      const keepDoc = plan0.store.doc;
      plan0.store.doc = {v: 2, entries: {}, plan: plan0.plan};
      plan0.tick();                                   // what the page calls twice a second
      check("the button warns from the page's own tick, with no interaction",
            $("planButton").classList.contains("uncalibrated"),
            $("planButtonValue").textContent + " " + $("planButton").className);
      plan0.store.doc = keepDoc;
      plan0.tick();
    }

    // Red when the station has nothing measured for where the radio is standing: every
    // transmission would go out at the manual guess, and that is worth a colour.
    const keptDoc = plan0.store.doc;
    plan0.store.doc = {v: 2, entries: {}, plan: plan0.plan};
    plan0.renderButton();
    check("the topbar button goes red when nothing is calibrated",
          $("planButton").classList.contains("uncalibrated") &&
          $("planButtonValue").textContent === "NOT CALIBRATED",
          $("planButtonValue").textContent + " " + $("planButton").className);
    plan0.store.doc = {v: 2, plan: plan0.plan, entries: {"IC-705|2m|99":
      {gain: 0.3, knee: 0.3, modLevel: 128}}};
    plan0.renderButton();
    check("and stays red when the table has nothing for THIS band",
          $("planButton").classList.contains("uncalibrated") &&
          $("planButtonValue").textContent === "NOT FOR THIS BAND",
          $("planButtonValue").textContent);
    plan0.store.doc = keptDoc;
    plan0.renderButton();

    // RUN always answers. A disabled button with nothing beside it is
    // indistinguishable from a broken one -- which is how it was reported.
    plan.plan = {powers: [], rows: []};
    plan.render();
    check("with nothing to measure, RUN says so instead of going quiet",
          $("planField").querySelector('[data-plan="run"]').disabled === false &&
          /RUN will refuse/.test($("planField").querySelector('[data-plan="blocked"]').textContent),
          $("planField").querySelector('[data-plan="blocked"]').textContent);
    $("planField").querySelector('[data-plan="run"]').click();
    await sleep(300);
    check("and pressing it prints the reason",
          $("planField").querySelector('[data-plan="error"]').textContent.length > 0,
          $("planField").querySelector('[data-plan="error"]').textContent);

    // Build a one-cell plan on a band the earlier scenarios were not on, so the
    // retune is a real change.
    // Two bands on purpose. With one band the whole run stays on one frequency, so it
    // asks once and the "a question for every retune" rule is untested -- and the
    // version of this check that passed before was counting clicks on a CONTINUE button
    // left on screen by the very bug this fixes.
    plan.plan = {powers: [40], rows: [{band: "40m", hz: 7040000, cells: [1]},
                                      {band: "30m", hz: 10140000, cells: [1]}]};
    await plan.savePlan();
    check("the plan is stored on the station, not in this browser",
          Boolean((await (await fetch("/txgain.json", {cache: "no-store"})).json()).plan.rows.length),
          "a plan built at the desk has to be runnable from the tablet at the switch");
    check("the estimate says what the run will cost, in carriers and questions",
          /carriers/.test($("planField").textContent) &&
          /antenna questions/.test($("planField").textContent),
          $("planField").textContent.slice(0, 200));

    // The two numbers the whole design turns on. "How do I know what is set in the
    // radio's menu, and is the TX audio gain just static" is answered by showing them.
    const radioLine = $("planField").querySelector('[data-plan="radio"]').textContent;
    check("the window names the radio's MOD level and that it is one value for all bands",
          /MOD level/.test(radioLine) && /every band/.test(radioLine),
          radioLine.slice(0, 160));
    check("and the audio level a transmission would use, with where it came from",
          /TX audio gain now/.test(radioLine) &&
          /every transmission/.test(radioLine),
          radioLine.slice(-160));

    check("with a runnable plan it asks for RUN, and highlights it",
          /press RUN/.test($("planField").querySelector('[data-plan="todo"]').textContent) &&
          $("planField").querySelector('[data-plan="run"]').classList.contains("wanted"),
          $("planField").querySelector('[data-plan="todo"]').textContent);

    const modBefore = (await (await fetch("/civ-settings")).json())["1A050117"];
    $("planField").querySelector('[data-plan="run"]').click();

    // Nothing may key before the question is answered. Asserted by waiting for the
    // question and then checking that no carrier exists -- the plan has already
    // retuned and set the power by this point, which is exactly the moment a naive
    // implementation would start transmitting.
    const asked = await wait(() => !$("planField").querySelector('[data-plan="ask"]').hidden, 15000);
    check("it asks about the antenna before it keys", asked,
          "blocked=" + JSON.stringify(plan.blockingReason()) +
          " message=" + JSON.stringify(plan.message) +
          " running=" + plan.running + " disabled=" +
          $("planField").querySelector('[data-plan="run"]').disabled);
    check("the question names the band, the frequency and the power",
          /40m/.test($("planField").querySelector('[data-plan="ask"]').textContent) &&
          /7040/.test($("planField").querySelector('[data-plan="ask"]').textContent),
          $("planField").querySelector('[data-plan="ask"]').textContent);
    // Only the buttons that mean something. Everything else, pressed here, can only
    // produce a failure -- and there is exactly one STOP, in one place.
    check("while it asks, only CONTINUE and SKIP are offered",
          Boolean($("planField").querySelector('[data-answer="ok"]')) &&
          Boolean($("planField").querySelector('[data-answer="skip"]')) &&
          !$("planField").querySelector('[data-answer="stop"]'),
          $("planField").querySelector('[data-plan="ask"]').textContent.slice(0, 120));
    check("there is one STOP, and it is the toolbar's",
          $("planField").querySelectorAll('[data-plan="stop"]').length === 1 &&
          !$("planField").querySelector('[data-plan="stop"]').hidden);
    // Measured from the real layout, not asserted from the stylesheet: "disabled" is
    // only useful if it is VISIBLE, and the operator asked for exactly that -- a label
    // that cannot be confused with a live one.
    check("a disabled control is visibly dimmer than a live one",
          (() => {
            const dead = $("planField").querySelector('[data-plan="run"]');
            const live = $("planField").querySelector('[data-plan="stop"]');
            const deadStyle = getComputedStyle(dead), liveStyle = getComputedStyle(live);
            return Number(deadStyle.opacity) < Number(liveStyle.opacity) &&
                   deadStyle.cursor === "not-allowed";
          })(),
          getComputedStyle($("planField").querySelector('[data-plan="run"]')).opacity +
          " vs " +
          getComputedStyle($("planField").querySelector('[data-plan="stop"]')).opacity);

    check("and the controls that would only fail are disabled",
          ["run", "runall", "add", "addpower", "addband", "newpower"].every(name =>
            $("planField").querySelector('[data-plan="' + name + '"]').disabled === true),
          ["run", "runall", "add", "addpower", "addband", "newpower"]
            .filter(name => !$("planField").querySelector('[data-plan="' + name + '"]').disabled)
            .join(",") || "all disabled");
    // And the progress must move during the survey, not sit at 0/4.
    // The button reports the phase, never a count frozen at 0/4. An unanswered
    // question outranks even that, which is why ANTENNA? counts as an answer here.
    check("the button reports where the run is, not a frozen count",
          ["SURVEY", "MOD", "MEASURING", "VERIFYING", "FINISHING", "ANTENNA?"]
            .some(word => $("planButtonValue").textContent.toUpperCase().includes(word)),
          $("planButtonValue").textContent);

    check("the panel says the antenna answer is the operator's turn",
          /confirm the antenna/.test($("planField").querySelector('[data-plan="todo"]').textContent),
          $("planField").querySelector('[data-plan="todo"]').textContent);
    check("and no carrier is up while it waits",
          globalThis.__wspr.gainCal.running === false &&
          globalThis.__wspr.gainCal.tx.state !== "streaming",
          globalThis.__wspr.gainCal.tx.state);
    check("the radio was already tuned for it, so the answer is about the right band",
          globalThis.__wspr.state.radio.frequency === 7040000,
          String(globalThis.__wspr.state.radio.frequency));
    // The one way this window differs from the timetable: a waiting question cannot
    // be dismissed. A run about to key a carrier must not be able to hide the only
    // place its question is asked.
    check("the button shouts the question",
          $("planButtonValue").textContent.includes("ANTENNA?"),
          $("planButtonValue").textContent);
    document.body.click();
    $("planField").querySelector('[data-plan="close"]').click();
    check("and the window cannot be closed while it is asking", !$("planField").hidden);

    // Answer, and let the whole plan run.
    $("planField").querySelector('[data-answer="ok"]').click();
    // Every later retune asks again -- the operator's rule is one question per
    // retune, and the verification pass is a retune of its own.
    let answers = 1;
    // "Is anything happening and which step are we on" -- collected while it runs,
    // because after the run there is nothing left to look at.
    let sawProgress = false, lastProgress = "";
    const planDone = await wait(() => {
      const live = $("planField").querySelector('[data-plan="live"]');
      if (live && !live.hidden) {
        lastProgress = live.textContent;
        // A phase label with a position in it, and at some point the cell being
        // measured. Not the exact wording -- that is the panel's business.
        if (["survey", "measuring", "MOD level", "verifying", "finishing"]
              .some(label => lastProgress.includes(label)) &&
            lastProgress.includes("/")) sawProgress = true;
      }
      const ask = $("planField").querySelector('[data-plan="ask"]');
      if (ask && !ask.hidden) {
        const button = $("planField").querySelector('[data-answer="ok"]');
        if (button) { button.click(); answers++; }
      }
      return plan.running === false && Boolean(plan.summary);
    }, 120000);
    check("the plan finished", planDone, plan.message || "no summary");
    check("the progress line named the cell and the step while it worked",
          sawProgress, lastProgress);
    const planRetunes = (await (await fetch("/commands")).json())
      .filter(command => command.type === "setFrequency").length;
    check("it asked again for every retune, never fewer", answers >= 3,
          answers + " answers over " + planRetunes + " setFrequency writes");

    const civAfter = await (await fetch("/civ-settings")).json();
    check("the MOD level was written, once, from the worst band's knee",
          civAfter["1A050117"] !== modBefore,
          modBefore + " -> " + civAfter["1A050117"]);
    // Judged at the cell the plan calibrated, NOT at whatever the restore left the
    // radio on -- the first version of this check asked /knee afterwards and was
    // measuring 80 m at 50 %, which the MOD loop never looked at.
    const ownerKnee = 1.10 * 40 / civAfter["1A050117"];   // K(40m) x the planned 40 % / MOD
    check("and it landed where the calibrated cell's knee sits near 0.7",
          Math.abs(20 * Math.log10(ownerKnee / 0.7)) <= 1.5,
          "knee " + ownerKnee.toFixed(3) + " at MOD " + civAfter["1A050117"]);

    const table = await (await fetch("/txgain.json", {cache: "no-store"})).json();
    // The exact cell, not "something with 40m in it": the single-shot test above also
    // leaves an entry behind, and on a run where the dial happened to be on 40 m the
    // loose match picked THAT one and every assertion below compared the wrong row.
    const planKey = Object.keys(table.entries).find(key => key.endsWith("|40m|40"));
    check("the cell was measured and filed under its own band and power",
          Boolean(planKey), JSON.stringify(table.entries));
    const cell = planKey ? table.entries[planKey] : null;
    check("the entry records the MOD level it was measured at",
          Boolean(cell) && cell.modLevel === civAfter["1A050117"],
          cell ? String(cell.modLevel) : "none");
    check("the entry records the frequency it was measured on",
          Boolean(cell) && cell.hz === 7040000, cell ? String(cell.hz) : "none");
    // The proof that the plan really drove the radio: the stored knee has to match
    // what the fixture's formula gives for THAT band, THAT power and THAT MOD level.
    // A plan that skipped the retune would have measured 20 m; one that skipped the
    // power write would have measured the previous percent.
    // percent off the key, for the same reason as above.
    const cellPercent = Number(planKey.split("|")[2]);
    const expected = 1.10 * cellPercent / cell.modLevel;   // K(40m) in the fixture
    check("the measured knee matches the radio it was measured on",
          Boolean(cell) && Math.abs(20 * Math.log10(cell.knee / expected)) <= 1.0,
          cell ? cell.knee + " vs " + expected.toFixed(4) : "none");

    check("the run is summarised in cells, not in adjectives",
          /measured/.test(plan.summary), plan.summary);
    check("the radio was put back where the plan found it",
          globalThis.__wspr.state.radio.frequency === frequencyBefore,
          frequencyBefore + " -> " + globalThis.__wspr.state.radio.frequency);

    // Every measurement records the MOD level it was taken at, and the plan moved that
    // level -- so the single-shot row from earlier and the plan's own row disagree, and
    // that disagreement is exactly what makes the older one detectably stale. Before
    // the panel read the level on open, the earlier row recorded 0 ("unknown"), which
    // is honest but useless; now it records a number that can be compared.
    const older = table.entries[storedKey];
    check("the earlier measurement records the MOD level it was taken at",
          Boolean(older) && Number(older.modLevel) > 0,
          older ? String(older.modLevel) : "missing");
    check("and the plan moved the level, so that row is now detectably stale",
          Boolean(older) && Boolean(cell) && Number(older.modLevel) !== Number(cell.modLevel),
          (older ? older.modLevel : "?") + " vs " + (cell ? cell.modLevel : "?"));
    check("and the plan's own cell records the level it was measured at",
          Boolean(cell) && Number(cell.modLevel) > 0,
          cell ? String(cell.modLevel) : "missing");

    location.hash = "";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    check("clearing the hash leaves the calibration panel where it is",
          !$("calField").hidden, "it is a setting, not a mode");
  } catch (error) {
    check("page script ran without throwing", false, String(error && error.stack || error));
  }

  await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // The page script is injected by appending it as a script tag through the
  // devtools-free route: a query parameter the fixture rewrites into the HTML.
  const url = `http://127.0.0.1:${port}/wspr.html?audioPort=${port}`;
  // No --virtual-time-budget: it makes Chrome run timers as fast as it can, which
  // is right for a screenshot and wrong here -- the page's own polling and the
  // beacon's 500 ms heartbeat have to advance in step with real fetches.
  // Same Android user agent as tools/data-browser-smoke.js: the beacon is left
  // running on the operator's phone, and the wake lock keeper treats its video
  // fallback as a mobile-only technique, so a desktop user agent would test a
  // device nobody uses this page from.
  const androidUa = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `--user-agent=${androidUa}`, url,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  // The batch plan keys three carriers of its own (survey, verification, clean), so
  // the run is minutes long. It used to be 240 s and the plan tests pushed it over,
  // which surfaced as nine unrelated failures and no clue -- see the /oops route.
  timer = setTimeout(() => finish({checks: [["page reported within the timeout", false,
    "the page never posted /result. last steps: " + (progress.slice(-4).join(" > ") || "none") +
    (pageErrors.length ? " | errors: " + pageErrors.join(" | ") : "")]]}), 420000);
});

// The fixture rewrites wspr.html on the way out to append the test script, so the
// page under test is byte-identical to production apart from that one tag.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("wspr.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
