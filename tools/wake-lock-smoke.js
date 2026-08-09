#!/usr/bin/env node
"use strict";

// Covers data/wake-lock.js without a browser, because no single browser run can
// cover more than one of its branches.
//
// Whether navigator.wakeLock exists at all is decided by the origin, not by the
// code: it is secure-context only, so on http://192.168.x.x it is undefined and
// the video fallback is what really runs. The two browser harnesses each pin down
// one side of that -- data-browser-smoke.js browses the named host wifilt.test and
// asserts the video branch, wspr-browser-smoke.js browses 127.0.0.1 and sees the
// secure one -- but neither can reach a rejected request, a blocked autoplay, an
// iPhone, or a lock the browser takes back on tab switch. Injecting a fake
// navigator and document is the only way to test those.

const fs = require("fs"), path = require("path");
const WakeLock = require("../data/wake-lock.js");

let failures = 0, checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) return true;
  failures++;
  console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  return false;
}
function ok(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
  return false;
}

// ---- minimal DOM ------------------------------------------------------------
//
// Only the handful of calls wake-lock.js makes. A real DOM implementation would
// hide exactly the mistakes this is meant to catch, such as play() being called
// before muted is set.

function makeElement(doc, tag) {
  const element = {
    tagName: tag.toUpperCase(),
    children: [], attributes: {}, style: {cssText: ""}, dataset: {},
    hidden: false, textContent: "", className: "", id: "",
    muted: false, defaultMuted: false, loop: false, playsInline: false,
    paused: true, playCalls: 0, mutedWhenPlayed: null,
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name] : null;
    },
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); },
    removeEventListener(name, fn) {
      this.listeners[name] = (this.listeners[name] || []).filter(entry => entry !== fn);
    },
    dispatch(name, event) { for (const fn of (this.listeners[name] || []).slice()) fn(event); },
    classList: {
      set: new Set(),
      toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); },
      contains(name) { return this.set.has(name); },
    },
    play() {
      this.playCalls++;
      this.mutedWhenPlayed = this.muted;
      if (doc.playRejects) return Promise.reject(new Error("NotAllowedError"));
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.paused = true; },
  };
  element.classList.set = new Set();
  return element;
}

function makeDocument(options = {}) {
  const doc = {
    visibilityState: options.visibilityState || "visible",
    readyState: "complete",
    playRejects: Boolean(options.playRejects),
    created: [],
    listeners: {},
    byId: {},
  };
  doc.createElement = tag => { const element = makeElement(doc, tag); doc.created.push(element); return element; };
  doc.body = makeElement(doc, "body");
  doc.head = makeElement(doc, "head");
  doc.topbar = makeElement(doc, "nav");
  doc.topbar.className = "tabs";
  doc.querySelector = selector =>
    (selector.includes(".tabs") || selector === ".site-topbar") ? doc.topbar : null;
  doc.getElementById = id => doc.byId[id] || null;
  doc.addEventListener = (name, fn) => { (doc.listeners[name] = doc.listeners[name] || []).push(fn); };
  doc.removeEventListener = (name, fn) => {
    doc.listeners[name] = (doc.listeners[name] || []).filter(entry => entry !== fn);
  };
  doc.dispatch = (name, event) => { for (const fn of (doc.listeners[name] || []).slice()) fn(event); };
  doc.videos = () => doc.created.filter(element => element.tagName === "VIDEO");
  return doc;
}

function makeSentinel() {
  const sentinel = {
    released: false, listeners: {},
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); },
    release() { this.released = true; this.dispatch("release"); return Promise.resolve(); },
    dispatch(name) { for (const fn of (this.listeners[name] || []).slice()) fn(); },
  };
  return sentinel;
}

function makeNavigator(options = {}) {
  const nav = {
    userAgent: options.userAgent || "Mozilla/5.0 (Linux; Android 14) Chrome/126",
    platform: options.platform || "Linux armv8l",
    maxTouchPoints: options.maxTouchPoints || 5,
    requests: 0,
  };
  if (options.wakeLock !== false) {
    nav.wakeLock = {
      request: async () => {
        nav.requests++;
        if (options.wakeLockRejects) throw new Error("NotAllowedError");
        nav.sentinel = makeSentinel();
        return nav.sentinel;
      },
    };
  }
  return nav;
}

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/605";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const settle = () => new Promise(resolve => setImmediate(resolve));

// ---- the secure-context path ------------------------------------------------

(async () => {
{
  // What a phone gets only if somebody puts HTTPS in front of the firmware.
  const doc = makeDocument(), nav = makeNavigator();
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  check("wakeLock available: state", keeper.state, "wake-lock");
  check("wakeLock available: accessible name", keeper.label(), "screen on");
  check("wakeLock available: one request", nav.requests, 1);
  ok("wakeLock available: no video is built", doc.videos().length === 0,
    "the fallback must stay dormant when the real API works");
}

{
  // The spec releases the sentinel whenever the document hides. Without the
  // re-acquire the lock is gone for good after the first tab switch, which is
  // exactly the unattended failure this whole feature exists to prevent.
  const doc = makeDocument(), nav = makeNavigator();
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  const sentinel = nav.sentinel;
  doc.visibilityState = "hidden";
  sentinel.dispatch("release");
  check("after the browser releases the lock the state drops", keeper.state, "idle");
  doc.dispatch("visibilitychange");
  await settle();
  check("hidden documents do not re-request", nav.requests, 1);
  doc.visibilityState = "visible";
  doc.dispatch("visibilitychange");
  await settle();
  check("becoming visible re-acquires", keeper.state, "wake-lock");
  check("and that took a second request", nav.requests, 2);
}

// ---- the path production actually takes -------------------------------------

{
  // http://192.168.x.x on Android: no wakeLock at all.
  const doc = makeDocument(), nav = makeNavigator({wakeLock: false});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  check("no wakeLock: falls back to video", keeper.state, "video");
  check("no wakeLock: the accessible name states the fact, not the mechanism",
    keeper.label(), "screen on");
  ok("the tip never mentions HTTPS or wakeLock at the operator",
    !/HTTPS|wakeLock|navigator/i.test(keeper.tip()), keeper.tip());
  const videos = doc.videos();
  check("no wakeLock: exactly one video", videos.length, 1);
  const video = videos[0];
  ok("the video is muted before play() is called", video.mutedWhenPlayed === true,
    "an audible element takes audio focus and posts a media notification");
  ok("the video loops", video.loop === true);
  ok("the video is inline", video.playsInline === true);
  ok("the video is not display:none", !/display\s*:\s*none/.test(video.style.cssText),
    video.style.cssText);
  ok("the video is in the document", doc.body.children.includes(video));
  const sources = video.children.map(child => child.getAttribute("type"));
  check("both containers are offered", sources, ["video/mp4", "video/webm"]);
  ok("the mp4 source is a data URI",
    video.children[0].getAttribute("src").startsWith("data:video/mp4;base64,"));
}

{
  // Headless Chrome has the API but no screen to lock, so request() rejects. A
  // rejected promise must mean "fall through", not "done".
  const doc = makeDocument(), nav = makeNavigator({wakeLockRejects: true});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  check("a rejected wakeLock request falls through to video", keeper.state, "video");
  check("and it did try the real API first", nav.requests, 1);
}

// ---- autoplay refused --------------------------------------------------------

{
  // Low Power Mode and some data-saver modes reject play() on muted video too.
  const doc = makeDocument({playRejects: true});
  const nav = makeNavigator({wakeLock: false});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  check("blocked autoplay asks for a tap", keeper.state, "needs-tap");
  check("blocked autoplay accessible name", keeper.label(), "tap to keep screen on");
  ok("a gesture listener is armed", (doc.listeners.pointerdown || []).length === 1);

  doc.playRejects = false;
  doc.dispatch("pointerdown");
  await settle();
  check("the first tap recovers", keeper.state, "video");
  ok("the gesture listener is gone afterwards",
    (doc.listeners.pointerdown || []).length === 0);
}

// ---- iOS ---------------------------------------------------------------------

{
  // The video trick does nothing on iOS. Playing it anyway would drain the
  // battery and, worse, tell the operator the display is safe when it is not.
  const doc = makeDocument();
  const nav = makeNavigator({wakeLock: false, userAgent: IOS_UA, platform: "iPhone"});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  check("iOS over HTTP is reported honestly", keeper.state, "unavailable");
  check("iOS accessible name", keeper.label(), "screen may sleep");
  ok("iOS gets the Auto-Lock instruction", keeper.tip().includes("Auto-Lock"), keeper.tip());
  check("no video is built on iOS", doc.videos().length, 0);
}

{
  const nav = makeNavigator({userAgent: IOS_UA, platform: "iPhone"});
  ok("an iPhone is detected", WakeLock.isIos(nav));
  ok("iPadOS is detected behind its desktop user agent",
    WakeLock.isIos({userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605",
      platform: "MacIntel", maxTouchPoints: 5}));
  ok("a real Mac is not mistaken for an iPad",
    !WakeLock.isIos({userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605",
      platform: "MacIntel", maxTouchPoints: 0}));
}

// ---- desktop -------------------------------------------------------------------

{
  // Measured on a GNOME desktop 2026-07-27: Chrome held no idle inhibitor for the
  // one-pixel video, for a visible 320x180 one, or for that one fullscreen. So a
  // desktop browser without wakeLock gets the truth and the system-settings
  // advice, not a video and a green pill.
  const doc = makeDocument();
  const nav = makeNavigator({wakeLock: false, userAgent: DESKTOP_UA, platform: "Linux x86_64",
    maxTouchPoints: 0});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  check("a desktop browser over HTTP is told the truth", keeper.state, "unavailable");
  check("and the advice is desktop-shaped", keeper.reason, "desktop");
  ok("the desktop tip names the system settings",
    keeper.tip().includes("system settings"), keeper.tip());
  check("no video is built on a desktop", doc.videos().length, 0);
}

{
  ok("an Android phone counts as mobile",
    WakeLock.isMobile({userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile"}));
  ok("a Linux desktop does not", !WakeLock.isMobile({userAgent: DESKTOP_UA}));
}

{
  // A desktop behind HTTPS still gets the real API -- the refusal above is about
  // the video being useless there, not about desktops being unsupported.
  const doc = makeDocument();
  const nav = makeNavigator({userAgent: DESKTOP_UA, platform: "Linux x86_64", maxTouchPoints: 0});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  check("a desktop behind HTTPS uses the real API", keeper.state, "wake-lock");
}

{
  // iOS 16.4+ does have the API; behind HTTPS it must win over the honest refusal.
  const doc = makeDocument();
  const nav = makeNavigator({userAgent: IOS_UA, platform: "iPhone"});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  check("iOS behind HTTPS uses the real API", keeper.state, "wake-lock");
}

// ---- leaving ------------------------------------------------------------------

{
  const doc = makeDocument(), nav = makeNavigator();
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  const sentinel = nav.sentinel;
  keeper.stop();
  ok("stop() releases the sentinel", sentinel.released);
  check("stop() returns to idle", keeper.state, "idle");
  check("stop() unhooks visibilitychange", (doc.listeners.visibilitychange || []).length, 0);
}

{
  const doc = makeDocument(), nav = makeNavigator({wakeLock: false});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  await keeper.start();
  const video = doc.videos()[0];
  ok("the video is playing", !video.paused);
  keeper.stop();
  ok("stop() pauses the video", video.paused);
}

// ---- the dot ---------------------------------------------------------------------

{
  const doc = makeDocument(), nav = makeNavigator({wakeLock: false});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  const dot = WakeLock.attachDot(keeper, doc);
  ok("the dot exists", Boolean(dot));
  check("the dot id", dot.id, "wakeLockDot");
  ok("the dot sits in the shared topbar", doc.topbar.children.includes(dot));
  ok("the dot is hidden while idle", dot.hidden === true);
  await keeper.start();
  ok("the dot appears once the display is held", dot.hidden === false);

  // The whole point of the redesign: the page shows a colour, nothing else. No
  // label, no icon, no frame -- a stray glyph here is the regression to catch.
  check("the dot carries no text at all", dot.textContent, "");
  ok("the state is expressed only as a colour hook",
    dot.dataset.wakelockState === "video", dot.dataset.wakelockState);

  // ...and every word lives in the hover/tap panel instead.
  ok("the panel carries the whole explanation",
    dot.getAttribute("data-tip").includes("will not sleep"), dot.getAttribute("data-tip"));
  check("the panel text and the native title agree",
    dot.getAttribute("title"), dot.getAttribute("data-tip"));
  ok("the panel names the state, because a colour alone is ambiguous",
    dot.getAttribute("data-tip").startsWith("Screen on"));
  ok("the panel never mentions HTTPS or wakeLock at the operator",
    !/HTTPS|wakeLock|navigator/i.test(dot.getAttribute("data-tip")));
  check("a screen reader still gets words", dot.getAttribute("aria-label"), "screen on");
}

{
  // A phone has no hover, so the panel must open on tap and close again on a tap
  // elsewhere -- otherwise it sits over the topbar until the page reloads.
  const doc = makeDocument(), nav = makeNavigator({wakeLock: false});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  const dot = WakeLock.attachDot(keeper, doc);
  await keeper.start();
  check("the panel starts closed", dot.getAttribute("aria-expanded"), "false");
  ok("and is not forced open", !dot.classList.contains("is-open"));
  dot.dispatch("click", {stopPropagation() {}});
  check("a tap opens the panel", dot.getAttribute("aria-expanded"), "true");
  ok("the open class drives the CSS", dot.classList.contains("is-open"));
  doc.dispatch("click");
  check("a tap elsewhere closes it", dot.getAttribute("aria-expanded"), "false");
  dot.dispatch("keydown", {key: "Enter", preventDefault() {}});
  check("Enter opens it too", dot.getAttribute("aria-expanded"), "true");
  doc.dispatch("keydown", {key: "Escape"});
  check("Escape closes it", dot.getAttribute("aria-expanded"), "false");
}

{
  const doc = makeDocument({playRejects: true});
  const nav = makeNavigator({wakeLock: false});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  const dot = WakeLock.attachDot(keeper, doc);
  await keeper.start();
  check("a blocked display shows the amber state", dot.dataset.wakelockState, "needs-tap");
  ok("and the panel says what to do about it",
    dot.getAttribute("data-tip").includes("Tap here"), dot.getAttribute("data-tip"));

  // The retry rides the document-level gesture listener, so tapping the dot
  // recovers even though the dot's own handler only opens the panel.
  doc.playRejects = false;
  doc.dispatch("pointerdown");
  await settle();
  check("tapping the dot revives the video", keeper.state, "video");
  check("and the colour goes back to held", dot.dataset.wakelockState, "video");
}

{
  const doc = makeDocument();
  const nav = makeNavigator({wakeLock: false, userAgent: IOS_UA, platform: "iPhone"});
  const keeper = WakeLock.create({navigator: nav, document: doc});
  const dot = WakeLock.attachDot(keeper, doc);
  await keeper.start();
  check("iOS gets the red state", dot.dataset.wakelockState, "unavailable");
  ok("and the Auto-Lock instruction is in the panel",
    dot.getAttribute("data-tip").includes("Auto-Lock"), dot.getAttribute("data-tip"));
  check("still no text on the page", dot.textContent, "");
}

{
  // The dot's meaning IS its colour, so the injected rules are load-bearing. The
  // base rule is green; amber and red are overrides keyed on the state attribute.
  // A state with no override renders green -- it would claim the display is held.
  const doc = makeDocument(), nav = makeNavigator({wakeLock: false});
  WakeLock.attachDot(WakeLock.create({navigator: nav, document: doc}), doc);
  const style = doc.head.children.find(child => child.tagName === "STYLE");
  ok("the dot injects its own stylesheet", Boolean(style));
  const css = style ? style.textContent : "";
  ok("held is green", /\.wakelock-dot\{[^}]*--green/.test(css));
  for (const [state, colour] of [["needs-tap", "--amber"], ["unavailable", "--red"]]) {
    const rule = new RegExp('\\.wakelock-dot\\[data-wakelock-state="' + state
      + '"\\]\\{[^}]*' + colour);
    ok(`${state} overrides the colour (${colour})`, rule.test(css));
  }
  ok("every colour has a literal fallback, so a dot is never invisible",
    (css.match(/var\(--(green|amber|red),#[0-9a-f]{6}\)/g) || []).length >= 6, css.slice(0, 120));
  ok("the panel opens without hover as well, for phones",
    css.includes(".wakelock-dot.is-open::after"));
  ok("and the panel text comes from the attribute",
    css.includes("content:attr(data-tip)"));
}

// ---- the vendored media ----------------------------------------------------------

{
  // A truncated or re-encoded blob would still "play" in the fake DOM above and
  // fail silently on the radio, so check the containers themselves.
  const mp4 = Buffer.from(WakeLock.MEDIA.mp4, "base64");
  const webm = Buffer.from(WakeLock.MEDIA.webm, "base64");
  check("the mp4 is an ISO base media file", mp4.toString("ascii", 4, 8), "ftyp");
  check("the webm starts with the EBML magic",
    webm.subarray(0, 4).toString("hex"), "1a45dfa3");
  ok("the mp4 is small enough to be free", mp4.length < 8192, `${mp4.length} B`);
  ok("the webm is small enough to be free", webm.length < 8192, `${webm.length} B`);

  // The comment in wake-lock.js quotes the gzipped cost as the reason not to
  // swap the vendored blobs for an unverified canvas trick. If the number drifts,
  // the argument in the comment stops being true.
  const zlib = require("zlib");
  const base64Bytes = Buffer.byteLength(WakeLock.MEDIA.mp4 + WakeLock.MEDIA.webm);
  const gzipped = zlib.gzipSync(Buffer.from(WakeLock.MEDIA.mp4 + WakeLock.MEDIA.webm), {level: 9}).length;
  ok("both blobs still cost about 5 kB gzipped", gzipped < 6144,
    `${base64Bytes} B of base64, ${gzipped} B gzipped`);

  const source = fs.readFileSync(path.join(__dirname, "..", "data", "wake-lock.js"), "utf8");
  ok("the source records where the media came from",
    source.includes("NoSleep.js") && source.includes("MIT"));
  const notices = fs.readFileSync(
    path.join(__dirname, "..", "data", "THIRD-PARTY-NOTICES.txt"), "utf8");
  ok("the notices file credits NoSleep.js", notices.includes("NoSleep.js"),
    "vendored MIT media needs an attribution entry");
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
})();
