// The five steps of getting a station on the air, derived instead of stored.
//
// Setup used to be seven collapsed <details> in the order they were built, each
// badged with the storage tier behind it, and the only thing telling an operator
// what to do next was a refusal: open the device, land on DATA, and read a card
// explaining that DATA needs a radio it has not been given yet. This turns that
// around -- the same facts, in the order the work actually happens, with the
// next thing to do always visible.
//
// NOTHING HERE IS STORED. There is no "wizard step 3" anywhere: every step reads
// its own state off a fact the device already keeps, so a restored backup, a
// reflash or a move to another network all land on the correct step by
// themselves, and there is no saved cursor that can disagree with reality.
//
//   1 Network   !apMode                                       (live)
//   2 Identity  callsign + locator in EEPROM
//   3 Radio     a slot that is set up -- for LAN that means the model the radio
//               reported, which rememberRadioModel() persists and which is the
//               only durable proof a login ever succeeded
//   4 Transmit  an entry in /txgain.json
//   5 Browser   a log database in THIS browser (per-origin, unlike 1-4)
//
// Two axes, not one. A tick means "set up, and verified once"; the dot beside it
// means "reachable right now". A radio that is switched off must never turn its
// step red -- the setup did not break, the radio is off -- so a tick is never
// taken back automatically. That is also why step 4 is advice and not a gate:
// without a calibration JS8 and WSPR still transmit, just worse.
//
// Like lan-gate.js and wake-lock.js this carries its own markup and CSS, so
// putting it on a page is one script tag and one call.

(function (root) {
  "use strict";

  var CSS = ""
    + ".spine{margin:0 0 22px;padding:0;list-style:none;border:1px solid #24413b;border-radius:7px;overflow:hidden}"
    + ".spine-step{margin:0;border-top:1px solid #24413b}"
    + ".spine-step:first-child{border-top:0}"
    + ".spine-head{display:grid;grid-template-columns:26px 1fr auto;gap:10px;align-items:center;width:100%;"
    + "padding:11px 13px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}"
    + ".spine-head:hover,.spine-head:focus-visible{background:#0e1c19;outline:none}"
    + ".spine-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;"
    + "border:1px solid #3d675e;background:#081310;color:#7e918b;font-size:12px;font-weight:900}"
    + ".spine-step[data-state=done] .spine-mark{border-color:#3f9d6a;background:#12291f;color:#66d69a}"
    + ".spine-step[data-state=todo] .spine-mark{border-color:#e0a020;background:#231803;color:#e0a020}"
    + ".spine-step[data-state=blocked] .spine-mark{border-color:#5c6b66;color:#5c6b66}"
    + ".spine-step[data-state=na] .spine-mark{border-color:#2c3d38;color:#465651}"
    + ".spine-title{min-width:0}"
    + ".spine-name{display:block;font-size:12px;font-weight:850;letter-spacing:.08em;text-transform:uppercase;color:#d9e7e2}"
    + ".spine-step[data-state=na] .spine-name{color:#7e918b}"
    + ".spine-detail{display:block;margin-top:2px;font-size:12px;color:#7e918b;overflow-wrap:anywhere}"
    + ".spine-step[data-state=todo] .spine-detail{color:#e0a020}"
    + ".spine-live{font-size:11px;color:#7e918b;white-space:nowrap}"
    + ".spine-live::before{content:'\\25CF';margin-right:4px;color:#465651}"
    + ".spine-live[data-live=up]::before{color:#66d69a}"
    + ".spine-live[data-live=down]::before{color:#e0a020}"
    + ".spine-body{padding:0 13px 13px 49px}"
    + ".spine-body p{margin:0 0 9px;font-size:12px;line-height:1.55;color:#8ba59d}"
    + ".spine-body p:last-child{margin-bottom:0}"
    + ".spine-body b{color:#d9e7e2}"
    + ".spine-act{display:inline-block;margin-top:2px;padding:7px 11px;border:1px solid #3d675e;border-radius:4px;"
    + "background:#0d1f1b;color:#9fe8d2;font:inherit;font-size:12px;font-weight:850;text-decoration:none;cursor:pointer}"
    + ".spine-act:hover,.spine-act:focus-visible{border-color:#66f2d5;color:#fff;outline:none}"
    // The way out of a step is not one of its actions. Three buttons of equal
    // weight is how a two-step job starts looking like a three-step one.
    + ".spine-act-quiet{margin-top:9px;border-color:#25403a;background:transparent;color:#7e918b;font-weight:800}"
    + ".spine-act-quiet:hover,.spine-act-quiet:focus-visible{border-color:#3d675e;color:#d9e7e2}"
    + ".spine-warn{color:#e0a020!important}"
    + ".spine-ok{color:#66d69a!important}"
    + ".spine-bad{color:#e06c5a!important}"
    // The radio step's own workshop: model buttons, the menu steps they produce,
    // and the credentials -- deliberately in the same block as the instruction
    // that tells the operator to invent them, so they are typed once, at the
    // radio, instead of being carried back to the keyboard in someone's head.
    + ".spine-models{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px}"
    + ".spine-model{padding:5px 10px;border:1px solid #3d675e;border-radius:4px;background:#081310;"
    + "color:#d9e7e2;font:inherit;font-size:12px;font-weight:800;cursor:pointer}"
    + ".spine-model:hover,.spine-model:focus-visible{border-color:#66f2d5;color:#fff;outline:none}"
    + ".spine-model[aria-pressed=true]{border-color:#66f2d5;background:#15332d;color:#66f2d5}"
    + ".spine-steps{margin:0 0 11px;padding-left:19px;color:#8ba59d;font-size:12px;line-height:1.6}"
    + ".spine-steps li{margin:4px 0}"
    + ".spine-steps code{padding:1px 4px;border-radius:3px;background:#0e1c19;color:#9fe8d2}"
    + ".spine-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:0 0 11px}"
    + ".spine-fields label{display:block;font-size:11px;font-weight:800;letter-spacing:.05em;"
    + "text-transform:uppercase;color:#7e918b}"
    + ".spine-fields input{width:100%;margin-top:3px;padding:7px 8px;border:1px solid #2c4a43;"
    + "border-radius:4px;background:#050d0b;color:#d9e7e2;font:inherit;font-size:13px}"
    + ".spine-fields input:focus{border-color:#66f2d5;outline:none}"
    + ".spine-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 9px}"
    + ".spine-hits{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}"
    + ".spine-hit{padding:5px 9px;border:1px solid #3d675e;border-radius:4px;background:#0d1f1b;"
    + "color:#9fe8d2;font:inherit;font-size:12px;font-weight:800;cursor:pointer}"
    + ".spine-hit:hover{border-color:#66f2d5;color:#fff}"
    + ".spine-note{font-size:12px;line-height:1.5;color:#8ba59d}"
    // Steps 1 and 2 do not link to a panel any more, they CONTAIN it. The
    // section is MOVED in, never copied, so the document still holds exactly one
    // WiFi form and one identity form and no two of them can drift apart. Inside
    // a step its own <summary> would be a second accordion wrapped around one
    // that is already open, so it goes; the frame goes with it, because the step
    // is the frame.
    // Two ways to swallow a section. `bare` is for the ones a step IS -- the
    // WiFi fields, the callsign -- where the step's own head is already the
    // title and a second accordion round an open one is just furniture. Step 3
    // keeps its panel foldable, because there the guided walk is the step and
    // the full editor is the escape hatch under it.
    + ".spine-body > .setup-section{margin:0 0 11px}"
    + ".spine-body > .setup-section[data-spine-bare]{border:0;border-radius:0;overflow:visible}"
    + ".spine-body > .setup-section[data-spine-bare] > .setup-section-title{display:none}"
    + ".spine-body > .setup-section[data-spine-bare] > .setup-section-body{padding:0;border-top:0}"
    // The way on. One per step, always the last thing in it, always the same
    // shape -- so "what do I press now" is answered by position, not by reading.
    + ".spine-next{display:flex;flex-wrap:wrap;gap:9px;align-items:center;margin-top:11px;"
    + "padding-top:11px;border-top:1px solid #1b322c}"
    // An explicit display beats the UA's rule for [hidden], so the hidden state
    // has to be said outright -- otherwise CONTINUE shows on a step that is not
    // finished, which is an invitation to skip it.
    + ".spine-next[hidden]{display:none}"
    // Inside a step the panel is a column narrower than the page it came from,
    // and its title carries two badges. Let them wrap instead of running off.
    + ".spine-body > .setup-section > .setup-section-title{flex-wrap:wrap}"
    + ".spine-next .spine-act{margin-top:0}"
    + ".spine-act-go{border-color:#3f9d6a;background:#12291f;color:#8ff0bd}"
    + ".spine-act-go:hover,.spine-act-go:focus-visible{border-color:#66f2d5;color:#fff}"
    + ".spine-act[disabled]{opacity:.5;cursor:progress}"
    // The same five steps, one line high, for the pages that are not SETUP. The
    // transmit check is the only step an operator can finish from DATA or WSPR
    // -- the other four live in SETUP -- so this says which one is outstanding
    // and gets out of the way the moment it is not.
    + ".spine-banner{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;"
    + "margin:0 0 10px;padding:8px 13px;border:1px solid #674a30;border-radius:6px;"
    + "background:#1d1609;color:#e8d9bf;font-size:12px;line-height:1.5}"
    + ".spine-banner[hidden]{display:none}"
    + ".spine-banner b{color:#fff}"
    + ".spine-banner-step{padding:2px 7px;border:1px solid #8a572b;border-radius:999px;"
    + "color:#e0a020;font-size:11px;font-weight:850;white-space:nowrap}"
    + ".spine-banner .spine-act{margin:0;padding:5px 10px;border-color:#8a572b;"
    + "background:#352311;color:#ffd49a}"
    + ".spine-banner .spine-act:hover{border-color:#e0a020;color:#fff}"
    + ".spine-banner-dismiss{margin-left:auto;border:0;background:transparent;"
    + "color:#8a7256;font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 2px}"
    + ".spine-banner-dismiss:hover{color:#e8d9bf}"
    // An explicit display wins over the hidden attribute's UA rule, so the
    // hidden state has to be said outright wherever one is set.
    + ".spine[hidden]{display:none}"
    // No exits row of its own: the page's own tab bar already carries QRPLog,
    // DATA and LOGSYNC, so an unfinished spine is a home page you can walk away
    // from, not a wizard that traps you.
    + "@media (max-width:560px){.spine-head{grid-template-columns:26px 1fr;gap:9px}"
    + ".spine-live{grid-column:2;justify-self:start}.spine-body{padding-left:13px}}";

  var GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function injectStyle(doc) {
    if (doc.getElementById("setupSpineStyle")) return;
    var style = doc.createElement("style");
    style.id = "setupSpineStyle";
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  // ---- derivation ---------------------------------------------------------
  // Every function below answers one question from one fact. None of them may
  // remember anything between calls.

  function slotOf(data, index) {
    var p = "trx" + (index + 1);
    return {
      index: index,
      label: data[p + "label"] || p.toUpperCase(),
      enabled: index === 0 || data[p + "enabled"] === true,
      transport: String(data[p + "transport"] || "").toLowerCase(),
      lanIp: (data[p + "lanip"] || "").trim(),
      lanUser: (data[p + "lanuser"] || "").trim(),
      lanPass: (data[p + "lanpass"] || "").trim(),
      civAddr: String(data[p + "civaddr"] || "").trim().toUpperCase(),
      netId: String(data[p + "netid"] || "").trim().toUpperCase(),
      model: (data[p + "model"] || "").trim()
    };
  }

  // "Set up" is deliberately stricter for LAN than for the other two. LAN is the
  // only transport that can prove itself: the radio answers with its model and
  // rememberRadioModel() writes it down. CI-V and TrxNet leave no such trace, so
  // there the filled-in address is all the evidence there is.
  function slotSetUp(slot) {
    if (!slot.enabled) return false;
    if (slot.transport === "lan") return slot.model.length > 0;
    if (slot.transport === "civ") return slot.civAddr !== "" && slot.civAddr !== "00";
    if (slot.transport === "trxnet") return slot.netId !== "" && slot.netId !== "00";
    return false;
  }

  function slotHasLanCredentials(slot) {
    return slot.transport === "lan" && slot.enabled
      && slot.lanIp !== "" && slot.lanIp !== "0.0.0.0" && slot.lanUser !== "" && slot.lanPass !== "";
  }

  function transportName(t) {
    return t === "lan" ? "ICOM-LAN" : t === "civ" ? "CI-V" : t === "trxnet" ? "TrxNet" : t;
  }

  function countCalibrations(txgain) {
    var entries = txgain && txgain.entries;
    if (!entries || typeof entries !== "object") return null;
    var bands = {}, powers = {}, total = 0;
    Object.keys(entries).forEach(function (key) {
      var parts = key.split("|");
      if (parts.length < 3) return;
      bands[parts[1]] = true;
      powers[parts[2]] = true;
      total++;
    });
    if (!total) return null;
    return {total: total, bands: Object.keys(bands).length, powers: Object.keys(powers).length};
  }

  function derive(state) {
    var data = state.data || {};
    var slots = [0, 1, 2].map(function (i) { return slotOf(data, i); });
    var radio = null, lanSlot = null;
    slots.forEach(function (slot) {
      if (!radio && slotSetUp(slot)) radio = slot;
      if (!lanSlot && slot.transport === "lan" && slot.enabled) lanSlot = slot;
    });
    var call = (data.dxccall || "").trim();
    var grid = (data.dxclocator || "").trim();
    var cal = countCalibrations(state.txgain);

    return {
      slots: slots,
      radio: radio,
      lanSlot: lanSlot,
      network: {done: data.apMode !== true, ssid: (data.ssid || "").trim()},
      identity: {done: call !== "" && GRID_RE.test(grid), call: call, grid: grid,
                 compound: call.indexOf("/") >= 0},
      transmit: {done: !!cal, cal: cal, possible: !!lanSlot},
      browser: state.browser
    };
  }

  // ---- rendering ----------------------------------------------------------

  function buildStep(number, name) {
    var step = el("li", "spine-step");
    var head = el("button", "spine-head");
    head.type = "button";
    head.setAttribute("aria-expanded", "false");
    var mark = el("span", "spine-mark");
    var title = el("div", "spine-title");
    title.appendChild(el("span", "spine-name", number + " · " + name));
    var detail = el("span", "spine-detail");
    title.appendChild(detail);
    var live = el("span", "spine-live");
    live.hidden = true;
    head.appendChild(mark);
    head.appendChild(title);
    head.appendChild(live);
    var body = el("div", "spine-body");
    body.hidden = true;
    step.appendChild(head);
    step.appendChild(body);
    head.addEventListener("click", function () {
      var open = body.hidden;
      body.hidden = !open;
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });
    return {node: step, mark: mark, detail: detail, live: live, body: body, head: head};
  }

  function setState(step, state, markText) {
    step.node.setAttribute("data-state", state);
    step.mark.textContent = markText;
  }

  function action(label, onClick) {
    var button = el("button", "spine-act", label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function link(label, href) {
    var a = el("a", "spine-act", label);
    a.href = href;
    return a;
  }

  function paragraph(html) {
    var p = document.createElement("p");
    p.innerHTML = html;
    return p;
  }

  function create(options) {
    var host = options.host;
    var openSection = options.openSection || function () {};
    var doc = host.ownerDocument;
    injectStyle(doc);

    var state = {data: null, txgain: null, live: null, browser: null, openIndex: undefined};

    var list = el("ol", "spine");
    var steps = [
      buildStep(1, "Network"),
      buildStep(2, "Identity"),
      buildStep(3, "Radio"),
      buildStep(4, "Transmit check"),
      buildStep(5, "This browser")
    ];
    steps.forEach(function (step) { list.appendChild(step.node); });

    host.appendChild(list);

    // Which step is open is the operator's choice the moment they make one, and
    // it has to survive the five-second live poll. Without this the render that
    // follows the poll slams a hand-opened step shut again, which reads as the
    // page fighting back. -1 means "they closed the last one on purpose".
    steps.forEach(function (step, index) {
      // buildStep's own listener has already flipped the body by the time this
      // runs, so it reads the state that resulted rather than the one before.
      step.head.addEventListener("click", function () {
        state.openIndex = step.body.hidden ? -1 : index;
      });
    });

    // The way on: one step open at a time, scrolled to, and pinned. Steps are
    // short enough that the head landing at the top of the viewport puts the
    // whole of the next one in view -- which is the point, because scrolling to
    // find the next thing to do was the thing that made this page a maze.
    function openStep(index) {
      state.openIndex = index;
      steps.forEach(function (step, i) {
        step.body.hidden = i !== index;
        step.head.setAttribute("aria-expanded", i === index ? "true" : "false");
      });
      try {
        steps[index].head.scrollIntoView({behavior: "smooth", block: "start"});
      } catch (e) {
        steps[index].head.scrollIntoView();
      }
    }

    // A section that has been moved into a step is inside a hidden body whenever
    // that step is closed, and `details.open = true` on something hidden shows
    // nothing and focuses nothing. Anything sending the operator to a field has
    // to open the step first, so it asks here where the field went.
    function revealSection(id) {
      if (!(id in adopted)) return false;
      openStep(adopted[id]);
      return true;
    }

    // What the device says it stored, not what was typed into the fields.
    function refresh() {
      return fetch("/setup-data.json", {cache: "no-store"})
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data) setData(data); })
        .catch(function () {});
    }

    // Steps 1 and 2 used to end in a link that scrolled somewhere else, which is
    // how a five-step page turned into a page you had to already know. They now
    // carry the fields themselves, so the body cannot be thrown away and rebuilt
    // on every five-second tick the way the other three are: it is built once,
    // and only the prose, the badge and the button label are rewritten.
    //
    // The panel is MOVED in, not copied. Two copies of the callsign field would
    // be two answers to the same question, and only one of them would be saved.
    // sectionId -> the step that swallowed it, so anything that wants to send
    // the operator to a field can still find out where it ended up.
    var adopted = {};

    // `bare` strips the section's own accordion: the step's head is the title
    // and the panel is the step. Without it the panel stays foldable, which is
    // what step 3 wants -- the guided walk is the step there, and the full
    // editor sits under it for the cases the walk does not cover.
    function adoptInto(step, sectionId, bare) {
      var panel = options.adopt ? options.adopt(sectionId) : null;
      if (!panel) return null;
      // A bare panel has no way of being opened -- its summary is gone -- so it
      // is forced open. A foldable one keeps whatever the page decided: the
      // radio editor opens itself when the config is incomplete, and adoption
      // must not quietly shut it again.
      if (bare) {
        if (panel.tagName === "DETAILS") panel.open = true;
        panel.setAttribute("data-spine-bare", "");
      }
      step.body.appendChild(panel);
      adopted[sectionId] = steps.indexOf(step);
      return panel;
    }

    function buildPanelStep(step, sectionId, fallbackLabel) {
      var work = {lead: paragraph(""), extra: paragraph(""), panel: null};
      step.body.innerHTML = "";
      step.body.appendChild(work.lead);
      work.extra.hidden = true;
      step.body.appendChild(work.extra);
      work.panel = adoptInto(step, sectionId, true);
      var row = el("div", "spine-next");
      work.act = el("button", "spine-act spine-act-go", "CONTINUE");
      work.act.type = "button";
      row.appendChild(work.act);
      work.note = el("span", "spine-note");
      row.appendChild(work.note);
      step.body.appendChild(row);
      // Only if the move did not happen: an operator on a page whose panel the
      // spine could not take over still needs a way to the fields.
      if (!work.panel) {
        var escape = action(fallbackLabel, function () { openSection(sectionId); });
        escape.className = "spine-act spine-act-quiet";
        row.appendChild(escape);
      }
      return work;
    }

    // A step's button is the one place where "saved" and "did not save" both
    // have to be visible, so every one of them goes through here.
    function runStep(work, label, busyText, promise, onDone) {
      work.act.disabled = true;
      work.act.textContent = busyText;
      work.note.className = "spine-note";
      work.note.textContent = "";
      promise.then(function (value) {
        work.act.disabled = false;
        work.act.textContent = label;
        onDone(value);
      }).catch(function (err) {
        work.act.disabled = false;
        work.act.textContent = label;
        work.note.className = "spine-note spine-bad";
        work.note.textContent = (err && err.message === "locator")
          ? "The locator above was not accepted — nothing was saved."
          : "Saving failed. Check that the interface is still reachable, then try again.";
      });
    }

    var networkWork = null, identityWork = null;

    function fillNetwork(step, model) {
      var d = model.network;
      if (!networkWork) {
        networkWork = buildPanelStep(step, "wifiSection", "OPEN WIFI SETTINGS");
        networkWork.act.addEventListener("click", function () {
          // In AP mode the step does not end in a save, it ends in a handover:
          // the device joins the router while its own hotspot is still up and
          // shows the address it was given. That flow takes the page over, so it
          // belongs to the page and not here.
          if (!derive(state).network.done && options.joinNetwork) {
            options.joinNetwork();
            return;
          }
          runStep(networkWork, "SAVE AND CONTINUE", "Saving…",
            options.save ? options.save() : Promise.resolve(), function () { openStep(1); });
        });
      }
      if (d.done) {
        setState(step, "done", "✓");
        step.detail.textContent = (d.ssid ? d.ssid + " · " : "") + location.hostname;
        networkWork.lead.innerHTML = "The interface is on your network. Give it a fixed lease in "
          + "your router and this address stops moving. Changing the network below takes effect "
          + "on the next restart.";
        networkWork.extra.hidden = true;
        if (!networkWork.act.disabled) networkWork.act.textContent = "SAVE AND CONTINUE";
        return;
      }
      setState(step, "todo", "1");
      step.detail.textContent = "AP mode — the device is showing its own hotspot";
      networkWork.lead.innerHTML = "Enter the network name and password of your router. The device "
        + "joins it while this hotspot is still running, then shows the address it was given "
        + "<b>with a QR code</b> — that is the address to use from then on.";
      networkWork.extra.hidden = false;
      networkWork.extra.innerHTML = "Fill in the callsign in step 2 before pressing this: everything "
        + "on this page is saved together, and the hotspot goes away at the end of the handover.";
      if (!networkWork.act.disabled) networkWork.act.textContent = "SAVE AND JOIN THE NETWORK";
    }

    function fillIdentity(step, model) {
      var d = model.identity;
      if (!identityWork) {
        identityWork = buildPanelStep(step, "identitySection", "OPEN IDENTITY SETTINGS");
        identityWork.act.addEventListener("click", function () {
          runStep(identityWork, "SAVE AND CONTINUE", "Saving…",
            options.save ? options.save() : Promise.resolve(), function () {
              // The device is the authority on what was stored, so the tick comes
              // from re-reading it rather than from the fields having been typed.
              refresh();
              openStep(2);
            });
        });
      }
      if (d.done) {
        setState(step, "done", "✓");
        step.detail.textContent = d.call + " · " + d.grid;
      } else {
        setState(step, "todo", "2");
        step.detail.textContent = !d.call ? "no callsign yet"
          : !d.grid ? "no locator yet" : "locator " + d.grid + " is not a valid Maidenhead square";
      }
      // The panel carries this sentence itself, so with the panel moved in the
      // step's own lead would be the same thing said twice in a row.
      identityWork.lead.hidden = !!identityWork.panel;
      identityWork.lead.innerHTML = "Your callsign and locator. The DX cluster logs in with them, "
        + "and they are what the logbook and the digital modes put on the air.";
      if (d.compound) {
        identityWork.extra.hidden = false;
        identityWork.extra.innerHTML = "<span class=\"spine-warn\">" + d.call
          + " is a compound callsign. JS8 and the cluster take it as it is, but the WSPR beacon "
          + "cannot encode it — that needs a message type this version does not build.</span>";
      } else {
        identityWork.extra.hidden = true;
      }
    }

    // The radio step is the only one with real work in it, so its body is built
    // ONCE and then only shown or hidden. Rebuilding it on every render -- and
    // there is one every five seconds while the live dot polls -- would wipe a
    // password out from under the operator mid-typing.
    var radioWork = null;

    function modelRow(number) {
      var Models = root.IcomModels;
      if (!Models || !number) return null;
      return Models.models().filter(function (m) { return m.number === number; })[0] || null;
    }

    // Only the steps that lead to a login. The data mode, the modulator input
    // and the PRESET belong to the transmit check, where they can be verified
    // instead of merely instructed -- and where a shorter list here means the
    // first tick arrives after three actions rather than eight.
    function connectionSteps(row) {
      var net = row ? row.net : "LAN";
      var menu = row ? row.netMenu : "the radio's network settings";
      var steps = [];
      if (net === "WLAN") {
        steps.push("On the radio: <code>MENU → SET → WLAN Set</code> — set <code>WLAN</code> to "
          + "<b>ON</b>, <code>Connection Type</code> to <b>Station</b>, and under "
          + "<code>Access Point</code> pick the same network this interface is on.");
      } else {
        steps.push("Connect an Ethernet cable from the radio to the same router as this interface, "
          + "and leave <code>DHCP</code> <b>ON</b>.");
      }
      steps.push("In <code>" + menu + "</code>: set <code>Network Control</code> to <b>ON</b>, then "
        + "invent a <b>Network User ID</b> and password — and type them in below straight away.");
      steps.push("Leave <code>DHCP</code> <b>ON</b>. The address does not have to be read off the "
        + "radio: <b>FIND RADIO</b> sweeps the network for it.");
      return steps;
    }

    function buildRadioWork() {
      var box = document.createElement("div");
      var lead = paragraph("");
      box.appendChild(lead);

      var models = el("div", "spine-models");
      models.appendChild(el("span", "spine-note", "Which radio?"));
      box.appendChild(models);

      var stepList = el("ol", "spine-steps");
      box.appendChild(stepList);

      var fields = el("div", "spine-fields");
      function labelled(text, type) {
        var label = el("label", null, text);
        var input = document.createElement("input");
        input.type = type || "text";
        input.autocomplete = "off";
        label.appendChild(input);
        fields.appendChild(label);
        return input;
      }
      var userInput = labelled("Network user");
      var passInput = labelled("Password", "password");
      var ipInput = labelled("Radio address");
      box.appendChild(fields);

      var findRow = el("div", "spine-row");
      var findButton = el("button", "spine-act", "FIND RADIO");
      findButton.type = "button";
      var findNote = el("span", "spine-note");
      findRow.appendChild(findButton);
      findRow.appendChild(findNote);
      box.appendChild(findRow);

      var hits = el("div", "spine-hits");
      box.appendChild(hits);

      var verifyRow = el("div", "spine-row");
      var verifyButton = el("button", "spine-act", "VERIFY");
      verifyButton.type = "button";
      var verdict = el("span", "spine-note");
      verifyRow.appendChild(verifyButton);
      verifyRow.appendChild(verdict);
      box.appendChild(verifyRow);

      var work = {
        node: box, lead: lead, models: models, stepList: stepList,
        user: userInput, pass: passInput, ip: ipInput,
        findButton: findButton, findNote: findNote, hits: hits,
        verifyButton: verifyButton, verdict: verdict,
        chosen: null, stopScan: null, stopTest: null, seeded: false
      };

      var Models = root.IcomModels;
      var rows = Models ? Models.models() : [];
      rows.forEach(function (row) {
        var button = el("button", "spine-model", row.label);
        button.type = "button";
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", function () { chooseModel(work, row.number); });
        models.appendChild(button);
        button.dataset.model = String(row.number);
      });
      var unknown = el("button", "spine-model", "other / not sure");
      unknown.type = "button";
      unknown.setAttribute("aria-pressed", "false");
      unknown.dataset.model = "0";
      unknown.addEventListener("click", function () { chooseModel(work, 0); });
      models.appendChild(unknown);

      findButton.addEventListener("click", function () { runScan(work); });
      verifyButton.addEventListener("click", function () { runVerify(work); });
      return work;
    }

    function chooseModel(work, number) {
      work.chosen = number;
      [].forEach.call(work.models.querySelectorAll("[data-model]"), function (button) {
        button.setAttribute("aria-pressed", button.dataset.model === String(number) ? "true" : "false");
      });
      work.stepList.innerHTML = "";
      connectionSteps(modelRow(number)).forEach(function (text) {
        var item = document.createElement("li");
        item.innerHTML = text;
        work.stepList.appendChild(item);
      });
      if (!number) {
        var note = document.createElement("li");
        note.className = "spine-warn";
        note.textContent = "Unrecognised radio — these are the steps every network-capable Icom "
          + "needs; the menu names may differ.";
        work.stepList.appendChild(note);
      }
    }

    function runScan(work) {
      if (!root.IcomDiscovery) return;
      if (work.stopScan) work.stopScan();
      work.hits.innerHTML = "";
      work.findNote.className = "spine-note";
      work.findNote.textContent = "Sweeping the network…";
      work.stopScan = root.IcomDiscovery.startScan({
        onUpdate: function (scan) {
          if (scan.state === "running") work.findNote.textContent = scan.scanned + "/" + scan.total;
          work.hits.innerHTML = "";
          (scan.found || []).forEach(function (found) {
            var hit = el("button", "spine-hit", found.ip + "  ·  use");
            hit.type = "button";
            hit.addEventListener("click", function () { work.ip.value = found.ip; });
            work.hits.appendChild(hit);
          });
        },
        onDone: function (scan) {
          var found = (scan.found || []).length;
          if (found) {
            work.findNote.textContent = found === 1 ? "one radio answered" : found + " radios answered";
            if (found === 1 && !work.ip.value.trim()) work.ip.value = scan.found[0].ip;
            return;
          }
          work.findNote.className = "spine-note spine-warn";
          work.findNote.textContent = root.IcomDiscovery.emptyScanAdvice(scan, {
            ssid: state.data && state.data.ssid, address: location.hostname
          });
        },
        onRefused: function (text) {
          work.findNote.className = "spine-note spine-warn";
          work.findNote.textContent = text;
        },
        onError: function () {
          work.findNote.className = "spine-note spine-bad";
          work.findNote.textContent = "The device did not answer the scan.";
        }
      });
    }

    function runVerify(work) {
      if (!root.IcomDiscovery) return;
      var ip = work.ip.value.trim(), user = work.user.value.trim(), pass = work.pass.value;
      if (!ip || !user || !pass) {
        work.verdict.className = "spine-note spine-warn";
        work.verdict.textContent = "Address, user and password first.";
        return;
      }
      if (work.stopTest) work.stopTest();
      work.verdict.className = "spine-note";
      work.verdict.textContent = "Logging in…";
      var row = modelRow(work.chosen);
      work.stopTest = root.IcomDiscovery.startTest({
        ip: ip, user: user, pass: pass,
        civaddr: row ? row.civAddr : "A4",
        slot: 1
      }, {
        onUpdate: function (verdict) { work.verdict.textContent = verdict.text; },
        onDone: function (verdict, detected) {
          work.verdict.className = "spine-note " + (verdict.ok ? "spine-ok" : "spine-bad");
          work.verdict.textContent = verdict.text;
          if (!verdict.ok) return;
          // The radio has answered, so the firmware has already written the model
          // down. What is still only in this form is the address and the login --
          // save those and let the running client pick them up. No restart: the
          // step ends in a working link, not in a reboot.
          if (options.applyRadio) options.applyRadio({
            transport: "lan", ip: ip, user: user, pass: pass,
            civaddr: (row ? row.civAddr : "A4"),
            detected: detected || ""
          });
          var saved = options.save ? options.save() : Promise.resolve();
          saved.then(function () {
            return fetch("/lan/reconnect", {method: "POST"}).catch(function () {});
          }).then(function () {
            return fetch("/setup-data.json", {cache: "no-store"}).then(function (r) { return r.json(); });
          }).then(function (data) {
            setData(data);
            // The radio answered and the settings are stored, so this step is
            // over -- move on instead of leaving the operator on a green step
            // wondering whether that was all of it.
            openStep(3);
          }).catch(function () {
            work.verdict.className = "spine-note spine-warn";
            work.verdict.textContent = verdict.text + " Saving the settings failed — "
              + "open the Radio section and save there.";
          });
        },
        onRefused: function (text) {
          work.verdict.className = "spine-note spine-warn";
          work.verdict.textContent = text;
        },
        onError: function () {
          work.verdict.className = "spine-note spine-bad";
          work.verdict.textContent = "The device did not answer the test.";
        }
      });
    }

    // Step 3 is built once for the same reason steps 1 and 2 are: it carries the
    // Radio section itself now, and a body rebuilt on every tick would tear that
    // panel back out of the document -- along with whatever was half-typed in it.
    // The three states show and hide pieces instead of replacing them.
    var radioBody = null;

    function buildRadioBody(step) {
      step.body.innerHTML = "";
      var blocked = paragraph(
        "The radio lives on your home network, so it cannot be reached or searched for while the "
        + "device is still showing its own hotspot. Finish step 1 first.");
      step.body.appendChild(blocked);
      var doneLead = paragraph("");
      step.body.appendChild(doneLead);

      radioWork = buildRadioWork();
      step.body.appendChild(radioWork.node);
      radioWork.lead.innerHTML = "Two things have to happen on the radio itself, and one of them "
        + "is a user and password you make up. <b>VERIFY</b> is what completes this step: it logs "
        + "in once and reads the model back, which is the proof that everything in between works.";
      chooseModel(radioWork, 0);

      // The full editor, folded, under the guided walk. It is the same section
      // that used to be a page-length scroll below -- three slots, the CI-V bus,
      // labels -- and it belongs to this step, so this is where it lives.
      var panel = adoptInto(step, "radioSection", false);

      var nextRow = el("div", "spine-next");
      var go = el("button", "spine-act spine-act-go", "CONTINUE");
      go.type = "button";
      go.addEventListener("click", function () { openStep(3); });
      nextRow.appendChild(go);
      step.body.appendChild(nextRow);

      return {blocked: blocked, doneLead: doneLead, panel: panel, nextRow: nextRow};
    }

    function fillRadio(step, model) {
      if (!radioBody) radioBody = buildRadioBody(step);
      var waiting = !model.network.done;
      var done = !waiting && !!model.radio;

      radioBody.blocked.hidden = !waiting;
      radioBody.doneLead.hidden = !done;
      radioWork.node.hidden = waiting || done;
      if (radioBody.panel) radioBody.panel.hidden = waiting;
      radioBody.nextRow.hidden = !done;

      if (waiting) {
        setState(step, "blocked", "3");
        step.detail.textContent = "waiting for the network";
        return;
      }
      if (done) {
        var slot = model.radio;
        setState(step, "done", "✓");
        step.detail.textContent = slot.label + " · "
          + (slot.model || transportName(slot.transport))
          + (slot.model ? " (" + transportName(slot.transport) + ")" : "");
        radioBody.doneLead.innerHTML = slot.transport === "lan"
          ? "This radio logged in and reported its own model, so the address and credentials are known "
            + "to work. The dot on the right is whether it is answering <b>right now</b> — a radio that "
            + "is switched off does not undo the setup."
          : "Commands only: " + transportName(slot.transport) + " carries no audio, so the digital "
            + "modes and the transmit check are not available on it.";
        return;
      }

      setState(step, "todo", "3");
      var lan = model.lanSlot;
      step.detail.textContent = lan && slotHasLanCredentials(lan)
        ? "address and credentials entered, but the radio has not answered yet"
        : "no radio configured yet";
      // Seed from whatever is already stored, once, so a half-finished setup is
      // continued rather than retyped -- but never over something being typed.
      if (!radioWork.seeded && lan) {
        radioWork.seeded = true;
        if (lan.lanIp && lan.lanIp !== "0.0.0.0") radioWork.ip.value = lan.lanIp;
        if (lan.lanUser) radioWork.user.value = lan.lanUser;
      }
    }

    function fillTransmit(step, model) {
      var d = model.transmit;
      step.body.innerHTML = "";
      if (!d.possible) {
        setState(step, "na", "—");
        step.detail.textContent = "needs a radio on ICOM-LAN";
        step.body.appendChild(paragraph(
          "The transmit check measures how much audio the radio takes before its ALC acts, which "
          + "needs the network audio path. CI-V and TrxNet carry commands only, so there is nothing "
          + "to measure and nothing missing."));
        return;
      }
      if (d.done) {
        setState(step, "done", "✓");
        step.detail.textContent = d.cal.bands + (d.cal.bands === 1 ? " band · " : " bands · ")
          + d.cal.powers + (d.cal.powers === 1 ? " power setting" : " power settings");
      } else if (!model.radio) {
        // Nothing to key yet. Amber here would be an instruction the operator
        // cannot act on, which is exactly what this page exists to stop.
        setState(step, "blocked", "4");
        step.detail.textContent = "waiting for the radio";
        step.body.appendChild(paragraph(
          "This keys the transmitter, so it needs a radio that answers. Finish step 3 first."));
        return;
      } else {
        // Advice, not a gate: without it JS8 and WSPR still transmit, just worse.
        setState(step, "todo", "4");
        step.detail.textContent = "recommended — never measured";
      }
      step.body.appendChild(paragraph(
        "One keyed carrier on the band and power the radio is set to now, raising the audio level "
        + "until the ALC just starts. It proves the whole chain in one go — data mode, audio path, "
        + "PTT, power, SWR — and gives the digital modes the level to use."));
      step.body.appendChild(link("RUN THE TRANSMIT CHECK ↗", "/wspr.html#autogain"));
    }

    function fillBrowser(step, model) {
      step.body.innerHTML = "";
      if (model.browser === true) {
        setState(step, "done", "✓");
        step.detail.textContent = "log database present on this device";
      } else if (model.browser === false) {
        setState(step, "todo", "5");
        step.detail.textContent = "no log on this device yet";
      } else {
        setState(step, "na", "5");
        step.detail.textContent = "this browser will not say";
      }
      step.body.appendChild(paragraph(
        "Steps 1–4 are stored in the interface and are the same on every device. The QSO log is "
        + "different: it lives in <b>this browser</b>, so a second phone or tablet starts without it. "
        + "LOGSYNC copies it across, and keeps them in step afterwards."));
      step.body.appendChild(link("OPEN LOGSYNC ↗", "/datasync"));
    }

    function applyLive(step, model) {
      var slot = model.radio;
      if (!slot || slot.transport !== "lan" || state.live === null) {
        step.live.hidden = true;
        return;
      }
      step.live.hidden = false;
      step.live.setAttribute("data-live", state.live ? "up" : "down");
      step.live.textContent = state.live ? "online" : "not answering";
    }

    function render() {
      if (!state.data) return;
      var model = derive(state);
      fillNetwork(steps[0], model);
      fillIdentity(steps[1], model);
      fillRadio(steps[2], model);
      fillTransmit(steps[3], model);
      fillBrowser(steps[4], model);
      applyLive(steps[2], model);

      // The list is always here. It used to fold itself into one line once the
      // core three were done, which read as the page throwing the structure away
      // the moment it started being worth having: five headings say what a
      // station is made of, and an operator coming back to change one thing
      // needs to see WHICH one -- WiFi, identity, radio -- not a sentence
      // summarising all of them. Bodies still open one at a time; a shut step is
      // a heading you can still read and click.
      //
      // Open the first step that still wants something, so the page always shows
      // the next action without hiding the ones already done -- unless the
      // operator has said which one they want open, in which case that wins
      // until they say otherwise.
      var first = -1;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].node.getAttribute("data-state") === "todo") { first = i; break; }
      }
      var target = state.openIndex === undefined ? first : state.openIndex;
      steps.forEach(function (step, index) {
        step.body.hidden = index !== target;
        step.head.setAttribute("aria-expanded", index === target ? "true" : "false");
      });
    }

    function setData(data) { state.data = data; render(); }

    function loadTxGain() {
      return fetch("/txgain.json", {cache: "no-store"})
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { state.txgain = j; render(); })
        .catch(function () {});
    }

    function loadBrowser() {
      // Opening the database by name would CREATE it, so an empty log would be
      // conjured up by looking. databases() only reports.
      if (!indexedDB || typeof indexedDB.databases !== "function") { state.browser = null; return; }
      try {
        indexedDB.databases().then(function (list) {
          state.browser = (list || []).some(function (db) { return db && db.name === "contestLogDb"; });
          render();
        }).catch(function () { state.browser = null; render(); });
      } catch (e) { state.browser = null; }
    }

    function pollLive() {
      // In AP mode there is no radio to be reachable, so asking once a tick would
      // only be noise on a device that is still being configured.
      if (!state.data || state.data.apMode === true) { state.live = null; return; }
      // LAN may sit on TRX2 or TRX3, and a plain /state always answers for TRX1 --
      // so without ?radio=lan the dot would report a different radio than the one
      // the step is about. lan-gate.js and the DATA pages make the same request.
      var lan = state.data && derive(state).lanSlot;
      fetch(lan ? "/state?radio=lan" : "/state", {cache: "no-store"})
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          state.live = j ? j.connected === true : null;
          render();
        })
        .catch(function () { state.live = null; render(); });
    }

    function start() {
      loadTxGain();
      loadBrowser();
      pollLive();
      setInterval(pollLive, 5000);
    }

    return {setData: setData, start: start, render: render,
            openStep: openStep, revealSection: revealSection, refresh: refresh};
  }

  // ---- the one-line form, for DATA and WSPR --------------------------------
  //
  // Decision 8 of the plan: the transmit check cannot be done on SETUP -- that
  // page has no TX stack and no session -- so the operator leaves the spine in
  // the middle of the one step that is long, physical and takes them away from
  // the keyboard. Losing the thread there is exactly what the spine exists to
  // prevent, so the spine follows them.
  //
  // It is a banner and not the accordion because these pages are already dense,
  // and because four of the five steps cannot be acted on from here anyway: the
  // LAN gate would not have let this page open at all without a configured
  // radio. So it says the one outstanding thing and disappears when there is
  // none.
  function createBanner(options) {
    var host = options.host;
    if (!host) return null;
    injectStyle(host.ownerDocument);

    var node = el("div", "spine-banner");
    node.hidden = true;
    var badge = el("span", "spine-banner-step");
    var text = el("span");
    node.appendChild(badge);
    node.appendChild(text);
    host.insertBefore(node, host.firstChild);

    var dismissed = false;

    function show(step, message, actionLabel, onAction) {
      node.innerHTML = "";
      badge.textContent = step;
      node.appendChild(badge);
      text.innerHTML = message;
      node.appendChild(text);
      if (actionLabel) {
        var act = el("button", "spine-act", actionLabel);
        act.type = "button";
        act.addEventListener("click", onAction);
        node.appendChild(act);
      }
      // Dismissable for this page view only, never stored: a banner that can be
      // silenced for good is a banner that stops meaning anything, and the state
      // it reports is derived, so it comes back by itself when it is still true.
      var close = el("button", "spine-banner-dismiss", "×");
      close.type = "button";
      close.title = "Hide until the page is reloaded";
      close.addEventListener("click", function () { dismissed = true; node.hidden = true; });
      node.appendChild(close);
      node.hidden = false;
    }

    function refresh() {
      if (dismissed) return;
      Promise.all([
        fetch("/setup-data.json", {cache: "no-store"}).then(function (r) { return r.ok ? r.json() : null; }),
        fetch("/txgain.json", {cache: "no-store"}).then(function (r) { return r.ok ? r.json() : null; })
      ]).then(function (both) {
        var data = both[0];
        if (!data) return;
        var model = derive({data: data, txgain: both[1], browser: null});
        if (!model.identity.done) {
          show("Step 2 of 5", "This station has no callsign yet — everything transmitted from "
            + "here needs one.", "OPEN SETUP", function () { location.href = "/setup"; });
          return;
        }
        if (model.transmit.possible && !model.transmit.done) {
          show("Step 4 of 5", "<b>The transmit check has never been run.</b> One keyed carrier "
            + "measures how much audio this radio takes before its ALC acts — until then the "
            + "digital modes are guessing at the level.",
            options.onCalibrate ? "MEASURE IT HERE" : null, options.onCalibrate);
          return;
        }
        node.hidden = true;
      }).catch(function () {});
    }

    return {refresh: refresh, element: node};
  }

  var api = {create: create, slotSetUp: slotSetUp, countCalibrations: countCalibrations, derive: derive, createBanner: createBanner};
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SetupSpine = api;
}(typeof globalThis !== "undefined" ? globalThis : self));
