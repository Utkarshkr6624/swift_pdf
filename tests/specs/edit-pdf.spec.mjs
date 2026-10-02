// Edit PDF Text, driven the way a person drives it: open a file, read the page,
// tap a line, type a replacement, save.
import { test, assert, step } from "../lib/harness.mjs";
import { makeNamedPdfFile, makePdf, makeBrokenPdfFile } from "../lib/fixtures.mjs";
import { addFiles, waitForStatus, statusText } from "../lib/browser.mjs";

const EDIT = { path: "/edit-pdf.html" };

async function openPdf(t, files) {
  await addFiles(t, "#fileInput", files);
  await t.page.locator("#editorShell").waitFor({ state: "visible", timeout: 30000 });
}

// Types a replacement over the first line of the page. The overlay box always
// holds the original words (the new ones are painted on the canvas), so an
// applied edit shows up as the is-edited marker and the spoken label.
async function editFirstLine(t, replacement) {
  const first = t.page.locator("#pageOverlay .ed-box").first();
  const original = await first.innerText();
  await first.click();
  await t.page.locator("#textInput").fill(replacement);
  await t.page.locator("#applyBtn").click();
  await t.page.waitForFunction(
    (text) => {
      const box = document.querySelector("#pageOverlay .ed-box.is-edited");
      return box && (box.getAttribute("aria-label") || "").includes(text);
    },
    replacement,
    { timeout: 5000 }
  );
  return original;
}

const editedLines = (t) => t.page.locator("#pageOverlay .ed-box.is-edited").count();

const savedText = (t) =>
  t.page.evaluate(async () => {
    const pdfjs = await loadPdfJs();
    const bar = document.getElementById("resultBar");
    const data = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const pages = [];
    try {
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
        const page = await doc.getPage(pageNo);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => item.str).join(" "));
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    return pages;
  });

test(
  "opening a PDF swaps the dropzone for the editor and counts the pages",
  async (t) => {
    await step("before a file is chosen there is nothing but the dropzone", async () => {
      assert.equal(await t.page.locator("#dropzone").isVisible(), true);
      assert.equal(await t.page.locator("#editorShell").isVisible(), false);
    });

    await openPdf(t, [makeNamedPdfFile("letter.pdf", { pages: 3 })]);

    assert.equal(await t.page.locator("#dropzone").isVisible(), false);
    assert.equal(await t.page.locator("#editorShell").isVisible(), true);
    assert.equal(await t.page.locator("#pageCounter").innerText(), "1 / 3");
    assert.equal(await t.page.locator("#pageCounter").getAttribute("aria-label"), "Page 1 of 3");
    assert.equal(await t.page.locator("#pageChips button").count(), 3);

    await step("the page is drawn with a box over every piece of text", async () => {
      const boxes = await t.page.locator("#pageOverlay .ed-box").count();
      assert.ok(boxes >= 1, "there should be something to tap");
      const label = await t.page.locator("#pageOverlay .ed-box").first().getAttribute("aria-label");
      assert.match(label, /^Text: /, `unexpected box label: ${label}`);
      const drawn = await t.page.evaluate(() => document.getElementById("pageCanvas").width);
      assert.ok(drawn > 100, "the page canvas was not painted");
    });

    await step("the file name is carried over for the download", async () => {
      assert.equal(await t.page.locator("#fileName").inputValue(), "letter");
    });

    assert.match(await statusText(t), /Loaded 3 pages/);
    assert.equal(await t.page.locator("#choosePdfBtn").isEnabled(), true, "the page should not be left locked");
  },
  EDIT
);

test(
  "pages can be turned through with the buttons, the chips and the arrow keys",
  async (t) => {
    await openPdf(t, [makeNamedPdfFile("letter.pdf", { pages: 3 })]);

    await step("the first page has nowhere back to go", async () => {
      assert.equal(await t.page.locator("#pagePrev").isDisabled(), true);
      assert.equal(await t.page.locator("#pageNext").isDisabled(), false);
    });

    await t.page.locator("#pageNext").click();
    await t.page.waitForFunction(() => document.getElementById("pageCounter").textContent === "2 / 3");
    await waitForStatus(t, /Page 2\./, 10000);

    await step("the last page has nowhere on to go", async () => {
      await t.page.locator("#pageNext").click();
      await t.page.waitForFunction(() => document.getElementById("pageCounter").textContent === "3 / 3");
      assert.equal(await t.page.locator("#pageNext").isDisabled(), true);
      assert.equal(await t.page.locator("#pagePrev").isDisabled(), false);
    });

    await step("a chip jumps straight to its page", async () => {
      await t.page.locator("#pageChips button").first().click();
      await t.page.waitForFunction(() => document.getElementById("pageCounter").textContent === "1 / 3");
      assert.equal(
        await t.page.locator("#pageChips button").first().getAttribute("aria-current"),
        "page",
        "the current page should be marked"
      );
    });

    await step("the arrow keys work without touching the mouse", async () => {
      await t.page.locator("#edStage").click({ position: { x: 5, y: 5 } });
      await t.page.keyboard.press("Escape");
      await t.page.keyboard.press("ArrowRight");
      await t.page.waitForFunction(() => document.getElementById("pageCounter").textContent === "2 / 3");
      await t.page.keyboard.press("ArrowLeft");
      await t.page.waitForFunction(() => document.getElementById("pageCounter").textContent === "1 / 3");
    });
  },
  EDIT
);

test(
  "zoom in, out and fit, with the level spelled out",
  async (t) => {
    await openPdf(t, [makeNamedPdfFile("letter.pdf", { pages: 1 })]);
    assert.equal(await t.page.locator("#zoomLevel").innerText(), "100%");

    await t.page.locator("#zoomIn").click();
    const zoomedIn = await t.page.locator("#zoomLevel").innerText();
    assert.notEqual(zoomedIn, "100%", `zoom in did nothing, still ${zoomedIn}`);

    await t.page.locator("#zoomOut").click();
    await t.page.locator("#zoomOut").click();
    assert.notEqual(await t.page.locator("#zoomLevel").innerText(), zoomedIn);

    await t.page.locator("#zoomFit").click();
    assert.equal(await t.page.locator("#zoomLevel").innerText(), "100%");
  },
  EDIT
);

test(
  "tapping a line fills the panel with it, and Apply records the change",
  async (t) => {
    await openPdf(t, [makeNamedPdfFile("letter.pdf", { pages: 1 })]);

    await step("nothing is selected to begin with", async () => {
      assert.match(await t.page.locator("#edSelection").innerText(), /Nothing selected/i);
      assert.equal(await editedLines(t), 0);
    });

    const box = t.page.locator("#pageOverlay .ed-box").first();
    const original = await box.innerText();
    await box.click();

    await step("the panel offers the line as it stands", async () => {
      assert.equal(await t.page.locator("#textInput").inputValue(), original);
      assert.match(await t.page.locator("#edSelection").innerText(), /Original:/);
      assert.equal(
        await box.evaluate((node) => node.classList.contains("is-selected")),
        true,
        "the tapped line should be marked as the selection"
      );
    });

    await step("typing marks a preview before it is applied", async () => {
      await t.page.locator("#textInput").fill("REPLACED LINE");
      await t.page.waitForFunction(
        () => document.querySelector("#pageOverlay .ed-box.is-draft") !== null,
        null,
        { timeout: 5000 }
      );
      assert.equal(await editedLines(t), 0, "a preview is not an applied edit");
    });

    await t.page.locator("#applyBtn").click();
    await t.page.waitForFunction(
      () => document.querySelector("#pageOverlay .ed-box.is-edited") !== null,
      null,
      { timeout: 5000 }
    );
    assert.equal(
      await box.getAttribute("aria-label"),
      `Edited to: REPLACED LINE`,
      "a screen reader should hear the new words on the line"
    );
    await waitForStatus(t, /Applied on page 1\. 1 edit pending/, 10000);

    await step("Escape drops the selection without undoing the edit", async () => {
      await t.page.keyboard.press("Escape");
      assert.match(await t.page.locator("#edSelection").innerText(), /Nothing selected/i);
      assert.equal(await editedLines(t), 1, "Escape should not throw the edit away");
    });
  },
  EDIT
);

test(
  "saving with no edits says so instead of writing a pointless file",
  async (t) => {
    await openPdf(t, [makeNamedPdfFile("letter.pdf", { pages: 1 })]);
    await t.page.locator("#saveBtn").click();
    await waitForStatus(t, /No edits have been applied/i, 10000);
    assert.equal(await t.page.locator("#resultBar").isVisible(), false);
    assert.equal(await t.page.locator("#edConfirm").isVisible(), false, "no card should be raised");
  },
  EDIT
);

test(
  "an edit is written into a downloadable PDF, with a card to confirm it",
  async (t) => {
    await openPdf(t, [makeNamedPdfFile("letter.pdf", { pages: 2 })]);
    await editFirstLine(t, "SWIFTPDF WAS HERE");

    await step("the card states the count before anything is written", async () => {
      await t.page.locator("#saveBtn").click();
      await t.page.locator("#edConfirm").waitFor({ state: "visible" });
      const summary = await t.page.locator("#confirmSummary").innerText();
      assert.match(summary, /1 edit/);
      assert.match(summary, /1 page/);
    });

    await step("cancelling keeps the edit and writes nothing", async () => {
      await t.page.locator("#confirmCancel").click();
      await t.page.locator("#edConfirm").waitFor({ state: "hidden" });
      assert.equal(await t.page.locator("#resultBar").isVisible(), false);
      assert.equal(await editedLines(t), 1, "cancelling the card should not undo the edit");
    });

    await step("keeping changes writes the file", async () => {
      await t.page.locator("#saveBtn").click();
      await t.page.locator("#edConfirm").waitFor({ state: "visible" });
      await t.page.locator("#confirmKeep").click();
      await t.page.locator("#resultBar").waitFor({ state: "visible", timeout: 30000 });
    });

    const pages = await savedText(t);
    assert.equal(pages.length, 2, "the page count must not change");
    assert.match(pages[0], /SWIFTPDF WAS HERE/, "the replacement is not in the saved file");
    assert.equal(await t.page.locator(".result-text").innerText().then((s) => /ready|edited/i.test(s)), true);
  },
  EDIT
);

test(
  "edits can be undone one page at a time or thrown away entirely",
  async (t) => {
    await openPdf(t, [makeNamedPdfFile("letter.pdf", { pages: 2 })]);
    await editFirstLine(t, "FIRST PAGE EDIT");
    await t.page.keyboard.press("Escape");
    assert.equal(await editedLines(t), 1);

    await step("undo puts the line back as it was", async () => {
      await t.page.locator("#revertPageBtn").click();
      await t.page.waitForFunction(
        () => document.querySelectorAll("#pageOverlay .ed-box.is-edited").length === 0,
        null,
        { timeout: 5000 }
      );
      await waitForStatus(t, /Reverted 1 edit/, 10000);
    });

    await step("undoing a page with nothing on it says so", async () => {
      await t.page.locator("#revertPageBtn").click();
      assert.match(await statusText(t), /no applied edits/i);
    });

    await editFirstLine(t, "ANOTHER EDIT");
    await step("discarding asks first, then throws the edits away", async () => {
      await t.page.locator("#discardAllBtn").click();
      await t.page.locator("#edConfirm").waitFor({ state: "visible" });
      assert.match(await t.page.locator("#confirmSummary").innerText(), /1 edit/);
      await t.page.locator("#confirmDiscard").click();
      await t.page.locator("#edConfirm").waitFor({ state: "hidden" });
      await t.page.waitForFunction(
        () => document.querySelectorAll("#pageOverlay .ed-box.is-edited").length === 0,
        null,
        { timeout: 5000 }
      );
      assert.equal(await t.page.locator("#resultBar").isVisible(), false);
    });
  },
  EDIT
);

// A real defect, found while writing this suite: positionBoxes() rewrites a
// box's aria-label when a line has an edit but never puts the original label
// back, so after undoing an edit the line is still announced as "Edited to: …".
// The visible marker (is-edited) is correct; only the spoken label is stale.
// Reported to the owner, not fixed here (see tests/README.md).
test(
  "an undone line stops being announced as edited",
  async (t) => {
    await openPdf(t, [makeNamedPdfFile("letter.pdf", { pages: 1 })]);
    const original = await t.page.locator("#pageOverlay .ed-box").first().getAttribute("aria-label");
    await editFirstLine(t, "GOING AWAY");
    assert.match(
      await t.page.locator("#pageOverlay .ed-box").first().getAttribute("aria-label"),
      /Edited to: GOING AWAY/
    );

    await t.page.locator("#revertPageBtn").click();
    await t.page.waitForFunction(
      () => document.querySelectorAll("#pageOverlay .ed-box.is-edited").length === 0,
      null,
      { timeout: 5000 }
    );
    assert.equal(
      await t.page.locator("#pageOverlay .ed-box").first().getAttribute("aria-label"),
      original,
      "the line is announced as edited after the edit was undone"
    );
  },
  { ...EDIT }
);

test(
  "a scanned page with no text layer is explained, not silently ignored",
  async (t) => {
    await addFiles(t, "#fileInput", [
      { name: "scan.pdf", mimeType: "application/pdf", buffer: makePdf({ pages: 1, text: null }) },
    ]);
    await waitForStatus(t, /No selectable text/i, 20000);

    const message = await statusText(t);
    assert.match(message, /scan/i, "the scan should be named");
    assert.match(message, /OCR/i, "the message should say what to do about it");
    assert.equal(await t.page.locator("#editorShell").isVisible(), false, "there is nothing to edit");
    assert.equal(await t.page.locator("#dropzone").isVisible(), true, "the user must be able to try another file");
    assert.equal(await t.page.locator("#choosePdfBtn").isEnabled(), true);
  },
  EDIT
);

test(
  "a file that cannot be opened leaves the page ready for another try",
  async (t) => {
    await addFiles(t, "#fileInput", [makeBrokenPdfFile("broken.pdf")]);
    await waitForStatus(t, /could not|valid PDF|error/i, 20000);

    assert.doesNotMatch(await statusText(t), /InvalidPDFException|at Object\./, "a parser error leaked out");
    assert.equal(await t.page.locator("#editorShell").isVisible(), false);
    assert.equal(await t.page.locator("#dropzone").isVisible(), true);
    assert.equal(await t.page.locator("#choosePdfBtn").isEnabled(), true, "the page stayed locked");
    assert.equal(
      await t.page.evaluate(() => document.getElementById("editorGrid").style.pointerEvents),
      "",
      "the editor stayed inert after a failure"
    );
    assert.equal(await t.page.locator("#status").getAttribute("aria-busy"), null, "the status still says it is working");
  },
  EDIT
);
