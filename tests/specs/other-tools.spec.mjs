// The remaining tools, checked for the contract they all share: a file goes in,
// a valid file comes out, and a failure is explained. Nothing here tries to
// re-test a tool's whole feature list.
import { Buffer } from "node:buffer";
import { test, assert, step } from "../lib/harness.mjs";
import { makeNamedPdfFile, makeBrokenPdfFile, makePng, makeTextFile } from "../lib/fixtures.mjs";
import { addFiles, mouseDrag, waitForResultBar, waitForStatus, statusText } from "../lib/browser.mjs";

// The wording this suite treats as telling someone their text has gone - the same
// shape convert.spec.mjs uses for the compression note on the converter page.
const TEXT_IS_GONE = /selectable|searchable|searched for|copied/i;

// What a person reads after pressing the button: the result bar and the status
// line. Deliberately not the whole document - compress-pdf.html already warns
// about the text in the paragraph above the dropzone, so reading the page would
// let the warning go missing from the result and still pass.
const readDelivery = (t) =>
  t.page
    .evaluate(() => ({
      result: document.getElementById("resultBar")?.textContent || "",
      status: document.getElementById("status")?.textContent || "",
    }))
    .then(({ result, status }) => `RESULT BAR: ${result}\nSTATUS LINE: ${status}`);

// Page count and text of whatever the tool last produced.
const readResult = (t) =>
  t.page.evaluate(async () => {
    const pdfjs = await loadPdfJs();
    const bar = document.getElementById("resultBar");
    const bytes = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
    // pdf.js takes the buffer apart while it reads, so its length is read first.
    const size = bytes.length;
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
    return { bytes: size, pages };
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

/* ================================================================== *
 * Rebuilding pages as images, and what the user is told about it
 * ================================================================== */

// A cropped PDF page is rebuilt as a picture on the way out, so it takes a
// different path from a page that was only copied, and that path used to throw:
// addCroppedPdfPage in organize-pdf.js takes the output PDFDocument as a parameter
// called `document`, so `document.createElement` called the library instead of the
// browser and every cropped export died blaming the user's file. The crop here is a
// real pointer drag, because the crop dialog listens for pointer events and a
// synthesised DragEvent never reaches them.
test(
  "Organize PDF saves a cropped page instead of blaming the file",
  async (t) => {
    await addFiles(t, "#fileInput", [makeNamedPdfFile("report.pdf", { pages: 2 })]);
    await t.page.waitForFunction(
      () => document.querySelectorAll("#pageGrid .page-card").length === 2,
      null,
      { timeout: 60000 }
    );

    await step("the first page is cropped by dragging its corner handle inwards", async () => {
      const card = t.page.locator("#pageGrid .page-card").first();
      const thumbBefore = await card.locator("img").getAttribute("src");

      await card.locator('[aria-label="Crop page 1"]').click();
      await t.page.locator("#cropOverlay").waitFor({ state: "visible", timeout: 60000 });

      const before = await t.page.locator("#cropDimensions").innerText();
      const handle = await t.page.locator(".crop-handle-se").boundingBox();
      assert.ok(handle, "the crop frame has no corner handle to drag");
      await mouseDrag(
        t,
        { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
        { x: handle.x + handle.width / 2 - 150, y: handle.y + handle.height / 2 - 200 }
      );
      const after = await t.page.locator("#cropDimensions").innerText();
      assert.notEqual(after, before, `the drag did not change the crop (still ${before})`);

      await t.page.locator('.crop-foot button:has-text("Apply crop")').click();
      // Redrawing the card's preview from the cropped page is the last thing the
      // tool does before it hands the page back, so it is the signal the crop stuck.
      await t.page.waitForFunction(
        (old) => document.querySelector("#pageGrid .page-card img")?.getAttribute("src") !== old,
        thumbBefore,
        { timeout: 60000 }
      );
    });

    await step("saving hands back a PDF with both pages on it", async () => {
      await t.page.locator("#saveBtn").click();
      // Either the file appears or the page says why it could not be made. Waiting
      // for one of the two reports a broken export as a sentence rather than as a
      // timeout with nothing to say about it.
      await t.page.waitForFunction(
        () => {
          const bar = document.getElementById("resultBar");
          const status = document.getElementById("status")?.textContent || "";
          return (bar && !bar.hidden) || /could not|damaged|failed|unsupported|error/i.test(status);
        },
        null,
        { timeout: 120000 }
      );
      assert.equal(
        await t.page.locator("#resultBar").isVisible(),
        true,
        `saving a cropped page produced no file: ${await statusText(t)}`
      );

      const result = await readResult(t);
      assert.equal(result.pages.length, 2, "a page went missing from the organized PDF");
      assert.ok(result.bytes > 1000, `the download looks empty (${result.bytes} bytes)`);

      // Page 1 was cropped to a little under half the page, so whatever route the
      // export takes it cannot come back at full size. This is what tells the two
      // pages apart; the page count alone cannot.
      const [cropped, untouched] = result.pages;
      assert.ok(cropped.width < untouched.width, `the cropped page is still ${cropped.width}pt wide, the same as an uncropped one (${untouched.width}pt)`);
      assert.ok(cropped.height < untouched.height, `the cropped page is still ${cropped.height}pt tall, the same as an uncropped one (${untouched.height}pt)`);
    });
  },
  { path: "/organize-pdf.html" }
);

// A PDF carrying both a large photograph and one line of text. The picture is what
// makes re-encoding a page pay off, and the line is the witness: text going in and
// none coming out is the tool's doing, not the fixture's. Built in the page with the
// site's own pdf-lib, so there is no binary fixture to keep in sync.
async function photoPdfFile(t, name, line) {
  const bytes = await t.page.evaluate(async (words) => {
    const PDFLib = await loadPdfLib();
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 2200;
    const paint = canvas.getContext("2d");
    const wash = paint.createLinearGradient(0, 0, 1600, 2200);
    wash.addColorStop(0, "#2f6bff");
    wash.addColorStop(0.45, "#dfe8ff");
    wash.addColorStop(1, "#0d1c46");
    paint.fillStyle = wash;
    paint.fillRect(0, 0, 1600, 2200);
    paint.strokeStyle = "#0d1c46";
    paint.lineWidth = 26;
    for (let ring = 0; ring < 9; ring++) {
      paint.beginPath();
      paint.arc(800, 1100, 120 + ring * 90, 0, Math.PI * 2);
      paint.stroke();
    }
    paint.fillStyle = "#ffffff";
    paint.font = "200px sans-serif";
    paint.fillText("PLATE", 260, 1180);
    const jpeg = await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no blob"))), "image/jpeg", 0.92)
    );

    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const page = doc.addPage([595.28, 841.89]);
    page.drawImage(await doc.embedJpg(await jpeg.arrayBuffer()), { x: 0, y: 0, width: 595.28, height: 841.89 });
    page.drawText(words, { x: 40, y: 40, size: 18, font, color: PDFLib.rgb(1, 1, 1) });
    return Array.from(new Uint8Array(await doc.save()));
  }, line);
  return { name, mimeType: "application/pdf", buffer: Buffer.from(bytes) };
}

// The text a finished PDF actually carries, read out of raw bytes rather than off a
// result bar, so a fixture can be checked as the input it is about to be.
const textInBytes = (t, bytes) =>
  t.page.evaluate(async (data) => {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    try {
      const lines = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        lines.push((await page.getTextContent()).items.map((item) => item.str).join(" "));
        page.cleanup();
      }
      return lines.join(" ").trim();
    } finally {
      await doc.destroy();
    }
  }, Array.from(bytes));

// Compressing redraws every page as a JPEG, and a JPEG has no text in it. A person
// who searches the file afterwards finds nothing, so the tool has to say so at the
// moment they are handed the file - not only in the paragraph above the dropzone,
// which is there whether or not anyone reads it.
test(
  "Compress PDF says the text is gone when the file really did shrink",
  async (t) => {
    const file = await photoPdfFile(t, "plate.pdf", "plate page 1");

    await step("the input carries the text the tool is about to destroy", async () => {
      assert.match(await textInBytes(t, file.buffer), /plate page 1/, "the fixture never had any text in it, so the loss below would prove nothing");
    });

    await addFiles(t, "#fileInput", [file]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);

    await t.page.locator("#compressBtn").click();
    await waitForResultBar(t, 120000);

    const result = await readResult(t);

    await step("the file really did get smaller, so this is the branch under test", () => {
      assert.equal(result.pages.length, 1, "compression must keep the page");
      assert.ok(
        result.bytes < file.buffer.length,
        `the file did not shrink (${result.bytes} bytes against ${file.buffer.length}), so this is not the branch under test`
      );
    });

    await step("and the result really has no text left in it", () => {
      result.pages.forEach((page) =>
        assert.equal(page.text, "", "the compressed page still carries a text layer")
      );
    });

    await step("the person holding the file is told the text is gone", async () => {
      const said = await readDelivery(t);
      assert.match(
        said,
        TEXT_IS_GONE,
        `the tool threw the text layer away and the result the user reads does not say so: ${said}`
      );
    });
  },

  { path: "/compress-pdf.html" }
);

// The other half of the same promise. A PDF that is already a few kilobytes of
// vector text cannot get smaller by being redrawn as JPEG pictures, so the tool
// says so and tells the reader to keep the original - but it has still thrown the
// text layer away on the way, and the copy it hands over is the one without it.
// The disclosure is owed on this branch too, and it is the branch a reader is most
// likely to believe is harmless, because the sentence reassuring them is reassuring.
test(
  "Compress PDF says the text is gone even on the copy it tells you not to keep",
  async (t) => {
    const file = makeNamedPdfFile("lean.pdf", { pages: 3 });
    await addFiles(t, "#fileInput", [file]);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);

    await t.page.locator("#compressBtn").click();
    await waitForResultBar(t, 120000);

    const result = await readResult(t);
    const said = await readDelivery(t);

    await step("the file really did get bigger, so this is the branch under test", () => {
      assert.equal(result.pages.length, 3, "compression must keep every page");
      assert.ok(
        result.bytes > file.buffer.length,
        `the file did not get bigger (${result.bytes} bytes against ${file.buffer.length}), so this is not the branch under test`
      );
      assert.match(
        said,
        /already well compressed|keep the original/i,
        `the tool did not take the keep-the-original branch: ${said}`
      );
    });

    await step("and the copy it hands over really has no text in it", () => {
      result.pages.forEach((page) =>
        assert.equal(page.text, "", "a page still reads back with text in it")
      );
    });

    await step("the person holding that copy is told the text is gone", () => {
      assert.match(
        said,
        TEXT_IS_GONE,
        `the tool threw the text layer away, told the reader to keep the original, and never said the text went: ${said}`
      );
    });
  },
  { path: "/compress-pdf.html" }
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

test(
  "Image to PDF handles a whole folder without running out of room",
  async (t) => {
    // The tool used to hold every picture as a base64 string, then decode all of
    // them back into bytes, then hold the finished PDF on top of that. Each page
    // is now encoded, appended and released before the next picture is opened, so
    // what matters here is that a batch still produces every page and a file that
    // opens - the memory behaviour itself is not something a test can assert.
    const count = 9;
    await addFiles(t, "#fileInput",
      Array.from({ length: count }, (_, i) => ({
        name: `photo${i}.png`,
        mimeType: "image/png",
        buffer: makePng(),
      }))
    );
    await t.page.waitForFunction(
      (n) => document.querySelectorAll(".file-strip .chip").length === n,
      count,
      { timeout: 60000 }
    );
    await t.page.locator("#convertBtn").click();
    await waitForResultBar(t, 60000);

    const result = await readResult(t);
    assert.equal(result.pages.length, count, "a page went missing");
    for (const page of result.pages) {
      assert.ok(page.width > 0 && page.height > 0, "a page came out with no size");
    }

    await step("and every page carries an image", async () => {
      const perPage = await t.page.evaluate(async () => {
        const pdfjs = await loadPdfJs();
        const bar = document.getElementById("resultBar");
        const bytes = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        const found = [];
        try {
          for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const ops = await page.getOperatorList();
            // paintImageXObject is what a placed picture turns into.
            found.push(ops.fnArray.includes(pdfjs.OPS.paintImageXObject));
            page.cleanup();
          }
        } finally {
          await doc.destroy();
        }
        return found;
      });
      assert.equal(perPage.length, count);
      assert.ok(perPage.every(Boolean), "some pages did not get their picture onto them");
    });
  },
  { path: "/image-to-pdf.html" }
);
