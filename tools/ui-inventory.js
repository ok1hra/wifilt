#!/usr/bin/env node
// UI inventory — every control an operator can see, pulled out of the pages and
// the scripts that build them.
//
// The manual is written from this list and then checked back against it, so the
// list has to be honest in both directions: a control that never reaches the
// list is a control the manual is free to forget, and a phantom entry sends the
// writer looking for a button that does not exist.
//
// Half of the DATA page does not exist in data.html at all -- js8-*.js builds it
// at run time -- so scanning the HTML alone reports a coverage that is not real.
// That is why the JS pass exists.
//
//   node tools/ui-inventory.js                 # human-readable inventory
//   node tools/ui-inventory.js --json          # machine-readable
//   node tools/ui-inventory.js --check FILE... # what those documents miss

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");

// Which script belongs to which page. A control built by js8-msgbox.js is a
// control of the DATA page, and the inventory has to say so, otherwise the
// per-chapter check cannot work.
const PAGES = {
  "log.html":      {title: "QRPLog",  scripts: [/^log\.js$/, /^log-db\.js$/, /^log-macros\.js$/, /^station-/, /^trx-help\.js$/]},
  "dxc.html":      {title: "DXC",     scripts: [/^dxcc?\.js$/]},
  "data.html":     {title: "DATA — JS8Call", scripts: [/^js8-/, /^data\.js$/, /^spectrum\.js$/, /^wake-lock\.js$/, /^lan-gate\.js$/, /^tx-/]},
  "wspr.html":     {title: "DATA — WSPR",    scripts: [/^wspr/, /^tx-/, /^lan-gate\.js$/]},
  "setup.html":    {title: "SETUP",   scripts: [/^setup-spine\.js$/, /^icom-/, /^station-/]},
  "datasync.html": {title: "LOGSYNC", scripts: [/^datasync\.js$/]},
  "bd.html":       {title: "BD",      scripts: [/^bd\.js$/]},
};

// Text that is a control's name in the UI but noise in a checklist: single
// glyphs, pure punctuation, units already covered by the field they sit on.
const NOISE = new Set(["", "?", "×", "✕", "✎", "▾", "▼", "^", "+", "-", "*?",
                       "Hz", "dB", "km", "kHz", "W", "%", "…", "&nbsp;"]);

function clean(s) {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, " ")        // nested markup inside a label
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function keep(label) {
  const c = clean(label);
  if (NOISE.has(c)) return "";
  if (c.length < 2 || c.length > 90) return "";
  // A label made only of an interpolation is the template, not the text.
  if (/^["'`+\s]*$/.test(c)) return "";
  return c;
}

function add(list, kind, label, id, origin, fromAttr) {
  const l = keep(label);
  if (!l && !id) return;
  list.push({kind, label: l, id: id || "", origin, fromAttr: !!fromAttr});
}

// ---------------------------------------------------------------- HTML pass

function scanHtml(src, origin, out) {
  let m;

  const buttons = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((m = buttons.exec(src))) {
    add(out, "button", m[2], idOf(m[1]), origin);
  }

  const summaries = /<summary\b([^>]*)>([\s\S]*?)<\/summary>/gi;
  while ((m = summaries.exec(src))) {
    add(out, "section", m[2], idOf(m[1]), origin);
  }

  const labels = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  while ((m = labels.exec(src))) {
    add(out, "field", m[2], idOf(m[1]), origin);
  }

  const inputs = /<(input|select|textarea)\b([^>]*)>/gi;
  while ((m = inputs.exec(src))) {
    const attrs = m[2];
    // A `name=` is the last resort and is never text the operator reads, so it
    // identifies the field in a listing but cannot be held against the manual.
    const shown = attrOf(attrs, "placeholder") || attrOf(attrs, "aria-label")
               || attrOf(attrs, "title");
    add(out, m[1] === "input" ? inputKind(attrs) : m[1],
        shown || attrOf(attrs, "name"), idOf(attrs), origin, !shown);
  }

  const tabs = /<a\b([^>]*class="[^"]*\btab\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = tabs.exec(src))) {
    add(out, "nav", m[2], idOf(m[1]), origin);
  }

  // Help tips carry behaviour the UI explains nowhere else, so they are part of
  // what the manual has to say.
  const tips = /data-tip="([^"]{10,})"/gi;
  while ((m = tips.exec(src))) {
    add(out, "help", m[1], "", origin);
  }
}

function inputKind(attrs) {
  const t = (attrOf(attrs, "type") || "text").toLowerCase();
  return t === "checkbox" || t === "radio" ? t : "input";
}

function idOf(attrs)          { return attrOf(attrs, "id"); }
function attrOf(attrs, name)  {
  const m = new RegExp(name + '="([^"]*)"', "i").exec(attrs || "");
  return m ? m[1] : "";
}

// ------------------------------------------------------------------ JS pass

function scanJs(src, origin, out) {
  let m;

  // el("button", "class", "LABEL") — the spine and several JS8 panels build
  // every control this way.
  const elCall = /\bel\(\s*["'](button|a|summary)["']\s*,\s*[^,)]*,\s*["'`]([^"'`]{2,60})["'`]/g;
  while ((m = elCall.exec(src))) add(out, "button", m[2], "", origin);

  // Markup assembled in a template literal or a concatenation.
  const inline = /<button\b([^>]*)>([^<{$]{2,60})</gi;
  while ((m = inline.exec(src))) add(out, "button", m[2], idOf(m[1]), origin);

  const inlineSummary = /<summary\b([^>]*)>([^<{$]{2,60})</gi;
  while ((m = inlineSummary.exec(src))) add(out, "section", m[2], idOf(m[1]), origin);

  const inlineOpt = /<option\b[^>]*>([^<{$]{2,60})</gi;
  while ((m = inlineOpt.exec(src))) add(out, "option", m[1], "", origin);

  // .textContent = "LABEL" on something that was just created as a control.
  const text = /\.textContent\s*=\s*["'`]([A-Z][^"'`]{1,50})["'`]/g;
  while ((m = text.exec(src))) add(out, "label", m[1], "", origin);

  // Status and refusal strings the operator will read and look up.
  const notes = /(?:note|status|reason|msg|warn|title)\w*\s*=\s*["'`]([A-Z][^"'`]{9,90})["'`]/g;
  while ((m = notes.exec(src))) add(out, "message", m[1], "", origin);
}

// -------------------------------------------------------------------- build

function inventory() {
  const files = fs.readdirSync(DATA);
  const pages = {};

  for (const [page, meta] of Object.entries(PAGES)) {
    const out = [];
    const html = path.join(DATA, page);
    if (fs.existsSync(html)) scanHtml(fs.readFileSync(html, "utf8"), page, out);

    for (const f of files) {
      if (!f.endsWith(".js") || f.endsWith(".min.js")) continue;
      if (!meta.scripts.some((re) => re.test(f))) continue;
      scanJs(fs.readFileSync(path.join(DATA, f), "utf8"), f, out);
    }

    // One control, one row: the same button often appears in the HTML and again
    // in the script that relabels it.
    const seen = new Set();
    pages[page] = {title: meta.title, items: out.filter((it) => {
      const key = (it.label || it.id).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })};
  }
  return pages;
}

// -------------------------------------------------------------------- check

// Controls that exist in the markup but are deliberately not offered to the
// operator, so the manual is right not to describe them. Keeping the list here,
// with the reason, is what stops the next person "fixing" the manual by
// documenting a feature nobody can reach.
const WITHHELD = [
  // data.html: the TX SESSION mode selector offers CHAT only. Both composers and
  // their modules stay in the page; only the operator-facing choice is gone.
  /gateway|email|payload|template|character policy|maximum body|peer callsign/i,
  /binary file|prepare offer|send offer|copy hash|pause|resume|save file/i,
  /tune and transmit|the peer operator expects|files are prepared|short message/i,
  // setup.html: the Blocked DXCC placeholder is sample data that names specific
  // countries. The manual describes the field and its format, deliberately
  // without repeating the sample -- so the sample is not vocabulary to match.
  /^Russia/i,
];

// Coverage cannot be a substring test. A manual writes "SSID and password" where
// the page says "Connect to WiFi SSID 1 ?", and demanding the literal string back
// only teaches the writer to paste labels -- which is the opposite of a manual.
// So a control counts as covered when the manual contains its content words.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "you",
  "are", "not", "all", "off", "its", "was", "has", "can", "any", "one", "two",
  // Storage badges and help markers: page furniture, not the control's name.
  "eeprom", "config", "live", "spiffs", "optional",
]);

function words(s) {
  return String(s)
    .replace(/&#?\w+;/g, " ")            // &times; &#x2191; and friends
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

// Status strings, tooltips and transient labels are worth knowing about but are
// not controls; a manual that documented every one would be a string dump.
const INFORMATIONAL = new Set(["help", "message", "label"]);

function check(pages, docs) {
  const manual = new Set(words(docs.map((f) => fs.readFileSync(f, "utf8")).join("\n")));
  const verbose = process.argv.includes("--verbose");
  let missing = 0, total = 0, info = 0;

  for (const [, {title, items}] of Object.entries(pages)) {
    const gaps = [], notes = [];
    for (const it of items) {
      if (!it.label || it.fromAttr) continue;
      if (WITHHELD.some((re) => re.test(it.label))) continue;
      const need = words(it.label);
      if (!need.length) continue;
      const absent = need.filter((w) => !manual.has(w));
      if (INFORMATIONAL.has(it.kind)) {
        if (absent.length) { notes.push(it); info++; }
        continue;
      }
      total++;
      // One unfamiliar word in a long label is a rewording; a label whose words
      // are mostly absent is a control the manual never mentions.
      if (absent.length && absent.length > need.length / 2) { gaps.push([it, absent]); missing++; }
    }
    if (!gaps.length && !(verbose && notes.length)) continue;
    console.log("\n### " + title);
    if (gaps.length) {
      console.log("  UNCOVERED CONTROLS (" + gaps.length + ")");
      for (const [g, absent] of gaps)
        console.log("    [" + g.kind + "] " + g.label + "   <- " + g.origin
                    + "   missing: " + absent.join(", "));
    }
    if (verbose && notes.length) {
      console.log("  undocumented status text (" + notes.length + ")");
      for (const n of notes) console.log("    [" + n.kind + "] " + n.label + "   <- " + n.origin);
    }
  }

  console.log("\n" + (total - missing) + "/" + total + " controls covered"
              + (info ? ", " + info + " status strings undocumented (--verbose to list)" : "") + ".");
  return missing;
}

// --------------------------------------------------------------------- main

const args = process.argv.slice(2);
const pages = inventory();

if (args[0] === "--json") {
  console.log(JSON.stringify(pages, null, 2));
} else if (args[0] === "--check") {
  process.exitCode = check(pages, args.slice(1)) ? 1 : 0;
} else {
  let n = 0;
  for (const [, {title, items}] of Object.entries(pages)) {
    console.log("\n### " + title + "  (" + items.length + " controls)");
    for (const it of items) {
      console.log("  [" + it.kind + "] " + (it.label || "(" + it.id + ")")
                  + (it.id && it.label ? "  #" + it.id : "") + "   <- " + it.origin);
    }
    n += items.length;
  }
  console.log("\n" + n + " controls total.");
}
