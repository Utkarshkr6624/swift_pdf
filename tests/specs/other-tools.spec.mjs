// The remaining tools, checked for the contract they all share: a file goes in,
// a valid file comes out, and a failure is explained. Nothing here tries to
// re-test a tool's whole feature list.
import { test, assert, step } from "../lib/harness.mjs";
import { makeNamedPdfFile, makeBrokenPdfFile, makePng, makeTextFile } from "../lib/fixtures.mjs";
import { addFiles, waitForResultBar, waitForStatus, statusText } from "../lib/browser.mjs";

// Page count and text of whatever the tool last produced.
const readResult = (t) =>
  t.page.evaluate(async () => {
    const pdfjs = await loadPdfJs();
    const bar = document.getElementById("resultBar");
    const bytes = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pages = [];
    try {
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
        const page = await doc.getPage(pageNo);
        const content = await page.getTextContent();
        pages.push({
          text: content.items.map((item) => item.str).join(" ").trim(),
          width: page.getViewport({ scale: 1 }).width,
          height: page.getViewport({ scale: 1 }).height,
        });
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    return { bytes: bytes.length, pages };
  });

test(
  "Image to PDF turns the images, in order, into one page each",
  async (t) => {
    await addFiles(t, "#fileInput", [
      { name: "first.png", mimeType: "image/png", buffer: makePng() },
      { name: "second.png", mimeType: "image/png", buffer: makePng() },
    ]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 2);
    assert.equal(await t.page.locator("#imagePageCount").innerText(), "2 images · 2 PDF pages");

    await step("a file that is not an image is refused", async () => {
      await addFiles(t, "#fileInput", [makeTextFile("notes.txt")]);
      assert.match(await statusText(t), /skipped/i);
      assert.equal(await t.page.locator(".file-strip .chip").count(), 2);
    });

    await t.page.locator("#convertBtn").click();
    await waitForResultBar(t, 60000);

    const result = await readResult(t);
    assert.equal(result.pages.length, 2, "one page per image");
    for (const page of result.pages) assert.ok(page.width > 100 && page.height > 100, "the page has no size");
  },
  { path: "/image-to-pdf.html" }
);

test(
  "Compress PDF makes a file it can still read",
  async (t) => {
    await addFiles(t, "#fileInput", [makeNamedPdfFile("big.pdf", { pages: 3 })]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);

    await step("a quality can be chosen", async () => {
      await t.page.locator('.pill[data-q="small"]').click();
      assert.deepEqual(await t.page.locator(".pill.selected").allInnerTexts(), ["Smallest"]);
    });

    await t.page.locator("#compressBtn").click();
    await waitForResultBar(t, 60000);
    await waitForStatus(t, /compress/i, 30000);

    const result = await readResult(t);
    assert.equal(result.pages.length, 3, "compression must keep every page");
    assert.match(await t.page.locator(".result-text").innerText(), /compress/i);
  },
  { path: "/compress-pdf.html" }
);

test(
  "Add page numbers writes a number on every page, starting where asked",
  async (t) => {
    await addFiles(t, "#fileInput", [makeNamedPdfFile("doc.pdf", { pages: 3 })]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);

    await step("a starting number out of range is refused before any work", async () => {
      await t.page.locator("#startNumber").fill("0");
      await t.page.locator("#numberBtn").click();
      await waitForStatus(t, /starting number/i, 10000);
      assert.equal(await t.page.locator("#resultBar").isVisible(), false);
    });

    await t.page.locator("#startNumber").fill("7");
    await t.page.locator("#numberPosition").selectOption("top");
    await t.page.locator("#numberBtn").click();
    await waitForResultBar(t, 60000);

    const result = await readResult(t);
    assert.equal(result.pages.length, 3);
    result.pages.forEach((page, index) => {
      assert.match(page.text, new RegExp(`\\b${7 + index}\\b`), `page ${index + 1} is not numbered`);
    });
    assert.match(await statusText(t), /Added numbers to 3 pages/);
  },
  { path: "/page-numbers.html" }
);

test(
  "a second file replaces the first on the single-file tools",
  async (t) => {
    await addFiles(t, "#fileInput", [makeNamedPdfFile("one.pdf", { pages: 1 })]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
    await addFiles(t, "#fileInput", [makeNamedPdfFile("two.pdf", { pages: 1 })]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
    assert.deepEqual(await t.page.locator(".file-strip .chip .chip-name").allInnerTexts(), ["two.pdf"]);
  },
  { path: "/page-numbers.html" }
);

test(
  "PDF to image packs one image per page into a ZIP",
  async (t) => {
    await addFiles(t, "#fileInput", [makeNamedPdfFile("doc.pdf", { pages: 2 })]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);

    await t.page.locator("#convertBtn").click();
    await waitForResultBar(t, 60000);
    await waitForStatus(t, /Done/, 30000);

    const zip = await t.page.evaluate(async () => {
      const bar = document.getElementById("resultBar");
      const data = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
      return {
        bytes: data.length,
        magic: String.fromCharCode(...data.slice(0, 2)),
        extension: document.querySelector(".result-bar .name-ext").textContent,
        status: document.getElementById("status").textContent,
      };
    });

    assert.equal(zip.extension, ".zip", "the result bar should say what was made");
    assert.equal(zip.magic, "PK", "the download is not a ZIP");
    assert.ok(zip.bytes > 1000, `the download looks empty (${zip.bytes} bytes)`);
    assert.match(zip.status, /2 images packed/);
  },
  { path: "/pdf-to-image.html" }
);

test(
  "every tool explains a file it cannot read and stays usable",
  async (t) => {
    const tools = [
      { page: "/merge-pdf.html", action: "#convertBtn" },
      { page: "/compress-pdf.html", action: "#compressBtn" },
      { page: "/page-numbers.html", action: "#numberBtn" },
      { page: "/edit-pdf.html", action: null },
      { page: "/organize-pdf.html", action: null },
    ];

    for (const tool of tools) {
      await step(tool.page, async () => {
        await t.page.goto(t.url(tool.page), { waitUntil: "domcontentloaded" });
        await addFiles(t, "#fileInput", [makeBrokenPdfFile("broken.pdf")]);

        if (tool.action) {
          await t.page.locator(tool.action).click();
          await waitForStatus(t, /could not|valid PDF|error|damaged/i, 30000);
        } else {
          // These two open the file rather than acting on a button, so the file
          // itself has to be the thing that reports the problem.
          await waitForStatus(t, /could not|valid PDF|error|damaged/i, 30000);
        }

        const message = await statusText(t);
        assert.doesNotMatch(message, /InvalidPDFException|at Object\.|PDFDocument/, "a parser error leaked out");
        assert.equal(await t.page.locator("#status").getAttribute("aria-busy"), null, "still marked as working");
        const locked = await t.page
          .locator("button:visible")
          .evaluateAll((nodes) => nodes.filter((node) => node.disabled).map((node) => node.id || node.textContent.trim()));
        assert.deepEqual(locked, [], "controls stayed disabled after a failure");
        assert.equal(await t.page.locator("#resultBar").isVisible(), false, "a broken file produced a result");
      });
    }
  }
);
