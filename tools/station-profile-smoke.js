// How the station operates belongs to the station.
//
// The JS8 and WSPR settings lived in each browser's localStorage, so a tablet
// that arrived on the third day ran the same station with the heartbeat off, no
// groups and an empty band schedule -- silently, because nothing compared them.
// Moving them into the interface is only safe if three things hold, and each of
// them fails quietly rather than loudly, so each is pinned here:
//
//   * the per-machine values never travel (one computer's clock correction
//     must not reach another's transmit timing)
//   * a save of one half never erases another (the pages are open at once)
//   * an interface that already has a profile is never overwritten by a browser
//
// Since 2026-10-07 the document has four halves -- JS8, WSPR, RTTY and the
// Mercury schedule -- and every page rewrites the whole file, so every half has
// to survive every other page's save.

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
const RttySettings = require(path.join(ROOT, "data", "rtty-settings.js"));
const MercurySettings = require(path.join(ROOT, "data", "mercury-settings.js"));
const rtty = Object.assign(RttySettings.defaults(), {toneHz: 1785, rfPercent: 40,
  txPolarity: "reverse", squelchDb: 9});
const mercury = MercurySettings.normalize({freqTimetable: {enabled: true,
  slots: {4: {hz: 14105000, band: "20m"}}}});

// ---- what travels and what stays -------------------------------------------
const stored = Profile.forStation({js8, wspr, rtty, mercury});
check("the stored document carries both profiles", !!stored.js8 && !!stored.wspr);
check("the stored document carries RTTY and the Mercury schedule",
  !!stored.rtty && !!stored.mercury);
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
check("the RTTY power travels", stored.rtty.rfPercent === 40);
check("the RTTY TX polarity travels -- it is what the station puts on the air",
  stored.rtty.txPolarity === "reverse");
check("the RTTY squelch travels", stored.rtty.squelchDb === 9);
// Every click on a signal moves it: on the station it would rewrite the file
// after nearly every contact.
check("where the RTTY decoder is listening does not travel", stored.rtty.toneHz === undefined);
check("the Mercury schedule travels", stored.mercury.freqTimetable.slots[4].hz === 14105000);
// Stripping must not mutate the caller's own settings object.
check("stripping does not damage the page's own settings",
  js8.modems.js8call.clockCorrectionMs === 37 && wspr.clockCorrection === -11
  && rtty.toneHz === 1785);

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
const backRtty = Profile.forBrowser(stored, "rtty", Object.assign({}, rtty, {toneHz: 2210}));
check("RTTY takes the station's power", backRtty.rfPercent === 40);
check("RTTY keeps the tone this browser is listening on", backRtty.toneHz === 2210);
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
check("a document with only RTTY is not empty", !Profile.isEmpty({v: 1, rtty: {}}));
check("a document with only the Mercury schedule is not empty",
  !Profile.isEmpty({v: 1, mercury: {}}));
check("nothing comes back out of an empty station",
  Profile.forBrowser({}, "js8", js8) === null);
check("nothing comes back for a half that is not there",
  Profile.forBrowser({v: 1, js8: js8}, "wspr", wspr) === null);

// ---- one half never erases the other ---------------------------------------
// Both pages are open at once often enough that this is not theoretical: the
// file is replaced whole, so a JS8 save has to re-read before it writes.
(async function () {
  let onDisk = Profile.forStation({js8, wspr, rtty, mercury});
  let posts = 0, answering = true;
  global.fetch = function (url, options) {
    if (!answering) return Promise.reject(new Error("offline"));
    if (!options || options.method !== "POST")
      return Promise.resolve({ok: true, json: () => Promise.resolve(onDisk)});
    posts++;
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

  // The failure that made HALVES necessary: write() used to rebuild the file
  // from js8 and wspr alone, so any JS8 or WSPR save erased the two new halves.
  for (const which of Profile.HALVES) {
    const before = JSON.parse(JSON.stringify(onDisk));
    await Profile.write(which, Object.assign({}, onDisk[which], {marker: which}));
    const others = Profile.HALVES.filter(h => h !== which);
    const lost = others.filter(h => JSON.stringify(onDisk[h]) !== JSON.stringify(before[h]));
    check("saving the " + which + " half keeps every other half", lost.length === 0, lost.join(", "));
    check("saving the " + which + " half changes it", onDisk[which].marker === which);
  }

  // ---- a half that joined the station later --------------------------------
  // RTTY and Mercury kept their settings in localStorage first. The station's
  // copy wins; with none yet, only a copy actually saved here may become it.
  onDisk = Profile.forStation({js8, wspr, rtty});
  let adopted = await Profile.adoptHalf("rtty", Object.assign({}, rtty, {rfPercent: 5, toneHz: 900}), true);
  check("a station that has the half overrules this browser", adopted && adopted.rfPercent === 40);
  check("adopting keeps this browser's tone", adopted && adopted.toneHz === 900);
  posts = 0;
  adopted = await Profile.adoptHalf("mercury", mercury, false);
  check("a page's defaults never become the station's half",
    adopted === null && posts === 0 && !onDisk.mercury);
  adopted = await Profile.adoptHalf("mercury", mercury, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  check("a schedule saved in this browser becomes the station's when it has none",
    adopted === null && posts === 1 && !!onDisk.mercury
    && onDisk.mercury.freqTimetable.slots[4].hz === 14105000);
  check("that migration keeps every other half", !!(onDisk.js8 && onDisk.wspr && onDisk.rtty));
  answering = false;
  posts = 0;
  adopted = await Profile.adoptHalf("rtty", rtty, true);
  check("a station that does not answer is left alone", adopted === null && posts === 0);
  answering = true;

  // ---- a save that changes nothing stored is not sent ----------------------
  // The RTTY tone is saved on every click and kept off the station, so a save
  // of only a new tone must not rewrite the whole file.
  await Profile.adoptHalf("rtty", rtty, true);
  const push = Profile.writer("rtty", 1);
  posts = 0;
  push(Object.assign({}, onDisk.rtty, {toneHz: 1234}));
  await new Promise(resolve => setTimeout(resolve, 20));
  check("a save that moves only the tone is not sent", posts === 0);
  check("the page's own save is seen at once, before it is sent",
    !!Profile.seen() && Profile.seen().rtty.toneHz === 1234);
  push(Object.assign({}, onDisk.rtty, {rfPercent: 77}));
  await new Promise(resolve => setTimeout(resolve, 20));
  check("a save that changes a setting is sent", posts === 1 && onDisk.rtty.rfPercent === 77);
  push(Object.assign({}, onDisk.rtty, {toneHz: 1500}));
  await new Promise(resolve => setTimeout(resolve, 20));
  check("after that, the same setting is not sent again", posts === 1);

  // TxModePowers reads the station's halves through seen(), not this browser.
  global.StationProfile = Profile;
  const Powers = require(path.join(ROOT, "data", "tx-mode-powers.js"));
  const modes = Powers.read({storage: {getItem: () => null}});
  check("the mode powers come from the station, not from this browser's storage",
    modes.some(m => m.mode === "RTTY" && m.percent === 77)
    && modes.some(m => m.mode === "JS8" && m.percent === 14), JSON.stringify(modes));
  delete global.StationProfile;

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
  check("the profile is carried by the backup",
    /configDownloadBlob\("js8Config", JS8_CONFIG_PATH\)/.test(sketch));
  check("the restore writes the profile back", /extractJsonObject\(body, "js8Config"\)/.test(sketch));
  check("an oversized profile refuses the whole restore",
    /rejectOversize\("js8Config"/.test(sketch));

  check("DATA adopts the station profile at startup", /await adoptStationProfile\(\);/.test(data));
  check("DATA writes changes through, debounced",
    /StationProfile\.writer\("js8", 1500\)/.test(data));
  check("WSPR adopts the station profile", /adoptStationProfile\(\)\.then/.test(wsprJs));
  check("WSPR writes changes through, debounced",
    /StationProfile\.writer\("wspr", 1500\)/.test(wsprJs));
  const rttyJs = fs.readFileSync(path.join(ROOT, "data", "rtty.js"), "utf8");
  const panelJs = fs.readFileSync(path.join(ROOT, "data", "log-rtty-panel.js"), "utf8");
  const mercuryJs = fs.readFileSync(path.join(ROOT, "data", "mercury.js"), "utf8");
  const rttyStore = fs.readFileSync(path.join(ROOT, "data", "rtty-settings.js"), "utf8");
  const mercuryStore = fs.readFileSync(path.join(ROOT, "data", "mercury-settings.js"), "utf8");
  const setupHtml = fs.readFileSync(path.join(ROOT, "data", "setup.html"), "utf8");
  check("RTTY adopts the station's half before it draws its panel",
    /Promise\.all\(\[LanGate\.gate\(\), adoptStationSettings\(\)\]\)/.test(rttyJs)
    && /StationProfile\.adoptHalf\("rtty"/.test(rttyJs));
  check("the QRPlog RTTY palette adopts it too", /StationProfile\.adoptHalf\('rtty'/.test(panelJs));
  check("Mercury adopts the station's schedule", /StationProfile\.adoptHalf\("mercury"/.test(mercuryJs));
  check("every RTTY save goes to the station unless it is the adoption itself",
    /if \(!\(options && options\.localOnly\)\) pushToStation\(settings\)/.test(rttyStore)
    && /profile\.writer\("rtty", 1500\)/.test(rttyStore));
  check("every Mercury save goes to the station unless it is the adoption itself",
    /if \(!\(options && options\.localOnly\)\) pushToStation\(settings\)/.test(mercuryStore)
    && /profile\.writer\("mercury", 1500\)/.test(mercuryStore));
  check("adopting never sends the station's copy back",
    (rttyJs.match(/\{localOnly: true\}/g) || []).length === 1
    && (panelJs.match(/\{localOnly: true\}/g) || []).length === 1
    && (mercuryJs.match(/\{localOnly: true\}/g) || []).length === 1);
  for (const page of ["rtty.html", "log.html", "mercury.html", "setup.html", "data.html", "wspr.html"]) {
    const html = fs.readFileSync(path.join(ROOT, "data", page), "utf8");
    check(page + " loads station-profile.js", /<script src="\/station-profile\.js\?v=/.test(html));
  }
  check("the restore sends the station profile on its own, first",
    /fetch\("\/js8-config\.json", \{[\s\S]{0,200}body: JSON\.stringify\(profile\)/.test(setupHtml)
    && /delete rest\.js8Config;/.test(setupHtml)
    && /profileSent\.then\(function \(\) \{\s*return fetch\("\/config\/upload"/.test(setupHtml));
  check("the promote button exists and is hidden by default",
    /id="promoteSettings"/.test(dataHtml) && /id="promoteRow" hidden/.test(dataHtml));
  check("promoting refuses a station that already has a profile",
    /if\(!window\.StationProfile\.isEmpty\(station\)\)return false;/.test(data));
  check("the promote row is shown only when the station has nothing",
    /isEmpty\(station\)\)\{[\s\S]{0,120}promoteRow\)dom\.promoteRow\.hidden=false/.test(data));

  // The cap has to hold a full profile, or the first operator with a complete
  // configuration silently stops being able to save one. Built at the limits of
  // the pages' own normalizers, not from a typical profile: six TELEMETRY jobs
  // of eight fields with full-length names, every group, every schedule slot.
  const Js8Settings = require(path.join(ROOT, "data", "js8-settings.js"));
  const big = Js8Settings.defaults();
  const call = big.modems.js8call;
  call.groups = Array.from({length: Js8Settings.MAX_GROUPS}, (_, i) => "@GROUPX" + i);
  call.telemetry = {enabled: true, jobs: Array.from({length: 6}, (_, j) => ({
    id: "telemetryjob" + j, name: "TLMXX" + j, enabled: true, to: "@GROUPX1/ABC",
    periodMin: 1440, fields: Array.from({length: 8}, (_, k) => ({
      peer: "p".repeat(32), topic: "t".repeat(32), label: "LABEL00" + k,
      unit: "VOLT", type: "uint16", div: 1000, dec: 3}))}))};
  big.freqTimetable = {enabled: true, slots: Object.fromEntries(
    Array.from({length: 48}, (_, i) => [i, {hz: 144174000 + i, band: "2m"}]))};
  const fullJs8 = Js8Settings.normalize(big);
  check("the worst-case JS8 half really is at its limits",
    fullJs8.modems.js8call.telemetry.jobs.length === 6
    && fullJs8.modems.js8call.telemetry.jobs[0].fields.length === 8
    && Object.keys(fullJs8.freqTimetable.slots).length === 48);
  // WSPR at its limits: every half hour filled with its fifteen two-minute
  // frames, half of them RX items (those may repeat), and a power reference for
  // every band at every level the page offers -- referenceKey() is band|dBm.
  // A 10 W radio is offered the most levels (seven, 20-40 dBm).
  const WsprCore = require(path.join(ROOT, "data", "wspr-core.js"));
  const BANDS = WsprCore.PRESETS.map(preset => preset.band);
  const refs = {};
  for (const band of BANDS) for (const dbm of WsprCore.offeredPowerLevels(10, 10))
    refs[band + "|" + dbm] = {raw: 1234, dbm, at: 1791385846094, band};
  const fullWspr = {version: 9, powerDbm: 37, modelOverride: "IC-705",
    powerReferences: refs,
    timetable: Array.from({length: WsprCore.SLOTS_PER_DAY}, (_, slot) => ({slot,
      bands: Array.from({length: WsprCore.FRAMES_PER_SLOT},
        (_, i) => BANDS[i % BANDS.length] + (i % 2 ? " RX" : ""))})),
    rx: {enabled: true, upload: true, subtract: true, deep: true, wide: true, osd: true, quick: true}};
  const fullRtty = Object.assign(RttySettings.defaults(), {rfPercent: 100, squelchDb: 12});
  const fullMercury = MercurySettings.normalize({freqTimetable: {enabled: true,
    slots: Object.fromEntries(Array.from({length: 48}, (_, i) => [i, {hz: 144174000 + i, band: "2m"}]))}});
  const full = Profile.forStation({js8: fullJs8, wspr: fullWspr, rtty: fullRtty, mercury: fullMercury});
  const fullBytes = JSON.stringify(full).length;
  const capMatch = sketch.match(/JS8_CONFIG_MAX_BYTES\s*=\s*(\d+)/);
  const cap = capMatch ? Number(capMatch[1]) : 0;
  check("a profile at every page's limits fits the cap", fullBytes < cap,
    fullBytes + " B vs " + cap + " B");
  check("and leaves room for the next field someone adds", fullBytes < cap * 0.85,
    fullBytes + " B is over 85 % of " + cap + " B");

  if (failures.length) {
    console.error("STATION PROFILE FAIL (" + failures.length + " of " + checks + ")\n  "
      + failures.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log("STATION PROFILE PASS " + checks + " checks · full profile "
      + fullBytes + " B of " + cap + " B");
  }
}());
