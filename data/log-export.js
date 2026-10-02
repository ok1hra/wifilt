'use strict';
/**
 * log-export.js — CSV and ADIF rows for a QSO, shared by two pages
 *
 * The contest log (log.js) exports one log at a time; the GitHub Pages log
 * viewer (log-viewer/, built by tools/build-log-viewer.sh, which inlines this
 * very file) exports whatever its filters left. Both must write the same ADIF
 * for the same QSO -- a JS8 contact is MODE=MFSK SUBMODE=JS8 in either, and a
 * CW-R one is CW -- so the mapping lives here once and nowhere else.
 *
 * Pure functions only: no DOM, no IndexedDB, no download. The callers own the
 * file around these rows (log.js prepends a BOM, the viewer names the file
 * after its filter). tools/log-export-parity.js holds the output byte-for-byte
 * to what log.js wrote before this file existed.
 */
(function (global) {

  // ── CSV ────────────────────────────────────────────────────────────────────

  function escCsv(v) {
    const s = String(v == null ? '' : v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const CSV_HEADERS = [
    'qsoNumber','dateUtc','timeUtc','call','rstSent','rstReceived',
    'exchangeReceived','frequencyHz','frequencyDisplay','mode','trx',
    'continent','country','dxccPrefix','cqZone','ituZone',
    'utcOffset','qrbKm','azimuthDeg','locatorReceived',
  ];

  function qsoToCsvRow(q) {
    const d = q.dxcc || {};
    return [
      q.qsoNumber, q.qsoDateUtc, q.timeOnUtc,
      q.call, q.rstSent, q.rstReceived, q.exchangeReceived,
      q.frequencyHz, q.frequencyDisplay, q.mode, q.trx,
      d.continent, d.country, d.mainPrefix, d.cqZone, d.ituZone,
      d.utcOffset, d.qrbKm, d.azimuthDeg,
      q.locatorReceived || '',
    ].map(escCsv).join(',');
  }

  function csvFromQsos(qsos) {
    return [CSV_HEADERS.join(','), ...qsos.map(qsoToCsvRow)].join('\r\n');
  }

  // ── ADIF ───────────────────────────────────────────────────────────────────

  function adifField(tag, val) {
    if (val == null || val === '') return '';
    const s = String(val);
    return '<' + tag + ':' + s.length + '>' + s;
  }

  function freqToAdifMhz(hz) {
    return (hz / 1e6).toFixed(6);
  }

  function freqToBand(hz) {
    if (hz >= 1800000   && hz <= 2000000)   return '160m';
    if (hz >= 3500000   && hz <= 4000000)   return '80m';
    if (hz >= 5351500   && hz <= 5366500)   return '60m';
    if (hz >= 7000000   && hz <= 7300000)   return '40m';
    if (hz >= 10100000  && hz <= 10150000)  return '30m';
    if (hz >= 14000000  && hz <= 14350000)  return '20m';
    if (hz >= 18068000  && hz <= 18168000)  return '17m';
    if (hz >= 21000000  && hz <= 21450000)  return '15m';
    if (hz >= 24890000  && hz <= 24990000)  return '12m';
    if (hz >= 28000000  && hz <= 29700000)  return '10m';
    if (hz >= 50000000  && hz <= 54000000)  return '6m';
    if (hz >= 70000000  && hz <= 71000000)  return '4m';
    if (hz >= 144000000 && hz <= 148000000) return '2m';
    if (hz >= 222000000 && hz <= 225000000) return '1.25m';
    if (hz >= 420000000 && hz <= 450000000) return '70cm';
    if (hz >= 902000000 && hz <= 928000000) return '33cm';
    return '';
  }

  function adifModeMap(mode) {
    const m = (mode || '').toUpperCase();
    if (m === 'CW' || m === 'CWR' || m === 'CW-R') return 'CW';
    if (m === 'USB') return 'SSB';
    if (m === 'LSB') return 'SSB';
    if (m === 'FM')  return 'FM';
    if (m === 'AM')  return 'AM';
    if (m === 'RTTY' || m === 'RTTY-R' || m === 'RTTYR') return 'RTTY';
    if (m === 'FSK') return 'RTTY';
    if (m === 'DV')  return 'DIGITALVOICE';
    if (m === 'JS8') return 'MFSK';
    return mode;
  }

  // ADIF has no MODE=JS8 -- the standard encoding is MODE=MFSK with a
  // SUBMODE naming the actual digital mode (adifModeMap just above already
  // returns 'MFSK' for it). Everything else this logger writes has no
  // meaningful submode, so this returns '' and adifField() drops the tag.
  function adifSubmode(mode) {
    return (mode || '').toUpperCase() === 'JS8' ? 'JS8' : '';
  }

  function qsoToAdif(q, stationCall, myLocator) {
    const fields = [
      adifField('FREQ',             freqToAdifMhz(q.frequencyHz)),
      adifField('BAND',             freqToBand(q.frequencyHz)),
      adifField('QSO_DATE',         (q.qsoDateUtc || '').replace(/-/g,'')),
      adifField('TIME_ON',          (q.timeOnUtc  || '').replace(':','')),
      adifField('CALL',             q.call),
      adifField('MODE',             adifModeMap(q.mode)),
      adifField('SUBMODE',          adifSubmode(q.mode)),
      adifField('RST_SENT',         q.rstSent),
      adifField('STX',              String(q.qsoNumber).padStart(3,'0')),
      adifField('RST_RCVD',         q.rstReceived),
      adifField('SRX',              q.exchangeReceived),
      adifField('STATION_CALLSIGN', stationCall),
      adifField('MY_GRIDSQUARE',    myLocator),
      adifField('GRIDSQUARE',       q.locatorReceived || ''),
      '<EOR>',
    ];
    return fields.filter(Boolean).join(' ') + '\r\n';
  }

  function adifHeader() {
    return 'Generated by WIFILT contest log\r\n' +
           adifField('PROGRAMID','WIFILT-Log') + ' ' +
           adifField('PROGRAMVERSION','1.0') + ' ' +
           '<EOH>\r\n\r\n';
  }

  // stationOf(q) -> {stationCall, myLocator}: the log viewer's rows come from
  // many logs, so each QSO carries its own station, not the file's.
  function adifFromQsos(qsos, stationOf) {
    return adifHeader() + qsos.map(q => {
      const st = stationOf(q) || {};
      return qsoToAdif(q, st.stationCall, st.myLocator);
    }).join('');
  }

  global.LogExport = {
    escCsv, CSV_HEADERS, qsoToCsvRow, csvFromQsos,
    adifField, freqToAdifMhz, freqToBand, adifModeMap, adifSubmode,
    qsoToAdif, adifHeader, adifFromQsos,
  };

})(typeof window !== 'undefined' ? window : globalThis);
