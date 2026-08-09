'use strict';

const fs = require('fs');

const html = fs.readFileSync('data/setup.html', 'utf8');
const css = fs.readFileSync('data/setup.css', 'utf8');
const firmware = fs.readFileSync('wifilt.ino', 'utf8');
const lanClient = fs.readFileSync('icomLanClient.h', 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (let slot = 1; slot <= 3; slot += 1) {
  const prefix = `trx${slot}`;
  const select = html.match(new RegExp(
    `<select name="${prefix}transport"[\\s\\S]*?<\\/select>`
  ));
  assert(select, `${prefix} connection select missing`);
  for (const value of ['lan', 'trxnet', 'civ']) {
    assert(select[0].includes(`value="${value}"`), `${prefix} missing ${value}`);
  }
  for (const field of ['label', 'civaddr', 'netid', 'lanip', 'lanuser', 'lanpass']) {
    assert(html.includes(`name="${prefix}${field}"`), `${prefix}${field} missing`);
  }
}

assert(!html.match(/option[^>]+value="bt"/i), 'Bluetooth option returned');
assert(html.includes('TRX1 over TRXNET is limited'), 'TRX1 limitation is not visible');
assert(html.includes('context.dataset.connections.split'),
  'connection-dependent field switching missing');
assert(html.includes('input.disabled = !visible || !enabled'),
  'hidden transport fields are still submitted');
assert(html.includes('form._validateRadios'), 'radio form validation hook missing');
assert(css.includes('.setup-radio-workspace'), 'variant B workspace CSS missing');
assert(css.includes('grid-template-columns: 230px minmax(0, 1fr)'), 'desktop split layout missing');
assert(css.includes('grid-template-columns: repeat(3, minmax(0, 1fr))'), 'mobile radio tabs missing');

assert(firmware.includes('type != "setFrequency"'), 'TRX1 TrxNet command gate missing');
assert(firmware.includes('unsupported_transport'), 'limited-command error missing');
assert(firmware.includes('for (uint8_t candidate = 0; candidate < 3; candidate++)'),
  'three-slot CI-V address routing missing');
assert(firmware.includes('for (uint8_t slot = 0; slot < 3; slot++)'),
  'three-slot configuration loop missing');
assert(firmware.includes('void radioSlotSetFrequencyState(uint8_t slot'),
  'shared frequency state adapter missing');
assert(firmware.includes('frequency = freq;')
  && firmware.includes('g_trxFreq[slot - 1] = (long)freq;'),
  'TRX1 and TRX2/3 frequency state paths are not both routed');
assert(firmware.includes('setModesText(mode);')
  && firmware.includes('g_trxMode[slot - 1]'),
  'TRX1 and TRX2/3 mode state paths are not both routed');
assert(firmware.includes('radioLanLocalControlPort(slot)'),
  'per-slot LAN port routing missing');
// The client hands every frame to one router and stays slot-agnostic; the
// sketch decides what a slot's state means.
assert(lanClient.includes('lanCivFrameRoute(radioSlot'),
  'LAN frame routing hook missing');
assert(firmware.includes('void lanCivFrameRoute(uint8_t slot')
  && firmware.includes('if (slot == 0) { lanCivFrameHandler(frame, len); return; }')
  && firmware.includes('lanSecondaryCivFrameHandler(slot, frame, len);'),
  'LAN frame routing does not split TRX1 full CAT from per-slot state');
assert(lanClient.includes('audioAllowed ? audioLocalPort : 0'),
  'LAN audio port suppression missing');

// LAN may live in any slot, and the JS8 audio/PTT path plus the LAN view of
// /state have to follow it there rather than assuming TRX1.
assert(firmware.includes('uint8_t lanRadioSlotIndex(void)'),
  'LAN slot lookup missing');
assert(firmware.includes('bool withAudio = slot == lanRadioSlotIndex();'),
  'LAN audio is not bound to the slot that owns the LAN radio');
assert(firmware.includes('webServer.arg("radio") == "lan"'),
  '/state and /cmd cannot address the LAN radio');
assert(firmware.includes('bool catWriteFrameSlot(uint8_t slot'),
  'per-slot CAT write path missing');
assert(!/lanMode\s*&&\s*lanClient\.connected\(\)/.test(firmware)
  && !/!lanMode\s*\|\|\s*!lanClient\.connected\(\)/.test(firmware),
  'audio path still gates on the TRX1-only lanMode mirror');

console.log('SETUP RADIO CONTRACT PASS');
