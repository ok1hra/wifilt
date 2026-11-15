#!/usr/bin/env node
'use strict';
// DXCC.lookupDxcc() (data/dxcc.js) on the calls that showed its old table up,
// and on what the table generated from cty.dat (tools/build-dxcc.js) must keep.
//
// Why: a 276-QSO contest log (OK/OM DX, 2026-11-14) had UY7LM, UZ7E, UX1VT,
// UY7AM, UW1G (Ukraine), AR5EJ (Pakistan) and VO1AW (Canada) with no country at
// all, and YL2PJ as Sri Lanka. The hand-written table missed whole prefix
// blocks and ~45 entities, and carried junk aliases (DJ8, YL2 under 4S).
//
//   node tools/dxcc-lookup-test.js
//   node tools/dxcc-lookup-test.js <cty.dat>   # also: the table is current

const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'data', 'dxcc.js'), 'utf8'), sandbox);
const L = sandbox.window.DXCC.lookupDxcc;

const checks = [];
const check = (name, ok, detail) => checks.push([name, !!ok, detail || '']);
const show = r => r ? [r.country, r.mainPrefix, r.continent, r.cqZone, r.ituZone].join('|') : 'null';
function is(call, country, more) {
  const r = L(call);
  const ok = r && r.country === country &&
    Object.keys(more || {}).every(k => r[k] === more[k]);
  check(call + ' -> ' + country + (more ? ' ' + JSON.stringify(more) : ''), ok, show(r));
}

// ---- the log that found it -------------------------------------------------
['UY7LM', 'UZ7E', 'UX1VT', 'UY7AM', 'UW1G', 'UU9CW/LH'].forEach(c => is(c, 'Ukraine'));
is('AR5EJ', 'Pakistan');
is('VO1AW', 'Canada');
is('YL2PJ', 'Latvia');                       // was Sri Lanka (alias YL2)
is('DJ8XX', 'Germany');                      // was Sri Lanka (alias DJ8)
// ... and what it already got right stays right
is('OK1HRA', 'Czech Republic', { mainPrefix: 'OK', cqZone: 15, ituZone: 28 });
is('SM5/UY5OO', 'Sweden');
is('3Z0X', 'Poland');
is('KP2M', 'US Virgin Is');
is('LC5A', 'Norway');
is('M4D', 'England');
is('E79D', 'Bosnia-Herzegovina');
is('EC8M', 'Canary Is', { continent: 'AF' });
is('BI4VIP', 'China');

// ---- names and main prefixes other code depends on --------------------------
// log-stats.js (US/VE states) reads K, KL, KH6, VE; SETUP's blocked list
// matches "russia" inside these names; QSOs store the name.
is('K2SSS', 'USA', { mainPrefix: 'K' });
is('KL7ABC', 'Alaska', { mainPrefix: 'KL' });
is('KH6ABC', 'Hawaii', { mainPrefix: 'KH6' });
is('VE3VA', 'Canada', { mainPrefix: 'VE' });
is('UA3ABC', 'European Russia');
is('UA9ABC', 'Asiatic Russia');
is('UA2ABC', 'Kaliningrad');
is('RA8ABC', 'Asiatic Russia');              // was European Russia
is('UT2EE', 'Ukraine', { mainPrefix: 'UT' });

// ---- per-prefix zones from cty.dat -----------------------------------------
is('W6ABC', 'USA', { cqZone: 3 });
is('K0ABC', 'USA', { cqZone: 4 });
is('VE3VA', 'Canada', { cqZone: 4 });
is('RA0ABC', 'Asiatic Russia', { cqZone: 18 });

// ---- entities the old table did not have ------------------------------------
is('5B4AHJ', 'Cyprus');
is('D2XX', 'Angola');
is('S79XX', 'Seychelles');
is('V85XX', 'Brunei Darussalam');
is('CY0XX', 'Sable Island');

// ---- exact calls kept, WAE folded --------------------------------------------
is('TO0T', 'St Barthelemy');                 // TO is France by prefix
is('KC4AAA', 'Antarctica', { continent: 'AN' }); // KC4 is the USA by prefix; AN as always (DXC: OTHER)
is('3D2RA', 'Rotuma I');                     // no prefix of its own
is('4U1VIC', 'Austria');                     // WAE Vienna Intl Ctr, DXCC Austria
is('IT9ABC', 'Italy', { continent: 'EU' });  // WAE Sicily
is('TA1ABC', 'Turkey', { continent: 'EU' }); // WAE European Turkey
is('TA2ABC', 'Turkey', { continent: 'AS' });

// ---- slashes ---------------------------------------------------------------
is('R1BJA/0', 'Asiatic Russia');             // /digit moves the call area
is('UA3ABC/9', 'Asiatic Russia');
is('EA1AK/8', 'Canary Is');
is('W1AW/4', 'USA');
is('KH6DLK/0', 'USA');                       // not KH0, the Marianas
is('A60AAP/2', 'UAE');                       // the 6 is UAE's, not a call area
is('S50A/1', 'Slovenia');
is('OK1HRA/P', 'Czech Republic');
is('DL/OK1HRA', 'Germany');
check('OK1HRA/MM has no DXCC', L('OK1HRA/MM') === null, show(L('OK1HRA/MM')));
check('nothing for nothing', L('') === null && L(null) === null);

// ---- the table is what cty.dat gives ---------------------------------------
const cty = process.argv[2];
if (cty) {
  const { execFileSync } = require('child_process');
  let ok = true, out = '';
  try { out = execFileSync('node', [path.join(__dirname, 'build-dxcc.js'), cty, '--check'], { encoding: 'utf8' }); }
  catch (e) { ok = false; out = String(e.stdout || '') + String(e.stderr || ''); }
  check('data/dxcc.js is generated from ' + path.basename(cty), ok, out.trim().split('\n').pop());
}

const failed = checks.filter(c => !c[1]);
for (const [name, ok, detail] of checks)
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail && !ok ? ' -- ' + detail : ''));
console.log('DXCC LOOKUP ' + (failed.length ? 'FAIL' : 'PASS') + ' ' +
            (checks.length - failed.length) + '/' + checks.length);
process.exitCode = failed.length ? 1 : 0;
