# WIFILT log viewer

A read-only web page for the QSO log that **GIT LOG SYNC** (QRPLog, the button at the
bottom right) keeps in a GitHub repository. It is not installed on the interface. It runs
on GitHub Pages, in your log repository.

## Install

1. Run GIT LOG SYNC at least once, so the repository has `QSO-database.json`.
2. Upload [`index.html`](index.html) to the root of the log repository, next to
   `QSO-database.json`. Use *Add file → Upload files*, or download it from a terminal:

   ```
   curl -o index.html https://raw.githubusercontent.com/ok1hra/wifilt/main/log-viewer/index.html
   ```

3. In the log repository, open *Settings → Pages → Build and deployment*. Choose *Deploy
   from a branch*, then `main` and `/ (root)`, and save.
4. The log is at `https://<owner>.github.io/<repository>/` a minute or two later.

The repository must be **public** for Pages to serve it. That makes the whole log public.

To update the viewer, upload a newer `index.html`. The build number is at the bottom of the
page.

## Use

- **A filter under every column**, all of them applied together:
  - `text` finds the text anywhere in the cell, ignoring case.
  - `=text` must match the whole cell, so `=20m` does not find 2m or 12m.
  - The number columns also take `>5000`, `<10` and `14000-14100`.
  - In *Mode*, `=SSB` includes USB and LSB, and `=CW` includes CW-R.
- **The statistics in the header** count only the rows shown. Click a continent, or a
  number in the band × mode table, to filter by it.
- **The address keeps the filters and the sort order**, so a link opens the same view.
- **ADIF** and **CSV** download the rows shown.
- **Drag the edge of a column header** to resize the column; double-click the edge to fit
  it to its values. **▾** in the *Log* filter lists the logs the filter matches, with their
  QSO counts; click one to show only that log.
- **The map** shows the rows shown. The transmitter sites are red dots, one for each log
  locator. A log without a locator sits in the middle of its call's country (`≈`) unless
  you enter a locator in *QTH*. A QSO is placed by the locator it received. Without one, a
  US or Canadian station goes to the state or province in its exchange. Otherwise it goes
  to its DXCC country. Choose *Map* (OpenStreetMap) or *Azimuthal*, *Dots* or *Calls*, and
  turn the lines and the grey line on or off. Click a row of the log to set the grey line
  to that QSO's time. *In view* ADIF/CSV downloads the QSOs whose points are on screen. The map needs the internet (unpkg.com, cdn.jsdelivr.net,
  tile.openstreetmap.org); the rest of the page does not.
- To read a file other than `QSO-database.json`, add `?file=name.json` to the address.

The full guide is in [SOFTWARE.md → GIT LOG SYNC](../SOFTWARE.md#git-log-sync).

## For developers

`index.html` is **generated**. Edit `src/` (`viewer.html`, `viewer.css`, `map-core.js`,
`viewer-map.js`, `viewer.js`) and rebuild:

```
node tools/build-log-viewer.js           # writes log-viewer/index.html
node tools/build-log-viewer.js --check   # fails if index.html is out of date
node tools/log-viewer-smoke.js           # headless Chrome over the 16k-QSO history
node tools/log-viewer-map-core-test.js   # where the map puts QSOs, sites, the sun (node)
```

The map checks in the smoke test need the internet for the CDN libraries. Without it they
print `SKIP` and do not count.

The build inlines `data/dxcc.js` (countries) and `data/log-export.js` (the ADIF/CSV
mapping shared with QRPLog). Any change to either needs a rebuild of the viewer.
