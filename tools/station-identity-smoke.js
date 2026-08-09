// One callsign per station, not one per browser.
//
// Before this, the callsign existed three times: EEPROM for the cluster login,
// each browser's own JS8 profile, and once per log in the QSO database. WSPR
// read the browser copy, so which callsign went on the air depended on which
// tablet was open -- and on a fresh tablet it was nothing at all.
//
// The rules being checked here are small but each one has a failure mode that
// only shows up on the air, so they are pinned down individually:
//   * the interface wins, always
//   * except into an EMPTY interface, where a browser that already had a
//     callsign gets to hand it up instead of losing it
//   * nothing is adopted that the interface does not actually have
//   * every edit writes through, so a second answer cannot appear

const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const Identity = require(path.join(ROOT, "data", "station-identity.js"));

const failures = [];
function check(name, ok) { if (!ok) failures.push(name); }

// ---- normalising -----------------------------------------------------------
check("callsign is upper-cased and stripped", Identity.normaliseCall(" ok1hra ") === "OK1HRA");
check("compound callsigns survive normalising", Identity.normaliseCall("OK1HRA/P") === "OK1HRA/P");
check("punctuation is dropped from a callsign", Identity.normaliseCall("OK1-HRA!") === "OK1HRA");
check("a callsign is capped at the EEPROM field width",
  Identity.normaliseCall("ABCDEFGHIJKLMNOPQRST").length === 16);
check("a four-character locator is accepted", Identity.normaliseGrid("jo70") === "JO70");
check("a six-character locator is accepted", Identity.normaliseGrid("jo70fd") === "JO70FD");
// A bad locator has to become empty rather than be stored: WSPR packs it into
// the transmitted frame, so garbage there goes on the air.
check("a nonsense locator becomes empty", Identity.normaliseGrid("ZZ99") === "");
check("a truncated locator becomes empty", Identity.normaliseGrid("JO7") === "");

// ---- what may be TYPED ------------------------------------------------------
//
// The distinction the whole locator bug turned on: normaliseGrid answers "may
// this be stored", parseLocator answers "can I read this". An empty field is a
// deliberate clear; unreadable input is a mistake, and returning "" for it is
// what wiped the station's square when somebody typed half a locator on the JS8
// page and tabbed away.
check("a square is read as itself", Identity.parseLocator(" jo70fd ") === "JO70FD");
check("an empty field is empty, not an error", Identity.parseLocator("  ") === "");
check("coordinates are converted", Identity.parseLocator("50.0755, 14.4378") === "JO70FB");
check("coordinates separated by a space work too",
  Identity.parseLocator("50.0755 14.4378") === "JO70FB");
check("unreadable input is refused, NOT emptied", Identity.parseLocator("JO7") === null);
check("and so is prose", Identity.parseLocator("nonsense here") === null);
check("coordinates off the planet are refused", Identity.parseLocator("99, 200") === null);
check("the grid arithmetic came with it",
  Identity.latLonToGrid(50.0755, 14.4378, 6) === "JO70FB"
  && Identity.latLonToGrid(50.0755, 14.4378, 4) === "JO70");

// ---- adopting --------------------------------------------------------------
function adopted(station, local) {
  let applied = null;
  const result = Identity.adopt(station, local, changes => { applied = changes; });
  return {result, applied};
}

let a = adopted({call: "OK1HRA", grid: "JO70"}, {call: "", grid: ""});
check("an empty browser takes the station's identity",
  a.applied && a.applied.call === "OK1HRA" && a.applied.grid === "JO70");

a = adopted({call: "OK1HRA", grid: "JO70"}, {call: "OK1HRA", grid: "JO70"});
check("nothing is rewritten when they already agree", a.result === null && a.applied === null);

// The case the whole decision turns on: a browser that disagrees with the
// station is wrong, not the station.
a = adopted({call: "OK1HRA", grid: "JO70"}, {call: "OK2XYZ", grid: "JN99"});
check("the station overrules a browser that disagrees",
  a.applied && a.applied.call === "OK1HRA" && a.applied.grid === "JO70");

a = adopted({call: "OK1HRA", grid: ""}, {call: "", grid: "JO70"});
check("an empty station field never wipes the browser's",
  a.applied && a.applied.call === "OK1HRA" && a.applied.grid === undefined);

check("no station document means no change", Identity.adopt(null, {call: "OK1HRA"}, () => {}) === null);

// ---- promoting -------------------------------------------------------------
// promote() posts, so it is checked through a stubbed fetch rather than by
// reaching into the module.
const posted = [];
global.fetch = function (url, options) {
  posted.push({url, body: options && options.body ? JSON.parse(options.body) : null});
  return Promise.resolve({ok: true, json: () => Promise.resolve({ok: true})});
};

(async function () {
  posted.length = 0;
  await Identity.promote({call: "", grid: ""}, {call: "OK1HRA", grid: "JO70"});
  check("an empty station adopts what this browser already had",
    posted.length === 1 && posted[0].url === "/identity"
    && posted[0].body.call === "OK1HRA" && posted[0].body.grid === "JO70");

  posted.length = 0;
  const none = await Identity.promote({call: "OK1HRA", grid: "JO70"}, {call: "OK2XYZ", grid: "JN99"});
  check("a station that already has a callsign is never overwritten from a browser",
    none === null && posted.length === 0);

  posted.length = 0;
  await Identity.write({call: "ok1hra", grid: "jo70"});
  check("writing normalises before it posts",
    posted.length === 1 && posted[0].body.call === "OK1HRA" && posted[0].body.grid === "JO70");

  // The firmware writes what it is given, so "" means "forget the locator". A
  // value that merely failed to normalise must therefore never be sent as one.
  posted.length = 0;
  const refused = await Identity.write({grid: "JO7"});
  check("a locator that cannot be normalised is refused, not posted as empty",
    refused === null && posted.length === 0);
  posted.length = 0;
  await Identity.write({grid: ""});
  check("clearing on purpose is still allowed",
    posted.length === 1 && posted[0].body.grid === "");

  // ---- source contract -----------------------------------------------------
  const sketch = fs.readFileSync(path.join(ROOT, "wifilt.ino"), "utf8");
  const data = fs.readFileSync(path.join(ROOT, "data", "data.js"), "utf8");
  const wspr = fs.readFileSync(path.join(ROOT, "data", "wspr.js"), "utf8");
  const log = fs.readFileSync(path.join(ROOT, "data", "log.js"), "utf8");

  check("the firmware serves the write side",
    /webServer\.on\("\/identity",\s*HTTP_POST,\s*handlePostIdentity\)/.test(sketch));
  // And the read side, as its own route. /setup-data.json answers the same two
  // strings but costs two kilobytes and three filesystem reads, which is the
  // wrong price for something every open page re-reads on a timer.
  check("the firmware serves the read side",
    /webServer\.on\("\/identity",\s*HTTP_GET,\s*handleGetIdentity\)/.test(sketch)
    && /void handleGetIdentity\(\)/.test(sketch));
  check("the firmware stores it where the cluster already reads it",
    /eepromWriteStr\(DxcCallsign, 203, 16\)/.test(sketch)
    && /eepromWriteStr\(DxcLocator, 219, 6\)/.test(sketch));
  // The cluster logs in with the callsign, so it has to be told when it changes.
  check("a changed callsign reconnects the cluster",
    /if \(callChanged\) DxcRequestReconnect\(\);/.test(sketch));
  check("the write is committed, not left in the EEPROM shadow copy",
    /if \(wrote && !EEPROM\.commit\(\)\)/.test(sketch));

  check("DATA adopts the station identity during startup",
    /await syncStationIdentity\(\);/.test(data) && /async function syncStationIdentity/.test(data));
  check("WSPR adopts the station identity", /StationIdentity\.adopt\(station, local/.test(wspr));

  // ---- one editable copy ---------------------------------------------------
  //
  // SETUP is the only place a callsign or a locator can be typed. Three editable
  // copies meant three validations, and the JS8 one had no locator check at all:
  // typing "JN6" there posted an empty grid, and the firmware stores what it is
  // given -- so a typo on one tablet wiped the square the beacon transmits.
  const setup = fs.readFileSync(path.join(ROOT, "data", "setup.html"), "utf8");
  const dataHtml = fs.readFileSync(path.join(ROOT, "data", "data.html"), "utf8");
  const wsprHtml = fs.readFileSync(path.join(ROOT, "data", "wspr.html"), "utf8");

  check("SETUP has its own Identity section, above the cluster",
    /id="identitySection"/.test(setup)
    && setup.indexOf('id="identitySection"') < setup.indexOf('id="dxcSection"'));
  check("and it is where the two fields live",
    /name="dxccall"/.test(setup) && /name="dxclocator"/.test(setup)
    && setup.indexOf('name="dxccall"') > setup.indexOf('id="identitySection"')
    && setup.indexOf('name="dxccall"') < setup.indexOf('id="dxcSection"'));
  check("SETUP validates the locator with the shared parser",
    /StationIdentity\.parseLocator\(/.test(setup));
  check("a locator that cannot be read blocks the save rather than being stored",
    /setupSettleIdentity/.test(setup));
  // The identity step no longer LINKS to the section, it contains it: the panel
  // is moved into step 2 so the callsign is typed where it is asked for. The
  // link survives only as the fallback for a page the move did not happen on --
  // and both halves have to stay, or the one editable copy becomes unreachable.
  const spineSrc = fs.readFileSync(path.join(ROOT, "data", "setup-spine.js"), "utf8");
  check("the spine's identity step carries that section",
    /buildPanelStep\(step, "identitySection"/.test(spineSrc));
  check("and can still open it if the move did not happen",
    /openSection\(sectionId\)/.test(spineSrc));

  for (const [name, html] of [["data.html", dataHtml], ["wspr.html", wsprHtml]])
    check(name + " shows the identity instead of offering a field",
      /<output id="(myCall|callsign)"/.test(html)
      && /<output id="(myGrid|locator)"/.test(html)
      && /href="\/setup#identitySection"/.test(html));
  check("DATA no longer writes an identity of its own",
    !/saveStationIdentity/.test(data));
  check("WSPR no longer writes an identity of its own",
    !/StationIdentity\.write\(/.test(wspr));
  // Asked of the module, not of its text: the file still NAMES the two functions,
  // in the comment that says where they went.
  const WsprCore = require(path.join(ROOT, "data", "wspr-core.js"));
  check("there is one locator parser left, and it is not the encoder's",
    WsprCore.parseLocatorInput === undefined && WsprCore.latLonToGrid === undefined
    && typeof Identity.parseLocator === "function");
  check("the encoder kept what it actually needs",
    typeof WsprCore.normalizeLocator === "function");

  // Adopting once was true only until somebody opened SETUP.
  check("DATA keeps asking", /StationIdentity\.watch\(/.test(data));
  check("WSPR keeps asking", /StationIdentity\.watch\(/.test(wspr));
  check("a new log is prefilled from the station", /station\.call\) call\.value = station\.call/.test(log));
  check("a new log's callsign stays editable", !/lmMyCall'\)\.readOnly/.test(log));

  for (const page of ["data.html", "wspr.html", "log.html"]) {
    const html = fs.readFileSync(path.join(ROOT, "data", page), "utf8");
    check(page + " loads the identity module", /src="\/station-identity\.js/.test(html));
  }

  const total = 48;
  if (failures.length) {
    console.error("STATION IDENTITY FAIL (" + failures.length + " of " + total + ")\n  "
      + failures.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log("STATION IDENTITY PASS " + total + " checks");
  }
}());
