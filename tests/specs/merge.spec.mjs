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

// The wording this suite treats as telling someone their text has gone - the same
// shape convert.spec.mjs uses for the compression note on the converter page.
const TEXT_IS_GONE = /selectable|searchable|searched for|copied/i;

// What a person reads once the merge finishes: the result bar and the status line.
// Deliberately not the whole document - merge-pdf.html already carries the warning
// in the note beside the compression checkbox, and that note is on screen whether or
// not the merge was compressed, so reading the page would let the delivered result
// say nothing at all and still pass.
const readDelivery = (t) =>
  t.page
    .evaluate(() => ({
      result: document.getElementById("resultBar")?.textContent || "",
      status: document.getElementById("status")?.textContent || "",
    }))
    .then(({ result, status }) => "RESULT BAR: " + result + " | STATUS LINE: " + status);

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
  { ...MERGE }
);

// A real .docx, built in the browser with the site's own JSZip, so nothing here
// is mocked and no binary fixture can rot. This function is stringified into the
// page, so it cannot close over anything in this file. Passing `bytes` skips the
// ZIP and produces a damaged file that still announces itself as a Word document.
function docxBuilder() {
  return async function (paragraphs, name, bytes) {
    if (bytes) return new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
    const JSZip = await loadJsZip();
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>"
    );
    const body = paragraphs
      .map((text) => '<w:p><w:r><w:t xml:space="preserve">' + text + "</w:t></w:r></w:p>")
      .join("");
    zip.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        "<w:body>" + body + "</w:body></w:document>"
    );
    const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return new File([out], name, {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  };
}

async function withDocxBuilder(t) {
  await t.page.addScriptTag({ content: "window.buildDocx = (" + docxBuilder.toString() + ")();" });
  await t.page.waitForFunction(() => typeof window.buildDocx === "function");
}

// Drop a file built in the page onto the dropzone, the way a person would, and
// wait for the chip to land.
async function dropBuiltFile(t, spec) {
  await t.page.evaluate(
    async (args) => {
      const file = await window.buildDocx(args.paragraphs, args.name, args.bytes);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: transfer });
      document.getElementById("dropzone").dispatchEvent(drop);
    },
    spec
  );
  await t.page.waitForFunction(
    (count) => document.querySelectorAll(".file-strip .chip").length === count,
    spec.expect
  );
}

test(
  "a Word file is converted in the browser, merged in place, and the result admits what it lost",
  async (t) => {
    await withDocxBuilder(t);
    await addFiles(t, "#fileInput", named("notes.pdf"));
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
    await waitForThumbnails(t.page);

    await dropBuiltFile(t, {
      paragraphs: [
        "Quarterly summary written in the browser.",
        "Every word on this line has to survive the conversion.",
      ],
      name: "report.docx",
      expect: 2,
    });

    await mergeNow(t);

    await step("the Word file lands in the merged document, in strip order", async () => {
      const merged = await readMerged(t);
      assert.equal(merged.numPages, 2, "one PDF page plus the page the document became");
      const all = merged.text.join(" ");
      assert.match(all, /notes page 1/);
      assert.match(all, /Quarterly summary written in the browser\./);
      assert.match(all, /Every word on this line has to survive the conversion\./);
    });

    await step("the result says the conversion lost things, in the engine's words", async () => {
      const text = await readResultText(t);
      assert.match(text, /Merged \d+ files?/);
      assert.match(text, /1 converted to PDF first/);
      const notes = await t.page.textContent("#mergeNotesBody");
      assert.match(notes, /report\.docx/, "the disclosure should name the converted file");
      assert.match(notes, /Fonts, colours, spacing and the original page layout are not reproduced/);
      assert.match(notes, /footnotes/, "what is dropped has to be listed, not merely called lossy");
    });

    await step("the status line does not oversell it either", async () => {
      const message = await statusText(t);
      assert.match(message, /Word, PowerPoint or Excel file/);
      assert.match(message, /converted here first/);
    });

    await step("nothing left the device to do it", () => {
      assert.deepEqual(t.requestsWithBody(), [], "something was uploaded");
      const cdn = t.requests.filter((r) => r.url.startsWith("https://cdnjs.cloudflare.com/"));
      assert.ok(
        cdn.every((r) => /pdf\.js|pdf-lib|jszip/.test(r.url)),
        `unexpected CDN request: ${cdn.map((r) => r.url).join(", ")}`
      );
    });
  },
  MERGE
);

test(
  "a Word file that cannot be opened stops the merge with a sentence that names it",
  async (t) => {
    await withDocxBuilder(t);
    await addFiles(t, "#fileInput", named("notes.pdf"));
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);

    await step("a file can reach the strip with a PDF type and a Word name", async () => {
      // A ZIP signature and nothing behind it: the engine recognises it as an
      // Office document, tries, and cannot read it.
      await dropBuiltFile(t, { paragraphs: [], name: "report.docx", bytes: [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0], expect: 2 });
    });

    await startMerge(t);
    await waitForStatus(t, /could not be opened|could not be converted/, 30000);

    await step("the message is the engine's own sentence, not a parser error", async () => {
      const message = await statusText(t);
      assert.match(message, /^report\.docx/, `the message should open with the file name: ${message}`);
      assert.match(message, /could not be opened|could not be converted/);
      assert.doesNotMatch(message, /InvalidPDFException|at Object\.|PDFDocument/, "a parser error leaked into the message");
      assert.equal(await t.page.locator("#resultBar").isVisible(), false, "nothing should have been produced");
      assert.equal(await t.page.locator("#convertBtn").isEnabled(), true, "a retry has to be possible");
    });

    await step("an older .doc is named and refused before any work starts", async () => {
      await dropBuiltFile(t, { paragraphs: [], name: "old.doc", bytes: [0x50, 0x4b, 0x03, 0x04], expect: 3 });
      await t.page.locator("#convertBtn").click();
      await waitForStatus(t, /old\.doc/, 10000);
      const message = await statusText(t);
      assert.match(message, /older Word, PowerPoint or Excel file/i);
      assert.match(message, /\.docx/, "the newer format it does open should be named");
      assert.equal(await t.page.locator("#resultBar").isVisible(), false);
      assert.equal(await t.page.locator("#convertBtn").isEnabled(), true);
    });
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
    assert.match(text, /Merged 1 PDF/);
    assert.match(text, /Smallest/, "the chosen level should be named");

    await step("the page says the text is no longer selectable, because it is not", async () => {
      const note = await t.page.locator("#mergeCompress").innerText();
      assert.match(note, /no longer selectable or searchable/i);
    });
  },
  MERGE
);

// Compressing a merge redraws every page as a JPEG, so the document that comes out
// has no text in it. Left alone, pdf-lib copies the pages across untouched and the
// text is still there. Both halves are asserted here, because a warning bolted on
// unconditionally is worse than none: a merge that kept its text must not claim that
// it lost it, or people will stop believing the tool when it says the opposite.
test(
  "a compressed merge admits the text is gone, and a plain merge keeps its text without claiming otherwise",
  async (t) => {
    await addFiles(t, "#fileInput", [
      makeNamedPdfFile("alpha.pdf", { pages: 2 }),
      makeNamedPdfFile("beta.pdf", { pages: 1 }),
    ]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 2);
    await waitForThumbnails(t.page);

    await step("without compression the text survives, and the result claims nothing", async () => {
      assert.equal(await t.page.locator("#compressToggle").isChecked(), false);
      await mergeNow(t);

      const merged = await readMerged(t);
      assert.equal(merged.numPages, 3, "two pages plus one page should be three pages");
      assert.deepEqual(
        merged.text,
        ["alpha page 1", "alpha page 2", "beta page 1"],
        "a plain merge threw the text away"
      );

      const said = await readDelivery(t);
      assert.doesNotMatch(
        said,
        /text|selectable|searchable/i,
        `an uncompressed merge keeps its text and must not say otherwise: ${said}`
      );
    });

    await step("with compression the text really is gone, and the result says so", async () => {
      await t.page.locator("#compressToggle").check();
      await mergeNow(t);

      const merged = await readMerged(t);
      assert.equal(merged.numPages, 3, "compression must not drop or duplicate pages");
      assert.deepEqual(
        merged.text,
        ["", "", ""],
        "the compressed pages still carry a text layer"
      );

      const said = await readDelivery(t);
      assert.match(
        said,
        TEXT_IS_GONE,
        `the compressed merge threw the text layer away and never told the reader: ${said}`
      );
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

test(
  "a merge of many files still comes back as a whole, readable PDF",
  async (t) => {
    // The complaint this answers is a merge of a lot of PDFs handing back
    // something that is not a PDF at all. The pages here are small, so what is
    // being checked is the shape of the result at a batch size well past the
    // few-file case: every page present, in order, and a file that opens.
    const count = 24;
    const pagesEach = 3;
    const files = Array.from({ length: count }, (_, i) =>
      makeNamedPdfFile(`part${String(i).padStart(2, "0")}.pdf`, { pages: pagesEach })
    );
    await addFiles(t, "#fileInput", files);
    await t.page.waitForFunction(
      (n) => document.querySelectorAll(".file-strip .chip").length === n,
      count,
      { timeout: 60000 }
    );
    await mergeNow(t);

    await step("every page is there, in the order the strip is in", async () => {
      const merged = await readMerged(t);
      assert.equal(merged.numPages, count * pagesEach, "a page went missing from the merge");
      const order = merged.text.map((line) => line.split(" ")[0]);
      const expected = Array.from({ length: count }, (_, i) =>
        Array.from({ length: pagesEach }, () => `part${String(i).padStart(2, "0")}`)
      ).flat();
      assert.deepEqual(order, expected, "the pages came back in the wrong order");
    });

    await step("the bytes are a PDF, not a short buffer", async () => {
      const shape = await t.page.evaluate(async () => {
        const bar = document.getElementById("resultBar");
        const bytes = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
        return {
          header: String.fromCharCode(...bytes.slice(0, 5)),
          trailer: String.fromCharCode(...bytes.slice(Math.max(0, bytes.length - 64))),
        };
      });
      assert.equal(shape.header, "%PDF-", "the result does not begin like a PDF");
      assert.match(shape.trailer, /%%EOF/, "the result has no trailer, so it is incomplete");
    });
  },
  MERGE
);
