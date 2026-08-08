// Finding a radio on the network, and proving the credentials work.
//
// Both are two-step conversations with the firmware -- POST to start, then poll
// a status document -- and both are now wanted in two places: the setup spine,
// where finding the radio is the main action of the step, and the expert Radio
// section, where it has always been. This module is the conversation with no
// opinion about where the answer is drawn, so there is one copy of the polling,
// one copy of the refusal wording, and one copy of what an empty sweep means.
//
// The firmware runs ONE scan and ONE test at a time (they both need UDP 50001,
// which the live LAN client owns), so there is no per-slot state to keep here
// either -- the caller says which slot it is asking about and gets told what
// happened.

(function (root) {
  "use strict";

  // Why the device said no. These come back as short codes so the wording can
  // live with the operator-facing text rather than in the firmware.
  function refusalText(code) {
    if (code === "ap") return "Not available in AP mode — the radio lives on your home network.";
    if (code === "no_wifi") return "No network connection.";
    if (code === "busy") return "A scan or test is already running.";
    if (code === "tx") return "Not while the radio is transmitting.";
    return "Device refused the request.";
  }

  // The verdict of one login attempt. A successful test always knows the model:
  // it arrives in the radio's capabilities packet, before the login completes.
  function testVerdict(state, model) {
    if (state === "ok") {
      return {
        ok: true,
        text: model ? "Logged in — radio identifies as " + model + "." : "Radio accepted the login.",
        cls: "is-ok"
      };
    }
    if (state === "bad_credentials")
      return {ok: false, text: "Radio refused the username or password.", cls: "is-bad"};
    if (state === "no_answer")
      return {ok: false, text: "No answer from that address.", cls: "is-bad"};
    return {ok: null, text: "Testing…", cls: ""};
  }

  // An empty sweep is a diagnosis, not a failure -- and the device knows enough
  // to name the two things it is nearly always. Saying only "nothing answered"
  // leaves the operator guessing between "the radio is off the network" and
  // "Network Control is still switched off", which need opposite actions.
  function emptyScanAdvice(scan, context) {
    var where = scan && scan.subnet ? scan.subnet + ".0/24" : "your network";
    var here = context && context.ssid
      ? " (this interface is on “" + context.ssid + "”"
        + (context.address ? ", " + context.address : "") + ")"
      : "";
    return "Nothing answered on UDP 50001 in " + where + ". Most often that means "
      + "Network Control is not switched on in the radio's menu yet, or the radio is "
      + "on a different network than this interface" + here + ".";
  }

  // One poller for both conversations. Returns a stop function; calling it twice
  // is harmless, and every caller is expected to hold on to it -- a poll left
  // running against a page that has moved on is how these turn into ghosts.
  function pollUntilDone(url, intervalMs, onTick, onError) {
    var timer = null, stopped = false;
    function stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    }
    function tick() {
      fetch(url, {cache: "no-store"})
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (stopped) return;
          if (onTick(d) === false) stop();
        })
        .catch(function () { if (!stopped) { stop(); if (onError) onError(); } });
    }
    timer = setInterval(tick, intervalMs);
    tick();
    return stop;
  }

  function begin(url, body, handlers, poll) {
    var options = {method: "POST", cache: "no-store"};
    if (body) {
      options.headers = {"Content-Type": "application/json"};
      options.body = JSON.stringify(body);
    }
    var stop = function () {};
    fetch(url, options)
      .then(function (r) { return r.json().then(function (j) { return {ok: r.ok, data: j}; }); })
      .then(function (res) {
        if (!res.ok) {
          if (handlers.onRefused) handlers.onRefused(refusalText(res.data && res.data.error));
          return;
        }
        stop = poll();
      })
      .catch(function () { if (handlers.onError) handlers.onError(); });
    return function () { stop(); };
  }

  // handlers: onUpdate(scanDoc), onDone(scanDoc), onRefused(text), onError()
  function startScan(handlers) {
    handlers = handlers || {};
    return begin("/icom/scan", null, handlers, function () {
      return pollUntilDone("/icom/scan.json", 900, function (d) {
        if (d.state === "failed") {
          // "the sweep could not start" and "we lost track of the sweep" are
          // different problems, so they are not folded into one callback.
          if (handlers.onFailed) handlers.onFailed();
          else if (handlers.onError) handlers.onError();
          return false;
        }
        if (handlers.onUpdate) handlers.onUpdate(d);
        if (d.state !== "running") {
          if (handlers.onDone) handlers.onDone(d);
          return false;
        }
        return true;
      }, handlers.onError);
    });
  }

  // payload: {ip, user, pass, civaddr, slot}
  // handlers: onUpdate(verdict), onDone(verdict, model), onRefused(text), onError()
  function startTest(payload, handlers) {
    handlers = handlers || {};
    return begin("/icom/test", payload, handlers, function () {
      return pollUntilDone("/icom/test.json", 900, function (d) {
        var verdict = testVerdict(d.state, d.model);
        if (handlers.onUpdate) handlers.onUpdate(verdict, d.model);
        if (d.state !== "running") {
          if (handlers.onDone) handlers.onDone(verdict, d.model);
          return false;
        }
        return true;
      }, handlers.onError);
    });
  }

  var api = {
    refusalText: refusalText,
    testVerdict: testVerdict,
    emptyScanAdvice: emptyScanAdvice,
    startScan: startScan,
    startTest: startTest
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.IcomDiscovery = api;
}(typeof globalThis !== "undefined" ? globalThis : self));
