// The other half of the converter's symbol problem, in word-to-pdf.js.
//
// A formula in a PDF is not one run of text. It is a crowd of small runs — often
// one per glyph — because an equation is drawn with several embedded subset
// fonts, and a reader sees each of them as a separate item. The extractor used
// to join those items with a space every time, which turned "(x2+y2)=(a+b)/2c"
// into "( x2 + y2 ) = ( a + b ) / 2c": readable, but not what the page said, and
// no longer an expression.
//
// These tests hand structureForPage() the item shape pdf.js actually produces
// and read back what it made of it. The page is the real one, so the functions
// under test are the ones the site runs.
import { test, assert, step } from "../lib/harness.mjs";

const PAGE = { path: "/word-to-pdf.html" };

// Lays a string out as separate runs at given gaps, the way a PDF does, and
// reports what structureForPage() read back. `gaps` are the spaces between
// successive pieces, in points; a gap of 0 means the two runs are touching.
async function readBack(t, pieces, gaps, { size = 11, fontSize = 5 } = {}) {
  return t.page.evaluate(
    ({ pieces, gaps, size, fontSize }) => {
      const items = [];
      let x = 60;
      const y = 700;
      for (let i = 0; i < pieces.length; i++) {
        const text = pieces[i];
        // Roughly how wide a run is: enough for the gap logic to be meaningful.
        const width = text.length * fontSize * 0.5;
        items.push({
          str: text,
          transform: [1, 0, 0, 1, x, y],
          width,
          height: size,
        });
        x += width + (gaps[i] || 0);
      }
      const read = structureForPage(items);
      return {
        blocks: read.blocks.map((b) => b.text || b.rows || ""),
        text: read.blocks.map((b) => b.text || "").join("\n"),
      };
    },
    { pieces, gaps, size, fontSize }
  );
}

test(
  "an expression drawn as many small runs does not come back space-per-glyph",
  async (t) => {
    await step("glyphs that touch stay joined", async () => {
      // Every piece sits hard against the one before it: one formula, no spaces.
      const pieces = ["√", "(", "x", "2", "+", "y", "2", ")", "=", "(", "a", "+", "b", ")", "/", "2", "c"];
      const gaps = pieces.map(() => 0);
      const read = await readBack(t, pieces, gaps);
      assert.equal(read.text, "√(x2+y2)=(a+b)/2c", `the expression was broken up: ${JSON.stringify(read.text)}`);
    });

    await step("a gap the page actually shows becomes one space", async () => {
      // "x = 1" with a real word space between the letters and the equals sign,
      // and one between the sign and the number.
      const pieces = ["x", "=", "1"];
      const gaps = [3, 3]; // about half a character of air at 11pt
      const read = await readBack(t, pieces, gaps);
      assert.equal(read.text, "x = 1", `the spacing was lost: ${JSON.stringify(read.text)}`);
    });

    await step("prose is unaffected", async () => {
      // Two words, then a second sentence on the same line.
      const pieces = ["Hello", "there", "world"];
      const gaps = [3, 3];
      const read = await readBack(t, pieces, gaps);
      assert.equal(read.text, "Hello there world", `prose changed: ${JSON.stringify(read.text)}`);
    });
  },
  PAGE
);

test(
  "a symbol that a font reports as a space is not mistaken for a word gap",
  async (t) => {
    // pdf.js reports a glyph it cannot map through the font's ToUnicode table as
    // a space. The extractor used to trim runs and throw away anything that came
    // back empty, so such a run either vanished or was read as a separator. A run
    // carrying real characters must survive regardless of what sits either side.
    const text = await t.page.evaluate(() => {
      const size = 11;
      const fontSize = 5;
      const pieces = ["a", "≤", "b", "≥", "c"];
      const items = [];
      let x = 60;
      for (const piece of pieces) {
        const width = piece.length * fontSize * 0.5;
        items.push({ str: piece, transform: [1, 0, 0, 1, x, 700], width, height: size });
        x += width;
      }
      // A stray whitespace-only run between the last two, as a broken font
      // produces.
      items.splice(3, 0, { str: "  ", transform: [1, 0, 0, 1, x, 700], width: 2, height: size });
      return structureForPage(items).blocks.map((b) => b.text || "").join("\n");
    });
    assert.equal(text, "a≤b≥c", `a relation sign was lost or spaced out: ${JSON.stringify(text)}`);
  },
  PAGE
);

test(
  "a table row still reads as columns, not as one long line",
  async (t) => {
    // The gap between two cells is far wider than a word space, which is the only
    // thing separating a table row from a sentence. The measured join has to keep
    // that distinction, or every sheet of numbers would reflow into prose.
    const text = await t.page.evaluate(() => {
      const rows = [
        ["Region", "Q1", "Q2"],
        ["North", "120", "145"],
        ["South", "98", "133"],
      ];
      const items = [];
      const y0 = 700;
      let y = y0;
      for (const row of rows) {
        let x = 60;
        for (const cell of row) {
          const width = cell.length * 5 * 0.5;
          items.push({ str: cell, transform: [1, 0, 0, 1, x, y], width, height: 11 });
          x += width + 40; // a wide gap: two columns, not two words
        }
        y -= 16;
      }
      const read = structureForPage(items);
      return { tables: read.tables, blocks: read.blocks.map((b) => b.type + ":" + (b.type === "table" ? JSON.stringify(b.rows) : b.text)) };
    });
    assert.equal(text.tables, 1, `the grid was not recognised: ${JSON.stringify(text.blocks)}`);
    assert.match(text.blocks[0], /North/, "the rows were not read into columns");
  },
  PAGE
);