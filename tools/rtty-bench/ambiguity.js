"use strict";
// Can the operator actually tell which stream is right? For every reference
// CALLSIGN: the token each stream printed there, and whether a wrong one
// still LOOKS like a callsign (then picking between the two is a guess).
const C = require("./channel.js");
const {align, decodeProto, decodeProd, CANDIDATES, POINTS} = require("./complement.js");
const CALL = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/;
function tokenAt(got, map, s, e) {
  const js = []; for (let k = s; k <= e; k++) if (map[k] >= 0) js.push(map[k]);
  if (!js.length) return "";
  let a = Math.min(...js), b = Math.max(...js);
  const sep = ch => ch === " " || ch === "\r" || ch === "\n";
  while (a > 0 && !sep(got[a - 1])) a--;
  while (b < got.length - 1 && !sep(got[b + 1])) b++;
  return got.slice(a, b + 1);
}
const pick = process.argv.slice(2).length ? process.argv.slice(2) : ["C, integrace 70 % bitu", "C, vzorek dřív (0,35 bitu)"];
for (const cname of pick) {
  const t = {calls: 0, aOk: 0, bOk: 0, either: 0, rescueObvious: 0, rescueConfusable: 0, bothWrong: 0,
             aOkBwrongPlausible: 0, disagreeBothPlausible: 0};
  for (const [, sc] of POINTS) for (let seed = 301; seed < 304; seed++) {
    const {samples, expected} = C.buildScenario(sc, seed, {minChars: 500});
    const ga = decodeProd(samples), gb = decodeProto(CANDIDATES[cname], samples);
    const ma = align(expected, ga), mb = align(expected, gb);
    const re = /[^ ]+/g; let m;
    while ((m = re.exec(expected))) {
      const w = m[0];
      if (!(CALL.test(w))) continue;
      const s = m.index, e = s + w.length - 1;
      const ta = tokenAt(ga, ma, s, e), tb = tokenAt(gb, mb, s, e);
      const aOk = ta === w, bOk = tb === w;
      t.calls++; t.aOk += aOk; t.bOk += bOk; t.either += aOk || bOk;
      if (!aOk && bOk) { if (CALL.test(ta)) t.rescueConfusable++; else t.rescueObvious++; }
      if (!aOk && !bOk) t.bothWrong++;
      if (aOk && !bOk && CALL.test(tb)) t.aOkBwrongPlausible++;
    }
  }
  const p = x => (100 * x / t.calls).toFixed(1) + " %";
  console.log(`\n${cname}   (${t.calls} značek)`);
  console.log(`  A správně ${p(t.aOk)}, B správně ${p(t.bOk)}, aspoň jeden ${p(t.either)}`);
  console.log(`  B zachránil, A má zjevný nesmysl:        ${p(t.rescueObvious)}`);
  console.log(`  B zachránil, ale A má taky věrohodnou značku: ${p(t.rescueConfusable)}  <- operátor hádá`);
  console.log(`  A správně, B ukazuje jinou věrohodnou značku: ${p(t.aOkBwrongPlausible)}  <- riziko špatné volby`);
}
