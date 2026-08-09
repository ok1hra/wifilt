// The setup spine: derived state first, rendering second.
//
// The whole point of the spine is that NOTHING about it is stored -- every step
// works out its own state from a fact the device already keeps. So the valuable
// test is not "does it draw" but "given this device, does it say the right thing
// about it", and that part runs in plain Node against the module's own exports.
//
// Three passes:
//   A  derivation, one scenario per row, no browser
//   B  source contract -- the page mounts it, the sections it links to exist,
//      and the firmware agrees with the browser about what "set up" means
//   C  the real setup.html in headless Chrome, to catch DOM mistakes and to
//      prove the spine survives a page whose other endpoints are missing
//
// Pass B matters more than it looks: radioSlotSetUp() in the sketch and
// slotSetUp() here decide the same question -- one routes the bare IP, the other
// draws the tick -- and if they ever disagree the operator gets a green step on
// a page they were redirected to for being incomplete.

const fs = require("fs"), http = require("http"), path = require("path"), {spawn} = require("child_process");

const ROOT = path.join(__dirname, "..");
const Spine = require(path.join(ROOT, "data", "setup-spine.js"));

let failures = [];
function check(name, ok) { if (!ok) failures.push(name); }

// ---------------------------------------------------------------- pass A ----
// A device is described the way /setup-data.json describes it.
function device(over) {
  return Object.assign({
    apMode: false, ssid: "Domov", dxccall: "", dxclocator: "",
    trx1enabled: true, trx1label: "TRX1", trx1transport: "lan",
    trx1lanip: "", trx1lanuser: "", trx1lanpass: "", trx1civaddr: "A4",
    trx1netid: "00", trx1model: "",
    trx2enabled: false, trx2transport: "trxnet", trx2netid: "00", trx2civaddr: "00", trx2model: "",
    trx3enabled: false, trx3transport: "trxnet", trx3netid: "00", trx3civaddr: "00", trx3model: ""
  }, over || {});
}
function derive(data, txgain) { return Spine.derive({data: data, txgain: txgain || null, browser: null}); }

// Fresh out of the box: LAN on TRX1 with nothing in it.
let m = derive(device());
check("fresh device: network done in station mode", m.network.done === true);
check("fresh device: identity not done", m.identity.done === false);
check("fresh device: no radio", m.radio === null);
check("fresh device: transmit possible (a LAN slot exists)", m.transmit.possible === true);
check("fresh device: transmit not done", m.transmit.done === false);

// AP mode is the one state where step 1 is not done.
check("AP mode: network not done", derive(device({apMode: true})).network.done === false);

// Credentials entered but the radio never answered: NOT done. This is the case
// the whole design turns on -- typing an address is not evidence.
m = derive(device({trx1lanip: "192.168.1.60", trx1lanuser: "op", trx1lanpass: "pw"}));
check("LAN configured but never logged in: radio not done", m.radio === null);

// The model is the proof, and it is what rememberRadioModel() persists.
m = derive(device({trx1lanip: "192.168.1.60", trx1lanuser: "op", trx1lanpass: "pw", trx1model: "IC-705"}));
check("LAN with a learned model: radio done", m.radio !== null && m.radio.model === "IC-705");

// CI-V and TrxNet cannot report a model, so a configured address is all there is.
check("CI-V station: radio done without a model",
  derive(device({trx1transport: "civ", trx1civaddr: "94"})).radio !== null);
check("CI-V station: transmit check not applicable",
  derive(device({trx1transport: "civ", trx1civaddr: "94"})).transmit.possible === false);
check("TrxNet slot with NET_ID 00 is not set up",
  derive(device({trx1transport: "trxnet", trx1netid: "00"})).radio === null);
check("TrxNet slot with a NET_ID is set up",
  derive(device({trx1transport: "trxnet", trx1netid: "0A"})).radio !== null);

// A disabled secondary slot must never satisfy the step.
check("disabled slot with a model does not count",
  derive(device({trx2enabled: false, trx2transport: "lan", trx2model: "IC-7610"})).radio === null);
check("enabled secondary LAN slot does count",
  derive(device({trx2enabled: true, trx2transport: "lan", trx2model: "IC-7610"})).radio !== null);

// Identity: both halves, and the locator has to be a real square.
check("callsign alone is not identity", derive(device({dxccall: "OK1HRA"})).identity.done === false);
check("bad locator is not identity",
  derive(device({dxccall: "OK1HRA", dxclocator: "ZZ99"})).identity.done === false);
check("callsign and locator complete identity",
  derive(device({dxccall: "OK1HRA", dxclocator: "JO70"})).identity.done === true);
check("six-character locator is accepted",
  derive(device({dxccall: "OK1HRA", dxclocator: "JO70ab"})).identity.done === true);
check("compound callsign is flagged",
  derive(device({dxccall: "OK1HRA/P", dxclocator: "JO70"})).identity.compound === true);

// Calibrations are counted out of the key, which is model|band|percent.
const cal = Spine.countCalibrations({entries: {
  "IC-705|40m|1": {}, "IC-705|40m|14": {}, "IC-705|20m|1": {}
}});
check("calibration count: entries", cal && cal.total === 3);
check("calibration count: distinct bands", cal && cal.bands === 2);
check("calibration count: distinct power settings", cal && cal.powers === 2);
check("no calibrations reads as none", Spine.countCalibrations({entries: {}}) === null);
check("an empty txgain document is not an error", Spine.countCalibrations({}) === null);

// ---------------------------------------------------------------- pass B ----
const html = fs.readFileSync(path.join(ROOT, "data", "setup.html"), "utf8");
const sketch = fs.readFileSync(path.join(ROOT, "wifilt.ino"), "utf8");

check("setup.html loads the spine", /src="\/setup-spine\.js/.test(html));
check("setup.html has a mount point", html.includes('id="setupSpineHost"'));
check("setup.html feeds the spine the data it already fetched", html.includes("window.setupSpine.setData(data)"));
for (const id of ["wifiSection", "dxcSection", "radioSection"]) {
  check("setup.html has #" + id + " for the spine to open", html.includes('id="' + id + '"'));
}
check("firmware routes the bare IP by whether a radio is set up",
  sketch.includes("if (APmode || !stationRadioSetUp()) { renderSetupPage(); return; }"));
check("firmware has the same LAN rule as the browser (model is the proof)",
  /case RADIO_LAN:\s*return radioSlots\[slot\]\.model\.length\(\) > 0;/.test(sketch));
check("firmware treats a configured CI-V address as set up",
  /case RADIO_CIV:\s*return radioSlots\[slot\]\.civAddr != 0x00;/.test(sketch));
check("firmware treats a configured NET_ID as set up",
  /case RADIO_TRXNET:\s*return radioSlots\[slot\]\.netId != 0x00;/.test(sketch));
check("stationRadioSetUp is declared before use", sketch.includes("bool stationRadioSetUp(void);"));
// The save gate on the device, which is the one that actually decides. TRX1 is
// always enabled and defaults to ICOM-LAN, so a blank slot MUST be savable --
// otherwise /setup/save answers 400 on every first run and takes the WiFi and
// the callsign down with a radio nobody has reached yet. Partly filled is a
// different thing and is still refused.
check("firmware saves a slot nobody has configured yet",
  /bool blank = \(nextSlots\[slot\]\.lanIp\.length\(\) == 0 \|\| nextSlots\[slot\]\.lanIp == "0\.0\.0\.0"\)/.test(sketch)
  && /if \(!blank && \(!parsedIp\.fromString/.test(sketch));
check("firmware still refuses a half-filled LAN slot",
  /setupCivAddrErr = "TRX" \+ String\(slot \+ 1\) \+ " LAN needs IP, username and password"/.test(sketch));
// During the handover the station is joined AND the hotspot is still up, so a
// panel that reads APmode alone tells an operator already on their own network
// that the device is in AP mode. True, and useless: what is outstanding is the
// restart, because TrxNet and the radio clients only start on a boot that finds
// APmode false.
check("firmware separates the handover from AP mode",
  /if \(APmode && WiFiStationReady\(\)\) \{\s*\n\s*j \+= "\\"state\\":\\"handoff\\"/.test(sketch));
check("the page says what is actually outstanding there",
  /d\.state === 'handoff'/.test(html) && /starts on the next restart/.test(html));
// It keys the sidetone on every first connect, and an operator who was just
// handed the address on screen did not ask to hear it.
check("CW IP announce is off until it is asked for",
  /bool cwIpOnConnect\s*= false;/.test(sketch));
check("firmware no longer refuses a TrxNet slot that has no peer yet",
  /if \(nextSlots\[slot\]\.netId != 0x00\s*\n\s*&& \(TRXNET_ID == 0x00 \|\| nextSlots\[slot\]\.netId == TRXNET_ID\)\)/.test(sketch));

// ---- the banner, decision 8 ------------------------------------------------
// The transmit check cannot be done on SETUP -- no TX stack, no radio session --
// so the spine follows the operator to the page that can, rather than letting
// them lose the thread at the longest and most physical step.
const wsprHtml = fs.readFileSync(path.join(ROOT, "data", "wspr.html"), "utf8");
const dataHtml = fs.readFileSync(path.join(ROOT, "data", "data.html"), "utf8");
for (const [name, html] of [["wspr.html", wsprHtml], ["data.html", dataHtml]]) {
  check(name + " loads the spine", /src="\/setup-spine\.js/.test(html));
  check(name + " mounts the one-line banner", /SetupSpine\.createBanner/.test(html));
  check(name + " points the banner at its own calibration panel",
    /getElementById\("calField"\)/.test(html));
}
const spineSource = fs.readFileSync(path.join(ROOT, "data", "setup-spine.js"), "utf8");
check("the banner disappears when nothing is outstanding",
  /node\.hidden = true;[\s\S]{0,120}\}\)\.catch/.test(spineSource));
// A banner that can be silenced permanently stops meaning anything, and its
// state is derived, so it must come back by itself.
check("dismissing the banner is not remembered",
  /never stored/.test(spineSource) && !/localStorage/.test(spineSource));
check("an unset callsign is what the banner says first",
  /Step 2 of 5/.test(spineSource) && /no callsign yet/.test(spineSource));
check("the transmit check is offered, not demanded",
  /Step 4 of 5/.test(spineSource) && /never been run/.test(spineSource));

// ---------------------------------------------------------------- pass C ----
// Two devices, two page loads: one that has nothing and one that has everything.
const SCENARIOS = {
  fresh: {data: device({apMode: true}), txgain: {}},
  ready: {
    data: device({dxccall: "OK1HRA", dxclocator: "JO70", trx1lanip: "192.168.1.60",
      trx1lanuser: "op", trx1lanpass: "pw", trx1model: "IC-705"}),
    txgain: {entries: {"IC-705|40m|1": {}, "IC-705|20m|1": {}}}
  }
};

const DRIVER = `
<script>
(function () {
  function ready(fn) {
    if (document.readyState === "complete") fn();
    else window.addEventListener("load", fn);
  }
  ready(function () {
    // The spine renders from a fetch, so give it a tick to arrive.
    setTimeout(function () {
      var steps = [].slice.call(document.querySelectorAll(".spine-step"));
      var list = document.querySelector(".spine");
      fetch("/result", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          scenario: location.search.replace("?", ""),
          count: steps.length,
          states: steps.map(function (s) { return s.getAttribute("data-state"); }),
          details: steps.map(function (s) { return s.querySelector(".spine-detail").textContent; }),
          openBodies: steps.filter(function (s) { return !s.querySelector(".spine-body").hidden; }).length,
          listHidden: !list || list.hidden,
          listOffsetHeight: list ? list.offsetHeight : -1,
          headings: steps.map(function (s) { return s.querySelector(".spine-name").textContent; }),
          headsVisible: steps.filter(function (s) {
            return s.querySelector(".spine-head").offsetHeight > 0; }).length,
          summaryPresent: !!document.querySelector(".spine-summary")
        })
      });
    }, 600);
  });
}());
</script>`;

// The radio step is the only one with real work in it, so it gets driven end to
// end: pick a model, read the steps it produced, sweep, take the address the
// sweep found, log in, and check that the credentials were saved and the link
// asked to reconnect. `noradio` is the same walk with nothing on the network,
// where the interesting output is the sentence the operator is given.
SCENARIOS.radio = {
  data: device({dxccall: "OK1HRA", dxclocator: "JO70"}),
  txgain: {}, scanFinds: ["192.168.1.60"], testState: "ok", testModel: "IC-705"
};
SCENARIOS.noradio = {
  data: device({dxccall: "OK1HRA", dxclocator: "JO70"}),
  txgain: {}, scanFinds: [], testState: "no_answer", testModel: ""
};

const DRIVER_RADIO = `
<script>
(function () {
  // A successful login turns the step green, which replaces the whole body --
  // so the verdict is gone within a frame or two of appearing. Polling for it
  // is a race; watching for it is not.
  var verdictSeen = "";
  new MutationObserver(function () {
    var host = document.getElementById("setupSpineHost");
    var text = host ? host.textContent : "";
    var match = text.match(/(Logged in[^.]*\\.|Radio refused[^.]*\\.|No answer[^.]*\\.)/);
    if (match) verdictSeen = match[1];
  }).observe(document.documentElement, {childList: true, subtree: true, characterData: true});

  function el(sel) { return document.querySelector(sel); }
  function waitFor(fn, ms) {
    return new Promise(function (resolve) {
      var started = Date.now();
      (function poll() {
        var value = fn();
        if (value) return resolve(value);
        if (Date.now() - started > (ms || 4000)) return resolve(null);
        setTimeout(poll, 60);
      }());
    });
  }
  function post(payload) {
    return fetch("/result", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)});
  }
  window.addEventListener("load", function () {
    var out = {scenario: location.search.replace("?", "")};
    waitFor(function () { return el(".spine-models button[data-model]"); }).then(function () {
      var buttons = [].slice.call(document.querySelectorAll(".spine-models button[data-model]"));
      out.modelButtons = buttons.length;
      out.hasUnknownOption = buttons.some(function (b) { return b.dataset.model === "0"; });

      function pick(number) {
        var b = buttons.filter(function (x) { return x.dataset.model === String(number); })[0];
        if (b) b.click();
        return el(".spine-steps") ? el(".spine-steps").textContent : "";
      }
      out.wirelessSteps = pick(705);
      out.wiredSteps = pick(7610);
      out.pressedAfterPick = (function () {
        var b = buttons.filter(function (x) { return x.dataset.model === "7610"; })[0];
        return b ? b.getAttribute("aria-pressed") : "";
      }());
      pick(705);

      out.hasCredentialFields = document.querySelectorAll(".spine-fields input").length === 3;

      el(".spine-row .spine-act").click();            // FIND RADIO
      return waitFor(function () {
        var note = el(".spine-row .spine-note");
        var hit = el(".spine-hit");
        return (hit || (note && note.textContent.indexOf("UDP 50001") >= 0)) ? {hit: hit, note: note} : null;
      }, 6000);
    }).then(function (found) {
      var note = el(".spine-row .spine-note");
      out.scanNote = note ? note.textContent : "";
      var hit = el(".spine-hit");
      out.scanHits = document.querySelectorAll(".spine-hit").length;
      var inputs = document.querySelectorAll(".spine-fields input");
      if (hit) hit.click();
      out.ipAfterHit = inputs[2] ? inputs[2].value : "";
      inputs[0].value = "operator";
      inputs[1].value = "secret123";
      var verify = document.querySelectorAll(".spine-row .spine-act")[1];
      verify.click();
      return waitFor(function () { return verdictSeen || null; }, 6000);
    }).then(function (verdict) {
      out.verdict = verdict || "";
      return waitFor(function () {
        var step = document.querySelectorAll(".spine-step")[2];
        return step && step.getAttribute("data-state") === "done" ? "done" : null;
      }, 4000);
    }).then(function (state) {
      out.radioState = state || (document.querySelectorAll(".spine-step")[2] || {}).getAttribute
        ? document.querySelectorAll(".spine-step")[2].getAttribute("data-state") : "";
      post(out);
    });
  });
}());
</script>`;

// The first run, end to end, on the device an operator actually has in front of
// them: AP mode, nothing configured, TRX1 defaulting to ICOM-LAN with three
// empty fields. This is the walk that used to dead-end -- the WiFi and identity
// panels were somewhere else on the page, and the one button that gets a device
// out of AP mode returned silently because the radio config was incomplete,
// which in AP mode it MUST be.
SCENARIOS.firstrun = {data: device({apMode: true}), txgain: {}};

const DRIVER_FIRSTRUN = `
<script>
(function () {
  function waitFor(fn, ms) {
    return new Promise(function (resolve) {
      var started = Date.now();
      (function poll() {
        var value = fn();
        if (value) return resolve(value);
        if (Date.now() - started > (ms || 5000)) return resolve(null);
        setTimeout(poll, 60);
      }());
    });
  }
  function type(sel, value) {
    var f = document.querySelector(sel);
    if (!f) return false;
    f.value = value;
    f.dispatchEvent(new Event("input", {bubbles: true}));
    f.dispatchEvent(new Event("change", {bubbles: true}));
    return true;
  }
  function post(payload) {
    return fetch("/result", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)});
  }
  window.addEventListener("load", function () {
    var out = {scenario: "firstrun"};
    var steps = [];
    waitFor(function () {
      steps = [].slice.call(document.querySelectorAll(".spine-step"));
      return steps.length === 5 && steps[0].querySelector("#wifiSection") ? true : null;
    }).then(function (ok) {
      out.adopted = !!ok;
      out.wifiInStep1 = !!steps[0].querySelector("#wifiSection");
      out.identityInStep2 = !!steps[1].querySelector("#identitySection");
      out.identityStillInForm = !!document.querySelector('#identityCall[form="setup-form"]');
      var title = document.querySelector("#wifiSection > .setup-section-title");
      out.innerAccordionGone = title ? getComputedStyle(title).display === "none" : false;
      out.step1Button = (steps[0].querySelector(".spine-next .spine-act") || {}).textContent || "";
      out.step2Button = (steps[1].querySelector(".spine-next .spine-act") || {}).textContent || "";

      out.typed = type('[name="ssid"]', "Domov") && type('[name="pswd"]', "tajneheslo")
        && type("#identityCall", "OK1HRA") && type("#identityLocator", "JO70FD");

      // Step 2's own button, not the one at the bottom of the page.
      steps[1].querySelector(".spine-next .spine-act").click();
      return waitFor(function () {
        return steps[1].getAttribute("data-state") === "done" ? true : null;
      }, 6000);
    }).then(function (saved) {
      out.identitySaved = !!saved;
      out.identityDetail = steps[1].querySelector(".spine-detail").textContent;
      // Saving step 2 has to hand the operator to step 3, not leave them looking
      // at a green tick with no next move.
      out.step3Opened = !steps[2].querySelector(".spine-body").hidden;

      // A step opened by hand must survive the render that follows every poll.
      steps[4].querySelector(".spine-head").click();
      if (window.setupSpine && window.setupSpine.render) window.setupSpine.render();
      out.handOpenSurvivesRender = !steps[4].querySelector(".spine-body").hidden;

      // The regression this whole scenario exists for: on a device with no radio
      // configured, Save & Restart used to return without a trace.
      var save = document.querySelector('.actions button[type="submit"]');
      out.saveButtonFound = !!save;
      if (save) save.click();
      return waitFor(function () {
        var shell = document.querySelector("main.setup-shell");
        return shell && shell.style.display === "none" ? true : null;
      }, 6000);
    }).then(function (acted) {
      out.saveActed = !!acted;
      // Wait for the device end to confirm it was asked to join. Watching the
      // page text instead would post the result with /setup/wifi-try still in
      // flight, and a killed browser makes that look like it never happened.
      var seen = false;
      return waitFor(function () {
        if (!seen) {
          seen = true;
          fetch("/probe.json", {cache: "no-store"}).then(function (r) { return r.json(); })
            .then(function (p) { out.probe = p; seen = false; })
            .catch(function () { seen = false; });
        }
        return out.probe && out.probe.wifiTries >= 1 ? true : null;
      }, 8000);
    }).then(function (handover) {
      out.handoverStarted = !!handover;
      post(out);
    });
  });
}());
</script>`;

const results = {};
let chrome = null, finished = false, timer = null;

function report() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();

  const fresh = results.fresh, ready = results.ready;
  check("fresh: five steps rendered", fresh && fresh.count === 5);
  check("fresh: network step is the outstanding one", fresh && fresh.states[0] === "todo");
  check("fresh: identity outstanding", fresh && fresh.states[1] === "todo");
  // Not "todo": the radio cannot be reached from AP mode, and saying so beats
  // an amber step the operator cannot act on yet.
  check("fresh: radio step is blocked, not outstanding", fresh && fresh.states[2] === "blocked");
  // Amber on a step nobody can act on yet is the thing this page exists to stop.
  check("fresh: transmit check is blocked while there is no radio", fresh && fresh.states[3] === "blocked");
  check("fresh: exactly one step opened by itself", fresh && fresh.openBodies === 1);
  // The five headings are the page's structure and they stay. This used to fold
  // into one summary line as soon as the core three were done, which threw the
  // structure away exactly when an operator coming back to change one thing
  // needed to see WHICH one. Measured, not inferred: an explicit display beats
  // the hidden attribute, so the flag alone would not have caught the old bar
  // showing through.
  check("fresh: all five headings are visible", fresh && fresh.headsVisible === 5);
  check("ready: all five headings are still visible", ready && ready.headsVisible === 5);
  check("ready: the finished list is not folded away", ready && !ready.listHidden && ready.listOffsetHeight > 0);
  check("the one-line summary is gone entirely",
    fresh && ready && !fresh.summaryPresent && !ready.summaryPresent);
  check("ready: the headings name WiFi, identity and radio",
    ready && /network/i.test(ready.headings[0]) && /identity/i.test(ready.headings[1])
    && /radio/i.test(ready.headings[2]));

  check("ready: network done", ready && ready.states[0] === "done");
  check("ready: identity done", ready && ready.states[1] === "done");
  check("ready: radio done", ready && ready.states[2] === "done");
  check("ready: transmit done", ready && ready.states[3] === "done");
  check("ready: radio detail names the model", ready && /IC-705/.test(ready.details[2]));
  check("ready: transmit detail counts bands", ready && /2 bands/.test(ready.details[3]));
  check("ready: the radio heading carries the model", ready && /IC-705/.test(ready.details[2]));

  const radio = results.radio, noradio = results.noradio;
  check("radio: every known model plus an escape is offered",
    radio && radio.modelButtons >= 6 && radio.hasUnknownOption === true);
  check("radio: the IC-705 gets the wireless procedure",
    radio && /WLAN Set/.test(radio.wirelessSteps) && /Station/.test(radio.wirelessSteps));
  check("radio: an Ethernet model gets a cable, not a WLAN menu",
    radio && /Ethernet cable/.test(radio.wiredSteps) && !/WLAN Set/.test(radio.wiredSteps));
  check("radio: the chosen model is marked", radio && radio.pressedAfterPick === "true");
  // The credentials are invented at the radio, so they are asked for in the same
  // block as the instruction to invent them.
  check("radio: user, password and address sit with the steps",
    radio && radio.hasCredentialFields === true);
  check("radio: the sweep offers what it found", radio && radio.scanHits === 1);
  check("radio: taking a result fills the address", radio && radio.ipAfterHit === "192.168.1.60");
  check("radio: the login verdict names the model", radio && /IC-705/.test(radio.verdict));
  check("radio: the test used the model's own CI-V address",
    /"civaddr":"A4"/.test(probe.testBody) && /"ip":"192\.168\.1\.60"/.test(probe.testBody));
  // handleSet() discards a post without ssid+pswd, so a partial save is not a
  // thing -- proving the whole form went is proving the save can work at all.
  check("radio: the whole form was saved, without a restart",
    probe.saves.some(b => /ssid=/.test(b) && /pswd=/.test(b)
      && /trx1lanuser=operator/.test(b) && /noRestart=1/.test(b)));
  check("radio: the running link was asked to reconnect instead of rebooting", probe.reconnects === 1);
  check("radio: the step turns green once the radio has answered", radio && radio.radioState === "done");

  check("no radio found: the advice names the subnet that was swept",
    noradio && /192\.168\.1\.0\/24/.test(noradio.scanNote));
  check("no radio found: the advice names the two usual causes",
    noradio && /Network Control/.test(noradio.scanNote) && /different network/.test(noradio.scanNote));
  check("no radio found: the advice says where this interface is",
    noradio && /Domov/.test(noradio.scanNote));
  check("no radio found: the step does not turn green", noradio && noradio.radioState !== "done");

  // ---- the first run --------------------------------------------------------
  const first = results.firstrun;
  check("first run: the WiFi panel is inside step 1, not somewhere below it",
    first && first.wifiInStep1 === true);
  check("first run: the identity panel is inside step 2", first && first.identityInStep2 === true);
  // Moving a section out of <form> silently drops its fields from the POST, so
  // this is the check that stands between "looks saved" and "was saved".
  check("first run: moved fields are re-attached to the form",
    first && first.identityStillInForm === true);
  check("first run: the step does not wrap a second accordion round the panel",
    first && first.innerAccordionGone === true);
  check("first run: step 1 offers the handover, not a bare save",
    first && /JOIN THE NETWORK/.test(first.step1Button));
  check("first run: step 2 offers a way on", first && /CONTINUE/.test(first.step2Button));
  check("first run: typing into the adopted panels worked", first && first.typed === true);
  check("first run: step 2's own button saves the callsign to the device",
    first && first.identitySaved === true);
  check("first run: the tick names what the device stored",
    first && /OK1HRA/.test(first.identityDetail) && /JO70FD/.test(first.identityDetail));
  check("first run: saving step 2 opens step 3", first && first.step3Opened === true);
  check("first run: a step opened by hand survives the next render",
    first && first.handOpenSurvivesRender === true);
  // The regression. TRX1 is always active and defaults to ICOM-LAN with three
  // empty fields, so the radio check fails on every first run -- and in AP mode
  // it cannot pass, because the radio is not on a network the interface has not
  // joined yet. Save & Restart used to return silently there.
  check("first run: Save & Restart acts on a device with no radio configured",
    first && first.saveButtonFound === true && first.saveActed === true);
  check("first run: it saved the WiFi it was given",
    probe.saves.some(b => /ssid=Domov/.test(b) && /dxccall=OK1HRA/.test(b)));
  check("first run: AP mode hands over instead of rebooting into nowhere",
    first && first.handoverStarted === true && probe.wifiTries === 1 && probe.restarts === 0);

  const total = 97;
  if (failures.length) {
    console.error("SETUP SPINE FAIL (" + failures.length + " of ~" + total + ")\n  " + failures.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log("SETUP SPINE PASS derivation + source contract + rendered page (" + total + " checks)");
  }
}

// The page asks for /setup-data.json with no query string of its own, so which
// device is being simulated has to be remembered from the page request.
let currentScenario = "fresh";
const probe = {scanStarts: 0, reconnects: 0, testBody: "", saveBody: "",
               saves: [], restarts: 0, wifiTries: 0};

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const send = (type, body) => { res.writeHead(200, {"Content-Type": type}); res.end(body); };

  if (req.method === "POST" && url === "/result") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      res.writeHead(204); res.end();
      let data; try { data = JSON.parse(body); } catch (e) { return report(); }
      results[data.scenario] = data;
      scenarioDone(data.scenario);
    });
    return;
  }
  if (url === "/" || url === "/setup") {
    currentScenario = (req.url.split("?")[1] || "fresh").split("&")[0];
    const radioWalk = currentScenario === "radio" || currentScenario === "noradio";
    const driver = currentScenario === "firstrun" ? DRIVER_FIRSTRUN : radioWalk ? DRIVER_RADIO : DRIVER;
    const page = fs.readFileSync(path.join(ROOT, "data", "setup.html"), "utf8");
    return send("text/html; charset=utf-8", page.replace("</body>", driver + "</body>"));
  }
  // The firmware runs one sweep and one login at a time, so the stub is a single
  // pair of state machines rather than anything per slot.
  if (url === "/icom/scan" && req.method === "POST") { probe.scanStarts++; return send("application/json", "{\"ok\":true}"); }
  if (url === "/icom/scan.json") return send("application/json", JSON.stringify({
    state: "done", scanned: 254, total: 254, subnet: "192.168.1", truncated: false,
    found: (SCENARIOS[currentScenario].scanFinds || []).map(ip => ({ip}))
  }));
  if (url === "/icom/test" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { probe.testBody = body; res.writeHead(200,
      {"Content-Type": "application/json"}); res.end("{\"ok\":true}"); });
    return;
  }
  if (url === "/icom/test.json") {
    const sc = SCENARIOS[currentScenario];
    // A successful login is what makes the firmware write the model down, so
    // the stub does the same -- otherwise the step could never turn green.
    if (sc.testState === "ok") sc.data = Object.assign({}, sc.data, {trx1model: sc.testModel});
    return send("application/json", JSON.stringify({state: sc.testState, model: sc.testModel}));
  }
  if (url === "/setup/save" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      probe.saveBody = body;
      probe.saves.push(body);
      // The stub stores what it was sent, the way the device does. Without this
      // the round trip could not be tested at all: a step turns green because
      // /setup-data.json says so afterwards, never because a field was typed.
      const posted = new URLSearchParams(body);
      const data = SCENARIOS[currentScenario].data;
      ["ssid", "dxccall", "dxclocator"].forEach(key => {
        if (posted.has(key)) data[key] = posted.get(key);
      });
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end("{\"ok\":true}");
    });
    return;
  }
  // The driver waits on this rather than on page text: a request that is still
  // in flight when the browser is killed is indistinguishable from one that was
  // never made, and that raced.
  if (url === "/probe.json") return send("application/json", JSON.stringify(probe));
  if (url === "/restart" && req.method === "POST") { probe.restarts++; return send("application/json", "{\"ok\":true}"); }
  if (url === "/setup/wifi-try" && req.method === "POST") { probe.wifiTries++; return send("application/json", "{\"ok\":true}"); }
  if (url === "/setup/wifi-try.json") return send("application/json",
    JSON.stringify({state: "connecting", ssid: "Domov"}));
  if (url === "/lan/reconnect" && req.method === "POST") { probe.reconnects++; return send("application/json", "{\"ok\":true}"); }
  if (url === "/icom-discovery.js") return send("application/javascript",
    fs.readFileSync(path.join(ROOT, "data", "icom-discovery.js")));
  if (url === "/icom-models.js") return send("application/javascript",
    fs.readFileSync(path.join(ROOT, "data", "icom-models.js")));
  if (url === "/setup-spine.js") return send("application/javascript",
    fs.readFileSync(path.join(ROOT, "data", "setup-spine.js")));
  if (url.startsWith("/setup.css")) return send("text/css",
    fs.readFileSync(path.join(ROOT, "data", "setup.css")));
  if (url === "/setup-data.json") return send("application/json", JSON.stringify(SCENARIOS[currentScenario].data));
  if (url === "/txgain.json") return send("application/json", JSON.stringify(SCENARIOS[currentScenario].txgain));
  if (url === "/state") return send("application/json", JSON.stringify({connected: true}));
  // Everything else the page asks for is deliberately absent: the spine has to
  // survive a page whose other panels cannot load.
  res.writeHead(404, {"Content-Type": "application/json"});
  res.end("{}");
});

// Headless Chrome refuses more than one target per launch, so the scenarios run
// one browser after the other. A headless browser given a URL does not exit by
// itself either, so the page's own result is what ends each run.
let advance = null;

function scenarioDone(name) {
  if (chrome) { chrome.kill("SIGTERM"); chrome = null; }
  const next = advance;
  advance = null;
  if (next) next();
}

function runScenario(base, name, done) {
  advance = done;
  chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--no-proxy-server", base + "?" + name]);
  let err = "";
  chrome.stderr.on("data", c => err += c);
  chrome.on("close", code => {
    // Expected when scenarioDone() killed it; a real exit means no result came.
    if (finished || results[name]) return;
    failures.push("scenario " + name + ": no result (Chrome exited " + code + ") " + err.slice(0, 300));
    scenarioDone(name);
  });
}

server.listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + server.address().port + "/";
  timer = setTimeout(() => { failures.push("timeout waiting for the rendered page"); report(); }, 60000);
  runScenario(base, "fresh", function () {
    runScenario(base, "ready", function () {
      runScenario(base, "radio", function () {
        runScenario(base, "noradio", function () {
          runScenario(base, "firstrun", report);
        });
      });
    });
  });
});
