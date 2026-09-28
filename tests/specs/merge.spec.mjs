// Merge PDF, end to end: real files, the real CDN libraries, a real download.
// These are the checks that only pass by actually running the thing.
import { test, assert, step } from "../lib/harness.mjs";
import { makePdfFile, makeNamedPdfFile, makeBrokenPdfFile } from "../lib/fixtures.mjs";
import {
  addFiles,
  waitForThumbnails,
  waitForResultBar,
  waitForStatus,
  readResultText,
  statusText,
  chipNames,
  clickChipRemove,
} from "../lib/browser.mjs";

const MERGE = { path: "/merge-pdf.html" };

const named = (...names) => names.map((name) => makeNamedPdfFile(name, { pages: 1 }));

// Press Merge and wait for the result bar. Only for runs that are meant to
// succeed; a run that fails has to wait on the status line instead.
async function mergeNow(t) {
  await t.page.locator("#convertBtn").click();
  await waitForResultBar(t, 60000);
}

async function startMerge(t) {
  await t.page.locator("#convertBtn").click();
}

// The merged file, read back the way a person would: page count and the text
// on each page. pdf.js takes ownership of the buffer it is handed, so the raw
// bytes are read before it sees them.
async function readMerged(t) {
  return t.page.evaluate(async () => {
    const pdfjs = await loadPdfJs();
    const bar = document.getElementById("resultBar");
    const response = await fetch(bar._resultUrl);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const header = String.fromCharCode(...bytes.slice(0, 5));
    const length = bytes.length;
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const text = [];
    try {
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
        const page = await doc.getPage(pageNo);
        const content = await page.getTextContent();
        text.push(content.items.map((item) => item.str).join(" ").trim());
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    return { bytes: length, numPages: doc.numPages, header, text };
  });
}

test(
  "merging keeps every page, in the order the strip is in",
  async (t) => {
    await addFiles(t, "#fileInput", [
      makeNamedPdfFile("alpha.pdf", { pages: 2 }),
      makeNamedPdfFile("beta.pdf", { pages: 1 }),
    ]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 2);
    await waitForThumbnails(t.page);
    await mergeNow(t);

    await step("the result says what was made", async () => {
      const text = await readResultText(t);
      assert.match(text, /Merged 2 PDFs/);
      assert.match(await statusText(t), /Merged 2 PDFs\./);
    });

    const merged = await readMerged(t);
    assert.equal(merged.header, "%PDF-", "the download is not a PDF");
    assert.equal(merged.numPages, 3, "two pages plus one page should be three pages");
    assert.deepEqual(merged.text, ["alpha page 1", "alpha page 2", "beta page 1"]);

    await step("the page is usable again afterwards", async () => {
      assert.equal(await t.page.locator("#convertBtn").isEnabled(), true);
      assert.equal(await t.page.locator("#toolbar button").evaluateAll((nodes) => nodes.some((n) => n.disabled)), false);
    });
  },
  MERGE
);

test(
  "reordering the strip before merging changes the document that comes out",
  async (t) => {
    await addFiles(t, "#fileInput", named("first.pdf", "second.pdf"));
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 2);
    await waitForThumbnails(t.page);

    await step("move the second file to the front", async () => {
      await t.page.locator('.file-strip .chip .chip-menu-btn[aria-label="More options for second.pdf"]').click();
      await t.page.locator("body > .menu.open button", { hasText: "Move earlier" }).click();
      await t.page.waitForFunction(() => document.querySelectorAll(".chip .chip-name")[0].textContent === "second.pdf");
      assert.deepEqual(await chipNames(t), ["second.pdf", "first.pdf"]);
    });

    await mergeNow(t);
    const merged = await readMerged(t);
    assert.deepEqual(merged.text, ["second page 1", "first page 1"], "the merge ignored the order on screen");
  },
  MERGE
);

test(
  "a file that cannot be read stops the merge with advice, not a stuck page",
  async (t) => {
    await addFiles(t, "#fileInput", [makePdfFile("good.pdf"), makeBrokenPdfFile("broken.pdf")]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 2);
    await waitForThumbnails(t.page);

    await startMerge(t);
    await waitForStatus(t, /error|could not|valid PDF/i, 60000);

    await step("the message is plain English, not a parser error", async () => {
      const message = await statusText(t);
      assert.doesNotMatch(message, /InvalidPDFException|at Object\.|PDFDocument/, "a parser error leaked into the message");
      assert.ok(message.length > 20, "the message is too terse to act on");
    });

    await step("nothing is left locked, so a retry is possible", async () => {
      assert.equal(await t.page.locator("#convertBtn").isEnabled(), true);
      assert.equal(await t.page.locator("#status").getAttribute("aria-live"), "assertive", "a failure should interrupt");
      const disabled = await t.page
        .locator("#toolbar button, #dropzone button")
        .evaluateAll((nodes) => nodes.filter((n) => n.disabled).map((n) => n.id || n.textContent.trim()));
      assert.deepEqual(disabled, [], "controls stayed disabled after a failure");
    });

    await step("a merge that works is still possible afterwards", async () => {
      await clickChipRemove(t, "broken.pdf");
      await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
      await mergeNow(t);
      assert.match(await readResultText(t), /Merged 1 PDF\b/);
    });
  },
  MERGE
);

// A real defect, found while writing this suite: merge.js reports the failure
// against items[0] whatever went wrong, and explainProcessingError matches the
// tool's own "…or use an unsupported PDF feature" wording against its generic
// "unsupported" rule. Together they tell someone to go and fix a file that was
// perfectly fine. Reported to the owner, not fixed here (see tests/README.md).
test(
  "the failure names the file that actually went wrong",
  async (t) => {
    await addFiles(t, "#fileInput", [makePdfFile("good.pdf"), makeBrokenPdfFile("broken.pdf")]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 2);
    await waitForThumbnails(t.page);

    await startMerge(t);
    await waitForStatus(t, /error|could not|valid PDF/i, 60000);

    const message = await statusText(t);
    assert.match(message, /broken\.pdf/, `the message should name the damaged file, got: ${message}`);
    assert.doesNotMatch(message, /“good\.pdf”/, "the message blames a file that was fine");
  },
  { ...MERGE, knownBug: "a merge failure is reported against the first file, not the one that failed" }
);

test(
  "a Word file is refused with an honest reason instead of a broken merge",
  async (t) => {
    // A file can reach the strip with a PDF type and a Word name (a rename, or
    // an operating system that reports the type loosely). The merge must notice
    // the name and say plainly that this needs a server, not fail halfway.
    await addFiles(t, "#fileInput", named("notes.pdf"));
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
    await t.page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([1, 2, 3])], "report.docx", { type: "application/pdf" }));
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: transfer });
      document.getElementById("dropzone").dispatchEvent(drop);
    });
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 2);

    await t.page.locator("#convertBtn").click();
    await waitForStatus(t, /can't be converted in the browser/i, 10000);

    const message = await statusText(t);
    assert.match(message, /conversion server|on the roadmap/, "the reason should be honest about what is missing");
    assert.match(message, /report\.docx|Remove it/, "the message should say which file to take out");
    assert.equal(await t.page.locator("#resultBar").isVisible(), false, "nothing should have been produced");
    assert.equal(await t.page.locator("#convertBtn").isEnabled(), true);
  },
  MERGE
);

test(
  "compressing the merge keeps the pages and reports what it saved",
  async (t) => {
    await addFiles(t, "#fileInput", [makeNamedPdfFile("color.pdf", { pages: 3 })]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
    await waitForThumbnails(t.page);

    await step("the quality choices stay hidden until compression is asked for", async () => {
      assert.equal(await t.page.locator("#compressQuality").isVisible(), false);
      await t.page.locator("#compressToggle").check();
      assert.equal(await t.page.locator("#compressQuality").isVisible(), true);
    });

    await step("picking a level marks only that one", async () => {
      await t.page.locator('#compressQuality .pill[data-q="small"]').click();
      const selected = await t.page.locator("#compressQuality .pill.selected").allInnerTexts();
      assert.deepEqual(selected, ["Smallest"]);
    });

    await mergeNow(t);
    await waitForStatus(t, /compressed/i, 60000);

    const merged = await readMerged(t);
    assert.equal(merged.numPages, 3, "compression must not drop or duplicate pages");
    const text = await readResultText(t);
    assert.match(text, /Merged and compressed\./);
    assert.match(text, /Smallest/, "the chosen level should be named");

    await step("the page says the text is no longer selectable, because it is not", async () => {
      const note = await t.page.locator("#mergeCompress").innerText();
      assert.match(note, /no longer selectable or searchable/i);
    });
  },
  MERGE
);

test(
  "a merge never sends anything off the device",
  async (t) => {
    await addFiles(t, "#fileInput", [makeNamedPdfFile("private.pdf", { pages: 2 })]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
    await waitForThumbnails(t.page);
    await t.page.locator("#compressToggle").check();
    await mergeNow(t);

    assert.deepEqual(t.requestsWithBody(), [], "something was uploaded");
    assert.deepEqual(
      t.foreignRequests(),
      [],
      "a request went somewhere other than the site, the CDN or the font host"
    );
    const cdn = t.requests.filter((r) => r.url.startsWith("https://cdnjs.cloudflare.com/"));
    assert.ok(cdn.length > 0, "the libraries should have been fetched from the CDN");
    assert.ok(
      cdn.every((r) => r.url.includes("pdf.js") || r.url.includes("pdf-lib")),
      `unexpected CDN request: ${cdn.map((r) => r.url).join(", ")}`
    );
  },
  MERGE
);

test(
  "when the PDF library cannot load, the message says so",
  async (t) => {
    await addFiles(t, "#fileInput", [makeNamedPdfFile("offline.pdf")]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);

    await t.page.locator("#convertBtn").click();
    await waitForStatus(t, /could not load|internet connection/i, 30000);

    const message = await statusText(t);
    assert.match(message, /reload|connection/i);
    assert.doesNotMatch(message, /Failed to fetch|Loading chunk/, "a network error leaked into the message");
    assert.equal(await t.page.locator("#convertBtn").isEnabled(), true, "the button must come back for a retry");
    assert.equal(await t.page.locator("#resultBar").isVisible(), false);
  },
  { ...MERGE, blockCdn: true, pageErrors: false }
);
