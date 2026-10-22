# leengari.github.io

Personal portfolio for Lee Ngari, built as a static one-pager with a live
relational database running in the browser.

The signature piece is **JoyDB Live**: the real [JoyDB](https://github.com/LeeNgari/JoyDb)
engine — written in Go — is compiled to WebAssembly, seeded with the portfolio's
data at boot, and exposed through a read-write SQL console. No server, no API.
Visitors can browse tables, run queries, add themselves to a `visitors` table,
and reset the database. Joy, a small database mascot, reacts to what happens.

## Structure

```
index.html            the portfolio
cv.html               print-friendly CV (source for the PDF)
404.html              not-found page
assets/
  styles.css          the whole design system
  app.js              console boot + query/write UI + mascot
  favicon.svg
  og.png              1200×630 social card
  Lee-Ngari-CV.pdf    generated from cv.html
  fonts/              self-hosted woff2 files
data/content.json     canonical content used by the WASM seed and the fallback
                      (including the first visitors row)
wasm/
  joydb.wasm          compiled engine (committed)
  wasm_exec.js        Go runtime (must match the Go version used to build)
  src/                Go entry point that seeds the DB and exposes
                      query(), exec(), addVisitor(), and reset()
scripts/
  serve.mjs           local static server with the correct WASM MIME type
  build-wasm.ps1      rebuild joydb.wasm (needs a sibling JoyDb checkout)
  test-wasm.js        headless Node smoke test for the engine
  e2e.mjs             browser interaction checks (Edge + local server)
  e2e-fallback.mjs    checks the no-WASM fallback
  check-links.py      local link, anchor, and asset audit
  shoot.mjs           full-page screenshots for visual QA
```

## Local development

```sh
node scripts/serve.mjs
# http://127.0.0.1:4173/
```

Open the console with `http://127.0.0.1:4173/#joydb` to boot it immediately.
Otherwise it boots when the section approaches the viewport.

Engine smoke test (no browser needed):

```sh
node scripts/test-wasm.js
```

Browser and link checks (with the server running):

```sh
node scripts/e2e.mjs
node scripts/e2e-fallback.mjs
python scripts/check-links.py
```

## Rebuilding the WASM engine

`wasm/joydb.wasm` is a build artifact and is committed so the site works without
a Go toolchain. To rebuild it:

1. Clone JoyDB next to this repo:

   ```
   C:\Users\leeng\source\repos\JoyDb
   C:\Users\leeng\source\repos\LeeNgari.github.io
   ```

2. Run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\build-wasm.ps1
   ```

The script copies `data/content.json` into the Go module, builds with
`GOOS=js GOARCH=wasm`, and refreshes `wasm/wasm_exec.js` from the installed Go
toolchain. `wasm_exec.js` must come from the same Go version as the build.

The Go bridge lives in `wasm/src/main.go`. It creates an in-memory store with
`joydb.Open(":memory:")`, creates five tables, seeds them from the embedded JSON,
and exposes four JSON endpoints on `window.JoyDB`:

| Method | Purpose |
|---|---|
| `query(sql)` | `SELECT` only; returns columns and rows |
| `exec(sql)` | `INSERT`, `UPDATE`, `DELETE`; returns the affected row count |
| `addVisitor(name, note)` | Parameterized insert into `visitors` with the next id |
| `reset()` | Drops and reseeds the portfolio database |

DDL (`CREATE`, `DROP`, `ALTER`) is intentionally blocked in the UI so a visitor
cannot dismantle the demo. Writes live in the page's memory and are never
persisted; `reset()` restores the seed.

## Editing content

- **Narrative / layout:** `index.html`
- **Console data and schema:** `data/content.json` (including the seeded
  `visitors` row; also update the DDL in `wasm/src/main.go` if the schema
  changes), then rebuild the WASM.
- **Experience copy:** `index.html` and `cv.html`
- **Social card:** `scripts/og.html`, then re-render `assets/og.png`.
- **CV PDF:** edit `cv.html`, then re-render the PDF.

Re-render commands (headless Microsoft Edge on Windows):

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless --disable-gpu --no-pdf-header-footer --virtual-time-budget=5000 `
  --user-data-dir="$env:TEMP\edge-pdf" `
  --print-to-pdf="$PWD\assets\Lee-Ngari-CV.pdf" `
  "file:///$($PWD.Path -replace '\\','/')/cv.html"

& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless --disable-gpu --hide-scrollbars --window-size=1200,630 `
  --virtual-time-budget=4000 --user-data-dir="$env:TEMP\edge-og" `
  --screenshot="$PWD\assets\og.png" `
  "file:///$($PWD.Path -replace '\\','/')/scripts/og.html"
```

## Deploying (not done yet)

The plan is a **user site** at the domain root:

1. Create a public repo named `LeeNgari.github.io`.
2. Push this directory to `main`.
3. In Settings → Pages, deploy from `main` / root.
4. The site goes live at `https://leengari.github.io/`.
5. Point the old `portfolio` repo at the new root, or delete it.

The repo must be public because GitHub Pages on the free plan does not publish
private repositories. `.nojekyll` is present so the static files are served
as-is.

## Fonts and licenses

Space Grotesk, Instrument Serif, and IBM Plex Mono are self-hosted Latin subsets
under the SIL Open Font License 1.1. See `assets/fonts/README.md` and the
`assets/fonts/OFL-*.txt` files.

## Notes

- The console is read-write within the session. It runs against a fresh in-memory
  copy seeded at boot; writes and visitor rows are never persisted. DDL is
  blocked, and `reset` restores the seed.
- If WebAssembly fails to load, the console falls back to static example results
  and says so. The rest of the page is fully readable without JavaScript.
- Motion is minimal and respects `prefers-reduced-motion`.
