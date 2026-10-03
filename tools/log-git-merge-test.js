#!/usr/bin/env node
"use strict";

// GIT LOG SYNC's merge, without a browser.
//
// mergeBackups() decides what every device's log ends up as, and a wrong
// decision there does not crash anything: a QSO edited on one device quietly
// reverts on the next sync, or a deleted log comes back, or one is deleted that
// should not have been. Each rule from the 2026-10-02 grill gets a check here.

const path = require("path");
const core = require(path.join(__dirname, "..", "data", "log-git-sync.js"));
const { mergeBackups, snapshotToFile, qsoFromTransport, serializeFile, canon } = core;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -- " + detail : "")); }
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function log(id, extra) {
  return Object.assign({ id, contestName: id.slice(11), stationCall: "OK1HRA", myLocator: "JO60NA",
    createdAtUtc: "2026-09-01T10:00:00.000Z", updatedAtUtc: "2026-09-01T10:00:00.000Z",
    nextQsoNumber: 1, active: false }, extra || {});
}
function qso(id, logId, call, created, extra) {
  return Object.assign({ id, logId, call, qsoNumber: 1, qsoDateUtc: created.slice(0, 10),
    timeOnUtc: created.slice(11, 16), frequencyHz: 14025000, mode: "CW", createdAtUtc: created }, extra || {});
}
// A browser's database as buildBackup() returns it.
function db(logs, qsos, devices) {
  return { export_version: 1, exported_at: "x", stores: { logs, qso: qsos, settings: [], sync_state: [], devices: devices || [] } };
}
const file = (dev, d, tombs) => snapshotToFile(d, dev, tombs || []);

const L1 = "2026-09-01-CQWW";

// ── 1. first sync into an empty repository
{
  const a = file(A, db([log(L1, { active: true, nextQsoNumber: 3 })],
                       [qso(1, L1, "W1AW", "2026-09-01T10:01:00.000Z"), qso(2, L1, "DL1XX", "2026-09-01T10:02:00.000Z")]));
  const m = mergeBackups(a, null);
  check("empty repo: file is created", m.remoteChanged);
  check("empty repo: both QSOs out", m.merged.stores.qso.length === 2 && m.outCount === 2);
  check("empty repo: nothing written locally",
        m.localChanges.qsoAdd.length === 0 && m.localChanges.qsoUpdate.length === 0);
  check("own QSO ids become <dev>:<n>", m.merged.stores.qso.every(q => q.id.startsWith(A + ":") && q.source_device_id === A));
  check("`active` never leaves the browser", m.merged.stores.logs.every(l => !("active" in l)));
  check("idempotent: merging the result again changes nothing",
        !mergeBackups(a, m.merged).remoteChanged && mergeBackups(a, m.merged).localChanges.qsoAdd.length === 0);
}

// ── 2. two devices, union
{
  const a = file(A, db([log(L1)], [qso(1, L1, "W1AW", "2026-09-01T10:01:00.000Z")]));
  const b = file(B, db([log(L1)], [qso(1, L1, "JA1ZZ", "2026-09-01T11:00:00.000Z"), qso(2, L1, "VK2AA", "2026-09-01T11:05:00.000Z")]));
  const afterA = mergeBackups(a, null).merged;
  const mb = mergeBackups(b, afterA);
  check("union: B's push holds A's and B's QSOs", mb.merged.stores.qso.length === 3);
  check("union: B receives A's QSO", mb.localChanges.qsoAdd.length === 1 && mb.localChanges.qsoAdd[0].call === "W1AW");
  check("same local id on two devices is two QSOs", mb.localChanges.collisions.length === 0);
  const back = qsoFromTransport(mb.localChanges.qsoAdd[0], B);
  check("a foreign QSO keeps its string id", back.id === A + ":1");
  const ma = mergeBackups(a, mb.merged);
  check("A then receives B's two", ma.localChanges.qsoAdd.length === 2 && !ma.remoteChanged);
  check("own QSO returns under its own number", qsoFromTransport(mb.merged.stores.qso.find(q => q.id === A + ":1"), A).id === 1);
}

// ── 3. newer change wins, both ways; a tie keeps this browser's
{
  const base = qso(1, L1, "W1AW", "2026-09-01T10:01:00.000Z");
  const a = file(A, db([log(L1)], [base]));
  const inGit = mergeBackups(a, null).merged;
  const edited = file(A, db([log(L1)], [Object.assign({}, base, { call: "W1AX", updatedAtUtc: "2026-09-02T08:00:00.000Z" })]));
  const m1 = mergeBackups(edited, inGit);
  check("local edit is pushed", m1.remoteChanged && m1.merged.stores.qso[0].call === "W1AX");
  // B holds the old copy (via LOGSYNC) and syncs: it must take the edit, not push the old one back
  const bOld = file(B, db([log(L1)], [Object.assign({}, inGit.stores.qso[0])]));
  const m2 = mergeBackups(bOld, m1.merged);
  check("remote edit lands on the device with the old copy",
        m2.localChanges.qsoUpdate.length === 1 && m2.localChanges.qsoUpdate[0].call === "W1AX" && !m2.remoteChanged);
  const del = file(B, db([log(L1)], [Object.assign({}, m1.merged.stores.qso[0], { deleted: true, updatedAtUtc: "2026-09-03T00:00:00.000Z" })]));
  const m3 = mergeBackups(del, m1.merged);
  check("soft delete travels like an edit", m3.merged.stores.qso[0].deleted === true && m3.remoteChanged);
  const tieL = file(A, db([log(L1)], [Object.assign({}, base, { rstSent: "599", updatedAtUtc: "2026-09-05T00:00:00.000Z" })]));
  const tieR = mergeBackups(file(A, db([log(L1)], [Object.assign({}, base, { rstSent: "579", updatedAtUtc: "2026-09-05T00:00:00.000Z" })])), null).merged;
  const m4 = mergeBackups(tieL, tieR);
  check("tie: this browser's version wins", m4.merged.stores.qso[0].rstSent === "599" && m4.localChanges.qsoUpdate.length === 0);
}

// ── 4. tombstones
{
  const qa = qso(1, L1, "W1AW", "2026-09-01T10:01:00.000Z");
  const inGit = mergeBackups(file(A, db([log(L1)], [qa])), null).merged;
  // A deletes the log: its DB no longer has it, and holds a tombstone
  const aAfter = file(A, db([], []), [{ id: L1, deletedAtUtc: "2026-09-10T00:00:00.000Z" }]);
  const m1 = mergeBackups(aAfter, inGit);
  check("deleted log leaves the file", m1.merged.stores.logs.length === 0 && m1.merged.stores.qso.length === 0);
  check("tombstone goes into the file", m1.merged.deleted_logs.length === 1);
  check("the deleter is not asked about its own deletion", m1.localChanges.logDelete.length === 0);
  // B still has the log
  const bHas = file(B, db([log(L1)], [Object.assign({}, inGit.stores.qso[0])]));
  const m2 = mergeBackups(bHas, m1.merged);
  check("B is asked to delete it", m2.localChanges.logDelete.length === 1 && m2.localChanges.logDelete[0].qsoCount === 1);
  check("B deletes its QSOs of that log", m2.localChanges.qsoDelete.length === 1);
  check("B receives the tombstone", m2.localChanges.tombstones.length === 1);
  check("B does not push the log back", m2.merged.stores.logs.length === 0 && !m2.remoteChanged);
  // created again the same day, under the same id
  const again = file(A, db([log(L1, { createdAtUtc: "2026-09-10T12:00:00.000Z", updatedAtUtc: "2026-09-10T12:00:00.000Z" })],
                           [qso(5, L1, "ZL1AA", "2026-09-10T12:05:00.000Z")]),
                     [{ id: L1, deletedAtUtc: "2026-09-10T00:00:00.000Z" }]);
  const m3 = mergeBackups(again, m1.merged);
  check("a log created again after the deletion survives",
        m3.merged.stores.logs.length === 1 && m3.merged.stores.qso.length === 1 && m3.merged.stores.qso[0].call === "ZL1AA");
  // the same, against a device still holding the OLD log
  const m4 = mergeBackups(bHas, m3.merged);
  check("...and replaces the old one elsewhere",
        m4.localChanges.logDelete.length === 1 && m4.localChanges.logAdd.length === 1 &&
        m4.localChanges.qsoDelete.length === 1 && m4.localChanges.qsoAdd.length === 1);
  check("the later of two tombstones wins",
        mergeBackups(file(A, db([], []), [{ id: "x", deletedAtUtc: "2026-01-01" }]),
                     { stores: { logs: [], qso: [], devices: [] }, deleted_logs: [{ id: "x", deletedAtUtc: "2026-02-01" }] })
          .merged.deleted_logs[0].deletedAtUtc === "2026-02-01");
}

// ── 5. log metadata
{
  const a = file(A, db([log(L1, { active: true, nextQsoNumber: 40, updatedAtUtc: "2026-09-01T12:00:00.000Z" })], []));
  const r = mergeBackups(file(B, db([log(L1, { nextQsoNumber: 55, defaultExchange: "15",
                                                updatedAtUtc: "2026-09-01T13:00:00.000Z" })], [])), null).merged;
  const m = mergeBackups(a, r);
  const out = m.merged.stores.logs[0];
  check("nextQsoNumber is the larger one", out.nextQsoNumber === 55);
  check("newer metadata wins", out.defaultExchange === "15");
  check("metadata change is written locally", m.localChanges.logUpdate.length === 1);
  const r2 = mergeBackups(file(B, db([log(L1, { nextQsoNumber: 10, updatedAtUtc: "2026-09-01T13:00:00.000Z" })], [])), null).merged;
  check("nextQsoNumber never goes back", mergeBackups(a, r2).merged.stores.logs[0].nextQsoNumber === 40);
}

// ── 6. identity collision (DB cleared, device id kept)
{
  const old = mergeBackups(file(A, db([log(L1)], [qso(1, L1, "W1AW", "2026-08-01T10:00:00.000Z")])), null).merged;
  const fresh = file(A, db([log(L1)], [qso(1, L1, "OK2ZZ", "2026-09-20T10:00:00.000Z")]));
  const m = mergeBackups(fresh, old);
  check("collision is reported, not resolved", m.localChanges.collisions.length === 1);
  check("collision: the QSO in git is kept", m.merged.stores.qso.some(q => q.call === "W1AW"));
}

// ── 7. the file
{
  const m = mergeBackups(file(A, db([log(L1)], [qso(1, L1, "W1AW", "2026-09-01T10:01:00.000Z"),
                                                 qso(2, L1, "DL1XX", "2026-09-01T10:02:00.000Z")])), null);
  const text = serializeFile(m.merged, "2026-10-02T00:00:00.000Z");
  const parsed = JSON.parse(text);
  check("file is valid JSON with stores (LOGSYNC Import reads it)", !!parsed.stores && parsed.stores.qso.length === 2);
  check("one record per line", text.split("\n").filter(l => l.includes('"call"')).length === 2);
  const m2 = mergeBackups(file(A, db([log(L1)], [qso(1, L1, "W1AW", "2026-09-01T10:01:00.000Z"),
                                                  qso(2, L1, "DL1XX", "2026-09-01T10:02:00.000Z"),
                                                  qso(3, L1, "EA1AA", "2026-09-01T10:03:00.000Z")])), parsed);
  const text2 = serializeFile(m2.merged, "2026-10-02T01:00:00.000Z");
  const a = text.split("\n"), b = text2.split("\n");
  const added = b.filter(l => !a.includes(l)), removed = a.filter(l => !b.includes(l));
  check("a new QSO is a small diff (+qso, ~exported_at, ~nextQsoNumber line)",
        added.length <= 3 && removed.length <= 2 && added.some(l => l.includes("EA1AA")), JSON.stringify({ added, removed }));
  check("exported_at alone is not a change", !mergeBackups(file(A, db([log(L1)], [qso(1, L1, "W1AW", "2026-09-01T10:01:00.000Z"),
          qso(2, L1, "DL1XX", "2026-09-01T10:02:00.000Z")])), Object.assign({}, parsed, { exported_at: "other" })).remoteChanged);
  const shuffled = JSON.parse(text);
  shuffled.stores.qso = shuffled.stores.qso.map(q => { const o = {}; Object.keys(q).reverse().forEach(k => { o[k] = q[k]; }); return o; });
  check("key order is not a change", canon(shuffled.stores.qso[0]) === canon(parsed.stores.qso[0]));
  check("token/settings never in the file", !text.includes("token") && !("settings" in parsed.stores));
}

// ── 8. one QSO, two ids (2026-10-03, the doubled history)
// The same QSO reaches browsers under two ids: a file import keeps the file's
// own ("import:LOG:N"), LOGSYNC's pairing rewrites it to "<device>:<seq>"
// (datasync.js insertRemoteQsos). Both carry the same source_device_id and
// source_seq -- LOGSYNC's real identity. Matching on `id` made every imported
// QSO two QSOs after one sync, and the next sync pulled the second copy into
// every browser.
{
  const IMP = "00000000-0000-0000-0000-import000001";
  const L2 = "2020-10-20-GENERAL";
  const base = { logId: L2, call: "VE2ZM", qsoNumber: 468, qsoDateUtc: "2024-12-13", timeOnUtc: "19:11",
                 frequencyHz: 14059000, mode: "CW", createdAtUtc: "2024-12-13T19:11:00Z",
                 source_device_id: IMP, source_seq: 7213 };
  const viaFile = Object.assign({ id: "import:" + L2 + ":468" }, base);
  const viaSync = Object.assign({ id: IMP + ":7213" }, base);
  const browserB = file(B, db([log(L2)], [viaSync]));
  const gitFromA = mergeBackups(file(A, db([log(L2)], [viaFile])), null).merged;
  const m1 = mergeBackups(browserB, gitFromA);
  check("two ids, one identity: still one QSO in the file", m1.merged.stores.qso.length === 1,
        m1.merged.stores.qso.map(q => q.id).join(","));
  check("...and nothing is added locally", m1.localChanges.qsoAdd.length === 0 && m1.localChanges.qsoDelete.length === 0);
  check("the file settles on LOGSYNC's id", m1.merged.stores.qso[0].id === IMP + ":7213");

  // A browser already holding both copies (what the bad syncs left behind)
  const doubled = file(B, db([log(L2)], [viaSync, viaFile]));
  const m2 = mergeBackups(doubled, null);
  check("a doubled browser: the file gets one copy", m2.merged.stores.qso.length === 1);
  check("...and the extra copy here is deleted, under its own key",
        m2.localChanges.qsoDelete.length === 1 && m2.localChanges.qsoDelete[0].__localKey === viaFile.id,
        JSON.stringify(m2.localChanges.qsoDelete.map(q => q.__localKey)));
  check("...keeping LOGSYNC's copy", !m2.localChanges.qsoAdd.length && m2.merged.stores.qso[0].id === IMP + ":7213");

  // A doubled file in git (what commit b289db0 holds)
  const doubledGit = { stores: { logs: [logToFileLike(log(L2))], qso: [viaSync, viaFile], devices: [] }, deleted_logs: [] };
  const m3 = mergeBackups(file(A, db([log(L2)], [viaFile])), doubledGit);
  check("a doubled file is collapsed and pushed", m3.merged.stores.qso.length === 1 && m3.remoteChanged);
  check("...without adding anything here", m3.localChanges.qsoAdd.length === 0 && m3.localChanges.qsoDelete.length === 0);

  // A newer copy from git replaces the local one under the local one's key
  const edited = Object.assign({}, viaSync, { rstSent: "579", updatedAtUtc: "2026-10-03T20:00:00.000Z" });
  const m4 = mergeBackups(file(A, db([log(L2)], [viaFile])), { stores: { logs: [], qso: [edited], devices: [] }, deleted_logs: [] });
  check("a newer copy lands once: written under the new key, the old key removed",
        m4.localChanges.qsoUpdate.length === 1 && m4.localChanges.qsoDelete.length === 1 &&
        m4.localChanges.qsoDelete[0].__localKey === viaFile.id, JSON.stringify(m4.localChanges.qsoDelete.map(q => q.__localKey)));
  check("no local bookkeeping leaks into the file",
        !JSON.stringify(m2.merged).includes("__localKey") && !JSON.stringify(m4.merged).includes("__localKey"));

  // This browser's own QSO that came back to it through LOGSYNC as "<me>:<n>"
  const own = qso(5, L2, "OK2ZZ", "2026-10-01T10:00:00.000Z");
  const back = Object.assign({}, own, { id: A + ":5", source_device_id: A, source_seq: 5 });
  const m5 = mergeBackups(file(A, db([log(L2)], [own, back])), null);
  check("own QSO held twice: one in the file, the string copy deleted, the numbered one kept",
        m5.merged.stores.qso.length === 1 && m5.localChanges.qsoDelete.length === 1 &&
        m5.localChanges.qsoDelete[0].__localKey === A + ":5", JSON.stringify(m5.localChanges.qsoDelete.map(q => q.__localKey)));
}

function logToFileLike(l) { const r = Object.assign({}, l); delete r.active; return r; }

console.log("\n" + pass + "/" + (pass + fail) + " passed");
process.exit(fail ? 1 : 0);
