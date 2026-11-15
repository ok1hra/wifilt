#!/usr/bin/env python3
"""
build-cheatsheets.py -- one-page cheat sheets for WIFILT, SVG + PDF, EN + CS

    python3 tools/build-cheatsheets.py            # write docs/cheatsheets/*.svg and *.pdf
    python3 tools/build-cheatsheets.py --svg-only # skip the PDF step (no Inkscape)
    python3 tools/build-cheatsheets.py --png DIR  # also write PNG previews into DIR

Three sheets, A4 landscape, each in English and Czech:
    qrplog        the contest log (SOFTWARE.md section 3)
    js8call       the JS8Call-ICOM page (section 5)
    rpi-station   WIFILT + local-trx on a Raspberry Pi (sections 1.6-1.8, 2, 9.3)

The content lives here, both languages side by side (L(en, cs)), so the two
cannot drift apart: change a fact in one place and both sheets follow. Text is
set by this script, not by the viewer: every word is measured with the DejaVu
fonts (PIL) and wrapped here, and each run is placed at an explicit x. The SVG
asks for DejaVu Sans first and Verdana/Arial after it -- both narrower or equal,
so a viewer without DejaVu never overflows a card. The PDF is made from the SVG
by Inkscape and embeds the fonts.

Inline markup in every text: **bold**, `code`, [[Key]] (a keycap).
The script refuses to write a sheet whose columns run off the page.
"""
import argparse
import html
import os
import re
import shutil
import subprocess
import sys

from PIL import ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "cheatsheets")
DATE = "2026-11-15"

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
FONT_FILES = {
    "r": "DejaVuSans.ttf",
    "b": "DejaVuSans-Bold.ttf",
    "m": "DejaVuSansMono.ttf",
    "mb": "DejaVuSansMono-Bold.ttf",
}
SANS = "DejaVu Sans, Verdana, Arial, Helvetica, sans-serif"
MONO = "DejaVu Sans Mono, Consolas, Menlo, monospace"

# ── palette ──────────────────────────────────────────────────────────────────
INK = "#1d232b"
MUTED = "#5b6573"
LINE = "#d5dbe3"
SOFT = "#eef1f5"
DARK = "#1b2028"
AMBER_UI = "#F5B027"
ACCENT = {
    "blue": "#2f6fb0",
    "amber": "#c98400",
    "green": "#2e8b57",
    "red": "#c0392b",
    "violet": "#7b4fa6",
    "teal": "#12808a",
    "slate": "#46566a",
}

PAGE_W, PAGE_H = 297.0, 210.0
MARGIN = 7.0
TOP = 27.0
BOTTOM = 201.5
COL_GAP = 3.6
CARD_GAP = 3.0
S = 2.5          # body text size, mm (about 7.1 pt)
LH = S * 1.42    # line height
PAD = 2.1
TITLE_H = 5.6

LANG = "en"
OVERFLOW = []    # words wider than the room they were given, per sheet


def L(en, cs):
    return en if LANG == "en" else cs


# ── measuring ────────────────────────────────────────────────────────────────

_fonts = {}


def _font(style):
    if style not in _fonts:
        _fonts[style] = ImageFont.truetype(os.path.join(FONT_DIR, FONT_FILES[style]), 200)
    return _fonts[style]


def tw(text, style, size):
    return _font(style).getlength(text) * size / 200.0


def esc(s):
    return html.escape(s, quote=True)


# ── rich text ────────────────────────────────────────────────────────────────

TOKEN = re.compile(r"\*\*(.+?)\*\*|`(.+?)`|\[\[(.+?)\]\]")


def parse(s):
    """[(style, text)] with style r (regular), b (bold), c (code), k (keycap)."""
    out, pos = [], 0
    for m in TOKEN.finditer(s):
        if m.start() > pos:
            out.append(("r", s[pos:m.start()]))
        if m.group(1) is not None:
            out.append(("b", m.group(1)))
        elif m.group(2) is not None:
            out.append(("c", m.group(2)))
        else:
            out.append(("k", m.group(3)))
        pos = m.end()
    if pos < len(s):
        out.append(("r", s[pos:]))
    return out


def items(s):
    """Breakable items: words of r/b runs, code and keycaps whole."""
    res, pending = [], False
    for style, text in parse(s):
        if style in ("r", "b"):
            for part in re.split(r"(\s+)", text):
                if not part:
                    continue
                if part.isspace():
                    pending = True
                    continue
                res.append({"style": style, "text": part, "sp": pending})
                pending = False
        else:
            res.append({"style": style, "text": text, "sp": pending})
            pending = False
    return res


def item_w(it, size):
    st = it["style"]
    if st == "r":
        return tw(it["text"], "r", size)
    if st == "b":
        return tw(it["text"], "b", size)
    if st == "c":
        return tw(it["text"], "m", size * 0.94) + size * 0.5
    return tw(it["text"], "mb", size * 0.9) + size * 0.75


def wrap(s, maxw, size):
    """[[(item, x)]] -- greedy. Items with no space between them (a bold word
    and the full stop after it, a keycap and its "+") form one group that is
    never split across lines."""
    groups = []
    for it in items(s):
        if it["sp"] or not groups:
            groups.append([it])
        else:
            groups[-1].append(it)
    lines, cur, x = [], [], 0.0
    space = tw(" ", "r", size)
    for g in groups:
        gw = sum(item_w(it, size) for it in g)
        if gw > maxw + 0.05:
            OVERFLOW.append(f'"{"".join(it["text"] for it in g)}" is {gw:.1f} mm in {maxw:.1f} mm')
        add = space if cur else 0.0
        if cur and x + add + gw > maxw:
            lines.append(cur)
            cur, x, add = [], 0.0, 0.0
        gx = x + add
        for it in g:
            cur.append((it, gx))
            gx += item_w(it, size)
        x = gx
    if cur:
        lines.append(cur)
    return lines


def draw_line(line, x0, base, size, color=INK, bold_color=None):
    out = []
    for it, x in line:
        st, text = it["style"], esc(it["text"])
        X = x0 + x
        if st == "r":
            out.append(f'<text x="{X:.2f}" y="{base:.2f}" font-size="{size:.2f}" fill="{color}">{text}</text>')
        elif st == "b":
            out.append(f'<text x="{X:.2f}" y="{base:.2f}" font-size="{size:.2f}" font-weight="bold" '
                       f'fill="{bold_color or color}">{text}</text>')
        elif st == "c":
            w = item_w(it, size)
            out.append(f'<rect x="{X:.2f}" y="{base - size * 0.86:.2f}" width="{w:.2f}" height="{size * 1.14:.2f}" '
                       f'rx="0.5" fill="{SOFT}"/>')
            out.append(f'<text x="{X + size * 0.25:.2f}" y="{base - size * 0.02:.2f}" font-size="{size * 0.94:.2f}" '
                       f'font-family="{MONO}" fill="#2b3440">{text}</text>')
        else:
            w = item_w(it, size)
            out.append(f'<rect x="{X:.2f}" y="{base - size * 0.92:.2f}" width="{w:.2f}" height="{size * 1.22:.2f}" '
                       f'rx="0.6" fill="#f8f9fb" stroke="#8d98a5" stroke-width="0.18"/>')
            out.append(f'<rect x="{X + 0.15:.2f}" y="{base + size * 0.18:.2f}" width="{w - 0.3:.2f}" height="0.22" '
                       f'fill="#c3cad3"/>')
            out.append(f'<text x="{X + size * 0.375:.2f}" y="{base - size * 0.03:.2f}" font-size="{size * 0.9:.2f}" '
                       f'font-family="{MONO}" font-weight="bold" fill="{INK}">{text}</text>')
    return "".join(out)


def text_block(s, x, y, w, size=None, color=INK, lh=None, bold_color=None):
    size = size or S
    lh = lh or size * 1.42
    lines = wrap(s, w, size)
    out = []
    for i, line in enumerate(lines):
        out.append(draw_line(line, x, y + size * 0.95 + i * lh, size, color, bold_color))
    return "".join(out), len(lines) * lh


def text_width(s, size=None):
    size = size or S
    return sum(item_w(it, size) for it in items(s)) + tw(" ", "r", size) * sum(1 for it in items(s)[1:] if it["sp"])


# ── blocks ───────────────────────────────────────────────────────────────────
# Each block: function (x, y, w, accent) -> (svg, height)

def P(s, size=None, color=INK):
    def f(x, y, w, acc):
        svg, h = text_block(s, x, y, w, size, color)
        return svg, h + 0.6
    return f


def B(s, size=None):
    def f(x, y, w, acc, size=size):
        size = size or S
        ind = size * 1.15
        svg, h = text_block(s, x + ind, y, w - ind, size)
        dot = f'<circle cx="{x + size * 0.38:.2f}" cy="{y + size * 0.62:.2f}" r="{size * 0.17:.2f}" fill="{acc}"/>'
        return dot + svg, h + 0.45
    return f


def KV(key, s, kw=18.0, size=None):
    def f(x, y, w, acc):
        ksvg, kh = text_block(key, x, y, kw - 1.0, size, bold_color=acc)
        vsvg, vh = text_block(s, x + kw, y, w - kw, size)
        return ksvg + vsvg, max(kh, vh) + 0.5
    return f


def STEP(n, s, size=None):
    def f(x, y, w, acc, size=size):
        size = size or S
        r = size * 0.62
        cx, cy = x + r, y + size * 0.62
        circ = (f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="{acc}"/>'
                f'<text x="{cx:.2f}" y="{cy + size * 0.33:.2f}" font-size="{size * 0.86:.2f}" font-weight="bold" '
                f'fill="#fff" text-anchor="middle">{n}</text>')
        ind = 2 * r + 1.2
        svg, h = text_block(s, x + ind, y, w - ind, size)
        return circ + svg, h + 0.55
    return f


def NOTE(s, size=None, tint="#fff6e0", edge="#e2b13c"):
    def f(x, y, w, acc, size=size):
        size = size or S
        svg, h = text_block(s, x + 4.3, y + 1.2, w - 5.6, size)
        H = h + 2.2
        box = (f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{H:.2f}" rx="1.2" fill="{tint}" '
               f'stroke="{edge}" stroke-width="0.25"/>'
               f'<circle cx="{x + 2.2:.2f}" cy="{y + 1.2 + size * 0.62:.2f}" r="1.25" fill="{edge}"/>'
               f'<text x="{x + 2.2:.2f}" y="{y + 1.2 + size * 0.62 + 0.75:.2f}" font-size="2.1" font-weight="bold" '
               f'fill="#fff" text-anchor="middle">!</text>')
        return box + svg, H + 0.8
    return f


def CODE(lines, size=2.3):
    def f(x, y, w, acc):
        lh = size * 1.5
        H = len(lines) * lh + 1.6
        out = [f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{H:.2f}" rx="1.0" fill="{DARK}"/>']
        for i, ln in enumerate(lines):
            tw_ = tw(ln, "m", size)
            if tw_ > w - 2.2:
                raise SystemExit(f"CODE line too wide ({tw_:.1f} > {w - 2.2:.1f} mm): {ln}")
            prompt = ln.startswith("$ ")
            body = ln[2:] if prompt else ln
            px = x + 1.2
            if prompt:
                out.append(f'<text x="{px:.2f}" y="{y + 0.8 + (i + 0.78) * lh:.2f}" font-size="{size:.2f}" '
                           f'font-family="{MONO}" fill="{AMBER_UI}">$</text>')
                px += tw("$ ", "m", size)
            out.append(f'<text x="{px:.2f}" y="{y + 0.8 + (i + 0.78) * lh:.2f}" font-size="{size:.2f}" '
                       f'font-family="{MONO}" fill="#e8edf3" xml:space="preserve">{esc(body)}</text>')
        return "".join(out), H + 0.9
    return f


def GAP(h):
    def f(x, y, w, acc):
        return "", h
    return f


def SUB(s, size=None):
    """A small heading inside a card."""
    def f(x, y, w, acc, size=size):
        size = size or S * 0.98
        svg, h = text_block("**" + s + "**", x, y + 0.4, w, size, bold_color=acc)
        line = f'<rect x="{x:.2f}" y="{y + h + 0.5:.2f}" width="{w:.2f}" height="0.18" fill="{LINE}"/>'
        return svg + line, h + 1.4
    return f


def GRID(cells, cols=2, size=None):
    """Short labels in a grid of chips."""
    def f(x, y, w, acc, size=size):
        size = size or S
        gap = 1.1
        cw = (w - gap * (cols - 1)) / cols
        ch = size * 1.55
        out = []
        for i, c in enumerate(cells):
            r, k = divmod(i, cols)
            cx, cy = x + k * (cw + gap), y + r * (ch + gap)
            out.append(f'<rect x="{cx:.2f}" y="{cy:.2f}" width="{cw:.2f}" height="{ch:.2f}" rx="0.8" '
                       f'fill="{SOFT}" stroke="{LINE}" stroke-width="0.18"/>')
            svg, _ = text_block(c, cx + 1.0, cy + (ch - size * 1.42) / 2 + 0.05, cw - 1.6, size)
            if text_width(c, size) > cw - 1.6:
                raise SystemExit(f"GRID chip too narrow for: {c}")
            out.append(svg)
        rows = (len(cells) + cols - 1) // cols
        return "".join(out), rows * (ch + gap) + 0.3
    return f


def DIAG(fn):
    def f(x, y, w, acc):
        svg, h = fn(x, y, w)
        return svg, h + 1.0
    return f


# ── card, column, page ───────────────────────────────────────────────────────

class Card:
    def __init__(self, title, accent, blocks):
        self.title, self.accent, self.blocks = title, ACCENT[accent], blocks

    def render(self, x, y, w):
        inner = w - 2 * PAD
        body, cy = [], y + TITLE_H + 1.9
        for b in self.blocks:
            svg, h = b(x + PAD, cy, inner, self.accent)
            body.append(svg)
            cy += h
        H = cy - y + 1.2
        r = 1.6
        frame = (f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{H:.2f}" rx="{r}" fill="#ffffff" '
                 f'stroke="{self.accent}" stroke-width="0.35"/>'
                 f'<path d="M{x:.2f},{y + TITLE_H:.2f} V{y + r:.2f} a{r},{r} 0 0 1 {r},{-r} H{x + w - r:.2f} '
                 f'a{r},{r} 0 0 1 {r},{r} V{y + TITLE_H:.2f} Z" fill="{self.accent}"/>')
        if len(wrap("**" + self.title + "**", w - 4, 3.0)) > 1:
            OVERFLOW.append(f'card title does not fit one line: "{self.title}"')
        tsvg, _ = text_block("**" + self.title + "**", x + 2.2, y + (TITLE_H - 3.0 * 1.42) / 2 + 0.25,
                             w - 4, 3.0, color="#ffffff", bold_color="#ffffff")
        return frame + tsvg + "".join(body), H


def build_page(sheet):
    content_w = PAGE_W - 2 * MARGIN
    weights = sheet["weights"]
    total = sum(weights)
    colw = [(content_w - COL_GAP * (len(weights) - 1)) * wt / total for wt in weights]
    out, xs, x = [], [], MARGIN
    for cw in colw:
        xs.append(x)
        x += cw + COL_GAP
    problems = []
    for ci, column in enumerate(sheet["columns"]):
        y = TOP
        for card in column:
            svg, h = card.render(xs[ci], y, colw[ci])
            out.append(svg)
            y += h + CARD_GAP
        bottom = y - CARD_GAP
        if bottom > BOTTOM + 0.01:
            problems.append(f"column {ci + 1} runs {bottom - BOTTOM:.1f} mm past the bottom")
        sheet.setdefault("_free", []).append(BOTTOM - bottom)
    return "".join(out), problems


def header(sheet):
    acc = [ACCENT[k] for k in ("blue", "amber", "green", "red", "violet", "teal")]
    stripe = "".join(
        f'<rect x="{i * PAGE_W / len(acc):.2f}" y="21.2" width="{PAGE_W / len(acc) + 0.1:.2f}" height="1.1" '
        f'fill="{c}"/>' for i, c in enumerate(acc))
    sub_svg, _ = text_block(sheet["subtitle"], MARGIN + 0.2, 14.4, 200, 3.4, color=AMBER_UI, bold_color=AMBER_UI)
    return (
        f'<rect x="0" y="0" width="{PAGE_W}" height="21.2" fill="{DARK}"/>' + stripe +
        f'<text x="{MARGIN}" y="11.6" font-size="8.2" font-weight="bold" fill="#ffffff">{esc(sheet["title"])}</text>'
        + sub_svg +
        icon_waves(PAGE_W - MARGIN - 37.5, 5.4) +
        f'<text x="{PAGE_W - MARGIN}" y="10.2" font-size="5.4" font-weight="bold" fill="#ffffff" '
        f'text-anchor="end" letter-spacing="0.5">WIFILT</text>'
        f'<text x="{PAGE_W - MARGIN}" y="16.0" font-size="2.7" fill="#9aa5b1" text-anchor="end">'
        f'{esc(L("cheat sheet", "tahák"))} · {LANG.upper() if LANG == "en" else "CZ"}</text>'
    )


def icon_waves(x, y):
    """A small mast with radio waves."""
    c = AMBER_UI
    return (f'<g fill="none" stroke="{c}" stroke-width="0.55" stroke-linecap="round">'
            f'<path d="M{x + 4},{y + 10.5} L{x + 4},{y + 3.8}"/>'
            f'<path d="M{x + 1.9},{y + 10.5} L{x + 4},{y + 5.3} L{x + 6.1},{y + 10.5}"/>'
            f'<path d="M{x + 1.8},{y + 1.8} a3.2,3.2 0 0 0 0,4.2"/>'
            f'<path d="M{x + 6.2},{y + 1.8} a3.2,3.2 0 0 1 0,4.2"/>'
            f'<path d="M{x + 0.2},{y + 0.4} a5.2,5.2 0 0 0 0,7.0"/>'
            f'<path d="M{x + 7.8},{y + 0.4} a5.2,5.2 0 0 1 0,7.0"/></g>'
            f'<circle cx="{x + 4}" cy="{y + 3.9}" r="0.75" fill="{c}"/>')


def footer(sheet):
    left = f'WIFILT · github.com/ok1hra/wifilt · {sheet["ref"]}'
    right = f'{sheet["title"]} · {L("cheat sheet", "tahák")} · {DATE}'
    return (f'<rect x="{MARGIN}" y="{PAGE_H - 6.6:.2f}" width="{PAGE_W - 2 * MARGIN}" height="0.18" fill="{LINE}"/>'
            f'<text x="{MARGIN}" y="{PAGE_H - 3.4:.2f}" font-size="2.2" fill="{MUTED}">{esc(left)}</text>'
            f'<text x="{PAGE_W - MARGIN}" y="{PAGE_H - 3.4:.2f}" font-size="2.2" fill="{MUTED}" '
            f'text-anchor="end">{esc(right)}</text>')


def render_sheet(sheet):
    global S
    S = sheet.get("size", 2.5)
    OVERFLOW.clear()
    body, problems = build_page(sheet)
    problems += ["too wide: " + o for o in OVERFLOW]
    svg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" '
        f'viewBox="0 0 {PAGE_W} {PAGE_H}" font-family="{SANS}" lang="{LANG}">\n'
        f'<title>{esc(sheet["title"])} — {esc(L("cheat sheet", "tahák"))}</title>\n'
        f'<rect width="{PAGE_W}" height="{PAGE_H}" fill="#ffffff"/>\n'
        + header(sheet) + body + footer(sheet) + "\n</svg>\n"
    )
    return svg, problems


# ── diagram helpers ──────────────────────────────────────────────────────────

def box(x, y, w, h, fill, stroke=None, rx=1.0, sw=0.25, extra=""):
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    return f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{rx}" fill="{fill}"{st}{extra}/>'


def t(x, y, s, size=2.2, color=INK, weight=None, anchor=None, mono=False, rotate=None):
    a = f' text-anchor="{anchor}"' if anchor else ""
    wgt = f' font-weight="{weight}"' if weight else ""
    fam = f' font-family="{MONO}"' if mono else ""
    rot = f' transform="rotate({rotate} {x:.2f} {y:.2f})"' if rotate is not None else ""
    return (f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size:.2f}" fill="{color}"{a}{wgt}{fam}{rot} '
            f'xml:space="preserve">{esc(s)}</text>')


def arrow(x1, y1, x2, y2, color=MUTED, sw=0.3, dash=None, head=1.1):
    import math
    d = f' stroke-dasharray="{dash}"' if dash else ""
    ang = math.atan2(y2 - y1, x2 - x1)
    hx1 = x2 - head * math.cos(ang - 0.45)
    hy1 = y2 - head * math.sin(ang - 0.45)
    hx2 = x2 - head * math.cos(ang + 0.45)
    hy2 = y2 - head * math.sin(ang + 0.45)
    return (f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" stroke="{color}" stroke-width="{sw}"{d}/>'
            f'<path d="M{x2:.2f},{y2:.2f} L{hx1:.2f},{hy1:.2f} L{hx2:.2f},{hy2:.2f} Z" fill="{color}"/>')


def badge(x, y, n, color):
    return (f'<circle cx="{x:.2f}" cy="{y:.2f}" r="1.35" fill="{color}" stroke="#fff" stroke-width="0.25"/>'
            + t(x, y + 0.72, str(n), 1.9, "#fff", "bold", "middle"))


def kbd(x, y, label, size=2.0):
    w = tw(label, "mb", size) + 1.6
    return (box(x, y, w, size * 1.45, "#f8f9fb", "#8d98a5", 0.6, 0.18)
            + t(x + 0.8, y + size * 1.08, label, size, INK, "bold", mono=True)), w


# ═════════════════════════════════════════════════════════════════════════════
#  QRPlog
# ═════════════════════════════════════════════════════════════════════════════

def diag_qrplog_screen(x, y, w):
    """A sketch of the QRPlog page, numbered 1-6; the numbers sit in a gutter
    on the right so they never cover what they point at."""
    import math
    o = []
    G = 4.2                      # badge gutter
    X0, X1 = x + 1.2, x + w - G  # content edges
    cw = X1 - X0
    c = ACCENT["amber"]
    # tabs
    tx = X0
    for name, on in (("QRPLOG", True), ("DXC", False), ("DATA", False), ("SETUP", False)):
        tw_ = tw(name, "b", 1.7) + 2.2
        o.append(box(tx, y + 1.0, tw_, 2.9, "#F5B027" if on else "#323a46", rx=0.6))
        o.append(t(tx + 1.1, y + 3.05, name, 1.7, "#1b2028" if on else "#c6ced8", "bold"))
        tx += tw_ + 0.9
    # 1 journal
    jy = y + 4.8
    o.append(box(X0, jy, cw, 14.6, "#2a313b", rx=0.7))
    o.append(t(X0 + 0.8, jy + 2.1, L("Nr  Time  Call    Freq   Mode Exch DXCC", "Nr  Čas   Značka  Kmit.  Mód  Exch DXCC"),
               1.5, "#8b97a8", mono=True))
    rows = ["004 13:42 OH1TS  21013 CW  41  Finland", "005 13:44 EA5OH  21013 CW  144 Spain",
            "006 13:45 K3QP   21013 CW  29  USA", "007 13:46 UT8AS  21013 CW  27  Ukraine"]
    for i, r in enumerate(rows):
        yy = jy + 4.5 + i * 2.6
        last = i == len(rows) - 1
        if last:
            o.append(box(X0 + 0.4, yy - 1.75, cw - 0.8, 2.4, "#3a4452", rx=0.4))
        o.append(t(X0 + 0.8, yy, r, 1.5, "#dfe6ef" if last else "#aeb8c5", mono=True))
    o.append(badge(x + w - 2.1, jy + 7.3, 1, c))
    # 2 band map
    by = jy + 15.4
    o.append(box(X0, by, cw, 5.4, "#1a2028", rx=0.6))
    pts = []
    for i in range(0, 61):
        px = X0 + 0.4 + (cw - 0.8) * i / 60
        v = 0.6 + 0.35 * math.sin(i * 1.7) + (2.0 if i in (14, 15, 38, 39, 51) else 0) + (1.0 if i in (13, 16, 40) else 0)
        pts.append(f"{px:.2f},{by + 5.0 - v:.2f}")
    o.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#5fb3ff" stroke-width="0.25"/>')
    for fx, call in ((0.24, "DL1XYZ"), (0.64, "K3QP"), (0.86, "EA5OH")):
        o.append(t(X0 + cw * fx, by + 1.55, call, 1.25, "#F5B027", anchor="middle"))
    mx = X0 + cw * 0.45
    o.append(f'<line x1="{mx:.2f}" y1="{by + 0.3:.2f}" x2="{mx:.2f}" y2="{by + 5.1:.2f}" stroke="#ff5c5c" '
             f'stroke-width="0.3"/>')
    o.append(badge(x + w - 2.1, by + 2.7, 2, c))
    # 3 status bar
    sy = by + 6.2
    o.append(box(X0, sy, cw, 3.0, "#2a313b", rx=0.5))
    o.append(t(X0 + 0.8, sy + 2.1, "21.013.30 | CW | Ukraine | UT | QRB 1257km | Az 83", 1.5, "#c6ced8", mono=True))
    o.append(badge(x + w - 2.1, sy + 1.5, 3, c))
    # 4 input row
    iy = sy + 4.0
    fx = X0
    for lab, wid, val in (("Call", 0.31, "UT8AS"), ("Snt", 0.12, "599"), ("Rcv", 0.12, "599"), ("EXCH", 0.25, "27")):
        ww = cw * wid
        o.append(box(fx, iy, ww, 4.0, "#f4f6f9", "#7f8b99", 0.5, 0.2))
        o.append(t(fx + 0.8, iy + 2.9, val, 2.0, INK, "bold", mono=True))
        if lab == "Call":
            cx_ = fx + 0.8 + tw(val, "mb", 2.0) + 0.3
            o.append(f'<rect x="{cx_:.2f}" y="{iy + 0.7:.2f}" width="0.25" height="2.6" fill="{INK}"/>')
        fx += ww + 0.9
    o.append(box(fx + 0.1, iy + 1.1, 1.7, 1.7, "#f4f6f9", "#7f8b99", 0.3, 0.2))
    o.append(t(fx + 2.3, iy + 2.6, "global", 1.4, "#c6ced8"))
    o.append(badge(x + w - 2.1, iy + 2.0, 4, c))
    # 5 macro preview + hints
    my = iy + 4.6
    o.append(t(X0 + 0.4, my + 1.9, "UT8AS 5nn TT7", 1.6, "#4cd07d", mono=True))
    o.append(t(X1 - 0.4, my + 1.9, L("hints", "hlášky"), 1.5, "#ff6b6b", anchor="end"))
    o.append(badge(x + w - 2.1, my + 1.4, 5, c))
    # 6 buttons
    btn_y = my + 3.1
    bx = X0
    for name, col in (("RUN", "#2f6fb0"), ("RTTY", "#323a46"), ("TRX1", "#F5B027"), ("TRX2", "#323a46")):
        ww = tw(name, "b", 1.5) + 1.7
        o.append(box(bx, btn_y, ww, 2.8, col, rx=0.5))
        o.append(t(bx + 0.85, btn_y + 2.0, name, 1.5, "#1b2028" if col == "#F5B027" else "#e8edf3", "bold"))
        bx += ww + 0.6
    rx_ = X1
    for name, col in (("GIT LOG SYNC", "#323a46"), ("MACROS", "#323a46"), ("LOG", "#2e8b57"), ("?", "#323a46")):
        ww = tw(name, "b", 1.5) + 1.7
        rx_ -= ww
        o.append(box(rx_, btn_y, ww, 2.8, col, rx=0.5))
        o.append(t(rx_ + 0.85, btn_y + 2.0, name, 1.5, "#e8edf3", "bold"))
        rx_ -= 0.6
    o.append(badge(x + w - 2.1, btn_y + 1.4, 6, c))
    h = btn_y + 2.8 + 1.2 - y
    return box(x, y, w, h, "#20262f", rx=1.4) + "".join(o), h


def diag_enter_flow(x, y, w):
    o = []
    row_h = 5.4
    chip_w = 13.5
    res_x = x + chip_w + 1.4 + tw("Enter", "mb", 1.9) + 1.6 + 4.2
    cy = y

    def lane(title, color, steps):
        nonlocal cy
        o.append(box(x, cy, w, 3.6, color, rx=0.8))
        o.append(t(x + 1.4, cy + 2.6, title, 2.2, "#fff", "bold"))
        cy += 4.5
        for field, result in steps:
            o.append(box(x, cy, chip_w, 4.0, SOFT, LINE, 0.8, 0.2))
            o.append(t(x + chip_w / 2, cy + 2.8, field, 2.0, MUTED if field.startswith("(") else INK,
                       "bold", "middle"))
            k, kw = kbd(x + chip_w + 1.4, cy + 0.6, "Enter", 1.9)
            o.append(k)
            o.append(arrow(x + chip_w + 1.4 + kw + 0.5, cy + 2.0, res_x - 0.6, cy + 2.0, color, 0.3))
            svg, hh = text_block(result, res_x, cy + 0.1, w - (res_x - x), 2.2)
            o.append(svg)
            cy += max(row_h, hh + 1.2)
        cy += 0.8

    lane(L("RUN — you call CQ", "RUN — voláš CQ"), ACCENT["blue"], [
        (L("(empty)", "(prázdno)"), L("**CQ** goes out", "vyšle **CQ**")),
        ("Call", L("**exchange** · cursor → EXCH · dupe check", "**výměna** · kurzor → EXCH · kontrola dupe")),
        ("EXCH", L("**TU** · QSO logged · serial +1", "**TU** · QSO zapsáno · pořadové +1")),
    ])
    lane(L("S&P — you answer", "S&P — odpovídáš"), ACCENT["green"], [
        ("Call", L("**your call** goes out", "vyšle **tvou značku**")),
        ("EXCH", L("**exchange** · QSO logged", "**výměna** · QSO zapsáno")),
    ])
    return "".join(o), cy - y


def sheet_qrplog():
    kw = 20.6
    col1 = [
        Card(L("The screen", "Obrazovka"), "slate", [
            DIAG(diag_qrplog_screen),
            KV("**1**", L("journal — newest QSO at the bottom, click a row to edit",
                          "deník — nejnovější QSO dole, klik na řádek = úprava"), kw=4.0),
            KV("**2**", L("band map (with the DX cluster on)", "bandmapa (když běží DX cluster)"), kw=4.0),
            KV("**3**", L("status bar: frequency, mode, country, prefix, QRB, azimuth",
                          "stavový řádek: kmitočet, mód, země, prefix, QRB, azimut"), kw=4.0),
            KV("**4**", L("Call · Snt · Rcv · EXCH", "Call · Snt · Rcv · EXCH"), kw=4.0),
            KV("**5**", L("exactly what [[Enter]] would send now · red hints",
                          "přesně to, co by teď poslal [[Enter]] · červené hlášky"), kw=4.0),
            KV("**6**", L("RUN/S&P, palettes, TRX · help, LOG, MACROS, GIT LOG SYNC",
                          "RUN/S&P, paletky, TRX · nápověda, LOG, MACROS, GIT LOG SYNC"), kw=4.0),
        ]),
        Card(L("Enter runs the QSO", "Enter vede spojení"), "blue", [
            DIAG(diag_enter_flow),
            P(L("The **radio's mode** decides what is sent: **CW** → the radio keys Morse, **RTTY** → FSK, "
                "**USB-D/LSB-D** → through the RTTY palette. In SSB, FM and AM [[Enter]] only logs.",
                "Co se vyšle, určuje **mód rádia**: **CW** → Morse klíčuje rádio, **RTTY** → FSK, "
                "**USB-D/LSB-D** → přes paletku RTTY. V SSB, FM a AM [[Enter]] jen zapisuje.")),
        ]),
    ]
    col2 = [
        Card(L("Keyboard", "Klávesnice"), "amber", [
            KV("[[Enter]]", L("next step of the QSO", "další krok spojení"), kw),
            KV("[[Alt]]+[[Enter]]", L("log without sending", "zapsat bez vysílání"), kw),
            KV("[[Esc]]", L("**stop TX at once** · close a dialog · end the search",
                            "**okamžitě zastaví TX** · zavře dialog · ukončí hledání"), kw),
            KV("[[Space]]", L("in Call: dupe & partial-call search", "v Call: hledání dupe a části značky"), kw),
            KV("[[Home]]", L("to **Call**, cursor at the end", "do **Call**, kurzor na konec"), kw),
            KV("[[End]]", L("to **EXCH**", "do **EXCH**"), kw),
            KV("[[Tab]]", L("to the Snt / Rcv reports — [[Enter]] there transmits too",
                            "k reportům Snt / Rcv — [[Enter]] tam také vysílá"), kw),
            KV("[[Alt]]+[[1]][[2]][[3]]", L("select TRX1 / TRX2 / TRX3", "vybere TRX1 / TRX2 / TRX3"), kw),
            KV("[[Alt]]+[[U]]", L("RUN ⇄ S&P", "RUN ⇄ S&P"), kw),
            KV("[[Alt]]+[[W]]", L("clear the form", "vymaže formulář"), kw),
            KV("[[Alt]]+[[G]]", L("dupes from **all** logs on / off", "dupe ze **všech** deníků zap / vyp"), kw),
            KV("[[Alt]]+[[K]]", L("type a message — [[Enter]] sends, [[Esc]] discards",
                                  "napiš zprávu — [[Enter]] vyšle, [[Esc]] zahodí"), kw),
            KV("[[Alt]]+[[S]]", L("statistics palette", "paletka statistik"), kw),
            KV("[[Alt]]+[[T]]", L("RTTY palette AUTOTUNE (S&P)", "AUTOTUNE paletky RTTY (S&P)"), kw),
            KV("[[Alt]]+[[+]] [[-]]", L("size of the journal text", "velikost písma deníku"), kw),
            KV("[[?]]", L("button: this list on screen", "tlačítko: tento seznam"), kw),
            NOTE(L("A mouse click anywhere puts the cursor back where it was — Call or EXCH.",
                   "Klik myší kamkoli vrátí kurzor tam, kde byl — do Call nebo EXCH.")),
        ]),
        Card(L("Input row", "Vstupní řádek"), "teal", [
            B(L("**Call** — country, prefix, QRB and heading appear as you type",
                "**Call** — země, prefix, QRB a směr se ukazují už při psaní")),
            B(L("**Snt / Rcv** — 59 or 599 from the mode; type to change",
                "**Snt / Rcv** — 59 nebo 599 podle módu; přepiš, chceš-li jiný")),
            B(L("***?** (RUN) sends the part of the call with ?, **check** (S&P) searches the log, **nr?** asks for "
                "the number again", "***?** (RUN) vyšle část značky s ?, **check** (S&P) prohledá deník, **nr?** "
                "požádá o číslo znovu")),
        ]),
    ]
    col3 = [
        Card(L("Dupes & partial calls", "Dupe a části značek"), "red", [
            P(L("[[Space]] in Call arms the search; it follows every letter you type.",
                "[[Space]] v Call zapne hledání; sleduje každé napsané písmeno.")),
            B(L("**Worked before** → the journal lists that station: **red** = this band, **amber** = call only, "
                "dim Mode = another mode",
                "**Už pracováno** → deník ukáže tu stanici: **červená** = toto pásmo, **oranžová** = jen značka, "
                "šedý mód = jiný mód")),
            B(L("**Part of a call** → a palette of longer calls, the closest nearest your hand; click one into Call",
                "**Část značky** → paletka delších značek, nejbližší u ruky; klik ji vloží do Call")),
            B(L("**✕** hides until the next Space · **global** ([[Alt]]+[[G]]) = all logs",
                "**✕** skryje do další mezery · **global** ([[Alt]]+[[G]]) = všechny deníky")),
        ]),
        Card(L("Palettes", "Paletky"), "violet", [
            KV("**RTTY**", L("RTTY and data modes: waterfall + decoded text; click a word → Call / EXCH",
                             "RTTY a datové módy: vodopád + dekódovaný text; klik na slovo → Call / EXCH"), 13),
            KV("**JTTY**", L("USB-D / LSB-D: JTTY waterfall and messages", "USB-D / LSB-D: vodopád a zprávy JTTY"), 13),
            KV("**PA**", L("the amplifier on TrxNet (appears once it is heard)",
                           "zesilovač na TrxNetu (objeví se, až ho uslyší)"), 13),
            KV(L("**STATS**", "**STATS**"),
               L("[[Alt]]+[[S]]: QSOs per band and mode, no dupes; multipliers: US/VE states, zones (EXCH) or "
                 "**WPX prefixes** (call)",
                 "[[Alt]]+[[S]]: QSO po pásmech a módech bez dupe; násobiče: US/VE státy, zóny (z EXCH) nebo "
                 "**WPX prefixy** (ze značky)"), 13),
            KV("**TS480**", L("local-trx with a TS-480: the radio's own display", "local-trx s TS-480: displej rádia"), 13),
            P(L("Drag by the title bar — the place is remembered.", "Táhni za titulek — místo se pamatuje."),
              color=MUTED),
        ]),
        Card(L("Band map & DX cluster", "Bandmapa a DX cluster"), "teal", [
            B(L("Band map: spots around your frequency · **^** span 50/100/200 kHz · **▼** fold · click a spot → tune "
                "and fill Call",
                "Bandmapa: spoty kolem kmitočtu · **^** šíře 50/100/200 kHz · **▼** sbalit · klik na spot → naladí "
                "a vyplní Call")),
            B(L("**DXC** tab splits the page — cluster left, log right; drag the divider",
                "Záložka **DXC** rozdělí stránku — cluster vlevo, deník vpravo; dělítko se táhne")),
            B(L("Click a spot's kHz: **left** TRX1 · **middle** TRX2 · **right** TRX3 → S&P, call in Call, keep "
                "typing", "Klik na kHz spotu: **levé** TRX1 · **prostřední** TRX2 · **pravé** TRX3 → S&P, značka "
                "v Call, piš dál")),
        ]),
    ]
    col4 = [
        Card(L("Logs", "Deníky"), "green", [
            B(L("**LOG** — lit while a log is active, its name on hover — opens the log manager: "
                "**Open · CSV · ADIF · Edit · Del**",
                "**LOG** — svítí, když je deník aktivní, název po najetí myší — otevře správce deníků: "
                "**Open · CSV · ADIF · Edit · Del**")),
            B(L("New log: contest name, your call, locator and the exchange:",
                "Nový deník: název závodu, tvoje značka, lokátor a výměna:")),
            KV("**NONE**", L("report only", "jen report"), 14.2),
            KV("**NR**", L("serial number", "pořadové číslo"), 14.2),
            KV("**NR+UTC**", L("serial + time", "číslo + čas"), 14.2),
            KV("**NR+LOC**", L("serial + locator (VHF+)", "číslo + lokátor (VKV)"), 14.2),
            KV("**STATIC**", L("fixed text: zone, section, power…", "pevný text: zóna, sekce, výkon…"), 14.2),
            B(L("**MACROS** — CW / RTTY texts (CQ, TXEXCH, TU …)", "**MACROS** — texty CW / RTTY (CQ, TXEXCH, TU …)")),
        ]),
        Card(L("Journal", "Deník"), "slate", [
            B(L("Click a row: edit · **Save · Cancel · Delete**", "Klik na řádek: úprava · **Save · Cancel · Delete**")),
            B(L("Right-click a call → web search", "Pravé tlačítko na značce → hledání na webu")),
            B(L("SETUP → **Blocked DXCC** list: such calls are refused — BLOCKED",
                "SETUP → **Blocked DXCC**: takové značky odmítne — BLOCKED")),
        ]),
        Card(L("Your log lives in this browser", "Deník je v tomto prohlížeči"), "red", [
            P(L("QSOs are stored in the browser's database — not on the interface. Back them up.",
                "QSO jsou v databázi prohlížeče — ne v interfejsu. Zálohuj je.")),
            B(L("**GIT LOG SYNC** — one click syncs both ways with your GitHub repository · **(12)** not in git "
                "yet · **↓2** newer commits elsewhere · **⚙** settings",
                "**GIT LOG SYNC** — jeden klik synchronizuje oběma směry s repozitářem na GitHubu · **(12)** ještě "
                "není v gitu · **↓2** novější commity odjinud · **⚙** nastavení")),
            B(L("**LOGSYNC** page — another device, JSON backup / restore, ADIF · Cabrillo · EDI import",
                "Stránka **LOGSYNC** — jiné zařízení, záloha / obnova JSON, import ADIF · Cabrillo · EDI")),
        ]),
    ]
    return {
        "name": "qrplog",
        "title": "QRPlog",
        "subtitle": L("contest log · keyboard first · every click returns the cursor",
                      "závodní deník · vše z klávesnice · každý klik vrátí kurzor"),
        "ref": "SOFTWARE.md § 3",
        "size": 2.76,
        "weights": [1.22, 1.0, 1.0, 0.92],
        "columns": [col1, col2, col3, col4],
    }


# ═════════════════════════════════════════════════════════════════════════════
#  JS8Call-ICOM
# ═════════════════════════════════════════════════════════════════════════════

def diag_level(x, y, w):
    o = []
    lo, hi = -80.0, 0.0
    bx, bw, by, bh = x + 1.0, w - 2.0, y + 3.2, 3.0

    def X(v):
        return bx + bw * (v - lo) / (hi - lo)
    for a, b, c in ((-80, -60, "#e0b44a"), (-60, -20, "#3fae6a"), (-20, -10, "#e0b44a"), (-10, 0, "#d9534f")):
        o.append(box(X(a), by, X(b) - X(a), bh, c, rx=0))
    o.append(box(bx, by, bw, bh, "none", "#7f8b99", 0.4, 0.2))
    for v in (-60, -40, -20):
        o.append(t(X(v), by + bh + 2.4, f"{v}", 1.8, MUTED, anchor="middle"))
    o.append(t(bx + bw, by + bh + 2.4, "dBFS", 1.8, MUTED, anchor="end"))
    o.append(f'<path d="M{X(-40):.2f},{by - 0.2:.2f} l-1.1,-1.8 h2.2 Z" fill="{INK}"/>')
    o.append(t(X(-40), by - 2.3, L("noise ≈ −40", "šum ≈ −40"), 1.9, INK, "bold", "middle"))
    return "".join(o), 10.5


def diag_waterfall(x, y, w):
    import random
    rnd = random.Random(7)
    o = []
    top = y + 4.2
    h = 21.0
    fx0, fx1 = x + 0.8, x + w - 0.8

    def F(hz):
        return fx0 + (fx1 - fx0) * (hz - 500) / 2200.0
    o.append(box(fx0, top, fx1 - fx0, h, "#0d1117", rx=0.6))
    # heartbeat zone
    o.append(box(F(500), top, F(1000) - F(500), h, "#1b2b44", rx=0))
    o.append(t((F(500) + F(1000)) / 2, top - 0.9, L("heartbeats", "heartbeaty"), 1.7, ACCENT["blue"], "bold", "middle"))
    # slot lines
    for i in range(1, 4):
        yy = top + h * i / 4
        o.append(f'<line x1="{fx0:.2f}" y1="{yy:.2f}" x2="{fx1:.2f}" y2="{yy:.2f}" stroke="#5d6b7d" '
                 f'stroke-width="0.15" stroke-dasharray="0.8 0.6"/>')
    # signals
    sigs = [(620, 0, "#ffd34d"), (760, 1, "#ff9f43"), (880, 2, "#ffd34d"), (1240, 0, "#ff7b54"),
            (1240, 1, "#ffb86b"), (1720, 2, "#ffd34d"), (2150, 3, "#ff9f43"), (930, 3, "#ffe08a"),
            (1480, 3, "#ff7b54")]
    for hz, slot, col in sigs:
        y0 = top + h * slot / 4 + 0.5
        o.append(box(F(hz), y0, F(hz + 50) - F(hz), h / 4 - 1.0, col, rx=0.2, extra=' opacity="0.9"'))
    for _ in range(140):
        px = rnd.uniform(fx0 + 0.3, fx1 - 0.6)
        py = rnd.uniform(top + 0.3, top + h - 0.6)
        o.append(f'<rect x="{px:.2f}" y="{py:.2f}" width="0.35" height="0.35" fill="#24496b" opacity="0.7"/>')
    # TX offset cursor
    cx = F(1560)
    o.append(f'<line x1="{cx:.2f}" y1="{top:.2f}" x2="{cx:.2f}" y2="{top + h:.2f}" stroke="#ff4d4d" '
             f'stroke-width="0.35"/>')
    o.append(box(cx + 0.6, top + 0.8, tw(L("TX offset · click", "TX offset · klik"), "b", 1.6) + 1.4, 2.6,
                 "#ff4d4d", rx=0.4))
    o.append(t(cx + 1.3, top + 2.6, L("TX offset · click", "TX offset · klik"), 1.6, "#fff", "bold"))
    # callsigns above traces (hover)
    for hz, call in ((1240, "OK2ABC"), (1720, "DL7XY")):
        o.append(t(F(hz + 25) + 0.5, top + h - 0.8, call, 1.5, "#ffffff", rotate=-90))
    # slot label
    o.append(t(fx1 - 0.6, top + h / 4 - 0.6, L("slot 15 s", "slot 15 s"), 1.5, "#8b97a8", anchor="end"))
    # axis
    for hz in (500, 1000, 1500, 2000, 2500):
        o.append(f'<line x1="{F(hz):.2f}" y1="{top + h:.2f}" x2="{F(hz):.2f}" y2="{top + h + 0.8:.2f}" '
                 f'stroke="{MUTED}" stroke-width="0.2"/>')
        o.append(t(F(hz), top + h + 2.7, str(hz), 1.7, MUTED, anchor="middle"))
    o.append(t(fx1, top + h + 2.7, "Hz", 1.7, MUTED, anchor="end"))
    return "".join(o), h + 7.6


def diag_route(x, y, w):
    o = []
    cy = y + 6.2
    nodes = [(x + 6.0, L("YOU", "TY"), ACCENT["green"]), (x + w / 2, "HB9BV", ACCENT["blue"]),
             (x + w - 6.0, "IU7VLD", ACCENT["slate"])]
    for nx, label, col in nodes:
        o.append(f'<circle cx="{nx:.2f}" cy="{cy:.2f}" r="3.6" fill="{col}"/>')
        o.append(t(nx, cy + 0.8, label, 1.9 if len(label) < 5 else 1.55, "#fff", "bold", "middle"))
    o.append(arrow(x + 10.0, cy - 0.4, x + w / 2 - 4.0, cy - 0.4, ACCENT["green"], 0.35))
    o.append(t((x + 10.0 + x + w / 2 - 4.0) / 2, cy - 1.6, "MSG TO:IU7VLD …", 1.6, INK, "bold", "middle"))
    o.append(arrow(x + w / 2 + 4.0, cy - 0.4, x + w - 10.0, cy - 0.4, ACCENT["blue"], 0.35, dash="1 0.7"))
    o.append(t((x + w / 2 + 4.0 + x + w - 10.0) / 2, cy - 1.6, L("when heard", "až ho uslyší"), 1.6, INK,
               anchor="middle"))
    # direct, faded
    o.append(f'<path d="M{x + 6.0:.2f},{cy + 3.8:.2f} Q{x + w / 2:.2f},{cy + 10.5:.2f} {x + w - 6.0:.2f},'
             f'{cy + 3.8:.2f}" fill="none" stroke="#b7c0cb" stroke-width="0.3" stroke-dasharray="0.6 0.6"/>')
    o.append(t(x + w / 2, cy + 6.4, L("DIRECT — not heard here", "DIRECT — tady ho neslyšíš"), 1.6, MUTED,
               anchor="middle"))
    return "".join(o), 14.8


def sheet_js8():
    kw = 17.0
    kwh = 20.5
    col1 = [
        Card(L("On the radio, once", "Na rádiu, jednou"), "red", [
            STEP(1, L("`DATA MOD` = **WLAN** — otherwise PTT but no RF", "`DATA MOD` = **WLAN** — jinak PTT bez výkonu")),
            STEP(2, L("`WLAN MOD Level` — start at **25 %**", "`WLAN MOD Level` — začni na **25 %**")),
            STEP(3, L("Mode **USB-D** (choosing a band sets it)", "Mód **USB-D** (volba pásma ho nastaví)")),
            P(L("Paths of the IC-705: MENU → SET → Connectors → MOD Input. IC-7610, IC-9700, IC-7300MK2, IC-7760: "
                "`LAN MOD Level`. The **?** button shows your model's.",
                "Cesty z IC-705: MENU → SET → Connectors → MOD Input. IC-7610, IC-9700, IC-7300MK2, IC-7760: "
                "`LAN MOD Level`. Tlačítko **?** ukáže cesty pro tvůj model."), size=2.3, color=MUTED),
        ]),
        Card(L("Before the first TX", "Před prvním vysíláním"), "amber", [
            STEP(1, L("SETUP → **Identity**: callsign and locator", "SETUP → **Identity**: značka a lokátor")),
            STEP(2, L("**CAL PLAN** — calibrate TX audio (red = a band or power not measured)",
                      "**CAL PLAN** — kalibrace TX audia (červený = pásmo či výkon nezměřen)")),
            STEP(3, L("SETTINGS → **Enable radio TX**", "SETTINGS → **Enable radio TX**")),
            STEP(4, L("**HB** sends a heartbeat · **TUNE** a carrier", "**HB** vyšle heartbeat · **TUNE** nosnou")),
            NOTE(L("One live page per station. Another tab or device offers **TAKE THE SESSION OVER HERE**.",
                   "Jedna živá stránka na stanici. Jiná karta či zařízení nabídne **TAKE THE SESSION OVER HERE**.")),
        ]),
        Card(L("RX level", "Úroveň příjmu"), "teal", [
            DIAG(diag_level),
            B(L("Judge on noise alone, an empty stretch of band", "Posuzuj na samotném šumu, na prázdném kusu pásma")),
            B(L("Too high: **RF Gain** down · P.AMP off or ATT on", "Moc vysoko: **RF Gain** dolů · P.AMP vyp nebo ATT")),
            B(L("**AGC** FAST or MID — never OFF", "**AGC** FAST nebo MID — nikdy OFF")),
        ]),
        Card(L("Frequency timetable", "Plán kmitočtů"), "slate", [
            B(L("**TIMETABLE** in the top bar: 24 h in half-hour cells; click a cell to pick its band",
                "**TIMETABLE** v horní liště: 24 h po půlhodinách; klik na buňku vybere pásmo")),
            B(L("**OFF / ON** arms the plan · **Clear** empties it", "**OFF / ON** plán zapne · **Clear** ho vyprázdní")),
            B(L("A band change never cuts a transmission — it waits", "Změna pásma nikdy nepřeruší vysílání — počká")),
        ]),
    ]
    col2 = [
        Card(L("Header bar", "Horní lišta"), "slate", [
            KV("**?**", L("radio setup help for your model", "nápověda nastavení tvého rádia"), kwh),
            KV("**TRX · freq**", L("click → JS8 dial frequencies (sets USB-D)", "klik → kmitočty JS8 (nastaví USB-D)"), kwh),
            KV("**TIMETABLE**", L("24 h band schedule, half-hour cells", "24h plán pásem po půlhodinách"), kwh),
            KV("**CAL PLAN**", L("TX gain per band × power", "TX zisk pro pásmo × výkon"), kwh),
            KV("**● RX LIVE**", L("RX WAIT · RX LIVE · TX · **OFFLINE** (red)", "RX WAIT · RX LIVE · TX · **OFFLINE** (červeně)"),
               kw),
            KV("**✉ NEW MSG**", L("red bar = mail for you; click opens MSG BOX", "červená lišta = pošta pro tebe; klik otevře "
                                  "MSG BOX"), kwh),
        ]),
        Card(L("Waterfall", "Vodopád"), "blue", [
            DIAG(diag_waterfall),
            KV(L("**click**", "**klik**"), L("sets your TX offset", "nastaví TX offset"), kwh),
            KV(L("**hover**", "**najetí**"), L("callsigns where they were last heard", "značky tam, kde je naposled slyšel"),
               kw),
            KV("**TX speed**", L("AUTO · **A** 15 s · B · C · **E** slow · **I** fast", "AUTO · **A** 15 s · B · C · "
                                 "**E** pomalý · **I** rychlý"), kw),
            KV("**HB**", L("one heartbeat now", "jeden heartbeat hned"), kw),
            KV("**TUNE**", L("steady tone — turns into STOP", "stálý tón — změní se na STOP"), kw),
            KV("**GPS**", L("radio's GPS position to APRS-IS", "poloha z GPS rádia do APRS-IS"), kw),
        ]),
        Card(L("Dial frequencies · MHz · USB-D", "Kmitočty · MHz · USB-D"), "violet", [
            GRID(["**160** 1.8435", "**80** 3.578", "**60** 5.363", "**40** 7.078", "**30** 10.130",
                  "**20** 14.078", "**17** 18.104", "**15** 21.078", "**12** 24.922", "**10** 28.078",
                  "**6** 50.318", "**2** 144.178"], cols=3),
            P(L("The frequency button's menu tunes them and sets USB-D. A dial off these is only coloured.",
                "Nabídka tlačítka kmitočtu je naladí a nastaví USB-D. Jiný kmitočet se jen obarví."), color=MUTED),
        ]),
    ]
    col3 = [
        Card("TX SESSION", "green", [
            B(L("**Recipient** — click any callsign on the page (× clears)",
                "**Recipient** — klikni na jakoukoli značku na stránce (× smaže)")),
            B(L("**Message** — [[Enter]] sends · **▾** presets", "**Message** — [[Enter]] vyšle · **▾** předvolby")),
            B(L("**SEND LATER** — waits in MSG BOX until they or a relay are on the band (≤ 120 characters)",
                "**SEND LATER** — počká v MSG BOX, až bude adresát nebo prostředník na pásmu (≤ 120 znaků)")),
            B(L("**LOG QSO** · **ABORT** in the header", "**LOG QSO** · **ABORT** v záhlaví")),
            SUB(L("Routes through a relay", "Cesty přes prostředníka")),
            DIAG(diag_route),
            P(L("Under Message: stations you decode that hear the addressee, **DIRECT** first. Click a row to send "
                "through it; it turns **via HB9BV** once the relay confirms.",
                "Pod Message: stanice, které dekóduješ a které slyší adresáta, **DIRECT** první. Klik na řádek pošle "
                "zprávu přes ni; až prostředník potvrdí, ukáže se **via HB9BV**.")),
        ]),
        Card(L("Presets ▾", "Předvolby ▾"), "amber", [
            GRID(["CQ CQ CQ", "SNR ±nn", "SNR?", "HW CPY?", "QSL?", "GRID?", "INFO?", "STATUS?", "HEARING?",
                  "@APRSIS"], cols=2),
            P(L("**@APRSIS** → **GRID** (your position) or **CMD** (text to a service or a call)",
                "**@APRSIS** → **GRID** (tvoje poloha) nebo **CMD** (text službě nebo značce)")),
        ]),
        Card(L("Logging", "Zápis do deníku"), "green", [
            P(L("SNR both ways = QSO → logged by itself to `YYYY-MM-DD-JS8CALL`, mode **JS8** (ADIF MFSK / JS8). "
                "**LOG QSO** does it by hand, then turns into **VIEW LOG**.",
                "SNR oběma směry = QSO → zapíše se samo do `RRRR-MM-DD-JS8CALL`, mód **JS8** (ADIF MFSK / JS8). "
                "**LOG QSO** to udělá ručně, pak se změní na **VIEW LOG**.")),
        ]),
    ]
    col4 = [
        Card(L("Stations & map", "Stanice a mapa"), "teal", [
            B(L("Table: Call · DXCC · SNR · Hz · speed · distance · last; click a call to select it",
                "Tabulka: Call · DXCC · SNR · Hz · rychlost · vzdálenost · naposled; klik vybere značku")),
            B(L("Map: **red dot** = heard you · ring = only mentioned · **LINKS** who hears whom (60 min) · **LOG** "
                "distance scale", "Mapa: **červená tečka** = slyšel tě · kroužek = jen zmíněn · **LINKS** kdo slyší "
                "koho (60 min) · **LOG** měřítko")),
        ]),
        Card(L("MSG BOX & groups", "MSG BOX a skupiny"), "violet", [
            B(L("Store-and-forward mail both ways; clicking a message marks it read",
                "Pošta uložit-a-předat oběma směry; klik na zprávu = přečteno")),
            B(L("**@ALLCALL**, **@HB** always on; join more, add **@OWN** (a custom name costs a frame, ~15 s)",
                "**@ALLCALL**, **@HB** vždy; přidej další, vlastní **@JMENO** (stojí rámec navíc, ~15 s)")),
        ]),
        Card(L("Unattended", "Bez obsluhy"), "red", [
            B(L("**Answer queries automatically** is the ARM switch — without it no heartbeats, ACKs, replies or relays",
                "**Answer queries automatically** = hlavní vypínač — bez něj žádné heartbeaty, ACK, odpovědi ani relay")),
            B(L("**Unattended for** 1 · 6 · 12 · 24 · 168 h, counts down",
                "**Unattended for** 1 · 6 · 12 · 24 · 168 h, odpočítává")),
            B(L("**Repeat CQ** runs even when not armed", "**Repeat CQ** běží i bez zapnutí")),
            B(L("The pills in the SETTINGS header are switches", "Štítky v záhlaví SETTINGS jsou vypínače")),
        ]),
        Card(L("When it does not work", "Když to nejde"), "slate", [
            KV(L("**PTT, no RF**", "**PTT, bez RF**"), "`DATA MOD` = WLAN", 23),
            KV(L("**Loading 0 %**", "**Loading 0 %**"), L("press **RETRY**", "stiskni **RETRY**"), 23),
            KV(L("**TX underrun**", "**TX underrun**"), L("tablet closer to the Wi-Fi AP", "tablet blíž k Wi-Fi AP"), 23),
            KV(L("**Android hotspot**", "**Android hotspot**"), L("use a real router", "použij skutečný router"), 23),
        ]),
    ]
    return {
        "name": "js8call",
        "title": "JS8Call-ICOM",
        "subtitle": L("JS8 over ICOM-LAN, the whole station in a browser tab · DATA → JS8Call-ICOM",
                      "JS8 přes ICOM-LAN, celá stanice v kartě prohlížeče · DATA → JS8Call-ICOM"),
        "ref": "SOFTWARE.md § 5",
        "size": 2.8,
        "weights": [1.0, 1.05, 1.05, 1.0],
        "columns": [col1, col2, col3, col4],
    }


# ═════════════════════════════════════════════════════════════════════════════
#  Raspberry Pi station
# ═════════════════════════════════════════════════════════════════════════════

def diag_station(x, y, w):
    o = []
    # radio, left
    rx, ry, rw, rh = x, y + 9.0, 15.5, 13.0
    o.append(box(rx, ry, rw, rh, "#2a313b", rx=1.2))
    o.append(box(rx + 1.3, ry + 1.4, 8.2, 3.9, "#9fd8ff", rx=0.4))
    o.append(t(rx + 5.4, ry + 4.2, "14.074", 1.75, "#10324a", "bold", "middle", mono=True))
    o.append(f'<circle cx="{rx + 12.4:.2f}" cy="{ry + 3.6:.2f}" r="2.0" fill="#4a5462" stroke="#7d8896" '
             f'stroke-width="0.25"/>')
    o.append(t(rx + rw / 2, ry + rh - 2.0, L("radio", "rádio"), 2.0, "#e8edf3", "bold", "middle"))
    # pi, middle
    px, pw, py, ph = x + w * 0.47, w * 0.27, y + 5.0, 21.0
    o.append(box(px, py, pw, ph, "#1e7a46", rx=1.4))
    o.append(t(px + pw / 2, py + 3.2, "Raspberry Pi", 1.85, "#fff", "bold", "middle"))
    for i, (name, port) in enumerate((("WIFILT", ":80"), ("local-trx", ":8765"))):
        yy = py + 4.8 + i * 7.6
        o.append(box(px + 1.2, yy, pw - 2.4, 6.0, "#ffffff", rx=0.6))
        o.append(t(px + pw / 2, yy + 2.6, name, 1.85, INK, "bold", "middle"))
        o.append(t(px + pw / 2, yy + 4.9, port, 1.6, MUTED, anchor="middle", mono=True))
    o.append(f'<path d="M{px + pw / 2:.2f},{py + 10.9:.2f} v1.4" stroke="#fff" stroke-width="0.35"/>')
    # cables radio <-> pi
    for i, (lab, col) in enumerate(((L("CAT · USB", "CAT · USB"), ACCENT["blue"]),
                                    (L("audio · USB card", "audio · USB karta"), ACCENT["violet"]),
                                    (L("key / PTT", "klíč / PTT"), ACCENT["red"]))):
        yy = ry + 2.8 + i * 4.0
        o.append(f'<line x1="{rx + rw:.2f}" y1="{yy:.2f}" x2="{px:.2f}" y2="{yy:.2f}" stroke="{col}" '
                 f'stroke-width="0.45"/>')
        o.append(t((rx + rw + px) / 2, yy - 0.55, lab, 1.4, col, "bold", "middle"))
    # router, right top
    ow = w - (px + pw - x) - 4.0
    ox, oy = x + w - ow, y + 1.6
    o.append(box(ox, oy, ow, 7.4, "#46566a", rx=1.0))
    o.append(t(ox + ow / 2, oy + 3.1, "router", 1.85, "#fff", "bold", "middle"))
    o.append(t(ox + ow / 2, oy + 5.7, "Wi-Fi / LAN", 1.4, "#d7dee7", anchor="middle"))
    for k in range(3):
        o.append(f'<path d="M{ox + ow / 2 - 3 + k * 3:.2f},{oy:.2f} l0,-1.4" stroke="#46566a" stroke-width="0.5"/>')
    o.append(f'<line x1="{px + pw:.2f}" y1="{py + 5.5:.2f}" x2="{ox:.2f}" y2="{oy + 5.0:.2f}" '
             f'stroke="{ACCENT["amber"]}" stroke-width="0.45" stroke-dasharray="1 0.6"/>')
    # browser, right bottom
    bx, by = ox, y + 17.5
    o.append(box(bx, by, ow, 10.0, "#ffffff", "#46566a", 1.0, 0.35))
    o.append(box(bx + 1.0, by + 1.0, ow - 2.0, 5.6, "#e9eef4", rx=0.4))
    o.append(t(bx + ow / 2, by + 3.3, "QRPlog", 1.55, INK, "bold", "middle"))
    o.append(t(bx + ow / 2, by + 5.5, "JS8 · DXC", 1.35, MUTED, anchor="middle"))
    o.append(t(bx + ow / 2, by + 8.8, L("phone / PC", "telefon / PC"), 1.45, INK, anchor="middle"))
    o.append(f'<line x1="{ox + ow / 2:.2f}" y1="{oy + 7.4:.2f}" x2="{bx + ow / 2:.2f}" y2="{by:.2f}" '
             f'stroke="{ACCENT["amber"]}" stroke-width="0.45" stroke-dasharray="1 0.6"/>')
    o.append(t(ox + ow / 2 + 0.8, (oy + 7.4 + by) / 2 + 0.6, "Wi-Fi", 1.4, ACCENT["amber"], "bold"))
    # OI3 alternative, under the radio
    o.append(box(rx, ry + rh + 2.0, rw + 6.0, 6.4, "#fff6e0", "#e2b13c", 0.8, 0.25))
    o.append(t(rx + (rw + 6.0) / 2, ry + rh + 4.5, L("key/PTT: or the OI3", "klíč/PTT: nebo OI3"), 1.45, INK, "bold",
               "middle"))
    o.append(t(rx + (rw + 6.0) / 2, ry + rh + 6.9, L("over TrxNet", "přes TrxNet"), 1.4, MUTED, anchor="middle"))
    o.append(t(px + pw / 2, py + ph + 4.6, "http://hostname.local/", 1.9, ACCENT["blue"], "bold", "middle", mono=True))
    return "".join(o), py + ph + 6.0 - y


def diag_wifi_flow(x, y, w):
    o = []
    bw = w * 0.60
    rx_ = x + bw + 4.0
    rw = w - bw - 4.0
    yy = y

    def step(label, sub, fill, txt="#fff", hh=7.0):
        nonlocal yy
        o.append(box(x, yy, bw, hh, fill, rx=1.0))
        o.append(t(x + 1.5, yy + 2.9, label, 2.05, txt, "bold"))
        if sub:
            o.append(t(x + 1.5, yy + 5.4, sub, 1.65, txt))
        top = yy
        yy += hh + 3.0
        return top

    s1 = step(L("Boot", "Start"), L("known Wi-Fi within 40 s?", "známá Wi-Fi do 40 s?"), ACCENT["slate"])
    o.append(arrow(x + bw / 2, s1 + 7.0, x + bw / 2, s1 + 9.9, MUTED))
    s2 = step(L("Try known networks", "Zkus známé sítě"), L("in range, by priority", "v dosahu, podle priority"),
              ACCENT["slate"])
    o.append(arrow(x + bw / 2, s2 + 7.0, x + bw / 2, s2 + 9.9, MUTED))
    o.append(t(x + bw / 2 + 1.0, s2 + 9.2, L("none", "žádná"), 1.6, ACCENT["red"], "bold"))
    s3 = step("AP  WIFILT-setup-XXXX", L("password chosen at install", "heslo zvolené při instalaci"), ACCENT["amber"],
              hh=7.0)
    o.append(arrow(x + bw / 2, s3 + 7.0, x + bw / 2, s3 + 9.9, MUTED))
    s4 = step(L("Phone joins → portal", "Telefon se připojí → portál"), L("add a network → Save", "přidat síť → Save"),
              ACCENT["violet"])
    # loop back
    lx = x - 0.0
    o.append(f'<path d="M{x + 0.8:.2f},{s4 + 3.5:.2f} H{x - 1.8:.2f} V{s2 + 3.5:.2f} H{x - 0.2:.2f}" fill="none" '
             f'stroke="{ACCENT["violet"]}" stroke-width="0.35"/>')
    o.append(f'<path d="M{x:.2f},{s2 + 3.5:.2f} l-1.0,-0.6 v1.2 Z" fill="{ACCENT["violet"]}"/>')
    # connected box
    cy_ = s1 + 4.0
    o.append(box(rx_, cy_, rw, 16.0, "#e6f4ec", ACCENT["green"], 1.0, 0.35))
    o.append(t(rx_ + rw / 2, cy_ + 3.6, L("connected", "připojeno"), 2.1, ACCENT["green"], "bold", "middle"))
    o.append(t(rx_ + rw / 2, cy_ + 7.0, "hostname", 1.7, INK, "bold", "middle", mono=True))
    o.append(t(rx_ + rw / 2, cy_ + 9.4, ".local", 1.7, INK, "bold", "middle", mono=True))
    o.append(t(rx_ + rw / 2, cy_ + 13.0, L("WIFILT :80", "WIFILT :80"), 1.6, MUTED, anchor="middle"))
    o.append(arrow(x + bw, s1 + 3.5, rx_ - 0.2, s1 + 6.0, ACCENT["green"], 0.35))
    o.append(t(x + bw + 0.6, s1 + 3.0, L("yes", "ano"), 1.6, ACCENT["green"], "bold"))
    o.append(arrow(x + bw, s2 + 3.5, rx_ - 0.2, s2 + 1.0, ACCENT["green"], 0.35))
    o.append(t(x + bw + 0.6, s2 + 5.6, "OK", 1.6, ACCENT["green"], "bold"))
    # AP box on the right
    ay = s3 - 0.5
    o.append(box(rx_, ay, rw, 12.5, "#fff6e0", "#e2b13c", 1.0, 0.3))
    o.append(t(rx_ + rw / 2, ay + 3.0, L("on the AP", "na AP"), 1.7, INK, "bold", "middle"))
    o.append(t(rx_ + rw / 2, ay + 6.0, "192.168.4.1", 1.75, INK, "bold", "middle", mono=True))
    o.append(t(rx_ + rw / 2, ay + 8.6, "WIFILT + SSH", 1.55, MUTED, anchor="middle"))
    o.append(t(rx_ + rw / 2, ay + 11.0, L("portal opens itself", "portál se otevře sám"), 1.45, MUTED,
               anchor="middle"))
    return "".join(o), yy - y - 2.0


def diag_lcd(x, y, w):
    o = []
    lw = min(w, 52.0)
    o.append(box(x, y, lw, 12.0, "#26303a", rx=1.2))
    o.append(box(x + 1.5, y + 1.5, lw - 3.0, 9.0, "#9cc53f", rx=0.6))
    cw = (lw - 5.0) / 16.0
    # bars
    for i, hh in enumerate((1.0, 1.8, 2.6)):
        o.append(box(x + 2.6 + i * 0.75, y + 5.0 - hh, 0.55, hh, "#1f2d0c", rx=0))
    o.append(t(x + 2.5 + cw * 1.3, y + 5.0, "-62 Domov", 2.6, "#1f2d0c", "bold", mono=True))
    # lock
    lx, ly = x + lw - 5.0, y + 2.6
    o.append(box(lx, ly + 1.1, 2.2, 1.8, "#1f2d0c", rx=0.2))
    o.append(f'<path d="M{lx + 0.45:.2f},{ly + 1.2:.2f} v-0.5 a0.65,0.65 0 0 1 1.3,0 v0.5" fill="none" '
             f'stroke="#1f2d0c" stroke-width="0.35"/>')
    o.append(t(x + 2.5, y + 9.4, "192.168.1.23", 2.6, "#1f2d0c", "bold", mono=True))
    o.append(t(x + lw - 3.0, y + 9.4, "H", 2.6, "#1f2d0c", "bold", "end", mono=True))
    return "".join(o), 12.5


def sheet_rpi():
    col1 = [
        Card(L("The station", "Stanice"), "slate", [
            DIAG(diag_station),
            P(L("local-trx makes any hamlib radio look like an ICOM on the network; WIFILT talks to it on the Pi "
                "itself (127.0.0.1).",
                "local-trx udělá z jakéhokoli rádia v hamlibu síťový ICOM; WIFILT s ním mluví přímo na Pi "
                "(127.0.0.1)."), size=2.35, color=MUTED),
        ]),
        Card(L("1 · The SD card", "1 · SD karta"), "blue", [
            STEP(1, L("Raspberry Pi Imager → **Raspberry Pi OS Lite (64-bit)**",
                      "Raspberry Pi Imager → **Raspberry Pi OS Lite (64-bit)**")),
            STEP(2, L("In its settings: **host name**, user, **SSH**, your **Wi-Fi**",
                      "V jeho nastavení: **host name**, uživatel, **SSH**, tvoje **Wi-Fi**")),
            STEP(3, L("Boot it, then `ssh user@hostname.local`", "Nabootuj a `ssh uzivatel@hostname.local`")),
        ]),
        Card(L("2 · Guided install", "2 · Instalace s průvodcem"), "green", [
            CODE(["$ curl -fsSL \\", "    https://ok1hra.github.io/wifilt/pi-setup \\", "    | bash"], size=2.2),
            P(L("All questions first → the plan → **Start?** → it works on its own (the OI3 build takes minutes).",
                "Nejdřív všechny otázky → plán → **Start?** → dál pracuje sám (sestavení OI3 trvá minuty).")),
            KV(L("**packages**", "**balíčky**"), L("always · user into `audio`, `dialout`", "vždy · uživatel do `audio`, `dialout`"),
               19),
            KV("**WIFILT**", L("+ local-trx, **start at boot**: yes", "+ local-trx, **start při bootu**: ano"), 19),
            KV(L("**serial names**", "**jména portů**"), "`/dev/ttyUSB.cat` · `.cw` · `.panel`", 19),
            KV(L("**network**", "**síť**"), L("Wi-Fi fallback AP, Ethernet DHCP", "záložní Wi-Fi AP, Ethernet DHCP"), 19),
            KV(L("**OI3**, **fslock**", "**OI3**, **fslock**"), L("optional, default no", "volitelné, výchozí ne"), 19),
            P(L("Later: `wifilt-pi-setup` (`--only` · `--yes` · `--dry-run`). Log: `/var/log/wifilt-pi-setup.log`",
                "Později: `wifilt-pi-setup` (`--only` · `--yes` · `--dry-run`). Log: `/var/log/wifilt-pi-setup.log`"),
              size=2.35),
        ]),
    ]
    col2 = [
        Card(L("Wi-Fi & the setup access point", "Wi-Fi a nastavovací AP"), "amber", [
            DIAG(diag_wifi_flow),
            B(L("AP name `WIFILT-setup-XXXX` (end of the MAC)", "Jméno AP `WIFILT-setup-XXXX` (konec MAC)")),
            B(L("Join from a phone — the portal opens by itself; add or remove networks, **Save**",
                "Připoj se telefonem — portál se otevře sám; přidej či odeber sítě, **Save**")),
            B(L("Wi-Fi lost for > 2 min → AP again; an AP nobody joins retries the known networks every 5 min",
                "Wi-Fi pryč > 2 min → znovu AP; AP bez klienta zkouší známé sítě každých 5 min")),
            B(L("Settings: `/etc/default/wifi-fallback`, then `sudo systemctl restart wifi-fallback`",
                "Nastavení: `/etc/default/wifi-fallback`, pak `sudo systemctl restart wifi-fallback`"), size=2.35),
        ]),
        Card("Ethernet", "teal", [
            B(L("DHCP client; nobody answers in 20 s → the Pi is the DHCP server `192.168.50.1/24` (TrxNet boxes on a "
                "bare cable get addresses)",
                "DHCP klient; nikdo neodpoví do 20 s → Pi je DHCP server `192.168.50.1/24` (TrxNet krabičky na holém "
                "kabelu dostanou adresy)")),
        ]),
        Card(L("Where is the Pi?", "Kde je Pi?"), "slate", [
            B(L("`http://hostname.local/` — or the router's client list", "`http://hostname.local/` — nebo seznam klientů v routeru")),
            B(L("OI3 menu **RPI** (item 26) shows network and address", "Menu OI3 **RPI** (položka 26) ukáže síť a adresu")),
        ]),
        Card(L("Ports", "Porty"), "slate", [
            GRID([L("**80** web", "**80** web"), L("**82** DX cluster", "**82** DX cluster"),
                  L("**83** audio", "**83** audio"), L("**8765** local-trx", "**8765** local-trx")], cols=2),
            P(L("Without the port permission WIFILT moves to **+8000** (8080 …) and an amber banner says how to fix it.",
                "Bez oprávnění k portům se WIFILT přesune o **+8000** (8080 …) a oranžový pruh řekne, jak to opravit."),
              size=2.35),
        ]),
    ]
    col3 = [
        Card(L("3 · local-trx  —  :8765", "3 · local-trx  —  :8765"), "violet", [
            P("`http://hostname.local:8765/`"),
            STEP(1, L("**Audio** — capture (RX) and playback (TX) device; meter, test tone",
                      "**Audio** — vstup (RX) a výstup (TX) zvukovky; měřák, testovací tón")),
            STEP(2, L("**CAT** — `/dev/ttyUSB.cat`, baud, hamlib model · **Test read freq**",
                      "**CAT** — `/dev/ttyUSB.cat`, rychlost, model z hamlibu · **Test read freq**")),
            STEP(3, L("**Keying** — a second serial adapter (DTR / RTS = KEY / PTT) or a TrxNet device such as the OI3; "
                      "WPM · **Test KEY / PTT**",
                      "**Klíčování** — druhý sériový adaptér (DTR / RTS = KEY / PTT) nebo TrxNet zařízení jako OI3; "
                      "WPM · **Test KEY / PTT**")),
            STEP(4, L("Name, CI-V **A6**, listen **127.0.0.1** → **Run** → **Save** (restarts local-trx)",
                      "Jméno, CI-V **A6**, poslouchat **127.0.0.1** → **Run** → **Save** (restartuje local-trx)")),
            NOTE(L("CW, FSK and PTT never go over CAT. A TS-480 can also get its front panel back.",
                   "CW, FSK a PTT nikdy nejdou přes CAT. TS-480 navíc dostane zpět svůj čelní panel.")),
        ]),
        Card(L("4 · WIFILT  —  SETUP", "4 · WIFILT  —  SETUP"), "blue", [
            P("`http://hostname.local/` → **SETUP**"),
            STEP(1, L("**Identity** — callsign and locator", "**Identity** — značka a lokátor")),
            STEP(2, L("**Radio** → TRX1 ☑ **LOCAL-TRX** (fills 127.0.0.1 and A6) → **Save & Restart**",
                      "**Radio** → TRX1 ☑ **LOCAL-TRX** (vyplní 127.0.0.1 a A6) → **Save & Restart**")),
            STEP(3, L("**Audio** step turns green (port 83)", "Krok **Audio** zezelená (port 83)")),
            STEP(4, L("**Transmit check** → TX audio calibration", "**Transmit check** → kalibrace TX audia")),
            STEP(5, L("**This browser** — the QSO log lives in the browser you use",
                      "**This browser** — deník QSO žije v prohlížeči, který používáš")),
        ]),
        Card(L("Over SSH", "Přes SSH"), "slate", [
            CODE(["$ systemctl status wifilt local-trx", "$ journalctl -fu wifilt", "$ journalctl -fu wifi-fallback"],
                 size=2.15),
            P(L("Add a Wi-Fi network by hand:", "Přidat Wi-Fi síť ručně:")),
            CODE(["$ sudo nmcli dev wifi connect SSID \\", "      password PASSWORD"], size=2.15),
        ]),
    ]
    col4 = [
        Card(L("fslock — pull the plug safely", "fslock — bezpečné vytažení"), "red", [
            P(L("The root file system runs in RAM; the settings live on a 2nd card in a USB reader (`RPIDATA` → `/data`).",
                "Kořenový systém běží v RAM; nastavení je na 2. kartě v USB čtečce (`RPIDATA` → `/data`).")),
            CODE(["$ sudo fslock status", "$ sudo fslock lock", "$ sudo fslock unlock", "$ sudo fslock list",
                  "$ sudo fslock restore 2"], size=2.2),
            P(L("Lock the first time yourself: reboot, check `status` (data card, every path “on card”), then `lock`.",
                "Poprvé zamkni sám: restart, zkontroluj `status` (datová karta, vše „on card“), pak `lock`."),
              size=2.35),
        ]),
        Card(L("Updates", "Aktualizace"), "green", [
            B(L("Amber **→ rev ▲** in the top bar → **Update…** → **Update now**",
                "Oranžové **→ rev ▲** v horní liště → **Update…** → **Update now**")),
            B(L("Download + SHA256 · copy in `/opt/wifilt.prev` · restart · rolls back if it does not answer",
                "Stažení + SHA256 · kopie v `/opt/wifilt.prev` · restart · vrátí se, když neodpoví")),
            B(L("Locked Pi: unlock → reboot → install → lock again (3–5 min)",
                "Zamčené Pi: odemkne → restart → instalace → znovu zamkne (3–5 min)")),
            B(L("Refused while transmitting or with unattended operation armed",
                "Odmítne během vysílání nebo se zapnutým provozem bez obsluhy")),
            B(L("By hand: `wifilt-pi-setup`", "Ručně: `wifilt-pi-setup`")),
        ]),
        Card(L("OI3 display — menu RPI", "Displej OI3 — menu RPI"), "teal", [
            DIAG(diag_lcd),
            KV(L("**bars**", "**čárky**"), L("Wi-Fi signal · a mast = the Pi's AP · ? = silent 15 s",
                                            "signál Wi-Fi · stožár = AP Pi · ? = 15 s ticho"), 14.5),
            KV(L("**lock**", "**zámek**"), L("closed = fslock locked · blinking open = unlocked",
                                            "zavřený = zamčeno · blikající otevřený = odemčeno"), 14.5),
            KV(L("**row 2**", "**2. řádek**"), L("address · UPDATE 45% · RPI OFFLINE …", "adresa · UPDATE 45% · RPI OFFLINE …"),
               14.5),
        ]),
    ]
    return {
        "name": "rpi-station",
        "title": L("WIFILT + local-trx on a Raspberry Pi", "WIFILT + local-trx na Raspberry Pi"),
        "subtitle": L("a headless station by the radio · any rig through hamlib · Wi-Fi that sets itself up",
                      "stanice bez monitoru u rádia · jakékoli rádio přes hamlib · Wi-Fi, která se nastaví sama"),
        "ref": "SOFTWARE.md § 1.6–1.8, 2, 9.3",
        "size": 2.68,
        "weights": [1.12, 1.0, 1.0, 0.98],
        "columns": [col1, col2, col3, col4],
    }


# ═════════════════════════════════════════════════════════════════════════════
#  Ways to set it up -- illustrated
# ═════════════════════════════════════════════════════════════════════════════
# Devices are drawn at a nominal size and placed with translate + scale, so a
# phone looks like the same phone wherever it appears. Every painter returns
# (svg, width, height) at the scale it was given.

def _g(x, y, k, inner):
    return f'<g transform="translate({x:.2f},{y:.2f}) scale({k:.3f})">{inner}</g>'


def _mini_ui(x, y, w, h, dense=True):
    """A tiny QRPlog: tab bar, journal rows, band map, input row, buttons."""
    o = [box(x, y, w, h, "#f4f6f9", rx=0.5),
         box(x, y, w, h * 0.13, "#1b2028", rx=0.5),
         box(x + w * 0.05, y + h * 0.03, w * 0.18, h * 0.07, AMBER_UI, rx=0.3)]
    rows = 4 if dense else 3
    for i in range(rows):
        yy = y + h * (0.19 + i * 0.085)
        o.append(box(x + w * 0.05, yy, w * (0.86 if i % 2 else 0.74), h * 0.035, "#c9d1db", rx=0.2))
    by = y + h * 0.56
    pts = " ".join(f"{x + w * (0.05 + 0.9 * i / 20):.2f},"
                   f"{by + h * (0.06 - (0.05 if i in (6, 13) else 0.012 * ((i * 7) % 3))):.2f}" for i in range(21))
    o.append(f'<polyline points="{pts}" fill="none" stroke="#2f6fb0" stroke-width="{h * 0.012:.3f}"/>')
    iy = y + h * 0.7
    o.append(box(x + w * 0.05, iy, w * 0.36, h * 0.1, "#ffffff", "#7f8b99", 0.3, h * 0.008))
    o.append(box(x + w * 0.45, iy, w * 0.14, h * 0.1, "#ffffff", "#7f8b99", 0.3, h * 0.008))
    o.append(box(x + w * 0.63, iy, w * 0.32, h * 0.1, "#ffffff", "#7f8b99", 0.3, h * 0.008))
    o.append(box(x + w * 0.05, y + h * 0.85, w * 0.2, h * 0.08, ACCENT["blue"], rx=0.3))
    o.append(box(x + w * 0.28, y + h * 0.85, w * 0.16, h * 0.08, AMBER_UI, rx=0.3))
    o.append(box(x + w * 0.74, y + h * 0.85, w * 0.21, h * 0.08, ACCENT["green"], rx=0.3))
    return "".join(o)


def dev_phone(x, y, k=1.0):
    w, h = 11.0, 21.0
    o = [box(0, 0, w, h, "#1d232b", rx=1.9),
         _mini_ui(0.7, 1.9, w - 1.4, h - 3.6),
         box(w / 2 - 1.6, 0.6, 3.2, 0.7, "#0b0e12", rx=0.35),
         box(w / 2 - 2.0, h - 1.05, 4.0, 0.35, "#5b6573", rx=0.17)]
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_tablet(x, y, k=1.0):
    w, h = 32.0, 22.0
    o = [box(0, 0, w, h, "#1d232b", rx=2.0),
         _mini_ui(1.6, 1.3, w - 3.2, h - 2.6),
         f'<circle cx="0.8" cy="{h / 2:.2f}" r="0.35" fill="#3a4452"/>']
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_laptop(x, y, k=1.0, label=None):
    w = 32.0
    o = [box(0, 0, w, 20.5, "#2a313b", rx=1.3),
         _mini_ui(1.2, 1.2, w - 2.4, 18.0),
         f'<path d="M-3,22.6 L{w + 3},22.6 L{w + 0.6},20.5 L-0.6,20.5 Z" fill="#9aa5b1"/>',
         box(-3, 22.6, w + 6, 0.8, "#6b7684", rx=0.4),
         box(w / 2 - 4, 21.0, 8, 0.9, "#7f8b99", rx=0.3)]
    if label:
        o.append(box(w / 2 - tw(label, "b", 1.9) / 2 - 1.2, 8.0, tw(label, "b", 1.9) + 2.4, 4.0, "#1b2028", rx=0.6,
                     extra=' opacity="0.88"'))
        o.append(t(w / 2, 10.75, label, 1.9, "#ffffff", "bold", "middle"))
    return _g(x, y, k, "".join(o)), (w + 6) * k, 23.4 * k


def dev_esp32(x, y, k=1.0):
    w, h = 17.0, 10.5
    o = [box(0, 0, w, h, "#dfe5ec", "#8d98a5", 1.2, 0.3),
         box(0, 0, w, 2.4, "#c4ccd6", rx=1.2),
         box(0, 1.2, w, 1.2, "#c4ccd6", rx=0),
         t(1.4, 6.0, "WIFILT", 2.3, INK, "bold"),
         t(1.4, 8.7, "ESP32", 1.7, MUTED),
         f'<circle cx="{w - 2.2:.2f}" cy="5.0" r="0.9" fill="#3d8bff"/>',
         f'<circle cx="{w - 2.2:.2f}" cy="5.0" r="1.6" fill="#3d8bff" opacity="0.25"/>']
    for i in range(3):
        o.append(f'<circle cx="{w - 6.6 + i * 2.2:.2f}" cy="8.4" r="0.7" fill="#4a5462"/>')
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_ic705(x, y, k=1.0, label="IC-705"):
    w, h = 24.0, 13.0
    o = [f'<line x1="3.0" y1="0" x2="3.0" y2="-9" stroke="#3a3f47" stroke-width="0.5"/>',
         box(2.2, -0.9, 1.6, 1.2, "#7f8b99", rx=0.3),
         box(0, 0, w, h, "#2b2f36", rx=1.6),
         box(1.4, 1.6, 13.0, 6.6, "#0f3a66", rx=0.6),
         box(1.4, 1.6, 13.0, 2.0, "#1b5a99", rx=0.6),
         t(7.9, 6.8, "14.074", 2.3, "#cfe9ff", "bold", "middle", mono=True),
         f'<circle cx="19.3" cy="6.2" r="3.5" fill="#1a1d22" stroke="#555c66" stroke-width="0.35"/>',
         f'<circle cx="19.3" cy="6.2" r="1.1" fill="#3a3f47"/>',
         f'<circle cx="21.2" cy="4.6" r="0.35" fill="#8d98a5"/>']
    for i in range(5):
        o.append(box(1.6 + i * 2.6, 9.4, 2.0, 1.1, "#4a5462", rx=0.3))
    o.append(t(w - 1.0, h - 0.9, label, 1.6, "#c6ced8", "bold", "end"))
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_rig(x, y, k=1.0, label="IC-7610"):
    w, h = 40.0, 15.0
    o = [box(0, 0, w, h, "#2b2f36", rx=1.4),
         box(0.8, 0.8, w - 1.6, 1.0, "#3a3f47", rx=0.5),
         box(9.5, 2.6, 17.0, 9.0, "#0d1117", rx=0.5)]
    pts = " ".join(f"{10.0 + i * 0.8:.2f},{7.0 - (2.2 if i in (5, 6, 14) else 0.5 + 0.3 * ((i * 5) % 3)):.2f}"
                   for i in range(21))
    o.append(f'<polyline points="{pts}" fill="none" stroke="#5fb3ff" stroke-width="0.25"/>')
    o.append(box(10.0, 7.6, 16.0, 3.4, "#14304d", rx=0.2))
    o.append(t(18.0, 6.0 - 2.0, "7.074.00", 1.6, "#cfe9ff", "bold", "middle", mono=True))
    o.append(f'<circle cx="32.8" cy="7.6" r="4.6" fill="#1a1d22" stroke="#555c66" stroke-width="0.35"/>')
    o.append(f'<circle cx="32.8" cy="7.6" r="1.4" fill="#3a3f47"/>')
    for cx in (3.0, 6.6):
        o.append(f'<circle cx="{cx}" cy="5.2" r="1.3" fill="#1a1d22" stroke="#555c66" stroke-width="0.25"/>')
        o.append(f'<circle cx="{cx}" cy="9.8" r="1.0" fill="#1a1d22" stroke="#555c66" stroke-width="0.25"/>')
    for i in range(6):
        o.append(box(9.6 + i * 2.85, 12.2, 2.3, 1.2, "#4a5462", rx=0.3))
    o.append(t(w - 1.0, h - 0.8, label, 1.5, "#c6ced8", "bold", "end"))
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_ts480(x, y, k=1.0):
    w, h = 28.0, 9.0
    o = [box(0, 0, w, h, "#24282e", rx=1.0)]
    for i in range(9):
        o.append(f'<line x1="{15.0 + i * 1.35:.2f}" y1="1.2" x2="{15.0 + i * 1.35:.2f}" y2="{h - 1.2}" '
                 f'stroke="#3d434c" stroke-width="0.55"/>')
    o.append(box(1.4, 2.2, 3.4, 2.4, "#c9d1db", rx=0.3))
    o.append(box(2.1, 2.7, 2.0, 1.4, "#2b2f36", rx=0.1))
    o.append(t(1.4, 7.6, "TS-480", 1.75, "#e8edf3", "bold"))
    o.append(t(6.0, 4.2, "RJ12", 1.35, "#9aa5b1"))
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_panel_ghost(x, y, k=1.0, label=None):
    w, h = 28.0, 9.0
    o = [box(0, 0, w, h, "none", "#9aa5b1", 1.0, 0.3, extra=' stroke-dasharray="1 0.7"'),
         box(2.0, 1.6, 12.0, 5.6, "none", "#b7c0cb", 0.4, 0.25, extra=' stroke-dasharray="0.8 0.6"'),
         f'<circle cx="21.0" cy="4.5" r="2.8" fill="none" stroke="#b7c0cb" stroke-width="0.25" '
         f'stroke-dasharray="0.8 0.6"/>',
         f'<path d="M1,1 L{w - 1},{h - 1} M{w - 1},1 L1,{h - 1}" stroke="{ACCENT["red"]}" stroke-width="0.5" '
         f'opacity="0.85"/>']
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_rpi(x, y, k=1.0):
    w, h = 21.0, 14.0
    o = [box(0, 0, w, h, "#1f8b4c", rx=1.0)]
    for cx, cy in ((1.4, 1.4), (w - 6.2, 1.4), (1.4, h - 1.4), (w - 6.2, h - 1.4)):
        o.append(f'<circle cx="{cx}" cy="{cy}" r="0.6" fill="#e3c75f"/>')
    for i in range(14):
        o.append(box(2.6 + i * 0.95, 0.5, 0.6, 0.6, "#e3c75f", rx=0))
        o.append(box(2.6 + i * 0.95, 1.4, 0.6, 0.6, "#e3c75f", rx=0))
    o.append(box(4.0, 4.6, 6.0, 6.0, "#2a2f36", rx=0.3))
    o.append(box(11.0, 5.4, 2.6, 2.6, "#2a2f36", rx=0.2))
    for i, hh in enumerate((3.6, 3.6, 4.2)):
        o.append(box(w - 4.6, 2.6 + i * 3.9, 5.2, hh - 0.4, "#c9d1db", "#8d98a5", 0.3, 0.2))
    o.append(t(1.4, h - 2.4, "Raspberry Pi", 1.5, "#ffffff", "bold"))
    return _g(x, y, k, "".join(o)), (w + 0.6) * k, h * k


def dev_pa(x, y, k=1.0):
    w, h = 34.0, 13.0
    o = [box(0, 0, w, h, "#3a3f47", rx=1.2),
         box(1.4, 1.6, 12.0, 6.0, "#163b2b", rx=0.4),
         t(7.4, 5.4, "1K-FA", 2.1, "#8ff0b5", "bold", "middle", mono=True)]
    for i in range(4):
        o.append(box(1.4 + i * 3.1, 9.0, 2.5, 1.6, "#5b6573", rx=0.3))
    for i in range(10):
        o.append(f'<line x1="{16.5 + i * 1.5:.2f}" y1="2.0" x2="{16.5 + i * 1.5:.2f}" y2="7.4" stroke="#2b2f36" '
                 f'stroke-width="0.6"/>')
    o.append(t(w - 1.0, h - 1.2, "EXPERT 1K-FA", 1.55, "#e8edf3", "bold", "end"))
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_router(x, y, k=1.0):
    w, h = 17.0, 6.5
    o = [f'<line x1="3" y1="0" x2="1.6" y2="-5" stroke="#5b6573" stroke-width="0.6" stroke-linecap="round"/>',
         f'<line x1="{w - 3}" y1="0" x2="{w - 1.6}" y2="-5" stroke="#5b6573" stroke-width="0.6" '
         f'stroke-linecap="round"/>',
         box(0, 0, w, h, "#e9edf2", "#8d98a5", 1.4, 0.3)]
    for i in range(3):
        o.append(f'<circle cx="{2.4 + i * 1.6:.2f}" cy="{h / 2:.2f}" r="0.42" fill="{"#2e8b57" if i < 2 else AMBER_UI}"/>')
    o.append(t(w - 1.0, h / 2 + 0.7, "router", 1.6, MUTED, anchor="end"))
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_oi3(x, y, k=1.0):
    w, h = 15.0, 9.0
    o = [box(0, 0, w, h, "#2f3640", rx=1.0),
         box(1.2, 1.3, 9.5, 3.8, "#9cc53f", rx=0.3),
         t(1.8, 3.0, "OI3 CW", 1.35, "#1f2d0c", "bold", mono=True),
         t(1.8, 4.6, "22 WPM", 1.35, "#1f2d0c", mono=True),
         f'<circle cx="12.6" cy="3.3" r="1.6" fill="#1a1d22" stroke="#555c66" stroke-width="0.25"/>']
    for i in range(3):
        o.append(box(1.2 + i * 3.2, 6.3, 2.6, 1.5, "#5b6573", rx=0.3))
    return _g(x, y, k, "".join(o)), w * k, h * k


def dev_box(x, y, w, h, title, sub=None, fill="#46566a"):
    o = [box(x, y, w, h, fill, rx=1.0), t(x + w / 2, y + h / 2 + (0.0 if sub else 0.7), title, 1.75, "#fff", "bold",
                                         "middle")]
    if sub:
        o.append(t(x + w / 2, y + h / 2 + 2.3, sub, 1.4, "#d7dee7", anchor="middle"))
    return "".join(o)


def dev_soundcard(x, y, k=1.0):
    o = [box(0, 0, 7.0, 3.6, "#d9dee5", "#8d98a5", 0.8, 0.25),
         f'<circle cx="2.2" cy="1.8" r="0.8" fill="#e06aa8"/>', f'<circle cx="4.8" cy="1.8" r="0.8" fill="#6abf5e"/>',
         box(7.0, 1.1, 1.8, 1.4, "#9aa5b1", rx=0.2)]
    return _g(x, y, k, "".join(o)), 8.8 * k, 3.6 * k


def antenna(x, y, h=10.0, color="#5b6573"):
    return (f'<line x1="{x:.2f}" y1="{y:.2f}" x2="{x:.2f}" y2="{y - h:.2f}" stroke="{color}" stroke-width="0.45"/>'
            f'<path d="M{x - 3.2:.2f},{y - h + 1.8:.2f} L{x:.2f},{y - h:.2f} L{x + 3.2:.2f},{y - h + 1.8:.2f}" '
            f'fill="none" stroke="{color}" stroke-width="0.45"/>')


def wifi_icon(x, y, s=1.0, color=AMBER_UI):
    o = [f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{0.45 * s:.2f}" fill="{color}"/>']
    for r in (1.4, 2.5, 3.6):
        R = r * s
        o.append(f'<path d="M{x - R * 0.7:.2f},{y - R * 0.7:.2f} A{R:.2f},{R:.2f} 0 0 1 {x + R * 0.7:.2f},'
                 f'{y - R * 0.7:.2f}" fill="none" stroke="{color}" stroke-width="{0.38 * s:.2f}" '
                 f'stroke-linecap="round"/>')
    return "".join(o)


def cloud(x, y, label):
    return (f'<g fill="#eef1f5" stroke="#9aa5b1" stroke-width="0.25">'
            f'<ellipse cx="{x:.2f}" cy="{y:.2f}" rx="6.2" ry="2.6"/>'
            f'<circle cx="{x - 2.4:.2f}" cy="{y - 1.6:.2f}" r="2.1"/>'
            f'<circle cx="{x + 1.6:.2f}" cy="{y - 2.2:.2f}" r="2.6"/></g>'
            f'<ellipse cx="{x:.2f}" cy="{y:.2f}" rx="6.0" ry="2.4" fill="#eef1f5"/>'
            + t(x, y + 0.9, label, 1.45, MUTED, "bold", "middle"))


def wlink(x1, y1, x2, y2, label=None, lx=None, ly=None, color=None):
    color = color or ACCENT["amber"]
    o = [f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" stroke="{color}" stroke-width="0.45" '
         f'stroke-dasharray="1.1 0.7" stroke-linecap="round"/>']
    if label:
        o.append(chip((x1 + x2) / 2 if lx is None else lx, (y1 + y2) / 2 if ly is None else ly, label, color))
    return "".join(o)


def cable(points, color, label=None, at=None, sw=0.5):
    d = "M" + " L".join(f"{px:.2f},{py:.2f}" for px, py in points)
    o = [f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linejoin="round"/>']
    if label:
        lx, ly = at if at else points[len(points) // 2]
        o.append(chip(lx, ly, label, color))
    return "".join(o)


def chip(cx, cy, label, color, size=1.45):
    w = tw(label, "b", size) + 1.6
    return (box(cx - w / 2, cy - size * 0.95, w, size * 1.75, "#ffffff", color, 0.6, 0.25)
            + t(cx, cy + size * 0.4, label, size, color, "bold", "middle"))


def caption(x, y, s, size=1.6, color=INK, anchor="middle", weight="bold"):
    return t(x, y, s, size, color, weight, anchor)


def diag_setup_phone(x, y, w):
    o = []
    cx = x + w / 2
    # phone = hotspot + browser
    ph, pw_, phh = dev_phone(cx - 7.15, y + 6.0, 1.3)
    o.append(wifi_icon(cx, y + 5.0, 1.0))
    # internet
    o.append(cloud(x + 9.0, y + 6.5, L("internet", "internet")))
    o.append(wlink(x + 15.4, y + 7.0, cx - 7.6, y + 10.0, L("mobile data", "mobilní data"), lx=x + 16.0, ly=y + 13.6,
                   color="#9aa5b1"))
    # ESP32 and IC-705
    ex, ey = x + 2.0, y + 33.0
    esp, ew, eh = dev_esp32(ex, ey, 1.25)
    rx_, ry_ = x + w - 30.5, y + 31.0
    rig, rw_, rh_ = dev_ic705(rx_, ry_, 1.2)
    o.append(wlink(cx - 4.0, y + 25.0, ex + ew * 0.6, ey, "Wi-Fi", lx=x + 18.0, ly=y + 27.5))
    o.append(wlink(cx + 4.0, y + 25.0, rx_ + rw_ * 0.45, ry_, "Wi-Fi", lx=x + w - 18.5, ly=y + 27.5))
    o.append(f'<path d="M{ex + ew + 0.8:.2f},{ey + eh / 2:.2f} L{rx_ - 0.8:.2f},{ey + eh / 2:.2f}" '
             f'stroke="{ACCENT["blue"]}" stroke-width="0.4" stroke-dasharray="0.4 0.6"/>')
    o.append(chip((ex + ew + rx_) / 2, ey + eh / 2 + 3.0, L("ICOM-LAN: control + audio", "ICOM-LAN: řízení + audio"),
                  ACCENT["blue"]))
    o += [ph, esp, rig]
    o.append(caption(cx, y + 6.0 + phh + 2.8, L("hotspot + browser", "hotspot + prohlížeč")))
    o.append(caption(ex + ew / 2, ey + eh + 2.6, L("WIFILT box", "krabička WIFILT")))
    o.append(caption(rx_ + rw_ / 2, ry_ + rh_ + 2.6, "IC-705"))
    return "".join(o), ry_ + rh_ + 3.6 - y


def diag_setup_pc(x, y, w):
    o = []
    # laptop with WIFILT
    lp, lw, lh = dev_laptop(x + 3.0, y + 9.0, 0.82, label="WIFILT")
    # router
    rt, rw_, rh_ = dev_router(x + w / 2 - 6.5, y + 6.0, 0.85)
    o.append(cloud(x + w / 2 + 16.0, y + 5.0, L("cluster · git", "cluster · git")))
    o.append(cable([(x + w / 2 + 7.4, y + 8.0), (x + w / 2 + 10.0, y + 6.6)], "#9aa5b1"))
    # rig and PA
    gx, gy = x + w / 2 - 14.0, y + 23.0
    rig, gw, gh = dev_rig(gx, gy, 0.78, "IC-7610")
    px, py = x + w - 27.5, y + 40.0
    pa, paw, pah = dev_pa(px, py, 0.8)
    o.append(antenna(x + w - 3.5, y + 30.0, 11.0))
    # links
    o.append(wlink(x + 3.0 + lw * 0.75, y + 13.0, x + w / 2 - 6.6, y + 9.2, "Wi-Fi / LAN", lx=x + 30.5, ly=y + 7.0))
    o.append(cable([(x + w / 2, y + 6.0 + rh_), (x + w / 2, gy)], "#6b7684", "LAN", at=(x + w / 2 + 4.2, y + 17.8)))
    o.append(cable([(gx + gw, gy + gh * 0.7), (px + paw * 0.7, gy + gh * 0.7), (px + paw * 0.7, py)], "#2b2f36",
                   L("RF + PTT", "RF + PTT"), at=(px + paw * 0.7, gy + gh * 0.7 + 4.6)))
    o.append(cable([(px + paw, py + pah * 0.5), (x + w - 3.5, py + pah * 0.5), (x + w - 3.5, y + 30.0)], "#2b2f36"))
    o.append(cable([(px, py + pah * 0.55), (x + 3.0 + lw * 0.42, py + pah * 0.55), (x + 3.0 + lw * 0.42, y + 9.0 + lh)],
                   ACCENT["violet"], L("USB · PA daemon → TrxNet", "USB · démon PA → TrxNet"),
                   at=(x + 26.0, py + pah * 0.55)))
    o += [lp, rt, rig, pa]
    o.append(caption(x + 3.0 + lw / 2 - 2.4, y + 9.0 + lh + 2.6, L("PC · Windows / Linux", "PC · Windows / Linux")))
    return "".join(o), py + pah + 1.6 - y


def diag_setup_field(x, y, w):
    o = []
    tb, tbw, tbh = dev_tablet(x + 1.0, y + 7.0, 0.9)
    pix, piy = x + w / 2 - 8.0, y + 8.0
    pi, piw, pih = dev_rpi(pix, piy, 0.95)
    o.append(wifi_icon(pix + piw / 2, piy - 1.2, 0.95))
    o.append(chip(pix + piw / 2, piy - 6.6, "AP  192.168.4.1", ACCENT["amber"]))
    o.append(wlink(x + 1.0 + tbw + 0.8, y + 7.0 + tbh * 0.45, pix - 0.8, piy + pih * 0.45, "Wi-Fi",
                   lx=(x + 1.0 + tbw + pix) / 2, ly=y + 7.0 + tbh * 0.45 - 3.0))
    # TS-480 body at the bottom right, its absent front panel beside it
    tx_, ty_ = x + w - 29.0, y + 40.0
    ts, tsw, tsh = dev_ts480(tx_, ty_, 1.0)
    gh, ghw, ghh = dev_panel_ghost(tx_ - 26.5, ty_ + 0.5, 0.88)
    o.append(gh)
    o.append(t(tx_ - 26.5 + ghw / 2, ty_ + 0.5 + ghh + 2.6, L("front panel — not needed", "čelní panel — netřeba"), 1.45,
               ACCENT["red"], "bold", "middle"))
    o.append(antenna(tx_ + tsw - 3.0, ty_, 8.0))
    # cables: out of the Pi's USB ports on the right, down onto the radio
    lanes = [(L("CAT · hamlib", "CAT · hamlib"), ACCENT["blue"]),
             (L("audio · USB card", "audio · USB karta"), ACCENT["violet"]),
             (L("key / PTT", "klíč / PTT"), ACCENT["red"]),
             (L("panel · RJ12 5 V TTL", "panel · RJ12 5 V TTL"), ACCENT["teal"])]
    for i, (lab, col) in enumerate(lanes):
        sy = piy + 2.4 + i * 2.6
        xx = pix + piw + 2.2 + i * 2.5
        o.append(cable([(pix + piw - 0.4, sy), (xx, sy), (xx, ty_)], col, sw=0.42))
    # legend
    ly = y + 35.0
    for i, (lab, col) in enumerate(lanes):
        o.append(box(x + 1.0, ly + i * 3.1 - 0.9, 3.0, 0.9, col, rx=0.2))
        o.append(t(x + 5.0, ly + i * 3.1, lab, 1.55, col, "bold"))
    o += [tb, pi, ts]
    o.append(caption(x + 1.0 + tbw / 2, y + 7.0 + tbh + 2.6, L("tablet · browser", "tablet · prohlížeč")))
    o.append(caption(pix + piw / 2 - 1.0, piy + pih + 2.6, "WIFILT + local-trx", 1.5))
    o.append(caption(tx_ + tsw / 2, ty_ + tsh + 2.6, L("TS-480 body", "TS-480 bez panelu")))
    return "".join(o), ty_ + tsh + 3.6 - y


def diag_setup_home(x, y, w):
    o = []
    rt, rw_, rh_ = dev_router(x + 1.0, y + 7.0, 0.8)
    ph, pw_, phh = dev_phone(x + 1.5, y + 17.5, 0.55)
    lp, lw, lh = dev_laptop(x + 10.0, y + 18.5, 0.4)
    o.append(wlink(x + 4.5, y + 17.5, x + 5.0, y + 7.0 + rh_))
    o.append(wlink(x + 16.0, y + 18.5, x + 11.0, y + 7.0 + rh_))
    ex, ey = x + 29.0, y + 5.5
    esp, ew, eh = dev_esp32(ex, ey, 1.0)
    o.append(cable([(x + 1.0 + rw_, y + 7.0 + rh_ / 2), (ex, y + 7.0 + rh_ / 2)], "#6b7684"))
    o.append(t((x + 1.0 + rw_ + ex) / 2, y + 7.0 + rh_ / 2 - 0.7, "LAN", 1.35, MUTED, "bold", "middle"))
    gx, gy = x + w - 30.0, y + 3.0
    rig, gw, gh = dev_rig(gx, gy, 0.75, "IC-7610 / 9700")
    o.append(cable([(ex + ew, ey + eh / 2), (gx, ey + eh / 2)], ACCENT["blue"]))
    o.append(t((ex + ew + gx) / 2, ey + eh / 2 - 0.7, "LAN", 1.35, ACCENT["blue"], "bold", "middle"))
    o.append(dev_box(ex - 1.5, y + 21.5, 15.5, 6.8, "BD", L("antenna switch", "přepínač antén"), "#5b6573"))
    o.append(dev_box(ex + 15.0, y + 21.5, 15.5, 6.8, "PA", L("isolated CI-V", "oddělené CI-V"), "#5b6573"))
    o.append(cable([(ex + 6.25, ey + eh), (ex + 6.25, y + 21.5)], ACCENT["teal"]))
    o.append(cable([(ex + ew - 3.0, ey + eh), (ex + ew - 3.0, y + 19.0), (ex + 22.75, y + 19.0), (ex + 22.75, y + 21.5)],
                   ACCENT["teal"]))
    o += [rt, ph, lp, esp, rig]
    return "".join(o), 29.5


def diag_setup_anyrig(x, y, w):
    o = []
    lp, lw, lh = dev_laptop(x + 3.0, y + 4.0, 0.62, label="local-trx")
    gx, gy = x + w - 34.0, y + 6.0
    o.append(box(gx, gy, 32.0, 13.0, "#2b2f36", rx=1.4))
    o.append(box(gx + 2.0, gy + 2.0, 15.0, 5.2, "#c8d86a", rx=0.4))
    o.append(t(gx + 9.5, gy + 5.6, "14.025.00", 2.0, "#26310a", "bold", "middle", mono=True))
    o.append(f'<circle cx="{gx + 25.0:.2f}" cy="{gy + 6.5:.2f}" r="3.8" fill="#1a1d22" stroke="#555c66" '
             f'stroke-width="0.3"/>')
    o.append(t(gx + 16.0, gy + 11.3, "Yaesu · Kenwood · …", 1.5, "#c6ced8", "bold", "middle"))
    sc, scw, sch = dev_soundcard(x + 30.0, y + 21.0, 0.9)
    lanes = [("CAT · USB", ACCENT["blue"], 9.5), (L("audio", "audio"), ACCENT["violet"], 12.0),
             ("DTR / RTS", ACCENT["red"], 14.5)]
    for lab, col, yy in lanes:
        o.append(cable([(x + 3.0 + lw - 2.0, y + yy), (gx, y + yy)], col, sw=0.42))
        o.append(t((x + 3.0 + lw + gx) / 2, y + yy - 0.5, lab, 1.3, col, "bold", "middle"))
    o += [lp]
    o.append(sc)
    o.append(t(x + 30.0 + scw + 1.0, y + 23.6, L("USB sound card", "USB zvuková karta"), 1.4, MUTED))
    return "".join(o), 25.5


def diag_setup_multi(x, y, w):
    o = []
    cx = x + w / 2
    esp, ew, eh = dev_esp32(cx - 8.5, y + 2.0, 1.0)
    o += [esp]
    slots = [("TRX1", "ICOM-LAN", ACCENT["blue"]), ("TRX2", "CI-V", ACCENT["green"]),
             ("TRX3", "TrxNet", ACCENT["violet"])]
    colw = (w - 4.0) / 3
    for i, (name, tr, col) in enumerate(slots):
        bx = x + 2.0 + i * colw
        bw = colw - 2.0
        o.append(box(bx, y + 18.0, bw, 6.4, col, rx=1.0))
        o.append(t(bx + bw / 2, y + 20.9, name, 1.9, "#fff", "bold", "middle"))
        o.append(t(bx + bw / 2, y + 23.4, tr, 1.45, "#eef1f5", anchor="middle"))
        o.append(cable([(cx, y + 2.0 + eh), (cx, y + 15.0), (bx + bw / 2, y + 15.0), (bx + bw / 2, y + 18.0)], col,
                       sw=0.42))
        o.append(cable([(bx + bw / 2, y + 24.4), (bx + bw / 2, y + 27.0)], col, sw=0.42))
    # what hangs on each slot
    d1, d1w, _ = dev_ic705(x + 2.0 + (colw - 2.0) / 2 - 10.8, y + 27.0, 0.9, "IC-705")
    d2, d2w, _ = dev_rig(x + 2.0 + colw + (colw - 2.0) / 2 - 13.6, y + 27.0, 0.68, "IC-7300")
    d3, d3w, _ = dev_oi3(x + 2.0 + 2 * colw + (colw - 2.0) / 2 - 7.5, y + 27.0, 1.0)
    o += [d1, d2, d3]
    o.append(t(x + 2.0 + 2 * colw + (colw - 2.0) / 2, y + 39.0, L("OI3 keyer", "klíčovač OI3"), 1.45, MUTED,
               anchor="middle"))
    o.append(t(cx + 9.8, y + 7.0, "Alt+1 · Alt+2 · Alt+3", 1.55, INK, "bold"))
    return "".join(o), 40.5


def sheet_setups():
    col1 = [
        Card(L("Portable: phone hotspot + ESP32 + IC-705", "Přenosně: hotspot z telefonu + ESP32 + IC-705"), "amber", [
            DIAG(diag_setup_phone),
            B(L("The phone is the Wi-Fi **and** the screen: QRPlog, JS8, WSPR in its browser",
                "Telefon je Wi-Fi **i** obrazovka: QRPlog, JS8, WSPR v jeho prohlížeči")),
            B(L("IC-705: WLAN **Station** on the hotspot, **Network Control** ON, user + password",
                "IC-705: WLAN **Station** na hotspot, **Network Control** ON, uživatel + heslo")),
            B(L("The box keeps **two networks** — home and the phone — and joins whichever is on the air",
                "Krabička si pamatuje **dvě sítě** — domácí a telefon — a připojí tu, která je v dosahu")),
            B(L("Mobile data carries the DX cluster and GIT LOG SYNC", "Mobilní data nesou DX cluster a GIT LOG SYNC")),
            NOTE(L("The hotspot must let its clients reach each other. Some Android hotspots isolate them — then the "
                   "radio link and audio fail (SOFTWARE.md § 5.19); a pocket travel router solves it.",
                   "Hotspot musí propouštět provoz mezi klienty. Některé hotspoty Androidu je izolují — pak nejde "
                   "spojení s rádiem ani audio (SOFTWARE.md § 5.19); pomůže kapesní cestovní router.")),
        ]),
        Card(L("Home station 24/7: the ESP32 box", "Domácí stanice 24/7: krabička ESP32"), "slate", [
            DIAG(diag_setup_home),
            B(L("Runs unattended: JS8 heartbeats, mail and relays, the WSPR beacon",
                "Běží bez obsluhy: JS8 heartbeaty, pošta a relay, WSPR maják")),
            B(L("RemoteQTH board: band decoder (`/bd`, rev 04+), isolated CI-V for a PA, POWER-OUT 13.8 V",
                "Deska RemoteQTH: dekodér pásem (`/bd`, rev 04+), oddělené CI-V pro PA, POWER-OUT 13,8 V")),
            B(L("Any browser in the house; each keeps its log — GIT LOG SYNC joins them",
                "Jakýkoli prohlížeč v domě; každý má svůj deník — GIT LOG SYNC je spojí")),
        ]),
    ]
    col2 = [
        Card(L("Shack PC: Windows / Linux + ICOM + EXPERT 1K-FA", "PC: Windows / Linux + ICOM + EXPERT 1K-FA"),
             "blue", [
            DIAG(diag_setup_pc),
            B(L("WIFILT for Windows or Linux from the web installer — no ESP32 needed; updates from the web",
                "WIFILT pro Windows nebo Linux z webového instalátoru — ESP32 netřeba; aktualizace z webu")),
            B(L("Radio over ICOM-LAN: IC-705 on Wi-Fi, IC-7610 · 9700 · 7300MK2 · 7760 on a cable; SETUP → **FIND "
                "RADIO** → **VERIFY**",
                "Rádio přes ICOM-LAN: IC-705 po Wi-Fi, IC-7610 · 9700 · 7300MK2 · 7760 kabelem; SETUP → **FIND "
                "RADIO** → **VERIFY**")),
            B(L("1K-FA on its TrxNet daemon; SETUP → TrxNet → **Linear amplifier NET_ID** → **PA** palette: FW · SWR · "
                "REV, temperature, tuning segments, ON / OPERATE / TUNE",
                "1K-FA přes svého démona na TrxNetu; SETUP → TrxNet → **Linear amplifier NET_ID** → paletka **PA**: "
                "FW · SWR · REV, teplota, segmenty ladění, ON / OPERATE / TUNE")),
            B(L("The amplifier follows the radio's frequency over TrxNet", "Zesilovač sleduje kmitočet rádia přes TrxNet")),
            B(L("Runs while the PC runs", "Běží, dokud běží PC")),
        ]),
        Card(L("Any radio on a PC: local-trx", "Jakékoli rádio na PC: local-trx"), "violet", [
            DIAG(diag_setup_anyrig),
            B(L("local-trx makes a hamlib radio look like a networked ICOM: CAT, a sound card, DTR / RTS keying",
                "local-trx udělá z rádia v hamlibu síťový ICOM: CAT, zvuková karta, klíčování DTR / RTS")),
            B(L("ICOM-only extras (LAN MOD calibration, GPS, the radio's waterfall) switch off",
                "Funkce jen pro ICOM (kalibrace LAN MOD, GPS, vodopád rádia) se vypnou")),
        ]),
    ]
    col3 = [
        Card(L("Field: tablet + Raspberry Pi AP + TS-480", "Pole: tablet + Raspberry Pi jako AP + TS-480"), "green", [
            DIAG(diag_setup_field),
            B(L("No known Wi-Fi in range → the Pi opens its own AP `WIFILT-setup-XXXX`; the tablet joins and opens "
                "`http://192.168.4.1/`",
                "Žádná známá Wi-Fi → Pi otevře vlastní AP `WIFILT-setup-XXXX`; tablet se připojí a otevře "
                "`http://192.168.4.1/`")),
            B(L("local-trx: hamlib **Kenwood TS-480**, USB sound card, DTR / RTS keying",
                "local-trx: hamlib **Kenwood TS-480**, USB zvuková karta, klíčování DTR / RTS")),
            B(L("**Software panel** on the RJ12 panel cable — the real one unplugged: display, keys, knobs and power in the "
                "browser, **TS480** palette in QRPlog",
                "**Softwarový panel** na kabelu panelu RJ12 — skutečný odpojený: displej, tlačítka, knoby i zapínání "
                "v prohlížeči, paletka **TS480** v QRPlogu")),
            B(L("No internet: no cluster, no git — the log waits in the tablet; fslock lets you pull the plug",
                "Bez internetu: bez clusteru a gitu — deník počká v tabletu; s fslock lze vytáhnout napájení")),
        ]),
        Card(L("Several radios at once", "Více rádií najednou"), "teal", [
            DIAG(diag_setup_multi),
            B(L("Three slots, **only one on ICOM-LAN**; [[Alt]]+[[1]][[2]][[3]] or left / middle / right click on "
                "a DX spot", "Tři sloty, **jen jeden přes ICOM-LAN**; [[Alt]]+[[1]][[2]][[3]] nebo levý / prostřední "
                "/ pravý klik na DX spot")),
            B(L("TrxNet adds an OI3 keyer, the PA and the band decoder", "TrxNet přidá klíčovač OI3, PA a dekodér pásem")),
        ]),
    ]
    return {
        "name": "setups",
        "title": L("WIFILT — ways to set it up", "WIFILT — možnosti zapojení"),
        "subtitle": L("one web interface in three forms: ESP32 box · Windows / Linux PC · Raspberry Pi",
                      "jedno webové rozhraní ve třech podobách: krabička ESP32 · PC s Windows / Linuxem · Raspberry Pi"),
        "ref": "SOFTWARE.md § 1.5–1.7, 3.14, 3.14b · HARDWARE.md",
        "size": 2.45,
        "weights": [1.0, 1.0, 1.0],
        "columns": [col1, col2, col3],
    }


SHEETS = [sheet_qrplog, sheet_js8, sheet_rpi, sheet_setups]


def main():
    global LANG
    ap = argparse.ArgumentParser()
    ap.add_argument("--svg-only", action="store_true")
    ap.add_argument("--png", metavar="DIR")
    ap.add_argument("--only", help="sheet name (qrplog, js8call, rpi-station, setups)")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    inkscape = shutil.which("inkscape")
    failed = False
    for make in SHEETS:
        for lang in ("en", "cs"):
            LANG = lang
            sheet = make()
            if args.only and sheet["name"] != args.only:
                continue
            svg, problems = render_sheet(sheet)
            base = os.path.join(OUT, f'{sheet["name"]}-{lang}')
            free = ", ".join(f"{f:.1f}" for f in sheet["_free"])
            if problems:
                failed = True
                print(f"FAIL {base}.svg: " + "; ".join(problems))
            with open(base + ".svg", "w", encoding="utf-8") as fh:
                fh.write(svg)
            print(f"wrote {os.path.relpath(base, ROOT)}.svg  (free mm per column: {free})")
            if not args.svg_only:
                if not inkscape:
                    sys.exit("inkscape not found (use --svg-only)")
                subprocess.run([inkscape, base + ".svg", "--export-type=pdf", f"--export-filename={base}.pdf"],
                               check=True, stderr=subprocess.DEVNULL)
            if args.png and inkscape:
                os.makedirs(args.png, exist_ok=True)
                subprocess.run([inkscape, base + ".svg", "--export-type=png", "--export-dpi=150",
                                f"--export-filename={os.path.join(args.png, os.path.basename(base))}.png"],
                               check=True, stderr=subprocess.DEVNULL)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
