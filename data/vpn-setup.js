// SETUP -> Remote access: reach this station from anywhere over the internet,
// without a public IP address -- an encrypted n2n VPN through the supernode on
// remoteqth.com (SOFTWARE.md "Remote access", docs/vpn-n2n-implementace.md).
//
// Native Linux only: setup.html loads this when /setup-data.json reports
// caps.vpn, and tools/prepare-spiffs-tree.sh keeps it off the box. All state is
// the device's (/vpn/status, polled while the section is open); the page keeps
// none of it, so two browsers never disagree.
(function () {
  'use strict';

  var section = document.getElementById('vpnSection');
  if (!section || section.dataset.ready) return;
  section.dataset.ready = '1';

  var POLL_OPEN_MS = 1500;
  var POLL_CLOSED_MS = 15000;

  var st = null;            // last /vpn/status
  // The manual on GitHub follows main, i.e. describes the newest version.
  var MANUAL = 'https://github.com/ok1hra/wifilt/blob/main/SOFTWARE.md#19-remote-access-over-the-internet-pc-and-raspberry-pi';
  var codeInfo = null;      // /vpn/code once revealed
  var pollTimer = null;
  var actionBusy = false;

  // ---- skeleton (static text only; device data always goes in as text) -------

  section.innerHTML =
    '<summary class="setup-section-title">Remote access ' +
      '<span class="setup-local-badge" title="Stored on this computer (vpn.json in its configuration directory). ' +
      'Part of Download config: the backup file then gives access to the station.">config</span>' +
      '<span id="vpnSummaryState" class="vpn-summary-state"></span></summary>' +
    '<div class="setup-section-body">' +
      '<p class="setup-hint">Reach this station from anywhere over the internet, even when it has no public IP ' +
        'address: an encrypted n2n VPN through the supernode on remoteqth.com. Another computer running wifilt ' +
        '(Linux) joins with the same pairing code and opens this station by its VPN address. The supernode only ' +
        'passes the traffic on; the key that encrypts it is known only to your devices. ' +
        '<a href="' + MANUAL + '" target="_blank" rel="noopener">How to connect, step by step &#8599;</a></p>' +
      '<p class="setup-note" id="vpnManual" hidden></p>' +
      '<div id="vpnInstall" hidden>' +
        '<p class="setup-note" id="vpnInstallText"></p>' +
        '<div class="unattended-actions"><button type="button" id="vpnInstallBtn">INSTALL n2n</button></div>' +
      '</div>' +
      '<div id="vpnPair" hidden>' +
        '<p class="setup-hint">Not paired yet. On the first device create a new network: it gets a pairing code. ' +
          'Every further device joins with that code.</p>' +
        '<div class="unattended-actions"><button type="button" id="vpnCreateBtn">CREATE NEW NETWORK</button></div>' +
        '<label>Pairing code' +
          '<div class="input-with-tip">' +
            '<input type="text" id="vpnJoinCode" spellcheck="false" autocomplete="off" ' +
              'placeholder="WL-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-X">' +
            '<button type="button" id="vpnJoinBtn" class="use-ip-btn">JOIN</button>' +
            '<span class="help-tip" data-tip="The code shown on a device that is already in the network (SETUP → Remote access). ' +
              'Lower case, spaces and a missing WL- are fine; a typo is caught by its last character.">?</span>' +
          '</div>' +
        '</label>' +
      '</div>' +
      '<div id="vpnPaired" hidden>' +
        '<dl class="unattended-grid" id="vpnGrid"></dl>' +
        '<label class="checkbox-row"><input type="checkbox" id="vpnEnabled"> Connected to the VPN' +
          '<span class="help-tip" data-tip="Off keeps the pairing code but stops the VPN on this computer. ' +
          'The VPN is its own service: it keeps running while wifilt restarts or updates.">?</span></label>' +
        '<label>Device name' +
          '<div class="input-with-tip">' +
            '<input type="text" id="vpnDesc" maxlength="15" spellcheck="false" autocomplete="off">' +
            '<button type="button" id="vpnDescBtn" class="use-ip-btn">SAVE</button>' +
            '<span class="help-tip" data-tip="How this computer is listed on the other devices, up to 15 of A-Z 0-9 / . _ -. ' +
              'The supernode derives the VPN address from it, so a new name also means a new address.">?</span>' +
          '</div>' +
        '</label>' +
        '<label>Pairing code' +
          '<div class="input-with-tip">' +
            '<input type="password" id="vpnCode" readonly spellcheck="false" autocomplete="off" value="••••••••••••">' +
            '<button type="button" id="vpnCodeShow" class="use-ip-btn" title="Show / hide the code">SHOW</button>' +
            '<button type="button" id="vpnCodeCopy" class="use-ip-btn">COPY</button>' +
            '<button type="button" id="vpnCodeQr" class="use-ip-btn">QR</button>' +
            '<span class="help-tip" data-tip="Enter this code on another device to bring it into this network. ' +
              'Anyone with the code can reach this station: keep it like a password.">?</span>' +
          '</div>' +
        '</label>' +
        '<div id="vpnQr" class="vpn-qr" hidden></div>' +
        '<div class="trxnet-devices">' +
          '<div class="trxnet-devices-head">Devices in this VPN <span class="trxnet-devices-live">live</span></div>' +
          '<table class="vpn-peers" id="vpnPeers"><tbody></tbody></table>' +
          '<p class="setup-hint" id="vpnNoPeers">No other device is connected right now.</p>' +
        '</div>' +
        '<details class="vpn-advanced"><summary>Advanced</summary>' +
          '<label>Supernode' +
            '<div class="input-with-tip">' +
              '<input type="text" id="vpnSupernode" spellcheck="false" autocomplete="off" placeholder="remoteqth.com:82">' +
              '<button type="button" id="vpnSupernodeBtn" class="use-ip-btn">SAVE</button>' +
              '<span class="help-tip" data-tip="host:port of the n2n 3 supernode. Every device of the network must use the same one. ' +
                'Empty = remoteqth.com:82.">?</span>' +
            '</div>' +
          '</label>' +
          '<p class="setup-hint">For another n2n 3 client (hin2n on Android, an edge on any computer) -- shown with the code. ' +
            'The edge for a Linux computer without wifilt is on the ' +
            '<a href="https://ok1hra.github.io/wifilt/#n2n" target="_blank" rel="noopener">download page &#8599;</a>, ' +
            'the steps in the <a href="' + MANUAL + '" target="_blank" rel="noopener">manual &#8599;</a>.</p>' +
          '<dl class="unattended-grid" id="vpnClientGrid"></dl>' +
        '</details>' +
        '<div class="unattended-actions"><button type="button" id="vpnLeaveBtn">LEAVE NETWORK</button></div>' +
      '</div>' +
      '<p class="setup-note" id="vpnHelper" hidden></p>' +
      '<pre class="unattended-log" id="vpnLog" hidden></pre>' +
      '<p class="setup-note unattended-bad" id="vpnError" hidden></p>' +
    '</div>';

  var style = document.createElement('style');
  style.textContent =
    '.vpn-summary-state{margin-left:8px;font-size:11px;font-weight:700;letter-spacing:.03em}' +
    '.vpn-summary-state.on{color:var(--accent,#0a0)}.vpn-summary-state.bad{color:#c62828}' +
    '.vpn-peers{width:100%;border-collapse:collapse;font-size:.85rem;margin:.25rem 0}' +
    '.vpn-peers td{padding:.15rem .4rem;border-bottom:1px solid rgba(127,127,127,.2);font-variant-numeric:tabular-nums}' +
    '.vpn-qr{margin:.5rem 0;background:#fff;padding:8px;display:inline-block}' +
    '.vpn-advanced{margin:.5rem 0}.vpn-advanced summary{cursor:pointer;opacity:.8}' +
    '@media (prefers-color-scheme: dark){.vpn-summary-state.bad{color:#ff6b6b}}';
  document.head.appendChild(style);
  section.hidden = false;

  function $(id) { return document.getElementById(id); }

  // ---- talking to the device ------------------------------------------------------

  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function showError(text) {
    var e = $('vpnError');
    e.textContent = text || '';
    e.hidden = !text;
  }

  function act(promise) {
    actionBusy = true;
    showError('');
    return promise
      .then(function (d) { return d; })
      .catch(function (err) { showError(err.message || String(err)); throw err; })
      .finally(function () {
        actionBusy = false;
        poll(true);
      });
  }

  // ---- what the state means ---------------------------------------------------

  function stateOf(s) {
    if (!s) return { text: '', cls: '' };
    if (s.mode === 'manual') return { text: 'NOT INSTALLED', cls: '' };
    if (!s.paired) return { text: 'NOT PAIRED', cls: '' };
    if (!s.enabled) return { text: 'OFF', cls: '' };
    if (s.mode === 'no-n2n') return { text: 'n2n MISSING', cls: 'bad' };
    if (s.edgeError) return { text: 'ERROR', cls: 'bad' };
    if (!s.at) return { text: 'STARTING', cls: '' };
    // No answer from the edge's management port: with supernode-assigned
    // addresses the edge serves it only once a supernode has answered (until
    // then it waits in its bootstrap loop, without wlvpn0) -- so this is the
    // state of a supernode out of reach (UDP to port 82 blocked), not a start.
    if (!s.edge || !s.sn) return { text: 'CONNECTING', cls: '' };
    if (Number(s.sn.age) > 60) return { text: 'SUPERNODE LOST', cls: 'bad' };
    var n = Array.isArray(s.peers) ? s.peers.length : 0;
    return { text: 'CONNECTED · ' + n + (n === 1 ? ' device' : ' devices'), cls: 'on' };
  }

  function ago(sec) {
    sec = Number(sec);
    if (!isFinite(sec) || sec < 0) return '?';
    if (sec < 90) return sec + ' s ago';
    if (sec < 5400) return Math.round(sec / 60) + ' min ago';
    return Math.round(sec / 3600) + ' h ago';
  }

  function gridRow(dl, name, value, bad) {
    var dt = document.createElement('dt');
    dt.textContent = name;
    var dd = document.createElement('dd');
    dd.textContent = value;
    if (bad) dd.className = 'unattended-bad';
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  // ---- render -------------------------------------------------------------------

  function render(s) {
    st = s;
    var state = stateOf(s);
    var sum = $('vpnSummaryState');
    sum.textContent = state.text;
    sum.className = 'vpn-summary-state ' + state.cls;

    var manual = s.mode === 'manual';
    $('vpnManual').hidden = !manual;
    $('vpnManual').textContent = manual
      ? 'Remote access needs the VPN service: ' + (s.reason || 'install wifilt with sudo ./install.sh') + '.'
      : '';

    var noN2n = s.mode === 'no-n2n';
    $('vpnInstall').hidden = !noN2n;
    if (noN2n) {
      $('vpnInstallText').textContent = s.locked
        ? 'n2n 3.1.1 is not installed, and this system is locked (power-loss protection), so nothing can be ' +
          'installed now. Unlock it and run the Raspberry Pi installer (wifilt-pi-setup) with its vpn step.'
        : 'n2n 3.1.1 is not installed on this computer yet. INSTALL puts in the copy built for this release of ' +
          'WIFILT, or, where that does not run, builds it from source (github.com/ntop/n2n, tag 3.1.1, checked) -- ' +
          'that needs the internet and takes a few minutes on a Raspberry Pi.';
      $('vpnInstallBtn').hidden = !!s.locked;
    }

    $('vpnPair').hidden = manual || s.paired;
    $('vpnPaired').hidden = !s.paired;

    if (s.paired) {
      var grid = $('vpnGrid');
      grid.textContent = '';
      gridRow(grid, 'State', state.text + (s.edgeError ? ' -- ' + s.edgeError : ''), state.cls === 'bad');
      gridRow(grid, 'This device', s.desc || '?');
      gridRow(grid, 'VPN address', s.ip ? s.ip.replace(/\/\d+$/, '') : '(none yet)');
      gridRow(grid, 'Supernode', s.supernode + (s.sn ? ' -- answered ' + ago(s.sn.age)
                                                      : s.enabled && s.at ? ' -- no answer yet' : ''),
              s.enabled && s.sn && Number(s.sn.age) > 60);
      if (s.viaVpn) gridRow(grid, 'This page', 'is connected through this VPN', false);

      var en = $('vpnEnabled');
      if (document.activeElement !== en && !actionBusy) en.checked = !!s.enabled;
      var desc = $('vpnDesc');
      if (document.activeElement !== desc && !desc.dataset.dirty) desc.value = s.desc || '';
      var sn = $('vpnSupernode');
      if (document.activeElement !== sn && !sn.dataset.dirty) sn.value = s.supernode || '';

      var body = $('vpnPeers').tBodies[0];
      body.textContent = '';
      var peers = Array.isArray(s.peers) ? s.peers : [];
      peers.forEach(function (p) {
        var tr = document.createElement('tr');
        var ip = String(p.ip || '').replace(/\/\d+$/, '');
        [p.desc || '(no name yet)', ip || '?', p.mode === 'p2p' ? 'direct' : 'via supernode', ago(p.age)].forEach(function (t) {
          var td = document.createElement('td');
          td.textContent = t;
          tr.appendChild(td);
        });
        var td = document.createElement('td');
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          var a = document.createElement('a');
          a.href = 'http://' + ip + '/';
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = 'open ↗';
          td.appendChild(a);
        }
        tr.appendChild(td);
        body.appendChild(tr);
      });
      $('vpnNoPeers').hidden = peers.length > 0;
    }

    renderHelper(s.helper);

    if (location.hash === '#vpnSection' && !section.dataset.revealed) {
      section.dataset.revealed = '1';
      section.open = true;
      section.scrollIntoView({ block: 'start' });
    }
  }

  // The root helper's last action: a running install shows its progress, a
  // failure or an undone change stays visible, a success only briefly.
  function renderHelper(h) {
    var p = $('vpnHelper'), log = $('vpnLog');
    p.hidden = true;
    log.hidden = true;
    if (!h || !h.state || h.state === 'idle') return;
    var age = Date.now() / 1000 - Number(h.ts || 0);
    var text = '', bad = false;
    if (h.state === 'running') {
      text = 'Working: ' + (h.msg || h.phase || '…');
    } else if (h.state === 'reverted') {
      text = 'Your last change was undone and the previous settings are back: ' + (h.error || h.msg) + '.';
      bad = true;
    } else if (h.state === 'failed') {
      text = (h.msg || 'Failed') + ': ' + (h.error || '') ;
      bad = true;
    } else if (h.state === 'done' && age < 120) {
      text = h.msg || 'Done';
    }
    if (bad && age > 3600) return;   // an old failure is not news
    if (!text) return;
    p.textContent = text;
    p.className = 'setup-note' + (bad ? ' unattended-bad' : '');
    p.hidden = false;
    if (h.action === 'install' && Array.isArray(h.log) && h.log.length && (h.state === 'running' || bad)) {
      log.textContent = h.log.join('\n');
      log.hidden = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  function renderCode() {
    var shown = !!codeInfo;
    var input = $('vpnCode');
    input.type = shown ? 'text' : 'password';
    input.value = shown ? codeInfo.code : '••••••••••••';
    $('vpnCodeShow').textContent = shown ? 'HIDE' : 'SHOW';
    var g = $('vpnClientGrid');
    g.textContent = '';
    if (shown) {
      gridRow(g, 'Supernode', codeInfo.supernode);
      gridRow(g, 'Community', codeInfo.community);
      gridRow(g, 'Key', codeInfo.key);
      gridRow(g, 'Encryption', codeInfo.cipher + ' (-A4)');
      gridRow(g, 'IP address', 'from the supernode (DHCP/auto)');
    } else {
      gridRow(g, 'Code', 'press SHOW next to the pairing code');
    }
  }

  // ---- polling ------------------------------------------------------------------

  function poll(now) {
    window.clearTimeout(pollTimer);
    var run = function () {
      getJson('/vpn/status')
        .then(render)
        .catch(function () {})
        .finally(function () {
          pollTimer = window.setTimeout(run, section.open ? POLL_OPEN_MS : POLL_CLOSED_MS);
        });
    };
    if (now) run();
    else pollTimer = window.setTimeout(run, section.open ? POLL_OPEN_MS : POLL_CLOSED_MS);
  }
  section.addEventListener('toggle', function () { if (section.open) poll(true); });

  // ---- actions ------------------------------------------------------------------

  function viaVpnConfirm(text) {
    if (!st || !st.viaVpn) return true;
    return window.confirm('This page is connected through this VPN. ' + text);
  }

  $('vpnInstallBtn').addEventListener('click', function () {
    act(postJson('/vpn/install'));
  });

  $('vpnCreateBtn').addEventListener('click', function () {
    act(postJson('/vpn/pair', { action: 'new' })).then(function (d) {
      codeInfo = null;
      return getJson('/vpn/code').then(function (c) { codeInfo = c; renderCode(); });
    }).catch(function () {});
  });

  $('vpnJoinBtn').addEventListener('click', function () {
    var code = $('vpnJoinCode').value.trim();
    if (!code) { showError('Enter the pairing code from a device that is already in the network.'); return; }
    act(postJson('/vpn/pair', { action: 'join', code: code })).then(function () {
      $('vpnJoinCode').value = '';
    }).catch(function () {});
  });

  $('vpnEnabled').addEventListener('change', function (e) {
    var on = e.target.checked;
    if (!on && !viaVpnConfirm('Switching it off cuts this page off; the station stays reachable from its own ' +
                              'network only. Switch it off?')) {
      e.target.checked = true;
      return;
    }
    act(postJson('/vpn/set', { enabled: on })).catch(function () { e.target.checked = !on; });
  });

  ['vpnDesc', 'vpnSupernode'].forEach(function (id) {
    $(id).addEventListener('input', function () { $(id).dataset.dirty = '1'; });
  });

  $('vpnDescBtn').addEventListener('click', function () {
    var desc = $('vpnDesc').value.trim().toUpperCase();
    if (!viaVpnConfirm('A new name gives this device a new VPN address, so this page loses its connection; ' +
                       'the device list on your other computer shows the new one. Rename it?')) return;
    act(postJson('/vpn/set', { desc: desc })).then(function () { delete $('vpnDesc').dataset.dirty; })
      .catch(function () {});
  });

  $('vpnSupernodeBtn').addEventListener('click', function () {
    var sn = $('vpnSupernode').value.trim();
    if (!viaVpnConfirm('If this device cannot reach you through the new supernode within two minutes, ' +
                       'the previous one comes back by itself. Change it?')) return;
    act(postJson('/vpn/set', { supernode: sn })).then(function () { delete $('vpnSupernode').dataset.dirty; })
      .catch(function () {});
  });

  $('vpnLeaveBtn').addEventListener('click', function () {
    var text = st && st.viaVpn
      ? 'This page is connected through this VPN: leaving cuts it off for good, and the station can then be ' +
        'paired again only from its own network. Leave the network?'
      : 'Leave this network? This device forgets the pairing code; your other devices keep it.';
    if (!window.confirm(text)) return;
    codeInfo = null;
    renderCode();
    act(postJson('/vpn/leave')).catch(function () {});
  });

  $('vpnCodeShow').addEventListener('click', function () {
    if (codeInfo) { codeInfo = null; renderCode(); $('vpnQr').hidden = true; return; }
    getJson('/vpn/code').then(function (c) { codeInfo = c.code ? c : null; renderCode(); })
      .catch(function (err) { showError(err.message); });
  });

  function withCode(fn) {
    if (codeInfo) { fn(codeInfo.code); return; }
    getJson('/vpn/code').then(function (c) {
      if (!c.code) return;
      codeInfo = c;
      renderCode();
      fn(c.code);
    }).catch(function (err) { showError(err.message); });
  }

  // navigator.clipboard needs a secure context, and http://station is not one.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(function () {});
      return;
    }
    var t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); } catch (e) { /* the code stays visible to copy by hand */ }
    t.remove();
  }

  $('vpnCodeCopy').addEventListener('click', function () {
    withCode(function (code) {
      copyText(code);
      var b = $('vpnCodeCopy');
      b.textContent = 'COPIED';
      window.setTimeout(function () { b.textContent = 'COPY'; }, 1500);
    });
  });

  // The same encoder the AP hand-off screen loads on demand.
  function qrInto(el, text) {
    el.textContent = '';
    var draw = function () {
      if (window.QRCode) new window.QRCode(el, { text: text, width: 168, height: 168 });
    };
    if (window.QRCode) { draw(); return; }
    var s = document.createElement('script');
    s.src = '/qrcode.min.js';
    s.onload = draw;
    s.onerror = function () { el.hidden = true; };
    document.head.appendChild(s);
  }

  $('vpnCodeQr').addEventListener('click', function () {
    var box = $('vpnQr');
    if (!box.hidden) { box.hidden = true; box.textContent = ''; return; }
    withCode(function (code) { box.hidden = false; qrInto(box, code); });
  });

  renderCode();
  poll(true);
})();
