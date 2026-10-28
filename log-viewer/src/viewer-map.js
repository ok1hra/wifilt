'use strict';
/**
 * viewer-map.js — the map beside the log (GitHub Pages viewer)
 *
 * Draws what map-core.js works out from the rows the filters leave: red dots
 * where the logs were transmitted from, a point where each QSO was, lines
 * between them, the grey line. Two views:
 *
 *   - Map: Leaflet over OpenStreetMap tiles, fitted to the filtered QSOs, so a
 *     VHF contest shows its corner of Europe, not the world. The tiles draw
 *     country borders too faintly to read under the lines, so the
 *     world-atlas borders go on top of them;
 *   - Azimuthal: azimuthal equidistant around one transmitter site (d3-geo
 *     over world-atlas outlines; raster tiles only come in Mercator), the
 *     furthest QSO near the rim.
 *
 * Every library comes from a CDN, at a fixed version with its hash, and only
 * when it is needed: d3 not before the azimuthal view is opened. No internet,
 * no map -- the table and the statistics do not depend on any of it.
 *
 * The view (which map, lines, labels, grey line and its time, the centre, the
 * locator for logs without one) is kept in the address by viewer.js through
 * writeParams/readParams. Folding the map away is personal: localStorage.
 * "In view: ADIF / CSV" hands viewer.js the QSOs whose points are on screen.
 */
(function () {

  var LIB = {
    leafletCss: ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
                 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H'],
    leaflet:    ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
                 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH'],
    d3: [
      ['https://cdn.jsdelivr.net/npm/d3-array@3.2.4/dist/d3-array.min.js',
       'sha384-VpKMdU+TlpggHFip46tJ/xkFUs8NFBwLqUMo3+3uiu411lU6eUQYsHVU+JFpA5ja'],
      ['https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/dist/d3-geo.min.js',
       'sha384-VNiKRUXp0MmglFfqDwkfuk+Y78C3WTJShdKSaFwOacLR3UmamxHIJLBTD3BadIXD'],
      ['https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js',
       'sha384-Ukv1p/xTma6P4/2bY5KzWBw+ydSpXmhCMtyciIQVDJ1RmOxtCYNMF1uXT9T63H67'],
    ],
    atlas110: ['https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json',
               'sha384-yOCJ+8ShBm8UDqtAVtAvxTDDf4gXo5edxl/YG0FmVC5OTmqVLl7utuVGBDEeZWHf'],
    atlas50:  ['https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json',
               'sha384-Aw4s9pX1PTPntIYkZ/qV9IYiF5Gv8eTl6Dd/TT56zfO1Wwd+owFwYUuuXNUMrWkc'],
  };
  var FOLD_KEY = 'wifilt-log-viewer-map';
  var EARTH_KM = 6371, HALF_WORLD_KM = 20015, R2D = 180 / Math.PI;
  // Below this radius the azimuthal map is regional, and the coarse outlines
  // (110m) start to look like a child's drawing: the 50m ones are fetched.
  var DETAIL_KM = 3000;
  var MAX_POPUP_ROWS = 20;

  var DEFAULTS = { view: 'merc', lines: true, labels: 'call', gray: true, grayAt: null, site: '', myloc: '' };
  var st = Object.assign({}, DEFAULTS);
  var opts = {}, logsById = {}, rows = [], rowsKey = null, agg = null, needFit = true;
  var times = null;          // {min, max} ms of the filtered rows, for the slider
  var focusKey = null;       // the point of the row last clicked in the table
  var folded = false;
  var lmap = null, lay = {}, leafletState = 'idle';
  var az = { state: 'idle', geo110: null, geo50: null, loading50: false, zoom: 1, hits: [], radiusKm: 0 };
  var colors = {};

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── loading ─────────────────────────────────────────────────────────────────

  var loads = {};
  function loadScript(u) {
    if (!loads[u[0]]) loads[u[0]] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = u[0]; s.integrity = u[1]; s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = function () { delete loads[u[0]]; reject(new Error(u[0])); };
      document.head.appendChild(s);
    });
    return loads[u[0]];
  }

  function loadCss(u) {
    if (!loads[u[0]]) loads[u[0]] = new Promise(function (resolve, reject) {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = u[0]; l.integrity = u[1]; l.crossOrigin = 'anonymous';
      l.onload = resolve;
      l.onerror = function () { delete loads[u[0]]; reject(new Error(u[0])); };
      document.head.appendChild(l);
    });
    return loads[u[0]];
  }

  function loadJson(u) {
    if (!loads[u[0]]) loads[u[0]] = fetch(u[0], { integrity: u[1] }).then(function (r) {
      if (!r.ok) throw new Error(u[0] + ' HTTP ' + r.status);
      return r.json();
    }).catch(function (e) { delete loads[u[0]]; throw e; });
    return loads[u[0]];
  }

  function offline(what) {
    $('mapMsg').hidden = false;
    $('mapMsg').textContent = 'The map needs the internet: ' + what + ' could not be loaded. The log itself works without it.';
  }

  // ── colours: from the stylesheet, so dark mode is one place ────────────────

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    ['site', 'loc', 'state', 'dxcc', 'halo', 'text', 'sea', 'land', 'border', 'ring', 'night', 'focus'].forEach(function (k) {
      colors[k] = cs.getPropertyValue('--map-' + k).trim() || '#888';
    });
    colors.nightStrength = parseFloat(cs.getPropertyValue('--map-night-strength')) || 1;
  }

  function nightRgb() {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colors.night);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 10, 40];
  }

  // How dark the night is where the sun stands alt degrees high: nothing by
  // day, a visible step at the horizon (that is the grey line), then a little
  // deeper to astronomical night at -18 -- never so dark that the map under
  // it cannot be read.
  var NIGHT_EDGE = 0.07, NIGHT_DEEP = 0.15;
  function nightAlpha(alt) {
    return alt >= 0 ? 0 : (NIGHT_EDGE + NIGHT_DEEP * Math.min(1, -alt / 18)) * colors.nightStrength;
  }

  // ── data ────────────────────────────────────────────────────────────────────

  function parseWhen(s) {
    s = String(s || '');
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s)) return NaN;
    if (!/(?:Z|[+-]\d\d:?\d\d)$/i.test(s)) s += 'Z';
    return Date.parse(s);
  }

  function timeRange() {
    var lo = '', hi = '';
    rows.forEach(function (r) {
      if (!/^\d/.test(r.when)) return;
      if (!lo || r.when < lo) lo = r.when;
      if (!hi || r.when > hi) hi = r.when;
    });
    var a = parseWhen(lo), b = parseWhen(hi);
    times = isNaN(a) || isNaN(b) ? null : { min: a, max: b };
  }

  function nightDate() { return st.grayAt != null ? new Date(st.grayAt) : new Date(); }

  function pointRadius(p) { return p.kind === 'loc' ? 4 : 4 + 2.2 * Math.log10(p.n); }

  function pointLabel(p) {
    if (p.kind === 'loc') return p.calls[0] + (p.calls.length > 1 ? ' +' + (p.calls.length - 1) : '');
    return (p.kind === 'state' ? p.label : (p.prefix || p.label)) + ' ' + p.n;
  }

  function siteLabel(s) { return (s.approx ? '≈ ' : '') + (s.calls.join(' · ') || '?'); }

  function lineWidth(p, n) { return p.kind === 'loc' ? 1 : Math.min(4, 1 + Math.log10(n)); }

  // ── popups (the same HTML in both views) ────────────────────────────────────

  function filterFor(p) {
    if (p.kind === 'loc') {
      var exact = p.rows.every(function (r) { return r.loc === p.label; });
      return ['loc', (exact ? '=' : '') + p.label, 'Show only ' + p.label];
    }
    if (p.kind === 'dxcc') return ['country', '=' + p.country, 'Show only ' + p.country];
    return null;   // a state is one token of the exchange; no column filter says exactly that
  }

  function rowsTable(list) {
    var sorted = list.slice().sort(function (a, b) { return a.when < b.when ? 1 : a.when > b.when ? -1 : 0; });
    return '<table>' + sorted.slice(0, MAX_POPUP_ROWS).map(function (r) {
      return '<tr><td class="c">' + esc(r.call) + '</td><td>' + esc(r.date) + ' ' + esc(r.time) + '</td><td>' +
             esc(r.band) + '</td><td>' + esc(r.mode) + '</td></tr>';
    }).join('') + '</table>' +
      (list.length > MAX_POPUP_ROWS ? '<div class="dim">… and ' + (list.length - MAX_POPUP_ROWS) + ' more</div>' : '');
  }

  function pointPopup(p) {
    var kind = p.kind === 'loc' ? 'locator' : p.kind === 'state'
      ? (p.country === 'Canada' ? 'province, Canada' : 'state, USA') : 'DXCC, middle of the country';
    var f = filterFor(p);
    return '<div class="map-pop"><div class="h"><b>' + esc(p.label) + '</b> <span class="dim">' + kind + '</span></div>' +
      '<div class="dim">' + p.n + ' QSO · ' + p.calls.length + (p.calls.length === 1 ? ' station' : ' stations') + '</div>' +
      rowsTable(p.rows) +
      (f ? '<button type="button" class="map-filter" data-k="' + f[0] + '" data-v="' + esc(f[1]) + '">' + esc(f[2]) + '</button>' : '') +
      '</div>';
  }

  function sitePopup(s) {
    var where = s.approx
      ? 'The log has no locator: this is the middle of the own call\'s country. Give a locator in <i>QTH</i> above the map.'
      : 'Locator ' + esc(s.loc);
    return '<div class="map-pop"><div class="h"><b>' + esc(s.calls.join(' · ')) + '</b> <span class="dim">transmitter</span></div>' +
      '<div class="dim">' + where + '</div><div class="dim">' + s.n + ' QSO</div>' +
      (s.calls.length === 1 ? '<button type="button" class="map-filter" data-k="my" data-v="=' + esc(s.calls[0]) +
        '">Show only ' + esc(s.calls[0]) + '</button>' : '') + '</div>';
  }

  function wirePopup(el) {
    if (!el) return;
    var b = el.querySelector('.map-filter');
    if (b) b.addEventListener('click', function () {
      if (lmap) lmap.closePopup();
      closeAzPopup();
      if (opts.onFilter) opts.onFilter(b.getAttribute('data-k'), b.getAttribute('data-v'));
    });
  }

  // ── labels: one canvas, the most important first, none on top of another ──

  // items: [{x, y, text, kind: 'count' | 'call', color, pri}]
  function drawLabels(ctx, items, w, h) {
    items.sort(function (a, b) { return b.pri - a.pri; });
    var cell = 48, grid = {}, drawn = 0;
    function cellsOf(b) {
      var out = [];
      for (var gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++)
        for (var gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) out.push(gx + ',' + gy);
      return out;
    }
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (var i = 0; i < items.length && drawn < 800; i++) {
      var it = items[i];
      if (it.x < -40 || it.y < -10 || it.x > w + 40 || it.y > h + 10) continue;
      ctx.font = it.kind === 'count' ? '700 10px system-ui, sans-serif' : '600 11px ui-monospace, Menlo, Consolas, monospace';
      var tw = ctx.measureText(it.text).width;
      var x = it.kind === 'count' ? it.x - tw / 2 : it.x + 6, y = it.y;
      var box = [x - 2, y - 7, x + tw + 2, y + 7], cells = cellsOf(box), hit = false;
      for (var c = 0; c < cells.length && !hit; c++) {
        var list = grid[cells[c]] || [];
        for (var k = 0; k < list.length; k++) {
          var o = list[k];
          if (box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1]) { hit = true; break; }
        }
      }
      if (hit) continue;
      cells.forEach(function (key) { (grid[key] = grid[key] || []).push(box); });
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.halo;
      ctx.strokeText(it.text, x, y);
      ctx.fillStyle = it.color || colors.text;
      ctx.fillText(it.text, x, y);
      drawn++;
    }
  }

  // What to write on the map, wherever project(lat, lon) -> [x, y] | null puts it.
  // mids: [{lat, lon, n, kind}] -- the middle of each line to a state or DXCC.
  function labelItems(project, mids) {
    var items = [];
    if (st.lines) mids.forEach(function (m) {
      var xy = project(m.lat, m.lon);
      if (xy) items.push({ x: xy[0], y: xy[1], text: String(m.n), kind: 'count', color: colors[m.kind], pri: 1e6 + m.n });
    });
    if (st.labels === 'call') agg.points.forEach(function (p) {
      var xy = project(p.lat, p.lonU);
      if (xy) items.push({ x: xy[0], y: xy[1], text: pointLabel(p), kind: 'call', color: colors.text, pri: p.n });
    });
    return items;
  }

  // ── Map: Leaflet ────────────────────────────────────────────────────────────

  function ensureLeaflet() {
    if (leafletState === 'ready') return Promise.resolve();
    if (leafletState === 'loading') return loads.leafletReady;
    leafletState = 'loading';
    loads.leafletReady = Promise.all([loadCss(LIB.leafletCss), loadScript(LIB.leaflet)])
      .then(createLeaflet)
      .catch(function (e) {
        leafletState = 'failed';
        offline('Leaflet (unpkg.com)');
        throw e;
      });
    return loads.leafletReady;
  }

  function createLeaflet() {
    var NightLayer = L.GridLayer.extend({
      // One canvas pixel per 4x4 screen pixels; the browser smooths it when
      // it stretches the tile, which is just what a twilight should look like.
      createTile: function (coords) {
        var size = this.getTileSize(), q = 4, c = document.createElement('canvas');
        c.width = size.x / q; c.height = size.y / q;
        var ctx = c.getContext('2d'), img = ctx.createImageData(c.width, c.height);
        var map = this._map, z = coords.z, ox = coords.x * size.x, oy = coords.y * size.y;
        var sun = MapCore.subsolar(nightDate()), rgb = nightRgb(), lats = [], lons = [], x, y;
        // Mercator: the latitude only depends on y, the longitude on x.
        for (y = 0; y < c.height; y++) lats.push(map.unproject(L.point(ox, oy + y * q + q / 2), z).lat);
        for (x = 0; x < c.width; x++) lons.push(map.unproject(L.point(ox + x * q + q / 2, oy), z).lng);
        for (y = 0; y < c.height; y++) for (x = 0; x < c.width; x++) {
          var i = (y * c.width + x) * 4;
          img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
          img.data[i + 3] = Math.round(255 * nightAlpha(MapCore.sunAltitude(sun, lats[y], lons[x])));
        }
        ctx.putImageData(img, 0, 0);
        return c;
      },
    });

    var LabelLayer = L.Layer.extend({
      onAdd: function (map) {
        this._c = L.DomUtil.create('canvas', 'map-labels', map.getPane('labels'));
        map.on('moveend resize', this.draw, this);
        map.on('zoomstart', this._hide, this);
        this.draw();
      },
      onRemove: function (map) {
        L.DomUtil.remove(this._c);
        map.off('moveend resize', this.draw, this);
        map.off('zoomstart', this._hide, this);
      },
      _hide: function () { this._c.style.visibility = 'hidden'; },
      draw: function () {
        var map = this._map;
        if (!map || !agg) return;
        var size = map.getSize(), dpr = window.devicePixelRatio || 1, c = this._c;
        L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
        c.width = size.x * dpr; c.height = size.y * dpr;
        c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
        c.style.visibility = '';
        var ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawLabels(ctx, labelItems(function (lat, lon) {
          var p = map.latLngToContainerPoint([lat, lon]);
          return [p.x, p.y];
        }, lay.mids || []), size.x, size.y);
      },
    });

    lmap = L.map($('mapL'), { preferCanvas: true, zoomSnap: 0.25, minZoom: 1, worldCopyJump: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, className: 'osm-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(lmap);
    lmap.createPane('borders').style.zIndex = 240;
    lmap.getPane('borders').style.pointerEvents = 'none';
    lay.borderRenderer = L.canvas({ pane: 'borders' });
    lmap.on('zoomend', drawBorders);
    lmap.createPane('night').style.zIndex = 250;
    lmap.createPane('labels').style.zIndex = 450;
    lmap.getPane('night').style.pointerEvents = 'none';
    lmap.getPane('labels').style.pointerEvents = 'none';
    lay.night = new NightLayer({ pane: 'night', updateWhenZooming: false });
    lay.vec = L.layerGroup().addTo(lmap);
    lay.labels = new LabelLayer().addTo(lmap);
    lmap.on('popupopen', function (e) { wirePopup(e.popup.getElement()); });
    lmap.setView([30, 10], 2);
    leafletState = 'ready';
    loadScript(LIB.d3[2])
      .then(function () { return loadJson(LIB.atlas110); })
      .then(function (topo) { az.geo110 = az.geo110 || toGeo(topo); drawBorders(); })
      .catch(function () { /* the tiles have borders of their own, only fainter */ });
  }

  function shiftGeo(g, dx) {
    return { type: g.type, coordinates: g.coordinates.map(function (line) {
      return line.map(function (p) { return [p[0] + dx, p[1]]; });
    }) };
  }

  // Coarse borders for the world, fine ones from zoom 3 on. The coarse ones
  // are drawn three times, a world apart, because the points sit on
  // longitudes unwrapped round the busiest site and may be past +-180.
  var FINE_ZOOM = 3;
  function drawBorders() {
    if (!lmap || !az.geo110) return;
    readColors();
    var fine = lmap.getZoom() >= FINE_ZOOM;
    if (fine) want50();
    var geo = fine && az.geo50 ? az.geo50 : az.geo110, key = geo === az.geo50 ? '50' : '110';
    if (lay.borders && lay.bordersKey === key && lay.bordersColor === colors.border) return;
    if (lay.borders) lmap.removeLayer(lay.borders);
    lay.bordersKey = key;
    lay.bordersColor = colors.border;
    lay.borders = L.geoJSON({ type: 'FeatureCollection', features: (key === '110' ? [-360, 0, 360] : [0]).map(function (dx) {
      return { type: 'Feature', properties: {}, geometry: shiftGeo(geo.borders, dx) };
    }) }, {
      pane: 'borders', renderer: lay.borderRenderer, interactive: false,
      style: function () { return { color: colors.border, weight: 1, opacity: 0.9 }; },
    }).addTo(lmap);
  }

  function renderLeaflet() {
    if (!lmap || !agg) return;
    readColors();
    if (st.gray && !lmap.hasLayer(lay.night)) lay.night.addTo(lmap);
    if (!st.gray && lmap.hasLayer(lay.night)) lmap.removeLayer(lay.night);
    // One group, cleared and filled in drawing order: the canvas renderer
    // paints in the order layers arrive, and the sites must end up on top.
    lay.vec.clearLayers();
    var mids = [];
    if (st.lines) agg.links.forEach(function (lk) {
      var s = agg.sites[lk.site], p = agg.points[lk.point];
      var path = MapCore.greatCircle({ lat: s.lat, lon: s.lonU }, { lat: p.lat, lon: p.lonU });
      var style = { color: colors[p.kind], weight: lineWidth(p, lk.n), opacity: 0.5, interactive: false };
      lay.vec.addLayer(L.polyline(path, style));
      // A line over a pole can arrive at the copy of the point one world
      // away; a second copy, shifted, arrives at the point itself.
      var shift = p.lonU - path[path.length - 1][1];
      if (Math.abs(shift) > 1) lay.vec.addLayer(L.polyline(path.map(function (q) { return [q[0], q[1] + shift]; }), style));
      if (p.kind !== 'loc') {
        var m = path[Math.floor(path.length / 2)];
        mids.push({ lat: m[0], lon: m[1], n: lk.n, kind: p.kind });
      }
    });
    lay.mids = mids;
    agg.points.forEach(function (p) {
      var dot = st.labels === 'call';
      lay.vec.addLayer(L.circleMarker([p.lat, p.lonU], {
        radius: dot ? 2.5 : pointRadius(p), color: colors[p.kind], weight: 1,
        fillColor: colors[p.kind], fillOpacity: 0.7, bubblingMouseEvents: false,
      }).bindPopup(function () { return pointPopup(p); }, { maxWidth: 340 }));
    });
    var fp = focusKey && agg.points.filter(function (p) { return p.key === focusKey; })[0];
    if (fp) lay.vec.addLayer(L.circleMarker([fp.lat, fp.lonU], {
      radius: pointRadius(fp) + 6, color: colors.focus, weight: 3, fill: false, interactive: false,
    }));
    agg.sites.forEach(function (s) {
      lay.vec.addLayer(L.circleMarker([s.lat, s.lonU], {
        radius: 7, color: colors.site, weight: 2, fillColor: colors.site,
        fillOpacity: s.approx ? 0.15 : 0.9, dashArray: s.approx ? '3 3' : null, bubblingMouseEvents: false,
      }).bindTooltip(esc(siteLabel(s)), { permanent: true, direction: 'right', offset: [8, 0], className: 'site-tip' })
        .bindPopup(function () { return sitePopup(s); }, { maxWidth: 340 }));
    });
    lay.labels.draw();
    if (needFit) fit();
  }

  // ── Azimuthal: d3-geo on a canvas ───────────────────────────────────────────

  function ensureAz() {
    if (az.state === 'ready' || az.state === 'loading') return;
    az.state = 'loading';
    $('mapMsg').hidden = false;
    $('mapMsg').textContent = 'Loading the azimuthal map…';
    LIB.d3.reduce(function (p, u) { return p.then(function () { return loadScript(u); }); }, Promise.resolve())
      .then(function () { return loadJson(LIB.atlas110); })
      .then(function (topo) {
        az.geo110 = toGeo(topo);
        az.state = 'ready';
        $('mapMsg').hidden = true;
        drawAz();
      })
      .catch(function () {
        az.state = 'failed';
        offline('d3 and the world outlines (cdn.jsdelivr.net)');
      });
  }

  function toGeo(topo) {
    return {
      land: topojson.feature(topo, topo.objects.land),
      borders: topojson.mesh(topo, topo.objects.countries, function (a, b) { return a !== b; }),
    };
  }

  function want50() {
    if (az.geo50 || az.loading50) return;
    az.loading50 = true;
    loadJson(LIB.atlas50).then(function (topo) { az.geo50 = toGeo(topo); drawAz(); drawBorders(); })
      .catch(function () { /* the 110m outlines stay; it is only detail */ })
      .then(function () { az.loading50 = false; });
  }

  function azCenter() {
    var best = null;
    if (agg) agg.sites.forEach(function (s) {
      if (s.key === st.site) best = { s: s, w: Infinity };
      else if (!best || s.n > best.w) best = { s: s, w: s.n };
    });
    if (best) return best.s;
    if (agg && agg.points.length) return agg.points[0];
    return { lat: 50, lon: 15 };
  }

  // Ring spacing: about three rings inside the rim, at a round distance.
  function ringStep(km) {
    var steps = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
    for (var i = 0; i < steps.length; i++) if (km / steps[i] <= 4) return steps[i];
    return 5000;
  }

  var azFrame = 0;
  function drawAzSoon() {
    if (azFrame) return;
    azFrame = requestAnimationFrame(function () { azFrame = 0; drawAz(); });
  }

  function drawAz() {
    var box = $('mapAz');
    if (st.view !== 'az' || az.state !== 'ready' || folded) return;
    var w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return;
    readColors();
    var c = $('azCanvas'), dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var center = azCenter(), cll = [center.lon, center.lat];
    var R = Math.min(w, h) / 2 - 18, cx = w / 2, cy = h / 2;
    var fitKm = agg && (agg.points.length || agg.sites.length) ? MapCore.maxDistanceKm(center, agg) * 1.12 : HALF_WORLD_KM;
    var radiusKm = Math.max(20, Math.min(HALF_WORLD_KM, Math.max(200, Math.min(HALF_WORLD_KM, fitKm)) / az.zoom));
    az.radiusKm = radiusKm;
    var ang = radiusKm / EARTH_KM;
    az.view = { c: cll, ang: ang };
    var proj = d3.geoAzimuthalEquidistant().rotate([-center.lon, -center.lat]).translate([cx, cy])
      .scale(R / ang).clipAngle(Math.min(179.9, ang * R2D)).precision(0.3);
    var path = d3.geoPath(proj, ctx);
    if (radiusKm < DETAIL_KM) want50();
    var geo = (radiusKm < DETAIL_KM && az.geo50) || az.geo110;

    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.fillStyle = colors.sea; ctx.fill();
    ctx.beginPath(); path(geo.land); ctx.fillStyle = colors.land; ctx.fill();
    ctx.beginPath(); path(geo.borders); ctx.strokeStyle = colors.border; ctx.lineWidth = 0.9; ctx.stroke();

    if (st.gray) {
      var sun = MapCore.subsolar(nightDate()), anti = [sun.lon + 180, -sun.lat], rgb = nightRgb();
      // Night, then civil, nautical, astronomical: each a smaller cap around
      // the point opposite the sun, laid one over another.
      [[0, NIGHT_EDGE], [6, NIGHT_DEEP / 3], [12, NIGHT_DEEP / 3], [18, NIGHT_DEEP / 3]].forEach(function (d) {
        ctx.beginPath();
        path(d3.geoCircle().center(anti).radius(90 - d[0])());
        ctx.fillStyle = 'rgba(' + rgb.join(',') + ',' + d[1] * colors.nightStrength + ')';
        ctx.fill();
      });
    }

    // Distance rings and the compass round the rim.
    var step = ringStep(radiusKm);
    ctx.strokeStyle = colors.ring; ctx.fillStyle = colors.ring; ctx.lineWidth = 0.8;
    ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
    for (var km = step; km < radiusKm * 0.98; km += step) {
      var r = R * km / radiusKm;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillText(km >= 1000 && km % 1000 === 0 ? km / 1000 + 'k km' : km + ' km', cx + 3, cy - r - 1);
    }
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var a = 0; a < 360; a += 30) {
      var t = a * Math.PI / 180, sx = Math.sin(t), sy = -Math.cos(t);
      ctx.beginPath(); ctx.moveTo(cx + sx * R, cy + sy * R); ctx.lineTo(cx + sx * (R + 4), cy + sy * (R + 4)); ctx.stroke();
      ctx.fillText(a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a), cx + sx * (R + 11), cy + sy * (R + 11));
    }
    ctx.textAlign = 'left';

    if (!agg) return;
    var inView = function (lon, lat) { return d3.geoDistance(cll, [lon, lat]) <= ang + 1e-9; };
    var project = function (lat, lon) { return inView(lon, lat) ? proj([lon, lat]) : null; };
    var mids = [];
    if (st.lines) agg.links.forEach(function (lk) {
      var s = agg.sites[lk.site], p = agg.points[lk.point], a2 = [s.lon, s.lat], b2 = [p.lon, p.lat];
      ctx.beginPath();
      path({ type: 'LineString', coordinates: [a2, b2] });
      ctx.strokeStyle = colors[p.kind]; ctx.globalAlpha = 0.5; ctx.lineWidth = lineWidth(p, lk.n);
      ctx.stroke(); ctx.globalAlpha = 1;
      if (p.kind !== 'loc') {
        var m = d3.geoInterpolate(a2, b2)(0.5);
        mids.push({ lat: m[1], lon: m[0], n: lk.n, kind: p.kind });
      }
    });
    az.hits = [];
    agg.points.forEach(function (p) {
      var xy = project(p.lat, p.lon);
      if (!xy) return;
      var r = st.labels === 'call' ? 2.5 : pointRadius(p);
      ctx.beginPath(); ctx.arc(xy[0], xy[1], r, 0, 2 * Math.PI);
      ctx.fillStyle = colors[p.kind]; ctx.globalAlpha = 0.7; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = colors[p.kind]; ctx.lineWidth = 1; ctx.stroke();
      az.hits.push({ x: xy[0], y: xy[1], r: Math.max(r, 5), p: p });
      if (p.key === focusKey) {
        ctx.beginPath(); ctx.arc(xy[0], xy[1], r + 6, 0, 2 * Math.PI);
        ctx.strokeStyle = colors.focus; ctx.lineWidth = 3; ctx.stroke();
      }
    });
    // The labels take the points' unwrapped longitudes in labelItems; here
    // the projection does not care which copy of the world a longitude is in.
    drawLabels(ctx, labelItems(project, mids), w, h);
    agg.sites.forEach(function (s) {
      var xy = project(s.lat, s.lon);
      if (!xy) return;
      ctx.beginPath(); ctx.arc(xy[0], xy[1], 7, 0, 2 * Math.PI);
      ctx.fillStyle = colors.site; ctx.globalAlpha = s.approx ? 0.15 : 0.9; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.site; ctx.lineWidth = 2;
      if (s.approx) ctx.setLineDash([3, 3]);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '700 12px system-ui, sans-serif'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = colors.halo; ctx.strokeText(siteLabel(s), xy[0] + 10, xy[1]);
      ctx.fillStyle = colors.site; ctx.fillText(siteLabel(s), xy[0] + 10, xy[1]);
      az.hits.push({ x: xy[0], y: xy[1], r: 9, s: s });
    });
  }

  // What is under the mouse: a site before any point, else the nearest point.
  function azHit(e) {
    var best = null, bd = Infinity;
    az.hits.forEach(function (h) {
      var d = Math.hypot(h.x - e.offsetX, h.y - e.offsetY);
      if (d > h.r + 3) return;
      if (h.s) d -= 1000;
      if (d < bd) { bd = d; best = h; }
    });
    return best;
  }

  function closeAzPopup() { $('azPop').hidden = true; }

  function onAzClick(e) {
    var h = azHit(e), pop = $('azPop');
    if (!h) { closeAzPopup(); return; }
    pop.innerHTML = '<button type="button" class="az-close" aria-label="Close">×</button>' +
      (h.s ? sitePopup(h.s) : pointPopup(h.p));
    pop.hidden = false;
    var box = $('mapAz');
    pop.style.left = Math.max(4, Math.min(e.offsetX + 12, box.clientWidth - pop.offsetWidth - 4)) + 'px';
    pop.style.top = Math.max(4, Math.min(e.offsetY + 12, box.clientHeight - pop.offsetHeight - 4)) + 'px';
    pop.querySelector('.az-close').addEventListener('click', closeAzPopup);
    wirePopup(pop);
  }

  // ── what is in view ─────────────────────────────────────────────────────────

  // The rows behind every point on screen now, in either view. A QSO with no
  // place is never in view.
  function visibleRows() {
    if (!agg || folded) return [];
    var inView;
    if (st.view === 'merc') {
      if (!lmap) return [];
      var b = lmap.getBounds();
      inView = function (p) {
        return [-360, 0, 360].some(function (dx) { return b.contains([p.lat, p.lonU + dx]); });
      };
    } else {
      if (!az.view || az.state !== 'ready') return [];
      inView = function (p) { return d3.geoDistance(az.view.c, [p.lon, p.lat]) <= az.view.ang + 1e-9; };
    }
    var out = [];
    agg.points.forEach(function (p) { if (inView(p)) out.push.apply(out, p.rows); });
    return out;
  }

  function exportView(ext) {
    var list = visibleRows();
    if (!list.length) {
      $('mapMsg').hidden = false;
      $('mapMsg').textContent = 'No QSO in view on the map.';
      setTimeout(function () { $('mapMsg').hidden = true; }, 2500);
      return;
    }
    if (opts.onExport) opts.onExport(list, ext);
  }

  // ── fitting ─────────────────────────────────────────────────────────────────

  function fit() {
    if (folded || !agg) return;
    if (st.view === 'merc') {
      if (!lmap || !$('mapL').clientWidth) return;
      needFit = false;
      var b = MapCore.bounds(agg);
      if (!b) return;
      var clamp = function (lat) { return Math.max(-80, Math.min(84, lat)); };
      lmap.fitBounds([[clamp(b.south), b.west], [clamp(b.north), b.east]], { padding: [28, 28], maxZoom: 9, animate: false });
    } else {
      needFit = false;
      az.zoom = 1;
      drawAz();
    }
  }

  // ── controls ────────────────────────────────────────────────────────────────

  function fmtTime(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }

  function syncControls() {
    document.querySelectorAll('#mapBar [data-view]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === st.view);
    });
    document.querySelectorAll('#mapBar [data-lbl]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-lbl') === st.labels);
    });
    $('mapLines').checked = st.lines;
    $('mapGray').checked = st.gray;
    if (document.activeElement !== $('mapMyloc')) $('mapMyloc').value = st.myloc;
    $('mapMyloc').classList.remove('bad');
    $('mapL').hidden = st.view !== 'merc';
    $('mapAz').hidden = st.view !== 'az';
    if (st.view !== 'az') closeAzPopup();
    var sel = $('mapSite'), sites = agg ? agg.sites : [];
    sel.hidden = st.view !== 'az' || sites.length < 2;
    var center = azCenter();
    sel.innerHTML = sites.map(function (s) {
      return '<option value="' + esc(s.key) + '"' + (s === center ? ' selected' : '') + '>' +
             esc(siteLabel(s) + (s.loc ? ' ' + s.loc : '')) + '</option>';
    }).join('');
    syncTime();
  }

  function syncTime() {
    var r = $('mapTime');
    r.disabled = !st.gray || !times;
    $('mapNow').hidden = !st.gray || st.grayAt == null;
    if (times) {
      r.min = Math.floor(times.min / 60000);
      r.max = Math.max(Math.ceil(times.max / 60000), Math.floor(times.min / 60000) + 1);
      r.value = st.grayAt != null ? Math.round(st.grayAt / 60000) : r.max;
    }
    $('mapTimeLbl').textContent = !st.gray ? '' : st.grayAt == null ? 'now' : fmtTime(st.grayAt);
  }

  function legend() {
    var kinds = { loc: 0, state: 0, dxcc: 0 };
    if (agg) agg.points.forEach(function (p) { kinds[p.kind] += p.n; });
    var item = function (cls, text) { return '<span class="lg"><i class="' + cls + '"></i>' + text + '</span>'; };
    var approx = agg && agg.sites.some(function (s) { return s.approx; });
    $('mapNote').innerHTML =
      item('site', 'transmitter' + (approx ? ' (≈ log without a locator)' : '')) +
      (kinds.loc ? item('loc', 'locator ' + kinds.loc) : '') +
      (kinds.state ? item('state', 'state ' + kinds.state) : '') +
      (kinds.dxcc ? item('dxcc', 'DXCC ' + kinds.dxcc) : '') +
      (agg && agg.unplaced ? '<span class="lg">' + agg.unplaced + ' QSO with no place</span>' : '');
  }

  function changed() {
    syncControls();
    render();
    if (opts.onState) opts.onState();
  }

  function render() {
    legend();
    if (folded) return;
    if (st.view === 'merc') {
      ensureLeaflet().then(function () {
        lmap.invalidateSize();
        renderLeaflet();
      }, function () {});
    } else {
      ensureAz();
      if (needFit) fit(); else drawAz();
    }
  }

  function redrawNight() {
    if (folded) return;
    if (st.view === 'merc' && lmap && lmap.hasLayer(lay.night)) lay.night.redraw();
    if (st.view === 'az') drawAzSoon();
  }

  function setFolded(f) {
    folded = f;
    $('mapBox').classList.toggle('folded', f);
    document.querySelector('.upper').classList.toggle('map-folded', f);
    $('mapFold').textContent = f ? 'Map ▸' : '▾';
    $('mapFold').title = f ? 'Show the map' : 'Fold the map away';
    try { localStorage.setItem(FOLD_KEY, f ? '1' : '0'); } catch (_) {}
    if (!f) render();
  }

  function wire() {
    $('mapBar').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-view')) {
        st.view = b.getAttribute('data-view');
        needFit = true;
        changed();
      } else if (b.hasAttribute('data-lbl')) {
        st.labels = b.getAttribute('data-lbl');
        changed();
      }
    });
    $('mapLines').addEventListener('change', function (e) { st.lines = e.target.checked; changed(); });
    $('mapGray').addEventListener('change', function (e) { st.gray = e.target.checked; changed(); });
    $('mapTime').addEventListener('input', function (e) {
      st.grayAt = Number(e.target.value) * 60000;
      syncTime();
      redrawNight();
    });
    $('mapTime').addEventListener('change', function () { if (opts.onState) opts.onState(); });
    $('mapNow').addEventListener('click', function () {
      st.grayAt = null;
      syncTime();
      redrawNight();
      if (opts.onState) opts.onState();
    });
    $('mapSite').addEventListener('change', function (e) {
      st.site = e.target.value;
      needFit = true;
      changed();
    });
    $('mapMyloc').addEventListener('change', function (e) {
      var raw = e.target.value.trim(), loc = MapCore.normLocator(raw);
      if (raw && !loc) { e.target.classList.add('bad'); return; }
      st.myloc = loc;
      recompute(true);
      if (opts.onState) opts.onState();
    });
    $('mapFit').addEventListener('click', function () { needFit = true; fit(); });
    $('mapAdif').addEventListener('click', function () { exportView('adi'); });
    $('mapCsv').addEventListener('click', function () { exportView('csv'); });
    $('mapExp').addEventListener('mouseenter', function () {
      var n = visibleRows().length;
      $('mapExp').title = 'Download the ' + n + ' QSO whose points are in view on the map';
    });
    $('mapFold').addEventListener('click', function () { setFolded(!folded); });
    $('azCanvas').addEventListener('click', onAzClick);
    $('azCanvas').addEventListener('mousemove', function (e) {
      e.target.style.cursor = azHit(e) ? 'pointer' : '';
    });
    $('azCanvas').addEventListener('wheel', function (e) {
      e.preventDefault();
      az.zoom = Math.max(0.5, Math.min(500, az.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
      closeAzPopup();
      drawAzSoon();
    }, { passive: false });
    if (window.ResizeObserver) new ResizeObserver(function () {
      if (lmap && st.view === 'merc') { lmap.invalidateSize(); if (needFit) fit(); }
      if (st.view === 'az') drawAzSoon();
    }).observe($('mapArea'));
    // The live grey line moves a quarter of a degree a minute.
    setInterval(function () { if (st.gray && st.grayAt == null) redrawNight(); }, 60000);
  }

  // ── API for viewer.js ───────────────────────────────────────────────────────

  function recompute(force) {
    agg = MapCore.aggregate(rows, logsById, st.myloc);
    timeRange();
    if (force) needFit = true;
    syncControls();
    render();
  }

  window.ViewerMap = {
    init: function (o) {
      opts = o || {};
      var f = null;
      try { f = localStorage.getItem(FOLD_KEY); } catch (_) {}
      // On a phone the map would push the log off the screen: it starts folded there.
      if (f == null) f = window.matchMedia && window.matchMedia('(max-width: 640px)').matches ? '1' : '0';
      wire();
      setFolded(f === '1');
    },
    setLogs: function (byId) { logsById = byId || {}; rowsKey = null; },
    // key: the filters that made rows; the map refits only when it changes,
    // not when the table is merely sorted.
    update: function (list, key) {
      rows = list;
      key = key + '|' + st.myloc;
      if (key === rowsKey && agg) return;
      rowsKey = key;
      recompute(true);
    },
    focus: function (r) {
      var t = parseWhen(r.when);
      if (!isNaN(t)) st.grayAt = t;
      var pos = MapCore.locate(r);
      focusKey = pos ? pos.key : null;
      syncTime();
      if (st.view === 'merc' && lmap && !folded) {
        renderLeaflet();
        var p = focusKey && agg && agg.points.filter(function (x) { return x.key === focusKey; })[0];
        if (p && !lmap.getBounds().contains([p.lat, p.lonU])) lmap.panTo([p.lat, p.lonU]);
        redrawNight();
      } else redrawNight();
      if (opts.onState) opts.onState();
    },
    writeParams: function (p) {
      if (st.view !== DEFAULTS.view) p.set('map', st.view);
      if (!st.lines) p.set('lines', '0');
      if (st.labels !== DEFAULTS.labels) p.set('lbl', st.labels);
      if (!st.gray) p.set('gl', '0');
      if (st.grayAt != null) p.set('glt', new Date(st.grayAt).toISOString().slice(0, 16) + 'Z');
      if (st.site) p.set('site', st.site);
      if (st.myloc) p.set('myloc', st.myloc);
    },
    readParams: function (p) {
      st.view = p.get('map') === 'az' ? 'az' : 'merc';
      st.lines = p.get('lines') !== '0';
      st.labels = p.get('lbl') === 'dot' ? 'dot' : 'call';
      st.gray = p.get('gl') !== '0';
      var t = Date.parse(p.get('glt') || '');
      st.grayAt = isNaN(t) ? null : t;
      st.site = p.get('site') || '';
      st.myloc = MapCore.normLocator(p.get('myloc'));
      rowsKey = null;   // the next update() draws, even with the same filters
    },
    // For tools/log-viewer-smoke.js.
    info: function () {
      return {
        view: st.view, leaflet: leafletState, az: az.state, folded: folded,
        sites: agg ? agg.sites.length : 0, points: agg ? agg.points.length : 0, links: agg ? agg.links.length : 0,
        bounds: lmap ? lmap.getBounds() : null, zoom: lmap ? lmap.getZoom() : null, azRadiusKm: az.radiusKm,
        grayAt: st.grayAt, focusKey: focusKey, inView: visibleRows().length,
        borders: lay.bordersKey || null,
      };
    },
  };
}());
