// Two filesystems, and nothing may cross between them.
//
// The interface keeps the operator's configuration on its own flash partition
// (`cfg`) and the web assets on another (`spiffs`), because every flash replaces
// the assets and none of them may take the calibrations with it. That split only
// holds while every single call goes to the right mount, and getting it wrong
// does not fail loudly: a config file opened on the asset filesystem simply
// disappears at the next firmware update, months later, with no error anywhere.
//
// A name-based check is not enough on its own. The first bug this caught was
// handleMsgboxGet(), which picked MSGBOX_PATH or MSGBOX_LEGACY_PATH into a local
// `const char* path` and then opened it on `LittleFS` -- the constant was
// nowhere near the call. So the audit works on whole functions: any function
// that mentions a config path may not touch `LittleFS` at all.

const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const sketch = fs.readFileSync(path.join(ROOT, "wifilt.ino"), "utf8");
const csv = fs.readFileSync(path.join(ROOT, "partitions.csv"), "utf8");

const failures = [];
function check(name, ok) { if (!ok) failures.push(name); }

// Every path constant that names a file of the operator's, not of the build's.
const CONFIG_PATHS = ["RADIO_CONFIG_PATH", "LOG_CONFIG_PATH", "TXGAIN_CONFIG_PATH",
  "BD_CONFIG_PATH", "MEMORY_CONFIG_PATH", "MSGBOX_PATH", "MSGBOX_LEGACY_PATH",
  "UNATTENDED_LOG_PATH"];

// ---- the partition table ---------------------------------------------------
function partition(name) {
  const row = csv.split("\n").find(line => line.trim().startsWith(name + ","));
  if (!row) return null;
  const parts = row.split(",").map(s => s.trim());
  return {offset: parseInt(parts[3], 16), size: parseInt(parts[4], 16)};
}
const cfg = partition("cfg"), assets = partition("spiffs"), app = partition("app0");
check("partitions.csv declares a cfg partition", !!cfg);
check("partitions.csv still declares the asset partition under the name spiffs", !!assets);
if (cfg && assets && app) {
  check("cfg does not overlap the application", cfg.offset >= app.offset + app.size);
  check("the asset partition starts where cfg ends", assets.offset === cfg.offset + cfg.size);
  // Written at an offset, sized to the partition: an inconsistency here is not
  // an error at build time, it is a bundle that runs off the end of the chip.
  check("both partitions fit a 4 MB flash exactly",
    assets.offset + assets.size === 4 * 1024 * 1024);
}

// ---- the mounts ------------------------------------------------------------
check("the sketch declares a second filesystem instance",
  /fs::LittleFSFS cfgFS;/.test(sketch));
check("cfg is mounted by label, and formats itself on a brand new device",
  /cfgFS\.begin\(true,\s*"\/cfg",\s*\d+,\s*"cfg"\)/.test(sketch));
// A device that cannot serve its own setup page is worse than one that has
// forgotten its calibrations, so a failed cfg mount must not stop the assets.
check("a failed cfg mount does not abort the boot",
  /configuration partition mount failed/.test(sketch)
  && sketch.indexOf("cfgFS.begin") < sketch.indexOf("LittleFS.begin"));

// ---- no crossing -----------------------------------------------------------
// Split on function starts: crude, but the sketch is one flat translation unit
// and every definition begins in column zero.
const functions = [];
const lines = sketch.split("\n");
let current = null;
for (let i = 0; i < lines.length; i++) {
  if (/^[A-Za-z_][A-Za-z0-9_:<>*& ]*\s[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(lines[i])) {
    if (current) functions.push(current);
    current = {name: lines[i].trim().slice(0, 60), start: i + 1, body: ""};
  }
  if (current) current.body += lines[i] + "\n";
}
if (current) functions.push(current);

const crossings = [];
for (const fn of functions) {
  const mentionsConfig = CONFIG_PATHS.some(name => fn.body.includes(name));
  if (!mentionsConfig) continue;
  const usesAssets = /\bLittleFS\.(open|exists|remove|rename|mkdir)\s*\(/.test(fn.body);
  if (usesAssets) crossings.push(fn.name + " (line " + fn.start + ")");
}
check("no function touches a config path and the asset filesystem"
  + (crossings.length ? ": " + crossings.join(", ") : ""), crossings.length === 0);

// And the reverse: the asset server must never be pointed at cfgFS, or a
// firmware update would stop replacing the pages it ships.
const server = functions.find(fn => /handleFileFromSPIFFS/.test(fn.name));
check("the asset server reads from the asset filesystem",
  !!server && !/cfgFS\./.test(server.body) && /LittleFS\.(open|exists)/.test(server.body));

// ---- the tools -------------------------------------------------------------
const ghPages = fs.readFileSync(path.join(ROOT, "tools", "gh-pages.sh"), "utf8");
check("the release script derives the asset offset instead of repeating it",
  /SPIFFS_OFFSET="\$\(partition_field spiffs 4\)"/.test(ghPages)
  && !/^SPIFFS_OFFSET=0x/m.test(ghPages));
check("the release script refuses a bundle that runs off the chip",
  /runs past the end of a/.test(ghPages));
check("the release script never puts cfg in the bundle",
  !/\$\{?CFG_OFFSET\}?"?\s+"\$/.test(ghPages) && /deliberately NOT flashed/.test(ghPages));

for (const script of ["upload-firmware-spiffs.sh", "upload-spiffs.sh"]) {
  const text = fs.readFileSync(path.join(ROOT, "tools", script), "utf8");
  check(script + " reads the layout from partitions.csv",
    /partitions\.csv/.test(text) && !/0x170000["\s]*$/m.test(text));
  check(script + " writes the asset partition, never cfg", !/\bcfg\b.*write_flash/.test(text));
}

const total = 18;
if (failures.length) {
  console.error("FS PARTITION AUDIT FAIL (" + failures.length + " of " + total + ")\n  "
    + failures.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("FS PARTITION AUDIT PASS " + total + " checks · cfg "
    + (cfg.size / 1024) + " kB at 0x" + cfg.offset.toString(16)
    + " · assets " + (assets.size / 1024) + " kB at 0x" + assets.offset.toString(16));
}
