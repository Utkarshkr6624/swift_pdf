/* SwiftPDF — writing real .docx, .xlsx and .pptx files.
 *
 * This is the other half of the conversion matrix: the PDF renderer in
 * office-to-pdf.js turns a document into pages, and this turns the same
 * content, as ordered blocks, into an Office file the desktop apps open.
 * The promise holds — JSZip packs the ZIP container in the browser and nothing
 * is sent anywhere.
 *
 * "Minimal but valid" is the whole difficulty. Office is unforgiving: a
 * part that is missing, a relationship that points nowhere, or a shape with
 * no position shows up as "PowerPoint found a problem with content" and the
 * file is refused. So every package here carries its content types, its root
 * relationship, and — for PowerPoint — the slide master, layout and theme
 * that PowerPoint insists on. Where a real file has more, this writes the
 * smallest set that opens cleanly.
 *
 * The block shapes are treated as untrusted: a null field, a missing array, a
 * cell holding a newline or a number instead of a string. Nothing here throws
 * on an odd document; the worst that happens is a block that gets skipped.
 *
 * Nothing runs at load time beyond defining window.SwiftFileWriters, and
 * `document` is never touched at module scope, so the file is safe to include
 * anywhere.
 */
(function () {
  "use strict";

  /* ---------- limits ----------
   * Every one of these is a bound on what a file format or a screen can hold,
   * not a preference: past them the output is refused data, an overflowing
   * slide, or a browser that stops responding. */

  const EMU_PER_PX = 9525;            // 96 dpi -> English Metric Units
  const EMU_PER_PT = 12700;
  const EMU_PER_INCH = 914400;
  const SLIDE_WIDTH = 12192000;       // 13.333in, the 16:9 slide size
  const SLIDE_HEIGHT = 6858000;       // 7.5in
  const SLIDE_MARGIN = 457200;        // 0.5in
  const IMAGE_MAX_CX = 5486400;       // 6in
  const IMAGE_MAX_CY = 4114800;       // 4.5in
  const TABLE_WIDTH_TWIPS = 9360;     // A4 less one inch of margin, in twips
  const MAX_IMAGES = 400;
  const MAX_BLOCKS = 200000;
  const MAX_LINES_PER_BLOCK = 400;
  const MAX_TABLE_ROWS = 10000;
  const MAX_TABLE_COLUMNS = 256;
  const MAX_SHEET_ROWS = 1048576;    // Excel's own ceiling
  const MAX_SHEET_COLUMNS = 16384;   // ...and its other one
  const MAX_SLIDE_TABLE_ROWS = 30;
  const MAX_SLIDE_TABLE_COLUMNS = 10;
  const MAX_NESTING = 4;

  const MIMES = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  const NS = {
    rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    pkgRel: "http://schemas.openxmlformats.org/package/2006/relationships",
    content: "http://schemas.openxmlformats.org/package/2006/content-types",
    core: "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    dc: "http://purl.org/dc/elements/1.1/",
    dcterms: "http://purl.org/dc/terms/",
    dcmitype: "http://purl.org/dc/dcmitype/",
    xsi: "http://www.w3.org/2001/XMLSchema-instance",
    word: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    sheet: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    slide: "http://schemas.openxmlformats.org/presentationml/2006/main",
    draw: "http://schemas.openxmlformats.org/drawingml/2006/main",
    table: "http://schemas.openxmlformats.org/drawingml/2006/table",
    picture: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  };

  const CT = {
    rels: "application/vnd.openxmlformats-package.relationships+xml",
    core: "application/vnd.openxmlformats-package.core-properties+xml",
    docx: MIMES.docx,
    styles: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
    numbering: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
    xlsx: MIMES.xlsx,
    worksheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
    sharedStrings: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
    sheetStyles: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    pptx: MIMES.pptx,
    master: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
    layout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
    slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  };

  /* ---------- text ---------- */

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
  // XML 1.0 has no way to express a control character, so one that survived a
  // bad source file has to go rather than make the whole part unreadable.
  const XML_UNSAFE = /[&<>"'\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
  const XML_UNSAFE_TEST = /[&<>"'\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

  function esc(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    if (!XML_UNSAFE_TEST.test(text)) return text;
    return text.replace(XML_UNSAFE, (character) => ESCAPES[character] || "");
  }

  // Text destined for a text node. Every character is escaped here, and
  // nothing anywhere else is allowed to interpolate raw text into markup.
  function text(value) {
    return esc(value);
  }

  // A paragraph's text, which may be given as a single string or as styled
  // runs. Runs win when there are any, because that is where the bold and
  // italic live.
  function runsOf(block) {
    const runs = [];
    const given = Array.isArray(block.runs) ? block.runs : null;
    if (given) {
      for (const run of given) {
        if (!run || typeof run !== "object") continue;
        const value = run.text === null || run.text === undefined ? "" : String(run.text);
        if (!value) continue;          // an empty run is a run Office would drop
        runs.push({ text: value, bold: Boolean(run.bold), italic: Boolean(run.italic) });
      }
    }
    if (!runs.length) {
      const plain = block.text === null || block.text === undefined ? "" : String(block.text);
      if (plain) runs.push({ text: plain, bold: false, italic: false });
    }
    return runs;
  }

  function textOf(block) {
    if (!block || typeof block !== "object") return "";
    const runs = runsOf(block);
    if (runs.length) {
      let out = "";
      for (const run of runs) out += run.text;
      return out;
    }
    return "";
  }

  // A cell may be a string, a number, or nothing at all; a spreadsheet cell
  // holding a newline stays as it is rather than being quietly folded.
  function cellText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      if (typeof value.text === "string") return value.text;
      return "";
    }
    return String(value);
  }

  function linesOf(value) {
    const source = cellText(value);
    if (!source) return [""];
    const parts = source.split(/\r\n|\r|\n/);
    if (parts.length > MAX_LINES_PER_BLOCK) parts.length = MAX_LINES_PER_BLOCK;
    return parts;
  }

  /* ---------- small helpers ---------- */

  function isObject(value) {
    return Boolean(value) && typeof value === "object";
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return isObject(value) ? value : {};
  }

  function positive(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return number;
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  // The site's own loader, with a fallback for a page that already has JSZip.
  async function loadZipLib() {
    if (typeof window === "undefined") throw new Error("This converter runs in a browser window.");
    if (window.JSZip) return window.JSZip;
    if (typeof loadJsZip === "function") {
      const JSZip = await loadJsZip();
      if (JSZip) return JSZip;
    }
    if (window.JSZip) return window.JSZip;
    throw new Error("The ZIP engine could not be loaded. Check your internet connection and reload.");
  }

  async function pack(zip) {
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  /* ---------- images ---------- */

  // Only PNG and JPEG are embedded. Everything else Office can draw is
  // something a browser cannot resize or a writer cannot describe safely, and
  // a part that lies about its bytes is what causes a repair prompt.
  function sniffImage(bytes) {
    if (!bytes || bytes.length < 8) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d) return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    return null;
  }

  // Both formats state their pixel size in their first few bytes, so the
  // aspect ratio is known without decoding the image.
  function pixelSize(bytes, kind) {
    try {
      if (kind === "png") {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
      }
      if (kind === "jpg") {
        let i = 2;
        while (i < bytes.length - 9) {
          if (bytes[i] !== 0xff) { i += 1; continue; }
          const marker = bytes[i + 1];
          if (marker === 0xff) { i += 1; continue; }
          if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
          const length = (bytes[i + 2] << 8) | (bytes[i + 3]);
          const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (isFrame) {
            return { width: (bytes[i + 7] << 8) | (bytes[i + 8]), height: (bytes[i + 5] << 8) | (bytes[i + 6]) };
          }
          i += 2 + length;
        }
      }
    } catch (err) {
      // A truncated header is not a reason to fail the whole conversion.
    }
    return null;
  }

  function asBytes(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  function signatureOf(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return `${bytes.length}:${hash.toString(16)}`;
  }

  // Collects the media parts for one package and hands out a relationship id
  // for each, so a picture repeated in a document is stored once.
  function createMedia(prefix) {
    const items = [];
    const bySignature = new Map();
    const extensions = new Set();

    return {
      items,
      extensions,
      add(input) {
        const bytes = asBytes(input);
        if (!bytes || !bytes.length) return null;
        if (items.length >= MAX_IMAGES) return null;
        const kind = sniffImage(bytes);
        if (!kind) return null;
        const signature = signatureOf(bytes);
        const known = bySignature.get(signature);
        if (known) return known;
        const item = {
          name: `image${items.length + 1}.${kind}`,
          bytes,
          kind,
          id: `rIdImage${items.length + 1}`,
        };
        items.push(item);
        bySignature.set(signature, item);
        extensions.add(kind);
        return item;
      },
      addTo(zipInstance) {
        for (const item of items) zipInstance.file(prefix + item.name, item.bytes);
        return this;
      },
    };
  }

  // EMU is what both Word and PowerPoint measure a picture in, so the pixels a
  // block reports become a size that fits the page without being distorted.
  function imageExtent(item, block, maxCx, maxCy) {
    const declared = pixelSize(item.bytes, item.kind);
    const width = positive(block && block.width, declared ? declared.width : 0);
    const height = positive(block && block.height, declared ? declared.height : 0);
    const w = width || 300;
    const h = height || 200;
    let cx = w * EMU_PER_PX;
    let cy = h * EMU_PER_PX;
    const scale = Math.min(1, maxCx / cx, maxCy / cy);
    cx = Math.max(EMU_PER_PX, Math.round(cx * scale));
    cy = Math.max(EMU_PER_PX, Math.round(cy * scale));
    return { cx, cy };
  }

  /* ---------- package scaffolding ---------- */

  function contentTypesXml(overrides, imageExtensions) {
    let out = XML_HEAD + `<Types xmlns="${NS.content}">`;
    out += `<Default Extension="rels" ContentType="${CT.rels}"/>`;
    out += '<Default Extension="xml" ContentType="application/xml"/>';
    for (const extension of imageExtensions || []) {
      const type = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
      out += `<Default Extension="${esc(extension)}" ContentType="${type}"/>`;
    }
    for (const entry of overrides || []) {
      out += `<Override PartName="/${esc(entry.part)}" ContentType="${esc(entry.type)}"/>`;
    }
    return out + "</Types>";
  }

  function relsXml(list) {
    let out = XML_HEAD + `<Relationships xmlns="${NS.pkgRel}">`;
    for (const rel of list || []) {
      const mode = rel.mode ? ` TargetMode="${esc(rel.mode)}"` : "";
      out += `<Relationship Id="${esc(rel.id)}" Type="${esc(rel.type)}" Target="${esc(rel.target)}"${mode}/>`;
    }
    return out + "</Relationships>";
  }

  function corePropsXml(title) {
    return XML_HEAD +
      `<cp:coreProperties xmlns:cp="${NS.core}" xmlns:dc="${NS.dc}" xmlns:dcterms="${NS.dcterms}"` +
      ` xmlns:dcmitype="${NS.dcmitype}" xmlns:xsi="${NS.xsi}">` +
      `<dc:title>${text(title)}</dc:title>` +
      "<dc:creator>SwiftPDF</dc:creator>" +
      "<cp:lastModifiedBy>SwiftPDF</cp:lastModifiedBy>" +
      "<cp:revision>1</cp:revision>" +
      "</cp:coreProperties>";
  }

  function writeCoreProps(zip, title) {
    zip.file("docProps/core.xml", corePropsXml(title));
  }

  function rootRels(mainPart) {
    return relsXml([
      { id: "rId1", type: `${NS.rel}/officeDocument`, target: mainPart },
      { id: "rId2", type: `${NS.pkgRel}/metadata/core-properties`, target: "docProps/core.xml" },
    ]);
  }

  function titleOf(input, fallback) {
    const value = asObject(input).title;
    const name = value === null || value === undefined ? "" : String(value).trim();
    if (name) return name;
    return fallback || "SwiftPDF document";
  }

  /* ---------- block normalisation ---------- */

  function rowsOf(block) {
    const rows = [];
    for (const row of asArray(block && block.rows)) {
      if (!Array.isArray(row)) {
        rows.push([cellText(row)]);
        if (rows.length >= MAX_TABLE_ROWS) break;
        continue;
      }
      const cells = [];
      for (const cell of row) {
        cells.push(cellText(cell));
        if (cells.length >= MAX_TABLE_COLUMNS) break;
      }
      rows.push(cells);
      if (rows.length >= MAX_TABLE_ROWS) break;
    }
    return rows;
  }

  function columnCount(rows) {
    let count = 0;
    for (const row of rows) if (row.length > count) count = row.length;
    return count;
  }

  // A document handed to the Word writer may be a PowerPoint extraction or a
  // spreadsheet extraction, so slides and sheets are flattened into headings
  // and tables rather than dropped. The queue is walked with an index, not
  // with shift() or recursion, so a deep or very long list cannot blow the
  // stack or the clock.
  function linearBlocks(doc) {
    const out = [];
    const queue = [];
    let head = 0;
    for (const block of asArray(doc.blocks)) queue.push({ block, depth: 0 });

    while (head < queue.length) {
      const entry = queue[head++];
      const block = entry.block;
      if (!isObject(block)) continue;
      const type = String(block.type || "").toLowerCase();

      if (type === "slide" || type === "sheet") {
        if (entry.depth >= MAX_NESTING) continue;
        const label = type === "slide" ? block.title : block.name;
        const name = label === null || label === undefined ? "" : String(label).trim();
        if (name) out.push({ type: "heading", level: 2, text: name });
        if (type === "sheet" && asArray(block.rows).length) {
          out.push({ type: "table", rows: rowsOf(block) });
        }
        for (const inner of asArray(block.blocks)) {
          queue.push({ block: inner, depth: entry.depth + 1 });
        }
        continue;
      }
      out.push(block);
      if (out.length >= MAX_BLOCKS) break;
    }
    return out;
  }

  /* ---------- Word ---------- */

  const DOCX_HEADING_SIZES = [32, 26, 24, 24, 22, 22]; // half-points, Word's own defaults

  // A block says which heading it is; Word wants a style name, and the name
  // has to exist in styles.xml or the heading is written but not styled.
  function headingStyle(block) {
    const raw = block.level;
    const name = String(raw === null || raw === undefined ? "" : raw).toLowerCase().replace(/\s+/g, "");
    if (name === "title") return "Title";
    const number = Number(raw);
    if (Number.isFinite(number) && number >= 1 && number <= 6) return `Heading${Math.floor(number)}`;
    const match = /^heading([1-6])$/.exec(name);
    if (match) return `Heading${match[1]}`;
    return "Heading1";
  }

  function docxRunXml(run) {
    let properties = "";
    if (run.bold) properties += "<w:b/>";
    if (run.italic) properties += "<w:i/>";
    const props = properties ? `<w:rPr>${properties}</w:rPr>` : "";
    return `<w:r>${props}<w:t xml:space="preserve">${text(run.text)}</w:t></w:r>`;
  }

  function docxParagraphXml(styleId, runs) {
    if (!runs.length) {
      if (!styleId) return "<w:p/>";
      return `<w:p><w:pPr><w:pStyle w:val="${esc(styleId)}"/></w:pPr></w:p>`;
    }
    let props = "<w:pPr>";
    if (styleId) props += `<w:pStyle w:val="${esc(styleId)}"/>`;
    if (styleId === "ListParagraph") props += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720"/>';
    props += "</w:pPr>";
    let body = "";
    for (const run of runs) body += docxRunXml(run);
    return `<w:p>${props}${body}</w:p>`;
  }

  // A block whose text carries newlines becomes several paragraphs, which is
  // how Word represents a hard line break inside one block.
  function docxTextBlockXml(styleId, block) {
    const lines = linesOf(textOf(block));
    if (lines.length === 1) return docxParagraphXml(styleId, runsOf(block));
    let out = "";
    for (const line of lines) {
      const runs = line ? [{ text: line, bold: false, italic: false }] : [];
      out += docxParagraphXml(styleId, runs);
    }
    return out;
  }

  function docxTableXml(rows) {
    const columns = Math.max(1, Math.min(MAX_TABLE_COLUMNS, columnCount(rows)));
    const columnWidth = Math.max(360, Math.floor(TABLE_WIDTH_TWIPS / columns));
    let out = "<w:tbl>";
    out += "<w:tblPr>";
    out += `<w:tblW w:w="${TABLE_WIDTH_TWIPS}" w:type="dxa"/>`;
    out += "<w:tblBorders>";
    for (const edge of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
      out += `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
    }
    out += "</w:tblBorders>";
    out += '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>' +
      '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>';
    out += '<w:tblLook w:val="04A0"/>';
    out += "</w:tblPr>";
    out += "<w:tblGrid>";
    for (let i = 0; i < columns; i++) out += `<w:gridCol w:w="${columnWidth}"/>`;
    out += "</w:tblGrid>";

    for (let r = 0; r < rows.length && r < MAX_TABLE_ROWS; r++) {
      const row = rows[r];
      out += "<w:tr>";
      if (r === 0) out += "<w:trPr><w:tblHeader/></w:trPr>";
      for (let c = 0; c < columns; c++) {
        out += `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/></w:tcPr>`;
        const cell = c < row.length ? row[c] : "";
        const lines = linesOf(cell);
        let body = "";
        for (const line of lines) {
          if (!line) {
            body += "<w:p/>";
            continue;
          }
          body += docxParagraphXml(null, [{ text: line, bold: false, italic: false }]);
        }
        out += `${body}</w:tc>`;
      }
      out += "</w:tr>";
    }
    out += "</w:tbl>";
    // Word needs a paragraph after a table, and two tables written back to
    // back would be read as one.
    return `${out}<w:p/>`;
  }

  function docxImageXml(block, rels, media, shapeId) {
    const item = media.add(block && block.bytes ? block.bytes : null);
    if (!item) return "";
    rels.push({ id: item.id, type: `${NS.rel}/image`, target: `media/${item.name}` });
    const extent = imageExtent(item, block, IMAGE_MAX_CX, IMAGE_MAX_CY);
    // DrawingML ids are unsigned integers and must be unique in the part.
    const id = shapeId;
    let out = "<w:p><w:r><w:drawing>";
    out += '<wp:inline distT="0" distB="0" distL="0" distR="0">';
    out += `<wp:extent cx="${extent.cx}" cy="${extent.cy}"/>`;
    out += `<wp:docPr id="${id}" name="${esc(item.name)}"/>`;
    out += "<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>";
    out += `<a:graphic><a:graphicData uri="${NS.picture}">`;
    out += `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(item.name)}"/><pic:cNvPicPr/></pic:nvPicPr>`;
    out += `<pic:blipFill><a:blip r:embed="${item.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`;
    out += `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${extent.cx}" cy="${extent.cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>';
    out += "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>";
    return out;
  }

  function docxStylesXml() {
    let out = XML_HEAD + `<w:styles xmlns:w="${NS.word}">`;
    out += "<w:docDefaults><w:rPrDefault><w:rPr>";
    out += '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>';
    out += '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>';
    out += "</w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>";

    out += '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/><w:qFormat/></w:style>';

    // Explicit font names rather than theme references: this package carries
    // no theme part, and a style that points at one would have nothing to
    // resolve against.
    out += '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>' +
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:keepNext/><w:spacing w:after="120"/><w:contextualSpacing/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:spacing w:val="-10"/>' +
      '<w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>';

    for (let level = 1; level <= 6; level++) {
      out += `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
        '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>' +
        "<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"240\" w:after=\"60\"/>" +
        `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
        '<w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:b/>' +
        `<w:sz w:val="${DOCX_HEADING_SIZES[level - 1]}"/><w:szCs w:val="${DOCX_HEADING_SIZES[level - 1]}"/></w:rPr></w:style>`;
    }

    out += '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
      '<w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>' +
      '<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>';

    out += '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>' +
      '<w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>' +
      '<w:tblPr><w:tblBorders>' +
      '<w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>' +
      '<w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>' +
      '<w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>' +
      '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>' +
      '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>' +
      "</w:tblBorders></w:tblPr></w:style>";

    out += '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
      "<w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w=\"0\" w:type=\"dxa\"/>" +
      '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
      '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>';

    return out + "</w:styles>";
  }

  // Bullets have to come from a numbering definition; without this part a
  // w:numPr has nothing to point at and Word shows the items unbulleted.
  function docxNumberingXml() {
    const bullets = ["\u2022", "\u25CB", "\u25AA"];
    let out = XML_HEAD + `<w:numbering xmlns:w="${NS.word}">`;
    out += '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>';
    for (let level = 0; level < bullets.length; level++) {
      out += `<w:lvl w:ilvl="${level}">`;
      out += '<w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="' + bullets[level] + '"/><w:lvlJc w:val="left"/>';
      out += `<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr>`;
      out += '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr>';
      out += "</w:lvl>";
    }
    out += "</w:abstractNum>";
    out += '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    return out + "</w:numbering>";
  }

  const DOCX_SECTION =
    "<w:sectPr>" +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/>' +
    '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/>' +
    "</w:sectPr>";

  async function docx(input) {
    const doc = asObject(input);
    const blocks = linearBlocks(doc);
    const title = titleOf(doc, "Document");

    const JSZip = await loadZipLib();
    const zip = new JSZip();
    const media = createMedia("word/media/");
    const rels = [
      { id: "rIdStyles", type: `${NS.rel}/styles`, target: "styles.xml" },
      { id: "rIdNumbering", type: `${NS.rel}/numbering`, target: "numbering.xml" },
    ];

    let body = "";
    let shapeCount = 0;
    for (const block of blocks) {
      if (!isObject(block)) continue;
      const type = String(block.type || "").toLowerCase();

      if (type === "heading") {
        body += docxTextBlockXml(headingStyle(block), block);
      } else if (type === "paragraph" || type === "text") {
        body += docxTextBlockXml(null, block);
      } else if (type === "list") {
        const items = asArray(block.items);
        if (!items.length) continue;
        for (const item of items) {
          const value = cellText(item);
          const lines = linesOf(value);
          for (const line of lines) {
            const runs = line ? [{ text: line, bold: false, italic: false }] : [];
            body += docxParagraphXml("ListParagraph", runs);
          }
        }
      } else if (type === "table") {
        const rows = rowsOf(block);
        if (!rows.length) continue;
        body += docxTableXml(rows);
      } else if (type === "image") {
        if (++shapeCount > MAX_IMAGES) continue;
        body += docxImageXml(block, rels, media, shapeCount);
      }
      // Any other block type is not something this writer knows how to say,
      // and skipping it is better than writing something Office would reject.
    }

    // An empty document is still a document: Word expects at least one
    // paragraph in the body.
    if (!body) body = "<w:p/>";

    const document = XML_HEAD +
      `<w:document xmlns:w="${NS.word}" xmlns:r="${NS.rel}" ` +
      `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
      `xmlns:a="${NS.draw}" xmlns:pic="${NS.picture}">` +
      `<w:body>${body}${DOCX_SECTION}</w:body></w:document>`;

    zip.file("word/document.xml", document);
    zip.file("word/_rels/document.xml.rels", relsXml(rels));
    zip.file("word/styles.xml", docxStylesXml());
    zip.file("word/numbering.xml", docxNumberingXml());
    media.addTo(zip);
    writeCoreProps(zip, title);
    zip.file("_rels/.rels", rootRels("word/document.xml"));
    zip.file("[Content_Types].xml", contentTypesXml([
      { part: "word/document.xml", type: CT.docx },
      { part: "word/styles.xml", type: CT.styles },
      { part: "word/numbering.xml", type: CT.numbering },
      { part: "docProps/core.xml", type: CT.core },
    ], media.extensions));

    return pack(zip);
  }

  /* ---------- Excel ---------- */

  function columnName(index) {
    let n = index + 1;
    let name = "";
    while (n > 0) {
      const remainder = (n - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  // Excel's rules, enforced rather than trusted: 31 characters, no : \ / ? * [ ]
  // and no name that differs from another only by case.
  function sheetName(raw, index, used) {
    let name = raw === null || raw === undefined ? "" : String(raw);
    name = name.replace(/[:\\/?*[\]\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
    if (/^'/.test(name) || /'$/.test(name)) name = name.replace(/'/g, "");
    if (!name) name = `Sheet${index + 1}`;
    name = name.slice(0, 31);
    let candidate = name;
    let count = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = ` (${count})`;
      candidate = `${name.slice(0, 31 - suffix.length)}${suffix}`;
      count += 1;
      if (count > 1000) break;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  // Flattens a document's blocks into worksheet rows: a table or sheet block
  // keeps its grid, everything else becomes one cell per line, so nothing the
  // user wrote disappears just because the target format is a spreadsheet.
  function blocksToRows(blocks) {
    const rows = [];
    let line = [];
    const flush = () => { if (line.length) { rows.push(line); line = []; } };
    for (const block of asArray(blocks)) {
      if (!isObject(block)) continue;
      const type = String(block.type || "").toLowerCase();
      if (type === "table" || type === "sheet") { flush(); for (const r of rowsOf(block)) rows.push(r); continue; }
      if (type === "list") {
        for (const item of asArray(block.items)) { const v = cellText(item); if (v.trim()) line.push("\u2022 " + v); }
        continue;
      }
      if (type === "paragraph" || type === "heading" || type === "text") {
        const value = textOf(block);
        if (value.trim()) line.push(value);
        if (type === "heading") flush();
        continue;
      }
      if (type === "slide") flush();
    }
    flush();
    return rows;
  }

  function sheetList(doc) {
    const used = new Set();
    const given = asArray(doc.sheets);
    const out = [];
    if (given.length) {
      for (let i = 0; i < given.length; i++) {
        const sheet = asObject(given[i]);
        out.push({ name: sheetName(sheet.name, i, used), rows: rowsOf(sheet) });
      }
      return out;
    }
    // A document extraction may only carry sheet blocks; those are worksheets
    // already, and a table block is a small sheet of its own.
    for (const block of asArray(doc.blocks)) {
      if (!isObject(block)) continue;
      const type = String(block.type || "").toLowerCase();
      if (type === "sheet") out.push({ name: sheetName(block.name, out.length, used), rows: rowsOf(block) });
      else if (type === "table") out.push({ name: sheetName("", out.length, used), rows: rowsOf(block) });
    }
    // A Word, slide or PDF extraction is a run of paragraphs, not worksheets.
    // Without this it would become a valid but empty workbook and the text would
    // be gone with no error anywhere.
    if (!out.length) {
      const rows = blocksToRows(asArray(doc.blocks));
      if (rows.length) { out.push({ name: sheetName("", 0, used), rows }); return out; }
    }
    // A workbook with no sheets is a file Excel offers to repair.
    if (!out.length) out.push({ name: sheetName("", 0, new Set()), rows: [] });
    return out;
  }

  function worksheetXml(rows, strings) {
    const trimmed = rows.length > MAX_SHEET_ROWS ? rows.slice(0, MAX_SHEET_ROWS) : rows;
    const columns = Math.min(MAX_SHEET_COLUMNS, Math.max(columnCount(trimmed), 1));

    let out = XML_HEAD + `<worksheet xmlns="${NS.sheet}" xmlns:r="${NS.rel}">`;
    out += `<dimension ref="A1:${columnName(columns - 1)}${Math.max(1, trimmed.length)}"/>`;
    out += '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    out += '<sheetFormatPr defaultRowHeight="15"/>';

    // Widths are the longest value in the column plus a little air, so a
    // sheet of names or dates is readable without being stretched.
    const widths = [];
    for (let c = 0; c < columns; c++) widths.push(0);
    for (const row of trimmed) {
      for (let c = 0; c < columns && c < row.length; c++) {
        const length = row[c] ? row[c].length : 0;
        if (length > widths[c]) widths[c] = length;
      }
    }
    out += "<cols>";
    for (let c = 0; c < columns; c++) {
      const width = clamp(widths[c] + 2, 8, 50);
      out += `<col min="${c + 1}" max="${c + 1}" width="${width.toFixed(2)}" customWidth="1"/>`;
    }
    out += "</cols>";

    out += "<sheetData>";
    for (let r = 0; r < trimmed.length; r++) {
      const row = trimmed[r];
      let cells = "";
      for (let c = 0; c < columns && c < row.length; c++) {
        const value = row[c];
        if (value === "") continue;   // an empty cell is not a cell
        cells += `<c r="${columnName(c)}${r + 1}" t="s"><v>${strings.indexOf(value)}</v></c>`;
      }
      out += `<row r="${r + 1}">${cells}</row>`;
    }
    out += "</sheetData>";
    return out + "</worksheet>";
  }

  // Every value is a shared string, which is what a real file does and what
  // keeps a value that looks like a number ("007", a date, a formula) as the
  // text the user actually had. The table belongs to one workbook, so two
  // conversions in the same page cannot tread on each other.
  function createSharedStrings() {
    const list = [];
    const seen = new Map();
    return {
      list,
      references: 0,
      indexOf(value) {
        this.references += 1;
        const known = seen.get(value);
        if (known !== undefined) return known;
        const at = list.length;
        list.push(value);
        seen.set(value, at);
        return at;
      },
    };
  }

  function sharedStringsXml(strings) {
    let out = XML_HEAD + `<sst xmlns="${NS.sheet}" count="${strings.references}" uniqueCount="${strings.list.length}">`;
    for (const value of strings.list) {
      // Leading or trailing spaces only survive with xml:space set.
      const space = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : "";
      out += `<si><t${space}>${text(value)}</t></si>`;
    }
    return out + "</sst>";
  }

  // An explicit colour rather than a theme reference: this workbook carries
  // no theme part, and a theme="1" font colour would have nothing to resolve
  // against.
  function xlsxStylesXml() {
    return XML_HEAD +
      `<styleSheet xmlns="${NS.sheet}">` +
      '<fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>";
  }

  async function xlsx(input) {
    const doc = asObject(input);
    const sheets = sheetList(doc);
    const title = titleOf(doc, "Workbook");

    const JSZip = await loadZipLib();
    const zip = new JSZip();
    const strings = createSharedStrings();

    let workbook = XML_HEAD + `<workbook xmlns="${NS.sheet}" xmlns:r="${NS.rel}"><sheets>`;
    const rels = [];
    const overrides = [];
    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i];
      const part = `xl/worksheets/sheet${i + 1}.xml`;
      const id = `rIdSheet${i + 1}`;
      workbook += `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="${id}"/>`;
      rels.push({ id, type: `${NS.rel}/worksheet`, target: `worksheets/sheet${i + 1}.xml` });
      overrides.push({ part, type: CT.worksheet });
      sheets[i].part = part;
    }
    workbook += "</sheets></workbook>";

    // The sheets are written first so that every cell has already been given
    // its shared string index; the table itself is written below them.
    for (const sheet of sheets) {
      zip.file(sheet.part, worksheetXml(sheet.rows, strings));
    }

    rels.push({ id: "rIdSharedStrings", type: `${NS.rel}/sharedStrings`, target: "sharedStrings.xml" });
    rels.push({ id: "rIdStyles", type: `${NS.rel}/styles`, target: "styles.xml" });

    zip.file("xl/workbook.xml", workbook);
    zip.file("xl/_rels/workbook.xml.rels", relsXml(rels));
    zip.file("xl/sharedStrings.xml", sharedStringsXml(strings));
    zip.file("xl/styles.xml", xlsxStylesXml());
    writeCoreProps(zip, title);
    zip.file("_rels/.rels", rootRels("xl/workbook.xml"));
    zip.file("[Content_Types].xml", contentTypesXml(overrides.concat([
      { part: "xl/workbook.xml", type: CT.xlsx },
      { part: "xl/sharedStrings.xml", type: CT.sharedStrings },
      { part: "xl/styles.xml", type: CT.sheetStyles },
      { part: "docProps/core.xml", type: CT.core },
    ]), null));

    return pack(zip);
  }

  /* ---------- PowerPoint ---------- */

  function slideList(doc) {
    const given = asArray(doc.slides);
    const out = [];
    if (given.length) {
      for (const entry of given) out.push(asObject(entry));
      return out;
    }
    // Fall back to the document's own blocks, where each slide is a block.
    for (const block of asArray(doc.blocks)) {
      if (isObject(block) && String(block.type || "").toLowerCase() === "slide") out.push(block);
    }
    if (out.length) return out;
    // A Word or PDF extraction is a run of headings and paragraphs, not slides.
    // Without this it would become a valid deck of blank slides and the text
    // would be gone with no error anywhere.
    const content = asArray(doc.blocks).filter((b) => isObject(b) && String(b.type || "").toLowerCase() !== "sheet");
    if (content.length) { out.push({ title: "", blocks: content }); return out; }
    // A presentation with no slides will not open, so an empty deck gets one
    // blank slide rather than an empty file.
    out.push({ title: "", blocks: [] });
    return out;
  }

  const SLIDE_BODY_SIZES = [2000, 1800, 1400, 1200];
  const SLIDE_HEADING_SIZES = [2800, 2400, 2000, 1800];
  const SLIDE_TITLE_SIZE = 2800;

  // An estimate of how tall a line of text will be. PowerPoint has no chance
  // to reflow before it is shown, so the box is sized here and shrunk if the
  // text will not fit the slide.
  function lineCount(source, perLine) {
    let lines = 0;
    for (const line of String(source).split(/\r\n|\r|\n/)) {
      lines += Math.max(1, Math.ceil(line.length / perLine));
    }
    return Math.max(1, lines);
  }

  function textBoxHeight(source, sizeHundredths, widthEmu) {
    // A run size in DrawingML is hundredths of a point, and a box is measured
    // in EMU, so the size is converted before it is used.
    const points = sizeHundredths / 100;
    const charWidth = points * EMU_PER_PT * 0.52;
    const perLine = Math.max(6, Math.floor(widthEmu / charWidth));
    return Math.round(lineCount(source, perLine) * points * EMU_PER_PT * 1.25);
  }

  function fitSize(source, widthEmu, available, sizes) {
    for (const size of sizes) {
      if (textBoxHeight(source, size, widthEmu) <= available) return size;
    }
    return sizes[sizes.length - 1];
  }

  function aParagraph(runsXml, bullet, indent) {
    let properties = "";
    if (bullet) {
      properties += `<a:pPr marL="${indent}" indent="-${indent}"><a:buFont typeface="Arial"/><a:buChar char="\u2022"/></a:pPr>`;
    } else if (indent) {
      properties += `<a:pPr marL="${indent}"/>`;
    }
    return `<a:p>${properties}${runsXml || '<a:endParaRPr lang="en-US"/>'}</a:p>`;
  }

  function aRunXml(value, sizePt, bold, italic) {
    const attrs = ` lang="en-US" sz="${sizePt}" dirty="0"`;
    const weight = bold ? ' b="1"' : "";
    const slant = italic ? ' i="1"' : "";
    return `<a:r><a:rPr${attrs}${weight}${slant}><a:latin typeface="+mn-lt"/></a:rPr><a:t>${text(value)}</a:t></a:r>`;
  }

  function slideTextBox(id, x, y, cx, cy, paragraphs) {
    let out = "<p:sp>";
    out += `<p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`;
    out += "<p:spPr>";
    out += `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`;
    out += '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>';
    out += "</p:spPr>";
    out += '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>';
    out += paragraphs;
    out += "</p:txBody></p:sp>";
    return out;
  }

  function slidePicture(id, item, extent, x, y) {
    let out = "<p:pic>";
    out += `<p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/>` +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>';
    out += `<p:blipFill><a:blip r:embed="${item.id}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`;
    out += `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/>` +
      `<a:ext cx="${Math.round(extent.cx)}" cy="${Math.round(extent.cy)}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>';
    return out + "</p:pic>";
  }

  const SLIDE_ROW_HEIGHT = 320040; // 0.35in

  function slideTable(id, rows, x, y, width, columns) {
    const usable = width - SLIDE_MARGIN * 2;
    const columnWidth = Math.max(180000, Math.floor(usable / columns));
    const visible = rows.length > MAX_SLIDE_TABLE_ROWS ? rows.slice(0, MAX_SLIDE_TABLE_ROWS) : rows;
    const count = Math.max(1, Math.min(MAX_SLIDE_TABLE_COLUMNS, columns));
    const height = Math.max(SLIDE_ROW_HEIGHT, visible.length * SLIDE_ROW_HEIGHT);

    let out = "<p:graphicFrame>";
    out += `<p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>` +
      '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>';
    out += `<p:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(usable)}" cy="${Math.round(height)}"/></p:xfrm>`;
    out += `<a:graphic><a:graphicData uri="${NS.table}"><a:tbl>`;
    out += '<a:tblPr firstRow="1" bandRow="1"/>';
    out += "<a:tblGrid>";
    for (let c = 0; c < count; c++) out += `<a:gridCol w="${columnWidth}"/>`;
    out += "</a:tblGrid>";
    for (let r = 0; r < visible.length; r++) {
      out += `<a:tr h="${SLIDE_ROW_HEIGHT}">`;
      for (let c = 0; c < count; c++) {
        const value = c < visible[r].length ? visible[r][c] : "";
        out += "<a:tc>";
        let body = "";
        for (const line of linesOf(value)) {
          body += line
            ? aParagraph(aRunXml(line, 1200, r === 0, false), false, 0)
            : aParagraph("", false, 0);
        }
        out += `<a:txBody><a:bodyPr/><a:lstStyle/>${body}</a:txBody>`;
        out += "<a:tcPr/>";
        out += "</a:tc>";
      }
      out += "</a:tr>";
    }
    out += "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>";
    return { xml: out, height };
  }

  // One slide, laid out from the top down. Every shape states its own
  // position and size, so nothing depends on a placeholder inheriting its box
  // from the layout.
  function buildSlide(slide, media, nextId) {
    const rels = [{ id: "rIdLayout", type: `${NS.rel}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" }];
    const blocks = asArray(slide && slide.blocks);
    const width = SLIDE_WIDTH - SLIDE_MARGIN * 2;
    const bottom = SLIDE_HEIGHT - SLIDE_MARGIN;

    let shapes = "";
    let y = SLIDE_MARGIN;
    let id = nextId;

    const add = (xml, height) => {
      if (height <= 0) return false;
      if (y + height > bottom) return false;   // a slide is one screen; the rest does not fit
      shapes += xml;
      y += height;
      return true;
    };

    const title = slide && slide.title !== null && slide.title !== undefined ? String(slide.title) : "";
    if (title.trim()) {
      const size = SLIDE_TITLE_SIZE;
      const height = clamp(textBoxHeight(title, size, width) + 0.25 * EMU_PER_INCH, 0.6 * EMU_PER_INCH, 1.4 * EMU_PER_INCH);
      if (add(slideTextBox(id++, SLIDE_MARGIN, y, width, height,
        aParagraph(aRunXml(title, size, true, false), false, 0)), height)) {
        y += Math.round(0.15 * EMU_PER_INCH);
      }
    }

    for (const block of blocks) {
      if (!isObject(block)) continue;
      const type = String(block.type || "").toLowerCase();
      if (type === "image") {
        const item = media.add(block.bytes);
        if (!item) continue;
        const available = bottom - y;
        if (available < 0.4 * EMU_PER_INCH) break;
        const extent = imageExtent(item, block, width, available);
        rels.push({ id: item.id, type: `${NS.rel}/image`, target: `../media/${item.name}` });
        const x = SLIDE_MARGIN + Math.round((width - extent.cx) / 2);
        add(slidePicture(id++, item, extent, x, y), extent.cy);
        continue;
      }

      let source = "";
      if (type === "heading" || type === "paragraph" || type === "text") source = textOf(block);
      if (type === "heading") {
        if (!source) continue;
        const size = fitSize(source, width, bottom - y, SLIDE_HEADING_SIZES);
        const height = clamp(textBoxHeight(source, size, width) + 0.12 * EMU_PER_INCH, 0.3 * EMU_PER_INCH, bottom - y);
        if (add(slideTextBox(id++, SLIDE_MARGIN, y, width, height,
          aParagraph(aRunXml(source, size, true, false), false, 0)), height)) {
          y += Math.round(0.08 * EMU_PER_INCH);
        }
        continue;
      }
      if (type === "list") {
        const items = asArray(block.items);
        for (const item of items) {
          const value = cellText(item);
          if (!value.trim()) continue;
          const size = fitSize(value, width, bottom - y, SLIDE_BODY_SIZES);
          const height = clamp(textBoxHeight(value, size, width), 0.25 * EMU_PER_INCH, Math.max(0.25 * EMU_PER_INCH, bottom - y));
          if (!add(slideTextBox(id++, SLIDE_MARGIN, y, width, height,
            aParagraph(aRunXml(value, size, false, false), true, 228600)), height)) break;
        }
        continue;
      }
      if (type === "table") {
        const rows = rowsOf(block);
        if (!rows.length) continue;
        const columns = Math.max(1, Math.min(MAX_SLIDE_TABLE_COLUMNS, columnCount(rows)));
        const table = slideTable(id++, rows, SLIDE_MARGIN, y, width, columns);
        if (!add(table.xml, table.height)) break;
        continue;
      }
      if (type === "paragraph" || type === "text") {
        if (!source) continue;
        const runs = runsOf(block);
        const size = fitSize(source, width, bottom - y, SLIDE_BODY_SIZES);
        // A hard line break inside a paragraph becomes another a:p, which is
        // how PowerPoint stores one; the styling of the first run carries
        // over, because a line break inside a run has no style of its own.
        const bold = runs.length ? runs[0].bold : false;
        const italic = runs.length ? runs[0].italic : false;
        let body = "";
        for (const line of linesOf(source)) {
          body += line
            ? aParagraph(aRunXml(line, size, bold, italic), false, 0)
            : aParagraph("", false, 0);
        }
        const height = clamp(textBoxHeight(source, size, width), 0.25 * EMU_PER_INCH, Math.max(0.25 * EMU_PER_INCH, bottom - y));
        if (!add(slideTextBox(id++, SLIDE_MARGIN, y, width, height, body), height)) break;
      }
    }

    const tree = "<p:spTree>" +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      shapes +
      "</p:spTree>";

    const xml = XML_HEAD +
      `<p:sld xmlns:a="${NS.draw}" xmlns:r="${NS.rel}" xmlns:p="${NS.slide}">` +
      `<p:cSld>${tree}</p:cSld>` +
      "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>" +
      "</p:sld>";

    return { xml, rels, nextId: id };
  }

  function themeXml() {
    const accents = ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];
    // The colour scheme needs all twelve entries in a fixed order, or the
    // theme is not the theme the master and the slides resolve against.
    let colours =
      '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
      '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
      '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
      '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>';
    for (let i = 0; i < accents.length; i++) {
      colours += `<a:accent${i + 1}><a:srgbClr val="${accents[i]}"/></a:accent${i + 1}>`;
    }
    colours += '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>';

    const fills =
      "<a:fillStyleLst>" +
      "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>" +
      '<a:solidFill><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill>' +
      "</a:fillStyleLst>";
    const lines =
      "<a:lnStyleLst>" +
      '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
      '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
      '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
      "</a:lnStyleLst>";
    const effects =
      "<a:effectStyleLst>" +
      "<a:effectStyle><a:effectLst/></a:effectStyle>" +
      "<a:effectStyle><a:effectLst/></a:effectStyle>" +
      "<a:effectStyle><a:effectLst/></a:effectStyle>" +
      "</a:effectStyleLst>";
    const backgrounds =
      "<a:bgFillStyleLst>" +
      "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>" +
      '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill>' +
      "</a:bgFillStyleLst>";

    return XML_HEAD +
      `<a:theme xmlns:a="${NS.draw}" name="SwiftPDF">` +
      "<a:themeElements>" +
      `<a:clrScheme name="SwiftPDF">${colours}</a:clrScheme>` +
      '<a:fontScheme name="SwiftPDF">' +
      '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
      '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
      "</a:fontScheme>" +
      `<a:fmtScheme name="SwiftPDF">${fills}${lines}${effects}${backgrounds}</a:fmtScheme>` +
      "</a:themeElements>" +
      "<a:objectDefaults/><a:extraClrSchemeLst/>" +
      "</a:theme>";
  }

  const EMPTY_SP_TREE =
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

  // A master is not optional: every slide layout belongs to one, and a master
  // without a theme is a package PowerPoint refuses.
  function slideMasterXml() {
    return XML_HEAD +
      `<p:sldMaster xmlns:a="${NS.draw}" xmlns:r="${NS.rel}" xmlns:p="${NS.slide}">` +
      `<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${EMPTY_SP_TREE}</p:cSld>` +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"' +
      ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      "<p:txStyles>" +
      '<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="2800"/></a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>' +
      '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>' +
      "</p:txStyles>" +
      "</p:sldMaster>";
  }

  // A blank layout: the writer draws its own text boxes, so a layout full of
  // placeholders would only add empty shapes to every slide.
  function slideLayoutXml() {
    return XML_HEAD +
      `<p:sldLayout xmlns:a="${NS.draw}" xmlns:r="${NS.rel}" xmlns:p="${NS.slide}" type="blank" preserve="1">` +
      `<p:cSld name="Blank">${EMPTY_SP_TREE}</p:cSld>` +
      "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>" +
      "</p:sldLayout>";
  }

  async function pptx(input) {
    const doc = asObject(input);
    const slides = slideList(doc);
    const title = titleOf(doc, "Presentation");

    const JSZip = await loadZipLib();
    const zip = new JSZip();
    const media = createMedia("ppt/media/");

    const overrides = [
      { part: "ppt/presentation.xml", type: CT.pptx },
      { part: "ppt/slideMasters/slideMaster1.xml", type: CT.master },
      { part: "ppt/slideLayouts/slideLayout1.xml", type: CT.layout },
      { part: "ppt/theme/theme1.xml", type: CT.theme },
      { part: "docProps/core.xml", type: CT.core },
    ];
    const presentationRels = [
      { id: "rIdMaster", type: `${NS.rel}/slideMaster`, target: "slideMasters/slideMaster1.xml" },
    ];

    let idList = "";
    let nextId = 2;
    for (let i = 0; i < slides.length; i++) {
      const built = buildSlide(slides[i], media, nextId);
      nextId = built.nextId;
      const part = `ppt/slides/slide${i + 1}.xml`;
      zip.file(part, built.xml);
      zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relsXml(built.rels));
      overrides.push({ part, type: CT.slide });
      const relId = `rIdSlide${i + 1}`;
      presentationRels.push({ id: relId, type: `${NS.rel}/slide`, target: `slides/slide${i + 1}.xml` });
      idList += `<p:sldId id="${256 + i}" r:id="${relId}"/>`;
    }

    const presentation = XML_HEAD +
      `<p:presentation xmlns:a="${NS.draw}" xmlns:r="${NS.rel}" xmlns:p="${NS.slide}" saveSubsetFonts="1">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>' +
      `<p:sldIdLst>${idList}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>` +
      '<p:notesSz cx="6858000" cy="9144000"/>' +
      "</p:presentation>";

    zip.file("ppt/presentation.xml", presentation);
    zip.file("ppt/_rels/presentation.xml.rels", relsXml(presentationRels));
    zip.file("ppt/slideMasters/slideMaster1.xml", slideMasterXml());
    zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", relsXml([
      { id: "rId1", type: `${NS.rel}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: `${NS.rel}/theme`, target: "../theme/theme1.xml" },
    ]));
    zip.file("ppt/slideLayouts/slideLayout1.xml", slideLayoutXml());
    zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", relsXml([
      { id: "rId1", type: `${NS.rel}/slideMaster`, target: "../slideMasters/slideMaster1.xml" },
    ]));
    zip.file("ppt/theme/theme1.xml", themeXml());
    media.addTo(zip);
    writeCoreProps(zip, title);
    zip.file("_rels/.rels", rootRels("ppt/presentation.xml"));
    zip.file("[Content_Types].xml", contentTypesXml(overrides, media.extensions));

    return pack(zip);
  }

  /* ---------- public API ---------- */

  // The download extension -> content type a page needs to name the file it
  // has just been handed.
  function mimeFor(extension) {
    const key = String(extension === null || extension === undefined ? "" : extension)
      .toLowerCase()
      .trim()
      .split(";")[0]
      .trim()
      .replace(/^\./, "");
    return MIMES[key] || "application/octet-stream";
  }

  window.SwiftFileWriters = { docx, xlsx, pptx, mimeFor };
})();
