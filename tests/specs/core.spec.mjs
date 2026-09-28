// pdf-core.js helpers, exercised against a real page with the real file.
import { test, assert, step } from "../lib/harness.mjs";

const BLANK = { path: "/tests/fixtures/blank.html" };

test(
  "formatSize rounds at the KB and MB boundaries",
  async (t) => {
    const sizes = await t.page.evaluate(() =>
      [0, 1, 1023, 1024, 1536, 1048575, 1048576, 5 * 1048576 + 512 * 1024].map(formatSize)
    );
    assert.deepEqual(sizes, ["0 B", "1 B", "1023 B", "1 KB", "2 KB", "1024 KB", "1.0 MB", "5.5 MB"]);
  },
  BLANK
);

test(
  "setStatus keeps the live region polite and switches to assertive for errors",
  async (t) => {
    const read = () =>
      t.page.evaluate(() => {
        const el = document.getElementById("status");
        return {
          text: el.textContent,
          className: el.className,
          role: el.getAttribute("role"),
          live: el.getAttribute("aria-live"),
          atomic: el.getAttribute("aria-atomic"),
        };
      });

    await t.page.evaluate(() => setStatus("Merging…"));
    assert.deepEqual(await read(), {
      text: "Merging…",
      className: "status",
      role: "status",
      live: "polite",
      atomic: "true",
    });

    await step("an error interrupts rather than waits", async () => {
      await t.page.evaluate(() => setStatus("Could not read that file.", "error"));
      const state = await read();
      assert.equal(state.className, "status error");
      assert.equal(state.role, "alert");
      assert.equal(state.live, "assertive");
    });

    await step("clearing the message empties the region", async () => {
      await t.page.evaluate(() => setStatus(""));
      assert.equal((await read()).text, "");
    });
  },
  BLANK
);

test(
  "explainProcessingError turns library errors into advice a person can act on",
  async (t) => {
    const explain = (name, message, action, filename) =>
      t.page.evaluate(
        ([n, m, a, f]) => explainProcessingError(n ? Object.assign(new Error(m), { name: n }) : new Error(m), a, f),
        [name, message, action, filename]
      );

    const cases = [
      {
        what: "an open-password PDF names the file and admits the password cannot be guessed",
        run: () => explain("PasswordException", "No password given", "Merging these PDFs", "report.pdf"),
        expect: /report\.pdf.*correct open password/s,
      },
      {
        what: "a damaged PDF says so instead of showing a parser error",
        run: () => explain("InvalidPDFException", "Invalid PDF structure", "Merging these PDFs", "broken.pdf"),
        expect: /broken\.pdf.* could not be read as a valid PDF/s,
      },
      {
        what: "an out-of-memory failure suggests a smaller batch",
        run: () => explain("RangeError", "Array buffer allocation failed", "Merging these PDFs"),
        expect: /ran out of memory/,
      },
      {
        what: "a cancelled run is not reported as a failure of the file",
        run: () => explain("AbortError", "Rendering aborted", "Merging these PDFs"),
        expect: /Processing was interrupted/,
      },
      {
        what: "a missing CDN is described as a loading problem, not a bad file",
        run: () => explain("Error", "Failed to fetch dynamically imported module", "Merging these PDFs"),
        expect: /could not load/,
      },
      {
        what: "a tool's own short message survives",
        run: () => explain("Error", "This document is too large for one browser tab.", "Merging these PDFs"),
        expect: /^This document is too large/,
      },
      {
        what: "a raw JS error is hidden behind a friendly fallback",
        run: () => explain("TypeError", "Cannot read properties of undefined (reading 'x')", "Merging these PDFs"),
        expect: /could not finish/,
      },
      {
        what: "an empty error still produces advice",
        run: () => t.page.evaluate(() => explainProcessingError(null, "Merging these PDFs")),
        expect: /could not finish/,
      },
    ];

    for (const item of cases) {
      await step(item.what, async () => {
        const message = await item.run();
        assert.match(message, item.expect, `got: ${message}`);
        assert.doesNotMatch(message, /at Object\.|undefined is not/, `leaked internals: ${message}`);
        assert.ok(message.length > 20, "message is too terse to help");
      });
    }
  },
  BLANK
);

test(
  "dataUrlBytes decodes base64 back to the original bytes",
  async (t) => {
    const roundTrip = await t.page.evaluate(() => {
      const original = new Uint8Array([0, 1, 127, 128, 200, 255, 65, 66]);
      let binary = "";
      original.forEach((b) => (binary += String.fromCharCode(b)));
      const bytes = dataUrlBytes("data:application/octet-stream;base64," + btoa(binary));
      return Array.from(bytes);
    });
    assert.deepEqual(roundTrip, [0, 1, 127, 128, 200, 255, 65, 66]);
  },
  BLANK
);

test(
  "buildPdf writes a cross-reference table whose offsets point at real objects",
  async (t) => {
    const result = await t.page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#3366cc";
      ctx.fillRect(0, 0, 8, 8);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);

      const pages = [0, 1, 2].map((i) => ({ dataUrl, w: 8, h: 8, pageWidth: 300, pageHeight: 500, margin: 20 }));
      const bytes = buildPdf(pages);
      const text = new TextDecoder("latin1").decode(bytes);

      // Read the table back the way a reader would and check every entry.
      const startxref = Number(text.slice(text.lastIndexOf("startxref") + 9).trim().split(/\s/)[0]);
      const table = text.slice(startxref);
      const header = table.match(/^xref\n0 (\d+)\n/);
      const size = Number(header[1]);
      const entries = [];
      const lines = table.split("\n");
      for (let i = 2; i < 2 + size; i++) {
        const line = lines[i];
        if (!line || line.startsWith("trailer")) break;
        entries.push(line.trim());
      }
      const offsets = entries.slice(1).map((entry, index) => ({
        number: index + 1,
        declared: Number(entry.split(" ")[0]),
        atObject: text.slice(Number(entry.split(" ")[0]), Number(entry.split(" ")[0]) + 12).startsWith(`${index + 1} 0 obj`),
      }));

      return {
        length: bytes.length,
        header: text.slice(0, 8),
        endsWithEof: text.trimEnd().endsWith("%%EOF"),
        startxref,
        size,
        declaredSize: Number(text.match(/\/Size (\d+)/)[1]),
        count: Number(text.match(/\/Type \/Pages \/Count (\d+)/)[1]),
        mediaBoxes: Array.from(text.matchAll(/\/MediaBox \[ 0 0 ([\d.]+) ([\d.]+) \]/g)).map((m) => [m[1], m[2]]),
        imageWidths: Array.from(text.matchAll(/\/XObject \/Subtype \/Image \/Width (\d+)/g)).map((m) => Number(m[1])),
        offsets,
        xrefAtStartxref: text.slice(startxref, startxref + 4),
      };
    });

    await step("the file announces itself as a PDF", () => {
      assert.equal(result.header, "%PDF-1.4");
      assert.ok(result.endsWithEof, "no %%EOF marker");
    });

    await step("startxref lands on the table it claims", () => {
      assert.equal(result.xrefAtStartxref, "xref");
    });

    await step("every table entry addresses the object it claims", () => {
      assert.equal(result.offsets.length, result.size - 1);
      for (const entry of result.offsets) {
        assert.ok(entry.atObject, `object ${entry.number} is not at its recorded offset ${entry.declared}`);
      }
    });

    await step("the page tree and the trailer agree", () => {
      assert.equal(result.count, 3, "expected 3 pages");
      assert.equal(result.declaredSize, result.size);
    });

    await step("each page keeps the size and margin it was asked for", () => {
      assert.deepEqual(result.mediaBoxes, [
        ["300.00", "500.00"],
        ["300.00", "500.00"],
        ["300.00", "500.00"],
      ]);
      assert.deepEqual(result.imageWidths, [8, 8, 8]);
    });
  },
  BLANK
);

test(
  "buildPdf falls back to A4 and clamps a margin larger than the page",
  async (t) => {
    const result = await t.page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      const text = new TextDecoder("latin1").decode(
        buildPdf([
          { dataUrl, w: 4, h: 4 },
          { dataUrl, w: 4, h: 4, pageWidth: 100, pageHeight: 200, margin: 9999 },
        ])
      );
      return {
        mediaBoxes: Array.from(text.matchAll(/\/MediaBox \[ 0 0 ([\d.]+) ([\d.]+) \]/g)).map((m) => [m[1], m[2]]),
        // A negative placement would push the image off the page.
        placements: Array.from(text.matchAll(/q ([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g)).map((m) => [
          Number(m[1]),
          Number(m[2]),
          Number(m[3]),
          Number(m[4]),
        ]),
      };
    });

    assert.deepEqual(result.mediaBoxes[0], ["595.28", "841.89"], "default page should be A4");
    assert.deepEqual(result.mediaBoxes[1], ["100.00", "200.00"]);
    for (const [w, h, x, y] of result.placements) {
      assert.ok(w > 0 && h > 0, `image scaled to ${w}x${h}`);
      assert.ok(x >= 0 && y >= 0, `image placed at ${x},${y}`);
    }
  },
  BLANK
);

test(
  "a PDF built by buildPdf opens in a real reader",
  async (t) => {
    const result = await t.page.evaluate(async () => {
      await loadPdfLib();
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 30;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#cc3333";
      ctx.fillRect(0, 0, 40, 30);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      const bytes = buildPdf([
        { dataUrl, w: 40, h: 30, pageWidth: 300, pageHeight: 200 },
        { dataUrl, w: 40, h: 30, pageWidth: 300, pageHeight: 200 },
      ]);
      const doc = await window.PDFLib.PDFDocument.load(bytes);
      const pages = doc.getPages();
      return {
        count: pages.length,
        sizes: pages.map((p) => p.getSize()),
        firstBytes: Array.from(bytes.slice(0, 5)).map((c) => String.fromCharCode(c)).join(""),
      };
    });
    assert.equal(result.count, 2);
    assert.deepEqual(result.sizes, [
      { width: 300, height: 200 },
      { width: 300, height: 200 },
    ]);
    assert.equal(result.firstBytes, "%PDF-");
  },
  BLANK
);
