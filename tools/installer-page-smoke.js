// The GitHub Pages firmware installer, checked as a page instead of as a string.
//
// This page is the first screen of the whole first-run road, and it is the only
// one that exists before the device does -- so it is also the only place where a
// wrong sentence cannot be corrected by the device later. It used to claim that
// flashing destroys "contest logs", which live in the browser and cannot be
// touched by a flash, while saying nothing about the calibrations it really does
// destroy. Both halves of that are now asserted here.
//
// It runs against build/gh-pages/index.html -- the artifact that actually gets
// published -- and not against the heredoc in tools/gh-pages.sh, so "edited the
// generator but forgot to regenerate" is caught too, via the REV check.
//
// unpkg.com is pointed at localhost so the esp-web-tools module fails fast: the
// gate logic under test is a plain script and must not depend on it.

const fs = require("fs"), http = require("http"), path = require("path"), {spawn} = require("child_process");

const ROOT = path.join(__dirname, "..");
const PAGE = path.join(ROOT, "build", "gh-pages", "index.html");
const QR   = path.join(ROOT, "build", "gh-pages", "qrcode.min.js");

let chrome, finished = false, timer;

function finish(ok, text) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  (ok ? console.log : console.error)(text);
  if (!ok) process.exitCode = 1;
}

if (!fs.existsSync(PAGE)) {
  console.error("INSTALLER PAGE FAIL " + PAGE + " missing - run: bash tools/gh-pages.sh");
  process.exit(1);
}

const html = fs.readFileSync(PAGE, "utf8");
const sketch = fs.readFileSync(path.join(ROOT, "wifilt.ino"), "utf8");
const rev = (sketch.match(/#define REV\s+(\d+)/) || [])[1];

// ---- source-level contract -------------------------------------------------
// Things that must be on the page, and things that must never come back.
const mustHave = [
  ["current REV (page regenerated after the last release bump)", rev && html.includes(rev)],
  ["AP password", html.includes("remoteqth")],
  ["AP join QR payload", html.includes("WIFI:S:WIFILT-AP")],
  ["QR encoder served locally", html.includes("qrcode.min.js") && fs.existsSync(QR)],
  // The erase checkbox is the whole story now: it, and not the release, decides
  // whether the configuration survives. The page must quote the screen the
  // operator is about to see, say which way to answer, and say what the other
  // way costs -- otherwise it is back to guessing on their behalf.
  ["quotes the erase prompt verbatim", html.includes("Do you want to erase the device before installing WIFILT?")],
  ["says to leave the erase box unticked", /do not tick/i.test(html) && /unticked/i.test(html)],
  ["says an erase takes the whole chip", /whole chip/i.test(html) && /WiFi credentials/i.test(html)],
  ["names the calibrations among what is kept", /TX audio gain calibration/i.test(html)],
  ["says the QSO log is untouched", /QSO log/i.test(html) && /stored in your browser/i.test(html)],
  ["warns the pre-cfg releases lose config either way", /older than 20260808/.test(html)],
  ["says an update needs no AP-mode hunt", /rejoins your network on its own/i.test(html)],
  ["explains why the page cannot fetch the backup", /HTTPS/.test(html) && /HTTP/.test(html)],
  ["offers restoring the backup after flashing", /Upload config/i.test(html)],
  ["shows the road map", /road-now/.test(html) && /Transmit check/.test(html)],
  ["true flash layout", html.includes("1.375 MB application")],
  // The three folds. The ESP32 one is the page's whole reason to exist, so it
  // is required unconditionally; Linux and Windows are asserted further down
  // only when the build that produced this page actually carried their archive.
  ["the ESP32 fold", /<details class="platform" id="esp32">/.test(html)],
  // What the board can do that a PC cannot is the criterion the reader uses to
  // pick a fold, so it has to survive above them.
  ["names what only the board can do", /CI-V serial/.test(html)
    && /FSK\/RTTY keying/.test(html) && /band decoder/.test(html)],
  // Lifted out of the ESP32 fold: whoever opens only "Linux PC" must still meet
  // the step that decides whether any of it works.
  ["the radio step stands outside the folds", /id="radio-title"/.test(html)
    && /Test &amp; identify radio/.test(html)],
  ["the device link opens in its own tab", /href="http:\/\/wifilt\.local" target="_blank"/.test(html)],
];
const mustNotHave = [
  ["the false claim that flashing destroys contest logs", /contest logs/i.test(html)],
  ["the stale 2 MB application figure", /2 MB application/.test(html)],
  ["the router-DHCP hunt as the primary way to find the device", /^\s*<li>Find the interface's new IP address/m.test(html)],
  // The switch is gone and must not creep back: it made the page tell every
  // operator one story about a fate that is actually theirs to choose.
  ["the per-release config-fate wording", /last<\/strong> flash that loses it|Every flash replaces the filesystem/.test(html)],
  ["the backup acknowledgement gate", /backupDone/.test(html)],
  // There is no USB path to a radio anywhere in this project: the board reaches
  // radios over ICOM-LAN, over the CI-V serial bus or over TrxNet. The sentence
  // this guards told operators to buy hardware for a connection that does not
  // exist.
  ["the invented USB connection to the radio", /radio connected only by/i.test(html)],
  // A fold that ships open is the long page coming back one section at a time.
  ["a platform fold that starts open", /<details class="platform"[^>]*\sopen/.test(html)],
  // name= makes the folds exclusive, which closes Linux when Windows is opened.
  ["the exclusive-accordion attribute", /<details[^>]*name="platform"/.test(html)],
  ["step 0 calling itself a flash again", /road-n">0<\/span> Flash/.test(html)],
];

const sourceFailures = [];
for (const [label, ok] of mustHave) if (!ok) sourceFailures.push("missing: " + label);
for (const [label, bad] of mustNotHave) if (bad) sourceFailures.push("present again: " + label);

// ---- the driver injected into the real page --------------------------------
const DRIVER = `
<script>
(function () {
  var checks = [], errors = [];
  window.addEventListener("error", function (e) {
    // The esp-web-tools module is deliberately unreachable here; anything else
    // is a real script error on a page whose gate must work on a cold machine.
    var src = (e && e.filename) || "";
    if (src.indexOf("unpkg.com") < 0) errors.push(String(e.message || e.type) + " @ " + src);
  }, true);

  function el(id) { return document.getElementById(id); }
  function locked() { return el("flashGate").getAttribute("data-locked"); }
  function is(name, cond) { checks.push({ name: name, ok: !!cond }); }

  function state(label, expectLocked, expectPanel, expectRestore) {
    is(label + ": flash button " + (expectLocked ? "locked" : "unlocked"), locked() === (expectLocked ? "1" : "0"));
    is(label + ": backup panel " + (expectPanel ? "shown" : "hidden"), el("backupPanel").hidden === !expectPanel);
    is(label + ": restore step " + (expectRestore ? "shown" : "hidden"), el("restoreStep").hidden === !expectRestore);
    is(label + ": serial hints follow the gate", el("flashHints").hidden === expectLocked);
    is(label + ": gate note follows the gate", el("gateNote").hidden === !expectLocked);
  }

  // -- the three platform folds ---------------------------------------------
  // The page used to lay all three roads end to end, so everyone scrolled past
  // two that were not theirs. Folding it only helps if the folds start closed
  // and stay independent: an exclusive accordion would close Linux the moment
  // someone opened Windows to compare them.
  //
  // Which desktop folds exist is read off the page rather than assumed. A build
  // made without "make -C native dist" carries no archive and therefore no fold,
  // and that is not this test's business to call a failure.
  var folds = ["esp32", "linux", "windows"].filter(function (id) { return !!el(id); });
  is("the ESP32 fold is on the page", folds.indexOf("esp32") >= 0);
  folds.forEach(function (id) { is(id + ": collapsed on load", el(id).open === false); });

  // Opened the way an operator opens them, not by setting .open -- the exclusive
  // behaviour this guards against is a property of the click path.
  folds.forEach(function (id) { el(id).querySelector("summary").click(); });
  folds.forEach(function (id) { is(id + ": still open after the others were opened", el(id).open === true); });

  // Everything below is the flash gate, and an operator only ever reaches it
  // through an open ESP32 fold -- so that is where it gets tested.
  folds.forEach(function (id) { if (id !== "esp32") el(id).querySelector("summary").click(); });
  is("the ESP32 fold is open for the gate checks", el("esp32").open === true);

  // The one step that is the same on all three platforms, and the only one a
  // reader who opens a single fold would otherwise never see.
  var deviceLink = document.querySelector('a[href="http://wifilt.local"]');
  is("the device link sits outside every fold", !!deviceLink && !deviceLink.closest("details"));
  is("the device link opens in its own tab", !!deviceLink && deviceLink.target === "_blank");

  // A cold page must never let anyone flash before answering the one question
  // it cannot answer for itself.
  state("cold", true, false, false);

  el("choiceNew").click();
  state("new device", false, false, false);
  is("new device: choice is marked pressed", el("choiceNew").getAttribute("aria-pressed") === "true");

  // Upgrading no longer locks anything. A flash that keeps the configuration has
  // nothing to demand an acknowledgement for, and a warning gate that fires when
  // nothing is at stake is how operators learn to click past the ones that matter.
  el("choiceUpgrade").click();
  state("upgrade", false, true, true);
  is("upgrade: previous choice is released", el("choiceNew").getAttribute("aria-pressed") === "false");
  is("upgrade: no acknowledgement checkbox survives", !el("backupDone"));

  // Switching back and forth must keep the panel in step with the choice.
  el("choiceNew").click();
  state("back to new device", false, false, false);

  var qr = el("apQr");
  is("AP join QR was rendered", !!(qr && qr.children.length > 0));
  is("no unexpected script errors", errors.length === 0);

  fetch("/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checks: checks, errors: errors })
  });
}());
</script>
`;

const served = html.replace("</body>", DRIVER + "</body>");

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      res.writeHead(204); res.end();
      let data;
      try { data = JSON.parse(body); } catch (e) { return finish(false, "INSTALLER PAGE FAIL bad result payload"); }
      const failed = data.checks.filter(c => !c.ok).map(c => c.name);
      const all = failed.concat(sourceFailures);
      const summary = data.checks.length + " page checks, " + mustHave.length + " content checks, "
        + mustNotHave.length + " regression guards";
      if (all.length) return finish(false, "INSTALLER PAGE FAIL (" + summary + ")\n  " + all.join("\n  "));
      finish(true, "INSTALLER PAGE PASS " + summary + " rev=" + rev);
    });
    return;
  }
  if (req.url.startsWith("/qrcode.min.js")) {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    return res.end(fs.readFileSync(QR));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(served);
});

server.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port + "/";
  chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--no-proxy-server",
    "--host-resolver-rules=MAP unpkg.com 127.0.0.1:1", url]);
  let errors = "";
  chrome.stderr.on("data", c => errors += c);
  chrome.on("close", code => {
    if (!finished) finish(false, "INSTALLER PAGE FAIL Chrome exited " + code + "\n" + errors);
  });
  timer = setTimeout(() => finish(false, "INSTALLER PAGE FAIL timeout"), 30000);
});
