// The radio's network MOD level, read and written over CI-V.
//
// This is the one part of the calibration that changes a setting in the radio's
// own menu, so it is also the one part that has to be paranoid. The rules, in the
// order they matter:
//
//  1. READ FIRST, WRITE SECOND. A subaddress the radio never answered is a
//     subaddress this interface will not write to. Absence is the signal -- the
//     firmware does not parse NG (FA), so a command a radio does not implement
//     simply produces no reply and civReadSeq never moves.
//  2. NEVER A GUESSED SUBADDRESS. The number comes from icom-models.js, and it is
//     only there for models whose own CI-V reference was read. Across models these
//     are 00 62, 00 83, 00 90, 01 14, 01 17, 01 25, 01 28 -- no pattern, nothing to
//     check a guess against. 1A 05 01 14 is the LAN MOD level on one radio and
//     "WLAN AF/IF Output select" on another.
//  3. A DENY LIST FOR THE ONE IRREVERSIBLE MISTAKE. Every wrong write can be undone
//     with the value read from the same address moments earlier -- except a write
//     that lands on a CI-V or network setting, which takes the radio away with the
//     restore still unsent. Those subaddresses are refused outright.
//  4. WHERE ANY OF THAT FAILS, SAY WHAT TO DO. The operator's instruction was
//     explicit: if the level cannot be read or written, the plan stops and tells
//     them to set it in the radio's menu -- with the number and the menu path.
//
// The value is BCD, 0000..0255 = 0..100 %, the same encoding 14 0A uses for RF
// power, so the encoder is shared rather than written twice.

(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports ? require("./icom-models.js") : root.IcomModels);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.TxGainModLevel = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (IcomModels) {
  "use strict";

  const READ_URL = "/civread";
  // How long to wait for the radio to answer a read. The LAN control channel is
  // documented to starve under audio load, but nothing is streaming while this
  // runs, and 250 ms polls give the ordinary reply several chances.
  const READ_TIMEOUT_MS = 2500;
  const READ_POLL_MS = 250;

  const hex2 = value => value.toString(16).toUpperCase().padStart(2, "0");

  // 0..255 -> the two BCD bytes the radio expects (255 -> 02 55), identical to
  // WsprCore.civLevelCommand's payload for 14 0A.
  function bcdPayload(level) {
    const value = Math.max(0, Math.min(255, Math.round(Number(level) || 0)));
    return hex2(Math.floor(value / 100)) +
           hex2((((value / 10) | 0) % 10) * 16 + (value % 10));
  }

  function decodeBcd(hexPairs) {
    // "0096" -> 96. Two bytes, each a pair of decimal digits.
    let out = 0;
    for (let at = 0; at + 1 < hexPairs.length; at += 2) {
      const byte = parseInt(hexPairs.slice(at, at + 2), 16);
      if (!Number.isFinite(byte)) return null;
      out = out * 100 + (byte >> 4) * 10 + (byte & 0x0f);
    }
    return out;
  }

  // What this model lets us do, said in one place so the panel and the plan agree.
  function capability(model) {
    const row = model && typeof model === "object" ? model
      : IcomModels.findModel(IcomModels.modelNumber(model));
    if (!row) return {model: null, readable: false, writable: false,
                      reason: "the radio model is unknown", menu: ""};
    const command = row.modLevelCmd || "";
    if (!command) return {model: row, readable: false, writable: false,
                          reason: `no verified CI-V address for the ${row.label}'s ` +
                                  `${row.net} MOD level`, menu: row.modMenu || ""};
    if (!IcomModels.writableSubaddress(command))
      return {model: row, readable: true, writable: false,
              reason: `${command} is on the refused list`, menu: row.modMenu || ""};
    return {model: row, readable: true, writable: true, reason: "",
            menu: row.modMenu || "", command,
            inputCommand: row.modInputCmd || "", inputNet: row.modInputNet};
  }

  class ModLevelClient {
    // `send(payload)` posts to /cmd exactly as the host page already does, and
    // `fetchImpl` reads /civread. Both are injected so this file opens no sockets
    // of its own and can be driven by a test.
    constructor({send, fetchImpl, model, now} = {}) {
      this.send = send;
      this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
      this.now = now || (() => Date.now());
      this.modelSource = model;
      this.modelKey = undefined;
      this.cached = null;
      this.value = 0;              // last confirmed reading, 0 = never read
      this.original = 0;           // what the radio had when we first read it
      this.firmwareMissing = false;
      this.error = "";
    }

    // Re-derived, not captured. A panel is built when its page loads, which is before
    // the radio has answered its capabilities packet -- so a capability decided in the
    // constructor says "the radio model is unknown" for the rest of the session, and
    // the whole feature refuses to start on a radio it knows perfectly well. `model`
    // may therefore be a getter; the answer is cached until it changes.
    get capability() {
      const raw = typeof this.modelSource === "function" ? this.modelSource() : this.modelSource;
      const key = raw && typeof raw === "object" ? (raw.number || raw.label || "?") : raw;
      if (key !== this.modelKey || !this.cached) {
        this.modelKey = key;
        this.cached = capability(raw);
      }
      return this.cached;
    }

    get command() { return this.capability.command || ""; }

    // One read: arm, then poll until the sequence moves. Returns the value or null.
    async read(command = this.command) {
      this.error = "";
      if (!command) { this.error = this.capability.reason; return null; }
      let armed;
      try {
        armed = await this.send({type: "civ.read", data: command});
      } catch (error) {
        this.error = String(error.message || error);
        return null;
      }
      const before = Number(armed && armed.seq);
      const deadline = this.now() + READ_TIMEOUT_MS;
      let baseline = Number.isFinite(before) ? before : null;
      while (this.now() <= deadline) {
        await sleep(READ_POLL_MS);
        let json;
        try {
          const response = await this.fetchImpl(READ_URL, {cache: "no-store"});
          if (response.status === 404) {
            // No endpoint at all: this is an older firmware, not a silent radio.
            // The distinction is the whole reason /civread does not answer with a
            // friendly empty document the way /txgain.json does.
            this.firmwareMissing = true;
            this.error = "this interface's firmware cannot read CI-V replies — " +
                         "flash the firmware, not just the web assets";
            return null;
          }
          if (!response.ok) continue;
          json = await response.json();
        } catch (_error) { continue; }
        const seq = Number(json.seq) || 0;
        if (baseline === null) baseline = seq;
        if (seq === baseline) continue;
        // The reply has to be the one we asked about. The firmware already matches
        // the prefix, but an interface that answered a different question would be
        // the worst kind of wrong, so it is checked on this side too.
        const cmd = String(json.cmd || "").toUpperCase();
        const reply = String(json.reply || "").toUpperCase();
        if (cmd !== command.toUpperCase() || !reply.startsWith(command.toUpperCase()))
          continue;
        const payload = reply.slice(command.length);
        if (!payload) { this.error = "the radio answered with no value"; return null; }
        return {value: payload, cmd, ageMs: Number(json.ageMs) || 0};
      }
      this.error = `the radio did not answer ${spaced(command)}`;
      return null;
    }

    // The MOD level as a 0..255 raw value.
    async readLevel() {
      const answer = await this.read(this.command);
      if (!answer) return null;
      const level = decodeBcd(answer.value);
      if (level === null || level > 255) {
        // A number outside the documented range means the address is not what the
        // table thinks it is. Refuse rather than scale something unknown.
        this.error = `${spaced(this.command)} answered ${answer.value}, which is not ` +
                     "a 0..255 level — the address is not this radio's MOD level";
        return null;
      }
      this.value = level;
      if (!this.original) this.original = level;
      return level;
    }

    // Is the modulator actually listening to the network input? Readable on models
    // whose DATA MOD subaddress is known, and worth reading: "the MOD source is not
    // the LAN one" used to be one of three guesses printed after a failed search.
    async readInput() {
      const command = this.capability.inputCommand;
      if (!command) return {known: false, isNet: false, raw: null};
      const answer = await this.read(command);
      if (!answer) return {known: false, isNet: false, raw: null};
      const raw = parseInt(answer.value.slice(0, 2), 16);
      const expected = Number(this.capability.inputNet);
      if (!Number.isFinite(raw) || !Number.isFinite(expected))
        return {known: false, isNet: false, raw};
      return {known: true, isNet: raw === expected, raw, expected};
    }

    // Write, then read back. The read-back is not politeness: the write is
    // fire-and-forget over CI-V, and a MOD level that did not land would send the
    // whole matrix off by the ratio nobody noticed.
    async writeLevel(level) {
      this.error = "";
      if (!this.capability.writable) {
        this.error = this.capability.reason || "writing the MOD level is not supported here";
        return null;
      }
      const wanted = Math.max(0, Math.min(255, Math.round(Number(level) || 0)));
      try {
        await this.send({type: "civ.raw", data: this.command + bcdPayload(wanted)});
      } catch (error) {
        this.error = String(error.message || error);
        return null;
      }
      const confirmed = await this.readLevel();
      if (confirmed === null) return null;
      if (confirmed !== wanted) {
        this.error = `the radio kept ${confirmed} after being asked for ${wanted}`;
        return null;
      }
      return confirmed;
    }

    // Put back what the radio had before this run. Offered rather than automatic:
    // the new MOD level is the deliverable, but the operator never asked to lose
    // the old one, and restoring it also makes the previous table valid again.
    async undo() {
      if (!this.original || this.original === this.value) return null;
      return this.writeLevel(this.original);
    }

    // The highest percent of the 14 0A scale that still raises the output. An
    // IC-705 on its battery takes 100 % without complaint and stops at 5 W, so a
    // calibration at 100 % measured the 50 % cell again and filed it under the
    // wrong power. Only models whose supply commands are in icom-models.js are
    // asked; everything else is {limited: false}. Never touches this.error,
    // which belongs to the MOD level messages.
    async readPowerCeiling({supplyVolts = 0} = {}) {
      const row = this.capability.model;
      const none = {limited: false, percent: 100, watts: 0, battery: null, text: ""};
      if (!row || !row.powerSupplyCmd || !(row.watts > 0)) return none;
      const savedError = this.error;
      try {
        const kind = await this.read(row.powerSupplyCmd);
        let battery = null;
        if (kind) battery = parseInt(kind.value.slice(0, 2), 16) === 1;
        else if (Number(supplyVolts) > 0) battery = Number(supplyVolts) < row.batteryBelowVolts;
        if (battery === null) return none;
        // A radio that ignored 1A 0B will ignore its neighbour too; another
        // 2.5 s timeout before the first carrier buys nothing.
        const setting = kind
          ? await this.read(battery ? row.maxPowerBatteryCmd : row.maxPowerExternalCmd) : null;
        let watts = setting ? row.maxPowerStepsW[parseInt(setting.value.slice(0, 2), 16)] : 0;
        if (!(watts > 0)) watts = battery ? row.batteryWatts : row.watts;
        const percent = Math.max(1, Math.min(100, Math.floor(100 * watts / row.watts)));
        return {limited: percent < 100, percent, watts, battery,
                text: `${row.label} on ${battery ? "battery" : "external power"}: ` +
                      `max ${watts} W = ${percent} %`};
      } finally {
        this.error = savedError;
      }
    }
  }

  // Keeps readPowerCeiling() current for a page that writes power by itself
  // (the JS8 power bar). Re-read when the link comes up and whenever the supply
  // voltage moves by more than a TX sag -- plugging in or pulling the DC cable
  // moves it by about 5 V. `busy()` holds the read off while something else may
  // own the one-slot /civread mailbox or the radio is transmitting.
  class PowerCeilingWatch {
    constructor({client, busy, onChange} = {}) {
      this.client = client;
      this.busy = busy || (() => false);
      this.onChange = onChange || (() => {});
      this.ceiling = null;
      this.readVolts = 0;
      this.wasConnected = false;
      this.reading = false;
      this.retryAt = 0;
      this.owed = true;
    }

    // null = no limit known; otherwise the percent nothing should go above.
    percent() { return this.ceiling && this.ceiling.limited ? this.ceiling.percent : null; }
    text() { return this.ceiling && this.ceiling.limited ? this.ceiling.text : ""; }

    update(radio) {
      const connected = Boolean(radio && radio.connected);
      if (connected && !this.wasConnected) this.owed = true;
      this.wasConnected = connected;
      if (!connected || this.reading) return;
      const row = this.client.capability.model;
      if (!row || !row.powerSupplyCmd) {
        if (this.ceiling) { this.ceiling = null; this.onChange(); }
        return;
      }
      const volts = Number(radio.supplyVolts) || 0;
      if (volts > 0 && this.readVolts > 0 && Math.abs(volts - this.readVolts) >= 2) this.owed = true;
      if (!this.owed || Date.now() < this.retryAt || this.busy()) return;
      this.reading = true;
      this.client.readPowerCeiling({supplyVolts: volts}).then(ceiling => {
        this.owed = false;
        this.readVolts = volts;
        const before = this.percent();
        this.ceiling = ceiling;
        if (this.percent() !== before) this.onChange();
      }, () => { this.retryAt = Date.now() + 10000; })
        .finally(() => { this.reading = false; });
    }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const spaced = command => String(command).replace(/(..)(?=.)/g, "$1 ");

  return {ModLevelClient, PowerCeilingWatch, capability, bcdPayload, decodeBcd, spaced,
          READ_URL, READ_TIMEOUT_MS, READ_POLL_MS};
});
