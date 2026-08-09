// How the station operates belongs to the station.
//
// The JS8 and WSPR settings lived in each browser's localStorage, so a tablet
// that arrived on the third day ran the same station with the heartbeat off, no
// groups and an empty band schedule -- silently, because nothing compared them.
// Moving them into the interface is only safe if three things hold, and each of
// them fails quietly rather than loudly, so each is pinned here:
//
//   * the two per-machine values never travel (one computer's clock correction
//     must not reach another's transmit timing)
//   * a save of one half never erases the other (both pages are open at once)
//   * an interface that already has a profile is never overwritten by a browser

const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const Profile = require(path.join(ROOT, "data", "station-profile.js"));

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) failures.push(name + (detail ? " — " + detail : ""));
}

const js8 = {
  schemaVersion: 9, activeModem: "js8call",
  modems: {js8call: {myCall: "OK1HRA", grid: "JO70", hbMinutes: 60, groups: ["@OK"],
    txOffsetHz: 1500, rfPercent: 14, clockCorrectionMs: 37}},
  ui: {disclosures: {traffic: true, settings: false}},
  freqTimetable: {enabled: true, slots: {0: {hz: 14097100, band: "20m"}}}
};
const wspr = {version: 4, powerDbm: 23, modelOverride: "", clockCorrection: -11,
  powerReferences: {"40m": 118}, slots: {}};

// ---- what travels and what stays -------------------------------------------
const stored = Profile.forStation(js8, wspr);
check("the stored document carries both profiles", !!stored.js8 && !!stored.wspr);
check("the stored document is versioned", stored.v === Profile.SCHEMA_VERSION);
// The whole point: these two are about the machine, not the station.
check("this computer's clock correction does not travel",
  stored.js8.modems.js8call.clockCorrectionMs === undefined);
check("the beacon page's clock correction does not travel",
  stored.wspr.clockCorrection === undefined);
check("which panels are open here does not travel", stored.js8.ui === undefined);
// And everything that IS the station does.
check("the heartbeat interval travels", stored.js8.modems.js8call.hbMinutes === 60);
check("the groups travel", stored.js8.modems.js8call.groups[0] === "@OK");
check("the band schedule travels", stored.js8.freqTimetable.slots[0].hz === 14097100);
check("the RF power travels", stored.js8.modems.js8call.rfPercent === 14);
check("the beacon's power travels", stored.wspr.powerDbm === 23);
check("the beacon's per-band references travel", stored.wspr.powerReferences["40m"] === 118);
// Stripping must not mutate the caller's own settings object.
check("stripping does not damage the page's own settings",
  js8.modems.js8call.clockCorrectionMs === 37 && wspr.clockCorrection === -11);

// ---- coming back -----------------------------------------------------------
const backJs8 = Profile.forBrowser(stored, "js8", js8);
check("the station's heartbeat interval comes back", backJs8.modems.js8call.hbMinutes === 60);
check("this computer keeps its own clock correction",
  backJs8.modems.js8call.clockCorrectionMs === 37);
check("this computer keeps its own open panels", backJs8.ui.disclosures.traffic === true);
const backWspr = Profile.forBrowser(stored, "wspr", wspr);
check("the beacon takes the station's power", backWspr.powerDbm === 23);
check("the beacon keeps this computer's clock correction", backWspr.clockCorrection === -11);
// A browser that has never had a clock correction must not invent one.
const bare = Profile.forBrowser(stored, "js8", {});
check("an untouched browser gets no clock correction invented for it",
  bare.modems.js8call.clockCorrectionMs === undefined);

// ---- empty means empty -----------------------------------------------------
check("no document at all is empty", Profile.isEmpty(null));
check("an empty object is empty", Profile.isEmpty({}));
// The version alone is not a profile: the firmware answers {} for "never
// written", and a document with only a version would be the same nothing.
check("a document with only a version is still empty", Profile.isEmpty({v: 1}));
check("a document with either half is not empty", !Profile.isEmpty({v: 1, wspr: {}}));
check("nothing comes back out of an empty station",
  Profile.forBrowser({}, "js8", js8) === null);
check("nothing comes back for a half that is not there",
  Profile.forBrowser({v: 1, js8: js8}, "wspr", wspr) === null);

// ---- one half never erases the other ---------------------------------------
// Both pages are open at once often enough that this is not theoretical: the
// file is replaced whole, so a JS8 save has to re-read before it writes.
(async function () {
  let onDisk = Profile.forStation(js8, wspr);
  global.fetch = function (url, options) {
    if (!options || options.method !== "POST")
      return Promise.resolve({ok: true, json: () => Promise.resolve(onDisk)});
    onDisk = JSON.parse(options.body);
    return Promise.resolve({ok: true, json: () => Promise.resolve({ok: true})});
  };

  await Profile.write("js8", Object.assign({}, js8,
    {modems: {js8call: {myCall: "OK1HRA", hbMinutes: 15}}}));
  check("saving the JS8 half keeps the beacon's half",
    onDisk.wspr && onDisk.wspr.powerDbm === 23,
    JSON.stringify(onDisk.wspr));
  check("saving the JS8 half actually changes it",
    onDisk.js8 && onDisk.js8.modems.js8call.hbMinutes === 15);

  await Profile.write("wspr", Object.assign({}, wspr, {powerDbm: 10}));
  // Guarded rather than chained: when a half really does get erased -- the very
  // failure being tested -- an unguarded read throws, and a suite that dies is
  // harder to read than one that says which check failed.
  check("saving the beacon half keeps the JS8 half",
    onDisk.js8 && onDisk.js8.modems.js8call.hbMinutes === 15,
    JSON.stringify(onDisk.js8));
  check("saving the beacon half actually changes it",
    onDisk.wspr && onDisk.wspr.powerDbm === 10);
  check("a save never puts the per-machine values on the station",
    onDisk.wspr && onDisk.wspr.clockCorrection === undefined
    && onDisk.js8 && onDisk.js8.modems.js8call.clockCorrectionMs === undefined);

  // ---- source contract -----------------------------------------------------
  const sketch = fs.readFileSync(path.join(ROOT, "wifilt.ino"), "utf8");
  const data = fs.readFileSync(path.join(ROOT, "data", "data.js"), "utf8");
  const wsprJs = fs.readFileSync(path.join(ROOT, "data", "wspr.js"), "utf8");
  const dataHtml = fs.readFileSync(path.join(ROOT, "data", "data.html"), "utf8");

  check("the firmware serves the profile", /webServer\.on\("\/js8-config\.json", HTTP_GET/.test(sketch)
    && /webServer\.on\("\/js8-config\.json", HTTP_POST/.test(sketch));
  check("the profile lives on the configuration partition",
    /cfgFS\.open\(JS8_CONFIG_PATH/.test(sketch) && !/LittleFS\.open\(JS8_CONFIG_PATH/.test(sketch));
  // "Never written" is a state the promote path looks for, not a fault.
  check("a station with no profile answers an empty document, not 404",
    /if \(!cfgFS\.exists\(JS8_CONFIG_PATH\)\)[\s\S]{0,220}"\{\}"/.test(sketch));
  check("an oversized profile is refused with its size", /JS8_CONFIG_MAX_BYTES/.test(sketch)
    && /\\"error\\":\\"too_big\\",\\"bytes\\":/.test(sketch));
  check("the profile is carried by the backup", /\\"js8Config\\":/.test(sketch));
  check("the restore writes the profile back", /extractJsonObject\(body, "js8Config"\)/.test(sketch));
  check("an oversized profile refuses the whole restore",
    /rejectOversize\("js8Config"/.test(sketch));

  check("DATA adopts the station profile at startup", /await adoptStationProfile\(\);/.test(data));
  check("DATA writes changes through, debounced",
    /StationProfile\.writer\("js8", 1500\)/.test(data));
  check("WSPR adopts the station profile", /adoptStationProfile\(\)\.then/.test(wsprJs));
  check("WSPR writes changes through, debounced",
    /StationProfile\.writer\("wspr", 1500\)/.test(wsprJs));
  check("the promote button exists and is hidden by default",
    /id="promoteSettings"/.test(dataHtml) && /id="promoteRow" hidden/.test(dataHtml));
  check("promoting refuses a station that already has a profile",
    /if\(!window\.StationProfile\.isEmpty\(station\)\)return false;/.test(data));
  check("the promote row is shown only when the station has nothing",
    /isEmpty\(station\)\)\{[\s\S]{0,120}promoteRow\)dom\.promoteRow\.hidden=false/.test(data));

  // The cap has to hold a full profile, or the first operator with a complete
  // band schedule silently stops being able to save one.
  const full = {v: 1, js8: Profile.forStation(Object.assign({}, js8, {
    freqTimetable: {enabled: true, slots: Object.fromEntries(
      Array.from({length: 48}, (_, i) => [i, {hz: 14097100, band: "20m"}]))}
  }), null).js8, wspr: wspr};
  const fullBytes = JSON.stringify(full).length;
  const capMatch = sketch.match(/JS8_CONFIG_MAX_BYTES\s*=\s*(\d+)/);
  const cap = capMatch ? Number(capMatch[1]) : 0;
  check("a full 48-slot schedule fits the cap", fullBytes < cap,
    fullBytes + " B vs " + cap + " B");

  if (failures.length) {
    console.error("STATION PROFILE FAIL (" + failures.length + " of " + checks + ")\n  "
      + failures.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log("STATION PROFILE PASS " + checks + " checks · full profile "
      + fullBytes + " B of " + cap + " B");
  }
}());
