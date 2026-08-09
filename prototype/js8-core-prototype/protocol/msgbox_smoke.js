#!/usr/bin/env node
"use strict";

// Exercises the production MSG BOX layer: migration of the pre-type file,
// byte-driven eviction and the operator actions. Everything goes through the
// real store the inbox engine uses, never a private copy.

const {Js8Inbox, MemoryStore, TYPE} = require("../../../data/js8-inbox.js");
const {Js8MsgBox, AttemptLedger, migrateRecord, parseMailAdvert,
  parseDeliveredMail} = require("../../../data/js8-msgbox.js");

function check(condition, what) {
  if (!condition) { console.error(`MSGBOX FAIL: ${what}`); process.exitCode = 1; }
  return condition;
}
const boxOf = (over = {}) => {
  const store = new MemoryStore();
  return {store, box: new Js8MsgBox({store, ...over})};
};
const record = (over = {}) => ({id: 1, from: "K0OG", to: "OK1HRA",
  text: "HELLO", atMs: 1000, type: TYPE.UNREAD, ...over});

// --- migration of the pre-type file -----------------------------------------
{
  // A bare MSG used to be filed against its sender, MSG TO: against a third
  // station -- that is the whole discriminator the old file gives us.
  check(migrateRecord({from: "K0OG", to: "K0OG", delivered: false}).type === TYPE.UNREAD,
    "to === from and undelivered is unread mail for me");
  check(migrateRecord({from: "K0OG", to: "K0OG", delivered: true}).type === TYPE.READ,
    "to === from and delivered is mail I have seen");
  check(migrateRecord({from: "K0OG", to: "OH8STN", delivered: false}).type === TYPE.STORE,
    "a third station is stock we hold");
  check(migrateRecord({from: "K0OG", to: "OH8STN", delivered: true}).type === TYPE.DELIVERED,
    "handed over stock keeps its own type");
  check(migrateRecord({from: "K0OG", to: "K0OG", type: TYPE.STORE}).type === TYPE.STORE,
    "an already typed record must be left alone");

  const {box, store} = boxOf();
  const result = box.loadJsonl([
    JSON.stringify({id: 3, from: "K0OG", to: "K0OG", text: "OLD MAIL", atMs: 1}),
    "{ this line is broken",
    JSON.stringify({id: 5, from: "KD8SKZ", to: "OH8STN", text: "FOR OH8STN", atMs: 2}),
    "",
  ].join("\n"));
  check(result.restored === 2 && result.migrated === 2 && result.dropped === 1,
    `one corrupt line must cost one record, got ${JSON.stringify(result)}`);
  check(store.nextId === 6, "ids must continue past the highest restored one");
  check(store.all()[0].type === TYPE.UNREAD && store.all()[1].type === TYPE.STORE,
    "both kinds must come back with the type they always meant");
}

// --- round trip through the wire format --------------------------------------
{
  const {box, store} = boxOf();
  const inbox = new Js8Inbox({store});
  inbox.handle({from: "K0OG", to: "OK1HRA", command: "MSG", text: "PERSIST ME", complete: true},
    {nowMs: 1000, myCall: "OK1HRA", armed: true});
  const wire = box.toJsonl();
  const {box: second, store: secondStore} = boxOf();
  second.loadJsonl(wire);
  check(secondStore.all()[0].text === "PERSIST ME" && secondStore.all()[0].type === TYPE.UNREAD,
    "a record must survive the JSONL round trip with its type");
  check(second.loadJsonl("").restored === 0, "an empty file must restore nothing, not throw");
}

// --- eviction ladder ---------------------------------------------------------
{
  const {box, store} = boxOf();
  const add = over => store.add(record(over));
  add({type: TYPE.UNREAD, atMs: 10, text: "MINE UNREAD"});
  add({type: TYPE.DEFERRED, state: "waiting", atMs: 20, text: "STILL TRYING"});
  add({type: TYPE.STORE, to: "OH8STN", atMs: 30, text: "STOCK NEW"});
  add({type: TYPE.STORE, to: "OH8STN", atMs: 5, text: "STOCK OLD"});
  add({type: TYPE.READ, atMs: 40, text: "SEEN"});
  add({type: TYPE.DELIVERED, to: "OH8STN", atMs: 50, text: "GONE"});
  add({type: TYPE.DEFERRED, state: "handed", atMs: 60, text: "PARKED"});

  const order = [];
  for (;;) {
    const victim = box._nextVictim();
    if (!victim) break;
    order.push(victim.text);
    store.remove(victim.id);
  }
  check(order.join("|") === "GONE|SEEN|STOCK OLD|STOCK NEW|PARKED",
    `ladder must be delivered, read, stock (oldest first), finished deferred; got ${order.join("|")}`);
  const left = store.all().map(item => item.text).sort();
  check(left.join("|") === "MINE UNREAD|STILL TRYING",
    `unread mail and live deferred must never be evicted, left ${left.join("|")}`);
}

// --- eviction is driven by bytes, not by the record count --------------------
{
  const {box, store} = boxOf({maxBytes: 900, evictAtRatio: 0.9});
  for (let i = 0; i < 20; i += 1)
    store.add(record({type: TYPE.READ, atMs: i, text: `SEEN ${i} ${"X".repeat(60)}`}));
  const before = box.byteSize();
  check(before > box.budget(), "the fixture must actually exceed the budget");
  const result = box.enforceBudget();
  check(result.bytes <= box.budget(), `eviction must bring it under budget, got ${result.bytes}`);
  check(result.full === false, "with evictable records left it is not full");
  check(result.evicted.length > 0 && result.evicted[0].atMs === 0,
    "the oldest record goes first");

  // Only unread mail left and still over budget: refuse, never drop.
  const {box: tight, store: tightStore} = boxOf({maxBytes: 200, evictAtRatio: 0.9});
  for (let i = 0; i < 5; i += 1)
    tightStore.add(record({type: TYPE.UNREAD, atMs: i, text: `MAIL ${i}`}));
  const full = tight.enforceBudget();
  check(full.full === true, "an unevictable overflow must report full");
  check(tightStore.size() === 5, "and must not have dropped a single unread message");
}

// --- operator actions --------------------------------------------------------
{
  const {box, store} = boxOf();
  const mail = store.add(record({type: TYPE.UNREAD, text: "READ ME"}));
  const stock = store.add(record({type: TYPE.STORE, to: "OH8STN", text: "NOT MINE"}));
  check(box.markRead(mail.id) === true, "a click marks unread mail read");
  check(store.byId(mail.id).type === TYPE.READ, "and the type follows");
  check(box.markRead(mail.id) === false, "marking it twice must be a no-op");
  check(box.markRead(stock.id) === false, "third-party stock has no read state");

  const removed = box.remove(stock.id);
  check(removed && store.byId(stock.id) === null, "delete must take it out");
  check(box.restore(removed) && store.byId(stock.id) !== null,
    "undo must put the very same record back");
  check(store.byId(stock.id).id === stock.id,
    "with its original id -- NEXT MSG ID quotes it on the air");
  check(box.restore(removed) === null, "restoring an id already present must be refused");
}

// --- counts and filters ------------------------------------------------------
{
  const {box, store} = boxOf();
  store.add(record({type: TYPE.UNREAD, text: "A"}));
  store.add(record({type: TYPE.READ, text: "B"}));
  store.add(record({type: TYPE.STORE, to: "OH8STN", text: "C"}));
  store.add(record({type: TYPE.DELIVERED, to: "OH8STN", text: "D"}));
  store.add(record({type: TYPE.DEFERRED, state: "waiting", text: "E"}));
  store.add(record({type: TYPE.DEFERRED, state: "handed", text: "F"}));
  const counts = box.counts();
  check(counts.unread === 1 && counts.read === 1 && counts.held === 1 &&
    counts.delivered === 1 && counts.waiting === 1 && counts.deferred === 2,
    `counts must split by type, got ${JSON.stringify(counts)}`);
  check(box.items("mine").length === 2, "FOR ME is unread plus read");
  check(box.items("waiting").length === 2, "WAITING is every deferred record");
  check(box.items("held").length === 2, "HELD is stock plus what we handed over");
  check(box.items("all").length === 6, "ALL is everything");
}

// --- reading the advertisements upstream only writes -------------------------
{
  check(parseMailAdvert("HEARTBEAT SNR -12 MSG ID 32").id === 32,
    "the heartbeat advertisement carries the id");
  const yes = parseMailAdvert("YES MSG ID 7 +2");
  check(yes.id === 7 && yes.more === 2, "the QUERY MSGS answer carries id and count");
  check(parseMailAdvert("HEARTBEAT SNR -12") === null, "a plain ack advertises nothing");
  check(parseMailAdvert("SEE YOU AT THE MSG ID PARTY") === null,
    "an id-shaped phrase without a number is not an advertisement");
  // The delivery quotes the NEXT id; letting the plain parser see it would
  // register the pickup twice.
  check(parseMailAdvert("MSG HI FROM K0OG NEXT MSG ID 33") === null,
    "a delivery is not parsed as a bare advertisement");

  const delivery = parseDeliveredMail("MEET AT NOON FROM KD8SKZ NEXT MSG ID 33 +1");
  check(delivery.text === "MEET AT NOON" && delivery.origin === "KD8SKZ" &&
    delivery.nextId === 33 && delivery.more === 1,
    `the delivery must split into text, origin and the next id, got ${JSON.stringify(delivery)}`);
  check(parseDeliveredMail("MSG HELLO FROM K0OG").nextId === 0,
    "a delivery with nothing after it leaves no pickup");
  check(parseDeliveredMail("GREETINGS") === null, "a sentence with no FROM is not a delivery");
}

// --- the attempt ledger: an unreachable station cannot make us transmit forever
{
  const ledger = new AttemptLedger({maxAttempts: 5, cooldownMs: 3600000});
  check(ledger.due("K0OG|1", 0) === true, "the first attempt is always due");
  ledger.note("K0OG|1", 0);
  check(ledger.due("K0OG|1", 60000) === false, "a minute later it is not due again");
  check(ledger.due("K0OG|1", 3600000) === true, "an hour later it is");
  for (let i = 1; i < 5; i += 1) ledger.note("K0OG|1", i * 3600000);
  check(ledger.exhausted("K0OG|1") === true, "five attempts is the end of it");
  check(ledger.due("K0OG|1", 99 * 3600000) === false, "and no later hour brings it back");
  check(ledger.due("K0OG|2", 0) === true, "a different message is a different budget");
  ledger.clear("K0OG|1");
  check(ledger.due("K0OG|1", 0) === true, "a delivered message releases its budget");
}

// --- a pickup we could never ask for -----------------------------------------
{
  // A directed frame packs the recipient into 28 bits: a base callsign longer
  // than six characters cannot be addressed, and asking anyway throws inside the
  // encoder. The guard belongs where the pointer is created.
  const {isCallsign} = require("../../../data/js8-inbox.js");
  check(isCallsign("OK6HLD") === true, "six characters are packable");
  check(isCallsign("OK6HOLD") === false, "seven are not");
  check(isCallsign("OK1HRA/P") === true, "a portable suffix stays packable");
}

// --- plain traffic addressed to us is mail, and it is not acknowledged --------
{
  const store = new MemoryStore();
  const inbox = new Js8Inbox({store});
  const ctx = {nowMs: 1000, myCall: "OK1HRA"};
  const out = inbox.fileIncoming({from: "K0OG", to: "OK1HRA", text: "ARE YOU THERE"}, ctx);
  check(out.action === "store" && out.record.type === TYPE.UNREAD,
    "an ordinary message addressed to us is unread mail");
  check(!out.ack, "nothing was promised, so nothing is acknowledged");
  check(inbox.fileIncoming({from: "K0OG", to: "OK2XYZ", text: "HI"}, ctx).reason === "not-addressed",
    "traffic for somebody else is not our mail");
  check(inbox.fileIncoming({from: "K0OG", to: "OK1HRA", text: "ARE YOU THERE"}, ctx).action === "duplicate",
    "the same text twice inside the window is one message");
  check(store.size() === 1, "and leaves one record");
  // It must not become stock we would hand out.
  check(inbox.handle({from: "K0OG", to: "OK1HRA", command: "QUERY MSGS", complete: true},
    {nowMs: 1000, myCall: "OK1HRA", armed: true}).text === "NO",
    "filed traffic must never be offered back on QUERY MSGS");
}

// --- deferred outgoing mail --------------------------------------------------
{
  const {box, store} = boxOf();
  const now = 1000;
  const refusals = [
    [{to: "@NET", text: "HI"}, "not-a-station", "a group never shows up, so it could never be released"],
    [{to: "OK1HRA", text: "HI"}, "own-callsign", "you cannot work yourself"],
    [{to: "K0OG", text: ""}, "empty", "an empty message is not a message"],
    [{to: "K0OG", text: "X".repeat(121)}, "too-long", "121 characters exceed the protocol limit"],
    // Seven characters do not fit the 28-bit callsign field: parking mail for
    // such a station would wait for ever and then throw inside the encoder.
    [{to: "OK8LATE", text: "HI"}, "not-addressable", "a callsign we cannot address is refused up front"],
  ];
  for (const [input, reason, what] of refusals)
    check(box.defer({...input, nowMs: now, myCall: "OK1HRA"}).refused === reason, what);

  const record = box.defer({to: "K0OG", text: "MEET ON 40M", nowMs: now, myCall: "OK1HRA"});
  check(record.type === TYPE.DEFERRED && record.state === "waiting" && record.to === "K0OG",
    "a deferred message waits for its recipient");
  check(record.expiresMs === now + 7 * 24 * 3600000,
    "it stops trying after seven days -- the longest arming window there is");
  check(box.deferredFor("K0OG", now).length === 1, "and is offered when that station shows up");
  check(box.deferredFor("OH8STN", now).length === 0, "only to that station");

  // Five attempts and it stops on its own, exactly like a pickup.
  for (let i = 0; i < 4; i += 1) box.noteDeferredAttempt(record.id, now + i);
  check(store.byId(record.id).state === "waiting", "four attempts leave it trying");
  box.noteDeferredAttempt(record.id, now + 5);
  check(store.byId(record.id).state === "attention",
    "the fifth ends the automation and asks the operator for help");
  check(box.deferredFor("K0OG", now).length === 0, "and it is no longer offered");

  // The ACK is the only proof of delivery this protocol can make, so it is what
  // removes the record.
  const second = box.defer({to: "OH8STN", text: "QRV TONIGHT", nowMs: now, myCall: "OK1HRA"});
  check(box.confirmDeferred(second.id).text === "QRV TONIGHT", "an ACK closes the message");
  check(store.byId(second.id) === null, "and takes the record with it");

  // Seven days later, an untouched message stops by itself.
  const third = box.defer({to: "OK2ABC", text: "STILL HERE", nowMs: now, myCall: "OK1HRA"});
  check(box.deferredFor("OK2ABC", now + 6 * 24 * 3600000).length === 1, "six days in it still tries");
  check(box.deferredFor("OK2ABC", now + 8 * 24 * 3600000).length === 0, "after seven it does not");
  check(store.byId(third.id).state === "attention" && store.byId(third.id).reason === "expired",
    "and it says why it stopped rather than vanishing");

  // Parked at an intermediary: terminal, because the ACK proves storage there,
  // never delivery to the recipient.
  const fourth = box.defer({to: "OK3XYZ", text: "VIA SOMEBODY", nowMs: now, myCall: "OK1HRA"});
  box.handOffDeferred(fourth.id, "OK4REL");
  check(store.byId(fourth.id).state === "handed" && store.byId(fourth.id).via === "OK4REL",
    "a handed-off message records who has it");
  check(box.deferredFor("OK3XYZ", now).length === 0, "and stops being offered for sending");
  // Terminal states are evictable; a message still trying is not.
  const live = box.defer({to: "OK5AAA", text: "LIVE ONE", nowMs: now, myCall: "OK1HRA"});
  const victims = [];
  for (;;) { const victim = box._nextVictim(); if (!victim) break; victims.push(victim.id); store.remove(victim.id); }
  check(!victims.includes(live.id), "a message still trying is never evicted");
}

if (!process.exitCode)
  console.log("MSGBOX PASS migration=4 ladder=DELIVERED>READ>STORE>DEFERRED " +
    "neverEvicted=UNREAD+liveDEFERRED budget=bytes undo=sameId " +
    "advert=parsed delivery=split attempts=5/1h incoming=filed " +
    "deferred=7d/5tries ackCloses=true handoffTerminal=true");
