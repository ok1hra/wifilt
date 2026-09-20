'use strict';
/**
 * log-db.js — IndexedDB wrapper for contest log storage
 * Database: contestLogDb  v1
 * Stores: logs, qso, settings, runtimeState
 */

(function (global) {

  const DB_NAME    = 'contestLogDb';
  const DB_VERSION = 1;

  let _db = null;

  // ── Open / upgrade ─────────────────────────────────────────────────────────

  function openDb() {
    return new Promise((resolve, reject) => {
      if (_db) { resolve(_db); return; }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = e => {
        const db = e.target.result;

        // logs store
        if (!db.objectStoreNames.contains('logs')) {
          const ls = db.createObjectStore('logs', { keyPath: 'id' });
          ls.createIndex('active', 'active', { unique: false });
        }

        // qso store
        if (!db.objectStoreNames.contains('qso')) {
          const qs = db.createObjectStore('qso', { keyPath: 'id', autoIncrement: true });
          qs.createIndex('logId',           'logId',          { unique: false });
          qs.createIndex('logId_qsoNumber', ['logId','qsoNumber'], { unique: false });
          qs.createIndex('logId_call',      ['logId','call'],  { unique: false });
          qs.createIndex('logId_timestamp', ['logId','timestampUtc'], { unique: false });
          qs.createIndex('logId_freq',      ['logId','frequencyHz'],  { unique: false });
          qs.createIndex('logId_mode',      ['logId','mode'],  { unique: false });
        }

        // settings store  (key/value pairs)
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        // runtimeState store
        if (!db.objectStoreNames.contains('runtimeState')) {
          db.createObjectStore('runtimeState', { keyPath: 'key' });
        }
      };

      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── Generic helpers ─────────────────────────────────────────────────────────

  function tx(storeName, mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t    = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      const req  = fn(store);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror    = e  => reject(e.target.error);
      t.onabort    = e  => reject(new Error('Transaction aborted'));
    }));
  }

  function getAll(storeName, indexName, query) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t     = db.transaction(storeName, 'readonly');
      const store = t.objectStore(storeName);
      const src   = indexName ? store.index(indexName) : store;
      const req   = query !== undefined ? src.getAll(query) : src.getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  // ── Logs ───────────────────────────────────────────────────────────────────

  function createLog(opts) {
    const now = new Date().toISOString();
    const id  = opts.id || (now.slice(0,10) + '-' + opts.contestName.toUpperCase().replace(/[^A-Z0-9]/g,''));
    const log = {
      id,
      contestName:     opts.contestName,
      stationCall:     opts.stationCall,
      defaultExchange: opts.defaultExchange,
      myLocator:       opts.myLocator,
      createdAtUtc:    now,
      updatedAtUtc:    now,
      // Absent means on, matching how every reader tests it (cwAbbrev !== false).
      // This used to be dropped on the floor here, which made the dialog's own
      // checkbox a no-op for every log ever created.
      cwAbbrev:        opts.cwAbbrev !== false,
      nextQsoNumber:   opts.startQsoNumber || 1,
      active:          true,
    };
    return tx('logs', 'readwrite', s => s.put(log)).then(() => log);
  }

  function getLogs() {
    return getAll('logs');
  }

  function getLog(id) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction('logs','readonly').objectStore('logs').get(id);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  function updateLog(log) {
    log.updatedAtUtc = new Date().toISOString();
    return tx('logs', 'readwrite', s => s.put(log));
  }

  function deleteLog(id) {
    return tx('logs', 'readwrite', s => s.delete(id));
  }

  // ── QSOs ───────────────────────────────────────────────────────────────────

  function addQso(qso) {
    qso.createdAtUtc = qso.createdAtUtc || new Date().toISOString();
    return tx('qso', 'readwrite', s => s.add(qso)).then(newId => {
      qso.id = newId;
      // Patched rather than invalidated: this is the hot path -- every logged
      // QSO comes through here -- and a search armed in S&P has to see the
      // station that was just worked without paying for a whole rebuild.
      if (_callIndex && !qso.deleted && qso.call) _callIndex.push(_indexRecord(qso));
      return qso;
    });
  }

  function getQso(id) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction('qso','readonly').objectStore('qso').get(id);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  function updateQso(qso) {
    qso.updatedAtUtc = new Date().toISOString();
    // Rebuilt, not patched: an edit can change the call, move the frequency to
    // another band or set the deleted flag, and the QSO may not be in the index
    // at all (it was deleted and is coming back). Edits are rare; the next
    // search pays for one getAll and every later one is free again.
    invalidateCallIndex();
    return tx('qso', 'readwrite', s => s.put(qso));
  }

  function getQsosForLog(logId) {
    return getAll('qso', 'logId', logId);
  }

  function deleteQso(id) {
    invalidateCallIndex();
    return tx('qso', 'readwrite', s => s.delete(id));
  }

  // Exact dupe check, one log, straight off the index. Kept as its own entry
  // point for the JS8 auto-logger (data.js), which dedupes one call per band on
  // a page that has no use for the call index below.
  function findDupes(logId, call) {
    return getAll('qso', 'logId_call', IDBKeyRange.only([logId, call.toUpperCase()]));
  }

  // ── Call index ─────────────────────────────────────────────────────────────
  //
  // QRPLog searches the log on every keystroke while its call search is armed,
  // and the global half of that search reads EVERY log. Against IndexedDB that
  // meant a getAll('qso') per keystroke -- the whole database deserialised to
  // answer "does any call contain DL1". The calls live in a flat array instead,
  // built once and patched in place.
  //
  // Lazy on purpose. This file is loaded by four pages (log, datasync, dxc,
  // data) and only QRPLog ever searches; building the index in openDb() would
  // charge the DXC pop-up for a table it never reads.
  //
  // The records are thin -- {id, logId, call, hz, ts} -- because the one caller
  // that needs whole QSOs (the dupe list, a handful of rows) fetches them by id.
  // A deleted QSO never enters the index at all.
  //
  // Invalidation lives HERE, inside the writers, so a write added later cannot
  // forget it. What it cannot see is a write from ANOTHER document: LOGSYNC
  // pulls remote QSOs and the JS8 page logs its own, each through its own copy
  // of this file in its own tab. That is what invalidateCallIndex() is for --
  // QRPLog calls it when its tab comes back to the front.
  let _callIndex = null;

  // frequencyHz is what every writer stores today, but the text beside it is
  // not one format: QRPLog's own formatter writes "14.074.00" and the ADIF
  // importer writes "14.0740 MHz". Reading the number back out of that text is
  // what the old dupe colouring did, and it understood only the first of the
  // two -- so an imported QSO could never match a band, and never turned red.
  // Take the number when there is one; parse only a record that has none.
  function _hzOf(q) {
    const n = Number(q.frequencyHz);
    if (Number.isFinite(n) && n > 0) return n;
    const s = String(q.frequencyDisplay || '').trim();
    const dotted = s.match(/^(\d+)\.(\d{1,3})\.(\d{1,2})$/);
    if (dotted) return (+dotted[1]) * 1e6 + (+dotted[2]) * 1e3 + (+dotted[3]) * 10;
    const mhz = s.match(/^([\d.]+)\s*MHZ$/i);
    if (mhz) return Math.round(parseFloat(mhz[1]) * 1e6) || 0;
    return 0;
  }

  // Sortable instant for a QSO. timestampUtc is what every writer sets now;
  // the fallback is the same one loadJournalFromDb uses for older rows.
  function _tsOf(q) {
    return q.timestampUtc || ((q.qsoDateUtc || '') + 'T' + (q.timeOnUtc || '') + 'Z');
  }

  function _indexRecord(q) {
    return {
      id:    q.id,
      logId: q.logId,
      call:  String(q.call).toUpperCase(),
      hz:    _hzOf(q),
      ts:    _tsOf(q),
    };
  }

  function _buildCallIndex() {
    return getAll('qso').then(qsos => {
      const idx = [];
      for (let i = 0; i < qsos.length; i++) {
        const q = qsos[i];
        if (q.deleted || !q.call) continue;
        idx.push(_indexRecord(q));
      }
      _callIndex = idx;
      return idx;
    });
  }

  function invalidateCallIndex() { _callIndex = null; }

  // The ONE place the two result sets are separated.
  //
  // They are disjoint by definition -- exact is call === fragment, partial is
  // "contains it and is longer" -- and splitting them anywhere else is how the
  // old code ended up with a global partial search that returned the exact
  // matches too and left each caller to filter them back out.
  //
  // The two halves carry their own scope because QRPLog gives them their own
  // switches: a duplicate that scores is in the log being worked, while a
  // partial call is a memory aid worth asking the whole history about.
  function matchCalls(fragment, opts) {
    const frag  = String(fragment || '').toUpperCase();
    const o     = opts || {};
    const exact = [], partial = [];
    if (!frag) return Promise.resolve({ exact, partial });
    const p = _callIndex ? Promise.resolve(_callIndex) : _buildCallIndex();
    return p.then(idx => {
      for (let i = 0; i < idx.length; i++) {
        const r = idx[i];
        const own = r.logId === o.logId;
        if (r.call === frag) {
          if (o.exactGlobal || own) exact.push(r);
        } else if (r.call.length > frag.length && r.call.indexOf(frag) !== -1) {
          if (o.partialGlobal || own) partial.push(r);
        }
      }
      return { exact, partial };
    });
  }

  // Build + store a QSO in one shot: DXCC lookup (+ QRB/azimuth from the log's
  // locator and a received grid, falling back to DXCC entity coordinates),
  // serial number from a fresh read of the log, then addQso and bump nextQsoNumber.
  // Shared so both the QRPLog page and the JS8 TX session log the same shape.
  function commitQso(fields) {
    const call = String(fields.call || '').toUpperCase();
    if (!call) return Promise.reject(new Error('Missing callsign'));
    return getLog(fields.logId).then(log => {
      if (!log) throw new Error('No active log');
      const now     = new Date();
      const dateUtc = now.toISOString().slice(0, 10);
      const timeUtc = String(now.getUTCHours()).padStart(2, '0') + ':' +
                      String(now.getUTCMinutes()).padStart(2, '0');
      const grid    = String(fields.grid || '').toUpperCase();

      let dxcc = global.DXCC ? global.DXCC.lookupDxcc(call) : null;
      if (dxcc && global.DXCC) {
        const myLoc = log.myLocator || '';
        const myPos = myLoc ? global.DXCC.locatorToLatLon(myLoc) : null;
        const dxPos = (grid && global.DXCC.locatorToLatLon(grid)) ||
                      { lat: dxcc.latitude, lon: dxcc.longitude };
        if (myPos && dxPos) {
          const { qrbKm, azimuthDeg } = global.DXCC.calculateQrbAzimuth(
            myPos.lat, myPos.lon, dxPos.lat, dxPos.lon);
          dxcc.qrbKm      = qrbKm;
          dxcc.azimuthDeg = azimuthDeg;
        }
      }

      const qso = {
        logId:            log.id,
        qsoNumber:        log.nextQsoNumber,
        qsoDateUtc:       dateUtc,
        timeOnUtc:        timeUtc,
        timestampUtc:     now.toISOString(),
        call,
        rstSent:          fields.rstSent || '',
        rstReceived:      fields.rstReceived || '',
        exchangeReceived: fields.exchangeReceived || '',
        frequencyHz:      fields.frequencyHz || 0,
        frequencyDisplay: fields.frequencyDisplay || '',
        mode:             fields.mode || '',
        trx:              fields.trx || '',
        dxcc:             dxcc || null,
        locatorReceived:  grid || '',
        bandClass:        fields.bandClass || 'HF',
        note:             fields.note || '',
        source:           fields.source || '',
      };

      return addQso(qso).then(saved => {
        log.nextQsoNumber = (log.nextQsoNumber || 1) + 1;
        return updateLog(log).then(() => saved);
      });
    });
  }

  // ── Settings (key/value) ───────────────────────────────────────────────────

  function getSetting(key, defaultVal) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction('settings','readonly').objectStore('settings').get(key);
      req.onsuccess = e => resolve(e.target.result ? e.target.result.value : defaultVal);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  function setSetting(key, value) {
    return tx('settings', 'readwrite', s => s.put({ key, value }));
  }

  function getAllSettings() {
    return getAll('settings').then(rows => {
      const obj = {};
      rows.forEach(r => { obj[r.key] = r.value; });
      return obj;
    });
  }

  // ── Runtime state ──────────────────────────────────────────────────────────

  function getRuntimeState(key, defaultVal) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction('runtimeState','readonly').objectStore('runtimeState').get(key);
      req.onsuccess = e => resolve(e.target.result ? e.target.result.value : defaultVal);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  function setRuntimeState(key, value) {
    return tx('runtimeState', 'readwrite', s => s.put({ key, value }));
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  global.LogDB = {
    openDb,
    // logs
    createLog, getLogs, getLog, updateLog, deleteLog,
    // qso
    addQso, getQso, updateQso, getQsosForLog, deleteQso, findDupes, matchCalls, invalidateCallIndex, commitQso,
    // settings
    getSetting, setSetting, getAllSettings,
    // runtime state
    getRuntimeState, setRuntimeState,
  };

}(window));
