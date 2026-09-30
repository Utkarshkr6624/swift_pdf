// The horizontal file strip: what a person picks, reorders and removes before
// any tool runs. Dragging here is real touch input, dispatched over CDP.
import { test, assert, step } from "../lib/harness.mjs";
import { makePdfFile, makeTextFile } from "../lib/fixtures.mjs";
import {
  addFiles,
  waitForThumbnails,
  chipBoxes,
  chipGrabPoint,
  touchDrag,
  touchHoldAt,
  touchStartAt,
  touchEnd,
  clickChipRemove,
  chipNames,
  waitForResultBar,
  statusText,
} from "../lib/browser.mjs";

const MERGE = { path: "/merge-pdf.html" };
const pdfs = (...names) => names.map((name) => makePdfFile(name));

// expected defaults to the files just added, which is only right for the first
// add in a test; pass it explicitly when topping up a strip that already has files.
async function addPdfs(t, names, expected = names.length) {
  await addFiles(t, "#fileInput", pdfs(...names));
  await t.page.waitForFunction((n) => document.querySelectorAll(".file-strip .chip").length === n, expected);
}

test(
  "picking PDFs shows a chip for each, with its name, size and first page",
  async (t) => {
    await step("the toolbar stays out of the way until there is something to do", async () => {
      assert.equal(await t.page.locator("#toolbar").isVisible(), false);
      assert.equal(await t.page.locator("#status").innerText(), "");
    });

    await addPdfs(t, ["alpha.pdf", "beta.pdf"]);

    assert.deepEqual(await chipNames(t), ["alpha.pdf", "beta.pdf"]);
    const sizes = await t.page.locator(".file-strip .chip .chip-size").allInnerTexts();
    for (const size of sizes) assert.match(size, /^\d+(\.\d+)? (B|KB|MB)$/, `odd size label: ${size}`);

    await step("each chip has a remove button with a spoken label", async () => {
      const label = await t.page.locator('.file-strip .chip .chip-x').first().getAttribute("aria-label");
      assert.equal(label, "Remove alpha.pdf");
    });

    await step("the toolbar appears once there is a file to merge", async () => {
      assert.equal(await t.page.locator("#toolbar").isVisible(), true);
    });

    await waitForThumbnails(t.page);
    const thumbs = await t.page.locator(".file-strip .chip img").count();
    assert.equal(thumbs, 2, "the first page of each PDF should be drawn on its chip");
  },
  MERGE
);

test(
  "a file the tool cannot use is refused out loud and changes nothing",
  async (t) => {
    await addFiles(t, "#fileInput", [makeTextFile("notes.txt")]);
    assert.equal(await t.page.locator(".file-strip .chip").count(), 0);
    assert.equal(await t.page.locator("#toolbar").isVisible(), false);
    const message = await statusText(t);
    assert.match(message, /skipped/i);
    assert.match(message, /PDF/i, "the message should say what is accepted");

    await step("a good file after a bad one still works", async () => {
      await addPdfs(t, ["good.pdf"]);
      assert.deepEqual(await chipNames(t), ["good.pdf"]);
    });
  },
  MERGE
);

test(
  "dragging a chip with a finger moves it and leaves it there",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);

    const before = await chipNames(t);
    const boxes = await chipBoxes(t.page);

    await touchDrag(t, chipGrabPoint(boxes[0]), { x: boxes[2].x + boxes[2].width - 8, y: boxes[2].y + boxes[2].height / 2 });
    await t.page.waitForTimeout(200);

    const after = await chipNames(t);
    assert.deepEqual(after, [before[1], before[2], before[0]], `expected the first chip to move to the end, got ${after}`);
    assert.equal(new Set(after).size, after.length, "a file was duplicated or lost");
  },
  MERGE
);

test(
  "a small wobble is a tap, not a drag",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);
    const before = await chipNames(t);
    const boxes = await chipBoxes(t.page);

    // Under the 6px threshold, so no reorder should be attempted.
    const start = chipGrabPoint(boxes[0]);
    await touchDrag(t, start, { x: start.x + 3, y: start.y }, { steps: 3 });
    await t.page.waitForTimeout(150);

    assert.deepEqual(await chipNames(t), before, "a 3px wobble should not reorder anything");
  },
  MERGE
);

test(
  "a drag that starts on a chip's own button is left to the button",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);
    const before = await chipNames(t);
    const boxes = await chipBoxes(t.page);

    // The remove button sits in the top-right corner of a chip.
    const onButton = { x: boxes[0].x + boxes[0].width - 12, y: boxes[0].y + 12 };
    await touchDrag(t, onButton, { x: boxes[2].x + 20, y: boxes[2].y + 20 });
    await t.page.waitForTimeout(200);

    assert.deepEqual(await chipNames(t), before, "the strip should not have started a drag from a button");
    assert.equal(await t.page.locator(".file-strip .chip").count(), 3, "the remove button should not have fired either");
  },
  MERGE
);

test(
  "holding a drag at the end of a crowded strip scrolls it along",
  async (t) => {
    await t.page.setViewportSize({ width: 460, height: 900 });
    await addPdfs(t, ["a1.pdf", "a2.pdf", "a3.pdf", "a4.pdf", "a5.pdf", "a6.pdf"]);
    await waitForThumbnails(t.page);

    const overflow = await t.page.evaluate(() => {
      const strip = document.querySelector(".file-strip");
      return { scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth, scrollLeft: strip.scrollLeft };
    });
    assert.ok(overflow.scrollWidth > overflow.clientWidth, "the strip should overflow at this width");
    assert.equal(overflow.scrollLeft, 0);

    const boxes = await chipBoxes(t.page);
    const rightEdge = await t.page.evaluate(() => {
      const rect = document.querySelector(".file-strip").getBoundingClientRect();
      return { x: rect.right - 10, y: rect.top + rect.height / 2 };
    });

    await touchDrag(t, chipGrabPoint(boxes[0]), { x: rightEdge.x, y: rightEdge.y }, { keepDown: true });
    await touchHoldAt(t, rightEdge, 10);
    const scrolled = await t.page.evaluate(() => document.querySelector(".file-strip").scrollLeft);
    await touchEnd(t);

    assert.ok(scrolled > 0, `the strip should have scrolled towards the drag, scrollLeft was ${scrolled}`);
  },
  MERGE
);

test(
  "a re-render during a drag ends the gesture without duplicating a file",
  async (t) => {
    // Thumbnails and new files both rebuild every chip. A drag that survives
    // that with the old node in hand would re-insert a stale copy and show the
    // same file twice.
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);
    const before = await chipNames(t);

    const boxes = await chipBoxes(t.page);
    const start = chipGrabPoint(boxes[0]);
    await touchStartAt(t, start);
    await touchHoldAt(t, { x: start.x + 20, y: start.y }, 2);

    // Something would rebuild the strip while the finger is still down. The
    // rebuild is now held back until the gesture ends, so the new chip cannot
    // appear underneath a finger that is still dragging.
    await addFiles(t, "#fileInput", pdfs("four.pdf"));

    await touchHoldAt(t, { x: start.x + 240, y: start.y }, 4);
    await touchEnd(t);
    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 4, null, { timeout: 6000 }).catch(() => {});
    await t.page.waitForTimeout(300);

    const chips = await chipNames(t);
    assert.equal(chips.length, 4, `expected 4 chips, got ${chips.length}`);
    assert.equal(new Set(chips).size, 4, `a file was duplicated: ${chips.join(", ")}`);
    assert.deepEqual(chips, [...before, "four.pdf"], "the interrupted drag should not have scrambled the order");
  },
  MERGE
);

test(
  "the chip menu moves and removes files without a drag",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf", "three.pdf"]);
    await waitForThumbnails(t.page);

    const openMenu = async (index) => {
      await t.page.locator(".file-strip .chip .chip-menu-btn").nth(index).click();
      await t.page.locator("body > .menu.open").waitFor({ state: "visible" });
      return t.page.locator("body > .menu.open");
    };

    await step("a chip's hover lift would trap the menu, so it moves to the page", async () => {
      const menu = await openMenu(2);
      assert.equal(await menu.evaluate((node) => node.parentElement.tagName), "BODY");
    });

    await step("the first and last chips cannot move past the ends", async () => {
      const first = await openMenu(0);
      assert.equal(await first.locator("button", { hasText: "Move earlier" }).isDisabled(), true);
      assert.equal(await first.locator("button", { hasText: "Move later" }).isDisabled(), false);
      await t.page.keyboard.press("Escape");
      await t.page.mouse.click(10, 10);
    });

    await step("Move earlier reorders and re-renders the menu buttons", async () => {
      const menu = await openMenu(2);
      await menu.locator("button", { hasText: "Move earlier" }).click();
      await t.page.waitForFunction(() => document.querySelectorAll(".chip .chip-name")[1].textContent === "three.pdf");
      assert.deepEqual(await chipNames(t), ["one.pdf", "three.pdf", "two.pdf"]);
      const firstMoveEarlier = await t.page
        .locator(".file-strip .chip .chip-menu-btn")
        .nth(0)
        .click()
        .then(() => t.page.locator("body > .menu.open").locator("button", { hasText: "Move earlier" }).isDisabled());
      assert.equal(firstMoveEarlier, true, "the menu should follow the file it belongs to");
      await t.page.mouse.click(10, 10);
    });

    await step("clicking away closes the menu", async () => {
      await openMenu(0);
      await t.page.mouse.click(10, 10);
      assert.equal(await t.page.locator("body > .menu.open").count(), 0);
    });

    await step("the remove button takes the file out", async () => {
      // The × only appears on hover, so this is the mouse route; a finger uses
      // the chip menu's Remove, checked below.
      await clickChipRemove(t, "three.pdf");
      await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 2);
      assert.deepEqual(await chipNames(t), ["one.pdf", "two.pdf"]);
    });

    await step("the menu's Remove is there for anyone who cannot hover", async () => {
      const menu = await openMenu(1);
      await menu.locator("button", { hasText: "Remove" }).click();
      await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
      assert.deepEqual(await chipNames(t), ["one.pdf"]);
    });
  },
  MERGE
);

test(
  "changing the files retires a result that no longer matches them",
  async (t) => {
    await addPdfs(t, ["one.pdf"]);
    await waitForThumbnails(t.page);
    await t.page.locator("#convertBtn").click();
    await waitForResultBar(t);
    assert.equal(await t.page.locator("#resultBar").isVisible(), true);

    await step("adding a file hides the result", async () => {
      await addPdfs(t, ["two.pdf"], 2);
      assert.equal(await t.page.locator("#resultBar").isVisible(), false);
    });

    await step("reordering the strip hides it again", async () => {
      await t.page.locator("#convertBtn").click();
      await waitForResultBar(t);
      assert.equal(await t.page.locator("#resultBar").isVisible(), true);
      await t.page.locator('.file-strip .chip .chip-menu-btn[aria-label="More options for two.pdf"]').click();
      await t.page.locator("body > .menu.open button", { hasText: "Move earlier" }).click();
      await t.page.waitForFunction(() => document.getElementById("resultBar").hidden === true);
      assert.equal(await t.page.locator("#resultBar").isVisible(), false);
    });
  },
  MERGE
);

test(
  "Clear all empties the strip, the status line and the result",
  async (t) => {
    await addPdfs(t, ["one.pdf", "two.pdf"]);
    await waitForThumbnails(t.page);
    await t.page.locator("#convertBtn").click();
    await waitForResultBar(t);

    await t.page.locator("#clearBtn").click();

    assert.equal(await t.page.locator(".file-strip .chip").count(), 0);
    assert.equal(await t.page.locator("#resultBar").isVisible(), false);
    assert.equal(await statusText(t), "", "a stale message would describe a result that is gone");
    assert.equal(await t.page.locator("#toolbar").isVisible(), false);
    assert.equal(await t.page.locator("#convertBtn").isEnabled(), true, "the page must be usable again");
  },
  MERGE
);

test(
  "the dropzone reacts to a drag and takes the files that land on it",
  async (t) => {
    const box = await t.page.locator("#dropzone").boundingBox();
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await t.page.evaluate(
      ([x, y]) => {
        const zone = document.getElementById("dropzone");
        const event = (type) => {
          const drag = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
          Object.defineProperty(drag, "dataTransfer", { value: new DataTransfer() });
          zone.dispatchEvent(drag);
        };
        event("dragenter");
        event("dragover");
      },
      [centre.x, centre.y]
    );
    assert.equal(await t.page.locator("#dropzone").evaluate((node) => node.classList.contains("dragover")), true);

    await t.page.evaluate(
      ([x, y]) => {
        const zone = document.getElementById("dropzone");
        const drag = new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y });
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array([37, 80, 68, 70])], "dropped.pdf", { type: "application/pdf" }));
        Object.defineProperty(drag, "dataTransfer", { value: transfer });
        zone.dispatchEvent(drag);
      },
      [centre.x, centre.y]
    );

    await t.page.waitForFunction(() => document.querySelectorAll(".file-strip .chip").length === 1);
    assert.deepEqual(await chipNames(t), ["dropped.pdf"]);
    assert.equal(await t.page.locator("#dropzone").evaluate((node) => node.classList.contains("dragover")), false);
  },
  MERGE
);

test(
  "the dropzone ignores clicks while the tool is busy",
  async (t) => {
    const clicked = await t.page.evaluate(() => {
      const input = document.getElementById("fileInput");
      let opened = 0;
      input.click = () => opened++;
      setToolBusy(true);
      document.getElementById("dropzone").click();
      const during = opened;
      setToolBusy(false);
      document.getElementById("dropzone").click();
      return { during, after: opened };
    });
    assert.equal(clicked.during, 0, "a busy tool must not open a second file picker");
    assert.equal(clicked.after, 1);
  },
  MERGE
);
