// setToolBusy() and the result bar: the shared state every tool page depends on
// while a file is being processed.
import { test, assert, step } from "../lib/harness.mjs";

const BLANK = { path: "/tests/fixtures/blank.html" };

const snapshot = (t) =>
  t.page.evaluate(() => ({
    buttons: {
      a: document.getElementById("toolBtnA").disabled,
      b: document.getElementById("toolBtnB").disabled,
      alreadyDisabled: document.getElementById("toolBtnDisabled").disabled,
    },
    fileInput: document.getElementById("fileInput").disabled,
    dropBtn: document.getElementById("dropBtn").disabled,
    stripPointerEvents: document.getElementById("stripWrap").style.pointerEvents,
    statusBusy: document.getElementById("status").getAttribute("aria-busy"),
    statusWorking: document.getElementById("status").classList.contains("working"),
    leftover: document.querySelectorAll("[data-was-disabled], [data-was-pointer-events]").length,
  }));

test(
  "setToolBusy locks the page and puts everything back exactly as it was",
  async (t) => {
    await step("the page starts usable", async () => {
      const before = await snapshot(t);
      assert.deepEqual(before.buttons, { a: false, b: false, alreadyDisabled: true });
      assert.equal(before.fileInput, false);
      assert.equal(before.statusBusy, null);
    });

    await step("an inline pointer-events value is remembered, not blanked", async () => {
      await t.page.evaluate(() => (document.getElementById("stripWrap").style.pointerEvents = "auto"));
      await t.page.evaluate(() => setToolBusy(true));
      assert.equal((await snapshot(t)).stripPointerEvents, "none");
    });

    const locked = await snapshot(t);
    assert.deepEqual(locked.buttons, { a: true, b: true, alreadyDisabled: true });
    assert.equal(locked.dropBtn, true, "the dropzone button should be locked too");
    assert.equal(locked.fileInput, true);
    assert.equal(locked.statusBusy, "true");
    assert.equal(locked.statusWorking, true, "the status line should show it is working");

    await t.page.evaluate(() => setToolBusy(false));
    const after = await snapshot(t);
    assert.deepEqual(after.buttons, { a: false, b: false, alreadyDisabled: true }, "a disabled button stayed disabled");
    assert.equal(after.fileInput, false);
    assert.equal(after.dropBtn, false);
    assert.equal(after.stripPointerEvents, "auto", "the previous inline value should come back");
    assert.equal(after.statusBusy, null);
    assert.equal(after.statusWorking, false);
    assert.equal(after.leftover, 0, "bookkeeping attributes were left behind");
  },
  BLANK
);

test(
  "overlapping operations hold the lock until the last one finishes",
  async (t) => {
    // Two files opening at once used to hand the page back with every control
    // still disabled, because the first release cleared the lock for both.
    await t.page.evaluate(() => {
      setToolBusy(true);
      setToolBusy(true);
      setToolBusy(false);
    });
    const midway = await snapshot(t);
    assert.equal(midway.buttons.a, true, "the lock was released while work was still running");
    assert.equal(midway.statusBusy, "true");

    await t.page.evaluate(() => setToolBusy(false));
    const done = await snapshot(t);
    assert.equal(done.buttons.a, false, "the page stayed locked after the last operation");
    assert.equal(done.buttons.b, false);
    assert.equal(done.fileInput, false);
    assert.equal(done.stripPointerEvents, "");
    assert.equal(done.statusBusy, null);
    assert.equal(done.leftover, 0);
  },
  BLANK
);

test(
  "releasing the lock without holding it is harmless",
  async (t) => {
    await t.page.evaluate(() => setToolBusy(false));
    await t.page.evaluate(() => setToolBusy(false));
    const state = await snapshot(t);
    assert.deepEqual(state.buttons, { a: false, b: false, alreadyDisabled: true });
    assert.equal(state.leftover, 0);
  },
  BLANK
);

// A real defect, found while writing this suite: setToolBusy() only snapshots a
// control's previous state on the 0 -> 1 edge, so a control that appears while a
// second operation is already in flight is disabled by that second call and never
// released. No page does this today, so the suite records it rather than failing
// the build. Reported to the owner, not fixed here (see tests/README.md).
test(
  "a control that appears between two overlapping operations is handed back",
  async (t) => {
    // The first busy() call snapshots what exists, but a control added while a
    // second operation is in flight is disabled by that second call. It has to
    // be released by the same call that disabled it, or the page is stuck with
    // a dead button and no way to retry.
    const leftDisabled = await t.page.evaluate(() => {
      const toolbar = document.getElementById("toolbar");
      setToolBusy(true);
      const late = document.createElement("button");
      late.id = "lateBtn";
      late.textContent = "appeared late";
      toolbar.appendChild(late);
      setToolBusy(true);
      setToolBusy(false);
      const wasDisabled = late.disabled;
      setToolBusy(false);
      return { wasDisabled, stillDisabled: late.disabled };
    });
    assert.equal(leftDisabled.wasDisabled, true, "the late control should have been locked");
    assert.equal(leftDisabled.stillDisabled, false, "the late control was never released");
  },
  { ...BLANK, knownBug: "setToolBusy leaves a control created between two overlapping calls disabled forever" }
);

test(
  "showResult hands back a download with the right name and announces itself",
  async (t) => {
    const shown = await t.page.evaluate(async () => {
      const blob = new Blob([new Uint8Array([37, 80, 68, 70])], { type: "application/pdf" });
      showResult(blob, "merged.pdf");
      const bar = document.getElementById("resultBar");
      return {
        url: bar._resultUrl,
        hidden: bar.hidden,
        role: bar.getAttribute("role"),
        label: bar.getAttribute("aria-label"),
        extension: bar.querySelector(".name-ext").textContent,
        status: document.getElementById("status").textContent,
        statusKind: document.getElementById("status").className,
        revealed: bar.classList.contains("revealed"),
        focused: document.activeElement === bar,
      };
    });
    assert.equal(shown.hidden, false);
    assert.equal(shown.role, "region");
    assert.equal(shown.label, "PDF result ready");
    assert.equal(shown.extension, ".pdf");
    assert.equal(shown.revealed, true);
    assert.equal(shown.focused, true, "the result should take focus so a screen reader lands on it");
    assert.match(shown.status, /ready/i);
    assert.match(shown.statusKind, /success/);
    assert.ok(shown.url.startsWith("blob:"), "the result should be a local blob URL");
  },
  BLANK
);

test(
  "the download name comes from the name field and always ends in the right extension",
  async (t) => {
    const downloadName = async (t, given, fallback) =>
      t.page.evaluate(
        ([value, base]) => {
          const input = document.getElementById("fileName");
          if (input) input.value = value;
          else {
            const el = document.createElement("input");
            el.id = "fileName";
            document.body.appendChild(el);
            el.value = value;
          }
          showResult(new Blob(["x"]), base, "pdf");
          let captured = null;
          const realClick = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function () {
            captured = this.download;
          };
          document.getElementById("downloadBtn").click();
          HTMLAnchorElement.prototype.click = realClick;
          return captured;
        },
        [given, fallback]
      );

    assert.equal(await downloadName(t, "report", "merged.pdf"), "report.pdf");
    assert.equal(await downloadName(t, "report.pdf", "merged.pdf"), "report.pdf", "must not double the extension");
    assert.equal(await downloadName(t, "  spaced  ", "merged.pdf"), "spaced.pdf");
    assert.equal(await downloadName(t, "", "merged.pdf"), "merged.pdf", "an empty name falls back to the default");
  },
  BLANK
);

test(
  "replacing a result frees the previous blob and hides on demand",
  async (t) => {
    const result = await t.page.evaluate(() => {
      const revoked = [];
      const realRevoke = URL.revokeObjectURL;
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        return realRevoke.call(URL, url);
      };
      showResult(new Blob(["a"]), "one.pdf");
      const first = document.getElementById("resultBar")._resultUrl;
      showResult(new Blob(["b"]), "two.pdf");
      const second = document.getElementById("resultBar")._resultUrl;
      hideResultBar();
      const afterHide = {
        hidden: document.getElementById("resultBar").hidden,
        kept: document.getElementById("resultBar")._resultUrl,
        revokedFirst: revoked.includes(first),
        revokedSecond: revoked.includes(second),
      };
      URL.revokeObjectURL = realRevoke;
      return afterHide;
    });
    assert.equal(result.hidden, true);
    assert.equal(result.kept, null, "a stale URL would keep the old file in memory");
    assert.equal(result.revokedFirst, true, "the replaced result was not released");
    assert.equal(result.revokedSecond, true);
  },
  BLANK
);

test(
  "a page with nowhere to show the result says so instead of failing silently",
  async (t) => {
    const message = await t.page.evaluate(() => {
      const bar = document.getElementById("resultBar");
      bar.remove();
      try {
        showResult(new Blob(["a"]), "x.pdf");
        return null;
      } catch (err) {
        return err.message;
      } finally {
        document.body.appendChild(bar);
      }
    });
    assert.match(String(message), /result area is missing/i);
  },
  BLANK
);
