#!/usr/bin/env node
"use strict";

// Syntax-check the scripts the browser harnesses INJECT into the page.
//
// Those scripts live inside template literals, so `node --check` on the harness
// says nothing about them: the harness parses fine and the string is just a string.
// A syntax error in there is the worst failure mode this project has:
//
//   * the tag fails to parse, so nothing in it runs -- including the error handler
//     it installs, so no error is reported anywhere
//   * every server-side check then fails for its own unrelated reason
//   * and the run takes the full timeout first
//
// That is exactly what a duplicate `const settings` did while the batch-plan checks
// were being written, and it cost a seven-minute round trip to find. Run this first;
// it takes milliseconds.
//
// It is also the fifth appearance of the template-literal trap in this repo. The
// others were a backslash ending a regex, a backslash ending a comment, `\\s`
// degrading to `s`, and -- on 2026-09-07, in log-hotkey-smoke.js, which this file
// was NOT watching -- `/Alt\\+\\+/` degrading to `/Alt++/`, an invalid regex that
// cost exactly the seven-minute silent round trip described above. Those are style
// rules nobody can enforce; this is a check.
//
// So the list is no longer a list: every harness in tools/ is scanned. A check
// that has to be remembered when a harness is added is a check that is not there
// the day it is needed.

const fs = require("fs"), path = require("path"), vm = require("vm");

const HARNESSES = fs.readdirSync(__dirname).filter(name => name.endsWith(".js")).sort();

let checked = 0, failures = 0;

for (const name of HARNESSES) {
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  // Every `const NAME = ` followed by a backtick, up to the closing backtick at the
  // start of a line. Deliberately simple: the harnesses declare their page scripts
  // exactly this way, and a pattern that tried to be clever about nesting would be
  // the next thing to fail silently.
  const pattern = /const ([A-Z_][A-Z0-9_]*) = `/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const from = match.index + match[0].length;
    // The literal ends at the first backtick that is not escaped. Looking for
    // "\n`;" instead -- which is how every page script happens to end -- silently
    // swallowed the rest of the file whenever a SHORT literal came first, and then
    // reported the code that followed it as a broken page script.
    let end = -1;
    for (let i = from; i < source.length; i++) {
      if (source[i] === "\\") { i++; continue; }
      if (source[i] === "`") { end = i; break; }
    }
    if (end < 0) continue;
    let body = source.slice(from, end);
    // Only the ones that are really scripts, not a chunk of CSS or markup.
    if (!/\bfunction\b|=>|await /.test(body)) continue;
    if (/^\s*</.test(body)) continue;                 // an HTML page, not a script
    // The live-radio drivers are TEMPLATES: they interpolate a callsign, a
    // frequency, a peer's port. Those `${...}` are the harness's own, evaluated
    // where they are written, and there is nothing to resolve them to here -- so
    // stand a 0 in for each one and go on checking the syntax around it, which is
    // the part that breaks silently. (An interpolation is still a bug in a
    // browser harness's page script; nothing here can tell the two apart, and a
    // parse error is the thing worth catching either way.)
    body = body.replace(/(^|[^\\])\$\{[^{}]*\}/g, "$10");
    checked++;
    try {
      // Parse what the BROWSER gets, not what the file shows. The two differ: the
      // literal's escapes are processed when the harness builds the string, so a
      // regex written `/\d+/` in the file arrives as `/d+/` -- valid where it was
      // typed, wrong where it runs. Checking the raw text missed exactly that and
      // let a broken script reach Chrome, where a parse error means the whole tag
      // is skipped in silence.
      //
      // Evaluated in an EMPTY context, so an interpolation throws instead of
      // running: `${...}` inside these literals would be evaluated in the harness
      // rather than in the page, which is a bug of its own.
      const asShipped = vm.runInNewContext("`" + body + "`", Object.create(null));
      new vm.Script(asShipped, {filename: `${name}:${match[1]}`});
    } catch (error) {
      failures++;
      console.error(`FAIL ${name} ${match[1]}: ${error.message}`);
      // The line number is relative to the literal; give the file line too, which is
      // what an editor needs.
      const before = source.slice(0, from).split("\n").length;
      const inner = /:(\d+)/.exec(String(error.stack).split("\n")[0]);
      console.error(`     literal starts at ${name}:${before}` +
                    (inner ? `, so about line ${before + Number(inner[1]) - 1}` : ""));
    }
  }
}

console.log(`${checked - failures}/${checked} injected scripts parse`);
if (failures) process.exitCode = 1;
