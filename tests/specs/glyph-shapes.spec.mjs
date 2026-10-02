// The drawn glyph table, checked as ink rather than as path data.
//
// office-to-pdf.js draws the characters the standard PDF fonts cannot encode
// (a radical, a summation sign, a Greek capital) as stroked SVG paths. Every
// question that matters about such a glyph - is it heavy enough for the words
// beside it, does its bowl close, do its legs stand straight - is a question
// about the ink that lands on the page, so that is what is measured here: the
// paths are drawn into a real PDF at the body size with the weight the engine
// gives them, rasterised through pdf.js, and read back as pixels.
//
// Four things are held:
//   1. coverage - every Greek capital is in the table, and a variant with no
//      base is a hole that used to be a silent "?" in somebody's document;
//   2. weight - a drawn symbol is stroked as heavily as Helvetica's own stem,
//      which is what the surrounding text is set in;
//   3. shape - the glyphs that were redrawn keep the shape they were redrawn
//      for (a closed bowl, an S, three separate dots, straight legs, ink that
//      stays inside the advance);
//   4. the whole table, end to end, through a .docx of real OMML.
import { test, assert, step } from "../lib/harness.mjs";

// The blank harness page, with the engine loaded onto it by hand:
// office-to-pdf.js is deliberately not on any public page.
const BLANK = { path: "/tests/fixtures/blank.html" };

async function openEngine(t) {
  await t.page.addScriptTag({ url: t.url("/office-to-pdf.js") });
  await t.page.waitForFunction(() => Boolean(window.SwiftOffice));
}

// Drawn into a real PDF at the body's own size with the weight the engine gives
// each glyph, rasterised through pdf.js, and measured in pixels. Returns, per
// glyph: its ink box in em from the pen position, how many separate blobs of
// ink it is, the centre of mass of the ink in its top and bottom quarters (a
// glyph that leans one way at the top and the other at the bottom has an S
// between them), and for each requested height the runs of ink along that
// scanline - which is how a closed shape is told from an open one.
//
// Everything runs inside the page, so the returned numbers stay small.
function probeSource() {
  return async function (chars, defaultStroke, ys, asText, scale) {
    const glyphs = window.SwiftOffice.mathGlyphs;
    const pdfLib = await loadPdfLib();
    const pdfjs = await loadPdfJs();

    const SIZE = 11;
    const EM = SIZE * scale;
    const PER = Math.min(5, chars.length);
    const CELL_W = 30;
    const CELL_H = 28;
    const rows = Math.ceil(chars.length / PER);
    const PAGE_W = 10 + PER * CELL_W;
    const PAGE_H = 20 + rows * CELL_H;
    // the box of pixels a glyph's ink is measured in: 1.5 em across, which takes
    // the widest symbol and its overhang, and from 0.35 em below the baseline
    // to 1.05 em above it, which takes a descender and an ascender
    const BOX_X = Math.round(-0.2 * EM);
    const BOX_Y = Math.round(-1.05 * EM);
    const BOX_W = Math.round(1.5 * EM);
    const BOX_H = Math.round(1.4 * EM);

    const doc = await pdfLib.PDFDocument.create();
    const helv = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
    const page = doc.addPage([PAGE_W, PAGE_H]);

    const cells = chars.map((c, i) => {
      const col = i % PER;
      const row = (i / PER) | 0;
      const gx = 10 + col * CELL_W;
      const gy = PAGE_H - 10 - row * CELL_H - 10;
      if (asText.indexOf(c) !== -1) {
        page.drawText(c, { x: gx, y: gy, size: SIZE, font: helv, color: pdfLib.rgb(0, 0, 0) });
      } else {
        const g = glyphs[c];
        page.drawSvgPath(g.d, {
          x: gx, y: gy, scale: SIZE,
          borderColor: pdfLib.rgb(0, 0, 0),
          borderWidth: g.w === undefined ? defaultStroke : g.w,
        });
      }
      return { c, ox: Math.round(gx * scale), base: Math.round((PAGE_H - gy) * scale), text: asText.indexOf(c) !== -1 };
    });

    const bytes = await doc.save();
    const view = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const p = await view.getPage(1);
    const viewport = p.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    document.body.appendChild(canvas);
    await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const rgba = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    await view.destroy();
    canvas.remove();

    const out = [];
    for (const cell of cells) {
      // one bit per pixel of the cell: is the page black there
      const on = new Uint8Array(BOX_W * BOX_H);
      for (let y = 0; y < BOX_H; y++) {
        for (let x = 0; x < BOX_W; x++) {
          const px = cell.ox + BOX_X + x;
          const py = cell.base + BOX_Y + y;
          if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
          // the page is rendered on white, so darkness is the red channel
          on[y * BOX_W + x] = rgba[(py * canvas.width + px) * 4] < 140 ? 1 : 0;
        }
      }
      // every row and column of the cell, in em from the pen position
      const rowEm = (y) => (-BOX_Y - y) / EM;
      const colEm = (x) => (BOX_X + x) / EM;

      let l = Infinity, r = -Infinity, top = Infinity, bot = -Infinity;
      for (let y = 0; y < BOX_H; y++) {
        for (let x = 0; x < BOX_W; x++) {
          if (!on[y * BOX_W + x]) continue;
          if (x < l) l = x;
          if (x > r) r = x;
          if (y < top) top = y;
          if (y > bot) bot = y;
        }
      }
      if (!isFinite(l)) { out.push({ c: cell.c, empty: true }); continue; }

      // the runs of ink along a scanline a given number of em above the baseline
      const scan = (yEm) => {
        const y = Math.round(-BOX_Y - yEm * EM);
        const runs = [];
        let start = -1;
        for (let x = 0; x <= BOX_W; x++) {
          const v = x < BOX_W ? on[y * BOX_W + x] : 0;
          if (v && start === -1) start = x;
          if (!v && start !== -1) { runs.push({ from: colEm(start), to: colEm(x) }); start = -1; }
        }
        return runs;
      };
      // the centre of mass of the ink in the top terminal's band (or the bottom
      // one's), in em - the two are what separates an S from a bracket
      const com = (above) => {
        let sum = 0, n = 0;
        for (let y = 0; y < BOX_H; y++) {
          if (above ? rowEm(y) <= 0.62 : rowEm(y) > 0.08) continue;
          for (let x = 0; x < BOX_W; x++) {
            if (!on[y * BOX_W + x]) continue;
            sum += colEm(x);
            n++;
          }
        }
        return n ? sum / n : null;
      };
      // blobs of ink joined up and down, four-connected: a dotted glyph has
      // three, a continuous one has one
      const seen = new Uint8Array(BOX_W * BOX_H);
      const queue = new Int32Array(BOX_W * BOX_H);
      const blobs = [];
      for (let start = 0; start < on.length; start++) {
        if (!on[start] || seen[start]) continue;
        let head = 0, tail = 0, bl = Infinity, br = -Infinity, area = 0;
        queue[tail++] = start;
        seen[start] = 1;
        while (head < tail) {
          const at = queue[head++];
          const y = (at / BOX_W) | 0;
          const x = at % BOX_W;
          area++;
          if (x < bl) bl = x;
          if (x > br) br = x;
          const next = [at - 1, at + 1, at - BOX_W, at + BOX_W];
          for (let k = 0; k < 4; k++) {
            const nb = next[k];
            if (nb < 0 || nb >= on.length || seen[nb] || !on[nb]) continue;
            if (k < 2 && Math.abs((nb % BOX_W) - x) !== 1) continue;
            seen[nb] = 1;
            queue[tail++] = nb;
          }
        }
        blobs.push({ from: colEm(bl), to: colEm(br + 1), area });
      }

      const g = cell.text ? null : glyphs[cell.c];
      out.push({
        c: cell.c,
        a: g ? g.a : null,
        w: g ? (g.w === undefined ? defaultStroke : g.w) : null,
        l: colEm(l), r: colEm(r + 1), t: rowEm(top), b: rowEm(bot + 1),
        comTop: com(true), comBot: com(false),
        blobs,
        scan: ys.map(scan),
      });
    }
    return out;
  };
}

async function installProbe(t) {
  await t.page.addScriptTag({ content: "window.__probe = (" + probeSource().toString() + ");" });
}

// `defaultStroke` is the weight a glyph with no weight of its own is stroked
// at; the test that pins it does so by measuring, and this one only has to draw
// with whatever the engine's own default is, so it is passed in.
const probe = (t, chars, ys, defaultStroke = 0.085, asText = [], scale = 12) =>
  t.page.evaluate(([c, d, y, txt, s]) => window.__probe(c, d, y, txt, s), [chars, defaultStroke, ys, asText, scale]);

const round = (n) => Math.round(n * 1000) / 1000;

test(
  "every Greek capital in the table is drawn, and a variant with no base is not a silent gap",
  async (t) => {
    await openEngine(t);

    await step("the two capitals that were missing are there", async () => {
      const found = await t.page.evaluate(() => {
        const glyphs = window.SwiftOffice.mathGlyphs;
        const describe = (c) => {
          const g = glyphs[c];
          return g ? { a: g.a, w: g.w === undefined ? null : g.w, d: g.d.length } : null;
        };
        return { upsilon: describe("Υ"), omicron: describe("Ο"), rho: describe("Ρ") };
      });
      assert.ok(found.upsilon, "Υ (U+03A5) is not in the table, so ϒ aliases to nothing");
      assert.ok(found.omicron, "Ο (U+039F) is not in the table");
      assert.ok(found.rho, "Ρ is not in the table");
      assert.ok(found.upsilon.d > 0 && found.omicron.d > 0, "a capital with an empty path");
    });

    await step("every variant is drawn, and drawn with the glyph it varies", async () => {
      // The alias map used to skip a variant whose base was missing, silently:
      // the character then fell through to "?" in a real document. The engine
      // now refuses to load in that case, and this is the other half of it.
      const variants = ["∆", "ϕ", "ϑ", "ϱ", "ϖ", "ϵ", "ϝ", "ϒ", "Ϲ", "Ϻ", "Ϝ", "ϛ"];
      const drawn = await t.page.evaluate((names) => {
        const glyphs = window.SwiftOffice.mathGlyphs;
        return names.map((variant) => {
          const g = glyphs[variant];
          if (!g) return { variant, present: false, twin: null };
          // the base is the only other character drawing this very path
          for (const [c, other] of Object.entries(glyphs)) {
            if (c !== variant && other.d === g.d && other.a === g.a) return { variant, present: true, twin: c };
          }
          return { variant, present: true, twin: null };
        });
      }, variants);

      for (const row of drawn) {
        const code = "U+" + row.variant.codePointAt(0).toString(16).toUpperCase();
        assert.ok(row.present, `${row.variant} (${code}) is not drawn`);
        assert.ok(row.twin, `${row.variant} (${code}) is drawn with a shape no other glyph shares`);
      }
      assert.equal(drawn.find((r) => r.variant === "ϒ").twin, "Υ", "ϒ is no longer drawn with Υ");
    });

    await step("and the engine still loaded, so the loud guard is not firing", async () => {
      assert.equal(t.pageErrors.length, 0, `loading the engine logged: ${JSON.stringify(t.pageErrors)}`);
    });
  },
  BLANK
);

test(
  "a drawn symbol is stroked as heavily as the words beside it",
  async (t) => {
    await openEngine(t);
    await installProbe(t);

    // Helvetica's own "I" is the weight the words around a symbol are set in,
    // so it is the reference: a drawn stem thinner than this reads as pale.
    // Ι carries the heavier weight, ι the default one.
    const ink = await probe(t, ["I", "Ι", "ι"], [0.4], 0.085, ["I"], 24);
    const stem = (c) => {
      const row = ink.find((r) => r.c === c);
      assert.ok(row && !row.empty, `${c} drew nothing at 11pt`);
      const runs = row.scan[0];
      assert.equal(runs.length, 1, `${c} did not draw one vertical stem on the scanline: ${JSON.stringify(runs)}`);
      return round(runs[0].to - runs[0].from);
    };

    await step("the reference stem is a stem", async () => {
      const reference = stem("I");
      assert.ok(reference > 0.07 && reference < 0.12, `the measured Helvetica stem is ${reference} em, which is not a stem`);
    });

    await step("both drawn weights land on it", async () => {
      const reference = stem("I");
      for (const c of ["Ι", "ι"]) {
        const measured = stem(c);
        assert.ok(
          Math.abs(measured - reference) <= reference * 0.2,
          `${c} is stroked at ${measured} em against a text stem of ${reference} em; it should not be paler than the words beside it`
        );
      }
      // and neither is back to the hairline the table used to be drawn at
      assert.ok(stem("ι") > 0.07, `the default weight measures ${stem("ι")} em, which is the old hairline`);
    });
  },
  BLANK
);

test(
  "the redrawn symbols keep the shape they were redrawn for",
  async (t) => {
    await openEngine(t);
    await installProbe(t);

    const chars = ["∂", "∫", "∬", "∞", "∴", "∵", "∏", "∐", "≫", "≪", "Υ", "Ο", "Ρ", "Β", "Θ"];
    // the scanlines, in em above the baseline: near the baseline, through the
    // pair of dots therefore puts on the bottom line, through the flank of a
    // bowl, high on a leg, and through the pair because puts on the top line
    const ys = [0.1, 0.24, 0.4, 0.55, 0.58];
    const ink = await probe(t, chars, ys);
    const at = (c) => {
      const row = ink.find((r) => r.c === c);
      assert.ok(row && !row.empty, `${c} drew no ink at all`);
      return row;
    };

    await step("the bowl of a partial derivative closes", async () => {
      // A scanline through the flank of a closed bowl meets its left wall and
      // its right wall: two runs. The old shape left the right wall open above
      // the waist, so it met only one and the glyph read as "c".
      const row = at("∂");
      assert.equal(row.scan[2].length, 2, `the bowl of ∂ is not closed: ${JSON.stringify(row.scan[2])}`);
    });

    await step("an integral leans one way at the top and the other at the bottom", async () => {
      // The old shape was an arc: both terminals pointed the same way, so the
      // ink sat in the same place at the top and at the bottom and the glyph
      // read as a bracket.
      for (const c of ["∫", "∬"]) {
        const row = at(c);
        const lean = row.comTop - row.comBot;
        assert.ok(lean > 0.1, `${c} leans by ${round(lean)} em between its top hook and its bottom one; it reads as a bracket, not an integral`);
      }
    });

    await step("the three dots of therefore and because stay three dots", async () => {
      // therefore has its pair on the bottom line, because has it on the top
      for (const [c, pairAt] of [["∴", 1], ["∵", 4]]) {
        const row = at(c);
        assert.equal(row.blobs.length, 3, `${c} is ${row.blobs.length} blobs of ink, not three dots`);
        const runs = row.scan[pairAt];
        assert.equal(runs.length, 2, `${c} is not two separate marks along the line its pair sits on: ${JSON.stringify(runs)}`);
        const gap = runs[1].from - runs[0].to;
        assert.ok(gap > 0.008, `${c} has its pair ${round(gap)} em apart; they merge into a smear`);
        // and each mark is big enough to be a dot rather than a speck
        for (const blob of row.blobs) {
          assert.ok(blob.to - blob.from > 0.09, `${c} has a mark ${round(blob.to - blob.from)} em across; it is a speck, not a dot`);
        }
      }
    });

    await step("the legs of a product stand straight", async () => {
      for (const c of ["∏", "∐"]) {
        const row = at(c);
        const high = row.scan[3][0];
        const low = row.scan[0][0];
        assert.ok(high && low, `${c} did not draw a leg on both scanlines`);
        assert.ok(
          Math.abs(high.from - low.from) < 0.02,
          `the left leg of ${c} moves ${round(Math.abs(high.from - low.from))} em between the top and the bottom; it reads as a tapered Π`
        );
      }
    });

    await step("the double chevrons sit inside their advance, and match each other", async () => {
      const gt = at("≫");
      const lt = at("≪");
      for (const row of [gt, lt]) {
        assert.ok(row.r <= row.a - 0.005, `ink reaches ${round(row.r)} em inside an advance of ${row.a}; it will touch the next character`);
        assert.ok(row.l > -0.02, `${row.c} starts ${round(-row.l)} em before the pen`);
      }
      assert.ok(
        Math.abs((gt.r - gt.l) - (lt.r - lt.l)) < 0.02,
        `≫ and ≪ are not the same width: ${round(gt.r - gt.l)} against ${round(lt.r - lt.l)} em`
      );
    });

    await step("no ink runs past the advance of anything that was re-fitted", async () => {
      for (const c of ["Ρ", "Β", "Θ", "Ο", "Υ", "∂", "∞", "∫", "∬", "∏", "∐", "≫", "≪", "∴", "∵"]) {
        const row = at(c);
        assert.ok(row.r <= row.a - 0.005, `${c} puts ink at ${round(row.r)} em inside an advance of ${row.a}`);
      }
    });

    await step("the two capitals that were added are capital height", async () => {
      for (const c of ["Υ", "Ο"]) {
        const row = at(c);
        const height = row.t - row.b;
        assert.ok(height > 0.6 && height < 0.8, `${c} is ${round(height)} em tall, which is not capital height`);
      }
    });
  },
  BLANK
);

test(
  "a document with every drawn symbol in it converts without losing one",
  async (t) => {
    await openEngine(t);
    await t.page.addScriptTag({ content: "window.buildAllGlyphsDocx = " + buildAllGlyphsDocx.toString() + ";" });
    await t.page.waitForFunction(() => Boolean(window.buildAllGlyphsDocx));

    const result = await t.page.evaluate(async () => {
      await loadOfficeToPdf();
      const glyphs = window.SwiftOffice.mathGlyphs;
      const every = Object.keys(glyphs);
      const file = await window.buildAllGlyphsDocx(every);
      const out = await window.SwiftOffice.toPdf(file);
      const extracted = await window.SwiftOffice.extract(file);

      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: out.bytes.slice() }).promise;
      let paths = 0;
      try {
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const ops = await page.getOperatorList();
          // constructPath is how a drawn symbol reaches the page; a symbol that
          // came out as "?" would be a show-text operator instead
          paths += ops.fnArray.filter((fn) => fn === pdfjs.OPS.constructPath).length;
          page.cleanup();
        }
      } finally {
        await doc.destroy();
      }
      return {
        every,
        dropped: out.stats.droppedCharacters,
        paths,
        warnings: out.warnings,
        text: extracted.blocks.map((b) => b.text || "").join(" "),
      };
    });

    await step("nothing was replaced with a question mark", async () => {
      assert.equal(result.dropped, 0, `${result.dropped} characters were still replaced with "?"`);
      assert.ok(
        !result.warnings.some((w) => /replaced with/.test(w)),
        `the font warning fired: ${JSON.stringify(result.warnings)}`
      );
    });

    await step("every one of them was drawn rather than typed", async () => {
      assert.ok(
        result.paths >= result.every.length,
        `only ${result.paths} vector paths on the page for ${result.every.length} symbols`
      );
    });

    await step("and every one of them is in the text that came out", async () => {
      const missing = result.every.filter((c) => result.text.indexOf(c) === -1);
      assert.deepEqual(
        missing.map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()),
        [],
        "these did not survive the conversion"
      );
    });

    await step("the two capitals that were missing are in there, both of them", async () => {
      for (const c of ["Υ", "Ο", "ϒ"]) {
        assert.ok(result.text.indexOf(c) !== -1, `${c} (U+${c.codePointAt(0).toString(16).toUpperCase()}) did not come out of the document`);
      }
    });
  },
  BLANK
);

// A .docx with one <m:oMath> paragraph per character, built in the page out of
// the site's own JSZip loader. The point is that the file is the shape Word
// writes, so the converter's own reading of it is what is under test.
async function buildAllGlyphsDocx(chars) {
  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const body = chars.map((c) => `<w:p><m:oMath><m:r><m:t>${c}</m:t></m:r></m:oMath></w:p>`).join("");
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
         <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
         <Default Extension="xml" ContentType="application/xml"/>
         <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
       </Types>`
  );
  zip.folder("_rels").file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
         <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
       </Relationships>`
  );
  zip.folder("word").folder("_rels").file(
    "document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`
  );
  zip.folder("word").file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`
  );
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes], "glyphs.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}