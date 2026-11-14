// SPDX-License-Identifier: GPL-3.0-or-later
// TS-480 LCD renderer, shared by the full panel window (panel.html) and the
// QRPlog palette (qrplog.js, which runs in wifilt's page). Port of the LCD
// part of ts-480-web-panel's ts480/web/index.html: segment maps, icons, the
// menu texts the panel firmware draws itself, setting read-outs.
//
//   const lcd = Ts480Lcd.mount(svgElement);   // svg must be in the document and visible
//   lcd.render(stateMessage);                 // {"type":"state",...} from the WebSocket
//
// Coordinates are the panel photo's; the LCD window is LCD_VIEWBOX. All CSS
// is scoped under .ltx480-lcd so it can live inside another page.
(function () {
  "use strict";
  if (window.Ts480Lcd) return;

  const NS = "http://www.w3.org/2000/svg";
  const LX = 287, LY = 303, LW = 946, LH = 167;
  const LCD_VIEWBOX = `${LX} ${LY} ${LW} ${LH}`;

  function el(tag, attrs = {}, parent = null, text = null) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function injectCss() {
    if (document.getElementById("ltx480-lcd-css")) return;
    const style = document.createElement("style");
    style.id = "ltx480-lcd-css";
    // LCD colours sampled from a photo of a lit TS-480 display.
    style.textContent = `
.ltx480-lcd{--seg:#2a1503;--ghost:rgba(110,45,0,.075);--lcd-hi:#ffb53a;--lcd-lo:#e07800}
.ltx480-lcd text{font-family:"Liberation Sans Narrow","Nimbus Sans Narrow","Arial Narrow","Roboto Condensed","DejaVu Sans Condensed",sans-serif}
.ltx480-lcd .lcdbg{transition:opacity .2s}
.ltx480-lcd .s{stroke:var(--ghost);fill:none;stroke-linecap:round}
.ltx480-lcd .s.on{stroke:var(--seg)}
.ltx480-lcd .f{fill:var(--ghost)}
.ltx480-lcd .f.on{fill:var(--seg)}
.ltx480-lcd .fs{stroke:var(--ghost)} .ltx480-lcd .fs.on{stroke:var(--seg)}
.ltx480-lcd text.f,.ltx480-lcd text.invt{font-weight:700}
.ltx480-lcd .bar{fill:var(--ghost)}
.ltx480-lcd .bar.on{fill:var(--seg)}
.ltx480-lcd .inv{fill:var(--ghost)} .ltx480-lcd .inv.on{fill:var(--seg)}
.ltx480-lcd .invt{fill:transparent} .ltx480-lcd .invt.on{fill:var(--lcd-hi)}
.ltx480-lcd.off .s,.ltx480-lcd.off .f,.ltx480-lcd.off .fs,.ltx480-lcd.off .bar,.ltx480-lcd.off .inv{opacity:0}
.ltx480-lcd.unlit{--ghost:rgba(40,40,30,.06);--seg:#1d1c18}
.ltx480-lcd.unlit .invt.on{fill:#9c998f}
.ltx480-lcd .offtxt{fill:var(--lcd-lo)}`;
    document.head.appendChild(style);
  }

  // ---- segment maps --------------------------------------------------------
  const SEG7 = { "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc", "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
    " ": "", "-": "g", "_": "d", "A": "abcefg", "B": "cdefg", "C": "adef", "D": "bcdeg", "E": "adefg", "F": "aefg", "G": "acdef", "H": "bcefg",
    "I": "bc", "J": "bcde", "L": "def", "N": "ceg", "O": "abcdef", "P": "abefg", "Q": "abcfg", "R": "eg", "S": "afgcd", "T": "defg", "U": "bcdef", "Y": "bcdfg", "=": "dg", "?": "abeg",
    "o": "cdeg", "n": "ceg", "b": "cdefg", "c": "deg", "t": "defg", "u": "cde", "r": "eg", "h": "cefg", "d": "bcdeg" };
  const SEG14 = { "0": "abcdefjk", "1": "bcj", "2": "abdeg1g2", "3": "abcdg2", "4": "bcfg1g2", "5": "adfg1m", "6": "acdefg1g2", "7": "abc", "8": "abcdefg1g2", "9": "abcdfg1g2",
    "A": "abcefg1g2", "B": "abcdg2il", "C": "adef", "D": "abcdil", "E": "adefg1", "F": "aefg1", "G": "acdefg2", "H": "bcefg1g2", "I": "adil", "J": "bcde",
    "K": "efg1jm", "L": "def", "M": "bcefhj", "N": "bcefhm", "O": "abcdef", "P": "abefg1g2", "Q": "abcdefm", "R": "abefg1g2m", "S": "acdfg1g2", "T": "ail",
    "U": "bcdef", "V": "efjk", "W": "bcefkm", "X": "hjkm", "Y": "hjl", "Z": "adjk", " ": "", "-": "g1g2", "_": "d", "+": "g1g2il", "/": "jk", "*": "g1g2hijklm",
    "=": "dg1g2", "<": "jm", ">": "hk", "(": "jm", ")": "hk", "?": "abg2l", "'": "i", "\"": "fi", ",": "k", "#": "bcdg1g2il", "%": "cfg1g2jk", "&": "adeg1hjm",
    "°": "abfg1g2", "|": "il", "\\": "hm", "@": "abdefg2i", "$": "acdfg1g2il" };

  function seg7Polys(w, h, t, g) {
    const x0 = 0, x1 = w, y0 = 0, y2 = h, ym = h / 2, t2 = t / 2;
    const P = pts => pts.map(p => p.map(v => v.toFixed(2)).join(",")).join(" ");
    return {
      a: P([[x0 + g, y0], [x1 - g, y0], [x1 - t - g, y0 + t], [x0 + t + g, y0 + t]]),
      d: P([[x0 + g, y2], [x1 - g, y2], [x1 - t - g, y2 - t], [x0 + t + g, y2 - t]]),
      f: P([[x0, y0 + g], [x0 + t, y0 + t + g], [x0 + t, ym - t2 - g], [x0 + t2, ym - g], [x0, ym - t2 - g]]),
      e: P([[x0, y2 - g], [x0 + t, y2 - t - g], [x0 + t, ym + t2 + g], [x0 + t2, ym + g], [x0, ym + t2 + g]]),
      b: P([[x1, y0 + g], [x1 - t, y0 + t + g], [x1 - t, ym - t2 - g], [x1 - t2, ym - g], [x1, ym - t2 - g]]),
      c: P([[x1, y2 - g], [x1 - t, y2 - t - g], [x1 - t, ym + t2 + g], [x1 - t2, ym + g], [x1, ym + t2 + g]]),
      g: P([[x0 + t2 + g, ym], [x0 + t + g, ym - t2], [x1 - t - g, ym - t2], [x1 - t2 - g, ym], [x1 - t - g, ym + t2], [x0 + t + g, ym + t2]]),
    };
  }
  function seg14Lines(w, h) {
    const x0 = 2, x1 = w / 2, x2 = w - 2, y0 = 2, y1 = h / 2, y2 = h - 2, g = 1.9;
    return { a: [x0 + g, y0, x2 - g, y0], b: [x2, y0 + g, x2, y1 - g], c: [x2, y1 + g, x2, y2 - g], d: [x0 + g, y2, x2 - g, y2],
      e: [x0, y1 + g, x0, y2 - g], f: [x0, y0 + g, x0, y1 - g], g1: [x0 + g, y1, x1 - g, y1], g2: [x1 + g, y1, x2 - g, y1],
      h: [x0 + g + 1, y0 + g + 1, x1 - g, y1 - g], i: [x1, y0 + g, x1, y1 - g], j: [x2 - g - 1, y0 + g + 1, x1 + g, y1 - g],
      k: [x1 - g, y1 + g, x0 + g + 1, y2 - g - 1], l: [x1, y1 + g, x1, y2 - g], m: [x1 + g, y1 + g, x2 - g - 1, y2 - g - 1] };
  }

  // ---- menu texts (panel ROM, read off the real panel) --------------------
  const OO = ["oFF", "on"], OFF9 = ["oFF", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const EQ = ["oFF", "Hb1", "Hb2", "FP", "bb1", "bb2", "c", "U"];
  const MENU = [
    ["DISPLAY BRIGHTNESS", ["oFF", "1", "2", "3", "4"]],
    ["KEY ILLUMINATION", OO],
    ["AUTO MODE OPERATION", OO],
    ["TUNING CONTROL CHANGE RATE PER REVOLUTION", ["250", "500", "1000"]],
    ["TUNING CONTROL WITH MULTI/CH CONTROL FREQUENCY STEP SIZE", OO],
    ["FREQUENCY ROUNDING OFF WHEN USING MULTI/CH CONTROL", OO],
    ["MULTI/CH CONTROL 9KHZ STEP CHANGE IN AM BROADCAST BAND", OO],
    ["TEMPORARY FREQUENCY CHANGE AFTER MEMORY RECALL", OO],
    ["PROGRAM SCAN PARTIALLY SLOWED", OO],
    ["PROGRAM SLOW-SCAN RANGE", ["100", "200", "300", "400", "500"]],
    ["PROGRAM SCAN HOLD", OO],
    ["SCAN RESUME METHOD", ["to", "co"]],
    ["BEEP VOLUME", OFF9],
    ["SIDETONE VOLUME", OFF9],
    ["MESSAGE PLAYBACK VOLUME", OFF9],
    ["VOICE VOLUME", OFF9.slice(0, 8)],
    ["VOICE SPEED", ["0", "1", "2", "3", "4"]],
    ["CW FILTER FOR SSB MODE", OO],
    ["DSP RX EQUALIZER", EQ],
    ["DSP TX EQUALIZER", EQ],
    ["TX FILTER BANDWIDTH FOR SSB OR AM", ["2.0", "2.4"]],
    ["FINE TRANSMIT POWER ADJUSTMENT", OO],
    ["TIME-OUT TIMER", ["oFF", "3", "5", "10", "20", "30"]],
    ["TRANSVERTER FREQUENCY DISPLAY", OO],
    ["AUTOMATIC POWER DOWN IN TRANSVERTER MODE", OO],
    ["TX HOLD ANTENNA TUNER", OO],
    ["ANTENNA TUNER FOR RECEPTION", OO],
    ["EXTERNAL AT OPERATION MODE", ["At1", "At2"]],
    ["HF LINEAR AMPLIFIER CONTROL RELAY", ["oFF", "1", "2", "3"]],
    ["50MHZ LINEAR AMPLIFIER CONTROL RELAY", ["oFF", "1", "2", "3"]],
    ["CONSTANT RECORDING", OO],
    ["PLAYBACK REPEAT", OO],
    ["PLAYBACK INTERVAL TIME", v => String(v)],
    ["KEYING PRIORITY OVER PLAYBACK", OO],
    ["CW RX PITCH/TX SIDETONE FREQUENCY", v => String(400 + 50 * v)],
    ["CW WEIGHTING", v => v === 0 ? "AUto" : (2.4 + 0.1 * v).toFixed(1)],
    ["REVERSED CW WEIGHTING", OO],
    ["BUG KEY FUNCTION", OO],
    ["REVERSE DOT AND DASH KEYING", OO],
    ["AUTO CW TX WHEN KEYING IN SSB", OO],
    ["FREQUENCY CORRECTION FOR SSB-TO-CW CHANGE", OO],
    ["FSK SHIFT", ["170", "200", "425", "850"]],
    ["FSK KEY-DOWN POLARITY", OO],
    ["FSK TONE FREQUENCY", ["1275", "2125"]],
    ["FM MIC GAIN", ["1", "2", "3"]],
    ["FILTER FOR DATA COMMUNICATIONS", OO],
    ["AF INPUT LEVEL FOR DATA COMMUNICATIONS", v => String(v)],
    ["AF OUTPUT LEVEL FOR DATA COMMUNICATIONS", v => String(v)],
    ["FRONT PANEL PF KEY ASSIGNMENT", v => String(v).padStart(2, "0")],
    ["MIC PF1 KEY ASSIGNMENT", v => String(v).padStart(2, "0")],
    ["MIC PF2 KEY ASSIGNMENT", v => String(v).padStart(2, "0")],
    ["MIC PF3 KEY ASSIGNMENT", v => String(v).padStart(2, "0")],
    ["MIC PF4 KEY ASSIGNMENT", v => String(v).padStart(2, "0")],
    ["TRANSFER SPLIT FREQUENCY DATA TO ANOTHER TRANSCEIVER", OO],
    ["COPY SPLIT FREQUENCY DATA TO VFO", OO],
    ["TX INHIBIT", OO],
    ["COM PORT PARAMETERS", ["4800", "9600", "19200", "38400", "57600", "115200"]],
    ["REVERSE DTS POLARITY", OO],
    ["BUSY FREQUENCY TRANSMISSION LOCKOUT", OO],
    ["AUTO POWER OFF", ["oFF", "60", "120", "180"]],
    ["VOX OPERATION WITH DATA INPUT", OO],
  ];
  function menuValue(item, v) {
    const m = MENU[item]; if (!m || v == null) return "";
    return typeof m[1] === "function" ? m[1](v) : (m[1][v] ?? String(v));
  }

  // ---- setting read-outs on the sub-display ("2x" + "4hh") ------------------
  const vis = t => t.replace(/\./g, "").length;
  const padL = (t, n) => " ".repeat(Math.max(0, n - vis(String(t)))) + t;
  const HI_SSB = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000, 3400, 4000, 5000];
  const LO_SSB = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  const HI_AM = [2500, 3000, 4000, 5000], LO_AM = [0, 100, 200, 500];
  const STEP_SSB = ["500", "1k", "2.5k", "5k", "10k"];
  const STEP_FM = ["5k", "6.25k", "10k", "12.5k", "15k", "20k", "25k", "30k", "50k", "100k"];
  const isAM = s => s.mode_code === 5, isFMAM = s => s.mode_code === 4 || s.mode_code === 5;
  const SUBMODE = {
    "Q": (v) => "PWR-" + padL(v, 4),
    "N": (v) => "MIC-" + padL(v, 4),
    "P": (v) => "KEY-" + padL(10 + v, 4),
    "^": (v) => "TX M.-" + (v ? padL(v, 3) : "OFF"),
    "O": (v) => "RF G.-" + padL(v, 3),
    "R": (v) => "V.DLY-" + padL(5 * v, 3),
    "M": (v) => "NB LV.-" + padL(v + 1, 2),
    "J": (v) => "VOX G.-" + padL(v, 2),
    "K": (v) => "PRO.I-" + padL(v, 3),
    "`": (v) => "DNL LV.-" + (v + 1),
    "?": (v, s) => "STP-" + padL((isFMAM(s) ? STEP_FM : STEP_SSB)[v] ?? v, 4),
    "G": (v) => "VGROUP-" + v,
    "5": (v, s) => "HI-" + padL((isAM(s) ? HI_AM : HI_SSB)[v] ?? v, 5),
    "6": (v, s) => "LO-" + padL((isAM(s) ? LO_AM : LO_SSB)[v] ?? v, 5),
    "9": (v) => "WDH-" + padL([50, 80, 100, 150, 200, 300, 400, 500, 600, 1000, 2000][v] ?? v, 4),
    ":": (v) => "WDH-" + padL([250, 500, 1000, 1500][v] ?? v, 4),
    "C": (v) => "NR1-" + (v ? padL(v, 4) : "AUTO"),
    "b": () => "TX TUNE",
  };
  function subReadout(s) {
    const f = SUBMODE[s.param];
    return f && (s.menu_value != null || f.length === 0) ? f(s.menu_value, s) : null;
  }
  const MODE_TXT = { 1: "LSB", 2: "USB", 3: "CW", 4: "FM", 5: "AM", 6: "FSK", 7: "CWR", 9: "FSR" };

  function flag(c, b) { return s => !!s && (parseInt(s.flags[c] || "80", 16) & (1 << b)) !== 0; }
  function any(...fs) { return s => fs.some(f => f(s)); }
  const ALWAYS = s => !!s;
  let instances = 0;

  function mount(svg) {
    injectCss();
    const id = "ltx480-" + (++instances);
    const defs = el("defs", {}, svg);
    const lit = el("radialGradient", { id: id + "-lcd", cx: ".45", cy: ".45", r: ".75" }, defs);
    el("stop", { offset: "0", "stop-color": "#ffb53a" }, lit);
    el("stop", { offset: ".6", "stop-color": "#ff9a12" }, lit);
    el("stop", { offset: "1", "stop-color": "#e07800" }, lit);
    const unlitG = el("radialGradient", { id: id + "-lcdoff", cx: ".45", cy: ".45", r: ".75" }, defs);
    el("stop", { offset: "0", "stop-color": "#9c998f" }, unlitG);
    el("stop", { offset: ".7", "stop-color": "#86837a" }, unlitG);
    el("stop", { offset: "1", "stop-color": "#6f6c64" }, unlitG);

    const L = el("g", { class: "ltx480-lcd off" }, svg);
    const bg = el("rect", { class: "lcdbg", x: LX, y: LY, width: LW, height: LH, rx: 4, fill: `url(#${id}-lcd)` }, L);
    el("rect", { x: LX, y: LY, width: LW, height: LH, rx: 4, fill: "none", stroke: "rgba(0,0,0,.4)", "stroke-width": 3 }, L);
    const OFFTXT = el("text", { class: "offtxt", x: LX + LW / 2, y: LY + LH / 2 + 7, "text-anchor": "middle", "font-size": 20, "font-weight": 800, "letter-spacing": 5 }, L, "NO LINK");

    const IND = [];
    function ind(x, y, text, cond, size = 20, attrs = {}) {
      const t = el("text", { class: "f", x, y, "font-size": size, ...attrs }, L, text);
      IND.push([t, cond]); return t;
    }
    // Lays items out left to right by their real text width -- needs the svg
    // rendered, hence "mount when visible".
    function seq(x, y, size, items) {
      for (const it of items) {
        const [text, cond, gap = 0, sz = size] = it;
        const t = ind(x, y, text, cond, sz);
        x += t.getComputedTextLength() + gap;
      }
      return x;
    }

    // top row
    const TOP = 336, TS = 20;
    seq(296, TOP, TS, [["R◂", flag("D", 5)], ["AT", flag("D", 6)], ["▸T", flag("D", 4)]]);
    seq(383, TOP, TS, [["1◂", flag("@", 2)], ["ANT", any(flag("@", 2), flag("@", 3))], ["▸2", flag("@", 3)]]);
    ind(467, TOP, "ATT", flag("?", 1), TS); ind(510, TOP, "PRE", flag("?", 0), TS);
    ind(552, TOP, "VOX", flag("?", 3), TS); ind(595, TOP, "PROC", flag("?", 2), TS);
    ind(712, TOP, "★", flag("@", 1), TS);
    IND.push([el("rect", { class: "f", x: 738, y: TOP - 15, width: 24, height: 15, rx: 2 }, L), flag("A", 6)]);
    ind(772, TOP, "NB", flag("?", 4), TS);
    ind(813, TOP, "AGC", flag("A", 0), TS); ind(861, TOP, "OF", flag("A", 1), TS); ind(886, TOP, "F", flag("A", 2), TS);
    ind(910, TOP, "NAR", flag("A", 3), TS); ind(953, TOP, "2", flag("A", 4), TS); ind(974, TOP, "MHz", flag("?", 5), TS);
    ind(1033, TOP, "FINE", flag("?", 6), TS); ind(1079, TOP - 1, "✪", flag("@", 0), 16);
    { const r = el("rect", { class: "inv", x: 1097, y: 325, width: 62, height: 21, rx: 3 }, L);
      const t = el("text", { class: "invt", x: 1128, y: 343, "font-size": 20, "font-weight": 900, "text-anchor": "middle" }, L, "SPLIT");
      IND.push([r, flag("D", 3)], [t, flag("D", 3)]); }
    ind(1166, 358, "⚷", flag("A", 5), 22);
    ind(1187, 358, "🔒︎", flag("C", 2), 19);

    // curved meters
    const MCX = 430, MR = 568, MCY = 377 + MR;
    const dxDeg = dx => Math.asin(dx / MR) * 180 / Math.PI;
    function polar(r, deg) { const a = deg * Math.PI / 180; return [MCX + r * Math.sin(a), MCY - r * Math.cos(a)]; }
    function arcPath(r, a0, a1) {
      const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1);
      return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0,1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    function radialBar(r, deg, w, h) {
      return el("rect", { class: "bar", x: MCX - w / 2, y: MCY - r - h, width: w, height: h, transform: `rotate(${deg} ${MCX} ${MCY})` }, L);
    }
    function arcText(r, dx, text, size, cond = ALWAYS) {
      const deg = dxDeg(dx), [x, y] = polar(r, deg);
      const t = el("text", { class: "f", x, y, "font-size": size, "text-anchor": "middle", transform: `rotate(${deg} ${x} ${y})` }, L, text);
      IND.push([t, cond]); return t;
    }
    const MB = [], SB = [];
    for (let i = 0; i < 20; i++) {
      const wide = i >= 10, dx = wide ? -2 + (i - 10) * 10.1 : -91 + i * 9.1;
      MB.push(radialBar(MR, dxDeg(dx), wide ? 8 : 6, wide ? 10 + (i - 10) * 0.55 : 5 + i * 0.4));
    }
    for (const i of [1, 3, 5, 7, 9]) {
      const [x, y] = polar(MR + 13, dxDeg(-91 + i * 9.1));
      IND.push([el("rect", { class: "f", x: x - 3, y: y - 1.5, width: 6, height: 3 }, L), ALWAYS]);
    }
    IND.push([el("path", { class: "fs", d: arcPath(MR - 6, dxDeg(-97), dxDeg(97)), "stroke-width": 3.2, fill: "none" }, L), ALWAYS]);
    arcText(MR + 16, -110, "S", 17);
    for (const [t, dx] of [["1", -82], ["3", -64], ["5", -46], ["7", -28], ["9", -10], ["20", 29], ["40", 61], ["60dB", 104]]) arcText(MR + 23, dx, t, 17);
    for (const [t, dx] of [["10", -66], ["25", -38], ["50", -8], ["100", 42], ["200W", 92]]) arcText(MR - 25, dx, t, 16);
    IND.push([el("path", { class: "fs", d: arcPath(MR - 34, dxDeg(-90), dxDeg(-2)), "stroke-width": 4, fill: "none" }, L), ALWAYS]);
    for (let i = 0; i < 10; i++) SB.push(radialBar(MR - 42, dxDeg(-80 + i * 17.8), 14, 8));
    for (const [t, dx] of [["1", -80], ["1.5", -60], ["10", -42], ["2", -24], ["3", 20], ["20", 40], ["dB", 62], ["∞", 82]]) arcText(MR - 66, dx, t, 14);
    const subInd = {};
    [["PWR", 306, 412], ["ALC", 309, 426], ["SWR", 304, 442], ["COMP", 300, 457]].forEach(([k, x, y]) => {
      subInd[k] = el("text", { class: "f", x, y, "font-size": 15, transform: `rotate(-14 ${x} ${y})` }, L, k);
    });

    // memory / EQ / BC / NR block
    ind(560, 378, "M.CH", flag("@", 5), 17); ind(560, 397, "M.SCR", flag("@", 6), 17);
    ind(636, 354, "MENU", flag("@", 4), 18);
    seq(560, 416, 16, [["R◂", flag("B", 0)], ["EQ", any(flag("B", 0), flag("B", 1))], ["▸T", flag("B", 1)]]);
    seq(560, 433, 16, [["1◂", flag("B", 5)], ["BC", any(flag("B", 4), flag("B", 5))], ["▸2", flag("B", 4)]]);
    seq(560, 450, 16, [["1◂", flag("B", 3)], ["NR", any(flag("B", 2), flag("B", 3))], ["▸2", flag("B", 2)]]);
    ind(633, 452, "DNL", flag("B", 6), 20);
    ind(688, 426, "AUTO", flag("C", 6), 15);

    // right of the frequency
    [["A", 0], ["B", 1], ["M", 2]].forEach(([t, i], r) => {
      const y = 366 + r * 19;
      ind(1099, y, "◀", flag("E", i), 14); ind(1113, y, t, flag("D", i), 19); ind(1128, y, "▶", flag("E", 3 + i), 14);
    });
    ind(1166, 384, "PC", flag("C", 3), 20);
    ind(1166, 404, "C", flag("C", 1), 20); ind(1179, 404, "T", any(flag("C", 0), flag("C", 1)), 20);
    ind(1110, 438, "XIT", flag("C", 5), 20); ind(1110, 459, "RIT", flag("C", 4), 20);

    function segDisplay({ x, y, n, w, h, pitch, stroke, type, dots = true, gap = 0.9 }) {
      const map = type === 7 ? SEG7 : SEG14, cells = [];
      const polys = type === 7 ? seg7Polys(w, h, stroke, gap) : null, lines = type === 7 ? null : seg14Lines(w, h);
      for (let i = 0; i < n; i++) {
        const g = el("g", { transform: `translate(${x + i * pitch},${y}) skewX(-7)` }, L), segs = {};
        if (polys) for (const [k, p] of Object.entries(polys)) segs[k] = el("polygon", { class: "f", points: p }, g);
        else for (const [k, [a, b, c, d]] of Object.entries(lines)) segs[k] = el("line", { class: "s", x1: a, y1: b, x2: c, y2: d, "stroke-width": stroke }, g);
        const ds = type === 7 ? stroke * 0.9 : stroke * 1.1;
        const dp = dots ? el("rect", { class: "f", x: type === 7 ? w + 2 : w + (pitch - w - ds) / 2, y: h - ds, width: ds, height: ds }, g) : null;
        cells.push({ segs, dp });
      }
      return text => {
        const cs = [];
        for (const ch of text || "") { if (ch === "." && cs.length && !cs[cs.length - 1].dp) cs[cs.length - 1].dp = true; else cs.push({ ch, dp: false }); }
        while (cs.length < n) cs.unshift({ ch: " ", dp: false });
        cs.slice(-n).forEach((c, i) => {
          const on = map[c.ch] ?? map[c.ch.toUpperCase()] ?? "";
          for (const [k, e] of Object.entries(cells[i].segs)) {
            const lit = type === 7 ? on.includes(k) : on.match(new RegExp(k + "(?![12])")) !== null;
            e.classList.toggle("on", lit);
          }
          if (cells[i].dp) cells[i].dp.classList.toggle("on", c.dp);
        });
      };
    }
    const setFreq = segDisplay({ x: 753, y: 343, n: 7, w: 37, h: 57, pitch: 49, stroke: 7.4, type: 7, gap: 1.1 });
    const setChan = segDisplay({ x: 662, y: 357, n: 2, w: 20, h: 32, pitch: 27, stroke: 4.2, type: 7, gap: 0.7 });
    const setMode = segDisplay({ x: 677, y: 430, n: 3, w: 25, h: 29, pitch: 30, stroke: 3.4, type: 14, dots: false });
    const setSub = segDisplay({ x: 817, y: 414, n: 8, w: 27, h: 42, pitch: 35, stroke: 3.8, type: 14 });
    setFreq(""); setSub(""); setChan(""); setMode("");

    // menu sub-line scroller: 2 s hold, then 4 characters/s
    const scroll = { item: null, t0: 0 };
    function menuSubText(item) {
      const now = performance.now();
      if (scroll.item !== item) { scroll.item = item; scroll.t0 = now; }
      const text = (MENU[item] || ["MENU " + item])[0], loop = text + " ".repeat(8);
      const t = (now - scroll.t0) / 1000, hold = 2.0, cps = 4, cycle = hold + loop.length / cps;
      const tc = t % cycle, pos = tc < hold ? 0 : Math.floor((tc - hold) * cps);
      return (loop + loop).slice(pos, pos + 8);
    }
    const isMenu = s => flag("@", 4)(s) && s.menu_item != null;
    let lastState = null, live = false;
    const timer = setInterval(() => {
      if (!L.isConnected) { clearInterval(timer); return; }
      if (live && lastState && isMenu(lastState)) setSub(menuSubText(lastState.menu_item));
    }, 125);

    // m: {"type":"state",connected,state} -- or null for "no connection to local-trx"
    function render(m) {
      const s = m && m.state ? m.state : null;
      const connected = !!(m && m.connected);
      live = connected && !!s && s.power !== false;
      L.classList.toggle("off", !live);
      OFFTXT.textContent = live ? "" : !m ? "NO SERVER" : connected ? "POWER OFF" : "NO LINK";
      const dark = live && s.brightness === 0;
      bg.setAttribute("fill", dark ? `url(#${id}-lcdoff)` : `url(#${id}-lcd)`);
      bg.style.opacity = !live ? "0.07" : dark ? "1" : String(0.7 + 0.075 * Math.min(4, s.brightness ?? 4));
      L.classList.toggle("unlit", dark);
      lastState = s;
      if (!s) {
        for (const [e] of IND) e.classList.remove("on");
        return;
      }
      if (live && isMenu(s)) {
        setFreq(menuValue(s.menu_item, s.menu_value).padStart(7, " "));
        setSub(menuSubText(s.menu_item));
      } else {
        scroll.item = null;
        setFreq(s.freq);
        setSub(subReadout(s) ?? s.status);
      }
      setChan((s.menu_no || "  ").slice(0, 2));
      setMode(MODE_TXT[s.mode_code] || "");
      for (const [e, cond] of IND) e.classList.toggle("on", live && !!cond(s));
      MB.forEach((b, i) => b.classList.toggle("on", live && i < s.meter_main));
      SB.forEach((b, i) => b.classList.toggle("on", live && i < s.meter_sub));
      const sel = { "71": "ALC", "72": "SWR", "73": "COMP" }[s.meter_sel];
      for (const [k, e] of Object.entries(subInd)) e.classList.toggle("on", live && (k === sel || (k === "PWR" && s.lamp === "tx")));
    }

    return { render, group: L };
  }

  // SSB/AM/FM by CAT MD code: the modes the browser microphone may key.
  const isVoiceMode = code => code === 1 || code === 2 || code === 4 || code === 5;

  window.Ts480Lcd = { mount, LCD_VIEWBOX, isVoiceMode };
})();
