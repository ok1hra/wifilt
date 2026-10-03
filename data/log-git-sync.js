'use strict';
/**
 * log-git-sync.js — GIT LOG SYNC: the contest log, merged with one file in git
 *
 * The log lives only in this browser's IndexedDB. This keeps a copy of it as
 * one JSON file in a GitHub repository that every station's browsers sync to,
 * so the log survives the browser and other devices can see what this one
 * logged. It replaced the BACKUP button on QRPlog; the plain file backup stays
 * on the LOGSYNC page. Grilled 2026-10-02; the decisions, in short:
 *
 *   - ONE click syncs both ways: download the file, merge, write what is new
 *     into this browser, push the merged file back. No questions asked unless
 *     there is one to ask -- and then it is asked in the palette (the ⚙ half of
 *     the button), never in a dialog;
 *   - one file for every device, a union of all of them. A QSO is identified the
 *     way LOGSYNC identifies it, "<device id>:<local id>", so a QSO that went
 *     through LOGSYNC and through git is still one QSO;
 *   - the same QSO on both sides: the newer change wins (updatedAtUtc, else
 *     createdAtUtc), this browser on a tie. Edits and deletions (deleted:true)
 *     travel like any other change;
 *   - a deleted LOG leaves a tombstone (log-db.js, deleteLog) that travels in
 *     the file, or the union would bring the log back forever. Applying one
 *     here deletes a log the operator can see, so that, and only that, asks
 *     first -- after downloading a JSON backup of this browser's database;
 *   - a log's `active` flag is this browser's business and never leaves it;
 *     its nextQsoNumber is the larger of the two, never rolled back;
 *   - the repository, branch, file and token live on the interface
 *     (/git-backup.json), shared by every browser pointed at it.
 *
 * The file is one record per line with sorted keys, so a new QSO is a one-line
 * diff in git, and it still has the backup file's `stores` shape: LOGSYNC's
 * Import reads it as it is.
 *
 * The merge itself is pure and has no DOM: tools/log-git-merge-test.js runs it
 * in node. Everything below `if (!global.document)` is the browser half.
 */
(function (global) {

  // ── the merge (pure) ────────────────────────────────────────────────────────

  var FORMAT = 'wifilt-git-1';

  function stamp(r) { return (r && (r.updatedAtUtc || r.createdAtUtc)) || ''; }

  // JSON with sorted keys. Two browsers holding the same record in a different
  // key order must write the same line, or every sync would rewrite the file.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
        .map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  function byKey(list, key) {
    var m = {};
    (list || []).forEach(function (r) { if (r && r[key] != null) m[String(r[key])] = r; });
    return m;
  }

  function unionKeys(a, b) {
    var seen = {}, out = [];
    Object.keys(a).concat(Object.keys(b)).forEach(function (k) {
      if (!seen[k]) { seen[k] = true; out.push(k); }
    });
    return out;
  }

  function copy(r) { return JSON.parse(JSON.stringify(r)); }

  function normalizeFile(f) {
    var s = (f && f.stores) || {};
    return {
      stores: {
        logs:    Array.isArray(s.logs)    ? s.logs    : [],
        qso:     Array.isArray(s.qso)     ? s.qso     : [],
        devices: Array.isArray(s.devices) ? s.devices : [],
      },
      deleted_logs: Array.isArray(f && f.deleted_logs) ? f.deleted_logs : [],
      device_id: (f && f.device_id) || null,
    };
  }

  // A QSO's identity is LOGSYNC's: the device that logged it and its number
  // there. NOT its `id` -- one QSO can sit in two browsers under two ids: a
  // file import (LOGSYNC -> Import) keeps the file's own ("import:LOG:N"),
  // LOGSYNC's pairing rewrites it to "<device>:<seq>" (datasync.js
  // insertRemoteQsos). Matching on `id` turned every imported QSO into two
  // after one sync (2026-10-03: 16 025 doubled), so `id` is only the fallback
  // for a record that carries no source at all.
  function ident(q) {
    return (q.source_device_id != null && q.source_seq != null)
      ? q.source_device_id + ':' + q.source_seq : String(q.id);
  }

  // A QSO in the file's (LOGSYNC's transport) form. This browser's own QSOs
  // carry a plain number as id; everyone else's already arrived as
  // "<device>:<seq>" -- datasync.js getLocalQsosRange() and insertRemoteQsos().
  //
  // __localKey remembers where the record sits in THIS browser's IndexedDB, so
  // a copy can be deleted under its own key; it never reaches the file.
  function qsoToTransport(q, devId) {
    var r = copy(q);
    r.__localKey = q.id;
    if (typeof q.id === 'number') {
      r.id = devId + ':' + q.id;
      r.source_device_id = devId;
      r.source_seq = q.id;
    }
    return r;
  }

  // ...and back. A QSO this browser once logged returns under its own number,
  // so LOGSYNC's sequence vector reads it exactly as it did before.
  function qsoFromTransport(q, devId) {
    var r = copy(q);
    if (q.source_device_id === devId && typeof q.source_seq === 'number') {
      delete r.source_device_id;
      delete r.source_seq;
      r.id = q.source_seq;
    }
    return r;
  }

  function logToFile(l) {
    var r = copy(l);
    delete r.active;
    return r;
  }

  // backup = log.js buildBackup(); tombstones = LogDB.getLogTombstones()
  function snapshotToFile(backup, devId, tombstones) {
    var s = (backup && backup.stores) || {};
    return {
      stores: {
        logs:    (s.logs || []).map(logToFile),
        qso:     (s.qso || []).map(function (q) { return qsoToTransport(q, devId); }),
        devices: (s.devices || []).map(copy),
      },
      deleted_logs: (tombstones || []).map(copy),
      device_id: devId,
    };
  }

  function seqOf(q) { return typeof q.source_seq === 'number' ? q.source_seq : 0; }

  function sortQso(list) {
    return list.sort(function (a, b) {
      var da = String(a.source_device_id || ''), db = String(b.source_device_id || '');
      if (da !== db) return da < db ? -1 : 1;
      if (seqOf(a) !== seqOf(b)) return seqOf(a) - seqOf(b);
      var ia = String(a.id), ib = String(b.id);
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
  }

  function sortBy(list, key) {
    return list.sort(function (a, b) {
      var x = String(a[key]), y = String(b[key]);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  // The newer of two versions; `a` (this browser) on a tie or when b is absent.
  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    return stamp(b) > stamp(a) ? b : a;
  }

  /**
   * local, remote: files in the transport form (snapshotToFile / the parsed
   * file from git; remote may be null when the file does not exist yet).
   *
   * Returns {merged, localChanges, remoteChanged, outCount}:
   *   merged        the file to push
   *   localChanges  what to write into this browser: qsoAdd / qsoUpdate /
   *                 qsoDelete (transport form), logAdd / logUpdate, logDelete
   *                 ({id, contestName, qsoCount}), devices, tombstones,
   *                 collisions (ids two different QSOs claim -- see below)
   *   remoteChanged whether the file in git has to change at all
   *   outCount      QSOs the push adds to or changes in the file
   */
  function mergeBackups(local, remote) {
    var L = normalizeFile(local), R = normalizeFile(remote);

    // Tombstones: union, the later deletion of the same id winning.
    var tomb = {};
    L.deleted_logs.concat(R.deleted_logs).forEach(function (t) {
      if (!t || !t.id || !t.deletedAtUtc) return;
      if (!tomb[t.id] || t.deletedAtUtc > tomb[t.id].deletedAtUtc)
        tomb[t.id] = { id: t.id, deletedAtUtc: t.deletedAtUtc };
    });
    // Only what existed when the log was deleted dies with it. Log ids are
    // "date-CONTEST", so a log created again under the same name the same day
    // has the dead one's id -- and everything in it is younger than the stone.
    function dead(logId, createdAt) {
      var t = tomb[logId];
      return !!t && String(createdAt || '') <= t.deletedAtUtc;
    }

    var ch = { qsoAdd: [], qsoUpdate: [], qsoDelete: [], logAdd: [], logUpdate: [],
               logDelete: [], devices: [], tombstones: [], collisions: [] };

    // ── logs
    var Ll = byKey(L.stores.logs, 'id'), Rl = byKey(R.stores.logs, 'id');
    var logsOut = [], logDeleteIds = {};
    unionKeys(Ll, Rl).forEach(function (id) {
      var l = Ll[id], r = Rl[id];
      var lDead = !!l && dead(id, l.createdAtUtc);
      var rDead = !!r && dead(id, r.createdAtUtc);
      if (lDead) { logDeleteIds[id] = true; ch.logDelete.push({ id: id, contestName: l.contestName || id, qsoCount: 0 }); }
      var pick = newer(lDead ? null : l, rDead ? null : r);
      if (!pick) return;
      var out = logToFile(pick);
      var n = Math.max((l && !lDead && l.nextQsoNumber) || 0, (r && !rDead && r.nextQsoNumber) || 0);
      if (n) out.nextQsoNumber = n;
      logsOut.push(out);
      if (!l || lDead) ch.logAdd.push(out);
      else if (canon(out) !== canon(logToFile(l))) ch.logUpdate.push(out);
    });

    // ── QSOs
    var me = L.device_id;
    // Where a QSO belongs in this browser: its own under their number, every
    // other one under "<device>:<seq>".
    function targetKey(q) {
      return (me && q.source_device_id === me && typeof q.source_seq === 'number') ? q.source_seq : ident(q);
    }
    // The file's form: the identity as the id, nothing of this browser's.
    function clean(q) {
      var r = copy(q);
      delete r.__localKey;
      r.id = ident(q);
      return r;
    }
    var qsoOut = [], outCount = 0;
    // One side holding the same QSO twice -- what the id-matching syncs left
    // in browsers and in git. Keep one, the newer; on a tie the copy already
    // under its proper key. Two DIFFERENT QSOs under one identity (other
    // createdAtUtc) are a collision instead, never silently merged.
    function collapse(list, proper, isLocal) {
      var by = {};
      list.forEach(function (q) {
        var k = ident(q), have = by[k];
        if (!have) { by[k] = q; return; }
        if (String(q.createdAtUtc || '') !== String(have.createdAtUtc || '')) {
          ch.collisions.push(k);
          if (!isLocal) qsoOut.push(clean(q));
          return;
        }
        var keepNew = stamp(q) > stamp(have) || (stamp(q) === stamp(have) && proper(q) && !proper(have));
        var drop = keepNew ? have : q;
        if (keepNew) by[k] = q;
        if (isLocal) { ch.qsoDelete.push(drop); ch.duplicates++; }
      });
      return by;
    }
    ch.duplicates = 0;
    var Lq = collapse(L.stores.qso, function (q) { return q.__localKey === targetKey(q); }, true);
    var Rq = collapse(R.stores.qso, function (q) { return q.id === ident(q); }, false);
    unionKeys(Lq, Rq).forEach(function (id) {
      var l = Lq[id], r = Rq[id];
      // Two different QSOs under one identity: this browser's database was
      // emptied while its device id (localStorage) survived, so it is handing
      // out numbers it already used. Picking either would silently overwrite
      // the other. Report it and keep this browser's in the file untouched.
      if (l && r && String(l.createdAtUtc || '') !== String(r.createdAtUtc || '')) {
        ch.collisions.push(id);
        qsoOut.push(clean(r));
        return;
      }
      var lDead = !!l && dead(l.logId, l.createdAtUtc);
      var rDead = !!r && dead(r.logId, r.createdAtUtc);
      if (lDead) {
        ch.qsoDelete.push(l);
        ch.logDelete.forEach(function (d) { if (d.id === l.logId) d.qsoCount++; });
      }
      var pick = newer(lDead ? null : l, rDead ? null : r);
      if (!pick) return;
      var out = clean(pick);
      qsoOut.push(out);
      if (!r || rDead || canon(out) !== canon(clean(r))) outCount++;
      if (!l || lDead) ch.qsoAdd.push(out);
      else if (pick === r && canon(out) !== canon(clean(l))) {
        ch.qsoUpdate.push(out);
        // The newer copy goes in under its proper key; the old one, if it sat
        // elsewhere, must go, or the update itself makes a second copy.
        if (l.__localKey !== undefined && l.__localKey !== targetKey(out)) ch.qsoDelete.push(l);
      }
    });

    // ── devices (LOGSYNC's names for the devices behind the ids)
    var Ld = byKey(L.stores.devices, 'device_id'), Rd = byKey(R.stores.devices, 'device_id');
    var devOut = [];
    unionKeys(Ld, Rd).forEach(function (id) {
      var l = Ld[id], r = Rd[id];
      var pick = (!l || (r && String(r.last_seen_at || '') > String(l.last_seen_at || ''))) ? r : l;
      devOut.push(pick);
      if (pick !== l && (!l || canon(pick) !== canon(l))) ch.devices.push(pick);
    });

    // ── tombstones this browser does not have yet
    var Lt = byKey(L.deleted_logs, 'id');
    var tombOut = sortBy(Object.keys(tomb).map(function (k) { return tomb[k]; }), 'id');
    tombOut.forEach(function (t) {
      if (!Lt[t.id] || Lt[t.id].deletedAtUtc !== t.deletedAtUtc) ch.tombstones.push(t);
    });

    var merged = {
      export_version: 1,
      format: FORMAT,
      stores: {
        logs:    sortBy(logsOut, 'id'),
        qso:     sortQso(qsoOut),
        devices: sortBy(devOut, 'device_id'),
      },
      deleted_logs: tombOut,
    };
    var remoteChanged = !remote || fileBody(merged) !== fileBody(R);
    return { merged: merged, localChanges: ch, remoteChanged: remoteChanged, outCount: outCount };
  }

  // What "the file changed" means: its content, never its exported_at.
  function fileBody(f) {
    var s = f.stores;
    return canon({ logs: sortBy(s.logs.slice(), 'id'), qso: sortQso(s.qso.slice()),
                   devices: sortBy(s.devices.slice(), 'device_id'),
                   deleted_logs: sortBy(f.deleted_logs.slice(), 'id') });
  }

  // One record per line: a new QSO is one added line in `git diff`.
  function serializeFile(merged, exportedAt) {
    function arr(rows, indent) {
      if (!rows.length) return '[]';
      return '[\n' + rows.map(function (r) { return indent + '  ' + canon(r); }).join(',\n') + '\n' + indent + ']';
    }
    var s = merged.stores;
    return '{\n' +
      '  "export_version": 1,\n' +
      '  "format": ' + JSON.stringify(FORMAT) + ',\n' +
      '  "exported_at": ' + JSON.stringify(exportedAt) + ',\n' +
      '  "stores": {\n' +
      '    "logs": '    + arr(s.logs, '    ') + ',\n' +
      '    "qso": '     + arr(s.qso, '    ') + ',\n' +
      '    "devices": ' + arr(s.devices, '    ') + '\n' +
      '  },\n' +
      '  "deleted_logs": ' + arr(merged.deleted_logs, '  ') + '\n' +
      '}\n';
  }

  var core = {
    FORMAT: FORMAT, canon: canon, mergeBackups: mergeBackups, serializeFile: serializeFile,
    snapshotToFile: snapshotToFile, qsoToTransport: qsoToTransport, qsoFromTransport: qsoFromTransport,
    normalizeFile: normalizeFile,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (!global.document) { global.LogGitSyncCore = core; return; }

  // ── the browser half ────────────────────────────────────────────────────────

  var API = 'https://api.github.com';     // replaced by the smoke harness only
  var CFG_URL = '/git-backup.json';
  var GUIDE_URL = 'https://github.com/ok1hra/wifilt/blob/main/SOFTWARE.md#git-log-sync';
  var STORE_KEY = 'wifilt-git-sync-panel';       // {open, x, y, gap}
  var LAST_KEY  = 'wifilt-git-sync-last';        // ISO time this browser last synced
  var STEPS = ['config', 'ref', 'download', 'merge', 'apply', 'upload', 'commit', 'done'];

  var cfg = null;            // /git-backup.json as last read
  var cfgLoaded = false;
  var busy = false;
  var pending = 0;           // QSO writes since this browser's last sync
  var lastError = null;      // {text, collision}
  var confirmWait = null;    // resolve() of the delete-a-log question
  var btn, btnCfg, el, pos = null, gap = null, placed = null, open = false;

  function isConfigured() {
    return !!(cfg && cfg.repo && cfg.token && /^[^/\s]+\/[^/\s]+$/.test(cfg.repo));
  }

  function branchOf(c) { return (c && c.branch) || 'main'; }
  function pathOf(c)   { return (c && c.path) || 'QSO-database.json'; }

  function deviceId() {
    var id = null;
    try { id = localStorage.getItem('ds_device_id'); } catch (_) {}
    if (!id) {
      id = uuidv4();
      try { localStorage.setItem('ds_device_id', id); } catch (_) {}
    }
    return id;
  }

  // datasync.js's own, so an id made here is indistinguishable from LOGSYNC's.
  function uuidv4() {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.from(b, function (x) { return x.toString(16).padStart(2, '0'); });
    return h[0]+h[1]+h[2]+h[3]+'-'+h[4]+h[5]+'-'+h[6]+h[7]+'-'+h[8]+h[9]+'-'+h[10]+h[11]+h[12]+h[13]+h[14]+h[15];
  }

  function deviceLabel() {
    var l = null;
    try { l = localStorage.getItem('ds_device_label'); } catch (_) {}
    return l || ((global.location && global.location.hostname) || 'browser');
  }

  function lastSyncAt() {
    try { return localStorage.getItem(LAST_KEY) || ''; } catch (_) { return ''; }
  }

  // ── config on the interface ─────────────────────────────────────────────────

  function loadCfg() {
    return fetch(CFG_URL, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return cfg || {}; })
      .then(function (d) {
        var was = isConfigured();
        cfg = (d && typeof d === 'object') ? d : {};
        cfgLoaded = true;
        if (isConfigured() && !was && typeof global.disarmAutoBackup === 'function') global.disarmAutoBackup();
        return cfg;
      });
  }

  function saveCfg(next) {
    var body = JSON.stringify(next);
    return fetch(CFG_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: body, signal: AbortSignal.timeout(5000) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || !d.ok) throw new Error('interface refused the settings (' + (d.error || r.status) + ')');
          var was = isConfigured();
          cfg = next;
          if (isConfigured() && !was && typeof global.disarmAutoBackup === 'function') global.disarmAutoBackup();
          return cfg;
        });
      });
  }

  // ── GitHub ──────────────────────────────────────────────────────────────────

  function ghError(status, body, what) {
    var msg = (body && body.message) || ('HTTP ' + status);
    var text;
    if (status === 401) text = 'GitHub refused the token (401) — it is wrong or expired.';
    else if (status === 403) text = 'GitHub refused access (403): ' + msg + '. The token needs "Contents: Read and write" on this repository.';
    else if (status === 404) text = 'Not found on GitHub (' + what + '): check the repository and branch names, and that the token is allowed to see the repository.';
    else text = 'GitHub: ' + what + ' failed — ' + msg;
    var e = new Error(text);
    e.status = status;
    return e;
  }

  function gh(method, path, body, what, timeoutMs) {
    var opt = {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(timeoutMs || 20000),
    };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(API + path, opt).catch(netError).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { status: r.status, ok: r.ok, body: d };
      });
    }).then(function (res) {
      if (!res.ok && !(what === 'ref' && (res.status === 409 || res.status === 404)) &&
          !(what === 'update ref' && res.status === 422)) {
        throw ghError(res.status, res.body, what);
      }
      return res;
    });
  }

  function netError(e) {
    var t = e && e.name === 'TimeoutError' ? 'GitHub did not answer in time.'
                                           : 'GitHub is not reachable — is this browser on the internet?';
    var err = new Error(t);
    err.network = true;
    throw err;
  }

  function repoPath() { return '/repos/' + cfg.repo; }

  // The file at one commit, read as it streams in so the button can show how
  // far the download is. null = the file does not exist yet.
  function download(ref, onFraction) {
    var url = API + repoPath() + '/contents/' + encodePath(pathOf(cfg)) + '?ref=' + encodeURIComponent(ref);
    return fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(120000),
    }).catch(netError).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) return r.json().catch(function () { return {}; })
        .then(function (d) { throw ghError(r.status, d, 'download'); });
      var total = Number(r.headers.get('Content-Length')) || 0;
      if (!r.body || !r.body.getReader) return r.text();
      var reader = r.body.getReader(), chunks = [], got = 0;
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) return;
          chunks.push(x.value);
          got += x.value.length;
          if (total) onFraction(Math.min(1, got / total));
          return pump();
        });
      }
      return pump().then(function () {
        var all = new Uint8Array(got), o = 0;
        chunks.forEach(function (c) { all.set(c, o); o += c.length; });
        return new TextDecoder().decode(all);
      });
    }).then(function (text) {
      if (text == null) return null;
      try { return JSON.parse(text); }
      catch (e) { throw new Error('The file in git is not valid JSON (' + pathOf(cfg) + '): ' + e.message); }
    });
  }

  function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  function utf8ToBase64(text) {
    var bytes = new TextEncoder().encode(text), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // ── this browser's database ─────────────────────────────────────────────────

  function localSnapshot(devId) {
    return Promise.all([global.buildBackup(), LogDB.getLogTombstones()]).then(function (x) {
      return { at: x[0].exported_at, raw: x[0], file: snapshotToFile(x[0], devId, x[1]) };
    });
  }

  function idbReq(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function (e) { rej(e.target.error); };
    });
  }

  // Everything the merge says belongs in this browser, in ONE transaction:
  // either the whole sync lands here or none of it does.
  function applyLocal(ch, devId, raw) {
    var activeById = {};
    (raw.stores.logs || []).forEach(function (l) { activeById[l.id] = !!l.active; });
    var localQsoKey = function (q) {
      return (q.source_device_id === devId && typeof q.source_seq === 'number') ? q.source_seq : q.id;
    };
    return LogDB.openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(['logs', 'qso'], 'readwrite');
        var ls = t.objectStore('logs'), qs = t.objectStore('qso');
        ch.logDelete.forEach(function (d) { ls.delete(d.id); });
        ch.qsoDelete.forEach(function (q) { qs.delete(q.__localKey !== undefined ? q.__localKey : localQsoKey(q)); });
        ch.logAdd.concat(ch.logUpdate).forEach(function (l) {
          var r = copy(l);
          r.active = !!activeById[l.id];
          ls.put(r);
        });
        ch.qsoAdd.concat(ch.qsoUpdate).forEach(function (q) { qs.put(qsoFromTransport(q, devId)); });
        t.oncomplete = resolve;
        t.onerror = function (e) { reject(e.target.error); };
        t.onabort = function (e) { reject((e.target && e.target.error) || new Error('write aborted')); };
      });
    }).then(function () {
      return ch.tombstones.length ? LogDB.addLogTombstones(ch.tombstones) : null;
    }).then(function () {
      if (!ch.devices.length || typeof global._openSyncDbIfExists !== 'function') return;
      return global._openSyncDbIfExists().then(function (sdb) {
        if (!sdb) return;
        var t = sdb.transaction('devices', 'readwrite');
        ch.devices.forEach(function (d) { t.objectStore('devices').put(d); });
        return new Promise(function (res) { t.oncomplete = res; t.onerror = res; t.onabort = res; })
          .then(function () { sdb.close(); });
      });
    }).then(refreshLogPage);
  }

  // The QRPlog page reads the database through caches -- the call index, the
  // journal, the active log record. All of them are stale now.
  function refreshLogPage() {
    LogDB.invalidateCallIndex();
    if (typeof global.invalidateSearchCaches === 'function') global.invalidateSearchCaches();
    var active = global.LogManager && LogManager.getActiveLog();
    if (!active) return;
    return LogDB.getLog(active.id).then(function (fresh) {
      // restored:true -- this is the same log coming back, not a switch, so the
      // TX serial offset must survive it (log.js activateLog).
      LogManager.activateLog(fresh || null, fresh ? { restored: true } : undefined);
    });
  }

  // ── the sync ────────────────────────────────────────────────────────────────

  function sync() {
    if (busy) return Promise.resolve();
    busy = true;
    lastError = null;
    setProgress('config', 0);
    var result = { inCount: 0, outCount: 0, sha: '', duplicates: 0 };
    return loadCfg().then(function () {
      if (!isConfigured()) {
        busy = false;
        setProgress(null);
        setOpen(true);
        render();
        return;
      }
      return attempt(1, result).then(function () {
        setProgress('done', 0);
        var now = new Date().toISOString();
        return saveCfg(Object.assign({}, cfg, { lastSync: {
          at: now, sha: result.sha, inCount: result.inCount, outCount: result.outCount, by: deviceLabel() } }))
          .catch(function () { /* the sync itself succeeded; the status line is a nicety */ })
          .then(function () {
            showHint('Git sync: +' + result.inCount + ' in, ' + result.outCount + ' out' +
                     (result.duplicates ? ', ' + result.duplicates + ' duplicates removed here' : '') +
                     (result.sha ? ', ' + result.sha.slice(0, 7) : ', no changes'));
          });
      });
    }).catch(function (e) {
      if (e && e.cancelled) { showHint('Git sync cancelled — nothing written, nothing pushed'); return; }
      lastError = { text: (e && e.message) || String(e), collision: !!(e && e.collision) };
      setOpen(true);
      showHint('Git sync failed — see the ⚙ palette');
    }).then(function () {
      busy = false;
      setProgress(null);
      renderButton();
      render();
    });
  }

  function attempt(n, result) {
    var devId = deviceId();
    var head = null, baseTree = null, empty = false, snap, remote, m;
    setProgress('ref', 0);
    return gh('GET', repoPath() + '/git/ref/heads/' + encodeURIComponent(branchOf(cfg)), undefined, 'ref')
      .then(function (res) {
        if (res.status === 409) { empty = true; return; }
        if (res.status === 404) throw ghError(404, res.body, 'branch "' + branchOf(cfg) + '"');
        head = res.body.object.sha;
        return gh('GET', repoPath() + '/git/commits/' + head, undefined, 'commit')
          .then(function (c) { baseTree = c.body.tree.sha; });
      })
      .then(function () {
        setProgress('download', 0);
        return empty ? null : download(head, function (f) { setProgress('download', f); });
      })
      .then(function (r) {
        remote = r;
        setProgress('merge', 0);
        // Taken AFTER the download, so a QSO logged while the file was coming
        // in is part of what gets pushed.
        return localSnapshot(devId);
      })
      .then(function (s) {
        snap = s;
        m = mergeBackups(snap.file, remote);
        if (m.localChanges.collisions.length) {
          var e = new Error(m.localChanges.collisions.length + ' QSO(s) in git share an identity with ' +
            'different QSOs in this browser (e.g. ' + m.localChanges.collisions[0] + '). This happens ' +
            'when the browser\'s log was cleared but its device id survived. Nothing was written or pushed.');
          e.collision = true;
          throw e;
        }
        setProgress('apply', 0);
        return confirmDeletes(m.localChanges.logDelete);
      })
      .then(function () {
        var ch = m.localChanges;
        result.inCount = ch.qsoAdd.length + ch.qsoUpdate.length;
        result.duplicates = ch.duplicates || 0;
        var any = ch.qsoAdd.length || ch.qsoUpdate.length || ch.qsoDelete.length || ch.logAdd.length ||
                  ch.logUpdate.length || ch.logDelete.length || ch.devices.length || ch.tombstones.length;
        return any ? applyLocal(ch, devId, snap.raw) : null;
      })
      .then(function () {
        result.outCount = m.outCount;
        if (!m.remoteChanged) { markSynced(snap.at); return; }
        setProgress('upload', 0);
        var text = serializeFile(m.merged, new Date().toISOString());
        var nQso = m.merged.stores.qso.filter(function (q) { return !q.deleted; }).length;
        var message = 'GIT LOG SYNC: ' + nQso + ' QSO in ' + m.merged.stores.logs.length +
                      ' logs (' + deviceLabel() + ')';
        if (empty) return createFirst(text, message, result).then(function () { markSynced(snap.at); });
        return gh('POST', repoPath() + '/git/blobs', { content: text, encoding: 'utf-8' }, 'upload', 120000)
          .then(function (b) {
            return gh('POST', repoPath() + '/git/trees', { base_tree: baseTree, tree: [
              { path: pathOf(cfg), mode: '100644', type: 'blob', sha: b.body.sha }] }, 'tree');
          })
          .then(function (tr) {
            setProgress('commit', 0);
            return gh('POST', repoPath() + '/git/commits',
                      { message: message, tree: tr.body.sha, parents: [head] }, 'commit');
          })
          .then(function (c) {
            return gh('PATCH', repoPath() + '/git/refs/heads/' + encodeURIComponent(branchOf(cfg)),
                      { sha: c.body.sha, force: false }, 'update ref')
              .then(function (u) {
                if (u.status === 422) {
                  // Another device pushed between our read and our write. Start
                  // over from its commit; what we wrote locally is already in.
                  if (n >= 2) throw new Error('Another device keeps pushing at the same moment — try again.');
                  return attempt(n + 1, result);
                }
                result.sha = c.body.sha;
                markSynced(snap.at);
              });
          });
      });
  }

  // An empty repository has no tree for the Git Data API to build on (it
  // answers 409); the contents API can make the first commit.
  function createFirst(text, message, result) {
    setProgress('commit', 0);
    return gh('PUT', repoPath() + '/contents/' + encodePath(pathOf(cfg)),
              { message: message, content: utf8ToBase64(text), branch: branchOf(cfg) }, 'create file', 120000)
      .then(function (r) { result.sha = (r.body.commit && r.body.commit.sha) || ''; });
  }

  function markSynced(at) {
    try { localStorage.setItem(LAST_KEY, at); } catch (_) {}
    recount();
  }

  // Deleting a log this browser shows is the one thing a sync may not do
  // without asking. The JSON backup goes to Downloads before the answer is
  // acted on, so even a wrong "yes" has a way back.
  function confirmDeletes(list) {
    if (!list.length) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      confirmWait = function (yes) {
        confirmWait = null;
        render();
        if (!yes) { var e = new Error('cancelled'); e.cancelled = true; reject(e); return; }
        global.backupDb().then(resolve, function (err) {
          reject(new Error('Safety backup download failed (' + ((err && err.message) || err) +
                           ') — nothing was deleted.'));
        });
      };
      confirmList = list;
      setOpen(true);
      render();
    });
  }
  var confirmList = [];

  // ── unsynced counter ────────────────────────────────────────────────────────

  // Exact on load and after every sync; in between, each QSO write counts one.
  // An edit of a QSO already counted then counts twice -- this is "changes not
  // in git yet", and a recount over 16 000 QSOs on every write mid-contest is
  // not worth an exact number.
  function recount() {
    var since = lastSyncAt();
    return LogDB.openDb().then(function (db) {
      return idbReq(db.transaction('qso', 'readonly').objectStore('qso').getAll());
    }).then(function (all) {
      pending = all.filter(function (q) { return !since || stamp(q) > since; }).length;
      renderButton();
    }).catch(function () {});
  }

  function onWrite() { pending++; renderButton(); }

  function beforeUnload(e) { e.preventDefault(); e.returnValue = ''; }

  // ── the button ──────────────────────────────────────────────────────────────

  var progress = null;    // {step, frac}

  function setProgress(step, frac) {
    progress = step ? { step: step, frac: frac || 0 } : null;
    renderButton();
    renderProgress();
  }

  function progressFraction() {
    if (!progress) return 0;
    var i = STEPS.indexOf(progress.step);
    return Math.max(0, Math.min(1, (i + progress.frac) / (STEPS.length - 1)));
  }

  function renderButton() {
    if (!btn) return;
    var conf = isConfigured();
    if (busy && progress) {
      btn.textContent = 'SYNC… ' + progress.step;
      btn.style.setProperty('--gs-p', Math.round(progressFraction() * 100) + '%');
    } else {
      btn.textContent = 'GIT LOG SYNC' + (conf && pending > 0 ? ' (' + pending + ')' : '');
      btn.style.removeProperty('--gs-p');
    }
    btn.disabled = busy;
    btn.classList.toggle('gs-busy', busy);
    btn.classList.toggle('gs-error', !busy && !!lastError);
    if (conf) {
      btn.classList.toggle('btn-backup-pending', !busy && pending > 0);
      if (pending > 0) global.addEventListener('beforeunload', beforeUnload);
      else global.removeEventListener('beforeunload', beforeUnload);
    } else {
      global.removeEventListener('beforeunload', beforeUnload);
    }
    btn.title = buttonTitle();
  }

  function buttonTitle() {
    if (!cfgLoaded) return 'GIT LOG SYNC';
    if (!isConfigured()) return 'GIT LOG SYNC is not set up — click to set it up.\n⚙ settings & guide';
    var t = 'Sync this browser\'s log with ' + cfg.repo + ' (both ways).';
    var ls = cfg.lastSync;
    if (ls && ls.at) {
      t += '\nLast sync: ' + ls.at.replace('T', ' ').slice(0, 16) + ' UTC by ' + (ls.by || '?') +
           ' — +' + (ls.inCount || 0) + ' in, ' + (ls.outCount || 0) + ' out' +
           (ls.sha ? ', ' + ls.sha.slice(0, 7) : '');
    }
    if (pending > 0) t += '\n' + pending + ' change(s) here not in git yet.';
    return t + '\n⚙ settings & guide';
  }

  // ── the palette ─────────────────────────────────────────────────────────────

  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && typeof v === 'object') {
        if (typeof v.x === 'number' && typeof v.y === 'number') pos = { x: v.x, y: v.y };
        if (typeof v.gap === 'number') gap = v.gap;
      }
    } catch (_) {}
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ x: pos ? pos.x : null, y: pos ? pos.y : null, gap: gap }));
    } catch (_) {}
  }

  function clamp(p) {
    var w = el ? el.offsetWidth : 280, h = el ? el.offsetHeight : 260;
    return { x: Math.min(Math.max(0, p.x), Math.max(0, global.innerWidth - w)),
             y: Math.min(Math.max(0, p.y), Math.max(0, global.innerHeight - h)) };
  }

  // Like the PA palette: first opened above its own button, and from then on
  // hung from the bottom of the window by the gap the operator left there.
  function place() {
    if (!el) return;
    var h = el.offsetHeight;
    if (!pos) {
      var r = btnCfg.getBoundingClientRect();
      pos = clamp({ x: r.right - el.offsetWidth, y: r.top - h - 8 });
    }
    if (gap === null) gap = global.innerHeight - (pos.y + h);
    pos = clamp({ x: pos.x, y: global.innerHeight - h - gap });
    el.style.left = pos.x + 'px';
    el.style.top  = pos.y + 'px';
    placed = { y: pos.y, h: h };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function build() {
    el = document.createElement('div');
    el.className = 'pa-panel gs-panel';
    el.id = 'gsPanel';
    el.innerHTML =
      '<div class="pa-head" id="gsHead">' +
        '<span class="pa-head-name">GIT LOG SYNC</span>' +
        '<button class="pa-close" id="gsClose" type="button" title="Close">&#10005;</button>' +
      '</div>' +
      '<div class="pa-body">' +
        '<div class="gs-confirm" id="gsConfirm" hidden></div>' +
        '<div class="gs-error-msg" id="gsError" hidden></div>' +
        '<div class="gs-prog" id="gsProg" hidden><div class="gs-prog-bar"><i id="gsProgFill"></i></div>' +
          '<span id="gsProgText"></span></div>' +
        '<div class="gs-status" id="gsStatus"></div>' +
        '<form class="gs-form" id="gsForm" autocomplete="off">' +
          '<label>Repository<input id="gsRepo" placeholder="owner/name" spellcheck="false"></label>' +
          '<label>Branch<input id="gsBranch" placeholder="main" spellcheck="false"></label>' +
          '<label>File<input id="gsPath" placeholder="QSO-database.json" spellcheck="false"></label>' +
          '<label>Token<input id="gsToken" type="password" placeholder="github_pat_…" autocomplete="new-password"></label>' +
          '<div class="gs-tok" id="gsTok"></div>' +
          '<div class="gs-btns">' +
            '<button class="pa-btn" id="gsSave" type="submit">SAVE</button>' +
            '<button class="pa-btn" id="gsSyncNow" type="button">SYNC NOW</button>' +
          '</div>' +
        '</form>' +
        '<div class="gs-unconf" id="gsUnconf"></div>' +
        '<div class="gs-links">' +
          '<a href="' + GUIDE_URL + '" target="_blank" rel="noopener" id="gsGuide">Guide on GitHub</a>' +
          '<a target="_blank" rel="noopener" id="gsViewer" hidden>Open log viewer</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    // The rule from the PA palette: a BUTTON never takes the caret out of Call.
    // The fields here do take focus -- they have to -- and closing the palette
    // hands it back (setOpen).
    el.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) e.preventDefault();
    });
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      // Esc also stops a transmission on this page, and that stays ONE key
      // away (log.js): while something is going out the key goes on to it.
      if (typeof global.txLikelyRunning === 'function' && global.txLikelyRunning()) return;
      e.stopPropagation();
      setOpen(false);
    });
    document.getElementById('gsClose').addEventListener('click', function () { setOpen(false); });
    document.getElementById('gsForm').addEventListener('submit', function (e) { e.preventDefault(); onSave(); });
    document.getElementById('gsSyncNow').addEventListener('click', function () { sync(); });
    el.addEventListener('click', onPanelClick);
    mountDrag(document.getElementById('gsHead'));
    fillForm();
  }

  function mountDrag(handle) {
    var dragging = false, dx = 0, dy = 0;
    handle.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.pa-close')) return;
      dragging = true;
      dx = e.clientX - el.offsetLeft;
      dy = e.clientY - el.offsetTop;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      pos = clamp({ x: e.clientX - dx, y: e.clientY - dy });
      el.style.left = pos.x + 'px';
      el.style.top  = pos.y + 'px';
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      gap = global.innerHeight - (pos.y + el.offsetHeight);
      save();
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function fillForm() {
    if (!el) return;
    var c = cfg || {};
    document.getElementById('gsRepo').value = c.repo || '';
    document.getElementById('gsBranch').value = c.branch || '';
    document.getElementById('gsPath').value = c.path || '';
    document.getElementById('gsToken').value = '';
  }

  function onSave() {
    var repo = document.getElementById('gsRepo').value.trim()
      .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    var token = document.getElementById('gsToken').value.trim();
    var next = Object.assign({}, cfg || {}, {
      repo: repo,
      branch: document.getElementById('gsBranch').value.trim() || 'main',
      path: document.getElementById('gsPath').value.trim().replace(/^\/+/, '') || 'QSO-database.json',
    });
    // An empty token field means "keep the one saved": it is never shown back.
    if (token) next.token = token;
    if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      lastError = { text: 'Repository must be "owner/name", e.g. ok1hra/log.' };
      render();
      return;
    }
    if (repo !== (cfg && cfg.repo)) delete next.lastSync;
    saveCfg(next).then(function () {
      lastError = null;
      fillForm();
      showHint('GIT LOG SYNC settings saved');
      recount();
      renderButton();
      render();
    }, function (e) {
      lastError = { text: e.message };
      render();
    });
  }

  function onPanelClick(e) {
    var b = e.target.closest('[data-gs]');
    if (!b) return;
    var what = b.getAttribute('data-gs');
    if (what === 'yes' && confirmWait) confirmWait(true);
    else if (what === 'no' && confirmWait) confirmWait(false);
    else if (what === 'forget-token') {
      var next = Object.assign({}, cfg);
      delete next.token;
      saveCfg(next).then(function () { render(); renderButton(); }, function (err) {
        lastError = { text: err.message }; render();
      });
    } else if (what === 'new-id') {
      // A fresh identity for this browser: its QSOs go out under new ids, and
      // the old ones in git come back as another device's. Nothing is lost.
      try { localStorage.setItem('ds_device_id', uuidv4()); } catch (_) {}
      lastError = null;
      sync();
    } else if (what === 'download') {
      global.backupDb().then(function (fname) {
        showHint('Backup: ' + fname);
        if (typeof global._onBackupDone === 'function') global._onBackupDone();
      }, function (err) { showHint('Backup error: ' + ((err && err.message) || err)); });
    }
  }

  function renderProgress() {
    if (!el) return;
    var box = document.getElementById('gsProg');
    box.hidden = !progress;
    if (!progress) return;
    document.getElementById('gsProgFill').style.width = Math.round(progressFraction() * 100) + '%';
    document.getElementById('gsProgText').textContent = progress.step;
  }

  function render() {
    if (!el) return;
    var conf = isConfigured();
    var c = cfg || {};

    var cbox = document.getElementById('gsConfirm');
    cbox.hidden = !confirmWait;
    if (confirmWait) {
      cbox.innerHTML =
        '<p>Another device deleted ' + (confirmList.length === 1 ? 'this log' : 'these logs') +
        '. Delete ' + (confirmList.length === 1 ? 'it' : 'them') + ' here too?</p>' +
        '<ul>' + confirmList.map(function (d) {
          return '<li>' + esc(d.contestName) + ' <span class="gs-dim">' + esc(d.id) + ' · ' + d.qsoCount + ' QSO</span></li>';
        }).join('') + '</ul>' +
        '<p class="gs-dim">A JSON backup of this browser is downloaded first.</p>' +
        '<div class="gs-btns"><button class="pa-btn gs-danger" type="button" data-gs="yes">DELETE &amp; SYNC</button>' +
        '<button class="pa-btn" type="button" data-gs="no">CANCEL</button></div>';
    }

    var ebox = document.getElementById('gsError');
    ebox.hidden = !lastError;
    if (lastError) {
      ebox.innerHTML = esc(lastError.text) + (lastError.collision
        ? '<div class="gs-btns"><button class="pa-btn" type="button" data-gs="new-id">NEW DEVICE ID &amp; RETRY</button></div>'
        : '');
    }

    var st = document.getElementById('gsStatus');
    if (!cfgLoaded) st.textContent = 'Reading settings…';
    else if (!conf) st.textContent = 'Not set up yet.';
    else if (c.lastSync && c.lastSync.at) {
      var ls = c.lastSync;
      st.innerHTML = 'Last sync ' + esc(ls.at.replace('T', ' ').slice(0, 16)) + ' UTC by ' + esc(ls.by || '?') +
        ': +' + (ls.inCount || 0) + ' in, ' + (ls.outCount || 0) + ' out' +
        (ls.sha ? ' · <a target="_blank" rel="noopener" href="https://github.com/' + esc(c.repo) + '/commit/' +
                  esc(ls.sha) + '">' + esc(ls.sha.slice(0, 7)) + '</a>' : '') +
        (pending > 0 ? '<br>' + pending + ' change(s) here not in git yet.' : '');
    } else st.textContent = 'Set up, never synced from here yet.';

    document.getElementById('gsTok').innerHTML = c.token
      ? 'token saved ✓ · <button type="button" class="gs-link" data-gs="forget-token">remove</button>'
      : '<span class="gs-dim">Fine-grained token, this one repository only, "Contents: Read and write", with an expiry. ' +
        'Anyone on this network can read it back from the interface — give it nothing more.</span>';

    document.getElementById('gsSyncNow').disabled = busy || !conf;
    document.getElementById('gsSave').disabled = busy;

    var un = document.getElementById('gsUnconf');
    un.hidden = conf;
    if (!conf) {
      un.innerHTML = 'Until git is set up, a JSON backup still downloads by itself 30 min after the last QSO. ' +
        '<div class="gs-btns"><button class="pa-btn" type="button" data-gs="download">DOWNLOAD JSON NOW</button></div>' +
        'File backup and restore: <a href="/datasync">LOGSYNC → Backup / Restore</a>.';
    }

    var v = document.getElementById('gsViewer');
    var m = /^([^/]+)\/(.+)$/.exec(c.repo || '');
    v.hidden = !m;
    if (m) v.href = 'https://' + m[1].toLowerCase() + '.github.io/' + m[2] + '/';

    renderProgress();
    if (open) place();
  }

  function setOpen(v) {
    var was = open;
    open = !!v;
    if (open && !el) build();
    if (el) el.style.display = open ? '' : 'none';
    if (open) {
      if (!was) fillForm();
      render();
      place();
    } else if (was && el && el.contains(document.activeElement)) {
      var call = document.getElementById('inpCall');
      if (call) call.focus();
    }
    if (!open && confirmWait) confirmWait(false);
  }

  function showHint(text) {
    if (typeof global.showHint === 'function') global.showHint(text, 4000);
  }

  // ── mount ───────────────────────────────────────────────────────────────────

  function mount() {
    btn = document.getElementById('btnGitSync');
    btnCfg = document.getElementById('btnGitSyncCfg');
    if (!btn || !btnCfg) return;
    load();
    [btn, btnCfg].forEach(function (b) { b.addEventListener('mousedown', function (e) { e.preventDefault(); }); });
    btn.addEventListener('click', function () { sync(); });
    btnCfg.addEventListener('click', function () { setOpen(!open); });
    global.addEventListener('resize', function () { if (el && open) place(); });
    if (global.LogDB && LogDB.onQsoWrite) LogDB.onQsoWrite(onWrite);
    renderButton();
    loadCfg().then(function () { recount(); renderButton(); render(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  global.LogGitSync = {
    isConfigured: isConfigured,
    sync: sync,
    setOpen: setOpen,
    isOpen: function () { return open; },
    isBusy: function () { return busy; },
    pending: function () { return pending; },
    core: core,
    // the smoke harness points this at its fake GitHub
    _setApi: function (u) { API = u; },
  };

}(typeof window !== 'undefined' ? window : globalThis));
