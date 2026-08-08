// The setup help dialog, built per radio model instead of per page.
//
// It used to be one hand-written IC-705 procedure pasted into data.html and a
// second, shorter one in wspr.html. That was honest while the interface only
// spoke to an IC-705, but it stopped being honest the moment radio-type
// autodetection landed: an IC-7610 operator was shown `MENU → SET → WLAN Set`,
// a menu their radio does not have, and told to build a PRESET, a function their
// radio does not have either.
//
// So the procedure is generated from icom-models.js -- one row per radio, the same
// row WSPR reads its watts from. Five models differ in more than wording:
//
//   * WLAN (IC-705, wireless) vs LAN (everything else, Ethernet) appears in three
//     separate menu items, so it is a field, not three strings.
//   * Network settings live in THREE different places. IC-705: WLAN Set →
//     Remote Settings. IC-7300MK2 / IC-7760: Network → Remote Settings. IC-7610 /
//     IC-9700: directly under Network -- they have no Remote Settings submenu at
//     all. Checked in each radio's own manual.
//   * PRESET stores a whole named setup and gives one-touch return to it. The
//     IC-705, IC-7300MK2 and IC-7760 have it; the IC-7610 and IC-9700 do not, and
//     for them the guide has to say "set these by hand" rather than quietly drop
//     three steps and leave the operator wondering how to get back.
//
// An unrecognised radio gets the common-denominator guide and is told so by name.
// It never falls back to the IC-705 procedure: a page that explains a radio which
// is not connected is worse than one that admits what it does not know.
//
// The dialog it builds carries the same ids and classes the inline markup did
// (#trxHelpDialog, #trxHelpModeWarning, .trx-setup-steps), so the open/close and
// first-visit logic already in data.js and wspr.js keeps working untouched.

(function (root) {
  "use strict";

  const Models = root.IcomModels;

  // Only the switcher is new. The dialog's own styling has lived in data.css since
  // it was inline markup, and wspr.html loads data.css too, so duplicating it here
  // would create a second copy to keep in step.
  const SWITCH_CSS = ""
    + ".trx-help-models{display:flex;flex-wrap:wrap;gap:6px;align-items:center;"
    + "margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid #26443d}"
    + ".trx-help-models-label{margin-right:2px;color:#7e918b;font-size:11px;"
    + "font-weight:800;letter-spacing:.06em;text-transform:uppercase}"
    + ".trx-help-model{padding:5px 10px;border:1px solid #3d675e;border-radius:4px;"
    + "background:#081310;color:#d9e7e2;font:inherit;font-size:12px;font-weight:800;"
    + "cursor:pointer}"
    + ".trx-help-model:hover,.trx-help-model:focus-visible{border-color:#66f2d5;"
    + "color:#fff;outline:none}"
    + ".trx-help-model[aria-pressed=true]{border-color:#66f2d5;background:#15332d;"
    + "color:#66f2d5}"
    + ".trx-help-model-detected::after{content:' ●';color:#66f2d5;font-size:9px;"
    + "vertical-align:middle}"
    + ".trx-help-detected{margin:0 0 12px;color:#7e918b;font-size:12px}"
    + ".trx-help-detected strong{color:#d9e7e2}"
    + ".trx-help-untested{margin:10px 0 0;padding:9px 11px;border-left:3px solid #e0a020;"
    + "background:#1d1609;color:#e8d9bf;font-size:12px;line-height:1.5}";

  const escapeHtml = value => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const code = text => `<code>${escapeHtml(text)}</code>`;
  const step = (title, body) => `<li><strong>${title}</strong><p>${body}</p></li>`;

  // ---- the JS8 station procedure -------------------------------------------

  // Reads as one procedure with the radio's own words substituted, because it *is*
  // one procedure: prepare, join the network, allow network control, route receive
  // audio, store the digital settings, recall them, finish on this page. Only the
  // storing and recalling depend on whether the radio has PRESET.
  function js8Steps(model) {
    const net = model.net;                                  // "WLAN" or "LAN"
    const modLevel = `${net} MOD Level`;
    const steps = [];

    steps.push(step("Prepare the radio and station",
      `${model.firmwareNote ? escapeHtml(model.firmwareNote) + " " : ""}`
      + "Connect a suitable antenna or dummy load, select a low RF power for initial "
      + "tests, and synchronize the phone or computer system clock."));

    steps.push(step(`Connect the ${escapeHtml(model.label)} to the network`,
      net === "WLAN"
        ? `Open ${code("MENU → SET → WLAN Set")}, switch ${code("WLAN")} on, and join the `
          + "same network as this interface. On firmware versions that provide it, the "
          + "radio's own access-point mode can be used instead."
        : `Connect the radio's ${code("LAN")} port to the same network as this interface. `
          + `Under ${code(model.netMenu)}, either leave ${code("DHCP")} on or set a fixed `
          + "IP address."));

    steps.push(step("Enable network control",
      `Under ${code(model.netMenu)}, set ${code("Network Control")} to ${code("ON")}, keep `
      + `the default control/serial/audio ports ${code("50001 / 50002 / 50003")}, and `
      + "configure a Network User ID and password with administrator access. Enter the "
      + "same radio address and credentials on this device's SETUP page, then restart the "
      + "radio if it asks you to."));

    steps.push(step("Route receive audio to the network",
      `Set ${code(`MENU → SET → Connectors → ${net} AF/IF Output → Output Select`)} to `
      + `${code("AF")} and ${code("AF SQL")} to ${code("OFF (Open)")}.`));

    const settings = ""
      + '<dl class="trx-help-settings">'
      + "<div><dt>Mode</dt><dd>USB-D</dd></div>"
      + "<div><dt>Filter / bandwidth</dt><dd>FIL1 / 3.0 kHz</dd></div>"
      + "<div><dt>SSB-D TX bandwidth</dt><dd>100–2900 Hz</dd></div>"
      + "<div><dt>Speech compressor</dt><dd>COMP OFF</dd></div>"
      + `<div><dt>DATA MOD</dt><dd>${escapeHtml(net)}</dd></div>`
      + `<div><dt>CI-V address / transceive</dt><dd>${escapeHtml(model.civAddr)}h / ON</dd></div>`
      + "</dl>";

    // The MOD level sentence is deliberately identical in both branches: it is the
    // one setting PRESET does not carry, so it has to be set separately either way.
    const modLevelNote =
      `Separately set ${code(`MENU → SET → Connectors → MOD Input → ${modLevel}`)} to `
      + `${code("25%")} as the recommended starting point. ${code("DATA OFF MOD")} may stay `
      + "on the normal microphone input so voice operation still works outside data mode.";

    if (model.hasPreset) {
      steps.push(step("Create a dedicated preset",
        `Open ${code("MENU → PRESET")}. Long-press an unused memory, choose `
        + `${code("Edit the Preset Memory")}, and name it ${code(`JS8CALL ${net}`)}. Select the `
        + "check boxes for the settings listed in the next step."));
      steps.push(step("Enter the JS8Call preset values",
        settings + `<span>Finish with ${code("<<Write>> → YES")}. ${modLevelNote}</span>`));
      steps.push(step("Load and verify the preset",
        `Open ${code(`MENU → PRESET → JS8CALL ${net} → YES`)}. The preset must show `
        + `${code("In Use")}, and this page's header must report ${code("USB-D")}. If it reports `
        + "CW, RTTY, AM, FM or another mode, reload the preset."));
    } else {
      // No PRESET on this radio. Say so, rather than leaving the operator to
      // wonder where the one-touch restore went.
      steps.push(step("Enter the digital settings by hand",
        settings
        + `<span>This radio has no ${code("PRESET")} function, so there is no one-touch way `
        + "back to these values — note them down, or store the mode and filter in a memory "
        + `channel. ${modLevelNote}</span>`));
      steps.push(step("Verify the mode",
        `This page's header must report ${code("USB-D")}. If it reports CW, RTTY, AM, FM or `
        + "another mode, the radio is not in a data mode and the modem cannot decode."));
    }

    // The callsign and the grid used to be typed here. They are the station's,
    // not this page's, and SETUP is now the only place they can be edited -- so
    // instructing anyone to type them on the JS8Call page describes fields that
    // have been read-only outputs since the identity moved off the browser.
    steps.push(step("Complete the JS8Call-ICOM page setup",
      "Choose a JS8 dial frequency by tapping the TRX frequency, wait for the audio clock to "
      + `lock, and confirm ${code("Enable radio TX")}. The callsign and locator shown in `
      + `SETTINGS are the station's own: they are typed once in ${code("SETUP → Identity")} and `
      + "are read-only here."));

    // The audio level is measured now, not tuned by hand against the ALC needle.
    steps.push(step("Measure the TX audio level",
      `Leave ${code(`${modLevel}`)} at the ${code("25%")} above and run `
      + `${code("Automatic TX gain")} in SETTINGS: it keys one carrier and raises the audio `
      + "until the radio's ALC just acts, then stores the level below that. Set the band and "
      + "the RF power you want first — the result is filed under exactly that pair, and shared "
      + `with the WSPR beacon. ${code("CAL PLAN")} in the bar at the top measures a whole `
      + "band × power matrix in one run."));

    return steps;
  }

  // ---- the WSPR beacon procedure -------------------------------------------

  // Much shorter than the JS8 one on purpose: the beacon sets the mode itself
  // before every slot, so all the operator owns is the audio path and the power.
  function wsprSteps(model) {
    const net = model.net;
    const steps = [
      `<li>${code(`MENU → SET → Connectors → MOD Input → DATA MOD`)} to ${code(net)}.</li>`,
      `<li>${code(`MENU → SET → Connectors → MOD Input → ${net} MOD Level`)} to ${code("25%")}`
        + " as a starting point. Do not trim the audio by eye against the ALC meter — "
        + "<b>Automatic TX gain</b> in SETTINGS measures it, and <b>CAL PLAN</b> in the bar at "
        + "the top measures a whole band × power matrix.</li>",
      `<li>${code(`MENU → SET → Connectors → ${net} AF/IF Output → Output Select`)} to `
        + `${code("AF")}, and ${code("AF SQL")} to ${code("OFF (Open)")}.</li>`,
      `<li>Mode ${code("USB-D")} with filter ${code("FIL1")}. The beacon selects the mode, `
        + "not the filter.</li>",
      // Power is the one WSPR step that is genuinely per radio: the beacon caps at
      // 10 W, which is this radio's full output or a small fraction of it.
      `<li>RF power at or below <strong>10 W</strong>. `
        + (model.watts > 10
             ? `On a ${escapeHtml(model.label)} that is about `
               + `${Math.round(1000 / model.watts)} % of the power scale, so set it carefully.`
             : "That is full output on this radio.")
        + " The beacon refuses to key above 10 W, whatever the radio can do.</li>",
      "<li>Break-in off. WSPR keys through the network, not through VOX.</li>",
    ];
    return steps;
  }

  // ---- the guide for a radio we do not have a row for ----------------------

  // Everything the five known radios agree on, plus the one case where the model
  // number is right and no menu path can be: a serial radio bridged onto the
  // network by wfview or RS-BA1, whose network settings are on the PC.
  function genericSteps() {
    return [
      step("Enable network control on the radio",
        `Find the radio's network or remote settings and set ${code("Network Control")} to `
        + `${code("ON")}. Keep the default control/serial/audio ports `
        + `${code("50001 / 50002 / 50003")} and configure a network user ID and password with `
        + "administrator access."),
      step("Route receive audio to the network",
        `Set the ${code("LAN AF/IF Output")} (or ${code("WLAN AF/IF Output")}) `
        + `${code("Output Select")} to ${code("AF")} and ${code("AF SQL")} to `
        + `${code("OFF (Open)")}.`),
      step("Send transmit audio over the network",
        `Set ${code("DATA MOD")} to ${code("LAN")} (or ${code("WLAN")}) and start with a MOD `
        + "level around 25 %."),
      step("Select a data mode",
        `Mode ${code("USB-D")}, filter ${code("FIL1")}, speech compressor off. This page's `
        + `header must report ${code("USB-D")}.`),
      step("If the radio is bridged, configure the server instead",
        "A radio without network control of its own can still appear here through a "
        + "wfview or RS-BA1 server. In that case the network settings, the user and the "
        + "password live on that server, not in the radio's menu — the radio only reports "
        + "its model."),
    ];
  }

  // ---- rendering -----------------------------------------------------------

  // The eyebrow used to say WLAN whatever radio was on screen -- the one word the
  // whole model table exists to get right, sitting above a body that correctly
  // said LAN for four of the five. It follows the model now, which means it has to
  // be repainted like everything else, and says neither when no model is chosen.
  const netWord = model => (model ? model.net : "THE NETWORK");

  const KINDS = {
    js8:  {eyebrow: model => `JS8CALL-ICOM OVER ${netWord(model)}`,
           warning: "The radio is not in a suitable data mode. Complete the setup below and load "
                  + "the <strong>JS8CALL</strong> preset; the JS8Call-ICOM header must show "
                  + "<strong>USB-D</strong>.",
           note: "<strong>Reminder:</strong> JS8Call-ICOM is a high-duty-cycle digital mode. Use "
               + "conservative RF power and verify antenna matching before transmitting.",
           steps: js8Steps},
    wspr: {eyebrow: model => `WSPR BEACON OVER ${netWord(model)}`,
           warning: "The radio is not in a data mode. The beacon sets <strong>USB-D</strong> "
                  + "itself before every slot, but the audio path below has to be set up by hand "
                  + "first.",
           note: "The transmitted power in the WSPR message follows the radio: turn the power knob "
               + "and the reported value follows it, to the nearest legal WSPR level.",
           steps: wsprSteps},
  };

  // userPicked latches once the operator chooses a radio in the switcher. Without
  // it a late /state or /setup-data.json answer would yank the guide out from under
  // someone who deliberately opened a different model -- which is the whole point
  // of the switcher existing.
  let state = {kind: "js8", reported: "", selected: null, doc: null, userPicked: false};

  function switcher(detected, selected) {
    const buttons = Models.MODELS.map(model => {
      const isDetected = detected && detected.number === model.number;
      const isSelected = selected && selected.number === model.number;
      return `<button type="button" class="trx-help-model`
        + `${isDetected ? " trx-help-model-detected" : ""}" data-help-model="${model.number}"`
        + ` aria-pressed="${isSelected ? "true" : "false"}"`
        + `${isDetected ? ' title="Detected on the air"' : ""}>${escapeHtml(model.label)}</button>`;
    });
    // The generic guide stays reachable even when a model is detected: the radio may
    // be bridged, in which case none of the model menu paths apply.
    buttons.push(`<button type="button" class="trx-help-model" data-help-model="0"`
      + ` aria-pressed="${selected ? "false" : "true"}">Other Icom</button>`);
    return '<div class="trx-help-models">'
      + '<span class="trx-help-models-label">Radio</span>' + buttons.join("") + "</div>";
  }

  function detectedLine(detected, reported) {
    const name = String(reported || "").trim();
    if (detected) {
      return `<p class="trx-help-detected">Detected: <strong>${escapeHtml(name)}</strong> — `
        + `full output ${detected.watts} W, CI-V ${escapeHtml(detected.civAddr)}h.</p>`;
    }
    if (name) {
      return `<p class="trx-help-detected">Detected: <strong>${escapeHtml(name)}</strong> — no `
        + "specific guide for this model yet, showing the common Icom network procedure.</p>";
    }
    // Nothing connected and nothing remembered: name the slot, never a model.
    return '<p class="trx-help-detected">No radio has reported a model yet. Pick yours above, or '
      + "follow the common Icom network procedure below.</p>";
  }

  function body() {
    const kind = KINDS[state.kind] || KINDS.js8;
    const detected = Models.findModel(state.reported);
    const model = state.selected;
    const steps = model ? kind.steps(model) : genericSteps();
    const untested = model && !model.tested
      ? '<p class="trx-help-untested">The IC-705 is the model this interface has been verified '
        + `against. The ${escapeHtml(model.label)} exposes the same Network Control and `
        + "network audio functions and these paths come from its own manual, but the "
        + "combination has not been confirmed on the air yet — treat the first transmission "
        + "as a test.</p>"
      : "";
    return switcher(detected, model)
      + detectedLine(detected, state.reported)
      + `<ol class="trx-setup-steps">${steps.join("")}</ol>`
      + untested
      + `<p class="trx-help-note">${kind.note}</p>`;
  }

  function title() {
    if (state.selected) return `${state.selected.label} setup`;
    const name = String(state.reported || "").trim();
    return name ? `${name} setup` : "Radio setup";
  }

  function repaint() {
    const doc = state.doc;
    if (!doc) return;
    const kind = KINDS[state.kind] || KINDS.js8;
    const content = doc.querySelector("#trxHelpDialog .trx-help-content");
    const heading = doc.getElementById("trxHelpTitle");
    const warning = doc.getElementById("trxHelpModeWarning");
    const eyebrow = doc.getElementById("trxHelpEyebrow");
    if (warning) warning.innerHTML = kind.warning;
    if (eyebrow) eyebrow.textContent = kind.eyebrow(state.selected);
    if (heading) heading.textContent = title();
    if (content) content.innerHTML = body();
  }

  function injectStyle(doc) {
    if (doc.getElementById("trxHelpStyle")) return;
    const style = doc.createElement("style");
    style.id = "trxHelpStyle";
    style.textContent = SWITCH_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  // Builds the dialog with the ids the pages already reference, so the existing
  // open/close, first-visit and mode-warning logic needs no changes.
  function mount(doc, options) {
    const settings = options || {};
    state.doc = doc;
    state.kind = KINDS[settings.kind] ? settings.kind : "js8";
    injectStyle(doc);
    if (doc.getElementById("trxHelpDialog")) { repaint(); return; }
    const dialog = doc.createElement("dialog");
    dialog.id = "trxHelpDialog";
    dialog.className = "trx-help-dialog";
    dialog.setAttribute("aria-labelledby", "trxHelpTitle");
    dialog.innerHTML = ""
      + '<form method="dialog" class="trx-help-card">'
      + "<header><div>"
      // Filled by repaint(), like the title beside it: the eyebrow names the
      // radio's own word for the audio path, so it cannot be baked in at mount.
      + '<small id="trxHelpEyebrow"></small>'
      + '<h2 id="trxHelpTitle"></h2></div>'
      + '<button class="trx-help-close" type="submit" value="close"'
      + ' aria-label="Close setup help" title="Close">×</button>'
      + "</header>"
      // Outside .trx-help-content on purpose: the pages cache #trxHelpModeWarning
      // once and toggle .hidden on it, so it must survive every repaint.
      + '<p id="trxHelpModeWarning" class="trx-help-warning" hidden></p>'
      + '<div class="trx-help-content"></div>'
      + "<footer><span>Source: Icom transceiver manuals and the JS8Call user guide</span>"
      + '<button class="trx-help-done" type="submit" value="close">CLOSE</button></footer>'
      + "</form>";
    (doc.body || doc.documentElement).appendChild(dialog);

    // Delegated, so the switcher survives every repaint -- rebuilding innerHTML
    // detaches the button that was clicked, which is exactly how per-button
    // listeners get silently lost.
    dialog.addEventListener("click", event => {
      const button = event.target.closest ? event.target.closest("[data-help-model]") : null;
      if (!button) return;
      event.preventDefault();
      selectModel(button.getAttribute("data-help-model"));
    });

    repaint();
  }

  // Called whenever /state reports a model, or the remembered one arrives from
  // /setup-data.json. Cheap to call on every poll: identical input is a no-op, so
  // it does not rebuild the dialog behind the operator's cursor.
  function setReportedModel(reported) {
    const next = String(reported == null ? "" : reported);
    if (next === state.reported) return;
    state.reported = next;
    if (!state.userPicked) state.selected = Models.findModel(next);
    repaint();
  }

  // "0" (Other Icom) selects the generic guide on purpose -- a bridged radio
  // reports a real model number whose menu paths still do not apply.
  function selectModel(number) {
    state.userPicked = true;
    state.selected = Models.MODELS.find(model => model.number === Number(number)) || null;
    repaint();
  }

  root.TrxHelp = {mount, setReportedModel, selectModel,
                  // exported for the smoke harnesses and for anything that wants to
                  // know which guide is on screen without reading the DOM
                  current: () => ({kind: state.kind, reported: state.reported,
                                   selected: state.selected ? state.selected.label : null})};

})(typeof window !== "undefined" ? window : this);
