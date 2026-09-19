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
    return tx('qso', 'readwrite', s => s.put(qso));
  }

  function getQsosForLog(logId) {
    return getAll('qso', 'logId', logId);
  }

  function deleteQso(id) {
    return tx('qso', 'readwrite', s => s.delete(id));
  }

  // Exact dupe check
  function findDupes(logId, call) {
    return getAll('qso', 'logId_call', IDBKeyRange.only([logId, call.toUpperCase()]));
  }

  // Partial check: all non-deleted QSOs whose call contains fragment (but isn't an exact match)
  function findPartial(logId, fragment) {
    const frag = fragment.toUpperCase();
    return getQsosForLog(logId).then(qsos =>
      qsos.filter(q => !q.deleted && q.call && q.call.toUpperCase().includes(frag) && q.call.toUpperCase() !== frag)
    );
  }

  // Global search across all logs
  function findDupesGlobal(call) {
    return getAll('qso').then(qsos =>
      qsos.filter(q => !q.deleted && q.call && q.call.toUpperCase() === call.toUpperCase())
    );
  }

  function findPartialGlobal(fragment) {
    const frag = fragment.toUpperCase();
    return getAll('qso').then(qsos =>
      qsos.filter(q => !q.deleted && q.call && q.call.toUpperCase().includes(frag))
    );
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
    addQso, getQso, updateQso, getQsosForLog, deleteQso, findDupes, findPartial, findDupesGlobal, findPartialGlobal, commitQso,
    // settings
    getSetting, setSetting, getAllSettings,
    // runtime state
    getRuntimeState, setRuntimeState,
  };

}(window));
