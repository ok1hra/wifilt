// What this interface knows about each Icom transceiver, in one table.
//
// There used to be two half-tables: RADIO_FULL_POWER_W in wspr-core.js (watts
// only) and a single hand-written IC-705 procedure in data.html. Both answered
// "which radio is this?" and they could not both be right for five models, so an
// IC-7760 could not transmit WSPR at all (no watts entry -> refuse) while the
// setup help confidently explained an IC-705 menu tree to its operator.
//
// Keyed on the model NUMBER, not the reported string. The number is what the
// radio is; everything around it drifts. "IC-705", "IC705", a trailing firmware
// revision -- all parse to 705.
//
// DOM-free on purpose: wspr-core.js requires this under Node in the smoke tools,
// and trx-help.js builds the setup guides from the same rows in the browser.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.IcomModels = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {

  // net:      the word this radio uses for the network audio path. The IC-705 is
  //           wireless and says WLAN; every Ethernet model says LAN. It appears in
  //           three menu items, so it is data rather than three separate strings.
  // netMenu:  where Network Control and the credentials live. THREE variants, not
  //           two: the IC-705 keeps them under WLAN Set, the IC-7300MK2 and
  //           IC-7760 under Network > Remote Settings, and the IC-7610 and IC-9700
  //           have no Remote Settings submenu at all -- the items sit directly
  //           under Network. Verified in each radio's own manual, in docs/.
  // hasPreset: PRESET stores a whole named combination of settings, so the
  //           operator gets one-touch return to a working digital setup. Only some
  //           radios have it; on the others the guide has to say "set these by
  //           hand" rather than silently dropping three steps.
  // watts:    full output at 100 % of the CI-V power scale. This is the number
  //           that makes WSPR's dBm honest, and getting it wrong is a
  //           factor-of-ten error, so an unknown radio deliberately has no row.
  // civAddr:  the radio's default CI-V address. Note the IC-7300MK2 is B6h, NOT
  //           the original IC-7300's 94h -- same number, different address.
  //
  // modLevelCmd / modInputCmd: the 1A 05 subaddresses for this radio's network
  //           MOD level and for the setting that says which input feeds the
  //           modulator in a data mode. PRESENT ONLY WHERE THE NUMBER WAS READ IN
  //           THIS MODEL'S OWN CI-V REFERENCE, and absent everywhere else, because
  //           there is nothing to check a guess against: across models the
  //           subaddresses are 00 62, 00 83, 00 90, 01 14, 01 17, 01 25 and 01 28,
  //           with no pattern at all. The cost of guessing is not a failed write --
  //           1A 05 01 14 is the LAN MOD level on one model and "WLAN AF/IF Output
  //           select" on another, and 01 31 is CI-V Transceive, which would take
  //           the radio away mid-run with the restore still unsent.
  //
  //           A model with no number here is not left stranded: the tool reads the
  //           address first and only writes what the radio confirmed, and where it
  //           cannot, `modMenu` is what the operator is told to set by hand.
  const MODELS = [
    {
      number: 705, label: "IC-705", watts: 10, civAddr: "A4",
      net: "WLAN", netMenu: "MENU → SET → WLAN Set → Remote Settings",
      hasPreset: true, tested: true,
      firmwareNote: "Use firmware 1.20 or newer, which is where PRESET appears.",
      // Read in docs/IC-705_ENG_CI-V_1_20200721.pdf, "SET > Connectors":
      // 0117 = WLAN MOD Level 0000~0255, 0119 = DATA MOD (03 = WLAN). The value
      // is BCD, the same encoding 14 0A uses for power.
      modLevelCmd: "1A050117", modInputCmd: "1A050119", modInputNet: 3,
      modMenu: "MENU → SET → Connectors → MOD Input → WLAN MOD Level",
    },
    {
      number: 7300, label: "IC-7300MK2", watts: 100, civAddr: "B6",
      net: "LAN", netMenu: "MENU → SET → Network → Remote Settings",
      hasPreset: true,
      modMenu: "MENU → SET → Connectors → MOD Input → LAN MOD Level",
    },
    {
      number: 7610, label: "IC-7610", watts: 100, civAddr: "98",
      net: "LAN", netMenu: "MENU → SET → Network",
      hasPreset: false,
      // Read in docs/IC-7610_ENG_CI-V_4.pdf's own command table: 00 90 = LAN
      // MOD Level 0000~0255, same BCD encoding as IC-705's 01 17. Verified
      // live against a real IC-7610 (read matched the menu's displayed 25%,
      // then a write+readback round-trip confirmed and the original value
      // was restored). Deliberately no modLevelCmd/modInputNet: unlike the
      // IC-705's single global input select, the IC-7610 has a MOD input
      // choice PER DATA PROFILE (00 91~94 = DATA OFF/1/2/3, each 00~05 with
      // 05=LAN) with no CI-V-readable "which profile is active right now" --
      // readInput() would have nothing honest to check, so it stays absent
      // exactly like IC-7300/IC-9700/IC-7760 today, rather than guessing.
      modLevelCmd: "1A050090",
      modMenu: "MENU → SET → Connectors → MOD Input → LAN MOD Level",
    },
    {
      number: 9700, label: "IC-9700", watts: 100, civAddr: "A2",
      net: "LAN", netMenu: "MENU → SET → Network",
      hasPreset: false, vhfUhfOnly: true,
      // Deliberately no modLevelCmd. wfview lists 1A 05 01 14 for this radio with
      // Max=0 -- it does not offer the control itself -- and on the IC-705 that
      // same subaddress is "WLAN AF/IF Output > Output Select". Menu path from
      // docs/IC-9700_ENG_Basic_0a.pdf (default 50 %).
      modMenu: "MENU → SET → Connectors → MOD Input → LAN MOD Level",
    },
    {
      number: 7760, label: "IC-7760", watts: 200, civAddr: "B2",
      net: "LAN", netMenu: "MENU → SET → Network → Remote Settings",
      hasPreset: true,
      modMenu: "MENU → SET → Connectors → MOD Input → LAN MOD Level",
    },
  ];

  // Subaddresses this interface will never write, whatever a table claims. The
  // backstop for the one mistake that is not reversible: every other wrong write
  // can be undone with the value read from the same address a moment earlier, but
  // a CI-V or network setting takes the radio away and the restore never arrives.
  // From docs/IC-705_ENG_CI-V_1_20200721.pdf: 0131 CI-V Transceive, 0132 CI-V USB
  // Echo Back, 0165-0168 date/time and the NTP server string, 0295/0317/0320/0336
  // SSID.
  const FORBIDDEN_WRITE_SUBADDRESSES = Object.freeze([
    "0131", "0132", "0165", "0166", "0167", "0168",
    "0295", "0317", "0320", "0336",
  ]);

  // Is this 1A 05 command safe to write? Asked about the command string, not about
  // the model, because the danger is exactly the case where a model's table is
  // wrong and its number means something else on the radio in front of us.
  function writableSubaddress(command) {
    const hex = String(command || "").toUpperCase().replace(/[^0-9A-F]/g, "");
    if (!hex.startsWith("1A05") || hex.length !== 8) return false;
    return !FORBIDDEN_WRITE_SUBADDRESSES.includes(hex.slice(4));
  }

  // Radios that speak CI-V but have no network control of their own. They can
  // still turn up over LAN behind a wfview or RS-BA1 server, which reports the
  // radio's real model while the network settings live on the PC -- so their
  // watts have to be known even though no menu path can be offered.
  const BRIDGED_ONLY_WATTS = {7100: 100, 7851: 200, 9100: 100};

  // First run of 3-4 digits wins. Anything else -- a non-Icom radio behind a
  // bridge, a blank capabilities packet -- returns null, and every caller treats
  // null as "do not guess".
  function modelNumber(reported) {
    const match = /(\d{3,4})/.exec(String(reported == null ? "" : reported));
    return match ? Number(match[1]) : null;
  }

  // A model row, or null. There is deliberately no fallback to the IC-705: a page
  // that names a radio which is not connected is worse than one that admits it
  // does not know.
  function findModel(reported) {
    const number = modelNumber(reported);
    if (number == null) return null;
    return MODELS.find(model => model.number === number) || null;
  }

  // Full output at 100 % of the CI-V scale. Reads the model table first, then the
  // bridged-only radios, then gives up -- WSPR refuses to key on null rather than
  // assume, which is the only safe answer when 100 % could mean 10 W or 200 W.
  function fullPowerWatts(reported) {
    const model = findModel(reported);
    if (model) return model.watts;
    const number = modelNumber(reported);
    return (number != null && BRIDGED_ONLY_WATTS[number]) || null;
  }

  // For the setup-help model switcher and the WSPR manual power override, so both
  // lists are in one order and neither can gain a model the other lacks.
  function models() { return MODELS.slice(); }

  // radio.radioName can be a carryover from the PREVIOUS radio on a LAN slot:
  // while a reconnect is still "connecting", the firmware fills radioName
  // from what it remembers rather than leave it blank (so a page does not go
  // dead on a link blip), and that remembered value is exactly the wrong
  // answer the moment the physical radio behind it has actually changed.
  // radioNameSeen is true only once the CURRENT connection has itself read a
  // capabilities packet -- confirmed live against both an IC-705 and an
  // IC-7610 (switching a LAN slot's radio without restarting held the old
  // name for about a second while "connecting" was still true). Every reader
  // that turns the name into watts or a CI-V subaddress should go through
  // this rather than radio.radioName direct -- one shared copy so the fix
  // cannot regress in data.js/wspr.js/mercury.js independently of each other.
  function liveRadioModel(radio) {
    return radio && radio.radioNameSeen === true ? (radio.radioName || "") : "";
  }

  return {MODELS, BRIDGED_ONLY_WATTS, modelNumber, findModel, fullPowerWatts, models,
          FORBIDDEN_WRITE_SUBADDRESSES, writableSubaddress, liveRadioModel};
});
