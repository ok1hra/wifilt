/**
 * port-move-banner.js -- "this is not the address your QSO log lives at"
 *
 * The browser keeps the QSO log (IndexedDB) per origin, and the port is part of
 * the origin. The PC build moves HTTP to 8080 by itself when it cannot bind 80
 * (no CAP_NET_BIND_SERVICE -- which every upgrade or rebuild drops, because the
 * capability lives on the file). Without a word, that looks like an empty log.
 *
 * /ports.js says where HTTP is now and where the log lives (homeHttp, kept by the
 * PC build in its config directory; the box always reports 0 = nothing to say).
 * Dismissable for this page view only, like the spine's banners: the state is
 * derived, so it comes back by itself while it is still true.
 */
(function () {
  "use strict";

  function show() {
    var ports = window.WIFILT_PORTS || {};
    var home = Number(ports.homeHttp) || 0;
    var now = Number(location.port) || (location.protocol === "https:" ? 443 : 80);
    if (!home || home === now || !document.body) return;

    var homeUrl = location.protocol + "//" + location.hostname + (home === 80 ? "" : ":" + home) + "/";
    var box = document.createElement("div");
    box.className = "port-move-banner";
    box.setAttribute("role", "status");
    box.style.cssText = "position:relative;z-index:50;margin:0;padding:8px 40px 8px 12px;" +
      "background:#3a2a00;color:#ffd27a;border-bottom:2px solid #c98a00;" +
      "font:13px/1.4 system-ui,sans-serif";
    box.innerHTML =
      "<b>WIFILT is on port " + now + " this time, not " + home + ".</b> " +
      "The browser keeps the QSO log per address, so the log from " +
      "<a style='color:inherit' href='" + homeUrl + "'>" + homeUrl + "</a> is not shown here. " +
      "Port " + home + " usually failed because the binary lost its permission after an " +
      "upgrade or rebuild: <code style='user-select:all'>sudo setcap " +
      "cap_net_bind_service=+ep &lt;path to wifilt&gt;</code>, then restart WIFILT.";
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Hide for now";
    close.style.cssText = "position:absolute;right:8px;top:6px;background:none;border:0;" +
      "color:inherit;font-size:18px;cursor:pointer";
    close.addEventListener("click", function () { box.remove(); });
    box.appendChild(close);
    document.body.insertBefore(box, document.body.firstChild);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show);
  else show();
})();
