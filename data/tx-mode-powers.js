// Which RF power each tone mode transmits at -- read in one place.
//
// The TX audio calibration is ONE table for JS8, WSPR and RTTY in USB-D/LSB-D:
// the key is radio | band | power, and the mode is not in it, because the point
// where the ALC starts to act moves with the RF power the radio is set to and
// with nothing a mode does. What made it feel like "calibrating every mode
// separately" is that each mode sets its OWN power -- JS8 a percentage, WSPR a
// dBm level, RTTY its own percentage -- so a band calibrated from JS8 at 30 %
// still read "not calibrated" on WSPR at 5 %.
//
// This module names those powers so the calibration can be planned for all of
// them at once (CAL PLAN columns) and shown per mode (SETUP's overview). It reads
// the station's copy of each page's settings (data/station-profile.js) where the
// page has seen one, and this browser's stored copy for any mode it has not;
// nothing here writes.
//
// Mercury is deliberately absent: its bursts have ~7.5 dB more peak than a steady
// tone, so it keeps its own table and its own carrier. RTTY on real FSK keys the
// radio's shift modulator and needs no audio calibration at all.

(function (root) {
  "use strict";

  var KEYS = {js8: "wifilt.data.js8-settings", wspr: "wifilt.wspr.v1",
              rtty: "wifilt.data.rtty-settings"};
  // The WSPR page's own cap (wspr.js POWER_CEILING_W): the levels it offers.
  var WSPR_CEILING_W = 10;

  function readJson(storage, key) {
    try {
      var raw = storage && storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function wholePercent(value) {
    var n = Number(value);
    return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : 0;
  }

  // model: the radio model the station reports (WSPR's dBm needs its full power
  // to become a percentage). Returns [{mode, percent, detail}] for the modes that
  // have a power set; a mode with nothing chosen is simply absent.
  function read(options) {
    options = options || {};
    var storage = options.storage !== undefined ? options.storage
      : (typeof root.localStorage !== "undefined" ? root.localStorage : null);
    var wsprCore = options.wsprCore || root.WsprCore;
    var station = options.station !== undefined ? options.station
      : (root.StationProfile && root.StationProfile.seen ? root.StationProfile.seen() : null);
    function half(which) {
      return station && station[which] ? station[which] : readJson(storage, KEYS[which]);
    }
    var out = [];

    var js8 = half("js8");
    var js8Percent = wholePercent(js8 && js8.modems && js8.modems.js8call &&
                                  js8.modems.js8call.rfPercent);
    if (js8Percent) out.push({mode: "JS8", percent: js8Percent, detail: js8Percent + " %"});

    var wspr = half("wspr");
    if (wspr && wsprCore) {
      var model = wspr.modelOverride || options.model || "";
      var full = model ? wsprCore.fullPowerWatts(model) : 0;
      if (full) {
        // The same choice wspr.js targetDbm() makes: the stored level when the
        // page offers it, otherwise the lowest level it offers.
        var levels = wsprCore.offeredPowerLevels(full, WSPR_CEILING_W);
        var dbm = levels.indexOf(Number(wspr.powerDbm)) >= 0 ? Number(wspr.powerDbm) : levels[0];
        if (dbm !== undefined) {
          try {
            var percent = wsprCore.civPercent(wsprCore.powerCommand(dbm, full).level);
            if (percent >= 1) out.push({mode: "WSPR", percent: percent, detail: dbm + " dBm"});
          } catch (e) { /* above what this radio can do: nothing to plan */ }
        }
      }
    }

    var rtty = half("rtty");
    var rttyPercent = wholePercent(rtty && rtty.rfPercent);
    if (rttyPercent) out.push({mode: "RTTY", percent: rttyPercent, detail: rttyPercent + " %"});
    return out;
  }

  // Distinct whole percents, in the order given, at most `limit`: the caller's
  // own powers come first, so a page that has to drop one drops someone else's.
  function union(lists, limit) {
    var seen = {}, out = [];
    limit = limit || 4;
    lists.forEach(function (list) {
      (list || []).forEach(function (value) {
        var percent = wholePercent(value);
        if (!percent || seen[percent] || out.length >= limit) return;
        seen[percent] = true;
        out.push(percent);
      });
    });
    return out;
  }

  function modesAt(percent, modes) {
    return (modes || []).filter(function (m) { return m.percent === percent; })
      .map(function (m) { return m.mode; });
  }

  var api = {read: read, union: union, modesAt: modesAt, KEYS: KEYS};
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TxModePowers = api;
})(typeof window !== "undefined" ? window : globalThis);
