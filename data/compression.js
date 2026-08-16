// Extended compression profile for the JS8 data layer.
//
// A codec that packs a directed message body into the most compact JS8-legal
// text and back. Three stages, each reversible:
//
//   1. pack   — the message text is entropy-packed with the JS8 symbol model
//               (the same code table js8-protocol.js:43 uses on the wire).
//   2. whiten  — the packed bytes are run through a keystream drawn from the
//               profile material, so the body is order-independent and its
//               statistics are flat. A 6-byte seed derived from the content
//               anchors the keystream and doubles as the integrity tag.
//   3. render  — the whitened bytes are re-expressed with a complete prefix
//               code over the digit-free half of the symbol table, so the body
//               is always JS8-readable text and never trips the callsign
//               scanner (js8-protocol.js:566 needs a digit in slot 3).
//
// Wire body:  SENTINEL(version) + rendered-symbols + "."
//   leading sentinel  '.'=v1 '-'=v2 '+'=v3   (also stops leading-space trim)
//   trailing '.'                              (stops trailing-space trim)
//
// The first packed byte is a length marker, so a truncated body reports as a
// missing tail rather than as a mismatched profile. Context (version, both
// callsigns, the UTC hour, the length) is never rendered — both ends already
// hold it — but it is folded into the seed, binding the body to that pairing
// and hour.
//
// Conformance vectors for the primitives live in
// tools/compression-conformance.js (RFC 8439 / RFC 4231 / PBKDF2). The core is
// pure JS: the page is served over http, so no platform digest is available.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Compression = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  // ---- byte helpers ---------------------------------------------------------
  function bytesOf(value) {
    return value instanceof Uint8Array ? value : new Uint8Array(value || 0);
  }
  function hex(input) {
    return [...bytesOf(input)].map(v => v.toString(16).padStart(2, "0")).join("");
  }
  function fromHex(text) {
    const clean = String(text).replace(/\s+/g, "");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }
  function asciiBytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }
  function concat(...parts) {
    const total = parts.reduce((n, p) => n + bytesOf(p).length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { const b = bytesOf(p); out.set(b, at); at += b.length; }
    return out;
  }
  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  function randomBytes(n) {
    const out = new Uint8Array(n);
    const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (cryptoObj && cryptoObj.getRandomValues) cryptoObj.getRandomValues(out);
    else for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  // ---- digest (SHA-256) -----------------------------------------------------
  // Ported verbatim from js8-file-transfer.js:59 (sha256Fallback), which matches
  // the RFC 4231 HMAC vectors byte for byte.
  function digest(input) {
    const source = bytesOf(input), bitLength = source.length * 8,
      paddedLength = Math.ceil((source.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(source);
    bytes[source.length] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const constants = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
      words = new Uint32Array(64), rotate = (value, count) => (value >>> count) | (value << (32 - count));
    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
      for (let index = 16; index < 64; index += 1) {
        const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3),
          s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25), choice = (e & f) ^ (~e & g),
          temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0,
          sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22), majority = (a & b) ^ (a & c) ^ (b & c),
          temp2 = (sum0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0; hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0; hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }
    const output = new Uint8Array(32), outputView = new DataView(output.buffer);
    hash.forEach((value, index) => outputView.setUint32(index * 4, value, false));
    return output;
  }

  // ---- mac (HMAC-SHA256) ----------------------------------------------------
  const BLOCK = 64;
  function mac(key, message) {
    let k = bytesOf(key);
    if (k.length > BLOCK) k = digest(k);
    const inner = new Uint8Array(BLOCK), outer = new Uint8Array(BLOCK);
    for (let i = 0; i < BLOCK; i += 1) {
      const b = i < k.length ? k[i] : 0;
      inner[i] = b ^ 0x36; outer[i] = b ^ 0x5c;
    }
    return digest(concat(outer, digest(concat(inner, bytesOf(message)))));
  }

  // ---- stretch (PBKDF2-HMAC-SHA256) -----------------------------------------
  // Synchronous core, plus a chunked driver that yields to the event loop so the
  // audio channel and encoder tick keep running while the profile store opens.
  function pbkdf2Block(pass, salt, iters, block, accumulator) {
    const seed = concat(salt, new Uint8Array([(block >>> 24) & 255, (block >>> 16) & 255, (block >>> 8) & 255, block & 255]));
    let u = mac(pass, seed);
    const t = u.slice();
    for (let i = 1; i < iters; i += 1) {
      u = mac(pass, u);
      for (let j = 0; j < 32; j += 1) t[j] ^= u[j];
      if (accumulator) accumulator.done += 1;
    }
    return t;
  }
  function stretchSync(pass, salt, iters, dkLen) {
    const passBytes = typeof pass === "string" ? asciiBytes(pass) : bytesOf(pass);
    const saltBytes = typeof salt === "string" ? asciiBytes(salt) : bytesOf(salt);
    const out = new Uint8Array(dkLen);
    let off = 0, block = 1;
    while (off < dkLen) {
      const t = pbkdf2Block(passBytes, saltBytes, iters, block);
      const n = Math.min(32, dkLen - off);
      out.set(t.subarray(0, n), off);
      off += n; block += 1;
    }
    return out;
  }
  // Chunked: iterate in slices of CHUNK, reporting fractional progress. Runs the
  // full iteration count; the yield is what keeps the page responsive.
  const CHUNK = 2000;
  function stretch(pass, salt, iters, dkLen, onProgress) {
    const passBytes = typeof pass === "string" ? asciiBytes(pass) : bytesOf(pass);
    const saltBytes = typeof salt === "string" ? asciiBytes(salt) : bytesOf(salt);
    const blocks = Math.ceil(dkLen / 32);
    const totalWork = blocks * iters;
    const out = new Uint8Array(blocks * 32);
    let block = 1;
    return new Promise((resolve, reject) => {
      function nextBlock() {
        // per-block running state
        const seed = concat(saltBytes, new Uint8Array([(block >>> 24) & 255, (block >>> 16) & 255, (block >>> 8) & 255, block & 255]));
        let u = mac(passBytes, seed);
        const t = u.slice();
        let i = 1;
        function slice() {
          try {
            const end = Math.min(iters, i + CHUNK);
            for (; i < end; i += 1) {
              u = mac(passBytes, u);
              for (let j = 0; j < 32; j += 1) t[j] ^= u[j];
            }
            if (onProgress) {
              const done = (block - 1) * iters + i;
              onProgress(Math.min(1, done / totalWork));
            }
            if (i < iters) { setTimeout(slice, 0); return; }
            out.set(t, (block - 1) * 32);
            block += 1;
            if (block <= blocks) { setTimeout(nextBlock, 0); return; }
            resolve(out.subarray(0, dkLen));
          } catch (error) { reject(error); }
        }
        slice();
      }
      nextBlock();
    });
  }

  // ---- keystream (ChaCha20, RFC 8439) ---------------------------------------
  const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]; // "expand 32-byte k"
  function rotl(v, c) { return ((v << c) | (v >>> (32 - c))) >>> 0; }
  function keystreamBlock(state, out) {
    const x = state.slice();
    for (let i = 0; i < 10; i += 1) {
      qr(x, 0, 4, 8, 12); qr(x, 1, 5, 9, 13); qr(x, 2, 6, 10, 14); qr(x, 3, 7, 11, 15);
      qr(x, 0, 5, 10, 15); qr(x, 1, 6, 11, 12); qr(x, 2, 7, 8, 13); qr(x, 3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i += 1) {
      const v = (x[i] + state[i]) >>> 0;
      out[i * 4] = v & 255; out[i * 4 + 1] = (v >>> 8) & 255;
      out[i * 4 + 2] = (v >>> 16) & 255; out[i * 4 + 3] = (v >>> 24) & 255;
    }
  }
  function qr(x, a, b, c, d) {
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
  }
  function le32(bytes, off) {
    return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
  }
  function keystream(key, nonce, counter, length) {
    const k = bytesOf(key), n = bytesOf(nonce);
    const state = new Uint32Array(16);
    state[0] = SIGMA[0]; state[1] = SIGMA[1]; state[2] = SIGMA[2]; state[3] = SIGMA[3];
    for (let i = 0; i < 8; i += 1) state[4 + i] = le32(k, i * 4);
    state[12] = counter >>> 0;
    state[13] = le32(n, 0); state[14] = le32(n, 4); state[15] = le32(n, 8);
    const out = new Uint8Array(length), block = new Uint8Array(64);
    for (let off = 0; off < length; off += 64) {
      keystreamBlock(state, block);
      out.set(block.subarray(0, Math.min(64, length - off)), off);
      state[12] = (state[12] + 1) >>> 0;
    }
    return out;
  }
  // Full ChaCha20 stream cipher (message XOR keystream), used by the conformance
  // vectors and by the profile store.
  function stream(key, nonce, counter, message) {
    const m = bytesOf(message), ks = keystream(key, nonce, counter, m.length), out = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i += 1) out[i] = m[i] ^ ks[i];
    return out;
  }
  // Body whitening: nonce = seed(6) || 0*6, counter 0.
  function whiten(bytes, streamKey, seed6) {
    const nonce = concat(seed6, new Uint8Array(6));
    return stream(streamKey, nonce, 0, bytes);
  }

  // ==========================================================================
  // Symbol model (a private copy of the js8-protocol.js:43 table, so the codec
  // never depends on that module loading first and the wake fingerprint can
  // notice if the two ever drift apart).
  // ==========================================================================
  const MODEL = {
    "01": " ", "100": "E", "1101": "T", "0011": "A", "11111": "O",
    "11100": "I", "10111": "N", "10100": "S", "00011": "H", "00000": "R",
    "111011": "D", "110011": "L", "110001": "C", "101101": "U",
    "101011": "M", "001011": "W", "001001": "F", "000101": "G",
    "000011": "Y", "1111011": "P", "1111001": "B", "1110100": ".",
    "1100101": "V", "1100100": "K", "1100001": "-", "1100000": "+",
    "1011001": "?", "1011000": "!", "1010101": "\"", "1010100": "X",
    "0010101": "0", "0010100": "J", "0010001": "1", "0010000": "Q",
    "0001001": "2", "0001000": "Z", "0000101": "3", "0000100": "5",
    "11110101": "4", "11110100": "9", "11110001": "8", "11110000": "6",
    "11101011": "7", "11101010": "/"
  };
  const MODEL_ENCODE = Object.fromEntries(Object.entries(MODEL).map(([code, ch]) => [ch, code]));
  const ESCAPE_CHAR = "\"";
  // Extended set reachable through the escape symbol (6-bit index). Slot 0 is a
  // literal ESCAPE_CHAR so the escape character itself round-trips.
  const EXTENDED = ["\"", ",", ":", "@", "_", "(", ")", "'", ";", "=", "&",
    "%", "#", "*", "<", ">", "[", "]", "{", "}", "|", "$", "~", "`", "\\"];
  const EXTENDED_INDEX = Object.fromEntries(EXTENDED.map((ch, i) => [ch, i]));

  function bitsPush(bits, code) { for (const c of code) bits.push(c === "1" ? 1 : 0); }
  function bitsFromByte(value, width, bits) { for (let s = width - 1; s >= 0; s -= 1) bits.push((value >> s) & 1); }

  // ---- text normalisation --------------------------------------------------
  // Upper-case, strip diacritics, keep only what the model or the escape set can
  // carry; anything else becomes '?'. Returns the exact text that will be packed,
  // so the composer can show the operator what actually goes out.
  function normalize(text) {
    let s = String(text == null ? "" : text).toUpperCase();
    if (s.normalize) s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    let out = "";
    for (const ch of s) {
      if (Object.hasOwn(MODEL_ENCODE, ch) || Object.hasOwn(EXTENDED_INDEX, ch)) out += ch;
      else out += "?";
    }
    return out;
  }

  // ---- pack: text -> padded bytes ------------------------------------------
  function packBits(text) {
    const bits = [];
    for (const ch of text) {
      if (Object.hasOwn(MODEL_ENCODE, ch) && ch !== ESCAPE_CHAR) {
        bitsPush(bits, MODEL_ENCODE[ch]);
      } else if (Object.hasOwn(EXTENDED_INDEX, ch)) {
        bitsPush(bits, MODEL_ENCODE[ESCAPE_CHAR]);
        bitsFromByte(EXTENDED_INDEX[ch], 6, bits);
      } else {
        bitsPush(bits, MODEL_ENCODE["?"]);
      }
    }
    return bits;
  }
  function pack(text) {
    const bits = packBits(normalize(text));
    // Pad: one 0 then 1s to the next byte boundary (packHuffmanData convention,
    // reversed by dropping trailing 1s and one 0).
    bits.push(0);
    while (bits.length % 8 !== 0) bits.push(1);
    const out = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i += 1) if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
    return out;
  }
  function unpack(bytes) {
    const bits = [];
    for (const byte of bytesOf(bytes)) for (let s = 7; s >= 0; s -= 1) bits.push((byte >> s) & 1);
    while (bits.length && bits[bits.length - 1] === 1) bits.pop();
    if (bits.length && bits[bits.length - 1] === 0) bits.pop();
    let out = "", code = "";
    for (let i = 0; i < bits.length;) {
      code += bits[i]; i += 1;
      if (Object.hasOwn(MODEL, code)) {
        const ch = MODEL[code];
        code = "";
        if (ch === ESCAPE_CHAR) {
          if (i + 6 > bits.length) break;
          let index = 0;
          for (let b = 0; b < 6; b += 1) index = (index << 1) | bits[i + b];
          i += 6;
          out += index < EXTENDED.length ? EXTENDED[index] : "?";
        } else out += ch;
      }
    }
    return out;
  }

  // ==========================================================================
  // Air renderer: a complete prefix code over the 34 digit-free symbols, built
  // from the model weights (2^(8-len)). Because it is complete (Kraft = 1) every
  // byte string renders to symbols and back; the packed length marker says where
  // the body ends, so a lost tail frame is caught instead of silently truncating.
  // ==========================================================================
  function buildAirCode() {
    const symbols = [];
    for (const [code, ch] of Object.entries(MODEL)) {
      if (ch >= "0" && ch <= "9") continue;
      symbols.push({ ch, weight: 1 << (8 - code.length) });
    }
    // Deterministic Huffman: combine the two lightest nodes; ties broken by a
    // stable order (weight, then birth index) so both ends build the same code.
    let birth = 0;
    let nodes = symbols.map(s => ({ weight: s.weight, order: birth++, ch: s.ch, left: null, right: null }));
    const pool = nodes.slice();
    function pick() {
      let best = 0;
      for (let i = 1; i < pool.length; i += 1) {
        if (pool[i].weight < pool[best].weight ||
          (pool[i].weight === pool[best].weight && pool[i].order < pool[best].order)) best = i;
      }
      return pool.splice(best, 1)[0];
    }
    while (pool.length > 1) {
      const a = pick(), b = pick();
      pool.push({ weight: a.weight + b.weight, order: birth++, ch: null, left: a, right: b });
    }
    // Depth = code length per symbol.
    const lengths = {};
    (function walk(node, depth) {
      if (node.ch !== null) { lengths[node.ch] = depth || 1; return; }
      walk(node.left, depth + 1); walk(node.right, depth + 1);
    })(pool[0], 0);
    // Canonical codes: sort by (length, symbol) and assign sequential codes.
    const ordered = Object.keys(lengths).sort((a, b) =>
      lengths[a] - lengths[b] || (a < b ? -1 : a > b ? 1 : 0));
    const encode = {}, decode = {};
    let codeValue = 0, prevLen = 0;
    for (const ch of ordered) {
      const len = lengths[ch];
      codeValue <<= (len - prevLen);
      const bits = codeValue.toString(2).padStart(len, "0");
      encode[ch] = bits; decode[bits] = ch;
      codeValue += 1; prevLen = len;
    }
    let maxLen = 0;
    for (const ch in lengths) maxLen = Math.max(maxLen, lengths[ch]);
    return { encode, decode, maxLen };
  }
  const AIR = buildAirCode();

  function renderBytes(bytes) {
    const b = bytesOf(bytes);
    let out = "", code = "";
    for (let i = 0; i < b.length * 8;) {
      code += (b[i >> 3] >> (7 - (i & 7))) & 1; i += 1;
      if (Object.hasOwn(AIR.decode, code)) { out += AIR.decode[code]; code = ""; }
    }
    // Complete a dangling prefix into the shortest matching codeword so the
    // rendered string is a whole number of symbols; the spare bits fall off the
    // far end on the way back (we keep only the marked length).
    if (code) {
      for (const [bits, ch] of Object.entries(AIR.decode)) {
        if (bits.length > code.length && bits.startsWith(code)) { out += ch; break; }
      }
    }
    return out;
  }
  // symbols -> bit array (may run a few bits past the real length).
  function symbolsToBits(str) {
    const bits = [];
    for (const ch of str) {
      const code = AIR.encode[ch];
      if (!code) throw new Error("symbol outside air code");
      for (const c of code) bits.push(c === "1" ? 1 : 0);
    }
    return bits;
  }
  // Read the length marker and lift out exactly that many bytes. Returns null
  // when the symbols carry fewer bits than the marker promises (a lost tail).
  function unrenderBytes(str) {
    const bits = symbolsToBits(str);
    if (bits.length < 8) return null;
    let len = 0;
    for (let i = 0; i < 8; i += 1) len = (len << 1) | bits[i];
    const need = 1 + SEED_LEN + len;      // marker + seed + body
    if (bits.length < need * 8) return { short: true, need, have: bits.length >> 3 };
    const out = new Uint8Array(need);
    for (let i = 0; i < need * 8; i += 1) if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
    return { bytes: out };
  }

  // ==========================================================================
  // Profile format (v1). blob = LEN(1) | SEED(6) | body(LEN). The context is
  // folded into the seed but never rendered.
  // ==========================================================================
  const VERSION = 1;
  const SENTINEL = { 1: ".", 2: "-", 3: "+" };
  const SENTINEL_VERSION = { ".": 1, "-": 2, "+": 3 };
  const SEED_LEN = 6;
  const END = ".";

  function subkeys(material) {
    return { stream: mac(material, asciiBytes("E")), tag: mac(material, asciiBytes("M")) };
  }
  // Context (never on the wire): version | FROM ">" TO "|" HOUR | LEN.
  function context(version, from, to, hour, len) {
    const head = `${version}${String(from).toUpperCase()}>${String(to).toUpperCase()}|${hour}|`;
    return concat(asciiBytes(head), new Uint8Array([len & 0xff]));
  }

  // Build the wire body from text. `meta` = {from, to, hour, version?}.
  function seal(text, material, meta) {
    const version = meta.version || VERSION;
    const keys = subkeys(material);
    const packed = pack(text);
    if (packed.length > 255) throw new Error("message too long for one profile block");
    const len = packed.length;
    const ad = context(version, meta.from, meta.to, meta.hour, len);
    const seed = mac(keys.tag, concat(ad, packed)).subarray(0, SEED_LEN);
    const body = whiten(packed, keys.stream, seed);
    const blob = concat(new Uint8Array([len]), seed, body);
    return SENTINEL[version] + renderBytes(blob) + END;
  }

  // Try to open a wire body with one material and one hour. Returns:
  //   {text, seed}          on success
  //   {status:"missing-tail"} when the marker outlasts the symbols
  //   null                   on any mismatch (wrong profile, wrong hour, junk)
  function openWith(body, material, meta) {
    const version = SENTINEL_VERSION[body[0]];
    if (!version || body[body.length - 1] !== END) return null;
    const middle = body.slice(1, -1);
    if (!middle) return null;
    let lifted;
    try { lifted = unrenderBytes(middle); } catch (_e) { return null; }
    if (!lifted) return null;
    if (lifted.short) return { status: "missing-tail", need: lifted.need, have: lifted.have };
    const blob = lifted.bytes;
    const len = blob[0];
    const seed = blob.subarray(1, 1 + SEED_LEN);
    const bodyBytes = blob.subarray(1 + SEED_LEN, 1 + SEED_LEN + len);
    const keys = subkeys(material);
    const packed = whiten(bodyBytes, keys.stream, seed);
    const ad = context(version, meta.from, meta.to, meta.hour, len);
    const check = mac(keys.tag, concat(ad, packed)).subarray(0, SEED_LEN);
    if (!equalBytes(check, seed)) return null;
    return { text: unpack(packed), seed, version };
  }

  // Trial-open a body across a set of profiles and an hour window. Returns the
  // first profile whose material verifies, the recovered text, and the seed (for
  // replay tracking); a truncated body reports missing-tail against the profile
  // that recognised its length marker; no match returns null.
  function openAcross(body, profiles, meta) {
    if (!looksLikeProfile(body)) return null;
    for (const profile of profiles || []) {
      const material = unbase32(profile.material).subarray(0, 16);
      for (const hour of meta.hours) {
        let opened = null;
        try { opened = openWith(body, material, { from: meta.from, to: meta.to, hour }); }
        catch (_e) { opened = null; }
        if (!opened) continue;
        if (opened.status) return { profile, status: opened.status };
        return { profile, text: opened.text, seed: opened.seed };
      }
    }
    return null;
  }

  // The smallest possible blob is LEN(1)+SEED(6)+body(>=1) = 8 bytes = 64 bits,
  // which cannot render to fewer than ceil(64/maxCodeLen) symbols. Anything
  // shorter is definitely not a block, so the gate rejects it before a trial open
  // without ever refusing a real (decryptable) body.
  const MIN_BODY_SYMBOLS = Math.ceil(64 / AIR.maxLen);
  // Does a body even look like a profile block? Cheap gate before trial opens.
  function looksLikeProfile(body) {
    if (typeof body !== "string" || body.length < MIN_BODY_SYMBOLS + 2) return false;
    if (!Object.hasOwn(SENTINEL_VERSION, body[0]) || body[body.length - 1] !== END) return false;
    const middle = body.slice(1, -1);
    if (middle.length < MIN_BODY_SYMBOLS) return false;
    for (const ch of middle) {
      if (ch >= "0" && ch <= "9") return false;
      if (!Object.hasOwn(AIR.encode, ch)) return false;
    }
    return true;
  }

  // ==========================================================================
  // Profile store (browser only). Held in memory once opened; the encrypted
  // image lives in localStorage on the device origin and never on the device.
  // ==========================================================================
  const STORE_KEY = "compression.profiles";
  const STORE_ITERS = 200000;
  const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32(bytes) {
    const b = bytesOf(bytes);
    let out = "", buffer = 0, bits = 0;
    for (const byte of b) {
      buffer = (buffer << 8) | byte; bits += 8;
      while (bits >= 5) { bits -= 5; out += BASE32[(buffer >>> bits) & 31]; }
    }
    if (bits) out += BASE32[(buffer << (5 - bits)) & 31];
    return out;
  }
  function unbase32(text) {
    const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, "");
    const out = [];
    let buffer = 0, bits = 0;
    for (const ch of clean) {
      buffer = (buffer << 5) | BASE32.indexOf(ch); bits += 5;
      if (bits >= 8) { bits -= 8; out.push((buffer >>> bits) & 255); }
    }
    return Uint8Array.from(out);
  }

  function vaultSubkeys(master) {
    return { stream: mac(master, asciiBytes("VE")), tag: mac(master, asciiBytes("VM")) };
  }
  // Seal the profile list under a derived master key. Full-length tag, random
  // nonce, no shortening -- bytes are free here.
  function sealVault(profiles, master, salt, iters) {
    const json = asciiBytes(JSON.stringify(profiles));
    const keys = vaultSubkeys(master);
    const nonce = randomBytes(12);
    const ct = stream(keys.stream, nonce, 0, json);
    const tag = mac(keys.tag, concat(nonce, ct)).subarray(0, 16);
    return { v: 1, kdf: { salt: hex(salt), iters }, nonce: hex(nonce), tag: hex(tag), ct: hex(ct) };
  }
  function openVault(vault, master) {
    const keys = vaultSubkeys(master);
    const nonce = fromHex(vault.nonce), ct = fromHex(vault.ct);
    const tag = mac(keys.tag, concat(nonce, ct)).subarray(0, 16);
    if (!equalBytes(tag, fromHex(vault.tag))) return null;
    const json = stream(keys.stream, nonce, 0, ct);
    try { return JSON.parse(new TextDecoder().decode(json)); } catch (_e) { return null; }
  }

  // Salt for a passphrase-derived key. It MUST be a value both stations share, so
  // it is the (normalised) label -- never the target callsign, which is each
  // other's call and would give the two ends different keys. Normalising case and
  // whitespace keeps "OurNet" and "ournet" the same key.
  function passphraseSalt(label) {
    return asciiBytes("cmp|" + String(label == null ? "" : label).trim().toUpperCase().replace(/\s+/g, " "));
  }

  // ---- day code (activation phrase) -----------------------------------------
  // n = weekday, Mon=0..Sun=6 (local). code = [n, n+2, n+4, n+6] each mod 10.
  function dayCode(date) {
    const d = date || new Date();
    const n = (d.getDay() + 6) % 7;
    return [n, n + 2, n + 4, n + 6].map(x => x % 10).join("");
  }

  // ---- band offsets (kap. 16) -----------------------------------------------
  // Fixed, shared: both ends must apply the same shift. A rendezvous, not a
  // secret. Keyed by the band label bandOf() returns.
  const BAND_OFFSETS = {
    "160m": 3500, "80m": 5000, "40m": 4000, "30m": -6000, "20m": 4000,
    "17m": 4000, "15m": 4000, "12m": 7000, "10m": 4000,
  };

  // ---- behavioural fingerprint ----------------------------------------------
  // Prove the JS8 text layer still packs the way this codec expects before
  // enabling anything: any drift in the model, chooseDataForm or the trim rules
  // changes these frames, and a changed hash refuses activation.
  const FINGERPRINT_VECTORS = [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ ./-+?!\"",
    ".EXTENDED PROFILE CHECK VECTOR ONE.",
    "THE QUICK BROWN FOX AND SO ON FOR A WHILE LONGER TO SPAN FRAMES",
  ];
  function fingerprint(protocol) {
    let acc = "";
    for (const v of FINGERPRINT_VECTORS) {
      const frames = protocol.buildReplyFrames({ myCall: "OK1AAA", toCall: "OK1BBB", text: v, mode: 0 });
      acc += frames.map(f => f.raw).join("|") + "\n";
    }
    return hex(digest(asciiBytes(acc)));
  }
  // Pinned against the bundled protocol; tools/compression-conformance.js fails
  // if the layer drifts and this is not re-pinned deliberately.
  const FINGERPRINT_EXPECTED = "9c3b71268045b76bb46f7416e914d5c2db16f9e7fc70ce71e171e8493105ce08";

  // ==========================================================================
  // Runtime: dormant until the day code lands in the recipient field. Nothing
  // else touches the page, writes storage or adds DOM while dormant.
  // ==========================================================================
  const runtime = {
    phase: "dormant",     // dormant | accepted | open
    profiles: null,       // in-memory, cleared on reload
    salt: null, master: null, iters: STORE_ITERS,
    active: false,        // encryption toggle (composer coloured, offsets applied)
    seen: new Map(),      // seed hex -> ts, verified messages only, 2 h
    hooked: false, original: {},
    missingDeps: [],      // host bindings this module could not resolve (see HOST_BINDINGS)
  };
  const SEEN_TTL_MS = 2 * 3600 * 1000;

  // The DATA-page bindings this module wraps or reads by name are ALSO a build
  // contract: data.js is minified with `--mangle toplevel`, so every identifier
  // probed below must be in the reserved list of tools/minify-spiffs-js.sh or it
  // gets renamed out from under us -- and then the hooks bind to nothing, but only
  // in the minified (production/CI) build, never when reading the source.
  // probeHost() turns that silent drift into a visible failure: it runs on every
  // page load and data-browser-smoke.js (which serves the minified .gz) asserts
  // the list came back empty. Add a hook, add its name here AND in the reserved
  // list; the three move together or the smoke goes red.
  //
  // Explicit `typeof` per name -- not eval over a string list -- so the probe
  // works even under a future Content-Security-Policy without 'unsafe-eval'. Each
  // identifier resolves lexically to data.js's global binding (the `const state`
  // included); a name mangled away reads as "undefined" without throwing.
  function probeHost() {
    const miss = [];
    if (typeof state === "undefined") miss.push("state");
    if (typeof currentJs8 === "undefined") miss.push("currentJs8");
    if (typeof startTxTo === "undefined") miss.push("startTxTo");
    if (typeof applyDecoderActivity === "undefined") miss.push("applyDecoderActivity");
    if (typeof dispatchAssembledMessage === "undefined") miss.push("dispatchAssembledMessage");
    if (typeof buildSessionSnapshot === "undefined") miss.push("buildSessionSnapshot");
    if (typeof chooseCall === "undefined") miss.push("chooseCall");
    if (typeof clearRecipient === "undefined") miss.push("clearRecipient");
    if (typeof presetHz === "undefined") miss.push("presetHz");
    if (typeof bandOf === "undefined") miss.push("bandOf");
    if (typeof radioTransmitting === "undefined") miss.push("radioTransmitting");
    if (typeof requestFrequency === "undefined") miss.push("requestFrequency");
    if (typeof renderHeader === "undefined") miss.push("renderHeader");
    if (typeof renderFrequencyMenu === "undefined") miss.push("renderFrequencyMenu");
    if (typeof selectedMode === "undefined") miss.push("selectedMode");
    if (typeof isMyGroup === "undefined") miss.push("isMyGroup");
    if (typeof mailPathRefusal === "undefined") miss.push("mailPathRefusal");
    return miss;
  }

  function profileFor(call) {
    if (!runtime.profiles || !call) return null;
    const target = String(call).toUpperCase();
    for (const p of runtime.profiles) {
      if (p.type === "group" && String(p.group).toUpperCase() === target) return p;
      if (p.type !== "group" && String(p.peer).toUpperCase() === target) return p;
    }
    return null;
  }
  function materialOf(profile) { return unbase32(profile.material).subarray(0, 16); }

  function pruneSeen(now) {
    for (const [k, t] of runtime.seen) if (now - t > SEEN_TTL_MS) runtime.seen.delete(k);
  }

  // Leading directed-command tokens. A profile body is free text; a command the
  // operator typed expecting it to act would arrive as inert text (the receiver
  // never routes a profile body), so it is refused with a note instead.
  const COMMAND_HEAD = /^\s*(>|SNR\??|MSG( TO:)?|QUERY( MSGS\??| CALL)?|ACK|NACK|HEARING\??|GRID\??|STATUS\??|INFO\??|AGN\?|HW CPY\?|CMD|73|YES|NO|RR|QSL\??|FB|SK|DIT DIT)(\s|$)/i;
  function looksLikeCommand(text) { return COMMAND_HEAD.test(String(text || "").trim()); }
  function looksLikeCq(text) { return /^\s*CQ(\s|$)/i.test(String(text || "").toUpperCase()); }
  const MARK = "≋";      // ≋ — the profile marker shown in the feed

  // ==========================================================================
  // Browser bootstrap. Everything below runs only on the DATA page; the module
  // stays a pure codec everywhere else (Node tests, other pages).
  // ==========================================================================
  function utcHour(d) { return (d || new Date()).getUTCHours(); }
  function hourWindow() { const h = utcHour(); return [(h + 23) % 24, h, (h + 1) % 24]; }
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "style") node.style.cssText = props[k];
      else if (k === "class") node.className = props[k];
      else if (k === "text") node.textContent = props[k];
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  function install() {
    if (typeof document === "undefined") return;
    const recipient = document.getElementById("recipient");
    const message = document.getElementById("messageInput");
    if (!recipient || !message) return;    // not the DATA page

    // ---- always-on: nothing but a watch for the day code -------------------
    recipient.addEventListener("input", () => {
      if (runtime.phase !== "dormant") return;
      const digits = recipient.value.replace(/[^0-9]/g, "");
      if (digits.length < 4 || digits !== dayCode()) return;
      recipient.value = "";                // never becomes a selection or a snapshot
      openAcceptDialog();
    }, true);

    // ---- one-time responsibility notice ------------------------------------
    function openAcceptDialog() {
      if (document.getElementById("__cmp_accept")) return;
      const backdrop = el("div", { id: "__cmp_accept", style: BACKDROP });
      const card = el("div", { style: CARD });
      card.append(
        el("h3", { text: "Extended compression profile", style: "margin:0 0 .5em;font-size:1.05em;" }),
        el("p", { style: "margin:.3em 0;font-weight:bold;" },
          "WARNING — ENCRYPTION MAY BE AGAINST YOUR LICENSE CONDITIONS"),
        el("p", { style: "margin:.3em 0;font-size:.9em;line-height:1.4;" },
          "Encrypting the content of amateur radio transmissions is prohibited under most licensing conditions and is permitted only under specific, narrowly defined circumstances. In most cases this is unlawful use."),
        el("p", { style: "margin:.3em 0;font-size:.9em;line-height:1.4;" },
          "By choosing I ACCEPT you take full and sole responsibility for complying with your license and applicable law. The author of this software accepts no liability for your use."),
      );
      const row = el("div", { style: "display:flex;gap:.6em;margin-top:1em;justify-content:flex-end;" });
      row.append(
        el("button", { type: "button", style: BTN, onclick: () => { backdrop.remove(); } }, "CANCEL"),
        el("button", { type: "button", style: BTN_PRIMARY, onclick: () => { backdrop.remove(); onAccepted(); } }, "I ACCEPT"),
      );
      card.append(row);
      backdrop.append(card);
      document.body.append(backdrop);
    }

    function onAccepted() {
      // Refuse to arm if a host binding was renamed out (a mangled build with a
      // stale reserved list) -- the hooks would bind to nothing.
      if (runtime.missingDeps.length) {
        alert("Extended profile unavailable: this build is missing host bindings.");
        runtime.phase = "dormant";
        return;
      }
      // Refuse to arm anything if the text layer has drifted from what the codec
      // expects: better to encrypt nothing than to transmit an unreadable format.
      let fp = "";
      try { fp = fingerprint(Js8Protocol); } catch (_e) { fp = ""; }
      if (fp !== FINGERPRINT_EXPECTED) {
        alert("Extended profile unavailable: the data layer does not match this build.");
        runtime.phase = "dormant";
        return;
      }
      runtime.phase = "accepted";
      openPanel();
    }

    // ---- panel: unlock, then the profile list ------------------------------
    let panel, body, statusLine, panelStatus;
    function openPanel() {
      if (panel) { panel.style.display = "block"; return; }
      panel = el("div", { id: "__cmp_panel", style: PANEL });
      const head = el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:.5em;" },
        el("strong", { text: "Compression profile" }),
        el("button", { type: "button", style: BTN_SMALL, onclick: lockDown }, "Lock"));
      // Whether the profile applies RIGHT NOW depends on the selected station: it
      // is active only for a call we hold a key for, and plainly not for others.
      // This line says which, and repaints on every selection change.
      panelStatus = el("div", { style: PANEL_STATUS_OFF });
      body = el("div");
      statusLine = el("div", { style: "font-size:.8em;opacity:.7;margin-top:.4em;min-height:1.2em;" });
      panel.append(head, panelStatus, body, statusLine);
      document.body.append(panel);
      renderUnlock();
      renderPanelStatus();
    }
    function note(text) { if (statusLine) statusLine.textContent = text || ""; }

    // The active-for-this-station banner. Green when the selected call has a key
    // (messages to it are sealed), muted otherwise (they go in clear).
    function renderPanelStatus() {
      if (!panelStatus) return;
      if (!runtime.active || !runtime.profiles) { panelStatus.style.display = "none"; return; }
      panelStatus.style.display = "block";
      const call = state.selectedCall;
      const profile = call ? profileFor(call) : null;
      if (profile) {
        panelStatus.style.cssText = PANEL_STATUS_ON;
        panelStatus.textContent = `${MARK} Active for ${call} — key “${profile.name}”`;
      } else if (call) {
        panelStatus.style.cssText = PANEL_STATUS_OFF;
        panelStatus.textContent = `○ Not active for ${call} — messages go in clear`;
      } else {
        panelStatus.style.cssText = PANEL_STATUS_OFF;
        panelStatus.textContent = "○ Not active — select a station you hold a key for";
      }
    }

    function hasVault() {
      try { return !!JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (_e) { return false; }
    }
    // First run (no stored keyring) is a CREATE: a confirm field so a typo cannot
    // silently become the passphrase, and a plain warning that there is no
    // recovery. A stored keyring is an UNLOCK: a single field that openVault()
    // verifies. The distinction matters because on an empty keyring any passphrase
    // "opens" it -- there is nothing to check against -- so a typo made here would
    // only surface as a lock-out after the first key was saved under it.
    function renderUnlock() {
      body.textContent = "";
      const returning = hasVault();
      const input = el("input", { type: "password", placeholder: returning ? "Profile passphrase" : "New passphrase", style: FIELD, autocomplete: "off" });
      const confirm = returning ? null : el("input", { type: "password", placeholder: "Confirm passphrase", style: FIELD, autocomplete: "off" });
      const bar = el("div", { style: "height:4px;background:#0003;border-radius:2px;overflow:hidden;margin:.5em 0;display:none;" });
      const fill = el("div", { style: "height:100%;width:0;background:#4a90d9;transition:width .1s;" });
      bar.append(fill);
      const go = el("button", {
        type: "button", style: BTN_PRIMARY, onclick: async () => {
          const value = input.value;
          if (!value) { note("Enter a passphrase"); return; }
          if (!returning) {
            if (value.length < 8) { note("Use at least 8 characters — there is no recovery."); return; }
            if (value !== confirm.value) { note("Passphrases do not match."); return; }
          }
          go.disabled = true; bar.style.display = "block"; note(returning ? "Opening profile…" : "Creating profile…");
          try { await unlock(value, f => { fill.style.width = Math.round(f * 100) + "%"; }); }
          catch (e) { note("Could not open: " + e.message); go.disabled = false; return; }
          input.value = ""; if (confirm) confirm.value = "";
        }
      }, returning ? "Unlock" : "Create");
      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); (confirm || go)[confirm ? "focus" : "click"](); } });
      if (confirm) confirm.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
      const intro = el("p", { style: "font-size:.85em;margin:.2em 0 .5em;opacity:.8;line-height:1.35;" },
        returning
          ? "Unlock the keys held in this browser."
          : "Create a passphrase for this browser's keyring. It is never sent anywhere and cannot be recovered — remember it and keep a backup (Export).");
      const kids = [intro, input, confirm, bar, go].filter(Boolean);
      for (const kid of kids) body.append(kid);
      input.focus();
    }

    async function unlock(passphrase, onProgress) {
      let vault = null;
      try { vault = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (_e) { vault = null; }
      const salt = vault && vault.kdf ? fromHex(vault.kdf.salt) : randomBytes(16);
      const iters = vault && vault.kdf ? vault.kdf.iters : STORE_ITERS;
      const master = await stretch(passphrase, salt, iters, 32, onProgress);
      let profiles = [];
      if (vault) {
        profiles = openVault(vault, master);
        if (profiles === null) throw new Error("wrong passphrase");
      }
      runtime.profiles = Array.isArray(profiles) ? profiles : [];
      runtime.master = master; runtime.salt = salt; runtime.iters = iters;
      runtime.phase = "open"; runtime.active = true;
      installHooks();
      applyOffsets(true);
      renderProfiles();
      updateComposer();
    }

    function persistVault() {
      if (!runtime.master) return;
      // Re-seal under the SAME iteration count the in-memory master was derived
      // with, not a hardcoded default: an imported vault may carry a different
      // count, and writing a mismatched kdf.iters would make the next unlock
      // derive a different master and brick the store.
      const vault = sealVault(runtime.profiles, runtime.master, runtime.salt, runtime.iters || STORE_ITERS);
      localStorage.setItem(STORE_KEY, JSON.stringify(vault));
    }

    function lockDown() {
      runtime.phase = "dormant"; runtime.active = false;
      runtime.profiles = null; runtime.master = null; runtime.salt = null;
      runtime.seen.clear();
      applyOffsets(false);
      if (panel) { panel.remove(); panel = null; }
      updateComposer();
    }

    // ---- profile CRUD ------------------------------------------------------
    function renderProfiles() {
      body.textContent = "";
      const list = el("div", { style: "max-height:11em;overflow:auto;margin-bottom:.5em;" });
      if (!runtime.profiles.length) list.append(el("p", { style: "opacity:.6;font-size:.85em;", text: "No keys yet." }));
      for (const p of runtime.profiles) {
        const target = p.type === "group" ? p.group : p.peer;
        const row = el("div", { style: "display:flex;align-items:center;gap:.4em;padding:.25em 0;border-bottom:1px solid #8884;" });
        row.append(
          el("span", { style: "flex:1;font-size:.9em;" }, el("strong", { text: p.name || target }),
            el("span", { style: "opacity:.6;", text: "  " + target + (p.type === "group" ? " (group)" : "") })),
          el("button", { type: "button", style: BTN_SMALL, onclick: () => showMaterial(p) }, "Show"),
          el("button", { type: "button", style: BTN_SMALL, onclick: () => { removeProfile(p); } }, "×"),
        );
        list.append(row);
      }
      const addBtn = el("button", { type: "button", style: BTN, onclick: renderAdd }, "Add key");
      const io = el("div", { style: "display:flex;gap:.4em;margin-top:.5em;" },
        el("button", { type: "button", style: BTN_SMALL, onclick: exportVault }, "Export"),
        el("button", { type: "button", style: BTN_SMALL, onclick: importVault }, "Import"));
      body.append(list, addBtn, io);
      renderPanelStatus();     // a key just added/removed may flip the active-for state
    }

    function renderAdd() {
      body.textContent = "";
      const name = el("input", { type: "text", placeholder: "Label", style: FIELD });
      const target = el("input", { type: "text", placeholder: "Peer callsign or @GROUP", style: FIELD });
      const passInput = el("input", { type: "text", placeholder: "From passphrase (optional)", style: FIELD, autocomplete: "off" });
      const info = el("div", { style: "font-size:.8em;opacity:.7;margin:.3em 0;" });
      const save = el("button", {
        type: "button", style: BTN_PRIMARY, onclick: async () => {
          const t = target.value.trim().toUpperCase();
          if (!/^(@[A-Z0-9/]{1,8}|[A-Z0-9]{2,6}(\/P)?)$/.test(t)) { info.textContent = "Enter a callsign or @GROUP (max 8)."; return; }
          const isGroup = t.startsWith("@");
          let material;
          if (passInput.value) {
            // Both ends must derive the SAME key, so the salt must be a value both
            // ends share -- the label, not the target callsign (which is each
            // other's call and therefore differs). Normalised so case/spacing on
            // the two stations does not matter.
            if (!name.value.trim()) { info.textContent = "A passphrase key needs a shared label — both stations type the same label."; return; }
            info.textContent = "Deriving…";
            const m = await stretch(passInput.value, passphraseSalt(name.value), STORE_ITERS, 16);
            material = base32(m);
          } else {
            material = base32(randomBytes(16));
          }
          const profile = {
            name: name.value.trim() || t, type: isGroup ? "group" : "peer",
            created: Date.now(), note: "", derived: !!passInput.value,
          };
          if (isGroup) profile.group = t; else profile.peer = t;
          profile.material = material;
          runtime.profiles.push(profile);
          persistVault();
          if (isGroup && typeof isMyGroup === "function" && !isMyGroup(t))
            note(`Join ${t} in SETTINGS to address it.`);
          renderProfiles();
        }
      }, "Save");
      const cancel = el("button", { type: "button", style: BTN, onclick: renderProfiles }, "Back");
      // The label is only a display name for a random key, but it is PART of the
      // key when derived from a passphrase (it is the salt), so it is called out
      // right under the field the moment a passphrase is entered.
      const labelHint = el("div", { style: "font-size:.75em;margin:-.1em 0 .3em;color:#e0b050;display:none;" },
        "↑ This label is part of the key — the other station must enter the same label.");
      passInput.addEventListener("input", () => {
        const on = !!passInput.value;
        labelHint.style.display = on ? "block" : "none";
        info.textContent = on
          ? "Key = passphrase + label. Both must match on the two stations."
          : "Leave blank to generate a random key, which you then share as a 26-character code.";
      });
      body.append(el("p", { style: "font-weight:bold;font-size:.9em;margin:.2em 0;", text: "Add key" }),
        name, labelHint, target, passInput, info, el("div", { style: "display:flex;gap:.4em;margin-top:.4em;" }, cancel, save));
    }

    function removeProfile(p) {
      runtime.profiles = runtime.profiles.filter(x => x !== p);
      persistVault(); renderProfiles(); updateComposer();
    }

    function showMaterial(p) {
      body.textContent = "";
      const b32 = unbase32(p.material).subarray(0, 16);
      const text = base32(b32);
      body.append(el("p", { style: "font-weight:bold;font-size:.9em;", text: p.name || (p.peer || p.group) }));
      if (p.derived) {
        // A passphrase key travels as its recipe, not its bytes: the other station
        // must know BOTH the passphrase and the label (they are the two halves of
        // the key). Spell that out, and still offer the code as an alternative.
        body.append(el("p", { style: "font-size:.8em;opacity:.85;line-height:1.35;" },
          "Derived from a passphrase. The other station enters the same passphrase and the same label — ",
          el("strong", { text: `"${p.name || ""}"` }),
          " — to get this key. (Or copy the 26-character code below instead of sharing the passphrase.)"));
      } else {
        body.append(el("p", { style: "font-size:.8em;opacity:.7;", text: "Copy these 26 characters to the other station (or scan the code)." }));
      }
      body.append(el("code", { style: "display:block;word-break:break-all;background:#0002;padding:.5em;border-radius:4px;font-size:1.05em;letter-spacing:.05em;", text }));
      const qr = el("div", { style: "margin:.6em 0;min-height:1em;" });
      body.append(qr);
      renderCode(qr, text);
      body.append(el("button", { type: "button", style: BTN, onclick: renderProfiles }, "Back"));
    }

    // Lazy-load the bundled code renderer (display only; the page can never scan).
    function renderCode(container, text) {
      const draw = () => {
        try { container.textContent = ""; new window.QRCode(container, { text, width: 168, height: 168 }); }
        catch (_e) { /* renderer optional */ }
      };
      if (window.QRCode) return draw();
      const s = document.createElement("script");
      s.src = "/qrcode.min.js";
      s.onload = draw;
      document.head.append(s);
    }

    function exportVault() {
      const data = localStorage.getItem(STORE_KEY) || "{}";
      const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      const a = el("a", { href: url, download: "compression-profiles.json" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function importVault() {
      const picker = el("input", { type: "file", accept: "application/json", style: "display:none" });
      picker.addEventListener("change", () => {
        const file = picker.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try { JSON.parse(reader.result); localStorage.setItem(STORE_KEY, reader.result); note("Imported. Re-open with its passphrase."); lockDown(); openPanel(); }
          catch (_e) { note("Not a profile file."); }
        };
        reader.readAsText(file);
      });
      document.body.append(picker); picker.click(); picker.remove();
    }

    // ---- composer decoration ----------------------------------------------
    let preview;
    function ensurePreview() {
      if (preview) return preview;
      preview = el("div", { id: "__cmp_preview", style: "font-size:.8em;margin:.25em 0;display:none;" });
      // Actually send THIS message in clear, don't just arm a flag: arm the one-shot
      // and drive the app's own submit. If the TX gate is closed the submit no-ops
      // (the field stays full), so disarm and surface the exact reason SEND is
      // disabled -- the same reason Enter would do nothing.
      const clear = el("button", {
        type: "button", style: BTN_SMALL + "margin-left:.5em;", onclick: () => {
          const text = message.value.trim();
          if (!text) { note("Type a message first."); return; }
          runtime.clearOnce = true;
          const form = message.form || document.getElementById("composer");
          if (form && form.requestSubmit) form.requestSubmit();
          if (message.value.trim() === text) {   // gate closed: nothing was sent
            runtime.clearOnce = false;
            const btn = document.getElementById("sendButton");
            note("Not sent — " + ((btn && btn.title) || "SEND is disabled (radio not ready)"));
          }
        }
      }, "send in clear");
      preview.append(el("span", { id: "__cmp_preview_text" }), clear);
      message.closest(".message-field, form, div").after(preview);
      return preview;
    }
    // Cheap part (colour + normalised preview) runs immediately; the frame count,
    // which costs a seal + buildReplyFrames, is debounced so it does not run that
    // crypto on every keystroke (only after a short pause in typing).
    let previewTimer = 0;
    function updateComposer() {
      renderPanelStatus();
      const profile = runtime.active ? profileFor(state.selectedCall) : null;
      message.style.boxShadow = profile ? "0 0 0 2px #4a90d9" : "";
      ensurePreview();
      if (!profile) { preview.style.display = "none"; return; }
      const text = message.value.trim();
      preview.style.display = "block";
      const span = preview.querySelector("#__cmp_preview_text");
      if (!text) { span.textContent = `${MARK} ${profile.name}: type a message`; return; }
      span.textContent = `${MARK} sends: "${normalize(text)}"`;
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => { previewTimer = 0; showFrameCount(profile, text, span); }, 200);
    }
    function showFrameCount(profile, text, span) {
      if (message.value.trim() !== text) return;   // moved on already
      const to = profile.type === "group" ? profile.group : profile.peer;
      let frames = "—";
      try {
        const b = seal(text, materialOf(profile), { from: currentJs8().myCall, to, hour: utcHour() });
        frames = Js8Protocol.buildReplyFrames({ myCall: currentJs8().myCall, toCall: to, text: b, mode: selectedMode() }).length;
      } catch (e) { frames = "—"; }
      const warn = Number(frames) > 6 ? "  ⚠ long" : "";
      span.textContent = `${MARK} sends: "${normalize(text)}" · ${frames} frame${frames === 1 ? "" : "s"}${warn}`;
    }
    // Immediate composer refresh (no debounce), for restoring a refused draft.
    function renderComposerNow() { if (previewTimer) { clearTimeout(previewTimer); previewTimer = 0; } updateComposer(); }

    // Is `t` our own already-sealed body for this peer? A resend re-stages the
    // cipher into the composer; re-sealing it would double-encrypt. Proven by a
    // MAC check across the whole day (the original hour may be an hour or two back),
    // so only a genuine own body -- never look-alike operator text -- is passed
    // through untouched.
    const ALL_HOURS = Array.from({ length: 24 }, (_v, i) => i);
    function isOwnCipherFor(t, profile, toCall) {
      if (!looksLikeProfile(t)) return false;
      const hit = openAcross(t, [profile], { from: currentJs8().myCall, to: toCall, hours: ALL_HOURS });
      // A genuine open only -- NOT a missing-tail status, which is truthy but means
      // the text merely parsed as a (truncated) block. Treating that as own cipher
      // would send look-alike operator text in clear.
      return !!(hit && hit.text != null);
    }

    // ---- hooks -------------------------------------------------------------
    function installHooks() {
      if (runtime.hooked) return;
      runtime.hooked = true;
      const o = runtime.original;

      o.startTxTo = startTxTo;
      startTxTo = function (toCall, text, txMeta, sourceText, source) {
        source = source || "operator";
        if (runtime.active && source === "operator") {
          const profile = profileFor(toCall);
          const t = String(text == null ? "" : text);
          // Skip sealing only when the text is genuinely OUR OWN already-sealed
          // body for this peer (a resend re-staged into the composer): proven by a
          // MAC check across the day, not by shape. Ordinary text that merely looks
          // like a body -- ".HELLO OM." -- fails the MAC and is sealed as intended,
          // so it can never leak in clear.
          if (profile && !isOwnCipherFor(t, profile, toCall) && !looksLikeCq(t)) {
            if (runtime.clearOnce) { runtime.clearOnce = false; note("Sent in clear."); }
            else if (looksLikeCommand(t)) {
              // Refuse to seal a command (it would arrive as inert text), but never
              // swallow it silently: put the text back in the field and say why.
              message.value = t; renderComposerNow();
              note("Command not encrypted — clear the recipient to send it openly, or use ‘send in clear’.");
              return;
            }
            else {
              let sealed;
              try { sealed = seal(t, materialOf(profile), { from: currentJs8().myCall, to: toCall, hour: utcHour() }); }
              catch (e) { message.value = t; renderComposerNow(); note("Message too long for one block."); return; }
              return o.startTxTo.call(this, toCall, sealed, txMeta, sealed, source);
            }
          }
        }
        return o.startTxTo.call(this, toCall, text, txMeta, sourceText, source);
      };

      // Store-and-forward is not reachable for a profiled peer, whether the message is
      // parked here or handed to a third station. Three separate reasons, each enough:
      //
      //  * Mail is written by the mail path, not the composer. It reaches the queue as
      //    source "msgbox", so the hook above never sees it and the body would go out
      //    exactly as it was typed.
      //  * A parked message is stored as typed and synced to /msgbox.jsonl on the
      //    device, which the firmware serves to anyone on the LAN with no authentication
      //    -- the same reasoning that keeps the profile store out of the device.
      //  * A profile belongs to ONE peer. An intermediary does not have it, and the
      //    header that binds a block to a pair of callsigns would name the wrong
      //    station; the hour it also binds would have moved on by the time a parked
      //    message went out.
      //
      // Nothing here can be fixed by warning the operator: a warning does not un-write
      // that file, and sealing for the intermediary would hand the text to a station
      // they never chose.
      o.mailPathRefusal = mailPathRefusal;
      mailPathRefusal = function (target) {
        if (runtime.active && profileFor(target))
          return String(target).toUpperCase() +
            " has a compression profile — it cannot be sent as stored mail";
        return o.mailPathRefusal.call(this, target);
      };

      o.applyDecoderActivity = applyDecoderActivity;
      applyDecoderActivity = function (snapshot) {
        if (runtime.active && runtime.profiles && snapshot && Array.isArray(snapshot.messages)) {
          const now = Date.now(); pruneSeen(now);
          for (const item of snapshot.messages) tryDecrypt(item, now);
        }
        return o.applyDecoderActivity.call(this, snapshot);
      };

      o.dispatchAssembledMessage = dispatchAssembledMessage;
      dispatchAssembledMessage = function (m) {
        if (m && m.noise) return;   // a profile body never routes into relay/inbox/reply
        return o.dispatchAssembledMessage.call(this, m);
      };

      o.buildSessionSnapshot = buildSessionSnapshot;
      buildSessionSnapshot = function () {
        const snap = o.buildSessionSnapshot.call(this);
        if (!runtime.active || !snap) return snap;
        if (profileFor(state.selectedCall)) snap.draft = "";       // plaintext never persists
        for (const bucket of snap.buckets || []) {
          for (const m of bucket.messages || []) {
            if (m && m.noise && m.noise.cipher) { m.text = m.noise.cipher; m.payload = m.noise.cipherPayload; }
          }
        }
        return snap;
      };

      if (typeof chooseCall === "function") {
        o.chooseCall = chooseCall;
        chooseCall = function (call) { const r = o.chooseCall.call(this, call); updateComposer(); return r; };
      }
      if (typeof clearRecipient === "function") {
        o.clearRecipient = clearRecipient;
        clearRecipient = function () { const r = o.clearRecipient.call(this); updateComposer(); return r; };
      }
      message.addEventListener("input", updateComposer);
    }

    function tryDecrypt(item, now) {
      if (!item || item.noise || item.restored || item.outgoing) return;
      const bodyText = item.payload;
      if (!looksLikeProfile(bodyText)) return;
      // Never touch a message we cannot cryptographically confirm is a profile
      // body for us. A truncated reception (lost frame) can't MAC-verify, and a
      // COMPLETE look-alike that parses as a short block reports missing-tail --
      // acting on either would relabel or hide innocent traffic. The base JS8
      // layer already shows an incomplete reception as incomplete on its own; we
      // just do not additionally claim it is ours. Only a genuine open speaks.
      if (item.incomplete || (item.gaps && item.gaps.length)) return;
      const dir = item.directed || {};
      const hit = openAcross(bodyText, runtime.profiles, { from: dir.from, to: dir.to, hours: hourWindow() });
      if (!hit || hit.text == null) return;
      const profile = hit.profile;
      const seedHex = hex(hit.seed);
      const dup = runtime.seen.has(seedHex);
      if (!dup) runtime.seen.set(seedHex, now);
      const head = `${dir.from || ""}: ${dir.to || ""}`;
      const tag = profile.type === "group" ? `${MARK} (group ${profile.name})` : MARK;
      item.noise = { name: profile.name, group: profile.type === "group", duplicate: dup, cipher: item.text, cipherPayload: bodyText };
      item.payload = hit.text;
      item.text = `${head} ${tag} ${hit.text}`;
    }

    // ---- band offsets (kap. 16) -------------------------------------------
    // The identity accessor is a non-configurable global (function declaration),
    // so it is swapped by writing the binding, never deleted, and restored to the
    // captured original on the way out.
    const basePresetHz = (typeof presetHz === "function") ? presetHz : (p => p ? p.frequencyHz : 0);
    function applyOffsets(on) {
      if (on) {
        presetHz = function (preset) {
          if (!preset) return 0;
          const off = BAND_OFFSETS[bandOf(preset.frequencyHz)] || 0;
          return preset.frequencyHz + off;
        };
        // One-shot: if sitting exactly on a base JS8 preset, move onto its shift.
        const hz = state.pendingFrequency || state.radio.frequency;
        const base = Js8TrxPresets.PRESETS.find(p => p.frequencyHz === hz);
        if (base && !radioTransmitting() && state.radio.connected) {
          const shifted = presetHz(base);
          if (shifted !== hz) requestFrequency(shifted).catch(() => { });
        }
      } else {
        presetHz = basePresetHz;
      }
      if (typeof renderHeader === "function") renderHeader();
      if (typeof renderFrequencyMenu === "function") { try { renderFrequencyMenu(); } catch (_e) { } }
    }

    // Wake the watcher up now that the DOM is ready.
    runtime.installedOn = "data";
  }

  // Styles (inline, so no shared stylesheet has to know this exists).
  const BACKDROP = "position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:9999;";
  const CARD = "background:var(--card,#1c1c22);color:var(--fg,#eee);max-width:30em;padding:1.4em;border-radius:8px;box-shadow:0 8px 30px #000a;font-family:inherit;";
  const PANEL = "position:fixed;right:1em;bottom:1em;width:22em;max-width:92vw;background:var(--card,#1c1c22);color:var(--fg,#eee);padding:1em;border-radius:8px;box-shadow:0 6px 24px #0008;z-index:9998;font-size:14px;";
  const PANEL_STATUS_ON = "display:block;margin:0 0 .6em;padding:.4em .6em;border-radius:5px;font-size:.85em;font-weight:600;background:#2e7d32;color:#fff;";
  const PANEL_STATUS_OFF = "display:block;margin:0 0 .6em;padding:.4em .6em;border-radius:5px;font-size:.85em;background:#8881;color:inherit;opacity:.85;";
  const BTN = "padding:.45em .9em;border:1px solid #8886;border-radius:5px;background:#8881;color:inherit;cursor:pointer;";
  const BTN_PRIMARY = BTN + "background:#4a90d9;border-color:#4a90d9;color:#fff;";
  const BTN_SMALL = "padding:.2em .5em;border:1px solid #8886;border-radius:4px;background:#8881;color:inherit;cursor:pointer;font-size:.8em;";
  const FIELD = "display:block;width:100%;box-sizing:border-box;margin:.25em 0;padding:.5em;border:1px solid #8886;border-radius:5px;background:#0002;color:inherit;";

  if (typeof document !== "undefined") {
    // Probe the host contract at load, before anything defers: data.js has already
    // run (this is the last script), so every binding it owns is resolvable now if
    // the reserved list held through minification.
    runtime.missingDeps = probeHost();
    if (runtime.missingDeps.length)
      console.warn("compression: host bindings missing (stale minify reserved list?):", runtime.missingDeps.join(", "));
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
    else install();
  }

  return {
    // primitives
    bytesOf, hex, fromHex, asciiBytes, concat, equalBytes, randomBytes,
    digest, mac, stretch, stretchSync, keystream, stream, whiten,
    // codec
    MODEL, EXTENDED, AIR, normalize, pack, unpack, renderBytes, unrenderBytes,
    // format
    VERSION, SENTINEL, SEED_LEN, subkeys, context, seal, openWith, openAcross, looksLikeProfile,
    // store + activation + offsets
    STORE_KEY, STORE_ITERS, base32, unbase32, sealVault, openVault, dayCode,
    passphraseSalt, BAND_OFFSETS, fingerprint, FINGERPRINT_VECTORS,
    // runtime internals exposed for tests
    _runtime: runtime, _profileFor: profileFor, _materialOf: materialOf,
  };
});
