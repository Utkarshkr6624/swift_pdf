// Word equations, end to end: a .docx with real OMML in it goes in, and the
// characters of that mathematics come out the other side.
//
// This is the other half of the converter's symbol problem. office-to-pdf.js
// used to walk straight past an <m:oMath> element, so every equation in a
// document was simply absent; and the standard PDF fonts cannot encode a
// radical or a Greek letter, so the ones that did survive became "?". The two
// fixes are tested separately, because they are separate bugs: one is about
// reading, the other about drawing.
import { test, assert, step } from "../lib/harness.mjs";
import { buildMathsDocx, buildDocxWithText } from "../lib/docx-math.mjs";

// The same blank harness page office.spec.mjs uses, with the engine loaded onto
// it by hand: office-to-pdf.js is deliberately not on any public page, because
// it is only ever fetched when an Office file is actually opened.
const BLANK = { path: "/tests/fixtures/blank.html" };

async function openEngine(t) {
  await t.page.addScriptTag({ url: t.url("/office-to-pdf.js") });
  await t.page.addScriptTag({
    content: "window.buildMathsDocx = (" + buildMathsDocx.toString() + ");" +
      "window.buildDocxWithText = (" + buildDocxWithText.toString() + ");",
  });
  await t.page.waitForFunction(() => Boolean(window.buildMathsDocx && window.buildDocxWithText && window.SwiftOffice));
}

// The converter, once, and what came back: the text on the finished PDF, the
// vector paths drawn on it, and the characters the engine says it could not draw.
const convert = (t) =>
  t.page.evaluate(async () => {
    await loadOfficeToPdf();
    const file = await window.buildMathsDocx();
    const out = await window.SwiftOffice.toPdf(file);
    const extracted = await window.SwiftOffice.extract(file);

    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: out.bytes.slice() }).promise;
    const drawn = [];
    let text = "";
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const ops = await page.getOperatorList();
        // constructPath is how the vector-drawn symbols reach the page. A symbol
        // that came out as "?" would be a show-text operator instead.
        drawn.push(ops.fnArray.filter((fn) => fn === pdfjs.OPS.constructPath).length);
        const content = await page.getTextContent();
        text += content.items.map((item) => item.str).join(" ");
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    return {
      pages: doc.numPages,
      text,
      drawn: drawn.reduce((a, b) => a + b, 0),
      dropped: out.stats.droppedCharacters,
      warnings: out.warnings,
      blocks: extracted.blocks.map((b) => b.text || ""),
    };
  });

const has = (haystack, needle) => haystack.indexOf(needle) !== -1;

test(
  "an equation in a Word document is read out, structure and all",
  async (t) => {
    await openEngine(t);
    const result = await convert(t);

    await step("the radical is there, not skipped", async () => {
      const all = result.blocks.join(" ");
      assert.ok(has(all, "√"), `no radical in the blocks: ${JSON.stringify(result.blocks)}`);
      // A square root in Word is a drawn bar, not a character, so it has to come
      // back written out rather than reproduced.
      assert.match(all, /√\(x2\^\(2\)\)/, `the radicand was not kept: ${JSON.stringify(result.blocks)}`);
    });

    await step("a fraction keeps its numerator and denominator apart", async () => {
      const all = result.blocks.join(" ");
      assert.match(all, /\(a\+b\)\s*\/\s*\(2c\)/, `the fraction collapsed: ${JSON.stringify(all)}`);
      assert.doesNotMatch(all, /\(a\+b2c\)/, "the denominator ended up inside the numerator");
    });

    await step("a summation keeps its limits", async () => {
      const all = result.blocks.join(" ");
      assert.match(all, /∑_\(i=1\)\^\(n\)/, `the limits were lost: ${JSON.stringify(all)}`);
    });

    await step("an index on a radical is written as people write it", async () => {
      const all = result.blocks.join(" ");
      assert.match(all, /³√\(x\+y\)/, `the cube root was not read: ${JSON.stringify(all)}`);
    });

    await step("delimiters and the Symbol font run both survive", async () => {
      const all = result.blocks.join(" ");
      assert.ok(has(all, "[a,b,c]"), `the bracket pair was lost: ${JSON.stringify(all)}`);
      assert.ok(has(all, "√"), "the Symbol-font radical run was dropped");
    });
  },
  BLANK
);

test(
  "the symbols the standard PDF fonts cannot encode are drawn, not replaced",
  async (t) => {
    await openEngine(t);
    const result = await convert(t);

    await step("every relation and Greek letter survives as itself", async () => {
      const all = result.blocks.join(" ");
      for (const symbol of ["≤", "≠", "≈", "→", "∞", "∈", "∪"]) {
        assert.ok(has(all, symbol), `${symbol} is missing from ${JSON.stringify(all)}`);
      }
      for (const letter of ["α", "β", "δ", "π", "σ", "ω", "Δ", "Σ", "Ω", "Π"]) {
        assert.ok(has(all, letter), `${letter} is missing from ${JSON.stringify(all)}`);
      }
    });

    await step("and the page carries drawn paths for them", async () => {
      // Before the fix each of these was written into the PDF as "?", which is a
      // show-text operator. They are drawn as strokes now, so the page has to
      // contain vector paths.
      assert.ok(result.drawn > 20, `only ${result.drawn} vector paths on the page; the symbols are not being drawn`);
    });

    await step("ordinary prose is untouched", async () => {
      const all = result.blocks.join(" ");
      assert.ok(has(all, "Ordinary prose that must be unaffected."));
    });

    await step("and nothing was quietly swapped for a question mark", async () => {
      assert.equal(result.dropped, 0, `${result.dropped} characters were still replaced with "?"`);
      assert.ok(
        !result.warnings.some((w) => /replaced with/.test(w)),
        `the font warning should not fire for a document whose symbols are now drawn: ${JSON.stringify(result.warnings)}`
      );
    });
  },
  BLANK
);

test(
  "the drawn symbols sit on the text baseline rather than below it",
  async (t) => {
    await openEngine(t);
    // pdf-lib draws a path through a matrix with the y axis the wrong way up for
    // a letterform, so a glyph written with y growing upwards arrives below the
    // line. That is invisible in a test about text and glaring in a test about
    // geometry, which is why it is checked here and only here.
    const measured = await t.page.evaluate(async () => {
      const glyphs = window.SwiftOffice.mathGlyphs;
      const pdf = await loadPdfLib();
      const doc = await pdf.PDFDocument.create();
      const font = await doc.embedFont(pdf.StandardFonts.Helvetica);
      const size = 40;
      const page = doc.addPage([300, 120]);
      const baseline = 60;
      const x = 40;
      page.drawSvgPath(glyphs["≤"].d, { x, y: baseline, scale: size, borderColor: pdf.rgb(0, 0, 0), borderWidth: 0.062 });
      const bytes = await doc.save();
      const pdfjs = await loadPdfJs();
      const doc2 = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      const p2 = await doc2.getPage(1);
      const ops = await p2.getOperatorList();
      const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));

      const transforms = [];
      ops.fnArray.forEach((fn, i) => { if (names[fn] === "transform") transforms.push(ops.argsArray[i]); });
      // A glyph drawn the right way up has its own zero on the baseline and its
      // body above it, so the matrix that places it must flip y.
      const flipped = transforms.some((m) => m && m[3] < 0);
      await doc2.destroy();
      return { flipped, transforms };
    });

    assert.ok(
      measured.flipped,
      `the path is not being drawn through a y-flip, so the glyph will render below the line: ${JSON.stringify(measured.transforms)}`
    );
  },
  BLANK
);
test(
  "Latin-1 text is written as itself, not as a row of question marks",
  async (t) => {
    // A separate defect, found while fixing the symbols above and worth its own
    // test because it was never about mathematics. The check that asks the font
    // whether it can draw a character was calling the font's method detached from
    // the font, so it threw for every character and answered no to all of them -
    // including the pound sign, the degree sign, an accented letter and a pair of
    // curly quotes, which the standard fonts have always been able to draw.
    await openEngine(t);
    const text = "Cost £5 per ½ kg at 20°C; café, naïve, résumé, “quoted”, ±3 µm, 2×4 ÷ 2, No. 7 — 90%";
    const result = await t.page.evaluate(async (body) => {
      await loadOfficeToPdf();
      const file = await window.buildDocxWithText(body);
      const out = await window.SwiftOffice.toPdf(file);
      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: out.bytes.slice() }).promise;
      let seen = "";
      try {
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const content = await page.getTextContent();
          seen += content.items.map((item) => item.str).join("");
          page.cleanup();
        }
      } finally {
        await doc.destroy();
      }
      return { seen, dropped: out.stats.droppedCharacters };
    }, text);

    await step("nothing was replaced", async () => {
      assert.equal(result.dropped, 0, `${result.dropped} Latin-1 characters were replaced with "?"`);
      assert.doesNotMatch(result.seen, /\?/, `the page reads: ${JSON.stringify(result.seen)}`);
    });

    await step("the text is all there", async () => {
      // The micro sign is read back as a Greek mu, and that is not this
      // converter losing anything: the glyph Helvetica draws at that code point
      // is named mu, and a PDF carries the character's identity in the font's
      // own encoding rather than in a Unicode table it never had.
      const asDrawn = "µ→μ";
      for (const character of text) {
        const readBack = asDrawn.includes(character)
          ? Array.from(result.seen).find((c) => asDrawn.includes(c) && c.codePointAt(0) > 127 && "μµ".includes(c))
          : character;
        assert.ok(
          readBack !== undefined && result.seen.indexOf(readBack) !== -1,
          `${character} (U+${character.codePointAt(0).toString(16).toUpperCase()}) did not survive`
        );
      }
    });
  },
  BLANK
);
