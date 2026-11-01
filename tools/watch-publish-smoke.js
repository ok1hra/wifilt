#!/usr/bin/env node
"use strict";

// watch-publish.js, the holder's half of WATCH, in Node with a fake fetch:
// quiet while WATCH is off or the box does not offer it, sends only changes,
// re-sends an unchanged screen after a minute, goes quiet on 409, refuses a
// snapshot over the binary's 60 kB limit. docs/watch-implementace.md.
//
//   node tools/watch-publish-smoke.js

const path = require("path");
const modulePath = path.join(__dirname, "..", "data", "watch-publish.js");

let checks = 0, failed = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  -- ${detail}` : ""}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Each scenario gets a fresh module: the /health.json answer is shared per page.
function load() {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function fakeFetch({watch, snapshotStatus = 200}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({url, method: options.method || "GET", body: options.body});
    if (url === "/health.json") return {ok: true, json: async () => (watch === undefined ? {platform: "esp32"} : {watch})};
    return {ok: snapshotStatus === 200, status: snapshotStatus, json: async () => ({})};
  };
  return {calls, fetchImpl, posts: () => calls.filter(call => call.method === "POST")};
}

(async () => {
  {
    const WatchPublish = load();
    check("the module exports create()", typeof WatchPublish.create === "function");
    const fake = fakeFetch({watch: undefined});
    const publisher = WatchPublish.create({role: "js8", token: () => "t", intervalMs: 5, fetchImpl: fake.fetchImpl});
    publisher.publish(() => ({a: 1}));
    await sleep(40);
    check("on a build without WATCH nothing is posted", fake.posts().length === 0);
    check("and /health.json is read once", fake.calls.filter(call => call.url === "/health.json").length === 1);
  }
  {
    const WatchPublish = load();
    const fake = fakeFetch({watch: {on: false}});
    const publisher = WatchPublish.create({role: "js8", token: () => "t", intervalMs: 5, fetchImpl: fake.fetchImpl});
    publisher.publish(() => ({a: 1}));
    await sleep(40);
    check("with WATCH off nothing is posted", fake.posts().length === 0);
  }
  {
    const WatchPublish = load();
    const fake = fakeFetch({watch: {on: true}});
    let clock = 1000000, described = 0;
    const publisher = WatchPublish.create({role: "wspr", token: () => "abc", intervalMs: 5, fetchImpl: fake.fetchImpl, now: () => clock});
    const describe = () => { described++; return {spots: [1, 2]}; };
    for (let index = 0; index < 5; index++) publisher.publish(describe);
    await sleep(40);
    check("a burst of renders is one post", fake.posts().length === 1, String(fake.posts().length));
    check("the screen is described only when the post is due", described === 1, String(described));
    const post = fake.posts()[0];
    check("it posts to the role with the token", post && post.url === "/watch/snapshot?role=wspr&token=abc", post && post.url);
    check("the body is the description", post && post.body === JSON.stringify({spots: [1, 2]}));
    publisher.publish(describe);
    await sleep(40);
    check("an unchanged screen is not re-sent", fake.posts().length === 1);
    clock += 61000;
    publisher.publish(describe);
    await sleep(40);
    check("but is re-sent after a minute", fake.posts().length === 2, String(fake.posts().length));
    publisher.publish(() => ({spots: [1, 2, 3]}));
    await sleep(40);
    check("a change is sent", fake.posts().length === 3);
    publisher.publish(() => ({big: "x".repeat(70 * 1024)}));
    await sleep(40);
    check("a snapshot over 60 kB is not sent", fake.posts().length === 3);
    publisher.publish(() => { throw new Error("boom"); });
    await sleep(40);
    check("a failing description does not throw out of publish", fake.posts().length === 3);
  }
  {
    const WatchPublish = load();
    const fake = fakeFetch({watch: {on: true}, snapshotStatus: 409});
    let clock = 5000000;
    const publisher = WatchPublish.create({role: "js8", token: () => "t", intervalMs: 5, fetchImpl: fake.fetchImpl, now: () => clock});
    publisher.publish(() => ({a: 1}));
    await sleep(40);
    publisher.publish(() => ({a: 2}));
    await sleep(40);
    check("after a 409 the page goes quiet", fake.posts().length === 1, String(fake.posts().length));
    clock += 11000;
    publisher.publish(() => ({a: 3}));
    await sleep(40);
    check("and tries again ten seconds later", fake.posts().length === 2, String(fake.posts().length));
  }
  {
    const WatchPublish = load();
    const fake = fakeFetch({watch: {on: true}});
    const publisher = WatchPublish.create({role: "js8", token: () => "", intervalMs: 5, fetchImpl: fake.fetchImpl});
    publisher.publish(() => ({a: 1}));
    await sleep(40);
    check("without a session token nothing is posted", fake.posts().length === 0);
  }
  console.log(`\n${checks - failed}/${checks} checks passed`);
  process.exit(failed ? 1 : 0);
})();
