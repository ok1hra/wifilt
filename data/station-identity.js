// Who this station is, kept in one place.
//
// The callsign and locator used to exist three times over: in the interface's
// EEPROM for the DX cluster login, in each browser's own JS8 profile, and once
// more per log in the QSO database. WSPR read the middle one -- so which
// callsign actually went on the air depended on which tablet happened to be
// open, and a second tablet transmitted under no callsign at all.
//
// The interface wins, always. It is the only thing that IS the station: browser
// storage is per-origin, so `http://192.168.1.42` and `http://wifilt.local` are
// two different boxes to the same browser, and a new address orphans both.
//
// The browser keeps a copy so a page can draw itself before the fetch lands,
// but the copy is a cache -- never a second opinion. Editing is still allowed
// wherever it was allowed before; it just writes through to the interface
// instead of stopping in localStorage.

(function (root) {
  "use strict";

  var GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;

  // watch() re-reads once a minute for as long as the page lives, so its fetch
  // must not be able to hang forever: after a WiFi burst a request with no
  // deadline parks one of the browser's ~6 per-origin connections on a dead
  // socket, and the pages that load this module poll enough other endpoints
  // that the pool then never recovers. 8 s clears the ~5 s the firmware
  // legitimately defers port 80 around a TX slot; the write lands on EEPROM,
  // so it gets a longer leash.
  function deadline(ms) { return AbortSignal.timeout(ms || 8000); }

  function normaliseCall(value) {
    return String(value == null ? "" : value).toUpperCase().replace(/[^A-Z0-9/]/g, "").slice(0, 16);
  }

  function normaliseGrid(value) {
    var grid = String(value == null ? "" : value).toUpperCase().trim();
    return GRID_RE.test(grid) ? grid : "";
  }

  // Maidenhead from coordinates. Lifted out of wspr-core.js together with the
  // parser below: they were there because the WSPR settings panel was the only
  // field a locator could be typed into, and that field is now a display. The
  // encoder keeps normalizeLocator, which is what it actually needs.
  function latLonToGrid(lat, lon, characters) {
    if (!isFinite(lat) || !isFinite(lon)) return "";
    // Clamped rather than wrapped: a pole or the date line must not roll into a
    // field that does not exist.
    var la = Math.min(Math.max(lat, -90), 90) + 90;
    var lo = Math.min(Math.max(lon, -180), 180) + 180;
    var fieldLon = Math.min(17, Math.floor(lo / 20));
    var fieldLat = Math.min(17, Math.floor(la / 10));
    var grid = String.fromCharCode(65 + fieldLon, 65 + fieldLat)
             + Math.min(9, Math.floor((lo - fieldLon * 20) / 2))
             + Math.min(9, Math.floor(la - fieldLat * 10));
    if ((characters || 6) >= 6) {
      var restLon = lo - fieldLon * 20 - Math.floor((lo - fieldLon * 20) / 2) * 2;
      var restLat = la - fieldLat * 10 - Math.floor(la - fieldLat * 10);
      grid += String.fromCharCode(65 + Math.min(23, Math.floor(restLon / (2 / 24))),
                                  65 + Math.min(23, Math.floor(restLat / (1 / 24))));
    }
    return grid;
  }

  // What the operator may TYPE, which is not the same as what may be stored: a
  // pair of coordinates is a locator they have not converted yet.
  //
  // Returns "" for empty, a grid for anything it can read, and null for input it
  // cannot. Null is the whole point: an unreadable locator is NOT an empty one,
  // and treating the two the same is how typing "JN6" and tabbing away wiped the
  // station's locator while the browser kept the typo.
  function parseLocator(input) {
    var text = String(input == null ? "" : input).trim();
    if (!text) return "";
    var grid = normaliseGrid(text);
    if (grid) return grid;
    var pair = text.split(/[,;\s]+/).filter(Boolean);
    if (pair.length !== 2) return null;
    var lat = Number(pair[0]), lon = Number(pair[1]);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return null;
    return normaliseGrid(latLonToGrid(lat, lon, 6)) || null;
  }

  // The read side. `/identity` is two strings; `/setup-data.json` is two
  // kilobytes and three filesystem reads for the same answer, so it is only the
  // fallback -- for an interface whose firmware predates the GET route, where a
  // 404 must not read as "this station has no callsign".
  function read() {
    return fetch("/identity", {cache: "no-store", signal: deadline()})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return readFromSetupData();
        return {call: normaliseCall(data.call), grid: normaliseGrid(data.grid)};
      })
      .catch(function () { return readFromSetupData(); });
  }

  function readFromSetupData() {
    return fetch("/setup-data.json", {cache: "no-store", signal: deadline()})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return null;
        return {call: normaliseCall(data.dxccall), grid: normaliseGrid(data.dxclocator)};
      })
      .catch(function () { return null; });
  }

  // A field that cannot be normalised is REFUSED, never sent as empty. The
  // firmware writes what it is given, so "" means "forget the station's
  // locator" -- an answer nobody asked for by mistyping one.
  function write(identity) {
    var body = {};
    if (identity && identity.call !== undefined) body.call = normaliseCall(identity.call);
    if (identity && identity.grid !== undefined) {
      var grid = String(identity.grid == null ? "" : identity.grid).trim();
      var normalised = normaliseGrid(grid);
      // Clearing on purpose is still allowed; garbage is not.
      if (!normalised && grid) return Promise.resolve(null);
      body.grid = normalised;
    }
    return fetch("/identity", {
      method: "POST",
      cache: "no-store",
      signal: deadline(12000),
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    }).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // Take what the interface says and hand it to the page, but only when it is
  // actually different -- an unconditional apply would rewrite the stored
  // profile on every page load for no reason, and on a fresh interface it would
  // wipe a callsign the operator had only ever typed into this browser.
  //
  // `local` is what the page has now; `apply` is called with the values to adopt.
  // Returns what was adopted, or null when there was nothing to do.
  function adopt(station, local, apply) {
    if (!station) return null;
    var changes = {};
    var any = false;
    if (station.call && station.call !== normaliseCall(local && local.call)) {
      changes.call = station.call; any = true;
    }
    if (station.grid && station.grid !== normaliseGrid(local && local.grid)) {
      changes.grid = station.grid; any = true;
    }
    if (!any) return null;
    if (apply) apply(changes);
    return changes;
  }

  // A callsign the interface does not have yet, but this browser does, is the
  // one case where the browser has something worth keeping -- the operator set
  // it up here before identity moved into the interface. Offer it upwards
  // rather than deleting it, and only into an empty station.
  function promote(station, local) {
    if (!station || !local) return null;
    var body = {};
    if (!station.call && normaliseCall(local.call)) body.call = normaliseCall(local.call);
    if (!station.grid && normaliseGrid(local.grid)) body.grid = normaliseGrid(local.grid);
    if (!body.call && !body.grid) return null;
    return write(body).then(function () { return body; });
  }

  // Keep asking. Adopting once at page load was true only for the first minute:
  // change the callsign in SETUP and the tablet left open on the beacon page goes
  // on transmitting under the old one until somebody reloads it -- and nothing on
  // screen says so, because that page believes it holds the station's own value.
  //
  // A minute is chosen against what it costs, not against how fast anyone types:
  // this is two strings out of EEPROM, next to a /state poll that runs at 1 Hz.
  // The visibility hook is what actually matters -- a backgrounded tab has its
  // timers throttled, and a backgrounded tab is exactly the stale one.
  //
  // `local` is a getter, not a value: the page's own copy moves underneath.
  function watch(local, apply, options) {
    var intervalMs = (options && options.intervalMs) || 60000;
    function sync() {
      return read().then(function (station) {
        return adopt(station, typeof local === "function" ? local() : local, apply);
      }).catch(function () { return null; });
    }
    var timer = setInterval(sync, intervalMs);
    if (typeof document !== "undefined" && document.addEventListener)
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) sync();
      });
    return {sync: sync, stop: function () { clearInterval(timer); }};
  }

  var api = {
    read: read, write: write, adopt: adopt, promote: promote, watch: watch,
    parseLocator: parseLocator, latLonToGrid: latLonToGrid,
    normaliseCall: normaliseCall, normaliseGrid: normaliseGrid
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StationIdentity = api;
}(typeof globalThis !== "undefined" ? globalThis : self));
