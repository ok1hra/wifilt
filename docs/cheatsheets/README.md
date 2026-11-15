# WIFILT cheat sheets · taháky

One A4 landscape page each, to print or keep open beside the radio. Every sheet comes in
English and Czech, as SVG and as PDF.

Jedna strana A4 na šířku — k vytištění nebo k ruce u rádia. Každý tahák je anglicky
i česky, jako SVG i PDF.

| Sheet · Tahák | English | Česky | Manual · Manuál |
|---|---|---|---|
| **QRPlog** — contest log, keyboard, palettes, sync · závodní deník, klávesnice, paletky, synchronizace | [PDF](qrplog-en.pdf) · [SVG](qrplog-en.svg) | [PDF](qrplog-cs.pdf) · [SVG](qrplog-cs.svg) | [SOFTWARE.md § 3](../../SOFTWARE.md#3-qrplog) |
| **JS8Call-ICOM** — radio settings, waterfall, messages, relays, unattended · nastavení rádia, vodopád, zprávy, prostředníci, provoz bez obsluhy | [PDF](js8call-en.pdf) · [SVG](js8call-en.svg) | [PDF](js8call-cs.pdf) · [SVG](js8call-cs.svg) | [SOFTWARE.md § 5](../../SOFTWARE.md#5-data--js8call-over-icom-lan) |
| **Ways to set it up** — phone hotspot + ESP32 + IC-705, Windows / Linux PC + ICOM + EXPERT 1K-FA, tablet + Raspberry Pi AP + TS-480 without its panel, home 24/7 box, any radio through local-trx, several radios · **Možnosti zapojení** — hotspot z telefonu + ESP32 + IC-705, PC s Windows / Linuxem + ICOM + EXPERT 1K-FA, tablet + Raspberry Pi jako AP + TS-480 bez panelu, domácí krabička 24/7, jakékoli rádio přes local-trx, více rádií | [PDF](setups-en.pdf) · [SVG](setups-en.svg) | [PDF](setups-cs.pdf) · [SVG](setups-cs.svg) | [SOFTWARE.md § 1.5](../../SOFTWARE.md#15-where-it-runs) |
| **WIFILT + local-trx on a Raspberry Pi** — install, Wi-Fi and the setup access point, local-trx, fslock, updates · instalace, Wi-Fi a nastavovací AP, local-trx, fslock, aktualizace | [PDF](rpi-station-en.pdf) · [SVG](rpi-station-en.svg) | [PDF](rpi-station-cs.pdf) · [SVG](rpi-station-cs.svg) | [SOFTWARE.md § 1.6–1.8](../../SOFTWARE.md#17-a-raspberry-pi-station) |

## Regenerating · Jak je přegenerovat

The sheets are generated, not drawn: the content of both languages, the layout and the
diagrams are in [tools/build-cheatsheets.py](../../tools/build-cheatsheets.py). Change the
text there and run

Taháky se generují, nekreslí se ručně: obsah obou jazyků, sazba i diagramy jsou
v [tools/build-cheatsheets.py](../../tools/build-cheatsheets.py). Text se mění tam a pak:

```sh
python3 tools/build-cheatsheets.py              # SVG + PDF, all eight
python3 tools/build-cheatsheets.py --png /tmp/p # + PNG previews
python3 tools/build-cheatsheets.py --only js8call --svg-only
```

It needs Python 3 with Pillow, the DejaVu fonts (`fonts-dejavu-core`) and, for the PDF,
Inkscape. Every word is measured and wrapped by the script, and it refuses to write a sheet
whose text runs out of its card or off the page.

Potřebuje Python 3 s Pillow, fonty DejaVu (`fonts-dejavu-core`) a pro PDF Inkscape. Každé
slovo změří a zalomí skript sám a odmítne zapsat tahák, jehož text přetéká z karty nebo
ze stránky.
