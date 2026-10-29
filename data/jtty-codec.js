// JTTY source grammar: the 34-bit frame payload, text <-> frames, and the
// native function-key templates. A JS port of WSJT-X lib/jtty (GPL-3, pinned
// at v3.3.0-beta5 d89fe30ca): jtty_source_codec.f90, jtty_mod.f90 pack_jtty/
// unpack_jtty, the call28 part of lib/77bit/packjt77.f90 and the live-entry
// filler rule of jtty_filler.f90. No DSP here -- jtty-modem.js puts these
// frames on the air. docs/jtty-implementace.md §1 is the plain-language map.
//
// A frame is a Uint8Array(34) of 0/1, bit 1 first, exactly the '0'/'1' string
// upstream passes around: bits 1-32 the grammar word, bit 33 reserved zero,
// bit 34 end-of-message. The 32-bit word is built with multiplication rather
// than JS bit operators, which are signed 32-bit and would mangle bit 1.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JttyCodec = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ +-./?!\"#$%,&*()_'=[]{}<>|:;";
  const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const MAX_FRAMES = 16;
  const MAX_TEXT = 80;
  const FRAME_BITS = 34;

  const ATOM = Object.freeze({CALL: 0, EXCH_NUM: 1, EXCH_LOC: 2, EXCH_PAIR: 3,
    EXCH_NUM_TIME: 4, CONTROL: 5, GRID4: 6, TEXT5: 7});
  const CALL = Object.freeze({CQ: 0, CALL: 1, TU_CQ: 2, CALL_TU: 3, CALL_AGN: 4, TU_NOW: 5});
  const ROLE = Object.freeze({FIELD_ONLY: 0, FULL: 1});
  const NUM = Object.freeze({SERIAL: 0, CQ_ZONE: 1, ITU_ZONE: 2, AGE: 3, POWER: 4,
    CHECK: 5, LICENSE_YEAR: 6, GENERIC: 7});
  const LOC = Object.freeze({STATE_PROVINCE: 0, SECTION: 1, COUNTRY_PREFIX: 2, QTH: 3, ADMIN_CODE: 4});
  const PAIR = Object.freeze({ZONE_LOC3: 0, CLASS_SECTION: 1});
  const PROFILE = Object.freeze({UNKNOWN: 0, FIELD_DAY: 1, RTTY: 2});

  const CONTROL_TEXT = Object.freeze(["AGN?", "CALL?", "AGN CALL", "NR?", "AGN NR", "EXCH?",
    "STATE?", "SECTION?", "ZONE?", "GRID?", "RPRT?", "QSL TU", "TU", "QRZ?", "QSO B4",
    "WAIT", "NIL?", "OK?"]);

  // PACK77_ARRL_SECTIONS, lib/77bit/packjt77_grammar.f90; wire values 1..86.
  const ARRL_SECTIONS = Object.freeze(("AB AK AL AR AZ BC CO CT DE EB EMA ENY EPA EWA GA GH " +
    "IA ID IL IN KS KY LA LAX NS MB MDC ME MI MN MO MS MT NC ND NE NFL NH NL NLI NM NNJ NNY " +
    "TER NTX NV OH OK ONE ONN ONS OR ORG PAC PR QC RI SB SC SCV SD SDG SF SFL SJV SK SNJ STX " +
    "SV TN UT VA VI VT WCF WI WMA WNY WPA WTX WV WWA WY DX PE NB").split(" "));

  const NTOKENS = 2063592;
  const MAX22 = 4194304;
  const A1 = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const A2 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const A3 = "0123456789";
  const A4 = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const isDigit = c => c >= "0" && c <= "9";
  const isLetter = c => c >= "A" && c <= "Z";

  // ── call28 ─────────────────────────────────────────────────────────────

  // chkcall.f90: a syntax filter for standard and compound calls.
  function chkcall(w) {
    const n1 = w.length;
    if (n1 > 11 || /[.+\-?]/.test(w)) return false;
    const i0 = w.indexOf("/") + 1;
    if (n1 > 6 && i0 <= 0) return false;
    if (Math.max(i0 - 1, n1 - i0) > 6) return false;
    let bc = w.slice(0, 6);
    if (i0 >= 2 && i0 <= n1 - 1) bc = (i0 - 1 <= n1 - i0) ? w.slice(i0) : w.slice(0, i0 - 1);
    bc = bc.trimEnd();
    if (bc.length > 6) return false;
    if (!isLetter(bc[0] || "") && !isLetter(bc[1] || "")) return false;
    if (bc[0] === "Q" && bc.slice(0, 5) !== "QU1RK") return false;
    let i1 = 0;
    if (isDigit(bc[1] || "")) i1 = 2;
    if (isDigit(bc[2] || "")) i1 = 3;
    if (i1 === 0 || i1 === bc.length) return false;
    let n = 0;
    for (let i = i1; i < bc.length; i++) {
      if (!isLetter(bc[i])) return false;
      n++;
    }
    return n >= 1 && n <= 3;
  }

  // pack77_c28_standard_shape (packjt77_grammar.f90).
  function c28StandardShape(t) {
    const n = t.length;
    if (n < 3 || n > 6 || !/^[A-Z0-9]+$/.test(t)) return false;
    let iarea = 0;
    for (let i = n; i >= 2; i--) if (isDigit(t[i - 1])) { iarea = i; break; }
    if (iarea !== 2 && iarea !== 3) return false;
    let npdig = 0, nplet = 0;
    for (let i = 0; i < iarea - 1; i++) (isDigit(t[i]) ? npdig++ : nplet++);
    if (nplet === 0 || npdig >= iarea - 1) return false;
    for (let i = iarea; i < n; i++) if (!isLetter(t[i])) return false;
    return n - iarea <= 3;
  }

  // callok (packjt77.f90), applied to what unpack28 produced.
  function callok(w) {
    const n = w.length;
    if (n < 3 || w[0] === "Q") return false;
    let i0 = 0;
    for (let i = n; i >= 1; i--) if (isDigit(w[i - 1])) { i0 = i; break; }
    if (i0 !== 2 && i0 !== 3) return false;
    const pfx = w.slice(0, i0 - 1);
    if (!/^[A-Z0-9]+$/.test(pfx) || !/[A-Z]/.test(pfx)) return false;
    const ns = n - i0;
    if (ns < 1 || ns > 3) return false;
    return /^[A-Z]+$/.test(w.slice(i0));
  }

  // Standard-call branch of pack28_core. Anything else (tokens, hashes) is not
  // a JTTY call atom, so -1 instead of a hash.
  function pack28(call) {
    if (!c28StandardShape(call)) return -1;
    let iarea = 0;
    for (let i = call.length; i >= 2; i--) if (isDigit(call[i - 1])) { iarea = i; break; }
    const cs = (iarea === 2 ? " " + call.slice(0, 5) : call.slice(0, 6)).padEnd(6, " ");
    const i1 = A1.indexOf(cs[0]), i2 = A2.indexOf(cs[1]), i3 = A3.indexOf(cs[2]);
    const i4 = A4.indexOf(cs[3]), i5 = A4.indexOf(cs[4]), i6 = A4.indexOf(cs[5]);
    if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0 || i5 < 0 || i6 < 0) return -1;
    const n28 = 36 * 10 * 27 * 27 * 27 * i1 + 10 * 27 * 27 * 27 * i2 + 27 * 27 * 27 * i3 +
      27 * 27 * i4 + 27 * i5 + i6 + NTOKENS + MAX22;
    return n28 % 268435456;
  }

  function unpack28(n28) {
    if (n28 < NTOKENS + MAX22) return null;
    let n = n28 - NTOKENS - MAX22;
    const i1 = Math.floor(n / (36 * 10 * 27 * 27 * 27)); n -= 36 * 10 * 27 * 27 * 27 * i1;
    const i2 = Math.floor(n / (10 * 27 * 27 * 27)); n -= 10 * 27 * 27 * 27 * i2;
    const i3 = Math.floor(n / (27 * 27 * 27)); n -= 27 * 27 * 27 * i3;
    const i4 = Math.floor(n / (27 * 27)); n -= 27 * 27 * i4;
    const i5 = Math.floor(n / 27);
    const i6 = n - 27 * i5;
    if (i1 >= A1.length || i2 >= A2.length) return null;
    const c = (A1[i1] + A2[i2] + A3[i3] + A4[i4] + A4[i5] + A4[i6]).trim();
    if (!callok(c) || c.indexOf(" ") >= 0) return null;
    return c;
  }

  // jtty_standard_call / standard_call: only calls the 28-bit field carries
  // exactly. /P, /MM, 4-letter suffixes and the like fall back to TEXT5.
  function standardCall(call) {
    if (typeof call !== "string" || !call || !chkcall(call)) return false;
    if (call.indexOf("/") >= 0 || call[0] === "Q" || !/^[A-Z0-9]+$/.test(call)) return false;
    const n28 = pack28(call);
    return n28 >= 0 && unpack28(n28) === call;
  }

  // ── atoms ──────────────────────────────────────────────────────────────

  const callAtom = (action, text) => ({kind: ATOM.CALL, subtype: action, role: 0, value: 0, value2: 0, text});
  const numAtom = (role, kind, value) => ({kind: ATOM.EXCH_NUM, subtype: kind, role, value, value2: 0, text: ""});
  const locAtom = (role, kind, text) => ({kind: ATOM.EXCH_LOC, subtype: kind, role, value: 0, value2: 0, text});
  const zoneLocAtom = (zone, text) => ({kind: ATOM.EXCH_PAIR, subtype: PAIR.ZONE_LOC3, role: 0, value: zone, value2: 0, text});
  const classSectionAtom = (count, cls, section) =>
    ({kind: ATOM.EXCH_PAIR, subtype: PAIR.CLASS_SECTION, role: 0, value: count, value2: section, text: cls});
  const numTimeAtom = (role, serial, minute) => ({kind: ATOM.EXCH_NUM_TIME, subtype: 0, role, value: serial, value2: minute, text: ""});
  const controlAtom = id => ({kind: ATOM.CONTROL, subtype: id, role: 0, value: 0, value2: 0, text: ""});
  const grid4Atom = (role, grid) => ({kind: ATOM.GRID4, subtype: 0, role, value: 0, value2: 0, text: grid});
  const text5Atom = text => ({kind: ATOM.TEXT5, subtype: 0, role: 0, value: 0, value2: 0, text: text.slice(0, 5).padEnd(5, " ")});

  const validRole = r => r === 0 || r === 1;

  function validNumber(kind, value) {
    if (!(kind >= 0 && kind <= 7 && value >= 0 && value <= 131071 && Number.isInteger(value))) return false;
    if (kind === NUM.CQ_ZONE) return value >= 1 && value <= 40;
    if (kind === NUM.ITU_ZONE) return value >= 1 && value <= 90;
    if (kind === NUM.LICENSE_YEAR) return value <= 9999;
    return true;
  }

  function packBase36(token) {
    if (token.length !== 2 && token.length !== 3) return -1;
    let v = 0;
    for (const c of token) {
      const d = BASE36.indexOf(c);
      if (d < 0) return -1;
      v = 36 * v + d;
    }
    if (token.length === 3 && v < 36 * 36) return -1;
    return v;
  }

  function unpackBase36(value, n) {
    let s = "";
    for (let i = 0; i < n; i++) { s = BASE36[value % 36] + s; value = Math.floor(value / 36); }
    return s;
  }

  function grid4Index(grid) {
    if (typeof grid !== "string" || grid.length !== 4) return -1;
    const a = grid.charCodeAt(0) - 65, b = grid.charCodeAt(1) - 65;
    const c = grid.charCodeAt(2) - 48, d = grid.charCodeAt(3) - 48;
    if (!(a >= 0 && a < 18 && b >= 0 && b < 18 && c >= 0 && c < 10 && d >= 0 && d < 10)) return -1;
    return ((a * 18 + b) * 10 + c) * 10 + d;
  }

  function indexGrid4(v) {
    const d = v % 10; v = Math.floor(v / 10);
    const c = v % 10; v = Math.floor(v / 10);
    const b = v % 18, a = Math.floor(v / 18);
    return String.fromCharCode(65 + a, 65 + b, 48 + c, 48 + d);
  }

  const sectionIndex = name => ARRL_SECTIONS.indexOf(name) + 1;   // 0 = unknown

  // finish_struct: body27 | family3 | i2=2.
  const struct32 = (body, family) => 4 * (8 * body + family) + 2;

  // pack_jtty_atom -> the 32-bit grammar word, or -1.
  function atomWord(atom) {
    switch (atom.kind) {
      case ATOM.CALL: {
        if (!(atom.subtype >= 0 && atom.subtype <= 5) || !standardCall(atom.text)) return -1;
        const n28 = pack28(atom.text);
        const i2 = atom.subtype <= 3 ? 0 : 1;
        const n2 = atom.subtype <= 3 ? atom.subtype : atom.subtype - 4;
        return n28 * 16 + 4 * n2 + i2;
      }
      case ATOM.EXCH_NUM:
        if (!validRole(atom.role) || !validNumber(atom.subtype, atom.value)) return -1;
        return struct32(atom.role * 2 ** 26 + atom.subtype * 2 ** 22 + atom.value * 32, 0);
      case ATOM.EXCH_LOC: {
        if (!validRole(atom.role) || !(atom.subtype >= 0 && atom.subtype <= 4)) return -1;
        const n = atom.text.length, v = packBase36(atom.text);
        if (v < 0) return -1;
        return struct32(atom.role * 2 ** 26 + atom.subtype * 2 ** 22 + (n - 2) * 2 ** 21 + v * 32, 1);
      }
      case ATOM.EXCH_PAIR: {
        let pair;
        if (atom.subtype === PAIR.ZONE_LOC3) {
          if (!(atom.value >= 1 && atom.value <= 40)) return -1;
          const n = atom.text.length, v = packBase36(atom.text);
          if (v < 0) return -1;
          pair = atom.value * 2 ** 17 + (n - 2) * 2 ** 16 + v;
        } else if (atom.subtype === PAIR.CLASS_SECTION) {
          if (!(atom.value >= 1 && atom.value <= 32)) return -1;
          if (!(atom.value2 >= 1 && atom.value2 <= ARRL_SECTIONS.length) || atom.text.length !== 1) return -1;
          const cls = atom.text.charCodeAt(0) - 65;
          if (!(cls >= 0 && cls <= 5)) return -1;
          pair = atom.value * 2 ** 17 + cls * 2 ** 14 + atom.value2 * 2 ** 7;
        } else return -1;
        return struct32(atom.subtype * 2 ** 24 + pair * 2, 2);
      }
      case ATOM.EXCH_NUM_TIME:
        if (!validRole(atom.role) || !(atom.value >= 0 && atom.value <= 16383)) return -1;
        if (!(atom.value2 >= 0 && atom.value2 <= 1439)) return -1;
        return struct32(atom.role * 2 ** 26 + atom.value * 2 ** 12 + atom.value2 * 2, 3);
      case ATOM.CONTROL:
        if (!(atom.subtype >= 0 && atom.subtype <= 17)) return -1;
        return struct32(atom.subtype * 2 ** 16, 4);
      case ATOM.GRID4: {
        if (!validRole(atom.role)) return -1;
        const g = grid4Index(atom.text);
        if (g < 0) return -1;
        return struct32(2 ** 23 + atom.role * 2 ** 22 + g * 2 ** 7, 4);
      }
      case ATOM.TEXT5: {
        let top30 = 0;
        for (let i = 0; i < 5; i++) {
          const k = ALPHABET.indexOf(atom.text[i]);
          if (k < 0) return -1;
          top30 = 64 * top30 + k;
        }
        return 4 * top30 + 3;
      }
      default: return -1;
    }
  }

  function packAtom(atom, eom) {
    const word = atomWord(atom);
    if (word < 0) return null;
    const bits = new Uint8Array(FRAME_BITS);
    let w = word;
    for (let i = 31; i >= 0; i--) { bits[i] = w % 2; w = Math.floor(w / 2); }
    bits[32] = 0;
    bits[33] = eom ? 1 : 0;
    return bits;
  }

  // Field of `width` bits whose lowest bit sits `lsb` bits above the word's.
  const field = (word, lsb, width) => Math.floor(word / 2 ** lsb) % 2 ** width;

  // unpack_jtty_atom -> {atom, eom} or null for anything the grammar refuses.
  function unpackAtom(bits) {
    if (!bits || bits.length !== FRAME_BITS || bits[32] !== 0) return null;
    let word = 0;
    for (let i = 0; i < 32; i++) word = 2 * word + (bits[i] ? 1 : 0);
    if (word === 0) return null;
    const eom = bits[33] === 1;
    const i2 = word % 4;
    const top30 = Math.floor(word / 4);
    if (i2 === 0 || i2 === 1) {
      const n2 = top30 % 4;
      if (i2 === 1 && n2 > 1) return null;
      const call = unpack28(Math.floor(word / 16));
      if (!call || !standardCall(call)) return null;
      return {atom: callAtom(i2 === 0 ? n2 : n2 + 4, call), eom};
    }
    if (i2 === 3) {
      let text = "";
      for (let i = 0; i < 5; i++) text += ALPHABET[field(top30, 6 * (4 - i), 6)];
      return {atom: text5Atom(text), eom};
    }
    const family = top30 % 8;
    const body = Math.floor(top30 / 8);
    let atom = null;
    switch (family) {
      case 0: {
        if (field(body, 0, 5) !== 0) return null;
        atom = numAtom(field(body, 26, 1), field(body, 22, 4), field(body, 5, 17));
        if (!validNumber(atom.subtype, atom.value)) return null;
        break;
      }
      case 1: {
        const kind = field(body, 22, 4), n = field(body, 21, 1) + 2, v = field(body, 5, 16);
        if (field(body, 0, 5) !== 0 || kind > 4 || v >= 36 ** n || (n === 3 && v < 36 * 36)) return null;
        atom = locAtom(field(body, 26, 1), kind, unpackBase36(v, n));
        break;
      }
      case 2: {
        const schema = field(body, 24, 3), pair = field(body, 1, 23);
        if (field(body, 0, 1) !== 0) return null;
        if (schema === PAIR.ZONE_LOC3) {
          const zone = field(pair, 17, 6), n = field(pair, 16, 1) + 2, v = field(pair, 0, 16);
          if (zone < 1 || zone > 40 || v >= 36 ** n || (n === 3 && v < 36 * 36)) return null;
          atom = zoneLocAtom(zone, unpackBase36(v, n));
        } else if (schema === PAIR.CLASS_SECTION) {
          const count = field(pair, 17, 6), cls = field(pair, 14, 3), sec = field(pair, 7, 7);
          if (count < 1 || count > 32 || cls > 5 || sec < 1 || sec > ARRL_SECTIONS.length || field(pair, 0, 7) !== 0) return null;
          atom = classSectionAtom(count, String.fromCharCode(65 + cls), sec);
        } else return null;
        break;
      }
      case 3: {
        const minute = field(body, 1, 11);
        if (field(body, 0, 1) !== 0 || minute > 1439) return null;
        atom = numTimeAtom(field(body, 26, 1), field(body, 12, 14), minute);
        break;
      }
      case 4: {
        const sub = field(body, 23, 4), data = field(body, 0, 23);
        if (sub === 0) {
          const id = field(data, 16, 7);
          if (field(data, 0, 16) !== 0 || id > 17) return null;
          atom = controlAtom(id);
        } else if (sub === 1) {
          const g = field(data, 7, 15);
          if (field(data, 0, 7) !== 0 || g >= 32400) return null;
          atom = grid4Atom(field(data, 22, 1), indexGrid4(g));
        } else return null;
        break;
      }
      default: return null;
    }
    return {atom, eom};
  }

  function renderNumber(kind, value) {
    const s = String(value);
    if (kind === NUM.SERIAL) return value < 1000 ? s.padStart(3, "0") : s;
    if (kind === NUM.CQ_ZONE || kind === NUM.ITU_ZONE || kind === NUM.CHECK) return value < 100 ? s.padStart(2, "0") : s;
    if (kind === NUM.LICENSE_YEAR) return s.padStart(4, "0");
    return s;
  }

  const withRole = (role, text) => (role === ROLE.FULL ? "599 " + text : text);

  // render_jtty_atom. TEXT5 keeps its padding; callers decide what it means.
  function renderAtom(atom) {
    switch (atom.kind) {
      case ATOM.CALL:
        return ["CQ " + atom.text + " CQ", atom.text, "TU " + atom.text + " CQ", atom.text + " TU",
          atom.text + " AGN?", "TU NOW " + atom.text][atom.subtype] || null;
      case ATOM.EXCH_NUM:
        return validNumber(atom.subtype, atom.value) ? withRole(atom.role, renderNumber(atom.subtype, atom.value)) : null;
      case ATOM.EXCH_LOC: return withRole(atom.role, atom.text);
      case ATOM.EXCH_PAIR:
        if (atom.subtype === PAIR.ZONE_LOC3) return "599 " + String(atom.value).padStart(2, "0") + " " + atom.text;
        if (atom.subtype === PAIR.CLASS_SECTION) {
          const sec = ARRL_SECTIONS[atom.value2 - 1];
          return sec ? atom.value + atom.text + " " + sec : null;
        }
        return null;
      case ATOM.EXCH_NUM_TIME: {
        const hhmm = String(Math.floor(atom.value2 / 60)).padStart(2, "0") + String(atom.value2 % 60).padStart(2, "0");
        return withRole(atom.role, renderNumber(NUM.SERIAL, atom.value) + " " + hhmm);
      }
      case ATOM.CONTROL: return CONTROL_TEXT[atom.subtype] || null;
      case ATOM.GRID4: return withRole(atom.role, atom.text);
      case ATOM.TEXT5: return atom.text;
      default: return null;
    }
  }

  // ── text packing ───────────────────────────────────────────────────────

  // normalize_jtty_message: upper case, single spaces, '#' for the rest.
  function normalize(raw) {
    let out = "", lastSpace = true;
    for (let c of String(raw == null ? "" : raw).slice(0, MAX_TEXT)) {
      if (c === "\0" || c === "~" || c === "\t" || c === "\n" || c === "\r") c = " ";
      c = c.toUpperCase();
      if (c.length !== 1 || ALPHABET.indexOf(c) < 0) c = "#";
      if (c === " ") {
        if (lastSpace) continue;
        lastSpace = true;
      } else lastSpace = false;
      out += c;
    }
    return out.replace(/ $/, "");
  }

  function decimalValue(t) {
    if (!/^[0-9]{1,6}$/.test(t)) return -1;
    const v = Number(t);
    return v <= 131071 ? v : -1;
  }

  // RTTY Roundup: "599 05" -> "599 005". Null when it outgrows 80 characters.
  function normalizeSerials(msg) {
    const words = msg.split(" ");
    const out = [];
    for (let i = 0; i < words.length; i++) {
      out.push(words[i]);
      if (words[i] === "599" && i + 1 < words.length) {
        const v = decimalValue(words[i + 1]);
        if (v >= 0) { out.push(renderNumber(NUM.SERIAL, v)); i++; }
      }
    }
    const result = out.join(" ");
    return result.length > MAX_TEXT ? null : result;
  }

  function atomKey(a) { return 100 * a.kind + 2 * a.subtype + a.role; }

  // pack_jtty: the minimum-frame cover of the normalized text, by dynamic
  // programming over character offsets (never a greedy first match). Returns
  // {text, frames, atoms, starts} -- starts are 0-based offsets into text --
  // or null when the text needs more than 16 frames or is empty.
  function packText(message, options) {
    const profile = (options && options.profile) || PROFILE.UNKNOWN;
    const isFinal = !(options && options.isFinal === false);
    let msg = normalize(message);
    if (profile === PROFILE.RTTY) {
      msg = normalizeSerials(msg);
      if (msg === null) return null;
    }
    const n = msg.length;
    if (n === 0) return null;
    const INF = 999;
    const dp = new Array(n + 1).fill(INF);
    const next = new Array(n).fill(0);
    const choice = new Array(n).fill(null);
    dp[n] = 0;

    for (let ipos = n - 1; ipos >= 0; ipos--) {
      const consider = (atom, nxt) => {
        const cost = 1 + dp[nxt];
        if (cost > MAX_FRAMES || cost > dp[ipos]) return;
        if (cost === dp[ipos] && choice[ipos]) {
          const rank = atom.kind === ATOM.TEXT5 ? 1 : 0;
          const bestRank = choice[ipos].kind === ATOM.TEXT5 ? 1 : 0;
          if (rank > bestRank) return;
          if (rank === bestRank) {
            if (nxt < next[ipos]) return;
            if (nxt === next[ipos] && atomKey(atom) >= atomKey(choice[ipos])) return;
          }
        }
        dp[ipos] = cost;
        next[ipos] = nxt;
        choice[ipos] = atom;
      };
      // An offered atom must survive pack -> unpack -> render and spell out
      // exactly the text it would replace, separator space included.
      const offer = atom => {
        const frame = packAtom(atom, false);
        if (!frame) return;
        const back = unpackAtom(frame);
        if (!back) return;
        const r = renderAtom(back.atom);
        if (!r) return;
        const last = ipos + r.length;
        if (last > n || msg.slice(ipos, last) !== r) return;
        let nxt = n;
        if (last < n) {
          if (msg[last] !== " ") return;
          nxt = last + 1;
        }
        consider(atom, nxt);
      };

      consider(text5Atom(msg.slice(ipos, Math.min(n, ipos + 5))), Math.min(n, ipos + 5));
      if (ipos > 0 && msg[ipos - 1] !== " ") continue;

      const words = msg.slice(ipos).split(" ").slice(0, 3);
      for (const w of words) {
        if (w.length > 13) continue;
        for (let action = CALL.CQ; action <= CALL.TU_NOW; action++) offer(callAtom(action, w));
      }
      for (let id = 0; id < CONTROL_TEXT.length; id++) offer(controlAtom(id));
      for (let role = ROLE.FIELD_ONLY; role <= ROLE.FULL; role++) {
        let f = 0;
        if (role === ROLE.FULL) {
          if (words[0] !== "599" || words.length < 2) continue;
          f = 1;
        }
        const w = words[f];
        const v = decimalValue(w);
        if (v >= 0) offer(numAtom(role, NUM.GENERIC, v));
        if (v >= 0 && role === ROLE.FULL && profile === PROFILE.RTTY) offer(numAtom(role, NUM.SERIAL, v));
        if (w.length === 4) offer(grid4Atom(role, w));
        if (role !== ROLE.FULL || w.length < 2 || w.length > 3 || !/[A-Z]/.test(w)) continue;
        offer(locAtom(role, LOC.QTH, w));
        if (profile === PROFILE.RTTY) offer(locAtom(role, LOC.STATE_PROVINCE, w));
      }
      const w0 = words[0];
      if (words.length >= 2 && w0.length >= 2 && w0.length <= 3) {
        const count = decimalValue(w0.slice(0, -1));
        if (count >= 0) offer(classSectionAtom(count, w0.slice(-1), sectionIndex(words[1])));
      }
    }

    if (dp[0] > MAX_FRAMES) return null;
    const atoms = [], starts = [];
    for (let ipos = 0; ipos < n; ipos = next[ipos]) {
      atoms.push(choice[ipos]);
      starts.push(ipos);
    }
    const frames = packAtoms(atoms, isFinal);
    return frames ? {text: msg, frames, atoms, starts} : null;
  }

  // pack_jtty_atoms: EOM only on the last atom, and only when final.
  function packAtoms(atoms, isFinal) {
    if (!atoms.length || atoms.length > MAX_FRAMES) return null;
    const frames = [];
    for (let i = 0; i < atoms.length; i++) {
      const f = packAtom(atoms[i], i === atoms.length - 1 && isFinal !== false);
      if (!f) return null;
      frames.push(f);
    }
    return frames;
  }

  // One decoded frame, the way unpack_jtty appends it: TEXT5 characters
  // verbatim with spaces as '~', a structured atom plus one implicit
  // separator. null for a frame the grammar refuses.
  function renderFrame(bits) {
    const u = unpackAtom(bits);
    if (!u) return null;
    const r = renderAtom(u.atom);
    if (r === null) return null;
    if (u.atom.kind === ATOM.TEXT5) return {text: r.replace(/ /g, "~"), trailingSep: false, eom: u.eom, atom: u.atom};
    return {text: r, trailingSep: true, eom: u.eom, atom: u.atom};
  }

  // unpack_jtty for a whole message, display-ready.
  function unpackFrames(frames) {
    let msg = "", sep = false, eom = false;
    for (const bits of frames) {
      const f = renderFrame(bits);
      if (!f) return null;
      msg += (sep ? " " : "") + f.text;
      sep = f.trailingSep;
      eom = f.eom;
    }
    return {text: displayText(msg), eom};
  }

  // display_message_layout: '~~~~~' marks missed frames, other '~' are spaces.
  function displayText(decoded) {
    return String(decoded).slice(0, MAX_TEXT).replace(/~~~~~/g, " ... ").replace(/~/g, " ")
      .replace(/^ /, "").replace(/ +$/, "");
  }

  // jtty_filler.f90 / Jtty::stripJttyFillerText: every run of '<<<<<'
  // blocks, with the blanks around them, becomes one space; then trim and
  // collapse inner whitespace.
  const FILLER_TEXT = "<<<<<";
  function stripFiller(text) {
    return String(text).replace(/\s*(?:<<<<<\s*)+/g, " ").replace(/\s+/g, " ").trim();
  }

  // ── native function keys ───────────────────────────────────────────────

  // The eight shipped WSJT-X templates (jtty_source_encoding.txt "NativeMacro")
  // compile straight to typed atoms before placeholder expansion; anything
  // else is expanded and packed as text.
  const NATIVE_TEMPLATES = Object.freeze({
    "CQ %M CQ": c => [callAtom(CALL.CQ, c.myCall)],
    "%H %E": c => [callAtom(CALL.CALL, c.hisCall)].concat(exchangeAtoms(c)),
    "%H TU CQ %M CQ": c => [callAtom(CALL.CALL_TU, c.hisCall), callAtom(CALL.CQ, c.myCall)],
    "%M": c => [callAtom(CALL.CALL, c.myCall)],
    "%H": c => [callAtom(CALL.CALL, c.hisCall)],
    "TU NOW %Q %E": c => [callAtom(CALL.TU_NOW, c.queueCall)].concat(exchangeAtoms(c)),
    "%H AGN?": c => [callAtom(CALL.CALL_AGN, c.hisCall)],
    "%E": c => exchangeAtoms(c),
  });
  const DEFAULT_FKEYS = Object.freeze(["CQ %M CQ", "%H %E", "%H TU CQ %M CQ", "%M", "%H",
    "TU NOW %Q %E", "%H AGN?", "%E"]);

  // %E under the exchange profile: a decimal serial by default, exactly
  // "<count><class> <section>" for Field Day, a serial or a 2-3 character
  // state/province for RTTY Roundup. Throws on an invalid exchange -- a
  // native template must never change meaning by falling back to text.
  function exchangeAtoms(ctx) {
    const exch = normalize(ctx.exchange || "").replace(/^599 /, "");
    if (ctx.profile === PROFILE.FIELD_DAY) {
      const m = /^([0-9]{1,2})([A-F]) ([A-Z]{2,3})$/.exec(exch);
      const sec = m ? sectionIndex(m[3]) : 0;
      if (!m || !sec || Number(m[1]) < 1 || Number(m[1]) > 32) throw new Error("Field Day exchange must be <count><class> <section>");
      return [classSectionAtom(Number(m[1]), m[2], sec)];
    }
    const v = decimalValue(exch);
    if (v >= 0) return [numAtom(ROLE.FULL, NUM.SERIAL, v)];
    if (ctx.profile === PROFILE.RTTY && packBase36(exch) >= 0 && /[A-Z]/.test(exch))
      return [locAtom(ROLE.FULL, LOC.STATE_PROVINCE, exch)];
    throw new Error("exchange '" + exch + "' is not a serial number");
  }

  function expandPlaceholders(template, ctx) {
    return String(template).replace(/%[MHQEG]/g, p => ({
      "%M": ctx.myCall || "", "%H": ctx.hisCall || "", "%Q": ctx.queueCall || ctx.hisCall || "",
      "%E": ctx.exchange ? (/^599 /.test(ctx.exchange) ? ctx.exchange : "599 " + ctx.exchange) : "",
      "%G": ctx.grid ? ctx.grid.slice(0, 4) : "",
    }[p]));
  }

  // -> {text, frames, atoms, native}. ctx: {myCall, hisCall, queueCall,
  // exchange, grid, profile}. Throws when a native template has bad data.
  function compileMacro(template, ctx) {
    const key = normalize(template);
    const native = NATIVE_TEMPLATES[key];
    if (native) {
      const c = Object.assign({}, ctx, {
        myCall: normalize(ctx.myCall), hisCall: normalize(ctx.hisCall),
        queueCall: normalize(ctx.queueCall || ctx.hisCall),
      });
      const atoms = native(c);
      for (const a of atoms) {
        if (a.kind === ATOM.CALL && !standardCall(a.text)) throw new Error("'" + (a.text || "(empty)") + "' is not a standard callsign");
      }
      const frames = packAtoms(atoms, true);
      if (!frames) throw new Error("native template did not encode");
      const text = atoms.map(renderAtom).join(" ");
      return {text, frames, atoms, native: true};
    }
    const packed = packText(expandPlaceholders(template, ctx), {profile: ctx.profile});
    if (!packed) throw new Error("message does not fit in 16 frames");
    return Object.assign(packed, {native: false});
  }

  const profileFromName = name => ({"field-day": PROFILE.FIELD_DAY, "rtty-roundup": PROFILE.RTTY}[name] || PROFILE.UNKNOWN);

  return {
    ALPHABET, MAX_FRAMES, MAX_TEXT, FRAME_BITS, ATOM, CALL, ROLE, NUM, LOC, PAIR, PROFILE,
    CONTROL_TEXT, ARRL_SECTIONS, DEFAULT_FKEYS, FILLER_TEXT,
    chkcall, pack28, unpack28, standardCall,
    callAtom, numAtom, locAtom, zoneLocAtom, classSectionAtom, numTimeAtom, controlAtom, grid4Atom, text5Atom,
    packAtom, unpackAtom, renderAtom, renderFrame, normalize, normalizeSerials,
    packText, packAtoms, unpackFrames, displayText, stripFiller,
    compileMacro, expandPlaceholders, profileFromName,
  };
}));
