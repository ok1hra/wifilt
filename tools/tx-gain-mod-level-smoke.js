#!/usr/bin/env node
"use strict";

// The MOD level client, against a simulated radio and a simulated interface.
//
// This is the only code in the project that writes a setting in the radio's own
// menu, so the cases worth testing are the refusals:
//
//   * a model with no verified subaddress must not be written to at all
//   * a subaddress on the deny list must not be written to even if a table says so
//   * a radio that never answers must not be written to -- absence is the signal,
//     because the firmware does not parse NG
//   * an answer that is not a 0..255 level means the address is not what the table
//     thinks, and scaling it would send the whole matrix off by an unknown ratio
//   * a missing /civread means an old firmware, and it must NOT read as a silent
//     radio: those two have different instructions for the operator
//
// And one acceptance: on the IC-705, where the subaddress was read in the radio's
// own CI-V reference, the value round-trips as BCD.

const path = require("path");
const Mod = require(path.join(__dirname, "..", "data", "tx-gain-mod-level.js"));

let checks = 0, failures = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

// ---- a radio that answers 1A 05 --------------------------------------------
//
// Modelled the way the firmware works: a read arms a prefix, and a reply lands
// only if it matches. The sequence is what says "this is new".
function makeInterface({answers = {}, endpoint = true, silent = false} = {}) {
  const state = {seq: 0, cmd: "", reply: "", writes: [], reads: []};
  return {
    state,
    send: async payload => {
      if (payload.type === "civ.read") {
        state.cmd = payload.data;
        state.reply = "";
        state.reads.push(payload.data);
        const value = answers[payload.data];
        if (!silent && value !== undefined) {
          state.reply = payload.data + value;
          state.seq++;
        }
        return {ok: true, seq: silent || value === undefined ? state.seq : state.seq - 1};
      }
      if (payload.type === "civ.raw") {
        state.writes.push(payload.data);
        // A write changes what a later read will find, exactly as a radio would.
        const command = payload.data.slice(0, 8);
        if (answers[command] !== undefined) answers[command] = payload.data.slice(8);
        return {ok: true};
      }
      throw new Error(`unexpected command ${payload.type}`);
    },
    fetchImpl: async () => endpoint
      ? {ok: true, status: 200,
         json: async () => ({seq: state.seq, cmd: state.cmd, reply: state.reply, ageMs: 10})}
      : {ok: false, status: 404, json: async () => ({})},
  };
}

// ---- capability ------------------------------------------------------------

{
  const ic705 = Mod.capability(705);
  check("a model with a verified subaddress is readable and writable",
    ic705.readable && ic705.writable, JSON.stringify(ic705.reason));
  check("and it carries the command", ic705.command === "1A050117", ic705.command);

  const ic9700 = Mod.capability(9700);
  check("a model with no verified subaddress is neither",
    !ic9700.readable && !ic9700.writable);
  check("but it still knows where the menu is",
    /MOD Input/.test(ic9700.menu), ic9700.menu);
  check("and it says why, naming the radio",
    /IC-9700/.test(ic9700.reason), ic9700.reason);

  const unknown = Mod.capability(1234);
  check("an unknown radio offers nothing", !unknown.readable && !unknown.writable);
  check("and has no menu path to offer either", unknown.menu === "");
}

// ---- BCD -------------------------------------------------------------------

check("255 encodes as 02 55", Mod.bcdPayload(255) === "0255", Mod.bcdPayload(255));
check("96 encodes as 00 96", Mod.bcdPayload(96) === "0096", Mod.bcdPayload(96));
check("0 encodes as 00 00", Mod.bcdPayload(0) === "0000", Mod.bcdPayload(0));
check("128 encodes as 01 28", Mod.bcdPayload(128) === "0128", Mod.bcdPayload(128));
check("out of range is clamped, never wrapped", Mod.bcdPayload(400) === "0255");
check("0096 decodes to 96", Mod.decodeBcd("0096") === 96, String(Mod.decodeBcd("0096")));
check("0255 decodes to 255", Mod.decodeBcd("0255") === 255);
check("every level round-trips",
  Array.from({length: 256}, (_, level) => level)
       .every(level => Mod.decodeBcd(Mod.bcdPayload(level)) === level));

// ---- reading ---------------------------------------------------------------

(async () => {
  {
    const iface = makeInterface({answers: {"1A050117": "0096"}});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 705});
    const level = await client.readLevel();
    check("a level is read and decoded", level === 96, String(level));
    check("the first reading is remembered as the original", client.original === 96);
    check("the read went out as civ.read, not civ.raw",
      iface.state.reads.length === 1 && iface.state.writes.length === 0);
  }

  {
    // The radio ignores the address: no reply, so no value and NO WRITE.
    const iface = makeInterface({answers: {}, silent: true});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 705});
    const level = await client.readLevel();
    check("a silent radio yields no level", level === null);
    check("and the message names the address it asked about",
      /1A 05 01 17/.test(client.error), client.error);
    check("nothing was written", iface.state.writes.length === 0);
  }

  {
    // An answer outside 0..255 means the address is not the MOD level.
    const iface = makeInterface({answers: {"1A050117": "9999"}});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 705});
    const level = await client.readLevel();
    check("an out-of-range answer is refused, not scaled", level === null);
    check("and it says the address is wrong",
      /not this radio's MOD level/.test(client.error), client.error);
  }

  {
    // An interface that answers a DIFFERENT address. The firmware matches the
    // prefix itself, so this should be impossible -- which is exactly why it is
    // checked here too: accepting it would report the USB MOD level as the network
    // one, and every knee in the matrix would be measured against the wrong
    // sensitivity with nothing anywhere looking broken.
    const iface = makeInterface({answers: {"1A050117": "0096"}});
    const crossed = {...iface, fetchImpl: async () => ({ok: true, status: 200,
      json: async () => ({seq: iface.state.seq, cmd: "1A050116",
                          reply: "1A0501160255", ageMs: 5})})};
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: crossed.fetchImpl,
                                          model: 705});
    const level = await client.readLevel();
    check("a reply from another subaddress is not accepted as the answer",
      level === null, String(level));
    check("and it reads as no answer at all",
      /did not answer/.test(client.error), client.error);
  }

  {
    // No endpoint: an older firmware, and a different instruction.
    const iface = makeInterface({answers: {"1A050117": "0096"}, endpoint: false});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 705});
    const level = await client.readLevel();
    check("a missing /civread yields no level", level === null);
    check("it is reported as an old firmware, not a silent radio",
      client.firmwareMissing && /flash the firmware/.test(client.error), client.error);
  }

  // ---- writing -------------------------------------------------------------

  {
    const iface = makeInterface({answers: {"1A050117": "0128"}});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 705});
    await client.readLevel();
    const written = await client.writeLevel(84);
    check("a write lands and is confirmed by reading back", written === 84, String(written));
    check("the payload is the command plus BCD",
      iface.state.writes[0] === "1A0501170084", iface.state.writes[0]);
    check("the original value is still remembered", client.original === 128);

    const undone = await client.undo();
    check("undo puts back what the radio had", undone === 128, String(undone));
  }

  {
    // The radio keeps its own value: a write that did not land must not be
    // reported as success, or the whole matrix is measured at the wrong sensitivity.
    const iface = makeInterface({answers: {"1A050117": "0128"}});
    const stubborn = {...iface, send: async payload =>
      payload.type === "civ.raw" ? {ok: true} : iface.send(payload)};
    const client = new Mod.ModLevelClient({send: stubborn.send, fetchImpl: iface.fetchImpl,
                                          model: 705});
    await client.readLevel();
    const written = await client.writeLevel(84);
    check("a write the radio ignored is not success", written === null);
    check("and it says what the radio kept",
      /kept 128/.test(client.error), client.error);
  }

  {
    // A model with no verified subaddress: refused before anything goes on the wire.
    const iface = makeInterface({answers: {"1A050083": "0128"}});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 7300});
    const written = await client.writeLevel(84);
    check("an unverified model is never written to", written === null);
    check("nothing reached the wire", iface.state.writes.length === 0);
    check("and the operator is pointed at the menu",
      /no verified CI-V address/.test(client.error), client.error);
  }

  {
    // A table that named a forbidden subaddress: refused by the deny list even
    // though the model row claims it. This is the one mistake with no undo.
    const iface = makeInterface({answers: {"1A050131": "0001"}});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
      model: {label: "IC-TEST", net: "LAN", modLevelCmd: "1A050131",
              modMenu: "MENU → somewhere"}});
    check("a CI-V subaddress is not writable", client.capability.writable === false);
    const written = await client.writeLevel(84);
    check("and no write is attempted", written === null && iface.state.writes.length === 0);
    check("the reason names the refusal",
      /refused list/.test(client.error), client.error);
  }

  // ---- the MOD input -------------------------------------------------------

  {
    const iface = makeInterface({answers: {"1A050119": "03"}});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 705});
    const input = await client.readInput();
    check("the DATA MOD input is readable on the IC-705",
      input.known && input.isNet, JSON.stringify(input));
  }

  {
    const iface = makeInterface({answers: {"1A050119": "01"}});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 705});
    const input = await client.readInput();
    check("a modulator listening to USB is detected",
      input.known && !input.isNet && input.raw === 1, JSON.stringify(input));
  }

  {
    const iface = makeInterface({answers: {}});
    const client = new Mod.ModLevelClient({send: iface.send, fetchImpl: iface.fetchImpl,
                                          model: 7610});
    const input = await client.readInput();
    check("a model with no known input subaddress simply does not know",
      !input.known && input.raw === null, JSON.stringify(input));
  }

  console.log(`${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
})();
