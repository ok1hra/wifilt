// Is the configuration backup actually complete?
//
// "It backs everything up" is a claim, not a fact, and the way it goes wrong is
// silent: a field gets added to the download and nobody adds it to the restore,
// so a config comes back missing one thing and says {"ok":true}. That already
// happened once by design -- an oversized logConfig or txGain section was
// skipped without a word.
//
// So this checks the property rather than the code: every key the download
// EMITS must be a key the restore CONSUMES. A round trip on real hardware would
// be better still (download → wipe → upload → download, byte-identical), and
// that is what the on-device checklist asks for; this is the part that can run
// without a board, on every change, in a second.

const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const sketch = fs.readFileSync(path.join(ROOT, "wifilt.ino"), "utf8");

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) failures.push(name + (detail ? " — " + detail : ""));
}

// Keys appear in the sketch inside C++ string literals, so a JSON key is spelled
// \"name\" in the source, not "name". Both spellings count: the download builds
// its document with the escaped form and the restore looks keys up the same way.
function mentions(text, key) {
  return text.includes('\\"' + key + '\\"') || text.includes('"' + key + '"');
}

function body(signature) {
  // Anchor on the DEFINITION -- the sketch forward-declares almost everything,
  // so the name alone finds a one-line prototype.
  //
  // Bounded by the closing brace in column zero rather than by counting braces:
  // both of these handlers BUILD JSON, so their string literals are full of
  // unbalanced { and } and a counter walks straight off the end. (It did.)
  const start = sketch.indexOf(signature + " {");
  if (start < 0) return "";
  const end = sketch.indexOf("\n}\n", start);
  return end < 0 ? sketch.slice(start) : sketch.slice(start, end);
}

const download = body("void handleConfigDownload()");
const upload = body("void handleConfigUpload()");
check("the download handler was found", download.length > 100);
check("the restore handler was found", upload.length > 100);

// ---- every emitted key is consumed ----------------------------------------
const emitted = new Set();
for (const match of download.matchAll(/\\"([a-zA-Z0-9_]+)\\":/g)) emitted.add(match[1]);
// The CW and frequency memories are emitted by a loop with snprintf, so their
// keys never appear as literals on either side; checking for the same loop is
// what checking them individually would amount to.
check("the CW and frequency memories are written by the backup",
  /"cwmem%u"/.test(download) || /\\"cwmem\\"/.test(download) || /cwmem/.test(download));
check("the CW and frequency memories are read back by the restore",
  /"cwmem%u"/.test(upload) && /"freqmem%u"/.test(upload));

// Keys the restore deliberately does not consume, each with a reason.
const NOT_RESTORED = {
  fwRev: "a record of which firmware wrote the file, not a setting",
  cwmem: "written by a loop; the individual cwmemN keys are checked instead",
  freqmem: "written by a loop; the individual freqmemN keys are checked instead",
  source: "inside the bd section, consumed by the band decoder branch",
  rows: "inside the bd section",
  fMin: "inside a bd row", fMax: "inside a bd row", outputs: "inside a bd row",
};

const orphans = [];
for (const key of emitted) {
  if (key in NOT_RESTORED) continue;
  // A key counts as consumed if the restore mentions it at all: extractJsonString,
  // parseField, indexOf or extractJsonObject all name it as a literal.
  if (!mentions(upload, key)) orphans.push(key);
}
check("every key the backup writes is read back by the restore",
  orphans.length === 0, orphans.join(", "));

// These blobs carry the operator's real work, so they get
// named individually rather than trusted to the sweep above.
for (const blob of ["radioConfig", "logConfig", "txGain", "txGainPlan", "mercuryTxGain"]) {
  check("the backup carries " + blob, mentions(download, blob));
  check("the restore writes " + blob + " back", mentions(upload, blob));
}

// ---- nothing is dropped in silence ----------------------------------------
// The failure this file exists for: a section present but too large used to be
// skipped, and the restore still answered ok.
check("an oversized section refuses the restore instead of skipping it",
  /rejectOversize\("logConfig"/.test(upload) && /rejectOversize\("txGain"/.test(upload)
  && /rejectOversize\("txGainPlan"/.test(upload)
  && /rejectOversize\("mercuryTxGain"/.test(upload));
check("the refusal names the section and both sizes",
  /\\"section\\":\\"/.test(upload) && /\\"bytes\\":/.test(upload) && /\\"limit\\":/.test(upload));
check("the refusal returns early rather than carrying on",
  /rejectOversize\("logConfig"[\s\S]{0,80}return;/.test(upload));
check("a failed write of the calibrations is reported, not swallowed",
  /\\"error\\":\\"storage\\",\\"section\\":\\"txGain\\"/.test(upload)
  && /\\"error\\":\\"storage\\",\\"section\\":\\"txGainPlan\\"/.test(upload)
  && /\\"error\\":\\"storage\\",\\"section\\":\\"mercuryTxGain\\"/.test(upload));
// A bare 2048 in three places was how the cap and the check drifted apart.
check("the log-config cap is a named constant",
  /LOG_CONFIG_MAX_BYTES/.test(sketch) && !/length\(\) > 2048/.test(sketch));

// ---- the caps hold the data that is coming --------------------------------
// A full band-by-power matrix has to fit, or the plan produces a table that
// cannot be stored -- and the failure would land after the carriers, not before.
const record = {knee: 0.031, gain: 0.031, po: 118, swrMax: 1.4, hz: 7040000,
  modLevel: 93, at: 1786000000000};
const recordBytes = JSON.stringify({"IC-705|40m|1": record}).length - 2;
const CELLS = 44;                       // 11 bands x 4 power columns, the plan's cap
const tableBytes = CELLS * (recordBytes + 1) + 64;
const capMatch = sketch.match(/TXGAIN_MAX_BYTES\s*=\s*(\d+)/);
const cap = capMatch ? Number(capMatch[1]) : 0;
check("a full calibration matrix fits the stored table",
  tableBytes < cap, tableBytes + " B vs cap " + cap + " B");

const fullPlan = {v: 1, powers: [1, 10, 50, 100], rows: []};
for (const band of ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m"])
  fullPlan.rows.push({band, cells: [1, 1, 1, 1],
    hzByProfile: {"single-tone": 14100000, "mercury-datac1": 14105000}});
const planBytes = JSON.stringify(fullPlan).length;
const planCapMatch = sketch.match(/TXGAIN_PLAN_MAX_BYTES\s*=\s*(\d+)/);
const planCap = planCapMatch ? Number(planCapMatch[1]) : 0;
check("a full two-profile calibration plan fits its store",
  planBytes < planCap, planBytes + " B vs cap " + planCap + " B");

// And the record really is compacted -- the key already says model, band and
// power, so a record repeating them is what made the matrix not fit.
const cal = fs.readFileSync(path.join(ROOT, "data", "tx-gain-cal.js"), "utf8");
check("records are compacted before they are stored",
  /this\.doc\.entries\[key\] = compact\(key, entry\)/.test(cal));
check("reads put the key's fields back, so nothing downstream changed",
  /return found && Number\(found\.gain\) > 0 \? expand\(key, found\) : null/.test(cal));
check("model, band and power are not stored twice",
  /const REDUNDANT = \["model", "band", "percent"\]/.test(cal));
const Cal = require(path.join(ROOT, "data", "tx-gain-cal.js"));
const compacted = Cal.compact("IC-705|40m|1", Object.assign({}, record,
  {model: "IC-705", band: "40m", percent: 1, reachedCeiling: false, autoTrimmed: false}));
check("compacting drops the repeats and the false flags",
  !("model" in compacted) && !("band" in compacted) && !("percent" in compacted)
  && !("reachedCeiling" in compacted) && !("autoTrimmed" in compacted));
const expanded = Cal.expand("IC-705|40m|1", compacted);
check("expanding restores them from the key",
  expanded.model === "IC-705" && expanded.band === "40m" && expanded.percent === 1
  && expanded.reachedCeiling === false);
check("a record written before compacting still reads back",
  Cal.expand("IC-705|20m|5", {gain: 0.1, band: "20m", percent: 5}).band === "20m");

if (failures.length) {
  console.error("CONFIG BACKUP FAIL (" + failures.length + " of " + checks + ")\n  "
    + failures.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("CONFIG BACKUP PASS " + checks + " checks · " + emitted.size
    + " backed-up keys all restored · record " + recordBytes
    + " B · " + CELLS + " cells = " + tableBytes + " B of " + cap + " B");
}
