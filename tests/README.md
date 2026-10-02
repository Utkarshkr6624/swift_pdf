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

`specs/core.spec.mjs`, `specs/busy.spec.mjs`, `specs/office.spec.mjs` and
`specs/office-maths.spec.mjs` run against `fixtures/blank.html` so they can
build whatever DOM a helper needs and assert exactly what it did to it. The two
Office specs use it because `office-to-pdf.js` is deliberately not on any public
page — it is only ever fetched when an Office file is actually opened — so the
engine is loaded onto a bare page by hand. Everything else runs against a real
page of the site.

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
| `smoke` | every page loads with no uncaught error; nothing is fetched from an origin that is not the site or one of the CDN library hosts; no request carries a body |
| `core` | `formatSize`, `setStatus` live-region roles, `explainProcessingError`, `dataUrlBytes`, and `buildPdf` — including that every xref offset points at the object it claims, and that the result opens in pdf-lib |
| `busy` | `setToolBusy` locking, re-entrancy and exact restore; the result bar's name, extension, focus, announcements and blob cleanup |
| `file-strip` | picking, refusing and skipping files; touch drag reorder; the sub-threshold wobble; drags that start on a button; edge auto-scroll; a re-render during a drag; the chip menu; stale results; Clear all; the dropzone |
| `workspace` | the Edit-files grid: numbering, touch and mouse reorder, the swallowed click after a mouse drop, the single-wiring guard, vertical auto-scroll, live updates, Escape and backdrop close, and the image variant's crop/rotate/delete |
| `merge` | merging for real: page order read back out of the finished file, reordering before merging, a damaged file, a Word file, compression, and that a merge never sends anything off the device |
| `edit-pdf` | opening a PDF, page navigation by button, chip and keyboard, zoom, selecting and previewing a line, Apply, the confirm card, save, undo, discard, a scan with no text layer, and a file that will not open |
| `other-tools` | Image to PDF, Compress, Add page numbers, PDF to image, and the shared "a bad file is explained and nothing stays locked" contract across five tools |
| `office` | the SwiftOffice engine, through its documented API only: Word to paged A4 with its styling, tables and images intact, long words broken rather than run off the page; a deck to one slide-sized page per slide; a sheet to one page per sheet with its header repeated; text the standard PDF fonts cannot hold counted and explained; progress reporting; and a file that is not an Office document, or is a broken package, refused in plain English |
| `convert` | the four-by-four converter on `word-to-pdf.html`: all twelve source/target pairs converted for real and read back, each one saying what it kept and what it lost and never handing over a blank file; the from/to picker found by what it is rather than by id, so the page can be re-skinned; the same conversions on a 390px phone; and with the libraries blocked, the page explaining itself and unlocking |
| `office-maths` | Word equations end to end: an `<m:oMath>` element read out with its structure, the symbols the standard PDF fonts cannot encode drawn as paths instead of "?", those paths sitting on the text baseline rather than below it, and Latin-1 text written as itself |
| `maths-text` | how `word-to-pdf.js` groups the crowd of small runs an equation becomes in a PDF: an expression does not come back with a space between every glyph, a symbol the font reports as a space is not read as a word gap, and a table row still reads as columns |
| `maths-round-trip` | the two halves joined — a `.docx` in and the reader that turns the finished PDF back into a Word document. It measures the loss rather than asserting its absence, because a symbol the converter draws is ink on the page first and text in the layer only second, so the tests hold whichever way the text layer is later allowed to go |
| `seo-head` | the `<head>` tripwire: a complete, unique, honest set of search tags and a canonical that matches the page; that the same tags appear exactly once each; that nothing in the site still points at a Google host and every page takes its fonts from `assets/`; and that the sitemap agrees with the pages on disk |

## Known bugs

No defect is being recorded at the moment. There were three, each written as a
test with a `knownBug` marker so it would report rather than break the build,
and each marker said when the fix lands. All three have landed, so the list is
here as a record of what the markers were holding down:

1. **`setToolBusy` never released a control that appears mid-flight**
   (`pdf-core.js`, the busy block). The previous state was snapshotted only on
   the 0 → 1 edge, so a control created while a second operation was already in
   flight was disabled by that second call and never handed back. The snapshot
   is now taken on every `busy` call, so a late control is locked and released
   like any other. `specs/busy.spec.mjs`.

2. **A merge failure named the wrong file** (`merge.js`).
   `explainProcessingError(err, "Merging these PDFs", items[0].file.name)`
   reported the first file whatever had actually failed, so a damaged second
   file produced "could not read “good.pdf”". The merge now tracks the file it is
   working on and passes that name. The wording is still rewritten by the
   generic `unsupported` rule inside `explainProcessingError` — `merge.js` line
   262 says "…or use an unsupported PDF feature" and that is what trips it — but
   the rewrite keeps the right subject, so the test asserts on the name and not
   on the sentence. `specs/merge.spec.mjs`.

3. **An undone edit was still announced as edited** (`edit-pdf.js`,
   `positionBoxes`). The `is-edited` marker came off correctly, but the box's
   `aria-label` was only rewritten when an edit existed and never restored, so a
   screen reader kept hearing "Edited to: …" for a line that was back at its
   original wording. The label is now rebuilt on every pass.
   `specs/edit-pdf.spec.mjs`.

The `knownBug` markers have been dropped from all three, so each reports as a
plain `ok` now.

## Found, not fixed, and not tested

- The chip strip's remove button (`.chip-x`) is `display: none` until the chip
  is hovered, so it is mouse-only. The chip menu carries a Remove item, so
  nothing is unreachable by touch, and the suite uses the menu for that reason.
- `applyEdit` in `edit-pdf.js` refreshes the canvas and the boxes but not the
  selection line, so the "· edited" marker next to the selection only appears
  after re-selecting the line. The status line does report the applied edit, and
  the tests assert on that instead.

## Where the files go

The privacy test is an allowlist, and the length of it is the point.
`THIRD_PARTY_ASSET_HOSTS` in `lib/browser.mjs` names the three CDN library hosts
and nothing else; every request has to be the site's own origin or one of them,
and no request may carry a body at all.

That list used to have a fourth and fifth entry, `fonts.googleapis.com` and
`fonts.gstatic.com`, back when the web fonts were fetched from Google. They are
self-hosted now, under `assets/fonts/`, so nothing asks for them and the entries
were only left behind out of caution. Caution is the wrong instinct for an
allowlist: an exemption nobody has removed is an exemption nobody has to think
about, and the whole value of the check is that it turns red the day the thing
it was written for comes back. Paste the old Google Fonts `<link>` onto a page
and `smoke` fails on the request; `seo-head` fails too, on the reference itself,
so the link and the load path are both covered from two directions. Do not widen
the list to make a test green — fix the page.

Serving those font files correctly is part of the same story, so `lib/server.mjs`
maps `.woff2` to `font/woff2`. Chromium is forgiving enough to render an
`application/octet-stream` font, but a test server that lies about content types
teaches the suite to expect something production does not send.

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
