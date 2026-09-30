// office-to-pdf.js — the SwiftOffice engine, exercised for real.
//
// Every Office file here is built in the browser with the project's own JSZip
// (see officeHelpers below), so nothing is mocked and no binary fixture can rot.
// What comes back is a PDF read back through pdf.js, the way a person would see
// it: page count, page size, the words on each page and where they sit.
//
// The tests are written against the documented API only —
//   isOfficeFile(fileOrName) / kindOf(fileOrName) / toPdf(file, { onProgress })
// — and deliberately avoid anything private, so the engine is free to be
// restructured behind them.
import { test, assert, step } from "../lib/harness.mjs";
import { makePng } from "../lib/fixtures.mjs";

// A 1x1 transparent GIF. Real bytes, so an engine that sniffs content rather
// than the file name still sees a GIF and must skip it.
const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const BLANK = { path: "/tests/fixtures/blank.html" };

const A4 = { width: 595.28, height: 841.89 };
const SLIDE = { width: 960, height: 540 }; // 12192000 x 6858000 EMU
const MARGIN = 50; // the brief says ~56pt; a little slack for rounding
const SLACK = 1.5;

/* ------------------------------------------------------------------ *
 * Page-side helpers. This function is stringified into the browser, so
 * it must not close over anything in this file.
 * ------------------------------------------------------------------ */
function officeHelpers() {
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types";
  const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

  const CT = {
    docxMain: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    styles: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
    pptxMain: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    xlsxMain: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    worksheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
    sharedStrings: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
  };

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const EXT_TYPE = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    wmf: "image/x-wmf",
    emf: "image/x-emf",
    bmp: "image/bmp",
  };

  function fromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // A real content-types part, built from the parts themselves, so a fixture is
  // a package a strict reader would accept and the engine is never tripped up
  // by a shortcut a real Word file would not contain.
  function contentTypes(parts) {
    const implicit = new Set(["rels", "xml"]);
    let out =
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
    const seen = new Set();
    for (const part of parts) {
      const ext = part.path.split(".").pop().toLowerCase();
      const type = part.type || EXT_TYPE[ext];
      if (!type) continue;
      const key = implicit.has(ext) ? ext : "/" + part.path;
      if (seen.has(key)) continue;
      seen.add(key);
      out += implicit.has(ext)
        ? '<Default Extension="' + ext + '" ContentType="' + type + '"/>'
        : '<Override PartName="/' + part.path + '" ContentType="' + type + '"/>';
    }
    return XML_HEAD + '<Types xmlns="' + CONTENT + '">' + out + "</Types>";
  }

  function relsPart(list) {
    const body = (list || [])
      .map(
        (rel) =>
          '<Relationship Id="' + rel.id + '" Type="' + (rel.type || REL) + '" Target="' + rel.target + '"/>'
      )
      .join("");
    return XML_HEAD + '<Relationships xmlns="' + PKG_REL + '">' + body + "</Relationships>";
  }

  async function makeZip(parts) {
    const JSZip = await loadJsZip();
    const zip = new JSZip();
    zip.file("[Content_Types].xml", contentTypes(parts));
    for (const part of parts) zip.file(part.path, part.content);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  const fileFrom = (bytes, name) => new File([bytes], name);
  const mediaPart = (prefix, media) => (media || []).map((m) => ({ path: prefix + m.name, content: fromBase64(m.base64) }));

  /* ---------- DOCX ---------- */

  async function docx(options) {
    const opts = options || {};
    const parts = [
      { path: "word/document.xml", content: opts.body, type: CT.docxMain },
      {
        path: "word/styles.xml",
        type: CT.styles,
        content:
          XML_HEAD +
          '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
          '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
          "</w:styles>",
      },
      { path: "word/_rels/document.xml.rels", content: relsPart(opts.rels) },
    ].concat(mediaPart("word/media/", opts.media));
    return fileFrom(await makeZip(parts), opts.name || "document.docx");
  }

  /* ---------- PPTX ---------- */

  async function pptx(options) {
    const opts = options || {};
    const slides = opts.slides || [];
    const parts = [
      {
        path: "ppt/presentation.xml",
        type: CT.pptxMain,
        content:
          XML_HEAD +
          '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
          'xmlns:r="' + REL + '"><p:sldIdLst>' +
          slides.map((slide, i) => '<p:sldId id="' + (256 + i) + '" r:id="' + slide.relId + '"/>').join("") +
          '</p:sldIdLst><p:sldSz cx="' + opts.cx + '" cy="' + opts.cy + '"/></p:presentation>',
      },
      {
        path: "ppt/_rels/presentation.xml.rels",
        content: relsPart(
          slides.map((slide) => ({ id: slide.relId, type: REL + "/slide", target: "slides/" + slide.file }))
        ),
      },
    ];
    for (const slide of slides) {
      parts.push({ path: "ppt/slides/" + slide.file, content: slide.xml, type: CT.slide });
      parts.push({ path: "ppt/slides/_rels/" + slide.file + ".rels", content: relsPart(slide.rels) });
      parts.push(...mediaPart("ppt/media/", slide.media));
    }
    return fileFrom(await makeZip(parts), opts.name || "deck.pptx");
  }

  /* ---------- XLSX ---------- */

  async function xlsx(options) {
    const opts = options || {};
    const shared = opts.shared || [];
    const sheets = opts.sheets || [];
    const parts = [
      {
        path: "xl/workbook.xml",
        type: CT.xlsxMain,
        content:
          XML_HEAD +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + REL + '"><sheets>' +
          sheets.map((sheet) => '<sheet name="' + sheet.name + '" sheetId="1" r:id="' + sheet.relId + '"/>').join("") +
          "</sheets></workbook>",
      },
      {
        path: "xl/_rels/workbook.xml.rels",
        content: relsPart(sheets.map((sheet) => ({ id: sheet.relId, type: REL + "/worksheet", target: sheet.file }))),
      },
    ];
    for (const sheet of sheets) parts.push({ path: "xl/" + sheet.file, content: sheet.xml, type: CT.worksheet });
    if (shared.length) {
      parts.push({
        path: "xl/sharedStrings.xml",
        type: CT.sharedStrings,
        content:
          XML_HEAD +
          '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' +
          shared.length + '" uniqueCount="' + shared.length + '">' +
          shared.map((text) => "<si><t>" + text + "</t></si>").join("") +
          "</sst>",
      });
    }
    return fileFrom(await makeZip(parts), opts.name || "book.xlsx");
  }

  /* ---------- hostile archives ---------- */

  // Rewrite the uncompressed size a zip declares, in both the local header and
  // the central directory, without touching a byte of real content. This is
  // what a zip bomb looks like to a reader that trusts the index.
  function declareHugeSize(bytes, size) {
    const out = bytes.slice();
    const view = new DataView(out.buffer);
    let patched = 0;
    for (let i = 0; i + 4 <= out.length; i++) {
      if (out[i] !== 0x50 || out[i + 1] !== 0x4b) continue;
      const kind = view.getUint16(i + 2, true);
      if (kind === 0x0403) {
        view.setUint32(i + 22, size >>> 0, true);
        patched++;
      } else if (kind === 0x0201) {
        view.setUint32(i + 24, size >>> 0, true);
        patched++;
      }
    }
    return { bytes: out, patched };
  }

  async function manyEntries(count, name) {
    const JSZip = await loadJsZip();
    const zip = new JSZip();
    for (let i = 0; i < count; i++) zip.file("xl/media/f" + i + ".bin", "x");
    zip.file("xl/workbook.xml", XML_HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
    return fileFrom(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), name);
  }

  /* ---------- running the engine ---------- */

  // toPdf resolves for anything it can turn into a PDF; a file it cannot read
  // at all rejects. Either way it settles, so this never throws out of the page.
  async function settle(file) {
    try {
      const result = await SwiftOffice.toPdf(file);
      return {
        rejected: false,
        pageCount: result.pageCount,
        warnings: result.warnings,
        stats: result.stats,
        header: String.fromCharCode.apply(null, result.bytes.slice(0, 5)),
      };
    } catch (err) {
      return { rejected: true, message: String(err && err.message ? err.message : err) };
    }
  }

  // Everything a test wants to know about the finished file, read back through
  // pdf.js. pdf.js takes ownership of the buffer it is given, so it gets a copy.
  async function read(bytes) {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const drawOps = new Set([
      pdfjs.OPS.constructPath,
      pdfjs.OPS.rectangleFill,
      pdfjs.OPS.rectangleStroke,
      pdfjs.OPS.fill,
      pdfjs.OPS.stroke,
    ]);
    const imageOps = new Set([
      pdfjs.OPS.paintImageXObject,
      pdfjs.OPS.paintJpegXObject,
      pdfjs.OPS.paintImageXObjectRepeat,
      pdfjs.OPS.paintInlineImageXObject,
    ]);

    const pages = [];
    try {
      for (let number = 1; number <= doc.numPages; number++) {
        const page = await doc.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items = content.items
          .filter((item) => item.str && item.str.trim() !== "")
          .map((item) => ({
            str: item.str,
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            height: item.height,
          }));

        const ops = await page.getOperatorList();
        let pathCount = 0;
        let scale = null;
        const images = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          if (drawOps.has(fn)) pathCount++;
          if (fn === pdfjs.OPS.transform) {
            const a = ops.argsArray[i];
            if (Math.abs(a[1]) < 1e-6 && Math.abs(a[2]) < 1e-6) scale = { w: Math.abs(a[0]), h: Math.abs(a[3]) };
          } else if (imageOps.has(fn)) {
            images.push(scale || { w: 0, h: 0 });
          }
        }

        pages.push({
          number,
          width: viewport.width,
          height: viewport.height,
          items,
          text: items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim(),
          images,
          pathCount,
        });
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }

    return {
      numPages: doc.numPages,
      pages,
      header: String.fromCharCode.apply(null, bytes.subarray(0, 5)),
      length: bytes.length,
    };
  }

  async function convertAndRead(file, options) {
    const started = performance.now();
    const result = await SwiftOffice.toPdf(file, options || {});
    const summary = {
      pageCount: result.pageCount,
      warnings: result.warnings,
      stats: result.stats,
      bytesIsArray: result.bytes instanceof Uint8Array,
    };
    const pdf = await read(result.bytes);
    return Object.assign({}, summary, pdf, { elapsed: performance.now() - started });
  }

  window.officeFixtures = { docx, pptx, xlsx, makeZip, fromBase64, fileFrom, declareHugeSize, manyEntries, settle, convertAndRead };
  window.officeFixtures.pptxToPdf = async (args) => convertAndRead(await pptx(args));
  window.officeFixtures.xlsxToPdf = async (args) => convertAndRead(await xlsx(args));
  return window.officeFixtures;
}

/* ------------------------------------------------------------------ *
 * Node-side assertions
 * ------------------------------------------------------------------ */

// Line wrapping is the one thing a text conversion cannot fake, so word spacing
// is compared away: what has to survive is every character, in order.
const squash = (text) => String(text == null ? "" : text).replace(/\s+/g, "");

function inOrder(haystack, needles) {
  const flat = squash(haystack);
  let at = 0;
  for (const needle of needles) {
    const found = flat.indexOf(squash(needle), at);
    if (found < 0) return { ok: false, missing: needle };
    at = found + squash(needle).length;
  }
  return { ok: true };
}

const allText = (pdf) => pdf.pages.map((page) => page.text).join(" ");

function offPage(pdf, slack = SLACK) {
  const out = [];
  pdf.pages.forEach((page, index) => {
    for (const item of page.items) {
      const right = item.x + item.width;
      if (item.x < -slack || right > page.width + slack || item.y < -slack || item.y > page.height + slack) {
        out.push({ page: index + 1, str: item.str, x: item.x, right, y: item.y });
      }
    }
  });
  return out;
}

// A stricter version: content stays inside the ~56pt margins, not merely on the
// paper.
function outsideMargins(pdf, margin = MARGIN, slack = 2) {
  return pdf.pages.flatMap((page, index) =>
    page.items
      .filter((item) => item.x < margin - slack || item.x + item.width > page.width - margin + slack)
      .map((item) => ({ page: index + 1, str: item.str, x: item.x, right: item.x + item.width }))
  );
}

// A converter may draw a line as one string or word by word, so nothing here
// looks at individual text items: items sharing a baseline are one line, and
// words on a line separated by a real gap are one cell of a table or a sheet.
const CELL_GAP = 8;

function linesOf(pdf) {
  return pdf.pages.flatMap((page) => {
    const byY = new Map();
    for (const item of page.items) {
      const key = Math.round(item.y * 2) / 2;
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push(item);
    }
    return [...byY.entries()]
      .sort((a, b) => b[0] - a[0]) // PDF y grows upwards, so page order is descending
      .map(([y, items]) => {
        const sorted = items.slice().sort((a, b) => a.x - b.x);
        return {
          page: page.number,
          y,
          x: Math.min(...sorted.map((item) => item.x)),
          right: Math.max(...sorted.map((item) => item.x + item.width)),
          height: Math.max(...sorted.map((item) => item.height)),
          text: sorted.map((item) => item.str).join(""),
          items: sorted,
        };
      });
  });
}

function cellsOf(line) {
  const cells = [];
  for (const item of line.items) {
    const previous = cells[cells.length - 1];
    if (previous && item.x - previous.right <= CELL_GAP) {
      previous.text += item.str;
      previous.right = item.x + item.width;
      previous.height = Math.max(previous.height, item.height);
    } else {
      cells.push({ text: item.str, x: item.x, right: item.x + item.width, height: item.height });
    }
  }
  return cells;
}

// The run of text on the page that reads as the given string, wherever it sits.
function findLine(pdf, needle) {
  const want = squash(needle);
  return linesOf(pdf).filter((line) => squash(line.text).includes(want));
}

// The cell whose own text is the given string — what a table column or a
// spreadsheet column looks like on the page. An exact match wins over a partial
// one, so a cell is never confused with a longer cell that contains it.
function findCell(pdf, needle) {
  const want = squash(needle);
  const all = linesOf(pdf).flatMap((line) =>
    cellsOf(line).map((cell) => ({ ...cell, page: line.page, y: line.y }))
  );
  const exact = all.filter((cell) => squash(cell.text) === want);
  if (exact.length) return exact;
  return all.filter((cell) => squash(cell.text).includes(want));
}

const JARGON = /OOXML|EMU\b|DOMParser|Exception|undefined|NaN|\[object|cannot read|is not a function|at Object\./i;

const reEsc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function assertSentence(message, fileName) {
  assert.equal(typeof message, "string", "the message is not text");
  assert.ok(message.length > 20, `the message is too terse to help: ${message}`);
  assert.doesNotMatch(message, JARGON, `an internal error leaked into the message: ${message}`);
  const trimmed = message.trim();
  assert.ok(/\.$/.test(trimmed), `not a finished sentence: ${message}`);
  const sentences = trimmed.split(/(?<=\.)\s+/).filter((part) => part.trim().length > 0);
  assert.ok(sentences.length >= 1, "the message is empty");
  for (const sentence of sentences) {
    assert.ok(sentence.split(/\s+/).length >= 4, `a fragment rather than a sentence: ${sentence}`);
  }
  assert.match(message, new RegExp('^["“‘\']?' + reEsc(fileName)), `the message should open with the file name: ${message}`);
}

function assertPlainEnglish(warnings) {
  assert.equal(Array.isArray(warnings), true, `warnings should be an array, got: ${typeof warnings}`);
  for (const warning of warnings) {
    assert.equal(typeof warning, "string", "a warning is not text");
    assert.ok(warning.trim().length > 10, `a warning is too terse: ${warning}`);
    assert.doesNotMatch(warning, JARGON, `jargon in a warning: ${warning}`);
  }
}

async function boot(t) {
  await t.page.addScriptTag({ url: t.url("/office-to-pdf.js") });
  await t.page.addScriptTag({ content: "window.officeFixtures = (" + officeHelpers.toString() + ")();" });
  await t.page.waitForFunction(() => Boolean(window.officeFixtures && window.SwiftOffice));
}

/* ---------- WordprocessingML fragments ---------- */

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const WORDML =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml"';

const docxBody = (inner) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + WORDML + "><w:body>" + inner + "</w:body></w:document>";

const para = (text, opts = {}) =>
  "<w:p>" +
  (opts.pPr ? "<w:pPr>" + opts.pPr + "</w:pPr>" : "") +
  "<w:r>" +
  (opts.rPr ? "<w:rPr>" + opts.rPr + "</w:rPr>" : "") +
  '<w:t xml:space="preserve">' + esc(text) + "</w:t>" +
  "</w:r>" +
  (opts.extra || "") +
  "</w:p>";

const heading = (level, text) => para(text, { pPr: '<w:pStyle w:val="Heading' + level + '"/>' });
const listItem = (text) => para(text, { pPr: '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' });
const centered = (text) => para(text, { pPr: '<w:jc w:val="center"/>' });
const rightAligned = (text) => para(text, { pPr: '<w:jc w:val="right"/>' });
const boldText = (text) => para(text, { rPr: "<w:b/>" });

// The blip is the only thing a converter strictly needs, but the wrapper around
// it is what Word actually writes, so a fixture cannot pass a parser that only
// copes with stripped-down XML. The extent is square, matching the 2x2 image it
// points at, so a converter that keeps the picture's own proportions draws a
// square picture.
const drawingPara = (relId, extent) =>
  '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
  '<wp:extent cx="' + extent + '" cy="' + extent + '"/><wp:docPr id="1" name="Picture 1" descr="picture"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
  '<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
  '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
  '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + extent + '" cy="' + extent + '"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>' +
  "</wp:inline></w:drawing></w:r></w:p>";

const pictPara = (relId) => '<w:p><w:r><w:pict><v:imagedata r:id="' + relId + '" alt=""/></w:pict></w:r></w:p>';

const tableXml = (rows) =>
  "<w:tbl><w:tblPr><w:tblBorders>" +
  ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((side) => '<w:' + side + ' w:val="single" w:sz="4" w:color="auto"/>')
    .join("") +
  "</w:tblBorders></w:tblPr>" +
  rows
    .map((row) => "<w:tr>" + row.map((text) => "<w:tc><w:tcPr/>" + para(text) + "</w:tc>").join("") + "</w:tr>")
    .join("") +
  "</w:tbl>";

/* ---------- PresentationML fragments ---------- */

const SLIDE_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const slideXml = (shapes) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ' + SLIDE_NS + "><p:cSld><p:spTree>" +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  shapes +
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

const EMU = 12700; // EMU per point, so the numbers below read as points
const textBox = (x, y, cx, cy, runs) =>
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="' + Math.round(x * EMU) + '" y="' + Math.round(y * EMU) + '"/>' +
  '<a:ext cx="' + Math.round(cx * EMU) + '" cy="' + Math.round(cy * EMU) + '"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
  runs
    .map(
      (run) =>
        '<a:p><a:r><a:rPr lang="en-US" sz="' + (run.sz || 1800) + '" b="' + (run.b ? 1 : 0) + '"/><a:t>' +
        esc(run.text) + "</a:t></a:r></a:p>"
    )
    .join("") +
  "</p:txBody></p:sp>";

const pictureShape = (relId, x, y, cx, cy) =>
  '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
  '<p:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
  '<p:spPr><a:xfrm><a:off x="' + Math.round(x * EMU) + '" y="' + Math.round(y * EMU) + '"/>' +
  '<a:ext cx="' + Math.round(cx * EMU) + '" cy="' + Math.round(cy * EMU) + '"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';

/* ---------- SpreadsheetML fragments ---------- */

const sheetXml = (rowsXml, colsXml) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  (colsXml ? "<cols>" + colsXml + "</cols>" : "") +
  "<sheetData>" + rowsXml + "</sheetData></worksheet>";

const inlineCell = (ref, text) => '<c r="' + ref + '" t="inlineStr"><is><t>' + esc(text) + "</t></is></c>";
const numberCell = (ref, value) => '<c r="' + ref + '"><v>' + value + "</v></c>";
const sharedCell = (ref, index) => '<c r="' + ref + '" t="s"><v>' + index + "</v></c>";
const row = (number, cells) => '<row r="' + number + '">' + cells + "</row>";

/* ================================================================== *
 * Tests
 * ================================================================== */

test(
  "the engine answers to exactly the documented API",
  async (t) => {
    await boot(t);

    await step("only the three documented functions are published", async () => {
      const shape = await t.page.evaluate(() => ({
        keys: Object.keys(window.SwiftOffice).sort(),
        async: SwiftOffice.toPdf.constructor.name === "AsyncFunction",
        extractAsync: SwiftOffice.extract.constructor.name === "AsyncFunction",
      }));
      assert.deepEqual(shape.keys, ["extract", "isOfficeFile", "kindOf", "toPdf"]);
      assert.equal(shape.async, true, "toPdf should be async so a bad file cannot throw synchronously");
      assert.equal(shape.extractAsync, true, "extract should be async too");
    });

    await step("the three OOXML kinds are recognised, whatever the casing", async () => {
      const kinds = await t.page.evaluate(() =>
        ["report.docx", "REPORT.DOCX", "deck.pptx", "Deck.PPTX", "book.xlsx", "Book.XlSx"].map((name) => SwiftOffice.kindOf(name))
      );
      assert.deepEqual(kinds, ["docx", "docx", "pptx", "pptx", "xlsx", "xlsx"]);
    });

    await step("legacy binary Office files are not claimed", async () => {
      const legacy = await t.page.evaluate(() =>
        ["notes.doc", "slides.ppt", "sheet.xls", "docx", "", "a.docx.bak", "archive.docx.zip", "report.pdf"].map((name) => [
          name,
          SwiftOffice.kindOf(name),
          SwiftOffice.isOfficeFile(name),
        ])
      );
      for (const [name, kind, is] of legacy) {
        assert.equal(kind, null, `${name} should not be recognised`);
        assert.equal(is, false, `${name} should not be accepted`);
      }
    });

    await step("rubbish is refused without throwing", async () => {
      const answers = await t.page.evaluate(() => ({
        pdf: [SwiftOffice.kindOf("report.pdf"), SwiftOffice.isOfficeFile("report.pdf")],
        nullish: [SwiftOffice.kindOf(null), SwiftOffice.isOfficeFile(null)],
        undef: [SwiftOffice.kindOf(undefined), SwiftOffice.isOfficeFile(undefined)],
        emptyObject: [SwiftOffice.kindOf({}), SwiftOffice.isOfficeFile({})],
        number: [SwiftOffice.kindOf(42), SwiftOffice.isOfficeFile(42)],
        blob: [SwiftOffice.kindOf(new Blob([])), SwiftOffice.isOfficeFile(new Blob([]))],
        namelessFile: [SwiftOffice.kindOf(new File([], "")), SwiftOffice.isOfficeFile(new File([], ""))],
      }));
      assert.deepEqual(answers.pdf, [null, false]);
      assert.deepEqual(answers.nullish, [null, false]);
      assert.deepEqual(answers.undef, [null, false]);
      assert.deepEqual(answers.emptyObject, [null, false]);
      assert.deepEqual(answers.number, [null, false]);
      assert.deepEqual(answers.blob, [null, false]);
      assert.deepEqual(answers.namelessFile, [null, false]);
    });

    await step("a File and a {name} object are as good as a name", async () => {
      const answers = await t.page.evaluate(() => ({
        file: [SwiftOffice.kindOf(new File([new Uint8Array(4)], "deck.pptx")), SwiftOffice.isOfficeFile(new File([], "deck.pptx"))],
        plain: [SwiftOffice.kindOf({ name: "book.xlsx" }), SwiftOffice.isOfficeFile({ name: "book.xlsx" })],
        mixedCase: SwiftOffice.kindOf(new File([], "MiXeD.DocX")),
      }));
      assert.deepEqual(answers.file, ["pptx", true]);
      assert.deepEqual(answers.plain, ["xlsx", true]);
      assert.deepEqual(answers.mixedCase, "docx");
    });

    await step("loading the script twice is harmless", async () => {
      await t.page.addScriptTag({ url: t.url("/office-to-pdf.js") });
      assert.equal(await t.page.evaluate(() => typeof SwiftOffice.toPdf), "function");
    });

    assert.deepEqual(t.pageErrors, []);
  },
  BLANK
);

test(
  "a Word document becomes a paged A4 PDF with its text intact",
  async (t) => {
    await boot(t);

    const sentence = (n) =>
      "Paragraph number " + n + " carries a handful of ordinary words that have to be wrapped over more than one line of the page before the next paragraph begins.";
    const paragraphs = Array.from({ length: 120 }, (_, i) => para(sentence(i + 1)));
    const markers = paragraphs.map((_, i) => "Paragraph number " + (i + 1));

    const pdf = await t.page.evaluate(
      async (body) => await window.officeFixtures.convertAndRead(await window.officeFixtures.docx({ body, name: "report.docx" })),
      docxBody(paragraphs.join(""))
    );

    await step("the download is a real PDF", () => {
      assert.equal(pdf.header, "%PDF-", "the result is not a PDF");
      assert.equal(pdf.bytesIsArray, true, "bytes should be a Uint8Array");
      assert.equal(pdf.pageCount, pdf.numPages, "pageCount disagrees with the file itself");
      assert.ok(pdf.pageCount >= 2, `120 paragraphs should not fit on one page, got ${pdf.pageCount}`);
    });

    await step("every page is A4", () => {
      for (const page of pdf.pages) {
        assert.ok(Math.abs(page.width - A4.width) < 1, `page width ${page.width}`);
        assert.ok(Math.abs(page.height - A4.height) < 1, `page height ${page.height}`);
      }
    });

    await step("nothing was dropped, and the order is the document's", () => {
      const found = inOrder(allText(pdf), markers);
      assert.equal(found.ok, true, `missing or out of order: ${found.missing}`);
    });

    await step("the first paragraph is the top of the first page, not the bottom", () => {
      // The page is read from the top down. A page laid out the other way up
      // still contains every character in the right order inside the file, so
      // only the coordinates on the page give this away.
      const top = linesOf(pdf)[0];
      assert.equal(top.page, 1, `the topmost text is on page ${top.page}`);
      assert.match(top.text, /Paragraph number 1\b/, `the top of page 1 reads: ${JSON.stringify(top.text)}`);
    });

    await step("each page is filled from its top margin downwards", () => {
      for (const page of pdf.pages) {
        const lines = linesOf(pdf).filter((line) => line.page === page.number);
        const top = lines[0];
        const bottom = lines[lines.length - 1];
        assert.ok(top.y > page.height - MARGIN - 12, `page ${page.number} starts ${(page.height - top.y).toFixed(0)}pt from the top`);
        assert.ok(bottom.y > 12, `page ${page.number} runs ${bottom.y.toFixed(0)}pt from the foot of the page`);
      }
    });

    await step("no text runs off the paper or out of the margins", () => {
      assert.deepEqual(offPage(pdf), []);
      assert.deepEqual(outsideMargins(pdf), []);
    });

    await step("long paragraphs were wrapped, not left as one long line", () => {
      const drawn = pdf.pages.reduce((sum, page) => sum + linesOf({ pages: [page] }).length, 0);
      assert.ok(drawn >= 180, `120 wrapped paragraphs should need more than ${drawn} lines`);
      const firstLine = findLine(pdf, "Paragraph number 1 carries")[0];
      assert.ok(firstLine, "the first paragraph is missing");
      assert.ok(firstLine.right - firstLine.x > 200, `expected a full wrapped line, it was ${firstLine.right - firstLine.x}pt`);
      assert.ok(firstLine.x >= MARGIN - 1, `the first line starts at ${firstLine.x}pt, outside the margin`);
    });

    await step("the engine says what it counted", () => {
      assert.equal(typeof pdf.stats, "object");
      assert.ok(pdf.stats.characters > 0, "characters should be counted");
      assert.equal(pdf.stats.images, 0, "this document has no images");
      assert.ok(pdf.stats.paragraphs >= 120, `paragraphs counted: ${pdf.stats.paragraphs}`);
    });

    assertPlainEnglish(pdf.warnings);
  },
  BLANK
);

test(
  "a very long word is broken by character rather than allowed off the page",
  async (t) => {
    await boot(t);

    const word = "Averyveryverylongunbrokenidentifier" + "0123456789".repeat(14);
    const body = docxBody(para("Before the long word.") + para(word) + para("After the long word."));
    const pdf = await t.page.evaluate(
      async (xml) => await window.officeFixtures.convertAndRead(await window.officeFixtures.docx({ body: xml, name: "url.docx" })),
      body
    );

    assert.deepEqual(offPage(pdf), [], "a line was allowed to run past the edge of the page");

    await step("the whole word is still there, split across lines", () => {
      assert.equal(squash(allText(pdf)).includes(squash(word)), true, "the long word lost characters");
    });

    await step("and the sentences around it survived, in order", () => {
      const found = inOrder(allText(pdf), ["Before the long word.", word, "After the long word."]);
      assert.equal(found.ok, true, `missing or out of order: ${found.missing}`);
    });
  },
  BLANK
);

test(
  "Word styling we can honour is honoured, and the rest is not faked",
  async (t) => {
    await boot(t);

    const body = docxBody(
      para("A plain body paragraph to measure against.") +
        heading(1, "The Big Heading") +
        heading(2, "The Smaller Heading") +
        boldText("The same words, set bold.") +
        para("The same words, set bold.") +
        centered("Perfectly centred words.") +
        rightAligned("Words pushed right.") +
        listItem("First list item") +
        listItem("Second list item") +
        para("A run holding   three   spaces.")
    );

    const pdf = await t.page.evaluate(
      async (xml) => await window.officeFixtures.convertAndRead(await window.officeFixtures.docx({ body: xml, name: "styled.docx" })),
      body
    );

    assert.equal(pdf.pageCount, 1, "this should be one page");
    assertPlainEnglish(pdf.warnings);
    assert.deepEqual(offPage(pdf), []);

    const bodyLine = findLine(pdf, "A plain body paragraph to measure against.")[0];
    assert.ok(bodyLine, "the body paragraph is missing");

    await step("a heading is drawn larger than the body", () => {
      const h1 = findLine(pdf, "The Big Heading")[0];
      const h2 = findLine(pdf, "The Smaller Heading")[0];
      assert.ok(h1 && h2, "a heading is missing");
      assert.ok(h1.height > bodyLine.height * 1.3, `heading 1 is ${h1.height}pt against a ${bodyLine.height}pt body`);
      assert.ok(h1.height >= h2.height, "heading 1 should not be smaller than heading 2");
      assert.ok(h2.height > bodyLine.height, `heading 2 is ${h2.height}pt against a ${bodyLine.height}pt body`);
    });

    await step("a bold run is set with a different face from the same words unbold", () => {
      // The same sentence twice, once bold: a converter that honours <w:b/>
      // draws the two lines at different widths, because Helvetica and
      // Helvetica-Bold are not the same set of shapes.
      const lines = linesOf(pdf).filter((line) => squash(line.text).includes("Thesamewords,setbold."));
      assert.equal(lines.length, 2, `expected the sentence twice, found ${lines.length} lines`);
      const widths = lines.map((line) => line.right - line.x);
      assert.ok(
        Math.abs(widths[0] - widths[1]) > 0.5,
        `both lines are ${widths[0].toFixed(2)}pt wide, so the bold run was set in the same face as the plain one`
      );
    });

    await step("alignment moves the line", () => {
      const centre = findLine(pdf, "Perfectly centred words.")[0];
      const right = findLine(pdf, "Words pushed right.")[0];
      assert.ok(centre && right, "an aligned paragraph is missing");
      const middle = (centre.x + centre.right) / 2;
      assert.ok(Math.abs(middle - A4.width / 2) < 25, `the centred line sits at ${middle}pt on a ${A4.width}pt page`);
      assert.ok(right.right > A4.width - 90, `the right-aligned line ends at ${right.right}pt`);
      assert.ok(right.x > bodyLine.x + 100, "right alignment did not move the line");
    });

    await step("a numbered paragraph is marked or indented as a list item", () => {
      const first = findCell(pdf, "First list item")[0];
      assert.ok(first, "the list item is missing");
      const marked =
        first.x > bodyLine.x + 8 || ["•", "-", "–", "◦", "·", "1", "a"].some((mark) => first.text.includes(mark));
      assert.equal(marked, true, `the list item is neither indented nor marked: ${JSON.stringify(first.text)} at x=${first.x}`);
    });

    await step("significant spacing inside a run survives", async () => {
      // pdf.js reports a run of whitespace as a single " " no matter how wide it
      // was drawn, so the text of the line cannot prove anything here. Measure
      // the advance the engine actually wrote: the whitespace run the engine
      // emits for three spaces has to be about three space widths wide.
      const oneSpace = await t.page.evaluate(async () => {
        const lib = await loadPdfLib();
        const probe = await lib.PDFDocument.create();
        const font = await probe.embedFont(lib.StandardFonts.Helvetica);
        return font.widthOfTextAtSize(" ", 11);
      });

      const runs = [];
      for (const page of pdf.pages) {
        for (const item of page.items) {
          if (/^\s+$/.test(item.str) || item.width > oneSpace * 1.5) {
            if (item.width > 0.5) runs.push({ str: item.str, width: item.width, y: item.y });
          }
        }
      }
      const wide = runs.filter((r) => r.width > oneSpace * 2.5);
      assert.ok(
        wide.length > 0,
        `no run of three spaces survived: found ${runs.length} whitespace run(s), widths ${runs.map((r) => r.width.toFixed(2)).join(", ")}, one space is ${oneSpace.toFixed(2)}pt`
      );
    });
  },
  BLANK
);

test(
  "a Word table comes out as a table, not one run-on line",
  async (t) => {
    await boot(t);

    const rows = [
      ["Region", "Quarter", "Total"],
      ["North", "Q1", "1200"],
      ["South", "Q2", "1450"],
    ];
    const body = docxBody(para("Sales by region.") + tableXml(rows));
    const pdf = await t.page.evaluate(
      async (xml) => await window.officeFixtures.convertAndRead(await window.officeFixtures.docx({ body: xml, name: "table.docx" })),
      body
    );

    assertPlainEnglish(pdf.warnings);

    await step("every cell's text is there", () => {
      const found = inOrder(allText(pdf), rows.flat());
      assert.equal(found.ok, true, `missing or out of order: ${found.missing}`);
    });

    await step("each row is three separate cells, not one run-on line", () => {
      const lines = linesOf(pdf).filter((line) => line.y > 0);
      for (const row of rows) {
        const line = lines.find((candidate) => row.every((label) => squash(candidate.text).includes(squash(label))));
        assert.ok(line, `no single line holds the whole row ${row.join(" / ")}`);
        const cells = cellsOf(line);
        const matched = row.map((label) => cells.find((cell) => squash(cell.text) === squash(label)));
        for (let i = 0; i < matched.length; i++) {
          assert.ok(matched[i], `"${row[i]}" is not a cell of its own on: ${line.text}`);
        }
        for (let i = 1; i < matched.length; i++) {
          assert.ok(matched[i].x > matched[i - 1].right - 1, `the cells of a row are glued together: ${line.text}`);
        }
      }
    });

    await step("the columns line up and the rows stack", () => {
      const header = rows[0].map((label) => findCell(pdf, label)[0]);
      header.forEach((cell) => assert.ok(cell, "a header cell is missing"));
      for (let i = 1; i < header.length; i++) {
        assert.ok(header[i].x > header[i - 1].x + 20, `column ${i} did not move right (x=${header[i].x} after ${header[i - 1].x})`);
      }
      const second = rows[1].map((label) => findCell(pdf, label)[0]);
      const third = rows[2].map((label) => findCell(pdf, label)[0]);
      assert.ok(second[0] && third[0], "a data row is missing");
      assert.ok(second[0].y < header[0].y - 5, `the second row did not sit below the header (${second[0].y} against ${header[0].y})`);
      assert.ok(third[0].y < second[0].y - 5, "the third row did not sit below the second");
    });

    await step("the table is ruled", () => {
      const total = pdf.pages.reduce((sum, page) => sum + page.pathCount, 0);
      assert.ok(total > 0, "no lines or boxes were drawn for the table");
    });

    assert.deepEqual(offPage(pdf), []);
    assert.deepEqual(outsideMargins(pdf), []);
  },
  BLANK
);

test(
  "a Word image is carried into the PDF, and one we cannot draw is skipped with a warning",
  async (t) => {
    await boot(t);

    const body = docxBody(
      para("A picture follows this line.") +
        drawingPara("rId10", 1828800) +
        para("And a legacy picture after it.") +
        pictPara("rId11") +
        para("A picture we cannot draw follows.")
    );

    const pdf = await t.page.evaluate(
      async (args) =>
        await window.officeFixtures.convertAndRead(
          await window.officeFixtures.docx({
            body: args.body,
            name: "illustrated.docx",
            media: [
              { name: "image1.png", relId: "rId10", base64: args.png },
              { name: "image2.png", relId: "rId11", base64: args.png },
              { name: "image3.gif", relId: "rId12", base64: args.gif },
            ],
            rels: [
              { id: "rId10", target: "media/image1.png" },
              { id: "rId11", target: "media/image2.png" },
              { id: "rId12", target: "media/image3.gif" },
            ],
          })
        ),
      { body, png: makePng().toString("base64"), gif: GIF_1X1 }
    );

    await step("both readable images were drawn", () => {
      const drawn = pdf.pages.reduce((sum, page) => sum + page.images.length, 0);
      assert.ok(drawn >= 2, `expected at least two images in the PDF, found ${drawn}`);
    });

    await step("a picture keeps its own proportions and fits the column", () => {
      for (const page of pdf.pages) {
        for (const image of page.images) {
          assert.ok(image.w > 0 && image.h > 0, `an image was drawn at ${image.w}x${image.h}`);
          assert.ok(image.w <= A4.width - MARGIN + 2, `an image is ${image.w}pt wide on a ${A4.width}pt page`);
          // The fixture is a 2x2 PNG and its declared extent is square, so a
          // converter that keeps the picture's own proportions draws it square.
          assert.ok(Math.abs(image.w - image.h) < 2, `a square image was drawn at ${image.w}x${image.h}`);
        }
      }
    });

    await step("the images are counted, and the GIF is not dropped without a word", () => {
      assert.ok(pdf.stats.images >= 2, `images counted: ${pdf.stats.images}`);
      const said = pdf.warnings.join(" ");
      assert.match(said, /image|picture|photo|graphic/i, `no warning mentioned the image we skipped: ${said}`);
      assert.match(
        said,
        /skip|could not|cannot|unable|not (?:shown|drawn|included|supported)|unsupported/i,
        `the warning does not say the image was left out: ${said}`
      );
      assertPlainEnglish(pdf.warnings);
    });

    await step("the text around the images is untouched", () => {
      const found = inOrder(allText(pdf), [
        "A picture follows this line.",
        "And a legacy picture after it.",
        "A picture we cannot draw follows.",
      ]);
      assert.equal(found.ok, true, `missing or out of order: ${found.missing}`);
    });

    assert.deepEqual(offPage(pdf), []);
  },
  BLANK
);

test(
  "a PowerPoint deck becomes one page per slide at the slide's own size, in the order the file lists",
  async (t) => {
    await boot(t);

    // slide2.xml is asked for first, and the third part is not called slide3,
    // so file order and sldIdLst order disagree twice over.
    const shapesFor = (title) =>
      textBox(72, 40, 540, 90, [{ text: title, sz: 2800, b: true }]) +
      textBox(72, 216, 648, 144, [{ text: "Supporting note for " + title, sz: 1400 }]);

    // A File does not survive being passed into the page, so the deck is built
    // and converted in one go.
    const pdf = await t.page.evaluate(
      async (args) =>
        await window.officeFixtures.pptxToPdf({
          name: "pitch.pptx",
          cx: 12192000,
          cy: 6858000,
          slides: [
            { relId: "rId2", file: "slide1.xml", xml: args.first },
            {
              relId: "rId1",
              file: "slide2.xml",
              xml: args.second,
              rels: [{ id: "rId1", target: "../media/image1.png" }],
              media: [{ name: "image1.png", relId: "rId1", base64: args.png }],
            },
            { relId: "rId3", file: "slide7.xml", xml: args.third },
          ],
        }),
      {
        png: makePng().toString("base64"),
        first: slideXml(shapesFor("Opening slide")),
        second: slideXml(shapesFor("Closing slide") + pictureShape("rId1", 600, 360, 144, 144)),
        third: slideXml(shapesFor("Appendix slide")),
      }
    );

    await step("one page per slide", () => {
      assert.equal(pdf.pageCount, 3, `expected three slides, got ${pdf.pageCount} pages`);
      assert.equal(pdf.numPages, 3);
      assert.equal(pdf.stats.slides, 3, `slides counted: ${pdf.stats.slides}`);
    });

    await step("each page is the slide's own size, not A4", () => {
      for (const page of pdf.pages) {
        assert.ok(Math.abs(page.width - SLIDE.width) < 1, `page width ${page.width}`);
        assert.ok(Math.abs(page.height - SLIDE.height) < 1, `page height ${page.height}`);
      }
    });

    await step("the slides come out in the order sldIdLst gives, not file order", () => {
      assert.match(pdf.pages[0].text, /Opening slide/, `page 1 was: ${pdf.pages[0].text}`);
      assert.match(pdf.pages[1].text, /Closing slide/, `page 2 was: ${pdf.pages[1].text}`);
      assert.match(pdf.pages[2].text, /Appendix slide/, `page 3 was: ${pdf.pages[2].text}`);
    });

    await step("each shape's text and its supporting line are both there", () => {
      const found = inOrder(allText(pdf), [
        "Opening slide",
        "Supporting note for Opening slide",
        "Closing slide",
        "Supporting note for Closing slide",
        "Appendix slide",
        "Supporting note for Appendix slide",
      ]);
      assert.equal(found.ok, true, `missing or out of order: ${found.missing}`);
    });

    await step("the picture is drawn on the slide that carries it", () => {
      const perPage = pdf.pages.map((page) => page.images.length);
      assert.ok(perPage[1] >= 1, `slide 2 should carry the picture, it drew ${perPage[1]}`);
      const size = pdf.pages[1].images[0];
      assert.ok(size.w > 0 && size.h > 0, "the picture was drawn with no size");
      assert.ok(size.w <= SLIDE.width && size.h <= SLIDE.height, "the picture is bigger than its slide");
    });

    await step("nothing is drawn off the slide", () => {
      assert.deepEqual(offPage(pdf), []);
    });

    await step("slide titles are set larger than the note beneath them", () => {
      const title = findCell(pdf, "Opening slide")[0];
      const note = findCell(pdf, "Supporting note for Opening slide")[0];
      assert.ok(title && note, "a slide's text is missing");
      assert.ok(title.height > note.height, `title ${title.height}pt against note ${note.height}pt`);
    });

    await step("a shape at the top of the slide is at the top of the page", () => {
      // The title box sits 40pt from the top of a 540pt slide, so it belongs
      // near y = 500. A page that keeps the slide's coordinates without turning
      // the origin over puts it near the foot instead.
      const title = findCell(pdf, "Opening slide")[0];
      const note = findCell(pdf, "Supporting note for Opening slide")[0];
      assert.ok(title.y > SLIDE.height - 100, `the title is ${(SLIDE.height - title.y).toFixed(0)}pt from the top of the slide instead of 40pt`);
      assert.ok(note.y < title.y - 100, "the note below the title was drawn above it");
    });

    assertPlainEnglish(pdf.warnings);
  },
  BLANK
);

test(
  "a spreadsheet becomes one page per sheet, with the cell types resolved",
  async (t) => {
    await boot(t);

    const shared = ["Second sheet header", "Second sheet footer", "First sheet header", "First sheet footer"];
    const secondSheet = sheetXml(
      row(1, sharedCell("A1", 0) + sharedCell("B1", 1)) +
        row(2, inlineCell("A2", "Inline text") + '<c r="B2" t="str"><f>CONCAT(1,2)</f><v>12</v></c>') +
        row(3, '<c r="A3" t="b"><v>1</v></c>' + numberCell("B3", 42.5)) +
        row(4, '<c r="A4" s="1"/>' + numberCell("B4", 7))
    );
    const firstSheet = sheetXml(
      row(1, sharedCell("A1", 2) + sharedCell("B1", 3)) + row(2, sharedCell("A2", 0)),
      '<col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/>'
    );

    const pdf = await t.page.evaluate(
      async (args) =>
        await window.officeFixtures.xlsxToPdf({
          name: "budget.xlsx",
          shared: args.shared,
          // The sheet parts are named the other way round from the order the
          // workbook lists, so the relationships have to be followed.
          sheets: [
            { name: "Second", relId: "rId1", file: "worksheets/sheetB.xml", xml: args.second },
            { name: "First", relId: "rId2", file: "worksheets/sheetA.xml", xml: args.first },
          ],
        }),
      { shared, second: secondSheet, first: firstSheet }
    );

    await step("one page per sheet", () => {
      assert.equal(pdf.pageCount, 2, `expected two pages, got ${pdf.pageCount}`);
      assert.equal(pdf.stats.sheets, 2, `sheets counted: ${pdf.stats.sheets}`);
      for (const page of pdf.pages) {
        assert.ok(Math.abs(page.width - A4.width) < 1, `page width ${page.width}`);
        assert.ok(Math.abs(page.height - A4.height) < 1, `page height ${page.height}`);
      }
    });

    await step("sheets come out in workbook order", () => {
      assert.match(pdf.pages[0].text, /Second sheet header/, `page 1 was: ${pdf.pages[0].text}`);
      assert.match(pdf.pages[1].text, /First sheet header/, `page 2 was: ${pdf.pages[1].text}`);
    });

    await step("a shared string is looked up by its index", () => {
      const found = inOrder(allText(pdf), [
        "Second sheet header",
        "Second sheet footer",
        "First sheet header",
        "First sheet footer",
      ]);
      assert.equal(
        found.ok,
        true,
        `missing or out of order: ${found.missing} (the page reads: ${pdf.pages[0].text.slice(0, 120)})`
      );
    });

    await step("no cell value is quietly shortened to fit its column", () => {
      const shortened = linesOf(pdf).filter((line) => /…|\.\.\./.test(line.text));
      assert.deepEqual(
        shortened.map((line) => line.text),
        [],
        "a cell was cut short with an ellipsis and nothing in warnings says so"
      );
    });

    await step("inline, string, boolean, number and empty cells are all rendered", () => {
      const text = allText(pdf);
      assert.match(text, /Inline text/, "an inline string was lost");
      assert.match(text, /12/, "a formula's string value was lost");
      assert.match(text, /42\.5/, "a number was lost");
      assert.match(text, /true|TRUE|1/, "a boolean cell was lost");
      assert.match(text, /7/, "a plain number cell was lost");
    });

    await step("cells sit in their own column and row", () => {
      const left = findCell(pdf, "Second sheet header")[0];
      const right = findCell(pdf, "Second sheet footer")[0];
      const below = findCell(pdf, "Inline text")[0];
      assert.ok(left && right && below, "a cell is missing");
      assert.ok(right.x > left.x + 20, `the second column did not move right (${right.x} against ${left.x})`);
      assert.ok(below.y < left.y - 5, "the second row did not sit below the first");
    });

    await step("the sheet is ruled, so it still reads as a spreadsheet", () => {
      const total = pdf.pages.reduce((sum, page) => sum + page.pathCount, 0);
      assert.ok(total > 0, "no gridlines were drawn");
    });

    await step("nothing is drawn off the page", () => {
      assert.deepEqual(offPage(pdf), []);
      assert.deepEqual(outsideMargins(pdf), []);
    });

    assertPlainEnglish(pdf.warnings);
  },
  BLANK
);

test(
  "a long sheet runs over several pages and repeats its header row",
  async (t) => {
    await boot(t);

    const rows = [row(1, inlineCell("A1", "Row number") + inlineCell("B1", "Value"))];
    for (let i = 2; i <= 220; i++) {
      rows.push(row(i, inlineCell("A" + i, "Record " + i) + numberCell("B" + i, i * 3)));
    }
    const pdf = await t.page.evaluate(
      async (args) =>
        await window.officeFixtures.xlsxToPdf({
          name: "long.xlsx",
          sheets: [{ name: "Data", relId: "rId1", file: "worksheets/sheet1.xml", xml: args.xml }],
        }),
      { xml: sheetXml(rows.join("")) }
    );

    await step("more than one page", () => {
      assert.ok(pdf.pageCount >= 2, `220 rows should not fit on ${pdf.pageCount} page`);
    });

    await step("the header row is repeated on every page", () => {
      pdf.pages.forEach((page, index) => {
        assert.match(page.text, /Row number/, `page ${index + 1} has no header row: ${page.text.slice(0, 120)}`);
      });
    });

    await step("nothing was dropped, in order, right through to the last row", () => {
      const found = inOrder(allText(pdf), ["Record 2", "Record 50", "Record 120", "Record 219", "Record 220"]);
      assert.equal(found.ok, true, `missing or out of order: ${found.missing}`);
    });

    await step("no text is left below the page", () => {
      assert.deepEqual(offPage(pdf), []);
      assert.deepEqual(outsideMargins(pdf), []);
    });

    assertPlainEnglish(pdf.warnings);
  },
  BLANK
);

test(
  "text outside the standard PDF font is replaced, counted and explained",
  async (t) => {
    await boot(t);

    const body = docxBody(
      para("Opening line in English.") +
        para("नमस्ते दुनिया") +
        para("你好世界") +
        para("Здравствуйте") +
        para("Ship it 🚀 today.") +
        para("Closing line in English.")
    );
    const pdf = await t.page.evaluate(
      async (xml) => await window.officeFixtures.convertAndRead(await window.officeFixtures.docx({ body: xml, name: "world.docx" })),
      body
    );

    await step("the conversion still finishes", () => {
      assert.equal(pdf.header, "%PDF-");
      assert.ok(pdf.pageCount >= 1);
    });

    await step("the warning names the problem and what to do about it", () => {
      assertPlainEnglish(pdf.warnings);
      const said = pdf.warnings.join(" ");
      assert.match(said, /font/i, `no warning about the font: ${said}`);
      assert.match(said, /Hindi|Chinese|emoji|non-Latin|characters/i, `the warning does not say what was lost: ${said}`);
      assert.match(said, /\?/, "the warning should say the characters became a question mark");
      assert.match(said, /Word|Excel|export|full fidelity|try/i, `the warning gives no way forward: ${said}`);
    });

    await step("the characters were counted, not lost silently", () => {
      assert.equal(typeof pdf.stats.droppedCharacters, "number", `droppedCharacters should be a number, got: ${pdf.stats.droppedCharacters}`);
      assert.ok(pdf.stats.droppedCharacters >= 8, `droppedCharacters: ${pdf.stats.droppedCharacters}`);
    });

    await step("the English around them survived, in order", () => {
      const found = inOrder(allText(pdf), ["Opening line in English.", "Closing line in English."]);
      assert.equal(found.ok, true, `missing or out of order: ${found.missing}`);
    });

    await step("something visible was put in place of the lost text", () => {
      assert.match(allText(pdf), /\?/, "no placeholder was drawn for the text that could not be encoded");
    });

    await step("a document that needs no such warning drops no characters", async () => {
      const clean = await t.page.evaluate(
        async (xml) => await window.officeFixtures.convertAndRead(await window.officeFixtures.docx({ body: xml, name: "ascii.docx" })),
        docxBody(para("Only plain English in this one."))
      );
      assert.ok(!clean.stats.droppedCharacters, `droppedCharacters: ${clean.stats.droppedCharacters}`);
    });
  },
  BLANK
);

test(
  "every conversion reports what it could not reproduce",
  async (t) => {
    await boot(t);

    const pdf = await t.page.evaluate(
      async (body) => await window.officeFixtures.convertAndRead(await window.officeFixtures.docx({ name: "plain.docx", body })),
      docxBody(para("Just a sentence."))
    );

    assertPlainEnglish(pdf.warnings);
    await step("a document is never converted without a word about the limits", () => {
      assert.ok(
        pdf.warnings.length > 0,
        "no warnings at all: nothing tells the user that fonts, colours and the original layout were dropped"
      );
    });
  },
  BLANK
);

test(
  "a file that is not an Office document is refused in plain English",
  async (t) => {
    await boot(t);

    const outcomes = await t.page.evaluate(async () => ({
      garbage: await window.officeFixtures.settle(
        new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff, 0xfe, 0x42])], "salary.docx")
      ),
      // A perfectly good zip that has nothing to do with Word.
      notOffice: await window.officeFixtures.settle(
        window.officeFixtures.fileFrom(
          await window.officeFixtures.makeZip([{ path: "hello.txt", content: "just a text file" }]),
          "holiday.pptx"
        )
      ),
      // A zip with a spreadsheet name and no workbook in it.
      emptyZip: await window.officeFixtures.settle(
        window.officeFixtures.fileFrom(
          await window.officeFixtures.makeZip([{ path: "readme.txt", content: "nothing to see" }]),
          "book.xlsx"
        )
      ),
    }));

    for (const [key, fileName] of [
      ["garbage", "salary.docx"],
      ["notOffice", "holiday.pptx"],
      ["emptyZip", "book.xlsx"],
    ]) {
      await step(`${fileName} is refused with a sentence a person can act on`, () => {
        const outcome = outcomes[key];
        assert.equal(outcome.rejected, true, `expected a refusal, got ${JSON.stringify(outcome).slice(0, 200)}`);
        assertSentence(outcome.message, fileName);
      });
    }

    assert.deepEqual(t.pageErrors, []);
  },
  { ...BLANK, pageErrors: false }
);

test(
  "a broken package is refused in plain English rather than half converted",
  async (t) => {
    await boot(t);

    const outcomes = await t.page.evaluate(async (args) => ({
      // A .docx with no word/document.xml at all.
      noMain: await window.officeFixtures.settle(
        window.officeFixtures.fileFrom(
          await window.officeFixtures.makeZip([{ path: "word/styles.xml", content: "<w:styles/>" }]),
          "incomplete.docx"
        )
      ),
      // Markup that is not well formed.
      badXml: await window.officeFixtures.settle(
        await window.officeFixtures.docx({ body: "<w:document><w:body><w:p><w:r><w:t>oops</w:body>", name: "malformed.docx" })
      ),
      // A picture whose relationship resolves to nothing.
      missingRel: await window.officeFixtures.settle(
        await window.officeFixtures.docx({ name: "dangling.docx", body: args.dangling, rels: [] })
      ),
    }), {
      dangling: docxBody(
        para("Text before the broken picture.") + drawingPara("rId999", 1828800) + para("Text after the broken picture.")
      ),
    });

    await step("a package with no main part is refused", () => {
      assert.equal(outcomes.noMain.rejected, true, `expected a refusal, got ${JSON.stringify(outcomes.noMain)}`);
      assertSentence(outcomes.noMain.message, "incomplete.docx");
    });

    await step("markup that will not parse is refused, or at least explained", () => {
      const outcome = outcomes.badXml;
      if (outcome.rejected) assertSentence(outcome.message, "malformed.docx");
      else assertPlainEnglish(outcome.warnings);
    });

    await step("a picture whose relationship is missing costs a warning, not the document", () => {
      const outcome = outcomes.missingRel;
      assert.equal(outcome.rejected, false, `the whole document was thrown away: ${outcome.message}`);
      assertPlainEnglish(outcome.warnings);
      assert.ok(outcome.warnings.length > 0, "a missing image was dropped without saying so");
    });

    assert.deepEqual(t.pageErrors, []);
  },
  { ...BLANK, pageErrors: false }
);

test(
  "an empty document gets a clear message instead of a blank PDF",
  async (t) => {
    await boot(t);

    const outcomes = await t.page.evaluate(async (args) => ({
      docx: await window.officeFixtures.settle(
        await window.officeFixtures.docx({
          name: "empty.docx",
          body:
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:body></w:document>',
        })
      ),
      pptx: await window.officeFixtures.settle(
        await window.officeFixtures.pptx({ name: "empty.pptx", cx: 12192000, cy: 6858000, slides: [] })
      ),
      xlsx: await window.officeFixtures.settle(await window.officeFixtures.xlsx({ name: "empty.xlsx", sheets: [] })),
      blankSlide: await window.officeFixtures.settle(
        await window.officeFixtures.pptx({
          name: "blank.pptx",
          cx: 12192000,
          cy: 6858000,
          slides: [{ relId: "rId1", file: "slide1.xml", xml: args.blankSlide }],
        })
      ),
    }), { blankSlide: slideXml("") });

    for (const key of ["docx", "pptx", "xlsx"]) {
      await step(`an empty .${key} is refused in words`, () => {
        const outcome = outcomes[key];
        assert.equal(outcome.rejected, true, `expected a refusal, got ${JSON.stringify(outcome).slice(0, 200)}`);
        assertSentence(outcome.message, `empty.${key}`);
        assert.match(
          outcome.message,
          /empty|nothing|no (?:text|content|pages|slides|sheets)|could not find/i,
          `the message should say the document has nothing in it: ${outcome.message}`
        );
      });
    }

    await step("a slide with no shapes is not the same as no slides at all", () => {
      const outcome = outcomes.blankSlide;
      // One blank page or an honest complaint are both defensible; a crash or
      // a silent failure is not.
      if (outcome.rejected) assertSentence(outcome.message, "blank.pptx");
      else {
        assert.ok(outcome.pageCount >= 1, "a slide produced no pages at all");
        assertPlainEnglish(outcome.warnings);
      }
    });

    assert.deepEqual(t.pageErrors, []);
  },
  { ...BLANK, pageErrors: false }
);

test(
  "an archive that claims to be huge is refused before anything is read",
  async (t) => {
    await boot(t);

    const outcome = await t.page.evaluate(async (body) => {
      const good = await window.officeFixtures.docx({ body, name: "bomb.docx" });
      const raw = new Uint8Array(await good.arrayBuffer());
      const bomb = window.officeFixtures.declareHugeSize(raw, 400 * 1024 * 1024);
      const started = performance.now();
      const result = await window.officeFixtures.settle(window.officeFixtures.fileFrom(bomb.bytes, "bomb.docx"));
      return Object.assign({}, result, { elapsed: performance.now() - started, patched: bomb.patched });
    }, docxBody(para("One small paragraph.")));

    await step("the declared size really was rewritten", () => {
      assert.ok(outcome.patched >= 2, `only ${outcome.patched} size fields were patched, so this fixture is not a bomb`);
    });

    await step("it is refused, and refused quickly", () => {
      assert.equal(outcome.rejected, true, `expected a refusal, got ${JSON.stringify(outcome).slice(0, 200)}`);
      assertSentence(outcome.message, "bomb.docx");
      assert.match(outcome.message, /too large|size|large|unpack|expand|big/i, `the message should say why: ${outcome.message}`);
      assert.ok(outcome.elapsed < 20000, `it took ${Math.round(outcome.elapsed)}ms, which is not a refusal`);
    });

    assert.deepEqual(t.pageErrors, []);
  },
  { ...BLANK, pageErrors: false }
);

test(
  "an archive with an absurd number of parts is refused",
  async (t) => {
    await boot(t);

    // 20,000 parts is past any threshold a browser tool would consider sane.
    const outcome = await t.page.evaluate(async () => {
      const many = await window.officeFixtures.manyEntries(20000, "flood.xlsx");
      const started = performance.now();
      const result = await window.officeFixtures.settle(many);
      return Object.assign({}, result, { elapsed: performance.now() - started });
    });

    assert.equal(outcome.rejected, true, `expected a refusal, got ${JSON.stringify(outcome).slice(0, 200)}`);
    assertSentence(outcome.message, "flood.xlsx");
    assert.ok(outcome.elapsed < 20000, `it took ${Math.round(outcome.elapsed)}ms, which is not a refusal`);
    assert.deepEqual(t.pageErrors, []);
  },
  { ...BLANK, pageErrors: false }
);

test(
  "progress is reported while the work happens, and the callback is optional",
  async (t) => {
    await boot(t);

    const result = await t.page.evaluate(async (args) => {
      const calls = [];
      const watched = await window.officeFixtures.convertAndRead(
        await window.officeFixtures.docx({ name: "watched.docx", body: args.watched }),
        {
          onProgress: (done, total, label) => {
            calls.push([done, total, String(label)]);
          },
        }
      );
      const quiet = await window.officeFixtures.convertAndRead(
        await window.officeFixtures.docx({ name: "quiet.docx", body: args.quiet })
      );
      return { calls, watchedPages: watched.pageCount, quietPages: quiet.pageCount, quietText: quiet.pages[0].text };
    }, {
      watched: docxBody(
        Array.from({ length: 40 }, (_, i) => para("Line " + (i + 1) + " of a document being converted.")).join("")
      ),
      quiet: docxBody(para("No callback here.")),
    });

    await step("onProgress was called with numbers that make sense", () => {
      assert.ok(result.calls.length > 0, "onProgress was never called");
      for (const [done, total] of result.calls) {
        assert.equal(typeof done, "number", `done was ${done}`);
        assert.equal(typeof total, "number", `total was ${total}`);
        assert.ok(total >= 1, `total should be at least 1, got ${total}`);
        assert.ok(done <= total, `done ${done} is past total ${total}`);
      }
      for (const [, , label] of result.calls) {
        assert.equal(typeof label, "string", "label should be text");
      }
    });

    await step("progress moves forwards", () => {
      const done = result.calls.map((call) => call[0]);
      for (let i = 1; i < done.length; i++) {
        assert.ok(done[i] >= done[i - 1], `progress went backwards: ${done[i - 1]} then ${done[i]}`);
      }
    });

    await step("the callback is optional", () => {
      assert.equal(result.quietPages, 1);
      assert.match(result.quietText, /No callback here/);
    });
  },
  BLANK
);

test(
  "converting never sends the file anywhere",
  async (t) => {
    await boot(t);

    await t.page.evaluate(
      async (body) =>
        await window.officeFixtures.convertAndRead(await window.officeFixtures.docx({ name: "private.docx", body })),
      docxBody(para("Confidential payroll figures."))
    );

    assert.deepEqual(t.requestsWithBody(), [], "something was uploaded");
    assert.deepEqual(t.foreignRequests(), [], "a request went somewhere other than the site or the library CDN");
    const cdn = t.requests.filter((request) => request.url.startsWith("https://cdnjs.cloudflare.com/"));
    assert.ok(cdn.length > 0, "the ZIP and PDF libraries should have come from the CDN");
    for (const request of cdn) {
      assert.ok(/jszip|pdf-lib|pdf\.js/.test(request.url), `an unexpected CDN request: ${request.url}`);
    }
  },
  BLANK
);

test(
  "toPdf always settles, whatever it is handed",
  async (t) => {
    await boot(t);

    const outcomes = await t.page.evaluate(async () => {
      const inputs = {
        nullInput: null,
        number: 7,
        string: "report.docx",
        emptyObject: {},
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" }),
        truncatedZip: new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])], "cut.docx"),
        emptyFile: new File([], "void.docx"),
      };
      const out = {};
      for (const key of Object.keys(inputs)) {
        try {
          const result = await SwiftOffice.toPdf(inputs[key]);
          out[key] = {
            rejected: false,
            warnings: result.warnings,
            header: String.fromCharCode.apply(null, result.bytes.slice(0, 5)),
            pages: result.pageCount,
          };
        } catch (err) {
          out[key] = { rejected: true, message: String(err && err.message ? err.message : err) };
        }
      }
      return out;
    });

    for (const [key, outcome] of Object.entries(outcomes)) {
      await step(`${key} settles with an answer`, () => {
        assert.equal(typeof outcome.rejected, "boolean", "the call neither resolved nor rejected");
        if (outcome.rejected) {
          assert.ok(outcome.message.length > 10, `the message is too terse: ${outcome.message}`);
          assert.doesNotMatch(outcome.message, JARGON, `an internal error leaked: ${outcome.message}`);
        } else {
          assert.equal(outcome.header, "%PDF-", "it resolved with something that is not a PDF");
          assertPlainEnglish(outcome.warnings);
        }
      });
    }

    assert.deepEqual(t.pageErrors, []);
  },
  { ...BLANK, pageErrors: false }
);
