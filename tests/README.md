# SwiftPDF regression suite

Browser tests for the site as it behaves for a person using it: pick a file,
drag it about, press the button, get a file back. Nothing here is mocked — the
pages are served over `http://` from this repository and driven in Chromium.

```bash
node tests/run.mjs                     # everything
node tests/run.mjs --filter merge      # only tests whose file or name matches
node tests/run.mjs --headed            # watch it happen
node tests/run.mjs --list              # names only
```

Exit code is 0 when nothing failed, 1 otherwise, so it drops into CI as-is.

## Nothing was installed

The site has no build step and no dependencies, and the suite keeps it that way.

- The runner, the static file server and the assertions use Node built-ins only
  (`node:http`, `node:fs`, `node:assert`). There is no test framework and no
  `node_modules` in this repository.
- Playwright is found on the machine at run time — first `SWIFTPDF_PLAYWRIGHT`
  (a directory containing the `playwright` package), then the npm npx cache,
  then a normal `import("playwright")`. See `lib/playwright.mjs`. If Playwright
  is not installed anywhere, the runner says so and stops.
- Test PDFs and images are generated in memory by `lib/fixtures.mjs`, so there
  are no binary fixtures in the repository and no sample files to keep in sync.
- Tests that need a PDF library fetch it from the same CDN the site uses. One
  test deliberately blocks the CDN to check the failure message.

## Layout

| file | what it holds |
| --- | --- |
| `run.mjs` | the runner: serves the repo, opens a fresh page per test, reports |
| `lib/server.mjs` | static file server on an ephemeral port |
| `lib/browser.mjs` | page setup, real touch input over CDP, small page helpers |
| `lib/harness.mjs` | the `test()` registry and re-exports `assert` |
| `lib/fixtures.mjs` | PDFs and a PNG, written byte by byte in memory |
| `lib/playwright.mjs` | finds an existing Playwright install |
| `fixtures/blank.html` | a bare page carrying the element ids `pdf-core.js` looks for |
| `specs/*.spec.mjs` | the tests |

`specs/core.spec.mjs` and `specs/busy.spec.mjs` run against `fixtures/blank.html`
so they can build whatever DOM a helper needs and assert exactly what it did to
it. Everything else runs against a real page of the site.

## Dragging

Reordering is the easiest thing to get quietly wrong, so no drag is simulated
with a synthetic `DragEvent`. Touch gestures go through
`Input.dispatchTouchEvent` over CDP — Playwright's `touchscreen` only taps — and
mouse gestures go through Playwright's own mouse so the page sees a real
`pointerType: "mouse"`. `lib/browser.mjs` has `touchDrag`, `touchHoldAt`,
`mouseDrag` and `chipGrabPoint` for this.

## What each spec covers

| spec | area |
| --- | --- |
| `smoke` | every page loads with no uncaught error; nothing is fetched from an origin that is not the site, the CDN or the font host; no request carries a body |
| `core` | `formatSize`, `setStatus` live-region roles, `explainProcessingError`, `dataUrlBytes`, and `buildPdf` — including that every xref offset points at the object it claims, and that the result opens in pdf-lib |
| `busy` | `setToolBusy` locking, re-entrancy and exact restore; the result bar's name, extension, focus, announcements and blob cleanup |
| `file-strip` | picking, refusing and skipping files; touch drag reorder; the sub-threshold wobble; drags that start on a button; edge auto-scroll; a re-render during a drag; the chip menu; stale results; Clear all; the dropzone |
| `workspace` | the Edit-files grid: numbering, touch and mouse reorder, the swallowed click after a mouse drop, the single-wiring guard, vertical auto-scroll, live updates, Escape and backdrop close, and the image variant's crop/rotate/delete |
| `merge` | merging for real: page order read back out of the finished file, reordering before merging, a damaged file, a Word file, compression, and that a merge never sends anything off the device |
| `edit-pdf` | opening a PDF, page navigation by button, chip and keyboard, zoom, selecting and previewing a line, Apply, the confirm card, save, undo, discard, a scan with no text layer, and a file that will not open |
| `other-tools` | Image to PDF, Compress, Add page numbers, PDF to image, and the shared "a bad file is explained and nothing stays locked" contract across five tools |
| `seo-head` | the `<head>` tripwire: byte-identical to the last commit, and the expected set of search tags exactly once each; the sitemap agrees with the pages on disk |

## Known bugs

Three tests record a real defect instead of passing or failing the build. They
are marked with `knownBug` and are reported separately at the end of a run, and
each one says when the fix lands (the test then goes green and says the marker
can be dropped).

1. **`setToolBusy` never releases a control that appears mid-flight**
   (`pdf-core.js`, the busy block). The previous state is snapshotted only on the
   0 → 1 edge, so a control created while a second operation is already in
   flight is disabled by that second call and never handed back. No page does
   this today. `specs/busy.spec.mjs`.

2. **A merge failure names the wrong file** (`merge.js` line 108).
   `explainProcessingError(err, "Merging these PDFs", items[0].file.name)` always
   reports the first file, so a damaged second file produces "could not read
   “good.pdf”". The tool's own wording ("…or use an unsupported PDF feature")
   also collides with the generic `unsupported` rule inside
   `explainProcessingError`, which is what rewrites the message. Two small
   changes would fix it: pass the file that actually failed, and make the
   generic rule not shadow a message the tool wrote itself.
   `specs/merge.spec.mjs`.

3. **An undone edit is still announced as edited** (`edit-pdf.js`,
   `positionBoxes`). The `is-edited` marker is removed correctly, but the box's
   `aria-label` is only rewritten when an edit exists and never restored, so a
   screen reader keeps hearing "Edited to: …" for a line that is back to its
   original wording. `specs/edit-pdf.spec.mjs`.

## Found, not fixed, and not tested

- The chip strip's remove button (`.chip-x`) is `display: none` until the chip
  is hovered, so it is mouse-only. The chip menu carries a Remove item, so
  nothing is unreachable by touch, and the suite uses the menu for that reason.
- `applyEdit` in `edit-pdf.js` refreshes the canvas and the boxes but not the
  selection line, so the "· edited" marker next to the selection only appears
  after re-selecting the line. The status line does report the applied edit, and
  the tests assert on that instead.
- The site's web fonts are fetched from `fonts.googleapis.com` /
  `fonts.gstatic.com`. That is a third party, but it is a static asset host and
  the request carries no file, so the privacy test allows those two hosts and
  still fails on anything else — or on any request with a body.

## Writing a new test

```js
import { test, assert, step } from "../lib/harness.mjs";
import { makeNamedPdfFile } from "../lib/fixtures.mjs";
import { addFiles, waitForThumbnails } from "../lib/browser.mjs";

test("what it checks", async (t) => {
  await step("the part that is easy to get wrong", async () => {
    // t.page, t.cdp, t.pageErrors, t.foreignRequests(), t.url("/page.html")
  });
}, { path: "/merge-pdf.html" });
```

Options on a test: `path` (page to open first), `blockCdn`, `pageErrors: false`
(when the page is expected to log an error), `knownBug`. Each test gets a fresh
browser context, so nothing leaks between them.
