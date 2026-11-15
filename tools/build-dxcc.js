#!/usr/bin/env node
'use strict';
/**
 * build-dxcc.js -- regenerate the country table in data/dxcc.js from cty.dat
 *
 *   node tools/build-dxcc.js <path/to/cty.dat> [--check]
 *
 * cty.dat is AD1C's country file (https://www.country-files.com/, the "CT"
 * flavour -- cty.dat, not wl_cty.dat). The table between the two BEGIN/END
 * markers in data/dxcc.js is rewritten from it; nothing else in that file is
 * touched. --check writes nothing and exits 1 when the file would change.
 *
 * Why generated (2026-11-15): the table used to be written by hand, "based on"
 * cty.dat, and had drifted far from it. A contest log of 276 QSOs showed it --
 * UY/UZ/UX/UW (Ukraine), AR (Pakistan), VO1 (Canada) came back with no country
 * at all, and YL2PJ came back as Sri Lanka, which carried DJ8 and YL2 as
 * aliases. Checked against every prefix in cty.dat, about a quarter resolved to
 * nothing and many to the wrong entity (R8/RA8/RU0 as European Russia, ...),
 * and some 45 DXCC entities -- Cyprus, Angola, Seychelles, Brunei -- were not
 * in it at all.
 *
 * What is kept from the hand-written table, deliberately:
 *   - the country NAMES. They are stored with every QSO (q.dxcc), exported to
 *     CSV, and matched by SETUP's blocked-DXCC list as substrings ("russia"
 *     must keep matching "European Russia" and "Asiatic Russia"). OUR_NAME maps
 *     cty.dat's spelling back to ours; an entity we never had keeps cty.dat's.
 *   - the main prefixes shown as "prefix" (status bar, CSV dxccPrefix) and
 *     read by log-stats.js (K, KL, KH6, VE). OUR_PREFIX likewise.
 *   - one DXCC entity per country: cty.dat's WAE-only entities (marked "*":
 *     Sicily, Shetland, European Turkey, Bear Island, Vienna Intl Ctr) are
 *     folded into the DXCC entity they belong to, as the old table did.
 *
 * What comes from cty.dat: every prefix, the per-prefix CQ/ITU zone and
 * continent overrides (W0 is CQ 4, VE3 is CQ 4, UA0 is CQ 19 ...), and
 * latitude/longitude/UTC offset.
 *
 * Exact callsigns, only where a prefix cannot answer -- asked of the real
 * lookupDxcc() over the prefix-only table, so CALL/digit, /P and PREFIX/CALL
 * are judged the way the page will judge them. Kept: a call no prefix finds,
 * every call of an entity with no prefix of its own (Rotuma, Conway Reef,
 * Vienna Intl Ctr), and a call that lands in another country (TO0T is St.
 * Barthelemy, not France; KC4AAA is Antarctica, not the USA). Left out: calls
 * that land in another entity of the SAME administration (FAMILIES: the USA
 * and its territories, Russia, the UK) -- individual operators living away
 * from their call's area, a W6 in Hawaii, a UA3 in Siberia, a G in Scotland.
 * There are thousands of them, they would multiply this file's size, served
 * from the ESP32's flash on every QRPlog, DXC and JS8 page load, and they go
 * stale as people move. Such a call reads as its prefix's country, as in most
 * loggers without cty.dat.
 *
 * Longitude: cty.dat counts west as positive, this table east, as before.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'data', 'dxcc.js');
const BEGIN = '  // BEGIN GENERATED TABLE (tools/build-dxcc.js)';
const END = '  // END GENERATED TABLE';

// cty.dat name -> the name this interface has always shown.
const OUR_NAME = {
  'Sov Mil Order of Malta': 'Sov. Mil. Order of Malta',
  'Madeira Islands': 'Madeira Is',
  'Fed. Rep. of Germany': 'Germany',
  'Balearic Islands': 'Balearic Is',
  'Canary Islands': 'Canary Is',
  'Aland Islands': 'Aland Is',
  'Faroe Islands': 'Faroe Is',
  'Asiatic Turkey': 'Turkey',
  'Republic of Kosovo': 'Kosovo',
  'Mariana Islands': 'Mariana Is',
  'Johnston Island': 'Johnston Is',
  'Midway Island': 'Midway Is',
  'Palmyra & Jarvis Islands': 'Palmyra & Jarvis Is',
  'Baker & Howland Islands': 'Baker & Howland Is',
  'Wake Island': 'Wake Is',
  'US Virgin Islands': 'US Virgin Is',
  'Navassa Island': 'Navassa Is',
  'Desecheo Island': 'Desecheo Is',
  'United States': 'USA',
  'St. Pierre & Miquelon': 'St Pierre & Miquelon',
  'Clipperton Island': 'Clipperton Is',
  'Cayman Islands': 'Cayman Is',
  'Turks & Caicos Islands': 'Turks & Caicos Is',
  'St. Kitts & Nevis': 'St Kitts & Nevis',
  'St. Martin': 'Saint Martin',
  'St. Barthelemy': 'St Barthelemy',
  'Saba & St. Eustatius': 'Saba & St Eustatius',
  'St. Lucia': 'St Lucia',
  'St. Vincent': 'St Vincent',
  'British Virgin Islands': 'British Virgin Is',
  'Falkland Islands': 'Falkland Is',
  'South Georgia Island': 'South Georgia I',
  'South Sandwich Islands': 'South Sandwich Is',
  'South Orkney Islands': 'South Orkney Is',
  'Peter 1 Island': 'Peter I Is',
  'Bouvet': 'Bouvet I',
  'Republic of South Sudan': 'South Sudan',
  'Dem. Rep. of the Congo': 'Congo (DRC)',
  'Republic of the Congo': 'Congo Republic',
  'The Gambia': 'Gambia',
  'Annobon Island': 'Annobon I',
  'Pr. Edward & Marion Is.': 'Prince Edward & Marion Is',
  'Kingdom of Eswatini': 'Eswatini',
  'Reunion Island': 'Reunion',
  'Rodriguez Island': 'Rodriguez I',
  'Agalega & St. Brandon': 'Agalega & St Brandon',
  'Crozet Island': 'Crozet I',
  'Kerguelen Islands': 'Kerguelen Is',
  'Amsterdam & St. Paul Is.': 'Amsterdam & St Paul Is',
  'Heard Island': 'Heard I',
  'Palestine': 'Palestinian Auth',
  'United Arab Emirates': 'UAE',
  'Andaman & Nicobar Is.': 'Andaman & Nicobar Is',
  'Lakshadweep Islands': 'Lakshadweep Is',
  'West Malaysia': 'Malaysia (W)',
  'East Malaysia': 'Malaysia (E)',
  'Timor - Leste': 'East Timor',
  'Republic of Korea': 'Korea (South)',
  'DPR of Korea': 'Korea (North)',
  'Spratly Islands': 'Spratly Is',
  'Lord Howe Island': 'Lord Howe I',
  'Norfolk Island': 'Norfolk I',
  'Macquarie Island': 'Macquarie I',
  'Kermadec Islands': 'Kermadec Is',
  'Chatham Islands': 'Chatham Is',
  'Rotuma Island': 'Rotuma I',
  'Tokelau Islands': 'Tokelau Is',
  'North Cook Islands': 'Cook Is (N)',
  'South Cook Islands': 'Cook Is (S)',
  'Marquesas Islands': 'Marquesas Is',
  'Austral Islands': 'Austral Is',
  'Wallis & Futuna Islands': 'Wallis & Futuna Is',
  'Chesterfield Islands': 'Chesterfield Is',
  'Solomon Islands': 'Solomon Is',
  'Temotu Province': 'Temotu',
  'Western Kiribati': 'Kiribati (Gilbert Is)',
  'Central Kiribati': 'Kiribati (Phoenix Is)',
  'Eastern Kiribati': 'Kiribati (Line Is)',
  'Banaba Island': 'Banaba I',
  'Marshall Islands': 'Marshall Is',
  'Pitcairn Island': 'Pitcairn I',
  'Easter Island': 'Easter I',
  'San Felix & San Ambrosio': 'Desventuradas Is',
  'Juan Fernandez Islands': 'Juan Fernandez Is',
  'Galapagos Islands': 'Galapagos Is',
  'St. Helena': 'St Helena',
  'Ascension Island': 'Ascension I',
  'Tristan da Cunha & Gough': 'Tristan da Cunha',
};

// cty.dat primary prefix -> ours, where they differ. cty.dat's "/x" forms are
// its own identifiers, not prefixes; ours are upper-cased the same way.
const OUR_PREFIX = {
  'EU': 'EW',        // Belarus
  'UR': 'UT',        // Ukraine
  'CM': 'CO',        // Cuba
  'CE9': 'KC4',      // Antarctica
  'JD/o': 'JD1',     // Ogasawara
};

// cty.dat name -> continent, where ours differs. cty.dat files Antarctica
// and the islands south of 60 S under SA; this interface always said AN
// (ADIF's own code for it), and the DXC page's spotter filter puts AN in its
// OTHER box on purpose. South Shetland was not in the old table; it joins its
// neighbours.
const OUR_CONT = {
  'Antarctica': 'AN',
  'South Orkney Islands': 'AN',
  'South Shetland Islands': 'AN',
  'Peter 1 Island': 'AN',
};

// WAE-only entities ("*" in cty.dat) -> the DXCC entity (cty.dat name) they
// are part of.
const WAE_PARENT = {
  '4U1V': 'Austria',
  'GM/s': 'Scotland',
  'IT9': 'Italy',
  'IG9': 'Italy',
  'JW/b': 'Svalbard',
  'TA1': 'Asiatic Turkey',
};

// ── cty.dat ──────────────────────────────────────────────────────────────────

function parseAlias(raw) {
  const ov = {};
  let s = raw;
  const take = (re, key, conv) => {
    const m = re.exec(s);
    if (m) { ov[key] = conv(m[1]); s = s.replace(re, ''); }
  };
  take(/\((\d+)\)/, 'cq', Number);
  take(/\[(\d+)\]/, 'itu', Number);
  take(/\{([A-Z]{2})\}/, 'cont', String);
  s = s.replace(/<[^>]*>|~[^~]*~/g, '');
  return { text: s, ov };
}

function parseCty(text) {
  const out = [];
  for (const rec of text.split(';')) {
    const t = rec.trim();
    if (!t) continue;
    const lines = t.split(/\r?\n/);
    const h = lines[0].split(':').map(x => x.trim());
    if (h.length < 8 || !h[7]) continue;
    const e = {
      name: h[0], cq: +h[1], itu: +h[2], cont: h[3],
      lat: +h[4], lon: -(+h[5]), utc: +h[6],
      pfx: h[7].replace(/^\*/, ''), wae: h[7].startsWith('*'),
      prefixes: [], exact: [],
    };
    const body = lines.slice(1).join('').replace(/\s+/g, '');
    for (const a of body.split(',')) {
      if (!a) continue;
      if (a.startsWith('=')) e.exact.push(parseAlias(a.slice(1)));
      else e.prefixes.push(parseAlias(a));
    }
    out.push(e);
  }
  return out;
}

// ── build ────────────────────────────────────────────────────────────────────

function build(ctyText) {
  const cty = parseCty(ctyText);
  cty.forEach(e => { if (OUR_CONT[e.name]) e.cont = OUR_CONT[e.name]; });
  const version = (/=VER(\d{8})/.exec(ctyText) || [])[1] || 'unknown';
  const byName = {};
  cty.forEach(e => { byName[e.name] = e; });

  // Fold WAE-only entities into their DXCC parent. Their own zone and
  // continent go onto each of their prefixes, so IT9 still reads as zone 15
  // EU and TA1 as EU, not as the parent's.
  const entities = cty.filter(e => !e.wae);
  cty.filter(e => e.wae).forEach(e => {
    const parent = byName[WAE_PARENT[e.pfx]];
    if (!parent) throw new Error('WAE entity ' + e.pfx + ' (' + e.name + ') has no parent in WAE_PARENT');
    // An exact call of a WAE entity with no prefix of its own (4U1VIC) is
    // kept like any exact-only entity's: the parent's prefixes cannot find it.
    const own = a => ({ text: a.text, keep: e.prefixes.length === 0, ov: Object.assign(
      { cq: e.cq, itu: e.itu, cont: e.cont }, a.ov) });
    e.prefixes.forEach(a => parent.prefixes.push(own(a)));
    e.exact.forEach(a => parent.exact.push(own(a)));
  });

  const fmtOv = ov => (ov.cq != null ? '(' + ov.cq + ')' : '') +
                      (ov.itu != null ? '[' + ov.itu + ']' : '') +
                      (ov.cont ? '{' + ov.cont + '}' : '');
  // An override equal to the entity's own value says nothing.
  function trimOv(e, ov) {
    const o = {};
    if (ov.cq != null && ov.cq !== e.cq) o.cq = ov.cq;
    if (ov.itu != null && ov.itu !== e.itu) o.itu = ov.itu;
    if (ov.cont && ov.cont !== e.cont) o.cont = ov.cont;
    return o;
  }
  const nameOf = e => OUR_NAME[e.name] || e.name;

  // Pass 1: the prefixes alone.
  const prefixAliases = entities.map(e => {
    const out = [], seen = new Set();
    e.prefixes.forEach(a => {
      if (seen.has(a.text)) return;
      seen.add(a.text);
      out.push(a.text + fmtOv(trimOv(e, a.ov)));
    });
    return out;
  });

  // Pass 2: which exact calls are needed is asked of the REAL lookupDxcc(),
  // running over the pass-1 table -- so this tool and data/dxcc.js cannot
  // disagree about what a prefix (or a /P, a /digit, a PREFIX/CALL) finds.
  const lookup = runtimeLookup(renderTable(entities, prefixAliases, version, 0, 0));

  let exactKept = 0, exactDropped = 0;
  const aliases = entities.map((e, i) => {
    const out = prefixAliases[i].slice();
    const want = nameOf(e);
    e.exact.forEach(a => {
      // lookupDxcc() reads /MM and /AM as no DXCC; an exact entry would undo that.
      if (/\/(MM|AM)$/.test(a.text)) { exactDropped++; return; }
      const got = lookup(a.text);
      const gotName = got ? got.country : null;
      const keep = gotName !== want && (
        !gotName ||                          // no prefix finds it at all
        e.prefixes.length === 0 || a.keep || // its entity has no prefix of its own
        !sameFamily(gotName, want));         // not a resident of the same administration
      if (!keep) { exactDropped++; return; }
      exactKept++;
      out.push('=' + a.text + fmtOv(trimOv(e, a.ov)));
    });
    return out;
  });

  const table = renderTable(entities, aliases, version, exactKept, exactDropped);
  return { table, version, entities: entities.length, exactKept, exactDropped };
}

// Exact calls between two entities of one administration are individual
// operators living away from their call's area (a W6 in Hawaii, a UA3 in
// Siberia, a G in Scotland): thousands of them, stale as soon as people move.
// Left out -- see the header. Between any other two entities (TO0T on St.
// Barthelemy, not in France; KC4AAA in Antarctica, not the USA) they stay.
const FAMILIES = [
  ['USA', 'Alaska', 'Hawaii', 'Puerto Rico', 'US Virgin Is', 'Guam', 'Mariana Is',
   'American Samoa', 'Swains Island', 'Baker & Howland Is', 'Johnston Is', 'Midway Is',
   'Palmyra & Jarvis Is', 'Kure Island', 'Wake Is', 'Navassa Is', 'Desecheo Is',
   'Guantanamo Bay'],
  ['European Russia', 'Asiatic Russia', 'Kaliningrad'],
  ['England', 'Scotland', 'Wales', 'Northern Ireland', 'Isle of Man', 'Jersey', 'Guernsey'],
];
function sameFamily(a, b) {
  return FAMILIES.some(f => f.includes(a) && f.includes(b));
}

function renderTable(entities, aliases, version, exactKept, exactDropped) {
  const num = v => String(Math.round(v * 100) / 100);
  const rows = entities.map((e, i) => '    [' + [
    JSON.stringify(OUR_NAME[e.name] || e.name), e.cq, e.itu, JSON.stringify(e.cont),
    num(e.lat), num(e.lon), num(e.utc),
    JSON.stringify(OUR_PREFIX[e.pfx] || e.pfx.toUpperCase()),
    '[' + aliases[i].map(a => JSON.stringify(a)).join(',') + ']'].join(',') + '],');
  return [
    BEGIN,
    '  // From cty.dat VER' + version + ' (AD1C, https://www.country-files.com/).',
    '  // Do not edit by hand: change tools/build-dxcc.js and run it again.',
    '  // ' + rows.length + ' entities; ' + exactKept + ' exact calls kept, ' + exactDropped +
      ' left out -- see the tool\'s header.',
    '  const CTY_RAW = [',
    ...rows,
    '  ];',
    END,
  ].join('\n');
}

// data/dxcc.js with `table` in place of its own, evaluated: its lookupDxcc().
function runtimeLookup(table) {
  const vm = require('vm');
  const src = spliceTable(fs.readFileSync(TARGET, 'utf8'), table);
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.DXCC.lookupDxcc;
}

function spliceTable(src, table) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error('markers not found in ' + TARGET);
  return src.slice(0, a) + table + src.slice(b + END.length);
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const ctyPath = args.find(a => !a.startsWith('--'));
  if (!ctyPath) {
    console.error('usage: node tools/build-dxcc.js <path/to/cty.dat> [--check]');
    process.exit(2);
  }
  const res = build(fs.readFileSync(ctyPath, 'latin1'));
  const src = fs.readFileSync(TARGET, 'utf8');
  const out = spliceTable(src, res.table);
  console.log('cty.dat VER' + res.version + ': ' + res.entities + ' entities, ' +
              res.exactKept + ' exact calls kept, ' + res.exactDropped + ' left out');
  if (check) {
    if (out !== src) { console.error('data/dxcc.js is not what this cty.dat gives'); process.exit(1); }
    return;
  }
  if (out !== src) fs.writeFileSync(TARGET, out);
  console.log((out !== src ? 'wrote ' : 'unchanged ') + path.relative(ROOT, TARGET) +
              ' (' + Buffer.byteLength(out) + ' B)');
}

if (require.main === module) main();
module.exports = { build, parseCty, OUR_NAME, WAE_PARENT };
