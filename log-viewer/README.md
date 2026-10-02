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
- To read a file other than `QSO-database.json`, add `?file=name.json` to the address.

The full guide is in [SOFTWARE.md → GIT LOG SYNC](../SOFTWARE.md#git-log-sync).

## For developers

`index.html` is **generated**. Edit `src/` (`viewer.html`, `viewer.css`, `viewer.js`) and
rebuild:

```
node tools/build-log-viewer.js           # writes log-viewer/index.html
node tools/build-log-viewer.js --check   # fails if index.html is out of date
node tools/log-viewer-smoke.js           # headless Chrome over the 16k-QSO history
```

The build inlines `data/dxcc.js` (countries) and `data/log-export.js` (the ADIF/CSV
mapping shared with QRPLog). Any change to either needs a rebuild of the viewer.
