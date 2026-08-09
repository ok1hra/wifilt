#!/usr/bin/env node
"use strict";

// Exercises the production relay engine directly.
const {Js8Relay, splitHop, remainingHops, isCallsign} =
  require("../../../data/js8-relay.js");

function check(condition, what) {
  if (!condition) { console.error(`RELAY FAIL: ${what}`); process.exitCode = 1; }
  return condition;
}
const ctx = (over = {}) => ({nowMs: 0, myCall: "DR4CNK", armed: true, ...over});
const frame = (over = {}) => ({from: "KN4CRD", to: "DR4CNK", complete: true, ...over});

// --- path parsing -----------------------------------------------------------
{
  check(splitHop("OH8STN>HELLO").nextHop === "OH8STN", "next hop parsed");
  check(splitHop("OH8STN>HELLO").rest === "HELLO", "remainder parsed");
  check(splitHop("HELLO WORLD").nextHop === null, "plain text has no hop");
  // A > inside free text must not be mistaken for a hop.
  check(splitHop("A>B").nextHop === null, "a one-letter token is not a callsign");
  check(splitHop("HI THERE>X").nextHop === null, "text before > is not a callsign");
  check(remainingHops("A1BC>D2EF>G3HI>MSG") === 3, "three hops counted");
  check(remainingHops("MSG") === 0, "no hops in plain text");
  check(isCallsign("OK1HRA") && isCallsign("K0OG/P"), "valid callsigns accepted");
  check(!isCallsign("A") && !isCallsign("TOOLONGCALL"), "invalid callsigns rejected");
}

// --- we are the destination -------------------------------------------------
{
  const relay = new Js8Relay();
  const out = relay.handle(frame({text: "HELLO JULIAN! DE KN4CRD"}), ctx());
  check(out.action === "deliver", "plain payload must be delivered to us");
  check(out.text === "HELLO JULIAN! DE KN4CRD", "delivered text kept intact");
  check(out.ack && out.ack.to === "KN4CRD" && out.ack.text === "ACK",
    "the destination must acknowledge the sender");
  check(relay.stats.delivered === 1, "delivery counted");
}

// --- we are an intermediate hop ---------------------------------------------
// The exact upstream example.
{
  const relay = new Js8Relay();
  const out = relay.handle(frame({text: "OH8STN>HELLO JULIAN!"}), ctx());
  check(out.action === "forward" && out.to === "OH8STN", "must forward to the next hop");
  check(out.text === ">HELLO JULIAN! DE KN4CRD",
    `must append the originator, got ${JSON.stringify(out.text)}`);
  check(relay.stats.forwarded === 1, "forward counted");
  check(relay.snapshot(0).recent[0].text === ">HELLO JULIAN! DE KN4CRD",
    "everything we put on the air on someone's behalf must be logged");
}

// --- attribution is not duplicated ------------------------------------------
{
  const relay = new Js8Relay();
  const out = relay.handle(frame({text: "OH8STN>HELLO DE KN4CRD"}), ctx());
  check(out.text === ">HELLO DE KN4CRD", "an existing DE must be left alone");
}

// --- ACK follows the reverse relay path and is not ACKed again --------------
{
  const relay = new Js8Relay();
  const delivered = relay.handle(
    frame({from: "DR4CNK", to: "OH8STN", text: "HELLO JULIAN! DE KN4CRD"}),
    ctx({myCall: "OH8STN"}));
  check(delivered.ack && delivered.ack.to === "DR4CNK" &&
        delivered.ack.text === ">KN4CRD>ACK",
    `final ACK must follow the reverse path, got ${JSON.stringify(delivered.ack)}`);

  const ack = relay.handle(frame({text: "ACK DE OH8STN"}), ctx());
  check(ack.action === "deliver" && !ack.ack,
    "a relayed ACK must terminate instead of causing an ACK loop");
}

// --- delivery never requires arming, forwarding always does -----------------
// Receiving mail for ourselves is not the same as transmitting for a stranger.
{
  const relay = new Js8Relay();
  check(relay.handle(frame({text: "HELLO"}), ctx({armed: false})).action === "deliver",
    "a message for us must arrive even when disarmed");
  check(relay.handle(frame({text: "OH8STN>HELLO"}), ctx({armed: false})).reason === "not-armed",
    "forwarding for others must require unattended mode");
}

// --- loop protection --------------------------------------------------------
{
  const relay = new Js8Relay();
  check(relay.handle(frame({text: "DR4CNK>HELLO"}), ctx()).reason === "loop",
    "must refuse to forward to ourselves");
  check(relay.handle(frame({text: "OH8STN>DR4CNK>HELLO"}), ctx()).reason === "loop",
    "must refuse when we appear later in the path");
}

// --- limits -----------------------------------------------------------------
{
  const relay = new Js8Relay({maxTextLength: 40});
  check(relay.handle(frame({text: "OH8STN>" + "X".repeat(60)}), ctx()).reason === "too-long",
    "an oversized payload must be refused");
  // Attribution can be what pushes it over, and that must be caught too.
  // "OH8STN>" (7) is replaced by " DE KN4CRD" (10), so the forwarded text is
  // exactly 3 characters longer than the payload: the window where only the
  // second check can fire is payload in (limit-3, limit].
  const tight = new Js8Relay({maxTextLength: 30});
  const payload = "OH8STN>" + "Y".repeat(22);           // 29 chars, passes the first check
  check(payload.length <= 30, "payload must pass the first length check");
  check(tight.handle(frame({text: payload}), ctx()).reason === "too-long",
    "the length check must include the appended attribution");

  const deep = new Js8Relay({maxHops: 2});
  check(deep.handle(frame({text: "A1BC>D2EF>G3HI>MSG"}), ctx()).reason === "too-deep",
    "an over-deep chain must be refused");

  const capped = new Js8Relay({maxPerHour: 2});
  let t = 0, forwarded = 0;
  for (let i = 0; i < 5; i += 1)
    if (capped.handle(frame({text: "OH8STN>MSG " + i}), ctx({nowMs: t += 1000})).action === "forward")
      forwarded += 1;
  check(forwarded === 2, `hourly cap must stop at 2, got ${forwarded}`);
  check(capped.handle(frame({text: "OH8STN>LATER"}), ctx({nowMs: t + 3600001})).action === "forward",
    "the cap must slide with the hour");
}

// --- everything else that must not go on the air ----------------------------
{
  const relay = new Js8Relay();
  check(relay.handle(frame({to: "OK2XYZ", text: "OH8STN>X"}), ctx()).reason === "not-addressed",
    "a relay for another station must be ignored");
  check(relay.handle(frame({text: "OH8STN>X", complete: false}), ctx()).reason === "incomplete",
    "a half-received relay must never be forwarded");
  check(relay.handle(frame({text: ""}), ctx()).reason === "empty", "an empty payload must be refused");
  check(relay.handle(frame({text: "OH8STN>"}), ctx()).reason === "empty",
    "a hop with nothing after it must be refused");

  const off = new Js8Relay({enabled: false});
  check(off.handle(frame({text: "OH8STN>X"}), ctx()).reason === "disabled",
    "relay must be switchable off entirely");
}

// --- every refusal is explained ---------------------------------------------
{
  const events = [];
  const relay = new Js8Relay({onEvent: event => events.push(event), maxHops: 1});
  relay.handle(frame({text: "A1BC>D2EF>MSG"}), ctx());
  const refusal = events.find(event => event.type === "refused");
  check(refusal && refusal.detail && refusal.detail.includes("limit"),
    "a refusal must say which limit was hit");
}

if (!process.exitCode)
  console.log("RELAY PASS maxLen=120 maxHops=3 maxPerHour=12 " +
    "loopGuarded=true forwardNeedsArming=true deliveryAlways=true");
