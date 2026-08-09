#!/usr/bin/env node
"use strict";

// Exercises the production inbox engine directly.
const {Js8Inbox, MemoryStore, DEFAULTS, parseMsgTo} = require("../../../data/js8-inbox.js");

function check(condition, what) {
  if (!condition) { console.error(`INBOX FAIL: ${what}`); process.exitCode = 1; }
  return condition;
}
const ctx = (over = {}) => ({nowMs: 10 * 60000, myCall: "OK1HRA", armed: true,
  hearing: [{call: "K0OG", snr: -12, lastSlotUtcMs: 9 * 60000},
    {call: "KD8SKZ", snr: -7, lastSlotUtcMs: 8 * 60000}], ...over});
const frame = (over = {}) => ({from: "K0OG", to: "OK1HRA", complete: true, ...over});

// --- MSG TO: parsing --------------------------------------------------------
{
  check(parseMsgTo("TO:OK1ABC HELLO THERE").to === "OK1ABC", "recipient parsed");
  check(parseMsgTo("TO:OK1ABC HELLO THERE").text === "HELLO THERE", "text parsed");
  check(parseMsgTo("TO: OK1ABC  HELLO").to === "OK1ABC", "tolerates spacing");
  check(parseMsgTo("OK1ABC HELLO") === null, "missing TO: is malformed");
  check(parseMsgTo("TO:X HELLO") === null, "an unpackable callsign is malformed");
  check(parseMsgTo("TO:OK1ABC") === null, "a recipient with no text is malformed");
}

// --- MSG for us -------------------------------------------------------------
{
  const inbox = new Js8Inbox();
  const out = inbox.handle(frame({command: "MSG", text: "SEE YOU AT THE FIELD DAY"}), ctx());
  check(out.action === "store", "MSG must be stored");
  check(out.record.type === "UNREAD",
    `a bare MSG is mail for this operator, got ${out.record.type}`);
  check(out.record.to === "OK1HRA" && out.record.from === "K0OG",
    "it is filed under my callsign, from the sender");
  // The defect the type separation exists to kill: before it, QUERY MSGS drew
  // from every record, so the sender was offered its own message back.
  check(inbox.handle(frame({from: "K0OG", command: "QUERY MSGS"}), ctx()).text === "NO",
    "mail addressed to me must never be offered back to its sender");
  check(inbox.handle(frame({from: "K0OG", command: "QUERY MSG", text: "1"}), ctx()).reason === "not-yours",
    "and it must not be handed over when asked for by id");
  // The same text again inside the window is a lost ACK, not a second message.
  const twin = inbox.handle(frame({command: "MSG", text: "SEE YOU AT THE FIELD DAY"}), ctx());
  check(twin.action === "duplicate" && twin.ack.text === "ACK",
    "a repeat must be de-duplicated but still acknowledged");
  check(inbox.snapshot().items.length === 1, "and must not create a second record");
  check(out.ack.to === "K0OG" && out.ack.text === "ACK",
    `the acknowledgement must use the reference wire form, got ${JSON.stringify(out.ack)}`);
  // Accepting mail costs no airtime, so it must work with unattended mode off.
  const disarmed = new Js8Inbox();
  check(disarmed.handle(frame({command: "MSG", text: "HI"}), ctx({armed: false})).action === "store",
    "storing must not require unattended mode");
}

// --- MSG TO: a third station ------------------------------------------------
{
  const inbox = new Js8Inbox();
  const out = inbox.handle(frame({command: "MSG TO:", text: "TO:OH8STN QRV 40M TONIGHT"}), ctx());
  check(out.action === "store" && out.record.to === "OH8STN",
    "store-and-forward must file it under the final recipient");
  check(out.record.from === "K0OG", "the depositor is recorded");
  check(inbox.pending("OH8STN").length === 1, "it must be waiting for OH8STN");
  check(inbox.pending("K0OG").length === 0, "and not for the depositor");
  const bad = inbox.handle(frame({command: "MSG TO:", text: "garbage"}), ctx());
  check(bad.reason === "malformed", "malformed MSG TO: must be refused");
  check(bad.nack && bad.nack.to === "K0OG" && bad.nack.text === "NACK",
    "a malformed checksummed command must be NACKed, not answered with silence");
}

// --- QUERY MSGS -------------------------------------------------------------
{
  const inbox = new Js8Inbox();
  check(inbox.handle(frame({command: "QUERY MSGS"}), ctx()).text === "NO",
    "an empty inbox must answer NO");
  inbox.handle(frame({from: "KD8SKZ", command: "MSG TO:", text: "TO:K0OG FIRST"}), ctx());
  inbox.handle(frame({from: "KD8SKZ", command: "MSG TO:", text: "TO:K0OG SECOND"}), ctx());
  const out = inbox.handle(frame({from: "K0OG", command: "QUERY MSGS"}), ctx());
  check(out.text === "YES MSG ID 1 +1", `must offer the oldest id and count, got ${out.text}`);
  check(out.detail.includes("2 waiting"), "must say how many are waiting");
  check(inbox.handle(frame({command: "QUERY MSGS?"}), ctx()).action === "reply",
    "the ? spelling must work too");
}

// --- QUERY MSG --------------------------------------------------------------
{
  const inbox = new Js8Inbox();
  inbox.handle(frame({from: "KD8SKZ", command: "MSG TO:", text: "TO:K0OG MEET AT NOON"}), ctx());

  check(inbox.handle(frame({from: "K0OG", command: "QUERY MSG", text: "99"}), ctx()).reason === "unknown-id",
    "an unknown id must be refused");
  check(inbox.handle(frame({from: "OK2XYZ", command: "QUERY MSG", text: "1"}), ctx()).reason === "not-yours",
    "somebody else's message must not be handed over");
  // Delivering third-party content is transmitting for others, like a relay hop.
  check(inbox.handle(frame({from: "K0OG", command: "QUERY MSG", text: "1"}), ctx({armed: false})).reason === "not-armed",
    "delivery must require unattended mode");

  const out = inbox.handle(frame({from: "K0OG", command: "QUERY MSG", text: "1"}), ctx());
  check(out.action === "deliver" && out.text === "MSG MEET AT NOON FROM KD8SKZ",
    `delivery must carry the text, got ${JSON.stringify(out)}`);
  check(inbox.pending("K0OG").length === 1,
    "a queued reply must remain pending until RF transmission completes");
  check(inbox.confirmDelivered(out.deliveryId),
    "the completed RF transaction must confirm the delivery");
  check(inbox.pending("K0OG").length === 0, "a delivered message must not be offered again");
  check(inbox.handle(frame({from: "K0OG", command: "QUERY MSGS"}), ctx()).text === "NO",
    "after delivery the inbox is empty for that station");
}

// --- QUERY CALL -------------------------------------------------------------
{
  const inbox = new Js8Inbox();
  check(inbox.handle(frame({command: "QUERY CALL", text: "KD8SKZ"}), ctx()).text === "YES -07 (2m)",
    "a station we hear must be confirmed with SNR and age");
  check(inbox.handle(frame({command: "QUERY CALL", text: "OH8STN"}), ctx()).reason === "not-heard",
    "a station we do not hear must not trigger an on-air NO");
  check(inbox.handle(frame({command: "QUERY CALL", text: "!!"}), ctx()).reason === "malformed",
    "a bad callsign must be refused");
}

// --- quotas keep one station from filling the store -------------------------
{
  const inbox = new Js8Inbox({maxUnreadPerSender: 2});
  let stored = 0;
  for (let i = 0; i < 5; i += 1)
    if (inbox.handle(frame({command: "MSG", text: `M${i}`}), ctx()).action === "store") stored += 1;
  check(stored === 2, `per-sender quota must stop at 2, got ${stored}`);
  // A different station is unaffected.
  check(inbox.handle(frame({from: "KD8SKZ", command: "MSG", text: "HI"}), ctx()).action === "store",
    "the quota must be per sender, not global");

  // Third-party stock has its own two limits: per depositor and in total, so
  // strangers' mail cannot crowd out our own.
  const held = new Js8Inbox({maxPerSender: 2});
  let filed = 0;
  for (let i = 0; i < 5; i += 1)
    if (held.handle(frame({command: "MSG TO:", text: `TO:OH8STN M${i}`}), ctx()).action === "store") filed += 1;
  check(filed === 2, `per-depositor quota must stop at 2, got ${filed}`);
  const stock = new Js8Inbox({maxStore: 1});
  stock.handle(frame({command: "MSG TO:", text: "TO:OH8STN ONE"}), ctx());
  check(stock.handle(frame({from: "KD8SKZ", command: "MSG TO:", text: "TO:OH8STN TWO"}), ctx()).reason === "store-quota",
    "the third-party ceiling must refuse once reached");
  check(stock.handle(frame({from: "KD8SKZ", command: "MSG", text: "MINE"}), ctx()).action === "store",
    "and it must not block mail addressed to me");

  const small = new Js8Inbox({maxMessages: 1});
  small.handle(frame({command: "MSG", text: "ONE"}), ctx());
  check(small.handle(frame({from: "KD8SKZ", command: "MSG", text: "TWO"}), ctx()).reason === "full",
    "a full store must refuse");

  const short = new Js8Inbox({maxTextLength: 10});
  check(short.handle(frame({command: "MSG", text: "X".repeat(20)}), ctx()).reason === "too-long",
    "an oversized message must be refused");
}

// --- addressing and completeness --------------------------------------------
{
  const inbox = new Js8Inbox();
  check(inbox.handle(frame({to: "OK2XYZ", command: "MSG", text: "HI"}), ctx()).reason === "not-addressed",
    "mail for another station must be ignored");
  check(inbox.handle(frame({command: "MSG", text: "HI", complete: false}), ctx()).reason === "incomplete",
    "a half-received MSG must never be stored");
  check(inbox.handle(frame({command: "SNR?"}), ctx()).reason === "unsupported",
    "commands outside group E must be left to the other engines");
  check(inbox.handle(frame({command: "QUERY MSGS"}), ctx({armed: false})).reason === "not-armed",
    "QUERY MSGS must only answer while AUTO is enabled");
}

// --- an injected store is what the firmware will provide --------------------
{
  const store = new MemoryStore();
  const inbox = new Js8Inbox({store});
  inbox.handle(frame({command: "MSG", text: "PERSISTED"}), ctx());
  check(store.size() === 1 && store.all()[0].text === "PERSISTED",
    "records must land in the injected store, not a private one");
}

if (!process.exitCode)
  console.log(`INBOX PASS commands=5 maxMessages=${DEFAULTS.maxMessages} ` +
    `maxStore=${DEFAULTS.maxStore} maxPerSender=${DEFAULTS.maxPerSender} ` +
    `maxLen=${DEFAULTS.maxTextLength} typed=true ` +
    "storeAlways=true deliveryNeedsArming=true");
