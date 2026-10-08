// How the station operates, kept by the station.
//
// The JS8 and WSPR settings used to live in each browser's localStorage: the
// speed, the TX offset, the heartbeat interval, the groups, the RF power, and
// the 24-hour band schedule. Which meant a tablet that arrived on the third day
// ran the same station with the heartbeat off, no groups and an empty schedule
// -- and nothing anywhere said so. A schedule the station keeps cannot depend
// on which screen happens to be open.
//
// A few things genuinely belong to the machine and stay behind (BROWSER_ONLY):
//
//   clockCorrectionMs   the manual offset of THIS computer's clock
//   ui.disclosures      which panels this operator has open here
//   rtty.toneHz         where the RTTY decoder is listening at this moment
//
// Everything else follows the station. Storage is a blob endpoint on the
// configuration partition, so it survives a firmware update and lands in the
// backup for free -- the two things it could never do in localStorage.
//
// RTTY and Mercury followed on 2026-10-07, for the same reason: the RTTY page's
// RF power, squelch, polarity and decoder choices and the Mercury band schedule
// are facts about the station too, and a backup that could not carry them meant
// a reflash with "Erase device" quietly reset them. Their pages kept these in
// localStorage first, so they come over through adoptHalf() rather than the
// PROMOTE button below.
//
// The browser copy is not deleted: it is what draws the page before the fetch
// lands, and it is what the PROMOTE path offers upwards when the station has no
// profile of its own yet. It is a cache, never a second opinion.

(function (root) {
  "use strict";

  var URL = "/js8-config.json";

  // One file, one profile per page. WSPR keeps its own settings object -- power,
  // model override, per-band references, its own schedule -- and it is just as
  // much a fact about the station as the JS8 one, so it travels in the same
  // document rather than in a second endpoint that could get out of step with it.
  // RTTY and Mercury the same.
  //
  //   { "v": 1, "js8": <JS8>, "wspr": <WSPR>, "rtty": <RTTY>, "mercury": <Mercury> }
  //
  // Every page rewrites the whole file, so every page has to know every half --
  // a half missing from this list is erased by the next save of any other page.
  var HALVES = ["js8", "wspr", "rtty", "mercury"];
  //
  // Paths that stay in THIS browser, as dotted paths into that document.
  var SCHEMA_VERSION = 1;
  var BROWSER_ONLY = [
    "js8.modems.js8call.clockCorrectionMs",  // this computer's clock, not the station's
    "js8.ui",                                // which panels are open, here
    "wspr.clockCorrection",                  // the same, on the beacon page
    // Where the RTTY decoder listens right now: every click on a signal moves
    // it, so it is the tuning of this moment, not a setting. On the station it
    // would cost a rewrite of this whole file after nearly every contact.
    "rtty.toneHz"
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

  // What gets stored on the station: every half, minus the per-machine paths.
  // Stripping them rather than ignoring them on read matters -- one browser's
  // clock correction must not be able to reach another's transmit timing even
  // by accident. `halves` is {js8, wspr, rtty, mercury}, any of them absent.
  function forStation(halves) {
    var source = halves && typeof halves === "object" ? halves : {};
    var doc = {v: SCHEMA_VERSION};
    HALVES.forEach(function (which) {
      if (source[which]) doc[which] = clone(source[which]);
    });
    BROWSER_ONLY.forEach(function (path) { deletePath(doc, path); });
    return doc;
  }

  // Returns the half the caller asked for, with this machine's own values put
  // back over the top. `which` is one of HALVES; `local` is that page's
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
    return !HALVES.some(function (which) { return station[which]; });
  }

  // The station's document as this page last knew it: what was read from it,
  // with this page's own saves laid over the top the moment they are made
  // (not when the debounce sends them). A synchronous reader -- TxModePowers,
  // which names the RF power of every mode -- reads the station's halves from
  // here instead of whatever this one browser happens to have cached. null
  // until the first read.
  var lastSeen = null;
  function seen() { return lastSeen; }

  function read() {
    // Deadlines for the same reason station-identity.js carries them: a fetch
    // that can hang forever parks a pooled connection on a dead socket, and the
    // pages that load this module cannot afford to lose one. The POST rewrites
    // a LittleFS file, so it gets the longer leash.
    return fetch(URL, {cache: "no-store", signal: AbortSignal.timeout(8000)})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        if (doc && typeof doc === "object") lastSeen = doc;
        return doc;
      })
      .catch(function () { return null; });
  }

  // Writes are read-modify-write: the pages are open at once often enough that
  // a JS8 save must not erase the WSPR half, and the file is replaced whole.
  function write(which, settings) {
    return read().then(function (existing) {
      var doc = (existing && typeof existing === "object") ? existing : {};
      doc[which] = clone(settings);
      return post(forStation(doc)).then(function (ok) {
        if (ok) agreed[which] = storedForm(which, settings);
        return ok;
      });
    });
  }

  function post(doc) {
    return fetch(URL, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(12000),
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(doc)
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // What this page last agreed with the station on, per half, as the JSON the
  // station would store: set when a half is adopted from it and when one is
  // written to it. A save that would store the same thing again is not sent --
  // the RTTY tone is saved on every click and kept off the station, so without
  // this each click would still rewrite the whole file for nothing.
  var agreed = {};
  function storedForm(which, settings) {
    var halves = {};
    halves[which] = settings;
    return JSON.stringify(forStation(halves)[which] || null);
  }

  // Writes are debounced because the settings panel calls its save on every
  // keystroke of every field. The station does not need to hear about each one,
  // and the flash it lands on has a finite number of erase cycles.
  function writer(which, delayMs) {
    var timer = null, pending = null;
    return function (settings) {
      pending = settings;
      lastSeen = lastSeen || {};
      lastSeen[which] = clone(settings);
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        var doc = pending;
        pending = null;
        if (agreed[which] === storedForm(which, doc)) return;
        write(which, doc);
      }, delayMs || 1500);
    };
  }

  // For a page whose settings lived in localStorage before its half joined the
  // station (RTTY, Mercury). Resolves to the station's half when there is one --
  // the station overrules this browser, as everywhere else. When there is none
  // yet, this browser's copy becomes it, but only a copy the operator actually
  // saved here (`savedHere`): a page's defaults, on a tablet that has never
  // opened it, must not be what every other browser then adopts. Resolves to
  // null whenever the page should simply keep what it has.
  function adoptHalf(which, local, savedHere) {
    return read().then(function (station) {
      if (station && typeof station === "object" && station[which]) {
        agreed[which] = storedForm(which, station[which]);
        return forBrowser(station, which, local);
      }
      // null means the station did not answer: nothing is known, so nothing is
      // written. An answer without this half is the one case that migrates.
      if (station && savedHere && local) write(which, local);
      return null;
    }).catch(function () { return null; });
  }

  var api = {
    URL: URL, HALVES: HALVES, BROWSER_ONLY: BROWSER_ONLY, SCHEMA_VERSION: SCHEMA_VERSION,
    forStation: forStation, forBrowser: forBrowser, isEmpty: isEmpty,
    read: read, write: write, writer: writer, adoptHalf: adoptHalf, seen: seen
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StationProfile = api;
}(typeof globalThis !== "undefined" ? globalThis : self));
