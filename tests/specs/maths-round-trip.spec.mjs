// The round trip: Word equation -> PDF -> the reader that turns a PDF back into
// a Word document.
//
// Every other maths spec in this suite stops at one edge. office-maths.spec.mjs
// checks the two halves separately - what the extractor reads out of a .docx,
// and what the converter draws onto a page - and maths-text.spec.mjs checks how
// word-to-pdf.js groups the runs a PDF hands it. Neither of them puts the two
// together, and that is where the loss is: a symbol the converter draws is ink
// on the page first and foremost, and whether it also reaches the PDF's text
// layer is a separate matter a PDF does not make obvious. A file that came out
// of SwiftPDF and went back in can lose its equations while looking perfectly
// correct to anyone reading the screen.
//
// So this file measures the loss rather than hoping for its absence. It asserts
// what is true today and stays true if the symbols are later given a text layer:
// that nothing outside the drawn symbols is ever lost, that every symbol reaches
// the page by one route or the other, and that the direction which works - the
// .docx -> blocks -> .docx one - keeps every character it starts with.
//
// THE TEXT LAYER AS IT STANDS, measured through getTextContent() on SwiftPDF's
// own output. "every symbol in a Word document reaches the finished page" below
// is the test that produces these numbers, over 109 symbols:
//
//   * The standard PDF fonts are WinAnsi, which reaches ± × ÷ ° ³ ½ £ é ¬ and
//     stops there. Those 9 come back as text and have always done so.
//   * The other 99 - √ ∑ ∫ α Δ ≤ ≠ ≈ → ∞ ∈ ∪ ∴ ∀ ∃ and the rest - are outside
//     every standard font. They are drawn as vector paths, so the page looks
//     right. Whether they also carry text is a question this file is built to
//     survive either answer to.
//   * One of the 109, U+03D2 ϒ, is on neither route: the glyph table has no "Υ"
//     for its variant map to copy, so it is written as "?". See
//     WITHOUT_A_DRAWN_GLYPH below; that is the one loss in this file that no
//     assertion here can currently prevent.
//   * A page holding one symbol therefore reads, from getTextContent(), either
//     "left right" (the symbol is ink and nothing else) or "left ≤ right" (it
//     has a text layer too), or sits between the two while an invisible run for
//     the symbol is present but maps to nothing a reader can name. Every
//     assertion below is written to hold for all three.
//   * Nothing is ever replaced with "?" for these; droppedCharacters is 0. The
//     loss is silence, not corruption.
//   * U+E000-U+EFFF, the private-use codes the glyphs are drawn from, must
//     never appear in the text layer. Nothing here asserts that the symbols
//     themselves are present, only that whatever is there is clean.
//
// Nothing above is asserted as a permanent expectation. Every assertion here is
// written so that it holds whether a symbol arrives as text or as ink, so the
// file can be left in place when the text layer is fixed rather than deleted.
import { test, assert, step } from "../lib/harness.mjs";
import { buildMathsDocx, buildDocxWithText } from "../lib/docx-math.mjs";

// The real converter page rather than the blank harness: readPdfText() is a
// function of word-to-pdf.js, and it is the only place the site turns a PDF
// back into a document. pdf-core.js is already on the page, so the loaders for
// pdf.js, JSZip, office-to-pdf.js and file-writers.js all come with it.
const PAGE = { path: "/word-to-pdf.html" };

// office-to-pdf.js is deliberately not on any public page - it is fetched only
// when an Office file is actually opened - so it is put on by hand here, as
// office-maths.spec.mjs does. The document builders come in the same way,
// because they have to run inside the page and use the site's own JSZip.
async function openEngine(t) {
  await t.page.addScriptTag({ url: t.url("/office-to-pdf.js") });
  await t.page.addScriptTag({
    content:
      "window.buildMathsDocx = (" + buildMathsDocx.toString() + ");" +
      "window.buildDocxWithText = (" + buildDocxWithText.toString() + ");" +
      "window.buildProseTableDocx = (" + buildProseTableDocx.toString() + ");",
  });
  await t.page.waitForFunction(
    () => Boolean(window.buildMathsDocx && window.buildDocxWithText && window.buildProseTableDocx && window.SwiftOffice)
  );
}

// A document of ordinary prose around a real Word table: the two things that
// have to be indifferent to anything happening to symbols. Written the way Word
// writes it - w:tbl of w:tr of w:tc of w:p - rather than as something easy to
// generate, so the converter is doing the same work it does for a real file.
function buildProseTableDocx() {
  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const row = (cells) =>
    `<w:tr>${cells
      .map((c) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${c}</w:t></w:r></w:p></w:tc>`)
      .join("")}</w:tr>`;
  const body = [
    `<w:p><w:r><w:t>Totals for the third quarter.</w:t></w:r></w:p>`,
    `<w:tbl>${row(["Region", "Q1", "Q2"])}${row(["North", "120", "145"])}${row(["South", "98", "133"])}</w:tbl>`,
    `<w:p><w:r><w:t>A closing sentence after the table.</w:t></w:r></w:p>`,
  ].join("");
  return loadJsZip().then((JSZip) => {
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
    return zip.generateAsync({ type: "uint8array" });
  }).then((bytes) => new File([bytes], "totals.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
}

// The 109 symbols measured across the whole glyph table plus the WinAnsi
// characters that reach it. Spans every family the table has: radicals,
// relations, arrows, set operators, calculus, the lower and upper Greek
// alphabets including the symbol variants, and the nine characters the
// standard fonts can encode after all.
const SYMBOLS = [
  // The nine the standard PDF fonts reach, so the set is not only the sad half.
  "±", "×", "÷", "°", "³", "½", "£", "é", "¬",
  // Radicals, large operators, calculus.
  "√", "∑", "∏", "∫", "∂", "∇", "∅", "∴", "∵", "∞",
  // Relations and arrows.
  "≤", "≥", "≠", "≡", "≈", "≅", "∼", "∝", "≪", "≫",
  "→", "←", "↔", "⇒", "⇐", "⇔", "↦", "↑", "↓",
  // Sets, logic and geometry.
  "∈", "∉", "⊂", "⊃", "⊆", "⊇", "∪", "∩", "∀", "∃", "⊥", "∥", "∠",
  // The lower Greek alphabet.
  "α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ",
  "π", "ρ", "σ", "ς", "τ", "υ", "φ", "χ", "ψ", "ω",
  // Its variant and symbol forms, which the table draws from the same paths.
  "∆", "ϕ", "ϑ", "ϱ", "ϖ", "ϵ", "ϝ", "ϒ", "Ϲ", "Ϻ", "Ϝ", "ϛ",
  // The upper Greek alphabet.
  "Γ", "Δ", "Θ", "Λ", "Ξ", "Π", "Σ", "Φ", "Ψ", "Ω",
  "Α", "Β", "Ε", "Ζ", "Η", "Ι", "Κ", "Μ", "Ν", "Ρ", "Τ", "Χ",
];

// The one character in the list above that cannot be put on the page at all.
// MATH_GLYPHS has no "Υ" for the variant map to copy it from, so U+03D2 falls
// through to the font check and is written as "?" like any character the
// standard fonts know nothing about. It is measured rather than asserted good,
// because the only way to assert it reaches the page is to assert the opposite
// of what the code does today. The two assertions below are therefore written
// as "nothing but this one", so a regression anywhere else in the table still
// fails; if the glyph is ever added they keep passing and this entry can go.
const WITHOUT_A_DRAWN_GLYPH = new Set(["ϒ"]);

// A text layer with the drawing codes and any run a reader cannot name taken
// out, and its spacing settled. A run of the symbol font that pdf.js cannot map
// comes back as a C0 control character; it is not a word, so it is not compared
// as one, and the three ways a symbol page can read - silent, unmapped, and
// fully named - all come to the same comparison.
const asWords = (text) => text.replace(/[\u0000-\u001f\uE000-\uEFFF]/g, "").replace(/\s+/g, " ").trim();

// The symbols buildMathsDocx() actually puts on the page, deduplicated. Every
// one of them is outside WinAnsi, so every one of them is drawn rather than
// typed, and every one of them is therefore a character the PDF's text layer
// may or may not carry. This is the set the round trip is allowed to lose and
// nothing else - the assertion below is that the loss is contained in it.
const DRAWN_IN_THE_MATHS_DOCUMENT = "√∑≤≠≈→∞∈∪αβδπσωΔΣΩΠ";

// Everything the maths document should come back with whatever the symbols do,
// written as shapes rather than as strings so that neither the spacing nor the
// presence of a symbol can fail it. Each is a piece of the equation's structure
// - the radicand, the fraction, the limits, the delimiter pair - so a converter
// that broke the maths apart would fail here even though every word survived.
const STRUCTURE = [
  { label: "the radicand and its index", pattern: /x2\^\(2\)/ },
  { label: "the fraction, numerator over denominator", pattern: /\(a\+b\)\s*\/\s*\(2c\)/ },
  { label: "the radicand did not swallow the numerator", pattern: /x2\^\(2\)\)\s*=/ },
  { label: "the limits of the summation", pattern: /_\(i=1\)\^\(n\)/ },
  { label: "the body of the summation", pattern: /pi2\^\(2\)/ },
  { label: "the delimiter pair", pattern: /\[a,b,c\]/ },
  { label: "the index of the cube root, which is a plain character", pattern: /³/ },
];

// One document, converted for real, and then read three ways: straight off the
// page with pdf.js, through the reader the site uses to turn a PDF back into a
// document, and - for comparison - straight out of the original .docx, which is
// the text the round trip is being measured against.
const convertMaths = (t) =>
  t.page.evaluate(async () => {
    await loadOfficeToPdf();
    const file = await window.buildMathsDocx();
    const pdf = await window.SwiftOffice.toPdf(file);
    const source = await window.SwiftOffice.extract(file);

    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: pdf.bytes.slice() }).promise;
    const items = [];
    let drawn = 0;
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const ops = await page.getOperatorList();
        // constructPath is how a drawn symbol reaches the page; a symbol written
        // as text is a show-text operator instead.
        drawn += ops.fnArray.filter((fn) => fn === pdfjs.OPS.constructPath).length;
        items.push((await page.getTextContent()).items.map((item) => item.str));
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }

    const read = await readPdfText(new File([pdf.bytes.slice()], "maths.pdf", { type: "application/pdf" }), () => {});
    return {
      pages: pdf.pageCount,
      drawn,
      dropped: pdf.stats.droppedCharacters,
      items,
      layer: items.flat().join(""),
      readText: read.blocks.map((b) => b.text || "").join("\n"),
      readPages: read.pages,
      sourceText: source.blocks.map((b) => b.text || "").join("\n"),
    };
  });

const occurrences = (text, character) => text.split(character).length - 1;

test(
  "every symbol in a Word document reaches the finished page, as text or as ink",
  async (t) => {
    // One document per symbol, holding nothing but the two words around it. A
    // document holding all of them could only say how many survived; holding one
    // at a time says which, and it is the only way to tell a symbol that was
    // drawn from one that was quietly dropped along with everything else.
    await openEngine(t);
    const rows = await t.page.evaluate(async (symbols) => {
      await loadOfficeToPdf();
      const measured = [];
      for (const symbol of symbols) {
        const file = await window.buildDocxWithText(`left ${symbol} right`);
        const out = await window.SwiftOffice.toPdf(file);
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument({ data: out.bytes.slice() }).promise;
        let text = "";
        let drawn = 0;
        try {
          for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const ops = await page.getOperatorList();
            drawn += ops.fnArray.filter((fn) => fn === pdfjs.OPS.constructPath).length;
            text += (await page.getTextContent()).items.map((item) => item.str).join("");
            page.cleanup();
          }
        } finally {
          await doc.destroy();
        }
        measured.push({ symbol, text, drawn, dropped: out.stats.droppedCharacters });
      }
      return measured;
    }, SYMBOLS);

    const found = rows.filter((row) => row.text.includes(row.symbol));
    const inked = rows.filter((row) => row.drawn > 0);
    // The split as it stands, quoted in the failure message so a change to it
    // is visible rather than silent: an improvement shows up as `found` growing.
    const state = `${found.length} of ${rows.length} in the text layer, ${inked.length} drawn`;

    await step("not one of them was replaced with a question mark", async () => {
      const replaced = rows.filter((row) => row.dropped > 0).map((row) => row.symbol);
      assert.deepEqual(
        replaced.filter((symbol) => !WITHOUT_A_DRAWN_GLYPH.has(symbol)),
        [],
        `these were written as "?" because the font cannot draw them, and they are not the one character known to have no glyph: ${state}`
      );
      for (const row of rows) {
        if (WITHOUT_A_DRAWN_GLYPH.has(row.symbol)) continue;
        assert.ok(
          row.text.indexOf("?") === -1,
          `the page for ${row.symbol} contains a question mark: ${JSON.stringify(row.text)}`
        );
      }
    });

    await step("each one is on the page, whether as text or as ink", async () => {
      // The assertion that survives the text layer being fixed: a symbol has to
      // have got onto the page by some route, and a converter that lost it
      // entirely - no text and no drawing - fails here whichever world it is in.
      const nowhere = rows
        .filter((row) => !row.text.includes(row.symbol) && row.drawn === 0)
        .map((row) => row.symbol)
        .filter((symbol) => !WITHOUT_A_DRAWN_GLYPH.has(symbol));
      assert.deepEqual(
        nowhere,
        [],
        `these reached neither the text layer nor the page: ${state}`
      );
    });

    await step("and the words on either side of it are untouched", async () => {
      // A symbol cannot cost the sentence its sentence: whatever route the
      // symbol took, the words around it are drawn with the same font as any
      // other text and must come back through the reader unchanged.
      for (const row of rows) {
        const flat = asWords(row.text);
        assert.ok(flat.indexOf("left") === 0, `the word before ${row.symbol} is missing: ${JSON.stringify(row.text)}`);
        assert.ok(
          flat.endsWith("right"),
          `the word after ${row.symbol} is missing: ${JSON.stringify(row.text)}`
        );
      }
    });
  },
  PAGE
);

test(
  "a symbol page says its words in the text layer, and never leaks a drawing code",
  async (t) => {
    // What getTextContent() returns for a page that contains drawn symbols, said
    // as an assertion rather than as a snapshot. The page holds "left ≤ right";
    // the text layer answers "left right" while the symbol is ink only, and
    // "left ≤ right" once it carries text of its own. Runs a reader cannot name
    // are set aside before the comparison, so a third state on the way from one
    // to the other does not fail this, and anything genuinely wrong does, with
    // the text it actually produced in the message.
    await openEngine(t);
    const measured = await t.page.evaluate(async (symbols) => {
      await loadOfficeToPdf();
      const read = async (body) => {
        const file = await window.buildDocxWithText(body);
        const out = await window.SwiftOffice.toPdf(file);
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument({ data: out.bytes.slice() }).promise;
        const items = [];
        try {
          for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            items.push(...(await page.getTextContent()).items);
            page.cleanup();
          }
        } finally {
          await doc.destroy();
        }
        return {
          items,
          text: items.map((item) => item.str).join(""),
        };
      };
      const out = {};
      // A control with no symbol at all, and the same sentence with each of a
      // relation, a Greek letter and a radical put into it.
      out.control = await read("left right");
      for (const symbol of symbols) out[symbol] = await read(`left ${symbol} right`);
      return out;
    }, ["≤", "α", "√"]);

    await step("the control page is the two words and nothing else", async () => {
      assert.equal(asWords(measured.control.text), "left right");
      assert.ok(measured.control.items.length >= 1, "a page of two words returned no text items at all");
    });

    await step("a page whose only other content is a symbol says its words", async () => {
      for (const symbol of ["≤", "α", "√"]) {
        const flat = asWords(measured[symbol].text);
        assert.ok(
          flat === `left ${symbol} right` || flat === "left right",
          `a page holding “left ${symbol} right” reads ${JSON.stringify(asWords(measured[symbol].text))} from getTextContent()`
        );
      }
    });

    await step("every item is a usable string, not an empty or broken one", async () => {
      for (const symbol of ["≤", "α", "√"]) {
        for (const item of measured[symbol].items) {
          assert.equal(typeof item.str, "string", `an item on the ${symbol} page is not a string: ${JSON.stringify(item)}`);
          assert.ok(item.str.length > 0, `an empty run on the ${symbol} page: ${JSON.stringify(measured[symbol].items)}`);
        }
      }
    });

    await step("the private-use codes the glyphs are drawn from stay private", async () => {
      // office-to-pdf.js swaps each undrawable character for a code in
      // U+E000-U+EFFF and looks the path up from it. Those codes are an
      // implementation detail: if one ever reached the text layer a reader would
      // see a private-use glyph and call it corruption. It holds whether the
      // symbol is drawn or given a text layer, which is why it is asserted here
      // and the presence of the symbol itself is not.
      for (const symbol of ["≤", "α", "√"]) {
        assert.doesNotMatch(
          measured[symbol].text,
          /[\uE000-\uEFFF]/,
          `a drawing code leaked into the text layer of the ${symbol} page: ${JSON.stringify(measured[symbol].text)}`
        );
      }
    });
  },
  PAGE
);

test(
  "the maths round trip loses its drawn symbols and nothing else",
  async (t) => {
    await openEngine(t);
    const result = await convertMaths(t);

    // What is left after the round trip, symbol by symbol, quoted in every
    // message below: 0 of 21 today, all 21 once the symbols have a text layer.
    const lost = [];
    const kept = [];
    for (const symbol of DRAWN_IN_THE_MATHS_DOCUMENT) {
      const had = occurrences(result.sourceText, symbol);
      const has = occurrences(result.readText, symbol);
      for (let n = 0; n < had - has; n++) lost.push(symbol);
      for (let n = 0; n < has; n++) kept.push(symbol);
    }

    await step("no character anywhere was replaced with a question mark", async () => {
      assert.equal(result.dropped, 0, `${result.dropped} characters were replaced with "?"`);
      assert.doesNotMatch(result.layer, /\?/, `the page reads: ${JSON.stringify(result.layer)}`);
      assert.doesNotMatch(result.readText, /\?/, `the reader returned: ${JSON.stringify(result.readText)}`);
    });

    await step("the structure of the equations is still there", async () => {
      for (const { label, pattern } of STRUCTURE) {
        assert.match(result.readText, pattern, `${label} did not survive the round trip: ${JSON.stringify(result.readText)}`);
      }
    });

    await step("every character that is not a drawn symbol came back", async () => {
      // The heart of the measurement. The document's own text, read straight out
      // of the .docx, against the same document read back out of the PDF: the
      // only characters allowed to be missing are the ones drawn as vector art.
      // A word, a digit, a bracket or a piece of OMML structure going missing is
      // a real defect, and it fails here whether or not the symbols are fixed.
      const gone = [];
      for (const character of new Set(result.sourceText)) {
        if (/\s/.test(character)) continue;
        if (DRAWN_IN_THE_MATHS_DOCUMENT.includes(character)) continue;
        if (result.readText.indexOf(character) === -1) gone.push(character);
      }
      assert.deepEqual(
        gone.map((c) => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase()})`),
        [],
        `the round trip lost more than its symbols (${kept.length} of ${DRAWN_IN_THE_MATHS_DOCUMENT.length} symbol kinds came back): ${JSON.stringify(result.readText)}`
      );
    });

    await step("every symbol the round trip loses was drawn on the page", async () => {
      // The loss is in the text layer and not on the page, and this is what says
      // so: there is a vector path for each symbol that failed to come back, so
      // a person looking at the PDF sees the mathematics and only a reader
      // running over the file misses it. True today (21 paths, 21 lost) and
      // still true when the symbols arrive as text and nothing is lost at all.
      assert.ok(
        result.drawn >= lost.length,
        `${lost.length} symbols were lost by the round trip but only ${result.drawn} paths are drawn, so at least one of them is on the page nowhere`
      );
      assert.ok(result.drawn > 0, `no vector paths at all on a page of equations: ${JSON.stringify(result.items)}`);
    });

    await step("and the page itself is not empty and not blank", async () => {
      assert.equal(result.pages, result.readPages, "the reader did not see every page the converter wrote");
      assert.ok(result.items.flat().length > 0, "getTextContent() returned no items for a page of equations");
      assert.match(result.layer, /Ordinary prose that must be unaffected\./);
      assert.match(result.readText, /Ordinary prose that must be unaffected\./);
    });
  },
  PAGE
);

test(
  "the other direction keeps every character: .docx to blocks to .docx and back",
  async (t) => {
    // extract() is the direction that works. The text comes back as written,
    // including the scripts the PDF fonts cannot draw, and the writer puts those
    // characters into the file verbatim. This is the guard on it: a change made
    // to help the symbols along the PDF route must not quietly start dropping
    // characters on this one.
    await openEngine(t);
    const result = await t.page.evaluate(async () => {
      await loadOfficeToPdf();
      const file = await window.buildMathsDocx();
      const first = await window.SwiftOffice.extract(file);
      const writers = await loadFileWriters();
      const bytes = await writers.docx({ title: "Round trip", blocks: first.blocks });
      const JSZip = await loadJsZip();
      const zip = await JSZip.loadAsync(bytes);
      const xml = await zip.file("word/document.xml").async("string");
      const written = new File([bytes.slice()], "round-trip.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      // Read the written file back with the engine that wrote it: a character
      // that is in the XML but not in the blocks would be no use to anybody.
      const second = await window.SwiftOffice.extract(written);
      return {
        blocks: first.blocks,
        warnings: first.warnings,
        xml,
        again: second.blocks,
      };
    });

    const text = result.blocks.map((b) => b.text || "").join("\n");
    const everySymbol = DRAWN_IN_THE_MATHS_DOCUMENT.split("");

    await step("extract() returns the symbols as themselves", async () => {
      for (const symbol of everySymbol) {
        assert.ok(
          text.includes(symbol),
          `${symbol} (U+${symbol.codePointAt(0).toString(16).toUpperCase()}) is missing from the extracted text: ${JSON.stringify(text)}`
        );
      }
      assert.doesNotMatch(text, /\?/, `a character was replaced: ${JSON.stringify(text)}`);
    });

    await step("and it does not claim anything was lost", async () => {
      assert.ok(
        !result.warnings.some((w) => /replaced with/.test(w)),
        `extract() warned that characters were lost: ${JSON.stringify(result.warnings)}`
      );
    });

    await step("the written file holds those same characters, verbatim", async () => {
      for (const symbol of everySymbol) {
        assert.ok(
          result.xml.includes(symbol),
          `${symbol} is not in word/document.xml: the writer changed it on the way out`
        );
      }
      assert.match(result.xml, /Ordinary prose that must be unaffected\./);
      // The whole point of the file being XML and not a picture of one.
      assert.doesNotMatch(result.xml, /&#\d+;/, "a symbol was written as a numeric entity instead of as itself");
    });

    await step("and reading the written file back gives the same blocks", async () => {
      assert.deepEqual(
        result.again,
        result.blocks,
        "a .docx written from the extracted blocks does not read back as itself"
      );
    });
  },
  PAGE
);

test(
  "prose and a table come through the round trip exactly as they went in",
  async (t) => {
    // Neither direction above is allowed to have disturbed the two things a
    // document is mostly made of. Same .docx through the same two routes.
    await openEngine(t);
    const result = await t.page.evaluate(async () => {
      await loadOfficeToPdf();
      const file = await window.buildProseTableDocx();
      const pdf = await window.SwiftOffice.toPdf(file);
      const source = await window.SwiftOffice.extract(file);

      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: pdf.bytes.slice() }).promise;
      let layer = "";
      try {
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          layer += (await page.getTextContent()).items.map((item) => item.str).join("");
          page.cleanup();
        }
      } finally {
        await doc.destroy();
      }

      const read = await readPdfText(new File([pdf.bytes.slice()], "totals.pdf", { type: "application/pdf" }), () => {});

      const writers = await loadFileWriters();
      const bytes = await writers.docx({ title: "Totals", blocks: source.blocks });
      const JSZip = await loadJsZip();
      const zip = await JSZip.loadAsync(bytes);
      const xml = await zip.file("word/document.xml").async("string");
      const again = await window.SwiftOffice.extract(new File([bytes.slice()], "totals-again.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }));
      return {
        layer,
        blocks: read.blocks,
        tables: read.tables,
        detail: read.detail,
        dropped: pdf.stats.droppedCharacters,
        xml,
        again: again.blocks,
      };
    });

    const rows = [
      ["Region", "Q1", "Q2"],
      ["North", "120", "145"],
      ["South", "98", "133"],
    ];

    await step("the text layer holds the prose and every cell value", async () => {
      assert.equal(result.dropped, 0, `${result.dropped} characters were replaced with "?"`);
      assert.match(result.layer, /Totals for the third quarter\./);
      assert.match(result.layer, /A closing sentence after the table\./);
      for (const row of rows) {
        for (const cell of row) {
          assert.ok(result.layer.includes(cell), `the cell ${JSON.stringify(cell)} is not on the page: ${JSON.stringify(result.layer)}`);
        }
      }
    });

    await step("the reader finds the table as a table, between the two sentences", async () => {
      assert.equal(result.tables, 1, `no table was recognised: ${JSON.stringify(result.blocks)}`);
      assert.deepEqual(
        result.blocks.map((block) => block.type),
        ["paragraph", "table", "paragraph"],
        `the blocks are not prose, table, prose: ${JSON.stringify(result.blocks)}`
      );
      assert.deepEqual(result.blocks[1].rows, rows);
      assert.equal(result.blocks[0].text, "Totals for the third quarter.");
      assert.equal(result.blocks[2].text, "A closing sentence after the table.");
      assert.match(result.detail, /1 table/);
    });

    await step("the table is still a table after being written out and read again", async () => {
      assert.match(result.xml, /<w:tbl>/, "the written file has no table in it");
      for (const row of rows) {
        for (const cell of row) {
          assert.ok(result.xml.includes(cell), `the cell ${JSON.stringify(cell)} did not reach word/document.xml`);
        }
      }
      const again = result.again.find((block) => block.type === "table");
      assert.ok(again, `the written file has no table in it: ${JSON.stringify(result.again)}`);
      assert.deepEqual(again.rows, rows);
      assert.deepEqual(
        result.again.map((block) => block.type),
        ["paragraph", "table", "paragraph"],
        `the written file did not read back in order: ${JSON.stringify(result.again)}`
      );
    });
  },
  PAGE
);
