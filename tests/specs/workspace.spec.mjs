// The full-page "Edit files" workspace: the grid a person reorders in, which
// has to stay in step with the strip behind it and behave on touch and mouse.
import { test, assert, step } from "../lib/harness.mjs";
import { makePdfFile, makePng } from "../lib/fixtures.mjs";
import {
  addFiles,
  waitForThumbnails,
  touchDrag,
  touchHoldAt,
  touchEnd,
  mouseDrag,
  chipNames,
  cellNames,
  cellNumbers,
} from "../lib/browser.mjs";

const MERGE = { path: "/merge-pdf.html" };
const IMAGES = { path: "/image-to-pdf.html" };

const pdfs = (...names) => names.map((name) => makePdfFile(name));
const pngs = (...names) => names.map((name) => ({ name, mimeType: "image/png", buffer: makePng() }));

async function addPdfs(t, names, expected = names.length) {
  await addFiles(t, "#fileInput", pdfs(...names));
  await t.page.waitForFunction((n) => document.querySelectorAll(".file-strip .chip").length === n, expected);
}

async function openWorkspace(t) {
  await t.page.locator("#wsBtn").click();
  await t.page.locator("#workspaceOverlay").waitFor({ state: "visible" });
}

async function cellBoxes(page) {
  return page.locator("#wsGrid .ws-cell").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })
  );
}

// A grab point on a cell: the filename, clear of the number badge and the
// action buttons in the corner.
function cellGrabPoint(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height - 14 };
}

// A point in the top half of a cell, which is where a card has to land to take
// the position in front of it: dropping past the middle means "after".
function cellTopPoint(box) {
  return { x: box.x + box.width / 2, y: box.y + 12 };
}

test(
  "the workspace lists every file in order, numbered",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);
    await openWorkspace(t);

    assert.deepEqual(await cellNames(t), ["one.pdf", "two.pdf", "three.pdf"]);
    assert.deepEqual(await cellNumbers(t), ["1", "2", "3"]);
    assert.equal(await t.page.locator("#wsCount").innerText(), "3 files");
    assert.equal(await t.page.locator("#wsTitle").innerText(), "Edit files");
    assert.equal(await t.page.locator("#wsAddCard").count(), 1, "there must be a way to add more");
    assert.equal(await t.page.evaluate(() => document.body.style.overflow), "hidden", "the page behind should not scroll");

    await step("every cell names its file for a screen reader", async () => {
      const labels = await t.page.locator("#wsGrid .ws-cell .ws-filename").evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label"))
      );
      assert.deepEqual(labels, ["File: one.pdf", "File: two.pdf", "File: three.pdf"]);
    });
  },
  MERGE
);

test(
  "dragging a card with a finger reorders it and renumbers the grid",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf", "four.pdf"]);
    await waitForThumbnails(t.page);
    await openWorkspace(t);

    const boxes = await cellBoxes(t.page);
    await touchDrag(t, cellGrabPoint(boxes[0]), cellGrabPoint(boxes[2]));
    await t.page.waitForTimeout(200);

    assert.deepEqual(await cellNames(t), ["two.pdf", "three.pdf", "one.pdf", "four.pdf"]);
    assert.deepEqual(await cellNumbers(t), ["1", "2", "3", "4"], "the badges should follow the new order");
    assert.equal(await t.page.locator("#wsCount").innerText(), "4 files");

    await step("the strip behind the workspace is in the same order", async () => {
      await t.page.locator("#wsDoneBtn").click();
      await t.page.waitForFunction(() => document.getElementById("workspaceOverlay").hidden === true);
      assert.deepEqual(await chipNames(t), ["two.pdf", "three.pdf", "one.pdf", "four.pdf"]);
    });
  },
  MERGE
);

test(
  "the workspace reorders with a mouse too, not only with a finger",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);
    await openWorkspace(t);

    const boxes = await cellBoxes(t.page);
    await mouseDrag(t, cellGrabPoint(boxes[2]), cellTopPoint(boxes[0]));
    await t.page.waitForTimeout(200);

    assert.deepEqual(await cellNames(t), ["three.pdf", "one.pdf", "two.pdf"]);
  },
  MERGE
);

test(
  "a card that moves under the mouse does not also get clicked",
  async (t) => {
    // The drop is followed by a click on whatever is under the pointer. Left
    // alone that turns a reorder into a tap on the card it landed on.
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);
    await openWorkspace(t);

    await t.page.evaluate(() => {
      window.__clicks = 0;
      // Pointer capture during a drag retargets the mouse events to the card,
      // so the card is where a click lands either way.
      document.querySelectorAll("#wsGrid .ws-cell").forEach((cell) => {
        cell.addEventListener("click", () => window.__clicks++);
      });
    });

    const boxes = await cellBoxes(t.page);
    await step("a plain click still reaches the card", async () => {
      await t.page.locator("#wsGrid .ws-cell").first().click();
      assert.equal(await t.page.evaluate(() => window.__clicks), 1);
    });

    await step("a drag that ends over a card does not click it", async () => {
      await mouseDrag(t, cellGrabPoint(boxes[0]), cellGrabPoint(boxes[1]));
      await t.page.waitForTimeout(200);
      assert.equal(await t.page.evaluate(() => window.__clicks), 1, "the drop registered as a click");
    });
  },
  MERGE
);

test(
  "the workspace only wires its drag once, however often it is initialised",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);
    await openWorkspace(t);

    const wired = await t.page.evaluate(() => {
      initWorkspaceUI();
      initWorkspaceUI();
      return document.getElementById("wsGrid")._wsSortWired === true;
    });
    assert.equal(wired, true, "the grid should be marked as wired");

    const boxes = await cellBoxes(t.page);
    await touchDrag(t, cellGrabPoint(boxes[0]), cellGrabPoint(boxes[2]));
    await t.page.waitForTimeout(200);
    assert.deepEqual(
      await cellNames(t),
      ["two.pdf", "three.pdf", "one.pdf"],
      "a second listener would move the card twice"
    );
  },
  MERGE
);

test(
  "a crowded workspace scrolls under a drag held at its edge",
  async (t) => {
    // A short window is enough to make the grid taller than the workspace.
    await t.page.setViewportSize({ width: 1280, height: 420 });
    await addPdfs(t, Array.from({ length: 16 }, (_, i) => `file-${i + 1}.pdf`));
    await waitForThumbnails(t.page);
    await openWorkspace(t);

    const body = await t.page.evaluate(() => {
      const el = document.querySelector("#workspaceOverlay .ws-body");
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
    });
    assert.ok(body.scrollHeight > body.clientHeight, "the workspace should need scrolling here");

    const boxes = await cellBoxes(t.page);
    const bottomEdge = await t.page.evaluate(() => {
      const rect = document.querySelector("#workspaceOverlay .ws-body").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.bottom - 12 };
    });

    // The grid wraps and never scrolls itself, so the scroller to nudge is the
    // body around it, not the thing under the finger.
    await touchDrag(t, cellGrabPoint(boxes[0]), bottomEdge, { keepDown: true });
    await touchHoldAt(t, bottomEdge, 10);
    const scrolled = await t.page.evaluate(
      () => document.querySelector("#workspaceOverlay .ws-body").scrollTop
    );
    await touchEnd(t);

    assert.ok(scrolled > 0, `the workspace should have scrolled, scrollTop was ${scrolled}`);
    await step("and every file is still there exactly once", async () => {
      assert.equal((await cellNames(t)).length, 16);
    });
  },
  MERGE
);

test(
  "files added while the workspace is open show up straight away",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf"]);
    await waitForThumbnails(t.page);
    await openWorkspace(t);
    assert.deepEqual(await cellNames(t), ["one.pdf", "two.pdf"]);

    await addPdfs(t, ["three.pdf"], 3);
    assert.deepEqual(await cellNames(t), ["one.pdf", "two.pdf", "three.pdf"]);
    assert.equal(await t.page.locator("#wsCount").innerText(), "3 files");

    await step("so does one dropped onto the workspace itself", async () => {
      await t.page.evaluate(() => {
        const overlay = document.getElementById("workspaceOverlay");
        const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array([37, 80, 68, 70])], "dropped.pdf", { type: "application/pdf" }));
        Object.defineProperty(drop, "dataTransfer", { value: transfer });
        overlay.dispatchEvent(drop);
      });
      await t.page.waitForFunction(() => document.querySelectorAll("#wsGrid .ws-cell").length === 4);
      assert.deepEqual(await cellNames(t), ["one.pdf", "two.pdf", "three.pdf", "dropped.pdf"]);
    });
  },
  MERGE
);

test(
  "Escape and the backdrop both close the workspace and keep the order",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);
    await openWorkspace(t);

    const boxes = await cellBoxes(t.page);
    await touchDrag(t, cellGrabPoint(boxes[0]), cellGrabPoint(boxes[1]));
    await t.page.waitForTimeout(150);

    await t.page.keyboard.press("Escape");
    await t.page.waitForFunction(() => document.getElementById("workspaceOverlay").hidden === true);
    assert.equal(await t.page.evaluate(() => document.body.style.overflow), "", "the page should scroll again");

    await step("the backdrop is a second way out", async () => {
      await openWorkspace(t);
      const box = await t.page.locator("#workspaceOverlay").boundingBox();
      await t.page.mouse.click(box.x + 6, box.y + 6);
      await t.page.waitForFunction(() => document.getElementById("workspaceOverlay").hidden === true);
    });

    assert.deepEqual(await chipNames(t), ["two.pdf", "one.pdf", "three.pdf"]);
  },
  MERGE
);

test(
  "the image workspace counts images, deletes one, and rotates another",
  async (t) => {
    await addFiles(t, "#fileInput", pngs("shot1.png", "shot2.png", "shot3.png"));
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 3);
    await openWorkspace(t);

    assert.equal(await t.page.locator("#wsCount").innerText(), "3 images");
    assert.equal(await t.page.locator("#wsTitle").innerText(), "Edit images");

    await step("every card offers crop, rotate and delete", async () => {
      const actions = await t.page.locator("#wsGrid .ws-cell").first().locator(".ws-actions button").evaluateAll((nodes) =>
        nodes.map((node) => node.dataset.act)
      );
      assert.deepEqual(actions, ["crop", "rotate", "delete"]);
      const labels = await t.page.locator("#wsGrid .ws-cell").first().locator(".ws-actions button").evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label"))
      );
      assert.deepEqual(labels, ["Crop image 1", "Rotate image 1", "Remove image 1"]);
    });

    await step("rotating replaces the file with a turned copy", async () => {
      await t.page.locator('#wsGrid .ws-cell:nth-of-type(1) [data-act="rotate"]').click();
      await t.page.waitForFunction(() => document.querySelector(".ws-filename").textContent === "shot1-rotated.jpg");
      assert.equal(await t.page.locator("#wsGrid .ws-cell").nth(0).locator(".ws-num").innerText(), "1");
    });

    await step("deleting takes the file out of both places", async () => {
      await t.page.locator('#wsGrid .ws-cell:nth-of-type(1) [data-act="delete"]').click();
      await t.page.waitForFunction(() => document.querySelectorAll("#wsGrid .ws-cell").length === 2);
      await t.page.locator("#wsDoneBtn").click();
      await t.page.waitForFunction(() => document.getElementById("workspaceOverlay").hidden === true);
      assert.deepEqual(await chipNames(t), ["shot2.png", "shot3.png"]);
      assert.equal(await t.page.locator("#imagePageCount").innerText(), "2 images · 2 PDF pages");
    });
  },
  IMAGES
);
