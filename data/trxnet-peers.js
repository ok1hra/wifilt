// The live list of TrxNet devices, shared by every page that needs one.
//
// This was copied by hand twice before it was a module -- SETUP's own panel and
// the RTTY page's FSK output picker -- with the CSS copied alongside it both
// times. The JS8 TELEMETRY panel would have been the third copy, which is where
// a shared file stops being tidiness and starts being the cheaper option.
//
// Two ways to use a row, because the callers genuinely want different things:
//   fillTarget()  - SETUP and RTTY pick a NET_ID and type it into a field.
//   onPick()      - TELEMETRY picks a whole DEVICE and keeps it selected, so the
//                   row has to stay marked afterwards.
//
// Polling runs only while the host <details> is open. The device answers one
// request at a time, and a closed panel asking every three seconds forever is
// three seconds of somebody else's waterfall.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.TrxnetPeers = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const POLL_MS = 3000;

  function fmtAge(s) {
    s = Math.max(0, s | 0);
    if (s < 60) return s + ' s';
    if (s < 3600) return (s / 60 | 0) + ' m';
    return (s / 3600 | 0) + ' h';
  }

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Every device on this network names itself "<prefix>.<2-hex-digit NET_ID>"
  // (trxDeviceName's own convention in wifilt.ino), so the trailing pair is the
  // id to fill. A name that does not fit still renders, just unclickable.
  function netIdFromName(name) {
    var m = /\.([0-9a-fA-F]{2})$/.exec(String(name || ''));
    return m ? m[1].toUpperCase() : null;
  }

  function mount(section, body, options) {
    if (!section || !body) return null;
    // Historic signature: the third argument used to be fillTarget itself.
    var opts = typeof options === "function" ? {fillTarget: options} : (options || {});
    var fillTarget = opts.fillTarget || null;
    var onPick = opts.onPick || null;
    var selected = opts.selected || null;
    var timer = null;
    var last = null;

    function note(text) {
      body.innerHTML = '<span class="trxnet-peers-empty">' + esc(text) + '</span>';
    }

    function row(name, ip, age, cls, badge) {
      var netId = netIdFromName(name);
      // With onPick the whole device is the thing being chosen, so a name that
      // carries no NET_ID is still a valid pick; only the fill-an-input callers
      // need the id to exist.
      var clickable = cls !== 'trxnet-peer-self' && (onPick ? true : !!netId);
      var here = selected && selected() === name;
      var tag = clickable ? 'button' : 'div';
      var classes = 'trxnet-peer ' + (clickable ? 'trxnet-peer-pick ' : '') +
        (here ? 'trxnet-peer-on ' : '') + cls;
      var attrs = clickable
        ? ' type="button" class="' + classes + '" data-netid="' + (netId || '') +
          '" data-peer="' + esc(name) + '"' +
          (here ? ' aria-pressed="true"' : ' aria-pressed="false"') +
          ' title="' + (onPick ? 'Use ' + esc(name) : 'Fill ' + netId) + '"'
        : ' class="' + classes + '"';
      return '<' + tag + attrs + '>' +
        '<span class="trxnet-peer-name">' + esc(name) + (badge || '') + '</span>' +
        '<span class="trxnet-peer-ip">' + esc(ip) + '</span>' +
        '<span class="trxnet-peer-age">' + esc(age) + '</span>' +
        '</' + tag + '>';
    }

    function render(d) {
      last = d;
      if (d.state === 'handoff') {
        note('TrxNet starts on the next restart — the hotspot is still running');
        return;
      }
      if (d.state === 'ap') { note('TrxNet not active in AP mode'); return; }
      if (d.state === 'disabled') { note('TrxNet disabled'); return; }
      var peers = (d.peers || []).slice();
      peers.sort(function (a, b) {
        if (!!b.prio !== !!a.prio) return b.prio - a.prio;   // priority first
        return String(a.name).localeCompare(String(b.name)); // then alphabetical
      });
      var html = '';
      if (d.self) html += row(d.self, 'this device', '', 'trxnet-peer-self', '');
      if (!peers.length) {
        html += '<span class="trxnet-peers-empty">No devices heard yet</span>';
      } else {
        peers.forEach(function (p) {
          html += row(p.name, p.ip, fmtAge(p.age),
            p.prio ? 'trxnet-peer-prio' : '',
            p.prio ? ' <span class="trxnet-prio-badge">PRIO</span>' : '');
        });
      }
      body.innerHTML = html;
    }

    function poll() {
      return fetch('/trxnet-peers.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(render)
        .catch(function () { note('Device list unavailable'); });
    }

    function start() {
      if (timer) return;
      poll();
      timer = setInterval(poll, POLL_MS);
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    section.addEventListener('toggle', function () {
      if (section.open) start(); else stop();
    });
    if (section.open) start();

    body.addEventListener('click', function (e) {
      var btn = e.target.closest('.trxnet-peer-pick');
      if (!btn) return;
      if (onPick) {
        onPick(btn.dataset.peer, btn.dataset.netid || null);
        if (last) render(last);      // re-mark the row that is now selected
        return;
      }
      var input = fillTarget && fillTarget();
      if (!input) return;
      input.value = btn.dataset.netid;
      // Both events, because the two callers listen to different ones: SETUP
      // revalidates on 'input', the RTTY page saves on 'change'. A value set from
      // script fires neither by itself.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    return {start, stop, refresh: poll,
      repaint: function () { if (last) render(last); }};
  }

  return {mount, fmtAge, netIdFromName, POLL_MS};
});
