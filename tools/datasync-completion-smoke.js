// When LOGSYNC is allowed to say "Done".
//
// Reported from a real 16 000-QSO sync between two browsers: the Phase field
// read "Done ✓" while the transfer was still running, and then a completed
// transfer was repainted as "Failed" when the other side pressed Cancel.
//
// One cause behind both. `pendingReqIds` counts the requests THIS side made --
// that is, what it is still receiving. The side doing the sending has an empty
// set from the first message on, so it declared the sync over before it had sent
// anything, told the other side so, and the other side believed it while still
// writing thousands of records. And because "done" was reached that early, the
// close that ends every sync arrived in states where it still counted as a
// failure.
//
// So the rule is checked here as a rule, without a browser: three inputs, and no
// combination of them may report finished while either side still has work.

const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const {datasyncCompletion} = require(path.join(ROOT, "data", "datasync.js"));

const failures = [];
function check(name, ok) { if (!ok) failures.push(name); }

function state(over) {
  return Object.assign({
    helloReceived: true, doneSent: false, doneReceived: false,
    pendingRequests: 0, outboundSends: 0
  }, over || {});
}

// The exact shape of the bug: the sending side, at the moment the hello arrives.
// It wants nothing, so its request set is empty -- but it is about to push 16 000
// QSOs, and sendBatches() is already running.
let s = datasyncCompletion(state({outboundSends: 1}));
check("a side that is still sending is not finished", s.localDone === false);
check("and does not announce", s.announce === false);
check("and is certainly not done", s.finished === false);

// The receiving half of the same session.
s = datasyncCompletion(state({pendingRequests: 1}));
check("a side that is still receiving is not finished", s.localDone === false);
check("and does not announce", s.announce === false);

// Both at once -- a genuine two-way sync.
check("neither direction alone is enough",
  datasyncCompletion(state({pendingRequests: 1, outboundSends: 1})).localDone === false);

// Nothing may be decided before the other side has even said hello: an empty
// request set at that point means "nothing asked yet", not "nothing to ask".
check("silence before the hello is not completion",
  datasyncCompletion(state({helloReceived: false})).localDone === false);

// Idle on this side: announce once, but the SYNC is not over until the other
// side says the same about itself.
s = datasyncCompletion(state());
check("an idle side announces itself", s.announce === true);
check("but is not done while the other side has not answered", s.finished === false);

s = datasyncCompletion(state({doneSent: true}));
check("the announcement is not repeated", s.announce === false);
check("still not done on one side's word", s.finished === false);

s = datasyncCompletion(state({doneSent: true, doneReceived: true}));
check("done when both sides are finished", s.finished === true);
check("and nothing is announced twice", s.announce === false);

// The remote finishing first must not carry this side with it -- that is exactly
// what put "Done ✓" on a screen that was still importing.
check("the remote's word does not finish a side that is still receiving",
  datasyncCompletion(state({doneReceived: true, pendingRequests: 1})).finished === false);
check("nor one that is still sending",
  datasyncCompletion(state({doneReceived: true, outboundSends: 1})).finished === false);

// ---- source contract -------------------------------------------------------
const src = fs.readFileSync(path.join(ROOT, "data", "datasync.js"), "utf8");

// Sending is the only work the sender has, so finishing it is the only thing
// that can complete that side. Nothing else calls checkDone() there.
check("finishing a send re-checks completion",
  /outboundSends\+\+;[\s\S]{0,400}finally \{[\s\S]{0,200}outboundSends--;[\s\S]{0,200}checkDone\(\);/.test(src));
// A finished sync ends with somebody closing the connection. That is the normal
// last event, not a failure.
check("a close after a completed sync is not a failure",
  /if \(phase === 'done'\) \{[\s\S]{0,400}return;\s*\}\s*\n\s*if \(pc\.iceConnectionState === 'failed'\)/.test(src));
// Sliced rather than matched across: a regex reaching past the closing brace
// finds checkDone()'s own setPhase('done') and reports the opposite of the truth.
const onSyncDoneBody = (function () {
  const start = src.indexOf("function onSyncDone(");
  if (start < 0) return "";
  const end = src.indexOf("\n  }", start);
  return end < 0 ? "" : src.slice(start, end);
}());
check("the remote's sync_done records it and re-checks",
  /doneReceived = true;/.test(onSyncDoneBody) && /checkDone\(\);/.test(onSyncDoneBody));
check("the remote's sync_done no longer sets the phase by itself",
  onSyncDoneBody.length > 0 && !/setPhase\(/.test(onSyncDoneBody));
// Every counter has to be cleared when a channel opens, or a second sync in the
// same page inherits the first one's bookkeeping.
check("a new channel starts from a clean slate",
  /doneReceived  = false;/.test(src) && /outboundSends = 0;/.test(src));

const total = 21;
if (failures.length) {
  console.error("DATASYNC COMPLETION FAIL (" + failures.length + " of " + total + ")\n  "
    + failures.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("DATASYNC COMPLETION PASS " + total + " checks");
}
