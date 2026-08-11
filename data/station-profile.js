// How the station operates, kept by the station.
//
// The JS8 and WSPR settings used to live in each browser's localStorage: the
// speed, the TX offset, the heartbeat interval, the groups, the RF power, and
// the 24-hour band schedule. Which meant a tablet that arrived on the third day
// ran the same station with the heartbeat off, no groups and an empty schedule
// -- and nothing anywhere said so. A schedule the station keeps cannot depend
// on which screen happens to be open.
//
// Two things genuinely belong to the machine and stay behind:
//
//   clockCorrectionMs   the manual offset of THIS computer's clock
//   ui.disclosures      which panels this operator has open here
//
// Everything else follows the station. Storage is a blob endpoint on the
// configuration partition, so it survives a firmware update and lands in the
// backup for free -- the two things it could never do in localStorage.
//
// The browser copy is not deleted: it is what draws the page before the fetch
// lands, and it is what the PROMOTE path offers upwards when the station has no
// profile of its own yet. It is a cache, never a second opinion.

(function (root) {
  "use strict";

  var URL = "/js8-config.json";

  // One file, two profiles. WSPR keeps its own settings object -- power, model
  // override, per-band references, its own schedule -- and it is just as much a
  // fact about the station as the JS8 one, so it travels in the same document
  // rather than in a second endpoint that could get out of step with it.
  //
  //   { "v": 1, "js8": <the JS8 settings>, "wspr": <the WSPR settings> }
  //
  // Paths that stay in THIS browser, as dotted paths into that document.
  var SCHEMA_VERSION = 1;
  var BROWSER_ONLY = [
    "js8.modems.js8call.clockCorrectionMs",  // this computer's clock, not the station's
    "js8.ui",                                // which panels are open, here
    "wspr.clockCorrection"                   // the same, on the beacon page
  ];

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function getPath(doc, path) {
    var node = doc;
    var parts = path.split(".");
    for (var i = 0; i < parts.length; i++) {
      if (!node || typeof node !== "object") return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  function setPath(doc, path, value) {
    if (value === undefined) return;
    var parts = path.split(".");
    var node = doc;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }

  function deletePath(doc, path) {
    var parts = path.split(".");
    var node = doc;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!node || typeof node !== "object") return;
      node = node[parts[i]];
    }
    if (node && typeof node === "object") delete node[parts[parts.length - 1]];
  }

  // What gets stored on the station: everything except the two per-machine
  // paths. Stripping them rather than ignoring them on read matters -- one
  // browser's clock correction must not be able to reach another's transmit
  // timing even by accident.
  function forStation(js8, wspr) {
    var doc = {v: SCHEMA_VERSION};
    if (js8) doc.js8 = clone(js8);
    if (wspr) doc.wspr = clone(wspr);
    BROWSER_ONLY.forEach(function (path) { deletePath(doc, path); });
    return doc;
  }

  // Returns the half the caller asked for, with this machine's own values put
  // back over the top. `which` is "js8" or "wspr"; `local` is that page's
  // current settings object.
  function forBrowser(station, which, local) {
    if (isEmpty(station) || !station[which]) return null;
    var doc = clone(station);
    BROWSER_ONLY.forEach(function (path) {
      var parts = path.split(".");
      if (parts[0] !== which) return;
      var mine = getPath(local || {}, parts.slice(1).join("."));
      if (mine !== undefined) setPath(doc, path, clone(mine));
    });
    return doc[which];
  }

  function isEmpty(station) {
    if (!station || typeof station !== "object") return true;
    return !station.js8 && !station.wspr;
  }

  function read() {
    // Deadlines for the same reason station-identity.js carries them: a fetch
    // that can hang forever parks a pooled connection on a dead socket, and the
    // pages that load this module cannot afford to lose one. The POST rewrites
    // a LittleFS file, so it gets the longer leash.
    return fetch(URL, {cache: "no-store", signal: AbortSignal.timeout(8000)})
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // Writes are read-modify-write: the two pages are open at once often enough
  // that a JS8 save must not erase the WSPR half, and the file is replaced whole.
  function write(which, settings) {
    return read().then(function (existing) {
      var doc = (existing && typeof existing === "object") ? existing : {};
      doc.v = SCHEMA_VERSION;
      doc[which] = clone(settings);
      return post(forStation(doc.js8, doc.wspr));
    });
  }

  function post(doc) {
    return fetch(URL, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(12000),
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(doc)
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // Writes are debounced because the settings panel calls its save on every
  // keystroke of every field. The station does not need to hear about each one,
  // and the flash it lands on has a finite number of erase cycles.
  function writer(which, delayMs) {
    var timer = null, pending = null;
    return function (settings) {
      pending = settings;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        var doc = pending;
        pending = null;
        write(which, doc);
      }, delayMs || 1500);
    };
  }

  var api = {
    URL: URL, BROWSER_ONLY: BROWSER_ONLY, SCHEMA_VERSION: SCHEMA_VERSION,
    forStation: forStation, forBrowser: forBrowser, isEmpty: isEmpty,
    read: read, write: write, writer: writer
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StationProfile = api;
}(typeof globalThis !== "undefined" ? globalThis : self));
