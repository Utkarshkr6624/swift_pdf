// word-to-pdf.html — the four-by-four converter, driven the way a person drives it.
//
// The page is the whole product: twelve real source/target pairs, no build step,
// no server, nothing sent anywhere. So nothing here is mocked. The office
// fixtures are built in the browser with the project's own JSZip, the PDF
// fixtures are real PDFs, every conversion runs in the page, and every result is
// opened again and read back — the office files with JSZip, the PDFs with pdf.js.
//
// Two promises are load-bearing and are checked on every one of the twelve:
//
//   * the page never claims more than it does. Each conversion says what it
//     keeps and what it does not, and a document rebuilt from extracted text has
//     to admit that. A conversion that produced nothing must not hand over a
//     blank file as if it had.
//   * the file never leaves. A conversion that reaches a foreign origin, or that
//     sends a request with a body, fails the test that ran it.
//
// The from/to picker is found by *what it is* rather than by an id, so this spec
// survives the page being re-skinned: it looks for a control that offers the
// four formats (a <select>), or a run of single-format controls (pills or
// radios), and works out which is the source and which is the target from the
// text around them, falling back to the order they appear in. A page with no
// such control fails the test with a description of what it found instead.
import { Buffer } from "node:buffer";
import { test, assert, step } from "../lib/harness.mjs";
import { makePdfFile, makeBrokenPdfFile } from "../lib/fixtures.mjs";
import { addFiles, waitForResultBar, statusText } from "../lib/browser.mjs";

const PAGE = { path: "/word-to-pdf.html" };
const PHONE = { width: 390, height: 844 };

/* ------------------------------------------------------------------ *
 * The four formats and the twelve pairs. A format is never converted
 * to itself, so those four combinations do not exist.
 * ------------------------------------------------------------------ */

const ORDER = ["pdf", "word", "excel", "powerpoint"];

const FORMATS = {
  pdf: { name: "PDF", ext: "pdf", file: "quarterly.pdf", marker: "SwiftPDF" },
  word: { name: "Word", ext: "docx", file: "quarterly.docx", marker: "Quarterly" },
  excel: { name: "Excel", ext: "xlsx", file: "budget.xlsx", marker: "Balance" },
  powerpoint: { name: "PowerPoint", ext: "pptx", file: "roadmap.pptx", marker: "Roadmap" },
};

// What a piece of user-facing text might call each format. Matched as whole
// words so "Word" cannot be found inside "download".
const FORMAT_WORDS = {
  pdf: /\b(pdf)\b/i,
  word: /\b(word|docx)\b/i,
  excel: /\b(excel|xlsx|spreadsheet)\b/i,
  powerpoint: /\b(powerpoint|pptx|slides?|presentation|deck)\b/i,
};

const PAIRS = ORDER.flatMap((from) => ORDER.filter((to) => to !== from).map((to) => ({ from, to })));
const label = (key) => FORMATS[key].name;
const pairName = ({ from, to }) => `${label(from)} to ${label(to)}`;
// Everything except the three Office-to-PDF pairs is a document rebuilt out of
// extracted text, and has to be described that way.
const isRebuilt = ({ to }) => to !== "pdf";

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/* ------------------------------------------------------------------ *
 * Fixture builders. This function is stringified into the browser, so
 * it must not close over anything in this file.
 * ------------------------------------------------------------------ */
function fixtureHelpers() {
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
  const NS_SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const NS_PML = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

  const esc = (text) =>
    String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // A content-types part built from the parts themselves, so a fixture is a
  // package a strict reader accepts rather than one that only works because the
  // reader happens to be lenient.
  function types(overrides) {
    let out =
      XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>';
    for (const [part, type] of Object.entries(overrides)) {
      out += '<Override PartName="/' + part + '" ContentType="' + type + '"/>';
    }
    return out + "</Types>";
  }

  const rels = (list) =>
    XML +
    '<Relationships xmlns="' +
    PKG +
    '">' +
    (list || [])
      .map(
        (rel) =>
          '<Relationship Id="' +
          rel.id +
          '" Type="' +
          (rel.type || REL + "/officeDocument") +
          '" Target="' +
          rel.target +
          '"/>'
      )
      .join("") +
    "</Relationships>";

  async function zip(parts, overrides) {
    const JSZip = await loadJsZip();
    const archive = new JSZip();
    archive.file("[Content_Types].xml", types(overrides || {}));
    for (const [path, body] of Object.entries(parts)) archive.file(path, body);
    return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  const asFile = (bytes, name) => new File([bytes], name);

  /* ---------- Word ---------- */

  const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="' + REL + '"';
  const wPara = (text, style) =>
    "<w:p>" + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : "") + "<w:r><w:t>" + esc(text) + "</w:t></w:r></w:p>";
  const wCell = (text) => "<w:tc><w:tcPr/>" + wPara(text) + "</w:tc>";
  const wRow = (cells) => "<w:tr>" + cells.map(wCell).join("") + "</w:tr>";

  async function docx(name = "quarterly.docx", options) {
    const opts = options || {};
    const body =
      opts.empty === true
        ? "<w:p/>"
        : wPara("Quarterly Report", "Heading1") +
          "<w:p><w:r><w:t>Revenue grew without leaving the device.</w:t></w:r></w:p>" +
          '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>' +
          '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second point</w:t></w:r></w:p>' +
          "<w:tbl>" +
          wRow(["Region", "Revenue"]) +
          wRow(["North", "1200"]) +
          wRow(["South", "900"]) +
          "</w:tbl>";
    const bytes = await zip(
      {
        "word/document.xml": XML + "<w:document " + W_NS + "><w:body>" + body + "</w:body></w:document>",
        "word/styles.xml":
          XML +
          '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
          "</w:styles>",
        "word/_rels/document.xml.rels": rels([]),
      },
      {
        "word/document.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
      }
    );
    return asFile(bytes, name);
  }

  /* ---------- Excel ---------- */

  const inlineCell = (ref, text) => '<c r="' + ref + '" t="inlineStr"><is><t>' + esc(text) + "</t></is></c>";
  const sheetRow = (n, values) =>
    '<row r="' + n + '">' + values.map((value, i) => inlineCell(String.fromCharCode(65 + i) + n, value)).join("") + "</row>";

  async function xlsx(name = "budget.xlsx", options) {
    const opts = options || {};
    const rows =
      opts.empty === true
        ? [sheetRow(1, [""])]
        : [sheetRow(1, ["Balance sheet"]), sheetRow(2, ["Region", "Revenue"]), sheetRow(3, ["North", "1200"])];
    const bytes = await zip(
      {
        "xl/workbook.xml":
          XML +
          '<workbook xmlns="' +
          NS_SML +
          '" xmlns:r="' +
          REL +
          '"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": rels([{ id: "rId1", type: REL + "/worksheet", target: "worksheets/sheet1.xml" }]),
        "xl/worksheets/sheet1.xml": XML + '<worksheet xmlns="' + NS_SML + '"><sheetData>' + rows.join("") + "</sheetData></worksheet>",
      },
      {
        "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "xl/worksheets/sheet1.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
      }
    );
    return asFile(bytes, name);
  }

  /* ---------- PowerPoint ---------- */

  const EMU = 12700;
  const shape = (x, y, cx, cy, lines) =>
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' +
    Math.round(x * EMU) +
    '" y="' +
    Math.round(y * EMU) +
    '"/><a:ext cx="' +
    Math.round(cx * EMU) +
    '" cy="' +
    Math.round(cy * EMU) +
    '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>' +
    lines.map((line) => '<a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>' + esc(line) + "</a:t></a:r></a:p>").join("") +
    "</p:txBody></p:sp>";

  const slideXml = (title, lines) =>
    XML +
    '<p:sld xmlns:p="' +
    NS_PML +
    '" xmlns:a="' +
    NS_A +
    '" xmlns:r="' +
    REL +
    '"><p:cSld><p:spTree><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shape(40, 40, 880, 120, title) +
    shape(40, 200, 880, 300, lines) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

  async function pptx(name = "roadmap.pptx", options) {
    const opts = options || {};
    // An "empty" deck still has its shape outlines, so the only thing that makes
    // it empty is that no shape carries any text.
    const title = opts.empty === true ? [""] : ["Roadmap review"];
    const slides = [
      { file: "slide1.xml", lines: opts.empty === true ? [""] : ["First milestone", "Second milestone"] },
      { file: "slide2.xml", lines: opts.empty === true ? [""] : ["Third milestone"] },
    ];
    const parts = {
      "ppt/presentation.xml":
        XML +
        '<p:presentation xmlns:p="' +
        NS_PML +
        '" xmlns:a="' +
        NS_A +
        '" xmlns:r="' +
        REL +
        '"><p:sldIdLst>' +
        slides.map((slide, i) => '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 1) + '"/>').join("") +
        '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
      "ppt/_rels/presentation.xml.rels": rels(
        slides.map((slide, i) => ({ id: "rId" + (i + 1), type: REL + "/slide", target: "slides/" + slide.file }))
      ),
    };
    const overrides = {
      "ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    };
    for (const slide of slides) {
      parts["ppt/slides/" + slide.file] = slideXml(title, slide.lines);
      parts["ppt/slides/_rels/" + slide.file + ".rels"] = rels([]);
      overrides["ppt/slides/" + slide.file] = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
    }
    return asFile(await zip(parts, overrides), name);
  }

  /* ---------- PDFs built with the site's own pdf-lib ---------- */

  // The words these two PDFs are made of. A test that converts them checks the
  // output against this list, so "the conversion got better" cannot quietly
  // come at the price of losing a word.
  const REVIEW_WORDS = [
    "Quarterly", "Business", "Review", "Prepared", "by", "the", "finance", "team", "for", "board",
    "Revenue", "grew", "across", "every", "region", "this", "quarter,", "driven", "new",
    "enterprise", "agreements", "signed", "in", "second", "half", "of", "year", "and", "renewals",
    "existing", "accounts.", "Costs", "stayed", "flat,", "so", "margin", "improved", "four", "points",
    "against", "same", "period", "last", "year.",
    "Region", "Q1", "Q2", "Q3", "North", "120", "138", "171", "South", "90", "95", "110",
    "Outlook", "Margins", "should", "hold", "next", "quarter", "as", "headcount", "is", "frozen.",
  ];

  // A PDF laid out the way a business page is: a title, a subtitle, body lines
  // and a four-column grid, over two pages. Every word is drawn as one item at a
  // known position, which is exactly what pdf.js hands the reader back.
  async function structuredPdf(name = "review.pdf") {
    const PDFLib = await loadPdfLib();
    const doc = await PDFLib.PDFDocument.create();
    const plain = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const columns = [56, 170, 240, 310];

    const one = doc.addPage([595.28, 841.89]);
    one.drawText("Quarterly Business Review", { x: 56, y: 780, size: 24, font: bold });
    one.drawText("Prepared by the finance team for the board", { x: 56, y: 742, size: 13, font: plain });
    [
      "Revenue grew across every region this quarter, driven by the new",
      "enterprise agreements signed in the second half of the year and by",
      "renewals in the existing accounts. Costs stayed flat, so the margin",
      "improved by four points against the same period last year.",
    ].forEach((line, index) => one.drawText(line, { x: 56, y: 700 - index * 16, size: 10, font: plain }));
    [
      [["Region", true], ["Q1", true], ["Q2", true], ["Q3", true]],
      [["North", false], ["120", false], ["138", false], ["171", false]],
      [["South", false], ["90", false], ["95", false], ["110", false]],
    ].forEach((cells, row) => {
      cells.forEach(([value, strong], column) => {
        one.drawText(value, { x: columns[column], y: 600 - row * 22, size: 9, font: strong ? bold : plain });
      });
    });

    const two = doc.addPage([595.28, 841.89]);
    two.drawText("Outlook", { x: 56, y: 780, size: 20, font: bold });
    ["Margins should hold next quarter as", "headcount is frozen."].forEach((line, index) => {
      two.drawText(line, { x: 56, y: 740 - index * 16, size: 10, font: plain });
    });

    return asFile(await doc.save(), name);
  }

  // One long paragraph of prose, wrapped the way a word processor wraps it: many
  // lines, all the same size, none of them a grid. The reader must leave this
  // alone - no table, no pile of headings.
  async function prosePdf(name = "memo.pdf") {
    const PDFLib = await loadPdfLib();
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const page = doc.addPage([595.28, 841.89]);
    [
      "This memo is one paragraph of ordinary prose written to check that a page",
      "of running text is left as running text, because a reader that decides",
      "every wide gap is a column turns a letter into a table and a page of",
      "writing into a page of headings, which is worse than saying nothing.",
    ].forEach((line, index) => page.drawText(line, { x: 56, y: 700 - index * 16, size: 10, font }));
    return asFile(await doc.save(), name);
  }

  // A Word file carrying one large picture. The compression option only shows
  // on the way out to a PDF, so the thing that has to be compressible has to
  // arrive as an office file - and a picture is the only part of a document
  // that re-rendering makes measurably smaller.
  async function imageDocx(name = "photos.docx") {
    const canvas = document.createElement("canvas");
    canvas.width = 1400;
    canvas.height = 1400;
    const paint = canvas.getContext("2d");
    const wash = paint.createLinearGradient(0, 0, 1400, 1400);
    wash.addColorStop(0, "#2f6bff");
    wash.addColorStop(0.45, "#dfe8ff");
    wash.addColorStop(1, "#0d1c46");
    paint.fillStyle = wash;
    paint.fillRect(0, 0, 1400, 1400);
    paint.fillStyle = "#ffffff";
    paint.font = "140px sans-serif";
    paint.fillText("SwiftPDF", 120, 320);
    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/jpeg", 0.95);
    });
    const bytes = new Uint8Array(await jpeg.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);

    const drawing =
      "<w:p><w:r><w:drawing>" +
      '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="5486400" cy="5486400"/><wp:docPr id="1" name="Picture 1"/>' +
      '<a:graphic xmlns:a="' + NS_A + '"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr><pic:cNvPr id="1" name="image1.jpg"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="5486400"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>";

    const archive = new (await loadJsZip())();
    archive.file(
      "[Content_Types].xml",
      XML +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="jpg" ContentType="image/jpeg"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>"
    );
    archive.file("word/document.xml", XML + "<w:document " + W_NS + "><w:body>" + wPara("Quarterly photo plate") + drawing + "</w:body></w:document>");
    archive.file("word/_rels/document.xml.rels", rels([{ id: "rId1", type: REL + "/image", target: "media/image1.jpg" }]));
    archive.file("word/media/image1.jpg", binary, { binary: true });
    return asFile(await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" }), name);
  }

  /* ---------- damaged files ---------- */

  // Bytes that are not a zip at all: what a truncated download or a file with
  // the wrong extension looks like.
  function brokenOffice(name = "damaged.docx") {
    return asFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), name);
  }

  // A real, readable zip that is not a document: the half-written file a crash
  // or an interrupted sync leaves behind.
  async function hollowOffice(name = "damaged.docx") {
    return asFile(await zip({ "notes.txt": "this was never a Word document" }, {}), name);
  }

  return { docx, xlsx, pptx, brokenOffice, hollowOffice, structuredPdf, prosePdf, imageDocx, REVIEW_WORDS };
}

/* ------------------------------------------------------------------ *
 * Finding the "convert from" and "convert to" controls. Also
 * stringified into the browser, so it closes over nothing.
 * ------------------------------------------------------------------ */
function pickerHelpers() {
  const ALIAS = {
    pdf: ["pdf"],
    word: ["word", "docx"],
    excel: ["excel", "xlsx", "spreadsheet"],
    powerpoint: ["powerpoint", "pptx", "slides", "presentation", "deck"],
  };

  // "fromFormat" has to read as two words, so camelCase is split before the
  // value is broken up.
  const tokens = (value) =>
    String(value == null ? "" : value)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

  // Which format a label or an option value is talking about, or null.
  function keyOf(...values) {
    const words = tokens(values.filter(Boolean).join(" "));
    for (const [key, names] of Object.entries(ALIAS)) {
      if (words.some((word) => names.includes(word))) return key;
    }
    return null;
  }

  const optionKeys = (select) => {
    const seen = [];
    for (const option of select.options) {
      const key = keyOf(option.value, option.textContent);
      if (key && !seen.includes(key)) seen.push(key);
    }
    return seen;
  };

  // Everything printed near a control that could say which of the two it is.
  function descriptor(el) {
    const bits = [
      el.id,
      el.getAttribute && el.getAttribute("name"),
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("data-role"),
      el.getAttribute && el.getAttribute("data-side"),
    ];
    const labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const node = document.getElementById(labelledBy);
      if (node) bits.push(node.textContent);
    }
    const label = el.closest && el.closest("label");
    if (label) bits.push(label.textContent);
    const fieldset = el.closest && el.closest("fieldset");
    if (fieldset && fieldset.querySelector("legend")) bits.push(fieldset.querySelector("legend").textContent);
    // The heading or caption sitting directly above the control.
    let host = el.parentElement;
    for (let depth = 0; host && depth < 3; depth++) {
      for (const child of host.children) {
        if (child === el || child.contains(el)) continue;
        const text = (child.textContent || "").trim();
        if (text && text.length <= 60) bits.push(text);
      }
      host = host.parentElement;
    }
    return tokens(bits.filter(Boolean).join(" "));
  }

  const wants = (list, words) => words.some((word) => list.includes(word));

  // One "which format" control: a <select> offering the formats, or a container
  // of single-format controls.
  function rawGroups() {
    const groups = [];
    for (const select of document.querySelectorAll("select")) {
      const keys = optionKeys(select);
      if (keys.length >= 3) groups.push({ el: select, kind: "select", keys });
    }
    if (groups.length) return groups;

    const singles = [];
    for (const el of document.querySelectorAll(".pill, [role=radio], input[type=radio], [data-format]")) {
      const key = keyOf(el.value, el.getAttribute("data-format"), el.getAttribute("data-value"), el.textContent);
      if (key) singles.push({ el, key });
    }
    const seen = new Set();
    for (const single of singles) {
      // Climb until the ancestor holds a whole row of choices, but no further:
      // two rows that share a parent have to stay two groups.
      let host = null;
      let walk = single.el.parentElement;
      for (let depth = 0; walk && depth < 3; depth++) {
        if (singles.filter((other) => walk.contains(other.el)).length >= 3) {
          host = walk;
          break;
        }
        walk = walk.parentElement;
      }
      if (!host || seen.has(host)) continue;
      seen.add(host);
      const inside = singles.filter((other) => host.contains(other.el));
      groups.push({ el: host, kind: "pills", keys: [...new Set(inside.map((other) => other.key))], singles: inside });
    }
    return groups;
  }

  // A shared parent holding both rows would have swallowed them into a single
  // group, so as a last resort a group holding twice the formats of one choice
  // is split back in two, in the order the choices appear.
  function groups() {
    let found = rawGroups();
    if (found.length === 1 && found[0].keys.length >= 6) {
      const all = found[0].singles;
      const half = Math.ceil(all.length / 2);
      const split = (part) => ({
        el: part[0].el.parentElement,
        kind: "pills",
        keys: [...new Set(part.map((item) => item.key))],
        singles: part,
      });
      found = [split(all.slice(0, half)), split(all.slice(half))];
    }
    const hints = found.map((group) => {
      const words = descriptor(group.el);
      if (wants(words, ["from", "source", "original", "input"])) return "from";
      if (wants(words, ["to", "into", "target", "output", "destination", "result"])) return "to";
      return null;
    });
    // Only trust the wording when it actually separates the two.
    const usable = hints.filter(Boolean).length === found.length && new Set(hints).size === found.length;
    return found.map((group, index) => ({
      el: group.el,
      kind: group.kind,
      keys: group.keys,
      role: usable ? hints[index] : index === 0 ? "from" : "to",
    }));
  }

  // The node a test should actually touch for `key` in the given row.
  function resolve(role, key) {
    const found = groups();
    const group = found.find((item) => item.role === role);
    if (!group) {
      const seen = found.map((item) =>
        item.kind === "select" ? "select#" + (item.el.id || "?") : "row of " + item.keys.join("/")
      );
      throw new Error(
        'no "convert ' + role + '" control found. The page offers: ' + (seen.length ? seen.join(", ") : "nothing that chooses a format")
      );
    }
    if (group.kind === "select") {
      for (const option of group.el.options) {
        if (keyOf(option.value, option.textContent) === key) {
          if (option.disabled) return { ok: false, why: "the " + key + " option is disabled" };
          return { ok: true, kind: "select", el: group.el, value: option.value, current: group.el.value };
        }
      }
      return { ok: false, why: "no " + key + " option in the " + role + " list" };
    }
    const hit = group.singles.find((single) => single.key === key);
    if (!hit) return { ok: false, why: "no " + key + " choice in the " + role + " row" };
    // A radio is often hidden behind its label, and the label is what a finger
    // lands on, so hand back whatever is actually visible.
    const el = hit.el;
    if (el.tagName === "INPUT" && el.type === "radio") {
      const box = el.getBoundingClientRect();
      const visible = box.width > 0 && box.height > 0;
      return { ok: true, kind: "click", el: visible ? el : el.closest("label") || el, value: el.value };
    }
    return { ok: true, kind: "click", el, value: null };
  }

  return { groups, resolve };
}

/* ------------------------------------------------------------------ *
 * Node-side helpers
 * ------------------------------------------------------------------ */

async function installHelpers(t) {
  await t.page.addScriptTag({ content: "window.converterFixtures = (" + fixtureHelpers.toString() + ")();" });
  await t.page.addScriptTag({ content: "window.converterUI = (" + pickerHelpers.toString() + ")();" });
  await t.page.waitForFunction(() => Boolean(window.converterFixtures && window.converterUI));
}

async function reload(t) {
  await t.page.goto(t.url("/word-to-pdf.html"), { waitUntil: "domcontentloaded" });
  await installHelpers(t);
}

// Chooses a format the way a person would: selectOption for a list, a tap for a
// pill. The node is resolved fresh every time, because a page is free to
// re-render its picker when the other side of the conversion changes.
async function setFormat(t, role, key) {
  const handle = await t.page.evaluateHandle(({ role, key }) => {
    try {
      return window.converterUI.resolve(role, key);
    } catch (err) {
      return { ok: false, why: err.message };
    }
  }, { role, key });
  const info = await handle.evaluate((node) => ({ ok: node.ok, why: node.why, kind: node.kind, value: node.value, current: node.current }));
  if (!info.ok) {
    await handle.dispose();
    assert.fail(`could not choose ${label(key)} as the ${role}: ${info.why}`);
  }
  const element = (await handle.getProperty("el")).asElement();
  if (!element) {
    await handle.dispose();
    assert.fail(`the ${label(key)} ${role} control has nothing to tap`);
  }
  if (info.kind === "select") {
    await element.selectOption(info.value);
    if (info.current === info.value) {
      // Already chosen: selectOption has nothing to change, so nudge the page
      // with the event it would have listened for anyway.
      await element.evaluate((node) => node.dispatchEvent(new Event("change", { bubbles: true })));
    }
  } else {
    await element.click({ timeout: 10000 });
  }
  await handle.dispose();
  // One choice updates the button, the accepted files and the hint; give the
  // page a turn to do all of them before the next one.
  await t.page.waitForTimeout(60);
}

async function pickerReport(t) {
  return t.page.evaluate(() =>
    window.converterUI.groups().map((group) => ({
      role: group.role,
      kind: group.kind,
      keys: group.keys,
      label: group.el.id || group.el.className || group.el.tagName.toLowerCase(),
    }))
  );
}

// The three Office fixtures are built by the builders in fixtureHelpers, which
// are named after the format's extension rather than after the format.
const BUILDER = { word: "docx", excel: "xlsx", powerpoint: "pptx" };

// A real file of the given kind, handed back in the shape setInputFiles wants.
// The office ones are built in the browser; the PDF comes from lib/fixtures.mjs.
async function sourceFile(t, kind, name, options) {
  const wanted = name || FORMATS[kind].file;
  if (kind === "pdf") return makePdfFile(wanted, { pages: 2, text: "SwiftPDF fixture" });
  const bytes = await t.page.evaluate(
    async ({ builder, name, options }) => {
      const file = await window.converterFixtures[builder](name, options || {});
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    },
    { builder: BUILDER[kind], name: wanted, options: options || null }
  );
  return { name: wanted, mimeType: MIME[FORMATS[kind].ext], buffer: Buffer.from(bytes) };
}

// A file that cannot be converted: a real PDF with a broken body, or an office
// file that is not really one.
async function damagedFile(t, kind) {
  if (kind === "pdf") return makeBrokenPdfFile("damaged.pdf");
  const bytes = await t.page.evaluate(async (kind) => {
    const name = "damaged." + kind;
    const file = kind === "docx" ? await window.converterFixtures.hollowOffice(name) : window.converterFixtures.brokenOffice(name);
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }, FORMATS[kind].ext);
  return { name: "damaged." + FORMATS[kind].ext, mimeType: MIME[FORMATS[kind].ext], buffer: Buffer.from(bytes) };
}

// Everything a person can see once a file has been converted, read out of the
// page's own DOM. The bytes are measured, never copied into this file.
async function resultMeta(t) {
  return t.page.evaluate(async () => {
    const bar = document.getElementById("resultBar");
    const bytes = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
    const preview = document.getElementById("previewBtn");
    return {
      size: bytes.length,
      // Two bytes for the container check, four for the PDF's own signature.
      head: String.fromCharCode.apply(null, Array.from(bytes.slice(0, 2))),
      head4: String.fromCharCode.apply(null, Array.from(bytes.slice(0, 4))),
      extension: (document.querySelector(".result-bar .name-ext")?.textContent || "").trim(),
      resultText: (document.querySelector(".result-bar .result-text")?.textContent || "").trim(),
      notesVisible: !document.getElementById("notes")?.hidden,
      notesTitle: (document.getElementById("notesTitle")?.textContent || "").trim(),
      notes: [...document.querySelectorAll("#notesList li")].map((li) => (li.textContent || "").trim()),
      previewVisible: Boolean(preview) && !preview.hidden && preview.offsetParent !== null,
      resultLabel: bar.getAttribute("aria-label") || "",
      status: (document.getElementById("status")?.textContent || "").trim(),
      downloadLabel: (document.getElementById("downloadBtn")?.textContent || "").trim(),
    };
  });
}

// The office file that came out, opened again: which parts it has, and whether
// the source's own words are in there.
async function officeResult(t, needle) {
  return t.page.evaluate(async (needle) => {
    const JSZip = await loadJsZip();
    const bar = document.getElementById("resultBar");
    const bytes = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
    let zip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch (err) {
      return { readable: false, why: String(err && err.message) };
    }
    const names = Object.keys(zip.files);
    let xml = "";
    for (const name of names) {
      if (!/\.(xml|rels)$/i.test(name)) continue;
      xml += (await zip.file(name).async("string")) + "\n";
    }
    const text = xml.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
    return {
      readable: true,
      names,
      found: at !== -1,
      snippet: at === -1 ? text.slice(0, 200) : text.slice(Math.max(0, at - 60), at + 120),
    };
  }, needle);
}

async function pdfResult(t) {
  return t.page.evaluate(async () => {
    const pdfjs = await loadPdfJs();
    const bar = document.getElementById("resultBar");
    const bytes = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pages = [];
    try {
      for (let number = 1; number <= doc.numPages; number++) {
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim());
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    return { pages: pages.length, text: pages.join("\n") };
  });
}

// What a person can tap, and what sticks out past the edge of a phone. The
// shared nav and footer are left out on purpose: they belong to the whole site
// and are not this page's to size.
async function phoneReport(t, groupSelectors) {
  return t.page.evaluate((groupSelectors) => {
    const vw = document.documentElement.clientWidth;
    const owned = ["#dropzone", "#toolbar", "#resultBar", "#notes"]
      .map((sel) => document.querySelector(sel))
      .filter(Boolean);
    const pickers = groupSelectors.map((sel) => document.querySelector(sel)).filter(Boolean);
    const hosts = [...document.querySelectorAll("main")].concat(owned, pickers);
    const inScope = (el) => hosts.some((host) => host === el || host.contains(el));
    const describe = (el) => {
      if (el.id) return "#" + el.id;
      if (typeof el.className === "string" && el.className.trim()) return "." + el.className.trim().split(/\s+/).join(".");
      return el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : "");
    };
    const tooSmall = [];
    const cramped = [];
    for (const el of document.querySelectorAll("button, select, input, a[href], [role=radio], [role=button], label")) {
      if (!inScope(el)) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (el.tagName === "INPUT" && el.type === "file") continue; // driven by its button
      // WCAG 2.2 asks for 24x24 as the floor for anything a finger has to hit.
      if (box.width < 24 || box.height < 24) {
        tooSmall.push({ what: describe(el), text: (el.textContent || el.value || "").trim().slice(0, 24), w: Math.round(box.width), h: Math.round(box.height) });
      }
      // The converter's own buttons and choices are held to the height the site
      // already gives its buttons, because these are what a phone user aims at.
      const own = owned.some((host) => host.contains(el)) || pickers.some((host) => host.contains(el));
      if (own && /^(BUTTON|SELECT)$/.test(el.tagName) && box.height < 40) {
        cramped.push({ what: describe(el), text: (el.textContent || "").trim().slice(0, 24), h: Math.round(box.height) });
      }
    }
    const stickingOut = [];
    for (const el of document.querySelectorAll("body *")) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.right > vw + 1 || box.left < -1) stickingOut.push({ what: describe(el), left: Math.round(box.left), right: Math.round(box.right) });
    }
    return {
      vw,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      tooSmall,
      cramped,
      stickingOut: stickingOut.slice(0, 6),
    };
  }, groupSelectors);
}

// The name the browser is actually handed when the download button is pressed.
async function downloadName(t, expectedExtension) {
  const [download] = await Promise.all([
    t.page.waitForEvent("download", { timeout: 20000 }),
    t.page.locator("#downloadBtn").click(),
  ]);
  const name = download.suggestedFilename();
  assert.ok(name, "the download was handed no file name");
  assert.ok(name.toLowerCase().endsWith("." + expectedExtension), `the download is called “${name}”, not a .${expectedExtension}`);
  return name;
}

async function lockedControls(t) {
  return t.page
    .locator("button:visible")
    .evaluateAll((nodes) => nodes.filter((node) => node.disabled).map((node) => node.id || node.textContent.trim()));
}

// Waits for the page to stop working: the convert button is enabled again and
// the status line has held the same words for a moment. Waiting on the wording
// alone would trip over progress messages like "Opening the file…".
async function waitForSettled(t, timeout = 60000) {
  await t.page.waitForFunction(
    () => {
      const button = document.getElementById("convertBtn");
      if (!button || button.disabled) {
        window.__settled = null;
        return false;
      }
      const text = (document.getElementById("status")?.textContent || "").trim();
      const state = window.__settled || (window.__settled = { text, hits: 0 });
      if (state.text === text) state.hits += 1;
      else {
        state.text = text;
        state.hits = 0;
      }
      return text !== "" && state.hits >= 3;
    },
    null,
    { timeout, polling: 250 }
  );
  return statusText(t);
}

// Several files dropped at once. The page's input is deliberately not
// `multiple`, so this is the only way a person can hand it more than one file:
// the browser delivers a drag from the file manager as a drop event carrying
// every file, and that is what is reproduced here.
async function dropFiles(t, files) {
  const payload = files.map((file) => ({ name: file.name, bytes: Array.from(file.buffer) }));
  await t.page.evaluate((items) => {
    const transfer = new DataTransfer();
    for (const item of items) transfer.items.add(new File([new Uint8Array(item.bytes)], item.name));
    const zone = document.getElementById("dropzone");
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, payload);
  await t.page.waitForTimeout(150);
}

// Whatever the page is currently saying, from the parts a person can see.
async function visibleText(t) {
  return t.page.evaluate(() =>
    ["#status", "#toolbar", "#notes", "#resultBar"]
      .map((sel) => document.querySelector(sel))
      .filter((el) => el && el.offsetParent !== null)
      .map((el) => el.innerText || "")
      .join("\n")
      .trim()
  );
}

/* ------------------------------------------------------------------ *
 * The honesty checks. These are the point of the page.
 * ------------------------------------------------------------------ */

const JARGON =
  /OOXML|DOMParser|InvalidPDFException|\bException\b|undefined|NaN|\[object|cannot read|is not a function|at Object\.|base64|blob:|Uint8Array/i;

// Wording that would be a lie whatever the engine actually does. "for full
// fidelity" is deliberately absent: the engine ships it as advice to export the
// file from Word or Excel instead, which is honest rather than a claim.
const OVERCLAIM =
  /(exactly the same|identical(ly)?|pixel.?perfect|100 ?%|flawless|perfectly (match|convert)|as it appears|just like (the|your) original|keeps? (your|the) (layout|fonts|colours|colors|design)|unchanged|no changes|preserves? everything)/i;

// A conversion that rebuilds a document has to say so in as many words.
const REBUILT =
  /(re-?built|rebuild|re-?created|recreated|from scratch|a new (document|file|word|spreadsheet|workbook|deck|presentation)|laid (out )?(again|anew)|set (again|afresh)|starting (again|from)|not a copy|copied (out|across|over)|the words (were|are|have been) (put|placed|copied|written|typed|carried)|put (the )?(words|text) (into|in|onto)|typed (out|again)|written out (again|from)|plain (text|words))/i;

// What "this does not keep" looks like in plain words: something denied, and
// something named that did not survive. Both halves are required, so a note
// cannot pass by being vague in either direction.
const DENIAL = /\b(not|no|none|nothing|without|isn't|aren't|wasn't|weren't|does not|do not|did not|left out|dropped|skipped|lost)\b/i;
const LOSS = /\b(layout|layouts|design|fonts?|typeface|colours?|colors?|images?|pictures?|photos?|graphics?|position(ing|s|ed)?|formatting|columns?|headers?|footers?|comments?|footnotes?|endnotes?|animations?|charts?|graphs?|formulas?|functions?|number formats?|text boxes?|spacing|slide layouts?|backgrounds?|videos?|audios?|macros?|tracked changes?)\b/i;

function assertPlainEnglish(text, where) {
  assert.equal(typeof text, "string", where + " is not text");
  assert.doesNotMatch(text, JARGON, `technical wording leaked into ${where}: ${text}`);
  assert.doesNotMatch(text, OVERCLAIM, `${where} promises more than the page delivers: ${text}`);
  for (const line of text.split(/\n+/).map((part) => part.trim()).filter(Boolean)) {
    assert.ok(line.length > 10, `too terse to be useful in ${where}: ${line}`);
    assert.ok(/\.$/.test(line), `not a finished sentence in ${where}: ${line}`);
  }
}

// Naming the wrong format on screen: a Word file described as a PDF, a sheet
// described as a deck. The text may name no format at all; it may not name the
// wrong one, and if it names one it must name the one it is talking about.
function assertNoWrongFormat(text, { from, to }, where) {
  const said = text || "";
  const named = ORDER.filter((key) => FORMAT_WORDS[key].test(said));
  const wrong = named.filter((key) => key !== from && key !== to);
  assert.deepEqual(wrong, [], `${where} names the wrong format (${wrong.map(label).join(", ")}): ${said}`);
  if (named.length) assert.ok(named.includes(to), `${where} should name the ${label(to)} it is about: ${said}`);
}

// The same rule for the parts of the page that describe the file coming in:
// they talk about the source, not about what will be produced.
function assertNoWrongSource(text, from, where) {
  const said = text || "";
  const named = ORDER.filter((key) => FORMAT_WORDS[key].test(said));
  const wrong = named.filter((key) => key !== from);
  assert.deepEqual(wrong, [], `${where} names the wrong format (${wrong.map(label).join(", ")}): ${said}`);
  assert.ok(named.includes(from), `${where} should name the ${label(from)} it is asking for: ${said}`);
}

/* ================================================================== *
 * The twelve pairs
 * ================================================================== */

for (const { from, to } of PAIRS) {
  const pair = { from, to };
  test(
    `${pairName(pair)} produces a real ${FORMATS[to].ext} and an honest note`,
    async (t) => {
      await installHelpers(t);

      await step("the page offers both sides of this conversion", async () => {
        const groups = await pickerReport(t);
        assert.ok(groups.length >= 2, `the page needs a source and a target control, found: ${JSON.stringify(groups)}`);
        for (const role of ["from", "to"]) {
          const group = groups.find((item) => item.role === role);
          assert.ok(group, `no "${role}" control on the page: ${JSON.stringify(groups)}`);
          assert.ok(group.keys.includes(from), `the ${role} list does not offer ${label(from)}: ${group.keys.join(", ")}`);
          assert.ok(group.keys.includes(to), `the ${role} list does not offer ${label(to)}: ${group.keys.join(", ")}`);
        }
      });

      await step(`${label(from)} is chosen as the source and ${label(to)} as the target`, async () => {
        await setFormat(t, "from", from);
        await setFormat(t, "to", to);
      });

      const file = await sourceFile(t, from);
      await addFiles(t, "#fileInput", [file]);

      await step("the file is taken, and the page is ready to work on it", async () => {
        await t.page.locator("#toolbar").waitFor({ state: "visible", timeout: 15000 });
        const toolbarText = await t.page.locator("#toolbar").innerText();
        assert.ok(toolbarText.includes(file.name), `the toolbar should name the file it took: ${toolbarText}`);
        assert.doesNotMatch(await statusText(t), JARGON, "the status line leaked technical wording");
      });

      await step("the button says what it is going to produce", async () => {
        const text = await t.page.locator("#convertBtn").innerText();
        assert.match(text, FORMAT_WORDS[to], `the button should name the ${label(to)}: "${text}"`);
        assert.doesNotMatch(text, OVERCLAIM, "the button promises more than it delivers: " + text);
      });

      await t.page.locator("#convertBtn").click();
      await waitForResultBar(t, 90000);
      const meta = await resultMeta(t);

      await step("what comes back is a file of the right kind, with the words in it", async () => {
        assert.equal(meta.extension, "." + FORMATS[to].ext, "the result bar shows the wrong extension");
        assert.ok(meta.size > 400, `the download looks empty (${meta.size} bytes)`);
        if (to === "pdf") {
          assert.equal(meta.head4, "%PDF", "the download is not a PDF");
          const pdf = await pdfResult(t);
          assert.ok(pdf.pages > 0, "the PDF has no pages");
          assert.ok(
            pdf.text.toLowerCase().includes(FORMATS[from].marker.toLowerCase()),
            `the ${label(from)} words are missing from the PDF: ${pdf.text.slice(0, 300)}`
          );
        } else {
          assert.equal(meta.head, "PK", "the download is not an Office file");
          const needed = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[FORMATS[to].ext];
          const office = await officeResult(t, FORMATS[from].marker);
          assert.ok(office.readable, `the download is not a readable Office file: ${office.why}`);
          assert.ok(office.names.includes(needed), `the .${FORMATS[to].ext} is missing ${needed}: ${office.names.join(", ")}`);
          assert.ok(office.found, `the ${label(from)} words are missing from the file: ${office.snippet}`);
        }
      });

      await step("the result bar and the download button agree with the target", async () => {
        assertNoWrongFormat(meta.resultText, pair, "the result line");
        assertNoWrongFormat(meta.downloadLabel, pair, "the download button");
        assertNoWrongFormat(meta.resultLabel, pair, "the result bar's label for screen readers");
        assert.equal(
          meta.previewVisible,
          to === "pdf",
          to === "pdf" ? "a PDF should offer a preview" : "a preview makes no sense for a " + label(to) + " file"
        );
      });

      await step("the page says what the conversion did not keep", async () => {
        assert.equal(meta.notesVisible, true, "nothing told the user what was lost");
        assert.ok(meta.notes.length > 0, "the notes panel is empty");
        assertNoWrongFormat(meta.notesTitle, pair, "the notes heading");
        const all = meta.notes.join(" ");
        assertPlainEnglish(all, "the notes");
        assert.match(all, DENIAL, `the notes never deny anything: ${all}`);
        assert.match(all, LOSS, `the notes never name what was lost: ${all}`);
        if (isRebuilt(pair)) {
          assert.match(all, REBUILT, `the notes do not say the file was rebuilt from the text: ${all}`);
        }
      });

      await step("the download carries the right name and extension", async () => {
        const name = await downloadName(t, FORMATS[to].ext);
        assert.doesNotMatch(name.toLowerCase(), new RegExp("\\." + FORMATS[from].ext + "$"), "the download kept the source extension");
      });

      await step("the page is usable again, and nothing was sent anywhere", async () => {
        assert.deepEqual(await lockedControls(t), [], "controls stayed disabled after a conversion");
        assert.equal(await t.page.locator("#convertBtn").isEnabled(), true, "the convert button stayed disabled");
        assert.deepEqual(t.foreignRequests(), [], "the conversion reached a site that is not the CDN or this page");
        assert.deepEqual(t.requestsWithBody(), [], "the page sent a request with a file in it");
        assert.doesNotMatch(meta.status, JARGON, "the status line leaked technical wording");
      });
    },
    PAGE
  );
}

/* ================================================================== *
 * The things that are not one of the twelve
 * ================================================================== */

test(
  "a format is never converted to itself: the page says so and hands over nothing",
  async (t) => {
    await installHelpers(t);

    for (const key of ORDER) {
      await step(`${label(key)} to ${label(key)}`, async () => {
        await reload(t);
        await setFormat(t, "from", key);
        await setFormat(t, "to", key);

        const file = await sourceFile(t, key);
        await addFiles(t, "#fileInput", [file]);

        const convert = t.page.locator("#convertBtn");
        if ((await t.page.locator("#toolbar").isVisible()) && (await convert.isEnabled())) {
          await convert.click();
          await t.page.waitForTimeout(2000);
        }

        assert.equal(
          await t.page.locator("#resultBar").isVisible(),
          false,
          `a ${label(key)} file was produced from a ${label(key)} file`
        );
        const said = await visibleText(t);
        assert.match(
          said,
          /same|already|itself|no change|nothing to convert|choose a different|different (format|target|one)/i,
          `${label(key)} to ${label(key)} was not explained: ${said.slice(0, 300)}`
        );
        assert.doesNotMatch(said, JARGON, "the explanation leaked technical wording");
        assert.deepEqual(await lockedControls(t), [], `controls stayed disabled after refusing ${label(key)} to ${label(key)}`);
      });
    }
  },
  PAGE
);

test(
  "a file of the wrong kind is refused, and it is named",
  async (t) => {
    await installHelpers(t);
    const wrong = { pdf: "word", word: "excel", excel: "powerpoint", powerpoint: "pdf" };

    for (const from of ORDER) {
      await step(`${label(from)} chosen, a ${label(wrong[from])} file dropped`, async () => {
        await reload(t);
        await setFormat(t, "from", from);
        const file = await sourceFile(t, wrong[from], "mystery." + FORMATS[wrong[from]].ext);
        await addFiles(t, "#fileInput", [file]);

        const convert = t.page.locator("#convertBtn");
        if ((await t.page.locator("#toolbar").isVisible()) && (await convert.isEnabled())) {
          await convert.click();
          await t.page.waitForTimeout(2000);
        }

        const said = await t.page.evaluate(() => ({
          status: (document.getElementById("status")?.textContent || "").trim(),
          statusClass: document.getElementById("status")?.className || "",
          resultHidden: document.getElementById("resultBar")?.hidden,
        }));

        assert.equal(said.resultHidden, true, `a ${label(wrong[from])} file was accepted as a ${label(from)} file`);
        assert.ok(said.status.length > 20, `nothing was said about “${file.name}”: "${said.status}"`);
        assert.ok(said.status.includes(file.name), `the message does not name the file: ${said.status}`);
        assert.match(said.statusClass, /error/, `the refusal is not marked as a problem: ${said.status}`);
        assert.doesNotMatch(said.status, JARGON, "the refusal leaked technical wording");
        assert.deepEqual(await lockedControls(t), [], "controls stayed disabled after a refusal");
      });
    }
  },
  PAGE
);

test(
  "a damaged file is explained, nothing stays locked, and the next file still converts",
  async (t) => {
    await installHelpers(t);

    for (const { from, to } of [{ from: "word", to: "pdf" }, { from: "pdf", to: "excel" }, { from: "excel", to: "word" }]) {
      await step(`a damaged ${label(from)} file with ${pairName({ from, to })} chosen`, async () => {
        await reload(t);
        await setFormat(t, "from", from);
        await setFormat(t, "to", to);
        await addFiles(t, "#fileInput", [await damagedFile(t, from)]);

        const convert = t.page.locator("#convertBtn");
        if ((await t.page.locator("#toolbar").isVisible()) && (await convert.isEnabled())) {
          await convert.click();
        }
        const said = await waitForSettled(t);

        assert.ok(said.length > 20, `nothing was said about the damaged file: "${said}"`);
        assert.doesNotMatch(said, JARGON, `an internal error leaked out: ${said}`);
        assert.equal(await t.page.locator("#resultBar").isVisible(), false, "a damaged file produced a result");
        assert.deepEqual(await lockedControls(t), [], "controls stayed disabled after a damaged file");
        assert.equal(await t.page.locator("#fileInput").isDisabled(), false, "the file input stayed locked");

        await step("and a good file still works afterwards", async () => {
          await addFiles(t, "#fileInput", [await sourceFile(t, from, "intact." + FORMATS[from].ext)]);
          await t.page.locator("#convertBtn").click();
          await waitForResultBar(t, 90000);
          const meta = await resultMeta(t);
          assert.equal(meta.extension, "." + FORMATS[to].ext, "the retry produced the wrong file");
          assert.ok(meta.size > 400, "the retry produced an empty file");
        });
      });
    }
  },
  PAGE
);

test(
  "a conversion with nothing in it is not handed over as a blank file",
  async (t) => {
    await installHelpers(t);

    // A PDF with no text layer at all: the scan people most often convert.
    await step("a scanned PDF with no text in it", async () => {
      const scan = makePdfFile("scan.pdf", { pages: 1, text: null });
      for (const to of ["word", "excel", "powerpoint"]) {
        await setFormat(t, "from", "pdf");
        await setFormat(t, "to", to);
        await t.page.evaluate(() => setStatus(""));
        await addFiles(t, "#fileInput", [scan]);
        const convert = t.page.locator("#convertBtn");
        if ((await t.page.locator("#toolbar").isVisible()) && (await convert.isEnabled())) {
          await convert.click();
        }
        const said = await waitForSettled(t);

        const shown = await t.page.evaluate(() => ({ resultVisible: document.getElementById("resultBar")?.hidden === false }));
        assert.equal(shown.resultVisible, false, `a blank ${label(to)} file was handed over for a textless PDF`);
        assert.ok(said.length > 20, "nothing was said about the empty PDF");
        assert.doesNotMatch(said, JARGON, "the message leaked technical wording");
        await t.page.evaluate(() => {
          const clear = document.getElementById("clearBtn");
          if (clear) clear.click();
        });
      }
    });

    // A document that is perfectly valid but carries no content at all.
    for (const { from, to } of [{ from: "word", to: "excel" }, { from: "powerpoint", to: "word" }]) {
      await step(`an empty ${label(from)} file with ${pairName({ from, to })} chosen`, async () => {
        await reload(t);
        await setFormat(t, "from", from);
        await setFormat(t, "to", to);
        await addFiles(t, "#fileInput", [await sourceFile(t, from, "empty." + FORMATS[from].ext, { empty: true })]);
        const convert = t.page.locator("#convertBtn");
        if ((await t.page.locator("#toolbar").isVisible()) && (await convert.isEnabled())) {
          await convert.click();
        }
        const said = await waitForSettled(t);

        const shown = await t.page.evaluate(() => ({ resultVisible: document.getElementById("resultBar")?.hidden === false }));
        assert.equal(shown.resultVisible, false, `a blank ${label(to)} file was handed over for an empty ${label(from)} file`);
        assert.ok(said.length > 20, "nothing was said about the empty document");
        assert.doesNotMatch(said, JARGON, "the message leaked technical wording");
      });
    }
  },
  PAGE
);

test(
  "several files at once: they are all taken, and the page says how many",
  async (t) => {
    await installHelpers(t);
    await setFormat(t, "from", "word");
    await setFormat(t, "to", "pdf");

    const files = await Promise.all([
      sourceFile(t, "word", "first.docx"),
      sourceFile(t, "word", "second.docx"),
      sourceFile(t, "word", "third.docx"),
    ]);
    await dropFiles(t, files);

    await t.page.locator("#toolbar").waitFor({ state: "visible", timeout: 15000 });
    const toolbarText = await t.page.locator("#toolbar").innerText();
    assert.match(toolbarText, /3 files ready/, `the page should say how many it took: ${toolbarText}`);

    const said = await statusText(t);
    assert.match(said, /3 Word files/, `the page did not say it took three: ${said}`);

    const multiple = await t.page.evaluate(() => document.getElementById("fileInput").multiple);
    assert.equal(multiple, true, "the picker should let several files be chosen");

    // Every file is converted, not just the first.
    const downloads = [];
    t.page.on("download", (d) => downloads.push(d.suggestedFilename()));
    await t.page.locator("#convertBtn").click();
    await waitForResultBar(t, 120000);
    await t.page.waitForTimeout(2500);

    const meta = await resultMeta(t);
    assert.equal(meta.extension, ".pdf", "the wrong file came out");
    assert.ok(meta.size > 400, "the conversion produced nothing");
    assert.equal(downloads.length, 3, `three files should be saved separately, got ${JSON.stringify(downloads)}`);
    assert.ok(downloads.includes("first.pdf"), `files should be saved by name: ${downloads.join(", ")}`);

    const done = await statusText(t);
    assert.match(done, /Converted 3 files/, `the page did not report the batch: ${done}`);
  },
  PAGE
);

/* ================================================================== *
 * The chrome has to follow the selection
 * ================================================================== */

test(
  "the button, the accepted files and the dropzone all follow the selection",
  async (t) => {
    await installHelpers(t);
    const buttons = new Set();
    const accepts = new Set();
    const dropzones = new Set();
    const heads = new Set();

    for (const { from, to } of PAIRS) {
      const pair = { from, to };
      await step(pairName(pair), async () => {
        await setFormat(t, "from", from);
        await setFormat(t, "to", to);

        const shown = await t.page.evaluate(() => {
          // What the page says before a file is chosen: the heading, the pickers
          // and the dropzone, but nothing that belongs to a chosen file.
          const clone = document.querySelector("main").cloneNode(true);
          for (const sel of ["#toolbar", "#resultBar", "#notes", "#status"]) {
            const node = clone.querySelector(sel);
            if (node) node.remove();
          }
          return {
            button: (document.getElementById("convertBtn")?.textContent || "").trim(),
            accept: (document.getElementById("fileInput")?.getAttribute("accept") || "").trim(),
            dropzone: (document.getElementById("dropzone")?.innerText || "").trim(),
            head: (clone.textContent || "").replace(/\s+/g, " ").trim(),
          };
        });

        assert.match(shown.button, FORMAT_WORDS[to], `the button should name the ${label(to)}: "${shown.button}"`);
        assert.doesNotMatch(shown.button, OVERCLAIM, "the button promises more than it delivers: " + shown.button);

        assert.match(shown.accept, new RegExp("[./]" + FORMATS[from].ext + "\\b", "i"), `the file input should accept .${FORMATS[from].ext}: "${shown.accept}"`);
        for (const other of ORDER.filter((key) => key !== from)) {
          assert.doesNotMatch(
            shown.accept,
            new RegExp("[./]" + FORMATS[other].ext + "\\b", "i"),
            `the file input also accepts .${FORMATS[other].ext}: "${shown.accept}"`
          );
        }

        assert.match(shown.dropzone, FORMAT_WORDS[from], `the dropzone should talk about ${label(from)} files: "${shown.dropzone}"`);
        assertNoWrongSource(shown.dropzone, from, "the dropzone");

        buttons.add(shown.button);
        accepts.add(shown.accept);
        dropzones.add(shown.dropzone);
        heads.add(shown.head);
      });
    }

    await step("and the page's wording changes with the selection", async () => {
      assert.ok(buttons.size >= 3, `the button barely changes with the selection: ${[...buttons].join(" | ")}`);
      assert.ok(accepts.size >= 4, `the accepted files should change for each source: ${[...accepts].join(" | ")}`);
      assert.ok(dropzones.size >= 2, `the dropzone never changes with the source: ${[...dropzones].join(" | ")}`);
      assert.ok(heads.size >= 2, `the page's own wording never changes with the selection: ${[...heads].join(" || ").slice(0, 300)}`);
    });
  },
  PAGE
);

/* ================================================================== *
 * A phone
 * ================================================================== */

for (const from of ORDER) {
  test(
    `on a 390px phone, ${label(from)} converts to each of the other three`,
    async (t) => {
      await t.page.setViewportSize(PHONE);
      await installHelpers(t);
      const roles = await t.page.evaluate(() =>
        window.converterUI.groups().map((group) => {
          group.el.setAttribute("data-spec-picker", group.role);
          return group.role;
        })
      );
      const groupSelectors = roles.map((role) => `[data-spec-picker="${role}"]`);

      const targets = ORDER.filter((key) => key !== from);
      for (const to of targets) {
        await step(`${pairName({ from, to })} on a phone`, async () => {
          await setFormat(t, "from", from);
          await setFormat(t, "to", to);
          await addFiles(t, "#fileInput", [await sourceFile(t, from)]);
          await t.page.locator("#toolbar").waitFor({ state: "visible", timeout: 15000 });

          // The first of the three is pressed with a finger rather than a
          // mouse, so a button that only answers to a click is caught here.
          if (targets.indexOf(to) === 0) {
            const button = t.page.locator("#convertBtn");
            await button.scrollIntoViewIfNeeded();
            const box = await button.boundingBox();
            const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            await t.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...at, radiusX: 8, radiusY: 8, force: 1, id: 1 }] });
            await t.page.waitForTimeout(60);
            await t.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } else {
            await t.page.locator("#convertBtn").click();
          }
          await waitForResultBar(t, 60000);

          const meta = await resultMeta(t);
          assert.equal(meta.extension, "." + FORMATS[to].ext, "the wrong file came out on a phone");
          assert.ok(meta.size > 400, "an empty file came out on a phone");
          assert.equal(meta.notesVisible, true, "the phone got a file but no note about what was lost");

          const report = await phoneReport(t, groupSelectors);
          assert.ok(report.scrollWidth <= report.vw + 1, `the page scrolls sideways (${report.scrollWidth}px wide in ${report.vw}px)`);
          assert.ok(report.bodyScrollWidth <= report.vw + 1, "the body is wider than the phone");
          assert.deepEqual(report.stickingOut, [], "something sticks out past the edge of the screen");
          assert.deepEqual(report.tooSmall, [], "some controls are too small to tap");
          assert.deepEqual(report.cramped, [], "the converter's own controls are shorter than the site's 40px button floor");
        });
      }
    },
    PAGE
  );
}

/* ================================================================== *
 * The promise the whole site is built on
 * ================================================================== */

test(
  "no conversion sends the file anywhere, and the page never throws",
  async (t) => {
    await installHelpers(t);
    for (const { from, to } of [{ from: "word", to: "pdf" }, { from: "pdf", to: "excel" }]) {
      await setFormat(t, "from", from);
      await setFormat(t, "to", to);
      await addFiles(t, "#fileInput", [await sourceFile(t, from)]);
      await t.page.locator("#convertBtn").click();
      await waitForResultBar(t, 90000);
      assert.equal((await resultMeta(t)).extension, "." + FORMATS[to].ext, "the wrong file came out");
    }
    assert.deepEqual(t.foreignRequests(), [], "a conversion reached a site that is not the CDN or this page");
    assert.deepEqual(t.requestsWithBody(), [], "a request carried a body out of the page");
    assert.deepEqual(t.pageErrors, [], "the page threw");
  },
  PAGE
);

test(
  "with the libraries blocked the page explains itself and unlocks",
  async (t) => {
    await installHelpers(t);
    // A PDF is built here in Node, so nothing on the page has to load a library
    // to hand the page a file: the conversion itself is what must fail.
    await setFormat(t, "from", "pdf");
    await setFormat(t, "to", "word");
    await addFiles(t, "#fileInput", [makePdfFile("report.pdf", { pages: 1, text: "SwiftPDF fixture" })]);
    await t.page.locator("#convertBtn").click();
    const said = await waitForSettled(t, 90000);

    assert.ok(said.length > 20, "nothing was said when the engine could not load");
    assert.doesNotMatch(said, JARGON, `an internal error leaked out: ${said}`);
    assert.equal(await t.page.locator("#resultBar").isVisible(), false, "a result appeared without an engine");
    assert.deepEqual(await lockedControls(t), [], "controls stayed disabled when the engine could not load");
  },
  { path: "/word-to-pdf.html", blockCdn: true, pageErrors: false }
);

/* ================================================================== *
 * The page's own words, which are already indexed
 * ================================================================== */

test(
  "the page's own words describe the real tool",
  async (t) => {
    const html = await (await t.page.request.get(t.url("/word-to-pdf.html"))).text();
    const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"));

    await step("the search tags are complete, once each, and still point here", async () => {
      const once = (re, what) => {
        const n = (head.match(re) || []).length;
        assert.equal(n, 1, `word-to-pdf.html should have exactly one ${what}, found ${n}`);
      };
      once(/<title>/gi, "title");
      once(/name="description"/gi, "meta description");
      once(/rel="canonical"/gi, "canonical link");
      once(/property="og:title"/gi, "og:title");
      once(/property="og:description"/gi, "og:description");
      once(/property="og:image"/gi, "og:image");
      once(/property="og:url"/gi, "og:url");
      once(/name="twitter:card"/gi, "twitter:card");
      once(/name="viewport"/gi, "viewport");
      assert.equal((html.match(/application\/ld\+json/gi) || []).length, 1, "there should be one JSON-LD block");
    });

    const title = (head.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const description = (head.match(/name="description"\s+content="([\s\S]*?)"/i) || [])[1] || "";
    const canonical = (head.match(/rel="canonical"\s+href="([^"]*)"/i) || [])[1] || "";
    const ogUrl = (head.match(/property="og:url"\s+content="([^"]*)"/i) || [])[1] || "";

    await step("and they fit, and the canonical has not moved", async () => {
      assert.ok(title.length <= 70, `the title is ${title.length} characters: ${title}`);
      assert.ok(description.length <= 185, `the description is ${description.length} characters`);
      assert.equal(canonical, "https://swift-pdf-beta.vercel.app/word-to-pdf.html", "the canonical URL changed");
      assert.equal(ogUrl, canonical, "og:url does not match the canonical");
    });

    // The page was renamed off "Word to PDF" because it converts twelve ways.
    // "word to pdf" stays at the front of the title because the page is already
    // indexed for it, and it reads honestly next to what the tool also does.
    await step("the title leads with the indexed phrase and says what else the tool does", async () => {
      assert.match(title, /^file converter/i, `the title should lead with the tool name: ${title}`);
      assert.match(title, /word to pdf/i, `the title should still carry the searched phrase: ${title}`);
      assert.match(title, /(converter|file)/i, `the title should describe a converter: ${title}`);
      const named = ORDER.filter((key) => FORMAT_WORDS[key].test(title));
      assert.ok(named.length >= 3, `the title only names ${named.map(label).join(" and ")}: ${title}`);
      assert.doesNotMatch(title, /only|exclusively|just a|merely/i, `the title claims the tool does one thing: ${title}`);
      assert.doesNotMatch(title, OVERCLAIM, `the title promises more than the page delivers: ${title}`);
    });

    await step("the description says the tool does more than one thing", async () => {
      const named = ORDER.filter((key) => FORMAT_WORDS[key].test(description));
      // Three of the four, so a description cannot quietly keep describing a
      // one-way Word-to-PDF tool now the page converts twelve ways.
      assert.ok(named.length >= 3, `the description only names ${named.map(label).join(" and ")}: ${description}`);
      assert.doesNotMatch(description, OVERCLAIM, `the description promises more than the page delivers: ${description}`);
    });

    await step("the structured data describes the same tool", async () => {
      const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
      assert.ok(block, "there is no JSON-LD block");
      const strings = JSON.stringify(JSON.parse(block[1]));
      assert.doesNotMatch(strings, OVERCLAIM, "the structured data promises more than the page delivers");
      const named = ORDER.filter((key) => FORMAT_WORDS[key].test(strings));
      assert.ok(named.length >= 3, `the structured data only names ${named.map(label).join(" and ")}`);
    });

    await step("the visible heading keeps the lead phrase and does not oversell", async () => {
      await t.page.goto(t.url("/word-to-pdf.html"), { waitUntil: "domcontentloaded" });
      const shown = await t.page.evaluate(() => ({
        h1: (document.querySelector("h1")?.innerText || "").trim(),
        head: [...document.querySelectorAll(".page-head p")].map((node) => (node.innerText || "").trim()),
      }));
      assert.ok(shown.h1.length > 4, "the page has no heading");
      assert.match(shown.h1, FORMAT_WORDS.pdf, `the heading should name PDF: ${shown.h1}`);
      assert.match(shown.h1, /word to \w+/i, `the heading should name the current conversion: ${shown.h1}`);
      assert.doesNotMatch(shown.h1, OVERCLAIM, "the heading promises more than the page delivers: " + shown.h1);
      assert.ok(shown.head.length > 0, "the page has no standfirst under the heading");
      for (const paragraph of shown.head) assertPlainEnglish(paragraph, "the standfirst");
    });

    // The page is a converter for four formats now, and its own words should say
    // so from the home page card to the sitemap entry.
    await step("the home page card and the structured data name a converter, not a Word-to-PDF tool", async () => {
      const home = await (await t.page.request.get(t.url("/index.html"))).text();
      const card = (home.match(/<a class="tool-row" href="word-to-pdf\.html">[\s\S]*?<\/a>/i) || [])[0] || "";
      assert.ok(card, "the home page has no card for this tool");
      assert.doesNotMatch(card, /word to pdf/i, `the card still calls the tool "Word to PDF": ${card}`);
      const named = ORDER.filter((key) => FORMAT_WORDS[key].test(card));
      assert.equal(named.length, 4, `the card should name all four formats, found ${named.map(label).join(", ")}`);

      const block = (home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i) || [])[1];
      assert.ok(block, "the home page has no structured data");
      JSON.parse(block);

      const sitemap = await (await t.page.request.get(t.url("/sitemap.xml"))).text();
      assert.ok(sitemap.includes("word-to-pdf.html"), "the sitemap no longer lists this page");
    });
  },
  { path: "/index.html" }
);

/* ================================================================== *
 * Reading the structure back out of a PDF.
 *
 * A PDF stores words and their coordinates and nothing else, so the
 * lines, headings and grids on a page have to be worked out from where
 * the text sits. That is a heuristic and these tests are the ones that
 * hold it to both ends: it must find the structure a formatted page
 * really has, it must not cost a word, and it must leave a page of
 * ordinary prose alone.
 * ================================================================== */

// The .docx that came out, opened again, reduced to the things the reader is
// supposed to have rebuilt. Counts are measured, not asserted into existence.
async function docxStructure(t) {
  return t.page.evaluate(async () => {
    const JSZip = await loadJsZip();
    const bar = document.getElementById("resultBar");
    const bytes = new Uint8Array(await (await fetch(bar._resultUrl)).arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml").async("string");
    const paragraphs = xml.match(/<w:p[ >]/g) || [];
    const headings = [...xml.matchAll(/<w:pStyle w:val="(Heading[1-6])"\/>/g)].map((m) => m[1]);
    const tables = xml.match(/<w:tbl>/g) || [];
    const headerRow = (xml.match(/<w:tblHeader\/>/g) || []).length;
    // The paragraphs that are the document's own, with the ones inside a table
    // left out: a cell holds a paragraph, and counting those would make a table
    // look like a wall of text.
    const outsideTables = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, "");
    const bodyParagraphs = (outsideTables.match(/<w:p[ >]/g) || []).length;
    const text = xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
    return { paragraphs: paragraphs.length, bodyParagraphs, headings, tables: tables.length, headerRow, text };
  });
}

async function builtPdfFile(t, builder, name) {
  const bytes = await t.page.evaluate(
    async ({ builder, name }) => {
      const file = await window.converterFixtures[builder](name);
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    },
    { builder, name }
  );
  return { name, mimeType: "application/pdf", buffer: Buffer.from(bytes) };
}

test(
  "a PDF converted to Word comes back with headings, paragraphs and a real table",
  async (t) => {
    await installHelpers(t);
    await setFormat(t, "from", "pdf");
    await setFormat(t, "to", "word");
    await addFiles(t, "#fileInput", [await builtPdfFile(t, "structuredPdf", "review.pdf")]);

    await t.page.locator("#convertBtn").click();
    await waitForResultBar(t, 90000);
    const meta = await resultMeta(t);
    assert.equal(meta.extension, ".docx", "the wrong file came out");
    assert.doesNotMatch(meta.status, JARGON, "the status line leaked technical wording");

    const out = await docxStructure(t);

    await step("the page is no longer one wall of text", async () => {
      // The old reader emitted exactly one paragraph per page, so this
      // two-page document came out as two paragraphs and nothing else.
      assert.equal(out.bodyParagraphs, 5, `the page is ${out.bodyParagraphs} body paragraphs, not the 5 the page holds`);
      assert.ok(out.paragraphs > out.bodyParagraphs, "the table's cells are not being counted at all");
    });

    await step("the title and subtitle came back as headings", async () => {
      assert.ok(out.headings.length >= 2, `only ${out.headings.length} headings were recognised: ${out.headings.join(", ")}`);
      assert.ok(out.text.includes("Quarterly Business Review"), `the title is missing: ${out.text.slice(0, 200)}`);
      assert.ok(out.text.includes("Prepared by the finance team"), "the subtitle is missing");
    });

    await step("the grid came back as a table with its header row", async () => {
      assert.ok(out.tables >= 1, `no table was written: ${out.text.slice(0, 300)}`);
      assert.ok(out.headerRow >= 1, "the first row of the table is not marked as its header");
      const firstRow = (out.text.match(/Region\s+Q1\s+Q2\s+Q3/) || [])[0];
      assert.ok(firstRow, `the header cells are not together in the first row: ${out.text.slice(0, 300)}`);
      assert.match(out.text, /North\s+120\s+138\s+171/, "the first data row did not survive as cells");
      assert.match(out.text, /South\s+90\s+95\s+110/, "the second data row did not survive as cells");
    });

    await step("and not one word of the source was lost to get there", async () => {
      const wanted = await t.page.evaluate(() => window.converterFixtures.REVIEW_WORDS);
      const missing = wanted.filter((word) => !out.text.includes(word));
      assert.deepEqual(missing, [], `the conversion dropped: ${missing.join(", ")}`);
    });

    await step("the page admits the structure was worked out, not copied", async () => {
      const said = meta.notes.join(" ");
      assert.match(said, /worked out|reading of the page|rebuild/i, "the notes do not say the layout was reconstructed");
      assert.match(said, /table/i, "the notes never say a grid was written out as a table");
      assert.match(said, /picture|drawing|chart/i, "the notes never say pictures are left behind");
      assert.match(said, /page 1 of the PDF|Page 1 of the PDF/i, `the notes do not name the page that became a table: ${said}`);
      assertPlainEnglish(said, "the notes");
    });
  },
  PAGE
);

test(
  "a PDF of ordinary prose stays prose, and is not read as a table or a stack of headings",
  async (t) => {
    await installHelpers(t);
    await setFormat(t, "from", "pdf");
    await setFormat(t, "to", "word");
    await addFiles(t, "#fileInput", [await builtPdfFile(t, "prosePdf", "memo.pdf")]);

    await t.page.locator("#convertBtn").click();
    await waitForResultBar(t, 90000);
    const out = await docxStructure(t);

    await step("no grid was invented", async () => {
      assert.equal(out.tables, 0, `a page of prose was written out as a table: ${out.text.slice(0, 300)}`);
    });

    await step("and no headings either", async () => {
      assert.equal(out.headings.length, 0, `body text was marked as headings: ${out.headings.join(", ")}`);
    });

    await step("the wrapped lines were joined back into the paragraph they were", async () => {
      // Four lines were drawn, none of them ending a sentence, so the reader
      // should have put them back together rather than four paragraphs apart.
      assert.ok(out.paragraphs <= 2, `the paragraph was broken into ${out.paragraphs} paragraphs`);
      assert.match(out.text, /letter into a table and a page of writing into a page of headings/, "the prose did not survive");
    });
  },
  PAGE
);

/* ================================================================== *
 * Compressing the PDF on the way out
 * ================================================================== */

test(
  "the compression option is offered only when the target is a PDF, and shrinks a real PDF",
  async (t) => {
    await installHelpers(t);

    await step("it is hidden for every target that is not a PDF", async () => {
      for (const to of ["word", "excel", "powerpoint"]) {
        await setFormat(t, "from", "word");
        await setFormat(t, "to", to);
        const shown = await t.page.evaluate(() => {
          const box = document.getElementById("convertCompress");
          return box ? !box.hidden && box.offsetParent !== null : null;
        });
        assert.equal(shown, false, `the compression option is showing for a ${label(to)} target`);
      }
    });

    await step("and it is there for a PDF target", async () => {
      await setFormat(t, "from", "word");
      await setFormat(t, "to", "pdf");
      const shown = await t.page.evaluate(() => {
        const box = document.getElementById("convertCompress");
        return Boolean(box) && !box.hidden;
      });
      assert.equal(shown, true, "the compression option is missing for a PDF target");
    });

    const without = await (async () => {
      await addFiles(t, "#fileInput", [await officeFileWithPhoto(t, "photos.docx")]);
      await t.page.locator("#convertBtn").click();
      await waitForResultBar(t, 90000);
      return resultMeta(t);
    })();

    await step("with the option off, the file is the plain conversion", async () => {
      assert.equal(without.extension, ".pdf", "the wrong file came out");
      assert.ok(without.size > 4000, `the picture did not make it into the PDF (${without.size} bytes)`);
      assert.doesNotMatch(without.status + without.notes.join(" "), /compress/i, "the page mentioned compression when none was asked for");
    });

    for (const { level, label: levelName } of [
      { level: "small", label: "Smallest" },
      { level: "medium", label: "Balanced" },
      { level: "high", label: "Best quality" },
    ]) {
      await step(`compressed at ${levelName}`, async () => {
        await addFiles(t, "#fileInput", [await officeFileWithPhoto(t, "photos.docx")]);
        await t.page.evaluate((chosen) => {
          const toggle = document.getElementById("compressToggle");
          toggle.checked = true;
          toggle.dispatchEvent(new Event("change", { bubbles: true }));
          const pill = document.querySelector(`#compressQuality .pill[data-q="${chosen}"]`);
          pill.click();
        }, level);
        await t.page.locator("#convertBtn").click();
        await waitForResultBar(t, 90000);
        const meta = await resultMeta(t);

        assert.ok(meta.size < without.size, `nothing was saved at ${levelName}: ${meta.size} bytes against ${without.size}`);
        const said = meta.status + " " + meta.notes.join(" ");
        assert.doesNotMatch(meta.status, JARGON, "the status line leaked technical wording");
        assert.match(said, /selectable|searchable|searched for|copied/i, `nothing said the text is no longer selectable: ${said}`);
        assert.match(said, new RegExp(levelName, "i"), `the level used was not named: ${said}`);
        if (level !== "high") {
          assert.match(said, /saving|→|->/i, `the bytes saved were not reported: ${meta.status}`);
        }
      });
    }

    await step("the compression note does not survive a change of target", async () => {
      await setFormat(t, "to", "word");
      const said = await t.page.evaluate(() => ({
        status: (document.getElementById("status")?.textContent || "").trim(),
        result: (document.querySelector(".result-bar .result-text")?.textContent || "").trim(),
        notes: document.getElementById("notes")?.hidden,
        box: document.getElementById("convertCompress")?.hidden,
      }));
      assert.equal(said.notes, true, "the notes from the compressed PDF are still on screen");
      assert.doesNotMatch(said.status + said.result, /compress/i, "a compression note survived the change of target");
      assert.equal(said.box, true, "the compression option is still showing for a Word target");
    });

    await step("nothing stays locked and nothing is sent anywhere", async () => {
      assert.deepEqual(await lockedControls(t), [], "controls stayed disabled after compressing");
      assert.deepEqual(t.foreignRequests(), [], "the conversion reached a site that is not the CDN or this page");
      assert.deepEqual(t.requestsWithBody(), [], "the page sent a request with a file in it");
      assert.deepEqual(t.pageErrors, [], "the page threw");
    });
  },
  PAGE
);

// The office file the compression test needs, built in the browser.
async function officeFileWithPhoto(t, name) {
  const bytes = await t.page.evaluate(async (name) => {
    const file = await window.converterFixtures.imageDocx(name);
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }, name);
  return { name, mimeType: MIME.docx, buffer: Buffer.from(bytes) };
}
