'use strict';

// When a sync is over, as one pure rule.
//
// It lives out here, above the page, because getting it wrong is invisible from
// the inside: both sides showed "Done ✓" while 16 000 QSOs were still going down
// the channel, and a completed transfer turned into "Failed" when the other end
// closed the connection afterwards. Two mistakes, one cause -- "finished" was
// being read off half the evidence.
//
//   * pendingRequests counts what I am still RECEIVING. A side that had nothing
//     to ask for started at zero, so on its own it means "finished" only for the
//     side that happens to be the receiver.
//   * outboundSends counts what I am still SENDING. That was never looked at.
//   * doneReceived is the other side saying the same about itself. Until it
//     arrives, this side is finished but the SYNC is not -- and only the sync
//     being over makes a closing connection an ending rather than a failure.
function datasyncCompletion(s) {
  var localDone = !!s.helloReceived && s.pendingRequests === 0 && s.outboundSends === 0;
  return {
    localDone: localDone,
    announce: localDone && !s.doneSent,   // send sync_done exactly once
    finished: localDone && !!s.doneReceived
  };
}

if (typeof module === 'object' && module.exports) module.exports = {datasyncCompletion: datasyncCompletion};

(function () {

  // ── Config ───────────────────────────────────────────────────────────────────
  const SYNC_DB_NAME    = 'datasyncDb';
  const SYNC_DB_VER     = 1;
  const CONTEST_DB_NAME = 'contestLogDb';
  const CONTEST_DB_VER  = 1;
  const PROTOCOL_VER    = 1;
  const APP_VER         = '1.0.0';
  const MAX_ITEMS       = 200;
  const MAX_BYTES       = 32768;
  const BUFFER_HIGH     = 1024 * 1024;

  // ── State ────────────────────────────────────────────────────────────────────
  let syncDb    = null;
  let contestDb = null;
  let pc        = null;
  let dc        = null;
  let scanRaf    = null;
  let sessionId  = null;
  let phase      = 'idle';
  let helloReceived = false;
  let doneSent      = false;
  let doneReceived  = false;
  // Requests I MADE, so this only ever measured what I am still receiving. A
  // side with nothing to ask for had an empty set from the first message and
  // declared the sync finished while it was still pumping 16 000 QSOs down the
  // channel to the other one.
  let pendingReqIds = new Set();
  // ...which is what this counts: sendBatches() calls still running.
  let outboundSends = 0;
  let stats = { sent: 0, received: 0, batches: 0, errors: 0 };

  // ── Device ID ────────────────────────────────────────────────────────────────

  function uuidv4() {
    if (crypto.getRandomValues) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, x => x.toString(16).padStart(2, '0'));
      return h[0]+h[1]+h[2]+h[3]+'-'+h[4]+h[5]+'-'+h[6]+h[7]+'-'+h[8]+h[9]+'-'+h[10]+h[11]+h[12]+h[13]+h[14]+h[15];
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function deviceId() {
    let id = localStorage.getItem('ds_device_id');
    if (!id) { id = uuidv4(); localStorage.setItem('ds_device_id', id); }
    return id;
  }

  function deviceLabel() {
    let label = localStorage.getItem('ds_device_label');
    if (!label) {
      const ua = navigator.userAgent;
      const browser = /Firefox\//i.test(ua)  ? 'Firefox'
                    : /Edg\//i.test(ua)       ? 'Edge'
                    : /Chrome\//i.test(ua)    ? 'Chrome'
                    : /Safari\//i.test(ua)    ? 'Safari'
                    : 'Browser';
      const host   = window.location.hostname || 'local';
      const suffix = Math.random().toString(16).slice(2, 6).toUpperCase();
      label = browser + '-' + host + '-' + suffix;
      localStorage.setItem('ds_device_label', label);
    }
    return label;
  }

  // ── Filename helper ──────────────────────────────────────────────────────────

  function fileTs(d) {
    const p = n => String(n).padStart(2, '0');
    return String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
           '-' + p(d.getUTCHours()) + p(d.getUTCMinutes());
  }

  // ── Database: sync metadata (sync_state, devices) ────────────────────────────

  function openSyncDb() {
    return new Promise((resolve, reject) => {
      if (syncDb) { resolve(syncDb); return; }
      const req = indexedDB.open(SYNC_DB_NAME, SYNC_DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sync_state')) {
          db.createObjectStore('sync_state', { keyPath: 'source_device_id' });
        }
        if (!db.objectStoreNames.contains('devices')) {
          db.createObjectStore('devices', { keyPath: 'device_id' });
        }
      };
      req.onsuccess = e => { syncDb = e.target.result; resolve(syncDb); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── Database: contest log (QSOs, logs, settings) ─────────────────────────────
  // Local QSOs have numeric autoIncrement id.
  // Remote QSOs have string id: "source_device_id:source_seq".
  // In IndexedDB key order numbers sort before strings, so ranges on numeric
  // keys safely exclude remote string keys.

  function openContestDb() {
    return new Promise((resolve, reject) => {
      if (contestDb) { resolve(contestDb); return; }
      const req = indexedDB.open(CONTEST_DB_NAME, CONTEST_DB_VER);
      req.onupgradeneeded = e => {
        // Mirror of log-db.js v1 schema — only fires when DB is brand new.
        const db = e.target.result;
        if (!db.objectStoreNames.contains('logs')) {
          db.createObjectStore('logs', { keyPath: 'id' })
            .createIndex('active', 'active', { unique: false });
        }
        if (!db.objectStoreNames.contains('qso')) {
          const qs = db.createObjectStore('qso', { keyPath: 'id', autoIncrement: true });
          qs.createIndex('logId',           'logId',                   { unique: false });
          qs.createIndex('logId_qsoNumber', ['logId','qsoNumber'],     { unique: false });
          qs.createIndex('logId_call',      ['logId','call'],          { unique: false });
          qs.createIndex('logId_timestamp', ['logId','timestampUtc'],  { unique: false });
          qs.createIndex('logId_freq',      ['logId','frequencyHz'],   { unique: false });
          qs.createIndex('logId_mode',      ['logId','mode'],          { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('runtimeState')) {
          db.createObjectStore('runtimeState', { keyPath: 'key' });
        }
      };
      req.onsuccess = e => { contestDb = e.target.result; resolve(contestDb); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── Generic IDB helpers ──────────────────────────────────────────────────────

  function idbGetAll(db, store, index, query) {
    return new Promise((resolve, reject) => {
      const t   = db.transaction(store, 'readonly');
      const s   = t.objectStore(store);
      const src = index ? s.index(index) : s;
      const req = query !== undefined ? src.getAll(query) : src.getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function idbCount(db, store, range) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).count(range || null);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function idbPut(db, store, record) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).put(record);
      t.oncomplete = resolve;
      t.onerror    = e => reject(e.target.error);
    });
  }

  // ── Version vector ───────────────────────────────────────────────────────────

  async function getLocalVector() {
    const cdb = await openContestDb();

    // Max local (numeric) QSO id — numbers sort before strings in IDB,
    // so bound(1, MAX_SAFE_INTEGER) reliably skips remote string keys.
    let localMax = 0;
    await new Promise((resolve, reject) => {
      const range = IDBKeyRange.bound(1, Number.MAX_SAFE_INTEGER);
      const req   = cdb.transaction('qso', 'readonly')
                       .objectStore('qso')
                       .openCursor(range, 'prev');
      req.onsuccess = e => { if (e.target.result) localMax = e.target.result.key; resolve(); };
      req.onerror   = e => reject(e.target.error);
    });

    const vector = {};
    if (localMax > 0) vector[deviceId()] = localMax;

    // Build remote part of vector from QSOs actually present in contestDb.
    // DO NOT use sync_state here — it may be stale when QSOs were deleted
    // from contestDb while datasyncDb was left intact.
    const allQsos = await idbGetAll(cdb, 'qso');
    allQsos.forEach(q => {
      if (typeof q.id === 'string' && q.source_device_id && q.source_seq != null) {
        const cur = vector[q.source_device_id] || 0;
        if (q.source_seq > cur) vector[q.source_device_id] = q.source_seq;
      }
    });

    return vector;
  }

  // ── QSO read: local (numeric ids) ────────────────────────────────────────────

  function getLocalQsosRange(fromSeq, toSeq) {
    return openContestDb().then(cdb => new Promise((resolve, reject) => {
      const range = IDBKeyRange.bound(fromSeq, toSeq);
      const req   = cdb.transaction('qso', 'readonly').objectStore('qso').getAll(range);
      req.onsuccess = e => {
        resolve(e.target.result.map(q => {
          const r = Object.assign({}, q);
          r.source_device_id = deviceId();
          r.source_seq       = q.id;         // preserve numeric local id
          r.id               = deviceId() + ':' + q.id; // string key for transport
          return r;
        }));
      };
      req.onerror = e => reject(e.target.error);
    }));
  }

  // ── QSO read: remote (string ids, for relay) ──────────────────────────────────

  async function getRemoteQsosRange(devId, fromSeq, toSeq) {
    const cdb  = await openContestDb();
    const all  = await idbGetAll(cdb, 'qso');
    return all.filter(q =>
      typeof q.id === 'string' &&
      q.source_device_id === devId &&
      q.source_seq >= fromSeq &&
      q.source_seq <= toSeq
    );
  }

  // ── QSO write: remote QSOs into contestLogDb.qso ─────────────────────────────
  // id is set to "source_device_id:source_seq" (string) so it never collides
  // with local autoIncrement numeric ids. put() is idempotent.

  async function insertRemoteQsos(qsos, remoteLogs) {
    const cdb = await openContestDb();
    return new Promise((resolve, reject) => {
      const stores = remoteLogs && remoteLogs.length ? ['qso', 'logs'] : ['qso'];
      const t = cdb.transaction(stores, 'readwrite');
      if (remoteLogs && remoteLogs.length) {
        const ls = t.objectStore('logs');
        remoteLogs.forEach(l => ls.put(l));
      }
      const qs = t.objectStore('qso');
      let stored = 0;
      qsos.forEach(q => {
        q.id = q.source_device_id + ':' + q.source_seq;
        qs.put(q);
        stored++;
      });
      t.oncomplete = () => resolve(stored);
      t.onerror    = e  => reject(e.target.error);
    });
  }

  async function getLogsForDevice() {
    const cdb  = await openContestDb();
    return idbGetAll(cdb, 'logs');
  }

  async function updateSyncState(devId, maxSeq) {
    const sdb = await openSyncDb();
    await idbPut(sdb, 'sync_state', {
      source_device_id: devId,
      max_seq_seen:     maxSeq,
      updated_at:       new Date().toISOString(),
    });
  }

  async function upsertDevice(devId, label) {
    const sdb = await openSyncDb();
    const now = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const t   = sdb.transaction('devices', 'readwrite');
      const s   = t.objectStore('devices');
      const req = s.get(devId);
      req.onsuccess = e => {
        const rec = e.target.result || { device_id: devId, first_seen_at: now };
        rec.last_seen_at = now;
        if (label) rec.label = label;
        s.put(rec);
        t.oncomplete = resolve;
        t.onerror    = ev => reject(ev.target.error);
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  // ── Compression ──────────────────────────────────────────────────────────────








  // ── WebRTC ───────────────────────────────────────────────────────────────────

  function makePC() {
    if (pc) { try { pc.close(); } catch (_) {} }
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.oniceconnectionstatechange = () => {
      log('ICE: ' + pc.iceConnectionState);
      // A finished sync ends with somebody closing the connection, and that is
      // not a failure -- it is the normal last event. Without this guard the
      // other side pressing Cancel after everything had been transferred
      // repainted a completed sync as "Failed".
      if (phase === 'done') {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          log('Connection closed after a completed sync.');
        }
        return;
      }
      if (pc.iceConnectionState === 'failed')       setPhase('failed');
      if (pc.iceConnectionState === 'disconnected') { setPhase('idle'); log('Disconnected.'); }
    };
    return pc;
  }

  function waitIce(conn) {
    if (conn.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      const t = setTimeout(resolve, 6000);
      conn.onicegatheringstatechange = () => {
        if (conn.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      };
    });
  }

  // ── HTTP signalling via ESP32 ─────────────────────────────────────────────────

  let pollTimer = null;
  let peerBase  = '';   // base URL of peer ESP32 (for Device B → Device A)

  function myBase()   { return window.location.protocol + '//' + window.location.host; }
  function peerUrl()  { return peerBase || myBase(); }

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function fetchPendingOffer() {
    const r = await fetch(peerUrl() + '/pairing/offer', { cache: 'no-store' });
    const payload = await r.json();
    return payload && payload.type === 'datasync-offer' ? payload : null;
  }

  function sameOffer(payload) {
    return payload && payload.device_id === deviceId();
  }

  async function joinOffer(payload) {
    const label = payload.device_label || payload.device_id.slice(0, 8);
    el('offerFromLabel').textContent = label;
    el('offerFound').dataset.payload = JSON.stringify(payload);
    const eyebrow = document.querySelector('#phaseOffer .eyebrow');
    if (eyebrow) eyebrow.textContent = 'Connecting to ' + label + '…';
    showPhase('phaseOffer');
    await acceptOffer();
  }

  async function createOffer() {
    try {
      setPhase('creating-offer');
      sessionId = uuidv4();
      makePC();
      dc = pc.createDataChannel('datasync', { ordered: true });
      setupDC(dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIce(pc);
      const payload = {
        type: 'datasync-offer',
        protocol_version: PROTOCOL_VER, device_id: deviceId(),
        device_label: deviceLabel(), session_id: sessionId,
        sdp: pc.localDescription.sdp,
      };
      const resp = await fetch(myBase() + '/pairing/offer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error('ESP32 offer POST failed');
      setPhase('waiting-answer');
      log('Session created — waiting for other device to accept…');
      // show our IP for cross-ESP32 case
      const myIp = window.location.hostname;
      const ipEl = document.getElementById('offerMyIp');
      if (ipEl) ipEl.textContent = myIp;
      // poll for answer
      pollTimer = setInterval(async () => {
        let answered = false;
        try {
          const r = await fetch(myBase() + '/pairing/answer');
          const d = await r.json();
          if (d.pending) {
            stopPoll();
            await processAnswer(JSON.stringify(d));
            answered = true;
          }
        } catch (_) {}
        if (answered) return;
        try {
          const pendingOffer = await fetchPendingOffer();
          if (pendingOffer && !sameOffer(pendingOffer)) {
            log('Another pending session detected — joining it instead.');
            stopPoll();
            if (pc) { try { pc.close(); } catch (_) {} pc = null; dc = null; }
            await joinOffer(pendingOffer);
          }
        } catch (_) {}
      }, 2000);
    } catch(e) {
      log('createOffer ERROR: ' + e.name + ': ' + e.message);
    }
  }

  async function syncButton() {
    const ipInput = el('peerIpInput');
    const raw = ipInput ? ipInput.value.trim() : '';
    peerBase = raw ? (window.location.protocol + '//' + raw) : '';

    // Try to find a pending offer from another device (twice, with a random back-off)
    let payload = null;
    try {
      payload = await fetchPendingOffer();
      if (!payload) {
        await sleep(250 + Math.floor(Math.random() * 900));
        payload = await fetchPendingOffer();
      }
    } catch (_) {}

    if (payload && !sameOffer(payload)) {
      try {
        await joinOffer(payload);
      } catch (_) {
        resetPairing();
      }
      return;
    }

    // No foreign offer found (or own stale offer) — create one and wait
    showPhase('phaseOffer');
    await createOffer();
  }

  async function acceptOffer() {
    const raw = el('offerFound').dataset.payload;
    let payload;
    try {
      payload = JSON.parse(raw);
      if (payload.type !== 'datasync-offer')         throw new Error('Not a datasync-offer payload');
      if (payload.protocol_version !== PROTOCOL_VER) throw new Error('Protocol version mismatch');
    } catch (e) { log('Error: ' + e.message); return; }

    setPhase('connecting');
    sessionId = payload.session_id;
    await upsertDevice(payload.device_id, payload.device_label);
    makePC();
    pc.ondatachannel = e => { dc = e.channel; setupDC(dc); };
    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    const ans = {
      type: 'datasync-answer',
      protocol_version: PROTOCOL_VER, device_id: deviceId(),
      device_label: deviceLabel(), session_id: sessionId,
      sdp: pc.localDescription.sdp,
      pending: true,
    };
    await fetch(peerUrl() + '/pairing/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ans),
    });
    log('Answer sent — waiting for DataChannel…');
  }

  async function rejectOffer() {
    try {
      await fetch(peerUrl() + '/pairing/reject', { method: 'POST' });
    } catch(_) {}
    resetPairing();
  }

  async function processAnswer(raw) {
    let payload;
    try {
      payload = JSON.parse(raw.trim());
      if (payload.type !== 'datasync-answer') throw new Error('Not a datasync-answer payload');
      if (payload.session_id !== sessionId)   throw new Error('Session ID mismatch');
    } catch (e) { log('Error: ' + e.message); return; }
    await upsertDevice(payload.device_id, payload.device_label);
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    setPhase('connecting');
    log('Answer accepted — waiting for DataChannel…');
  }

  // ── DataChannel ──────────────────────────────────────────────────────────────

  function setupDC(channel) {
    channel.onopen = () => {
      setPhase('connected');
      log('DataChannel open — starting sync…');
      resetStats();
      helloReceived = false;
      doneSent      = false;
      doneReceived  = false;
      outboundSends = 0;
      pendingReqIds = new Set();
      sendHello();
    };
    channel.onclose  = () => { if (phase !== 'done') { log('DataChannel closed.'); setPhase('idle'); } };
    channel.onerror  = e  => log('DataChannel error: ' + ((e.error && e.error.message) || 'unknown'));
    channel.onmessage = e => {
      try { handleMsg(JSON.parse(e.data)); } catch (err) { log('Invalid message: ' + err.message); }
    };
  }

  function sendMsg(msg) {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg));
  }

  // ── Sync protocol ────────────────────────────────────────────────────────────

  async function sendHello() {
    setPhase('syncing');
    const [vector, logMeta] = await Promise.all([getLocalVector(), getLogsForDevice()]);
    sendMsg({
      type: 'hello', protocol_version: PROTOCOL_VER,
      device_id: deviceId(), device_label: deviceLabel(),
      app_version: APP_VER, db_schema_version: 1, vector, log_meta: logMeta,
    });
  }

  async function handleMsg(msg) {
    switch (msg.type) {
      case 'hello':        await onHello(msg);       break;
      case 'request_logs': await onRequestLogs(msg); break;
      case 'logs_batch':   await onLogsBatch(msg);   break;
      case 'ack_batch':    onAckBatch(msg);           break;
      case 'sync_done':    onSyncDone(msg);           break;
      default: log('Unknown message type: ' + msg.type);
    }
  }

  async function onHello(msg) {
    helloReceived = true;
    log('Hello from ' + (msg.device_label || msg.device_id.slice(0, 8)));
    document.getElementById('stRemoteDevice').textContent = msg.device_label || msg.device_id.slice(0, 8);
    if (msg.protocol_version !== PROTOCOL_VER) { log('Protocol version mismatch'); return; }
    await upsertDevice(msg.device_id, msg.device_label);
    if (msg.log_meta && msg.log_meta.length) {
      const cdb = await openContestDb();
      await new Promise((resolve, reject) => {
        const t = cdb.transaction('logs', 'readwrite');
        const s = t.objectStore('logs');
        msg.log_meta.forEach(l => s.put(l));
        t.oncomplete = resolve;
        t.onerror = e => reject(e.target.error);
      });
    }
    const localVec = await getLocalVector();
    let needCount  = 0;
    for (const [devId, remoteMax] of Object.entries(msg.vector)) {
      const localMax = localVec[devId] || 0;
      if (remoteMax > localMax) {
        const rid = uuidv4();
        pendingReqIds.add(rid);
        needCount++;
        log('Requesting ' + devId.slice(0, 8) + '… seq ' + (localMax + 1) + '–' + remoteMax);
        sendMsg({
          type: 'request_logs', request_id: rid, source_device_id: devId,
          from_seq: localMax + 1, to_seq: remoteMax,
          max_batch_bytes: MAX_BYTES, max_items: MAX_ITEMS,
        });
      }
    }
    if (needCount === 0) { log('Already in sync — nothing to request.'); checkDone(); }
  }

  async function onRequestLogs(msg) {
    log('Remote requests ' + msg.source_device_id.slice(0, 8) + '… seq ' + msg.from_seq + '–' + msg.to_seq);
    outboundSends++;
    try {
      await sendBatches(msg.source_device_id, msg.from_seq, msg.to_seq,
                        msg.request_id, msg.max_items || MAX_ITEMS);
    } finally {
      outboundSends--;
      // Sending was the only thing left on this side, so finishing it is what
      // completes the sync -- nothing else will call this.
      checkDone();
    }
  }

  async function sendBatches(devId, fromSeq, toSeq, requestId, maxItems) {
    let cur = fromSeq;
    let firstBatch = true;
    while (cur <= toSeq) {
      while (dc && dc.bufferedAmount > BUFFER_HIGH) await new Promise(r => setTimeout(r, 50));
      const end  = Math.min(cur + maxItems - 1, toSeq);
      const qsos = devId === deviceId()
        ? await getLocalQsosRange(cur, end)
        : await getRemoteQsosRange(devId, cur, end);
      const logMeta = firstBatch ? await getLogsForDevice() : [];
      firstBatch = false;
      if (qsos.length === 0) {
        sendMsg({
          type: 'logs_batch', request_id: requestId, batch_id: uuidv4(),
          source_device_id: devId, from_seq: cur, to_seq: toSeq,
          count: 0, is_last: true, logs: [], log_meta: logMeta,
        });
        break;
      }
      const actualEnd = qsos[qsos.length - 1].source_seq;
      const isLast    = actualEnd >= toSeq;
      sendMsg({
        type: 'logs_batch', request_id: requestId, batch_id: uuidv4(),
        source_device_id: devId, from_seq: cur, to_seq: actualEnd,
        count: qsos.length, is_last: isLast, logs: qsos, log_meta: logMeta,
      });
      stats.sent += qsos.length; stats.batches++; updateStats();
      log('Sent ' + qsos.length + ' QSOs (' + devId.slice(0, 8) + '… ' + cur + '–' + actualEnd + ')');
      cur = actualEnd + 1;
      if (isLast) break;
    }
  }

  async function onLogsBatch(msg) {
    let stored = 0;
    let actualMaxSeq = 0;
    if (msg.logs && msg.logs.length > 0) {
      stored = await insertRemoteQsos(msg.logs, msg.log_meta);
      // Track the highest source_seq actually stored (may be less than msg.to_seq if gaps)
      msg.logs.forEach(q => {
        if (q.source_seq > actualMaxSeq) actualMaxSeq = q.source_seq;
      });
    }
    stats.received += stored; stats.batches++; updateStats();
    sendMsg({ type: 'ack_batch', batch_id: msg.batch_id, status: 'ok', stored_count: stored });
    if (msg.is_last) {
      // Update sync_state only to the seq we actually received, not msg.to_seq.
      // This ensures a partial transfer is correctly re-requested next time.
      if (actualMaxSeq > 0) await updateSyncState(msg.source_device_id, actualMaxSeq);
      log('Received total ' + stats.received + ' QSOs from remote');
      pendingReqIds.delete(msg.request_id);
      checkDone();
    }
  }

  function onAckBatch(msg) { log('ACK stored=' + msg.stored_count); }

  function onSyncDone(msg) {
    log('Remote done: received=' + msg.received_count + ' sent=' + msg.sent_count);
    doneReceived = true;
    // The remote being finished says nothing about this side. It used to set the
    // phase here regardless, so a side still writing thousands of received QSOs
    // showed "Done" the moment the other one ran out of things to ask for.
    checkDone();
  }

  function checkDone() {
    const state = datasyncCompletion({
      helloReceived, doneSent, doneReceived,
      pendingRequests: pendingReqIds.size, outboundSends,
    });
    if (!state.localDone) return;
    if (state.announce) {
      doneSent = true;
      sendMsg({ type: 'sync_done', device_id: deviceId(),
                received_count: stats.received, sent_count: stats.sent, errors: [] });
      log('Nothing left on this side. Received=' + stats.received + ' Sent=' + stats.sent);
      refreshInfo();
      if (!state.finished) log('Waiting for the other side to finish…');
    }
    if (state.finished) {
      setPhase('done');
      log('Sync complete! Received=' + stats.received + ' Sent=' + stats.sent);
      refreshInfo();
    }
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  async function exportDb() {
    const [cdb, sdb] = await Promise.all([openContestDb(), openSyncDb()]);
    const now = new Date();

    const [logs, qso, settings, syncState, devices] = await Promise.all([
      idbGetAll(cdb, 'logs'),
      idbGetAll(cdb, 'qso'),
      idbGetAll(cdb, 'settings'),
      idbGetAll(sdb, 'sync_state'),
      idbGetAll(sdb, 'devices'),
    ]);

    const backup = {
      export_version: 1,
      exported_at:    now.toISOString(),
      device_id:      deviceId(),
      device_label:   deviceLabel(),
      stores: { logs, qso, settings, sync_state: syncState, devices },
    };

    download(fileTs(now) + '-QSO-database.json', JSON.stringify(backup, null, 2), 'application/json');
    log('Exported: ' + qso.length + ' QSOs, ' + logs.length + ' logs');
  }

  // ── Import ───────────────────────────────────────────────────────────────────

  async function importDb(file) {
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch (e) {
      log('Import error: invalid JSON — ' + e.message);
      return;
    }

    if (!backup.stores) {
      log('Import error: unrecognised backup format (missing "stores")');
      return;
    }

    const [cdb, sdb] = await Promise.all([openContestDb(), openSyncDb()]);
    const counts = {};

    // contest DB stores
    for (const [key, storeName] of [['logs','logs'],['qso','qso'],['settings','settings']]) {
      const records = backup.stores[key] || [];
      if (!records.length || !cdb.objectStoreNames.contains(storeName)) continue;
      counts[storeName] = await putAll(cdb, storeName, records);
    }

    // sync DB stores
    for (const [key, storeName] of [['sync_state','sync_state'],['devices','devices']]) {
      const records = backup.stores[key] || [];
      if (!records.length || !sdb.objectStoreNames.contains(storeName)) continue;
      counts[storeName] = await putAll(sdb, storeName, records);
    }

    const summary = Object.entries(counts).map(([k, v]) => k + '=' + v).join(' ');
    log('Import complete: ' + (summary || 'nothing imported'));
    await refreshInfo();
  }

  function putAll(db, storeName, records) {
    return new Promise((resolve, reject) => {
      const t     = db.transaction(storeName, 'readwrite');
      const store = t.objectStore(storeName);
      let n = 0;
      records.forEach(r => { store.put(r); n++; });
      t.oncomplete = () => resolve(n);
      t.onerror    = e  => reject(e.target.error);
    });
  }

  // ── Download helper ──────────────────────────────────────────────────────────

  function download(fname, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────

  function setPhase(p) {
    phase = p;
    const labels = {
      idle: 'Idle', 'creating-offer': 'Creating offer…', 'waiting-answer': 'Waiting for answer',
      connecting: 'Connecting…', connected: 'Connected', syncing: 'Syncing…',
      done: 'Done ✓', failed: 'Failed',
    };
    document.getElementById('stPhase').textContent = labels[p] || p;

    // Update pairing card status message
    const spinner  = document.querySelector('.ds-spinner');
    const offerMsg = document.querySelector('#phaseOffer .ds-phase-status');
    if (p === 'done') {
      if (spinner)  { spinner.style.display = 'none'; }
      if (offerMsg) { offerMsg.textContent = 'Sync complete ✓'; offerMsg.className = 'ds-phase-status ds-status-ok'; }
    } else if (p === 'failed') {
      if (spinner)  { spinner.style.display = 'none'; }
      if (offerMsg) { offerMsg.textContent = 'Sync failed'; offerMsg.className = 'ds-phase-status ds-status-err'; }
    } else if (p === 'connecting' || p === 'syncing') {
      if (offerMsg) { offerMsg.textContent = labels[p]; offerMsg.className = 'ds-phase-status'; }
    }
  }

  function resetStats() {
    stats = { sent: 0, received: 0, batches: 0, errors: 0 };
    updateStats();
  }

  function updateStats() {
    document.getElementById('stSent').textContent     = stats.sent;
    document.getElementById('stReceived').textContent = stats.received;
    document.getElementById('stBatches').textContent  = stats.batches;
    document.getElementById('stErrors').textContent   = stats.errors;
  }

  function log(msg) {
    const el = document.getElementById('syncLog');
    el.textContent += new Date().toISOString().slice(11, 19) + ' ' + msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function showPhase(id) {
    ['phaseIdle','phaseOffer','phaseJoin'].forEach(p =>
      document.getElementById(p).classList.toggle('ds-hidden', p !== id)
    );
  }

  function resetPairing() {
    if (pc) { try { pc.close(); } catch (_) {} pc = null; dc = null; }
    stopPoll();
    showPhase('phaseIdle');
    ['qrAnswerSection', 'scanAnswerWrap', 'scanOfferWrap'].forEach(id => {
      const node = document.getElementById(id);
      if (node) node.classList.add('ds-hidden');
    });
    const eyebrow = document.querySelector('#phaseOffer .eyebrow');
    if (eyebrow) eyebrow.textContent = 'Waiting for the other device…';
    setPhase('idle');
    resetStats();
  }

  async function refreshInfo() {
    const label = deviceLabel();
    document.getElementById('infoDeviceId').textContent    = deviceId().slice(0, 16) + '…';
    document.getElementById('infoDeviceLabel').textContent = label;
    const pairLabel = document.getElementById('pairDeviceLabel');
    if (pairLabel) pairLabel.textContent = label;
    try {
      const cdb       = await openContestDb();
      const numRange  = IDBKeyRange.bound(1, Number.MAX_SAFE_INTEGER);
      const localCnt  = await idbCount(cdb, 'qso', numRange);
      const totalCnt  = await idbCount(cdb, 'qso');
      document.getElementById('infoQsoCount').textContent    = localCnt;
      document.getElementById('infoRemoteCount').textContent = totalCnt - localCnt;
      const estKb = totalCnt * 650;
      document.getElementById('infoEstSize').textContent =
        estKb >= 1048576 ? '~' + (estKb / 1048576).toFixed(1) + ' MB'
                         : '~' + (estKb / 1024).toFixed(0) + ' kB';

      // max local seq
      let maxSeq = 0;
      await new Promise((resolve, reject) => {
        const req = cdb.transaction('qso','readonly').objectStore('qso')
                       .openCursor(numRange, 'prev');
        req.onsuccess = e => { if (e.target.result) maxSeq = e.target.result.key; resolve(); };
        req.onerror   = e => reject(e.target.error);
      });
      document.getElementById('infoLastSeq').textContent = maxSeq || '—';
    } catch (_) {
      ['infoQsoCount','infoRemoteCount','infoLastSeq'].forEach(id =>
        document.getElementById(id).textContent = '?'
      );
    }
    try {
      const sdb  = await openSyncDb();
      const devs = await idbGetAll(sdb, 'devices');
      document.getElementById('infoDeviceCount').textContent = devs.length;
    } catch (_) {
      document.getElementById('infoDeviceCount').textContent = '?';
    }
  }

  // ── Event wiring ─────────────────────────────────────────────────────────────

  function el(id) {
    const e = document.getElementById(id);
    if (!e) console.error('[datasync] missing element:', id);
    return e;
  }

  function wire() {
    function on(id, ev, fn) { const e = el(id); if (e) e.addEventListener(ev, fn); }

    on('btnSync',        'click', syncButton);
    on('btnCancelOffer', 'click', resetPairing);
    on('btnCancelJoin',  'click', resetPairing);
    on('btnAcceptOffer', 'click', async () => { showPhase('phaseOffer'); await acceptOffer(); });
    on('btnRejectOffer', 'click', rejectOffer);

    on('btnExport', 'click', exportDb);

    // ── Field info popup ──────────────────────────────────────────────────────
    const SI_FIELDS = {
      deviceId: ['Device ID',
        'A unique identifier generated for this browser profile on first use. ' +
        'Stored in localStorage; used during sync to track which QSOs were authored here. ' +
        'Shown truncated — the full UUID is used internally.'],
      localQsos: ['Local QSOs',
        'QSOs created on this device. They carry a numeric local sequence ID and are ' +
        'sent to other devices during sync. Does not include QSOs received from remote devices.'],
      lastSeq: ['Last seq',
        'The highest sequence number assigned to a locally created QSO. ' +
        'Acts as a version counter — the remote device requests all QSOs above ' +
        'its last-known sequence number for this device ID.'],
      remoteQsos: ['Remote QSOs',
        'QSOs received from other devices and stored in the local database. ' +
        'Together with Local QSOs they form the complete log.'],
      knownDevices: ['Known devices',
        'Number of distinct device IDs this database has ever received records from or synced with. ' +
        'Each browser profile that has participated in a sync session is counted separately.'],
      estSize: ['Est. DB size',
        'Rough estimate: (total QSOs in DB) × 650 B. Includes both local and received QSOs. ' +
        'Actual size varies with field lengths (±30 %).<br><br>' +
        'To see the exact figure in your browser:<br>' +
        '• <b>Chrome / Edge</b> — DevTools <kbd>F12</kbd> → Application → Storage<br>' +
        '• <b>Firefox</b> — address bar: <code>about:storage</code><br>' +
        '• <b>Safari</b> — Develop → Web Inspector → Storage<br><br>' +
        'This app runs over plain HTTP so the Storage API (requires HTTPS) is ' +
        'unavailable to JavaScript. Desktop browsers rarely evict IndexedDB data ' +
        'unless the disk is critically full — especially for bookmarked pages.'],
      phase: ['Phase',
        'Current state of the sync protocol:<br>' +
        '• <b>Idle</b> — no active session<br>' +
        '• <b>Waiting</b> — this device created an offer and is waiting for the other side to connect<br>' +
        '• <b>Connecting</b> — WebRTC handshake in progress<br>' +
        '• <b>Syncing</b> — QSO data is being exchanged<br>' +
        '• <b>Done</b> — session completed successfully'],
      remoteDevice: ['Remote device',
        'Label and Device ID of the peer currently connected for sync. ' +
        'The label is set by the other device on its own LOGSYNC page under "Create local device name".'],
      sent: ['Sent',
        'Number of QSOs sent to the remote device in the current session. ' +
        'Only records with a sequence number higher than what the remote already has are transmitted.'],
      received: ['Received',
        'Number of QSOs received from the remote device in the current session. ' +
        'Only records missing from the local database are stored.'],
      batches: ['Batches',
        'Number of data batches exchanged in the current session. ' +
        'Each batch holds up to 200 QSOs (max 32 kB); large logs are split across multiple batches.'],
      errors: ['Errors',
        'Number of protocol errors in the current session. ' +
        'A non-zero count may indicate a version mismatch, network interruption, or corrupted message.'],
    };

    const siPopup = document.getElementById('siFieldPopup');
    const siTitle = document.getElementById('siFieldTitle');
    const siBody  = document.getElementById('siFieldBody');

    document.querySelectorAll('[data-si]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const key  = btn.dataset.si;
        const info = SI_FIELDS[key];
        if (!info || !siPopup) return;
        siTitle.textContent = info[0];
        siBody.innerHTML    = '<p style="margin:0;line-height:1.55;font-size:13px">' + info[1] + '</p>';
        siPopup.classList.toggle('si-open');
      });
    });
    document.getElementById('siFieldClose').addEventListener('click', e => {
      e.stopPropagation();
      siPopup.classList.remove('si-open');
    });
    document.addEventListener('click', e => {
      if (siPopup && !siPopup.contains(e.target)) siPopup.classList.remove('si-open');
    });

    document.getElementById('importFile').addEventListener('change', async function () {
      if (!this.files[0]) return;
      const file = this.files[0];
      this.value = '';
      const msg = document.getElementById('importMsg');
      msg.textContent = 'Importing…';
      try {
        await importDb(file);
        msg.textContent = 'Done.';
      } catch (e) {
        msg.textContent = 'Error: ' + e.message;
        log('Import error: ' + e.message);
      }
      setTimeout(() => { msg.textContent = ''; }, 3000);
    });

    const importLogFile = el('importLogFile');
    if (importLogFile) importLogFile.addEventListener('change', function () {
      if (!this.files[0]) return;
      const file = this.files[0];
      this.value = '';
      handleImportLogFile(file);
    });
  }

  // ── Radio log import — format detection ──────────────────────────────────────

  function detectLogFormat(text) {
    const t = text.trim();
    if (/<EOH>|<EOR>|<[A-Z0-9_]+:\d+/i.test(t))                            return 'ADIF';
    if (/^START-OF-LOG:/mi.test(t) || /^QSO:/mi.test(t))                   return 'CABRILLO';
    if (/^\[REG1TEST(;\d+)?\]/mi.test(t) || /^\[QSORecords(;\d+)?\]/mi.test(t)) return 'EDI';
    return null;
  }

  // ── ADIF ─────────────────────────────────────────────────────────────────────

  function _adifFields(text) {
    const rec = {};
    const re = /<([A-Z0-9_]+):(\d+)(?::[^>]*)?>([^<]*)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      rec[m[1].toUpperCase()] = m[3].slice(0, Number(m[2]));
    }
    return rec;
  }

  function parseAdif(text) {
    const parts  = text.split(/<EOH>/i);
    const header = parts.length > 1 ? _adifFields(parts[0]) : {};
    const body   = parts.length > 1 ? parts.slice(1).join('') : text;
    const qsos   = [];
    for (const chunk of body.split(/<EOR>/i)) {
      const rec = _adifFields(chunk);
      if (Object.keys(rec).length) qsos.push(rec);
    }
    return {
      format: 'ADIF', qsos,
      prefill: {
        contest: header['CONTEST_ID']        || '',
        call:    header['STATION_CALLSIGN']  || header['OPERATOR'] || '',
        locator: header['MY_GRIDSQUARE']     || '',
      },
    };
  }

  // ── Cabrillo ──────────────────────────────────────────────────────────────────

  function parseCabrillo(text) {
    const header = {};
    const qsos   = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t === 'END-OF-LOG:') continue;
      if (t.toUpperCase().startsWith('QSO:')) {
        const p = t.replace(/^QSO:\s*/i, '').trim().split(/\s+/);
        qsos.push({
          freq: p[0], mode: p[1], date: p[2], time: p[3],
          myCall: p[4], sentRpt: p[5], sentExch: p[6],
          call: p[7], rcvdRpt: p[8], rcvdExch: p.slice(9).join(' '),
        });
      } else {
        const m = t.match(/^([A-Z0-9-]+):\s*(.*)$/i);
        if (m) header[m[1].toUpperCase()] = m[2];
      }
    }
    return {
      format: 'CABRILLO', qsos, header,
      prefill: {
        contest: header['CONTEST']      || '',
        call:    header['CALLSIGN']     || '',
        locator: header['GRID-LOCATOR'] || header['LOCATION'] || '',
      },
    };
  }

  // ── EDI / REG1TEST ────────────────────────────────────────────────────────────

  function parseEdi(text) {
    const sections = {};
    const qsos     = [];
    let cur        = 'ROOT';
    sections[cur]  = {};
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const sec = t.match(/^\[([^;\]]+)(?:;\d+)?\]$/);
      if (sec) { cur = sec[1].toUpperCase(); sections[cur] = sections[cur] || {}; continue; }
      if (cur === 'QSORECORDS') {
        const p = t.split(';');
        qsos.push({ date: p[0], time: p[1], call: p[2],
                    sentRpt: p[3], rcvdRpt: p[4], locator: p[5],
                    sentNr: p[6], rcvdNr: p[7], points: p[8] });
        continue;
      }
      const eq = t.indexOf('=');
      if (eq >= 0) sections[cur][t.slice(0, eq)] = t.slice(eq + 1);
    }
    const stx = sections['STX'] || {};
    return {
      format: 'EDI', qsos, sections,
      prefill: {
        contest: stx['Contest'] || stx['PContest'] || '',
        call:    stx['Callsign'] || stx['Call'] || stx['PCall'] || '',
        locator: stx['Locator'] || stx['PLocator'] || '',
      },
    };
  }

  // ── QSO normalizers ───────────────────────────────────────────────────────────

  function _adifDate(s)  { return s && s.length >= 8 ? s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8) : ''; }
  function _adifTime(s)  { return s && s.length >= 4 ? s.slice(0,2)+':'+s.slice(2,4) : '00:00'; }

  function _ediDate(s) {
    if (!s) return '';
    s = s.trim();
    if (s.length === 8) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
    if (s.length === 6) {
      const century = parseInt(s.slice(0,2), 10) >= 70 ? '19' : '20';
      return century + s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6);
    }
    return '';
  }

  function _ediFreqHz(sections) {
    const stx = sections['STX'] || {};
    const raw = stx['Band'] || stx['PBand'] || stx['TBand'] || '';
    const mhz = parseFloat(raw);
    return isNaN(mhz) ? 0 : Math.round(mhz * 1e6);
  }

  function _ediMode(sections) {
    const stx = sections['STX'] || {};
    return stx['TMode'] || stx['Mode'] || stx['PMode'] || '';
  }

  function _makeQso(logId, nr, fields) {
    const d = fields.dateUtc || '';
    const t = fields.timeUtc || '00:00';
    return Object.assign({
      logId, qsoNumber: nr,
      qsoDateUtc: d, timeOnUtc: t,
      timestampUtc: d ? d + 'T' + t + ':00Z' : new Date().toISOString(),
      call: '', rstSent: '599', rstReceived: '599',
      exchangeReceived: '', frequencyHz: 0, frequencyDisplay: '',
      mode: '', trx: 1, locatorReceived: '',
    }, fields);
  }

  function normalizeAdif(raw, logId, nr) {
    const freqHz = Math.round((parseFloat(raw['FREQ']) || 0) * 1e6);
    return _makeQso(logId, nr, {
      dateUtc:          _adifDate(raw['QSO_DATE']),
      timeUtc:          _adifTime(raw['TIME_ON'] || raw['TIME_OFF'] || ''),
      call:             (raw['CALL'] || '').toUpperCase(),
      rstSent:          raw['RST_SENT'] || '599',
      rstReceived:      raw['RST_RCVD'] || '599',
      exchangeReceived: raw['SRX'] || raw['SRX_STRING'] || raw['STX_STRING'] || '',
      frequencyHz:      freqHz,
      frequencyDisplay: freqHz ? (freqHz / 1e6).toFixed(4) + ' MHz' : (raw['BAND'] || ''),
      mode:             raw['MODE'] || raw['SUBMODE'] || '',
      locatorReceived:  raw['GRIDSQUARE'] || '',
    });
  }

  function normalizeCabrillo(raw, logId, nr) {
    const freqHz = Math.round((parseFloat(raw.freq) || 0) * 1e3);
    const time   = raw.time || '';
    return _makeQso(logId, nr, {
      dateUtc:          raw.date || '',
      timeUtc:          time.length >= 4 ? time.slice(0,2)+':'+time.slice(2,4) : '00:00',
      call:             (raw.call || '').toUpperCase(),
      rstSent:          raw.sentRpt || '599',
      rstReceived:      raw.rcvdRpt || '599',
      exchangeReceived: raw.rcvdExch || '',
      frequencyHz:      freqHz,
      frequencyDisplay: freqHz ? (freqHz / 1e6).toFixed(4) + ' MHz' : '',
      mode:             raw.mode || '',
    });
  }

  function normalizeEdi(raw, logId, nr, freqHz, mode) {
    const time = raw.time || '';
    return _makeQso(logId, nr, {
      dateUtc:          _ediDate(raw.date),
      timeUtc:          time.length >= 4 ? time.slice(0,2)+':'+time.slice(2,4) : '00:00',
      call:             (raw.call || '').toUpperCase(),
      rstSent:          raw.sentRpt || '59',
      rstReceived:      raw.rcvdRpt || '59',
      exchangeReceived: raw.rcvdNr || '',
      frequencyHz:      freqHz,
      frequencyDisplay: freqHz ? (freqHz / 1e6).toFixed(3) + ' MHz' : '',
      mode:             mode,
      locatorReceived:  raw.locator || '',
    });
  }

  // ── Import modal ──────────────────────────────────────────────────────────────

  let _impParsed = null;
  let _impLogEl  = null;

  function _buildImportModal() {
    const div = document.createElement('div');
    div.id        = 'dsImpModal';
    div.className = 'ds-imp-modal ds-hidden';
    div.innerHTML = `
      <div class="ds-imp-box">
        <div class="ds-imp-header">
          <span class="ds-imp-title" id="dsImpTitle">Import radio log</span>
          <button class="ds-imp-close" id="dsImpClose" type="button" title="Cancel">✕</button>
        </div>
        <div class="ds-imp-summary" id="dsImpSummary"></div>
        <form id="dsImpForm" class="ds-imp-form" autocomplete="off">
          <label class="ds-imp-row">
            <span>Contest</span>
            <input id="dsImpContest" maxlength="40" placeholder="CQWW" required>
          </label>
          <label class="ds-imp-row">
            <span>My call</span>
            <input id="dsImpMyCall" maxlength="16" placeholder="OK1ABC" required>
          </label>
          <label class="ds-imp-row">
            <span>Exchange</span>
            <input id="dsImpExch" maxlength="10" placeholder="NR / JO70FD">
          </label>
          <label class="ds-imp-row">
            <span>My locator</span>
            <input id="dsImpLoc" maxlength="6" placeholder="JO70FD">
          </label>
          <label class="ds-imp-row">
            <span>Start QSO#</span>
            <input id="dsImpStartNr" type="number" min="1" value="1">
          </label>
          <div class="ds-imp-actions">
            <button type="button" class="btn-cancel" id="dsImpCancel">Cancel</button>
            <button type="submit" id="dsImpSubmit">Import</button>
          </div>
        </form>
        <pre id="dsImpLog" class="log ds-log ds-hidden"></pre>
      </div>`;
    document.body.appendChild(div);

    div.addEventListener('click', e => { if (e.target === div) _closeImportModal(); });
    document.getElementById('dsImpClose').addEventListener('click', _closeImportModal);
    document.getElementById('dsImpCancel').addEventListener('click', _closeImportModal);
    document.getElementById('dsImpForm').addEventListener('submit', _onImportSubmit);

    ['dsImpContest','dsImpMyCall','dsImpExch','dsImpLoc'].forEach(id => {
      const inp = document.getElementById(id);
      inp.addEventListener('input', () => {
        const pos = inp.selectionStart;
        inp.value = inp.value.toUpperCase();
        inp.setSelectionRange(pos, pos);
      });
    });

    _impLogEl = document.getElementById('dsImpLog');
    return div;
  }

  function _openImportModal(parsed) {
    _impParsed = parsed;
    let modal = document.getElementById('dsImpModal');
    if (!modal) modal = _buildImportModal();

    const { format, qsos, prefill } = parsed;
    const n = qsos.length;
    document.getElementById('dsImpTitle').textContent   = 'Import — ' + format;
    document.getElementById('dsImpSummary').textContent = n + ' QSO' + (n !== 1 ? 's' : '') + ' detected in ' + format + ' file. Fill in log details and confirm.';

    const set = (id, v) => { if (v) document.getElementById(id).value = v.toUpperCase(); };
    set('dsImpContest', prefill.contest);
    set('dsImpMyCall',  prefill.call);
    set('dsImpLoc',     prefill.locator);
    document.getElementById('dsImpStartNr').value = 1;
    document.getElementById('dsImpSubmit').textContent = 'Create log & import ' + n + ' QSO' + (n !== 1 ? 's' : '');
    document.getElementById('dsImpSubmit').disabled = false;

    _impLogEl.classList.add('ds-hidden');
    _impLogEl.textContent = '';
    modal.classList.remove('ds-hidden');
    document.getElementById('dsImpContest').focus();
  }

  function _closeImportModal() {
    const modal = document.getElementById('dsImpModal');
    if (modal) modal.classList.add('ds-hidden');
    _impParsed = null;
  }

  function _impLog(msg) {
    if (!_impLogEl) return;
    _impLogEl.classList.remove('ds-hidden');
    _impLogEl.textContent += new Date().toISOString().slice(11, 19) + ' ' + msg + '\n';
    _impLogEl.scrollTop = _impLogEl.scrollHeight;
  }

  async function _onImportSubmit(e) {
    e.preventDefault();
    if (!_impParsed) return;

    const contestName     = document.getElementById('dsImpContest').value.trim();
    const stationCall     = document.getElementById('dsImpMyCall').value.trim();
    const defaultExchange = document.getElementById('dsImpExch').value.trim();
    const myLocator       = document.getElementById('dsImpLoc').value.trim();
    const startQsoNumber  = parseInt(document.getElementById('dsImpStartNr').value, 10) || 1;
    if (!contestName || !stationCall) return;

    const submitBtn = document.getElementById('dsImpSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Importing…';

    try {
      const logObj = await LogDB.createLog({ contestName, stationCall, defaultExchange, myLocator, startQsoNumber });
      _impLog('Log created: ' + logObj.id);

      const { format, qsos, sections } = _impParsed;
      const ediFreqHz = format === 'EDI' ? _ediFreqHz(sections || {}) : 0;
      const ediMode   = format === 'EDI' ? _ediMode(sections || {})   : '';

      let nr = startQsoNumber, ok = 0, skip = 0;
      for (const raw of qsos) {
        try {
          let q;
          if      (format === 'ADIF')     q = normalizeAdif(raw, logObj.id, nr);
          else if (format === 'CABRILLO') q = normalizeCabrillo(raw, logObj.id, nr);
          else                            q = normalizeEdi(raw, logObj.id, nr, ediFreqHz, ediMode);
          if (!q.call) { skip++; continue; }
          await LogDB.addQso(q);
          nr++; ok++;
        } catch (_) { skip++; }
      }

      logObj.nextQsoNumber = nr;
      await LogDB.updateLog(logObj);

      _impLog('Done. Imported ' + ok + ' QSOs' + (skip ? ', skipped ' + skip + ' (no call).' : '.'));
      submitBtn.textContent = 'Done ✓';
      log('Import: ' + ok + ' QSOs → "' + contestName + '" (' + logObj.id + ')');
      await refreshInfo();
    } catch (err) {
      _impLog('Error: ' + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Retry';
    }
  }

  async function handleImportLogFile(file) {
    const msg = document.getElementById('importLogMsg');
    msg.textContent = 'Reading…';
    try {
      const text   = await file.text();
      const format = detectLogFormat(text);
      if (!format) {
        msg.textContent = 'Unknown format. Supported: ADIF, Cabrillo, EDI.';
        setTimeout(() => { msg.textContent = ''; }, 4000);
        return;
      }
      msg.textContent = '';
      const parsed =
        format === 'ADIF'      ? parseAdif(text)      :
        format === 'CABRILLO'  ? parseCabrillo(text)  :
                                 parseEdi(text);
      _openImportModal(parsed);
    } catch (err) {
      msg.textContent = 'Error: ' + err.message;
      setTimeout(() => { msg.textContent = ''; }, 4000);
    }
  }

  // ── Storage persistence ───────────────────────────────────────────────────────

  async function checkStoragePersistence() {
    if (!navigator.storage || !navigator.storage.persisted) return;
    let persisted = await navigator.storage.persisted().catch(() => false);
    if (!persisted && navigator.storage.persist) {
      // Firefox: auto-grants (true, no dialog) when page is bookmarked.
      // Returns false when not bookmarked and user dismissed the permission prompt.
      persisted = await navigator.storage.persist().catch(() => false);
    }
    const warn = document.getElementById('storageWarn');
    if (!warn) return;
    if (persisted) {
      warn.classList.add('ds-hidden');
      log('Storage: persistent (browser will not evict the database).');
      return;
    }
    warn.classList.remove('ds-hidden');
    log('WARNING: storage not persistent — Firefox may clear the database on close.');

    document.getElementById('storageWarnClose').addEventListener('click',
      () => warn.classList.add('ds-hidden'), { once: true });

    const popup  = document.getElementById('storageFixPopup');
    const origin = window.location.origin;
    const originEl = document.getElementById('fixPopupOrigin');
    if (originEl) originEl.textContent = origin;

    function openFixPopup() { popup.classList.remove('ds-hidden'); }
    function closeFixPopup() { popup.classList.add('ds-hidden'); }

    document.getElementById('storageWarnFix').addEventListener('click', openFixPopup);
    document.getElementById('storageFixClose').addEventListener('click', closeFixPopup);
    document.getElementById('storageFixOk').addEventListener('click', closeFixPopup);
    popup.addEventListener('click', e => { if (e.target === popup) closeFixPopup(); });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    try {
      wire();
      setPhase('idle');
      updateStats();
      await refreshInfo();
      await checkStoragePersistence();
      log('Ready. Device: ' + deviceLabel() + ' (' + deviceId().slice(0, 8) + '…)');
    } catch (e) {
      log('INIT ERROR: ' + e.name + ': ' + e.message);
    }
  }

  // Guarded so the completion rule above can be required and checked in plain
  // Node. Nothing else in here runs at load time.
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

}());
