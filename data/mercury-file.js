// MRQ1 file layer (docs/mercury-implementace.md ch.5). ARQ already gives
// reliable, in-order, byte-exact delivery (go-back-N, tx_seq/rx_ack_seq) --
// this layer therefore needs NONE of js8-file-transfer.js's machinery
// (per-block CRC16, NACK ranges, compactRanges/parseRanges): all of that
// exists only because JS8 is an unreliable broadcast. What's left is just a
// header (magic/version/flags/size/offset/hash/name) riding as the first
// bytes of the ARQ byte-pipe, plus resume bookkeeping.
//
// Reuses js8-file-transfer.js's own sha256()/sha256Fallback()/hex()
// UNCHANGED rather than re-implementing them -- same reason
// mercury-cal-worker.js reuses tx-gain-cal.js's TxGainCal verbatim: this
// exact FIPS 180-4 SHA-256 already exists, is already proven (JS8's own
// file transfer depends on it), and crypto.subtle is unavailable on this
// device's insecure origin (see [[js8-crypto-layer-plan]]) so the pure-JS
// fallback path matters for real, not just as a defensive extra.
(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports
      ? require("./js8-file-transfer.js") : root.Js8FileTransfer
  );
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.MercuryFile = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (Js8FileTransfer) {
  "use strict";

  const MAGIC = [0x4d, 0x52, 0x51, 0x31]; // "MRQ1"
  const VERSION = 1;
  const HEADER_FIXED_LEN = 55; // everything up to and including the name-length byte
  const FLAG_DEFLATE = 0x01;
  const FLAG_RESUME = 0x02;
  // This project's own extension, riding the same header shape (doc ch.5
  // defines the byte layout but leaves "how the offset gets agreed" as an
  // implementation detail: "resume: receiver keeps the byte count in
  // IndexedDB; at a new connection the offset is negotiated and the sender
  // starts from there"). A QUERY carries name+size+hash with offset=0 and no
  // file bytes following, asking "do you already have any of this?"; a
  // REPLY carries the same identity with offset=<bytes the replier already
  // has> (0 if none) and no file bytes either. Whichever side is about to
  // send always sends a QUERY first and waits for a REPLY before sending
  // the real header+content -- cheap (55+namelen bytes each way) against a
  // 100kB-class transfer, and reuses the one struct instead of a second
  // wire format.
  const FLAG_QUERY = 0x04;
  const FLAG_REPLY = 0x08;

  function bytesOf(value) { return value instanceof Uint8Array ? value : new Uint8Array(value || 0); }

  // Mirrors doc ch.5's own sanitisation intent: a name safe to show in UI
  // and safe to use as a filesystem/IndexedDB key on either end. This name
  // arrives over an untrusted RF channel (parseHeader() runs this on
  // whatever bytes a peer actually sent, not just what buildHeader() put
  // in), and mercury.js's own UI shows it directly -- so besides path
  // separators and control characters, HTML-special characters get replaced
  // too, so "safe to show in UI" is actually true rather than just claimed;
  // callers should still prefer building DOM nodes via textContent over
  // innerHTML regardless (defense in depth, not a substitute for it).
  function sanitizeFileName(name) {
    const text = String(name || "")
      .replace(/[\\/]+/g, "_")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/[<>&"'`]/g, "_")
      .trim();
    // Truncate by UTF-8 BYTES, not UTF-16 code units: buildHeader()'s own
    // 255-byte cap counts encoded bytes, and any multi-byte alphabet
    // (Czech, Cyrillic, CJK) can put 2-4 bytes in what String.slice() counts
    // as one unit. Truncating by code units first let an ordinary ~90-char
    // Czech filename encode past 255 bytes and throw there instead.
    return truncateUtf8(text, 200) || "file";
  }

  // Trims `text` to at most `maxBytes` of UTF-8, cutting on a codepoint
  // boundary (never inside a surrogate pair) so the result re-encodes to
  // exactly the byte count it was measured at.
  function truncateUtf8(text, maxBytes) {
    const encoder = new TextEncoder();
    if (encoder.encode(text).length <= maxBytes) return text;
    let result = "", byteLen = 0;
    for (const ch of text) { // iterates by Unicode codepoint
      const chBytes = encoder.encode(ch).length;
      if (byteLen + chBytes > maxBytes) break;
      result += ch;
      byteLen += chBytes;
    }
    return result;
  }

  function buildHeader({ flags = 0, totalSize = 0, offset = 0, sha256 = null, name = "" }) {
    const nameBytes = new TextEncoder().encode(sanitizeFileName(name));
    if (nameBytes.length > 255) throw new Error("MRQ1 name too long (max 255 bytes UTF-8)");
    const hashBytes = bytesOf(sha256);
    if (hashBytes.length !== 32 && hashBytes.length !== 0) throw new Error("MRQ1 sha256 must be exactly 32 bytes");
    const header = new Uint8Array(HEADER_FIXED_LEN + nameBytes.length);
    const view = new DataView(header.buffer);
    header.set(MAGIC, 0);
    view.setUint8(4, VERSION);
    view.setUint8(5, flags & 0xff);
    view.setBigUint64(6, BigInt(totalSize), false);
    view.setBigUint64(14, BigInt(offset), false);
    header.set(hashBytes.length === 32 ? hashBytes : new Uint8Array(32), 22);
    view.setUint8(54, nameBytes.length);
    header.set(nameBytes, HEADER_FIXED_LEN);
    return header;
  }

  // Returns null if `bytes` doesn't yet contain a complete header (caller
  // should wait for more bytes to arrive over the ARQ pipe before retrying)
  // -- distinct from throwing, which means the bytes present are definitely
  // not a valid MRQ1 header (bad magic), not just incomplete.
  function parseHeader(bytes) {
    const buf = bytesOf(bytes);
    if (buf.length < HEADER_FIXED_LEN) return null;
    if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1] || buf[2] !== MAGIC[2] || buf[3] !== MAGIC[3])
      throw new Error("not an MRQ1 header (bad magic)");
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const version = view.getUint8(4);
    if (version !== VERSION) throw new Error(`unsupported MRQ1 version ${version}`);
    const flags = view.getUint8(5);
    const totalSize = Number(view.getBigUint64(6, false));
    const offset = Number(view.getBigUint64(14, false));
    const sha256 = buf.slice(22, 54);
    const nameLen = view.getUint8(54);
    if (buf.length < HEADER_FIXED_LEN + nameLen) return null;
    // Sanitized here too, not just in buildHeader(): the bytes on the wire
    // came from whatever the peer actually sent, over an untrusted RF
    // channel, and every caller downstream (mercury-worker.js's
    // ResumeStore key, mercury.js's <a download> UI) needs a name that is
    // already safe rather than re-deriving that guarantee itself.
    const name = sanitizeFileName(new TextDecoder().decode(buf.slice(HEADER_FIXED_LEN, HEADER_FIXED_LEN + nameLen)));
    return {
      version, flags, totalSize, offset, sha256, name,
      headerLength: HEADER_FIXED_LEN + nameLen,
      isDeflate: Boolean(flags & FLAG_DEFLATE),
      isResume: Boolean(flags & FLAG_RESUME),
      isQuery: Boolean(flags & FLAG_QUERY),
      isReply: Boolean(flags & FLAG_REPLY),
    };
  }

  function queryHeader({ totalSize, sha256, name }) {
    return buildHeader({ flags: FLAG_QUERY, totalSize, offset: 0, sha256, name });
  }
  function replyHeader({ totalSize, sha256, name, haveBytes }) {
    return buildHeader({ flags: FLAG_REPLY | (haveBytes > 0 ? FLAG_RESUME : 0), totalSize, offset: haveBytes, sha256, name });
  }
  function dataHeader({ totalSize, sha256, name, offset, deflated }) {
    let flags = 0;
    if (offset > 0) flags |= FLAG_RESUME;
    if (deflated) flags |= FLAG_DEFLATE;
    return buildHeader({ flags, totalSize, offset, sha256, name });
  }

  async function sha256(bytes) { return Js8FileTransfer.sha256(bytes); }
  function hex(bytes) { return Js8FileTransfer.hex(bytes); }

  // The ARQ byte-pipe is one continuous stream for the whole life of a
  // connection (mercury-worker.js's own receive side sees whatever
  // host_delivered() has accumulated so far, not one frame at a time), and a
  // single exchange can carry several MRQ1 frames back to back (QUERY, then
  // later a resumed DATA frame, on the SAME session -- see
  // run-native-transfer-resume.js). This is the shared, testable core of
  // "how many complete frames does this buffer hold right now, and how far
  // into it did we get" -- callers keep `offset` across calls as more bytes
  // arrive. A QUERY/REPLY frame carries no content (frameLength ==
  // headerLength); a DATA frame's content is only the TAIL from
  // header.offset to the end (totalSize - offset bytes), not the whole file,
  // matching how dataHeader()/run-native-transfer-resume.js build one.
  function consumeFrames(bytes, offset) {
    const buf = bytesOf(bytes);
    const frames = [];
    let pos = offset || 0;
    for (;;) {
      const remaining = buf.subarray(pos);
      let header;
      try { header = parseHeader(remaining); }
      catch (e) { throw new Error(`corrupt MRQ1 stream at offset ${pos}: ${e.message}`); }
      if (!header) break; // not enough bytes yet for even the header
      const contentLen = (header.isQuery || header.isReply) ? 0 : Math.max(0, header.totalSize - header.offset);
      const frameLen = header.headerLength + contentLen;
      if (remaining.length < frameLen) break; // header seen, content still arriving
      frames.push({ header, content: remaining.subarray(header.headerLength, frameLen) });
      pos += frameLen;
    }
    return { frames, offset: pos };
  }

  // ---- deflate-raw: best-effort. CompressionStream is widely available and
  // (unlike crypto.subtle) is NOT gated to secure contexts, but this stays
  // strictly optional -- doc ch.5 makes it a flag bit precisely so a browser
  // without it just sends uncompressed (flags bit0=0), which any receiver
  // must already handle since the flag is per-transfer, not a capability
  // negotiated up front. ----
  function canCompress() { return typeof CompressionStream === "function"; }

  async function deflateRaw(bytes) {
    if (!canCompress()) return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") throw new Error("this browser cannot inflate a deflate-raw MRQ1 payload");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---- resume store: IndexedDB, one row per (peer, name, sha256) in
  // progress. Same open/upgrade shape as log-db.js's own convention (own DB,
  // versioned schema, promise-wrapped). Stores raw received bytes as a single
  // growing Blob rather than per-block records: there is no block structure
  // here (ARQ already reassembles in order), so "how many bytes so far" and
  // "the bytes themselves" are the whole of what needs to survive a reload. ----
  const DB_NAME = "wifilt-mercury-transfers";
  const DB_VERSION = 1;
  const STORE_NAME = "incoming";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function resumeKey(peerCall, name, sha256Hex) { return `${peerCall}|${name}|${sha256Hex}`; }

  class ResumeStore {
    async get(peerCall, name, sha256Hex) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(resumeKey(peerCall, name, sha256Hex));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }

    // `chunk` is appended to whatever's already stored under this key --
    // callers pass consecutive slices as they arrive, not the whole buffer
    // each time, so a long transfer doesn't re-write megabytes per packet.
    async append(peerCall, name, sha256Hex, totalSize, chunk) {
      const db = await openDb();
      const key = resumeKey(peerCall, name, sha256Hex);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(key);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          const priorBlob = existing ? existing.blob : new Blob([]);
          const blob = new Blob([priorBlob, chunk]);
          const record = { key, peerCall, name, sha256Hex, totalSize, receivedBytes: blob.size, blob, updatedAt: Date.now() };
          const putReq = store.put(record);
          putReq.onsuccess = () => resolve(record);
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    }

    async clear(peerCall, name, sha256Hex) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).delete(resumeKey(peerCall, name, sha256Hex));
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
  }

  return {
    MAGIC, VERSION, HEADER_FIXED_LEN,
    FLAG_DEFLATE, FLAG_RESUME, FLAG_QUERY, FLAG_REPLY,
    buildHeader, parseHeader, queryHeader, replyHeader, dataHeader, consumeFrames,
    sanitizeFileName, sha256, hex,
    canCompress, deflateRaw, inflateRaw,
    ResumeStore,
  };
});
