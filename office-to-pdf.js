/* SwiftPDF — Word, PowerPoint and Excel to PDF, entirely in the browser.
 *
 * The promise of this site is that a file never leaves the device, so there is
 * no server to render anything. A .docx/.pptx/.xlsx is a ZIP of XML, and this
 * engine rebuilds a *text-and-images* PDF from it: real text, real images,
 * sensible reading order, real page breaks, in a generic font. The original
 * layout is not reproduced, and the caller is told so through `warnings`.
 * Silence about a lossy conversion is a bug, not a feature.
 *
 * The same parsers also answer extract(), which hands the same content back as
 * ordered blocks for the other office formats to write out - with the original
 * characters kept, which a PDF made from them cannot promise.
 *
 * Nothing runs at load time beyond defining window.SwiftOffice, and `document`
 * is never touched at module scope, so the file is safe to include anywhere.
 */
(function () {
  "use strict";

  /* ---------- geometry and limits ---------- */

  const A4_WIDTH = 595.28;
  const A4_HEIGHT = 841.89;
  const MARGIN = 56;
  // A text page conventionally carries a slightly smaller margin at the top
  // than at the sides, which also keeps the first baseline clear of the edge.
  const TOP_MARGIN = 50;
  const BODY_SIZE = 11;
  const LINE_FACTOR = 1.22;
  const EMU_PER_PT = 12700;
  const CHAR_WIDTH_PT = 7;        // spreadsheet character width -> points
  const DEFAULT_COLUMN_PT = 8.43 * CHAR_WIDTH_PT + 5;
  const SHEET_FONT_SIZE = 9;
  const SHEET_ROW_HEIGHT = 13;
  const MAX_UNCOMPRESSED = 200 * 1024 * 1024;
  const MAX_ENTRIES = 6000;
  const MAX_IMAGES = 400;
  const MAX_GRID_COLUMNS = 200;
  const MAX_GRID_ROWS = 5000;
  const MAX_COLUMN_PT = 160;
  // The room inside a column for its own text: three points at the left, where
  // the text starts, and the rest as the gap that keeps one column's text clear
  // of the next one's. A squeezed sheet gives up everything else before this.
  const SHEET_CELL_PAD = 6;
  // A column is made a fraction wider than the bare measurement of its text.
  // The width is worked out once when the sheet is laid out and again when the
  // cell is drawn, and the two land a hair apart; a column sized to the last
  // decimal would drop the final letter of its own header.
  const SHEET_CELL_SLACK = 0.75;
  // How much wider than its own text a column would like to be when there is
  // room to spare, so that a sheet with few columns still reads as a
  // spreadsheet rather than as a block of text with hairlines through it.
  const SHEET_ROOMY_COLUMN_PT = 14;
  // The narrowest a column may be and still show a word rather than a stroke.
  const MIN_COLUMN_PT = 22;
  // Below this a sheet's text stops being readable, so a crowded sheet is
  // squeezed no further than this however many columns it has.
  const MIN_SHEET_FONT = 6;
  const MIN_SHEET_ROW_PT = 8;

  const COLORS = {
    text: [0.08, 0.09, 0.1],
    grid: [0.82, 0.84, 0.87],
    rule: [0.45, 0.48, 0.52],
    headerFill: [0.93, 0.94, 0.96],
    slideEdge: [0.86, 0.87, 0.9],
    muted: [0.38, 0.4, 0.44],
  };

  const KINDS = ["docx", "pptx", "xlsx"];

  const BASE_WARNINGS = {
    docx: "Fonts, colours, spacing and the original page layout are not reproduced. This PDF contains the text, tables and images in reading order, set in a standard font.",
    pptx: "Slides are reproduced at their original size, but fonts, colours, backgrounds and animations are not. Text and images appear in the order they sit on the slide.",
    xlsx: "Only the cells that have content are included, drawn as a plain grid. Fonts, colours, number formats, formulas, charts, comments and merged cells are not reproduced.",
  };

  const UNSUPPORTED_WARNINGS = {
    docx: "Things that are not plain paragraphs — footnotes, comments, headers and footers, text boxes, charts, equations and tracked changes — are not included.",
    pptx: "Video, audio, animations, transitions and some text effects are not included.",
    xlsx: "Charts, pictures, comments, conditional formatting, and anything that is not a cell value are not included.",
  };

  const IMAGE_WARNING =
    "Some images could not be included because they are saved in a format that cannot go into a PDF (for example GIF, BMP, WMF or EMF). Open the document and save those pictures as PNG or JPEG for a complete result.";

  const FONT_WARNING =
    "Some characters in this document are outside the standard PDF font (for example Hindi, Chinese or emoji) and were replaced with “?”. Export it as a PDF from Word or Excel for full fidelity.";

  /* ---------- naming ---------- */

  function fileNameOf(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (typeof input.name === "string") return input.name;
    if (typeof input.fileName === "string") return input.fileName;
    return "";
  }

  function nameOrFallback(input) {
    const base = fileNameOf(input).split(/[\\/]/).pop();
    return base || "This file";
  }

  function kindOf(fileOrName) {
    const raw = fileNameOf(fileOrName);
    if (!raw) return null;
    // A dropped path or a cache-busting query must not hide the real extension.
    const name = raw.split(/[?#]/)[0].trim().toLowerCase();
    const match = name.match(/\.([a-z0-9]+)$/);
    if (!match) return null;
    return KINDS.indexOf(match[1]) === -1 ? null : match[1];
  }

  function isOfficeFile(fileOrName) {
    return kindOf(fileOrName) !== null;
  }

  // Every error the caller may see is a finished sentence that starts with the
  // file name, so the UI never has to splice wording together itself.
  function userError(name, rest) {
    const error = new Error(`${name} ${rest}`);
    error.swiftOfficeUserFacing = true;
    return error;
  }

  // extract() hands the text to another office format rather than to a PDF, so
  // it must not repeat the lossy wording of FONT_WARNING above: on this path
  // nothing was replaced.
  const UNICODE_WARNING =
    "This document contains characters outside the Latin alphabet (for example Hindi, Chinese or emoji). They have been kept exactly as they are written, but a PDF made from them will show “?” in their place.";

  const EXTRACT_WARNINGS = {
    docx: "The headings, paragraphs, lists, tables and pictures are read out of the document in reading order. Fonts, colours, spacing and the original page layout are not carried across, and footnotes, comments, headers and footers, text boxes, charts, equations and tracked changes are not included.",
    pptx: "The text and pictures of every slide are read out in slide order. Fonts, colours, backgrounds, animations and slide layouts are not carried across, and video, audio and anything that is not a shape are not included.",
    xlsx: "The cells that have content are read out of every sheet, in workbook order. Number formats, formulas, charts, comments, conditional formatting and merged cells are not carried across.",
  };

  // One progress reporter for both public entry points, so the contract that a
  // throwing callback must never fail a conversion is written down once.
  function createProgress(onProgress, total) {
    let done = 0;
    return (label) => {
      done += 1;
      if (!onProgress) return;
      try {
        onProgress(done, total, label);
      } catch (err) {
        // A broken progress callback must never fail somebody's conversion.
      }
    };
  }

  /* ---------- XML and relationship helpers ---------- */

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function localName(node) {
    if (!node) return "";
    return node.localName || String(node.nodeName || "").replace(/^.*:/, "");
  }

  function childrenOf(node, name) {
    const out = [];
    if (!node) return out;
    for (const child of node.children) {
      if (!name || localName(child) === name) out.push(child);
    }
    return out;
  }

  function firstOf(node, name) {
    if (!node) return null;
    for (const child of node.children) {
      if (localName(child) === name) return child;
    }
    return null;
  }

  function findFirst(node, name) {
    if (!node) return null;
    for (const child of node.children) {
      if (localName(child) === name) return child;
      const found = findFirst(child, name);
      if (found) return found;
    }
    return null;
  }

  // OOXML writes every attribute namespaced (w:val, a:sz, p:b ...), and a
  // prefixed lookup is not portable, so fall back to matching the local name.
  function attr(node, name) {
    if (!node || !node.attributes) return null;
    const direct = node.getAttribute(name);
    if (direct !== null) return direct;
    for (const item of node.attributes) {
      if (item.localName === name) return item.value;
    }
    return null;
  }

  function numAttr(node, name) {
    const value = Number(attr(node, name));
    return Number.isFinite(value) ? value : 0;
  }

  // r:id and r:embed share their local name with plain id attributes, so the
  // relationships namespace is the only thing that tells them apart.
  function relAttr(node, name) {
    if (!node || !node.attributes) return null;
    for (const item of node.attributes) {
      if (item.localName !== name) continue;
      if ((item.namespaceURI || "").indexOf("relationships") !== -1) return item.value;
    }
    return null;
  }

  function flagOn(node) {
    if (!node) return false;
    const value = attr(node, "val");
    if (value === null) return true;
    const lower = String(value).toLowerCase();
    return lower === "1" || lower === "true" || lower === "on";
  }

  // An OOXML part is addressed relative to the part that references it, and
  // "media/image1.png" and "../media/image1.png" are both normal.
  function resolvePart(basePart, target) {
    const parts = basePart.split("/");
    parts.pop();
    for (const segment of String(target).split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    return parts.join("/");
  }

  function parseXml(text) {
    if (typeof DOMParser !== "function") return null;
    try {
      const parsed = new DOMParser().parseFromString(text, "application/xml");
      if (!parsed || parsed.querySelector("parsererror")) return null;
      const root = parsed.documentElement;
      return root && root.nodeType === 1 ? root : null;
    } catch (err) {
      return null;
    }
  }

  // A shared string or a rich-text run can hold several <t> elements; the
  // value is all of them together.
  function concatDescendantText(node) {
    let out = "";
    for (const child of node.children) {
      out += localName(child) === "t" ? child.textContent : concatDescendantText(child);
    }
    return out;
  }

  /* ---------- ZIP central directory guard ----------
   * A hostile archive can declare a few kilobytes and expand to gigabytes.
   * Reading the central directory costs nothing and refuses the file before a
   * single entry is ever decompressed. */

  function readZipDirectory(bytes) {
    const length = bytes.length;
    if (length < 22) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The directory sits at the end, just before an optional comment (max 64K).
    const lowest = Math.max(0, length - 22 - 0xffff);
    for (let i = length - 22; i >= lowest; i--) {
      if (view.getUint32(i, true) !== 0x06054b50) continue;
      return {
        entries: view.getUint16(i + 10, true),
        size: view.getUint32(i + 12, true),
        offset: view.getUint32(i + 16, true),
      };
    }
    return null;
  }

  function sumUncompressed(bytes, directory) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = Math.min(directory.offset + directory.size, bytes.length);
    let total = 0;
    let position = directory.offset;
    while (position + 46 <= end && view.getUint32(position, true) === 0x02014b50) {
      total += view.getUint32(position + 24, true); // uncompressed size
      position += 46
        + view.getUint16(position + 28, true)   // file name length
        + view.getUint16(position + 30, true)   // extra field length
        + view.getUint16(position + 32, true);  // comment length
    }
    return total;
  }

  function guardZip(bytes, name) {
    const looksLikeZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (!looksLikeZip) {
      throw userError(name,
        "is not a Word, PowerPoint or Excel document that this converter can open. SwiftPDF reads .docx, .pptx and .xlsx files, which are ZIP archives. If this is an older .doc, .ppt or .xls file, save it in the newer format first.");
    }
    const directory = readZipDirectory(bytes);
    if (!directory) return; // let JSZip try; its own failure is reported further down
    if (directory.entries > MAX_ENTRIES) {
      throw userError(name,
        `is a ZIP archive holding ${directory.entries} files, far more than a Word, PowerPoint or Excel document should contain, so it was not opened.`);
    }
    let declared = 0;
    try {
      declared = sumUncompressed(bytes, directory);
    } catch (err) {
      declared = 0;
    }
    // A ZIP64 or truncated directory reports nothing useful, so assume a
    // generous but still bounded expansion rather than trust an unknown value.
    const estimate = declared > 0 ? declared : bytes.length * 100;
    if (estimate > MAX_UNCOMPRESSED) {
      throw userError(name,
        "is a ZIP archive that expands to more than 200 MB when opened, which is far more than a document of this size should contain, so it was not opened.");
    }
  }

  // Opening the archive is step one of every entry point, so the guard that
  // stands in front of it lives here too. The same damaged file must produce
  // the same sentence whichever function the caller reached for.
  async function openZip(bytes, name) {
    const JSZip = await loadJsZip();
    let zip = null;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch (err) {
      throw userError(name,
        "could not be opened. The file is damaged, or it is not a complete Word, PowerPoint or Excel document.");
    }
    if (Object.keys(zip.files).length > MAX_ENTRIES) {
      throw userError(name,
        `is a ZIP archive holding more than ${MAX_ENTRIES} files, far more than a document should contain, so it was not opened.`);
    }
    return zip;
  }

  // Identify the file, read it into memory and put it past the zip-bomb guard.
  // Both toPdf() and extract() start here, so neither can end up with a
  // different idea of what the same bytes mean.
  async function readSource(file) {
    const name = nameOrFallback(file);
    const kind = kindOf(file);
    if (!kind) {
      throw userError(name,
        "is not a Word, PowerPoint or Excel document that this converter can open. SwiftPDF converts .docx, .pptx and .xlsx files.");
    }
    if (!file || typeof file.arrayBuffer !== "function") {
      throw userError(name, "could not be read. Choose the file again and try.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    guardZip(bytes, name);
    return { name, kind, bytes };
  }

  /* ---------- fonts, encoding and measurement ---------- */

  // The PDF standard fonts are WinAnsi: Latin-1 plus a handful of symbols
  // between 0x80 and 0x9f, and nothing above 0xff. extract() never draws, so it
  // has no font to interrogate and uses this range test instead of the exact
  // query below. That is safe because it only decides whether to *mention*
  // text it cannot encode - the characters themselves are kept either way.
  function outsideLatinFont(character) {
    const code = character.codePointAt(0);
    if (code < 0xa0) return code >= 128;
    return code > 0xff;
  }

  // `preserve` is the one deliberate difference between the two entry points.
  // toPdf has no choice but to replace a character its font cannot draw; for
  // extract() that same character is the user's own text, and a Word-to-Excel
  // conversion that silently turns Hindi into "?" is a data loss bug. So the
  // identical parser runs in both, it is the replacement that is switched off,
  // and both count exactly the same characters so the two warnings stay honest.
  function createShaper(fonts, options) {
    const preserve = !!(options && options.preserve);
    const encodable = new Map();
    const dropped = { count: 0 };

    // WinAnsi cannot represent most of the world's scripts. Rather than let
    // pdf-lib throw halfway through a document and lose the whole conversion,
    // find the offending characters up front, count them, and say so.
    function canEncode(character, bold) {
      if (preserve) return !outsideLatinFont(character);
      const key = `${bold ? "b" : "r"}|${character}`;
      const known = encodable.get(key);
      if (known !== undefined) return known;
      const font = bold ? fonts.bold : fonts.regular;
      let ok = true;
      try {
        const encode = typeof font.encodeText === "function"
          ? font.encodeText
          : font.embedder.encodeText.bind(font.embedder);
        encode(character);
      } catch (err) {
        ok = false;
      }
      encodable.set(key, ok);
      return ok;
    }

    function sanitize(text) {
      if (!text) return "";
      let out = "";
      for (const character of String(text)) {
        const code = character.charCodeAt(0);
        // Line breaks and tabs are added by the parsers on purpose, so they
        // survive; every other control character is noise from a bad file.
        if (code === 10 || code === 13 || code === 9) { out += character; continue; }
        if (code < 32) continue;
        if (code < 128) { out += character; continue; }  // plain ASCII always encodes
        if (canEncode(character, false)) out += character;
        else {
          out += preserve ? character : "?";
          dropped.count++;
        }
      }
      return out;
    }

    function width(text, font, size) {
      if (!text) return 0;
      try {
        return font.widthOfTextAtSize(text, size);
      } catch (err) {
        // Belt and braces: everything measured has already been sanitised.
        return text.length * size * 0.5;
      }
    }

    return { sanitize, width, dropped };
  }

  // extract() parses with no PDF document and so no fonts to pick from. It
  // never measures or draws, so a font is not something it needs; the parsers
  // can still record one and let the renderer choose later.
  function pickFont(ctx, bold, italic) {
    if (!ctx.fonts) return null;
    if (bold && italic) return ctx.fonts.boldItalic;
    if (bold) return ctx.fonts.bold;
    if (italic) return ctx.fonts.italic;
    return ctx.fonts.regular;
  }

  /* ---------- line breaking ----------
   * Styled runs are tokenised once, so wrapping can run across a run boundary
   * without inventing a space the document never had, and every token keeps the
   * formatting of the characters it covers. */

  function makeTextToken(text, seg, ctx, kind) {
    const measured = ctx.shaper.width(text, seg.font, seg.size);
    return { kind, width: measured, pieces: [{ seg, text, width: measured }] };
  }

  function tokenWidth(token) {
    let total = 0;
    for (const piece of token.pieces) total += piece.width;
    return total;
  }

  // "hel" + "lo" in two runs is one word, so neighbouring word tokens join.
  function mergeTokens(tokens) {
    const out = [];
    for (const token of tokens) {
      const last = out[out.length - 1];
      if (last && last.kind === "word" && token.kind === "word") {
        last.pieces = last.pieces.concat(token.pieces);
        last.width = tokenWidth(last);
        continue;
      }
      out.push(token);
    }
    return out;
  }

  // A hard break inside a run: <w:br/>, a carriage return, or U+2028.
  function isBreakAt(text, index) {
    const code = text.charCodeAt(index);
    return code === 10 || code === 13 || code === 0x2028;
  }

  function tokenize(items, ctx) {
    const tokens = [];
    for (const item of items) {
      if (!item) continue;
      if (item.image) {
        tokens.push({ kind: "image", width: item.image.width, pieces: [], image: item.image });
        continue;
      }
      if (!item.text) continue;
      const text = item.text;
      let buffer = "";
      let i = 0;
      const flushBuffer = () => {
        if (!buffer) return;
        tokens.push(makeTextToken(buffer, item, ctx, "word"));
        buffer = "";
      };
      while (i < text.length) {
        const character = text[i];
        if (isBreakAt(text, i)) {
          flushBuffer();
          while (i < text.length && isBreakAt(text, i)) i++;
          tokens.push({ kind: "break", width: 0, pieces: [] });
          continue;
        }
        if (/\s/.test(character)) {
          flushBuffer();
          const start = i;
          while (i < text.length && /\s/.test(text[i]) && !isBreakAt(text, i)) i++;
          // The run is kept exactly as typed: a document that indents or
          // separates with several spaces should not have them squeezed to one.
          tokens.push(makeTextToken(text.slice(start, i) || " ", item, ctx, "space"));
          continue;
        }
        buffer += character;
        i++;
      }
      flushBuffer();
    }
    return mergeTokens(tokens);
  }

  // A single word wider than the column is broken by character; without this a
  // long URL would run straight off the page.
  function splitOversizedWord(token, maxWidth, ctx) {
    const parts = [];
    let current = { kind: "word", width: 0, pieces: [] };
    for (const piece of token.pieces) {
      let chunk = "";
      let chunkWidth = 0;
      for (const character of piece.text) {
        const characterWidth = ctx.shaper.width(character, piece.seg.font, piece.seg.size);
        if (chunk && chunkWidth + characterWidth > maxWidth) {
          current.pieces.push({ seg: piece.seg, text: chunk, width: chunkWidth });
          parts.push(current);
          current = { kind: "word", width: 0, pieces: [] };
          chunk = "";
          chunkWidth = 0;
        }
        chunk += character;
        chunkWidth += characterWidth;
      }
      if (chunk) {
        current.pieces.push({ seg: piece.seg, text: chunk, width: chunkWidth });
        current.width += chunkWidth;
      }
    }
    if (current.pieces.length) parts.push(current);
    return parts.length ? parts : [token];
  }

  function wrapTokens(tokens, maxWidth, ctx) {
    const width = Math.max(8, maxWidth);
    const lines = [];
    let line = [];
    let lineWidth = 0;
    const flush = () => {
      lines.push({ pieces: line, width: lineWidth });
      line = [];
      lineWidth = 0;
    };
    for (const token of tokens) {
      if (token.kind === "break") { flush(); continue; }
      if (token.kind === "image") {
        if (line.length) flush();
        lines.push({ pieces: [], width: Math.min(token.width, width), image: token.image });
        continue;
      }
      const size = tokenWidth(token);
      if (token.kind === "space") {
        if (!line.length) continue;                    // never start a line with a space
        if (lineWidth + size > width) { flush(); continue; }
        line = line.concat(token.pieces);
        lineWidth += size;
        continue;
      }
      if (lineWidth + size <= width) {
        line = line.concat(token.pieces);
        lineWidth += size;
        continue;
      }
      if (line.length) flush();
      if (size <= width) {
        line = line.concat(token.pieces);
        lineWidth = size;
        continue;
      }
      const parts = splitOversizedWord(token, width, ctx);
      for (let i = 0; i < parts.length - 1; i++) {
        line = parts[i].pieces;
        lineWidth = parts[i].width;
        flush();
      }
      line = parts[parts.length - 1].pieces;
      lineWidth = parts[parts.length - 1].width;
    }
    if (line.length) flush();
    return lines;
  }

  function lineSize(line, fallback) {
    let size = 0;
    for (const piece of line.pieces) size = Math.max(size, piece.seg.size);
    return size || fallback || BODY_SIZE;
  }

  /* ---------- images ---------- */

  function sniffImage(bytes) {
    if (!bytes || bytes.length < 8) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes.length > 24) return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    return null;
  }

  // Both formats state their pixel size in the first few bytes, so the aspect
  // ratio is known without decoding the pixels.
  function imagePixelSize(bytes, kind) {
    try {
      if (kind === "png") {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
      }
      if (kind === "jpg") {
        let i = 2;
        while (i < bytes.length - 9) {
          if (bytes[i] !== 0xff) { i++; continue; }
          const marker = bytes[i + 1];
          if (marker === 0xff) { i++; continue; }
          if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
          const length = (bytes[i + 2] << 8) | bytes[i + 3];
          const isFrame = marker >= 0xc0 && marker <= 0xcf
            && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (isFrame) {
            return {
              height: (bytes[i + 5] << 8) | bytes[i + 6],
              width: (bytes[i + 7] << 8) | bytes[i + 8],
            };
          }
          i += 2 + length;
        }
      }
    } catch (err) {
      // fall through to the default below
    }
    return { width: 300, height: 200 };
  }

  function imageSignature(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return `${bytes.length}:${hash.toString(16)}`;
  }

  async function embedImages(ctx, items) {
    const seen = new Map();
    let count = 0;
    let announced = false;
    for (const item of items) {
      const image = item.image;
      if (image.embedded === null && image.attempted) continue;
      if (++count > MAX_IMAGES) {
        image.embedded = null;
        image.attempted = true;
        if (!announced) {
          announced = true;
          ctx.warn("Some images were left out because this file contains a very large number of them.");
        }
        continue;
      }
      const signature = imageSignature(image.bytes);
      if (seen.has(signature)) {
        image.embedded = seen.get(signature);
        image.attempted = true;
        continue;
      }
      let embedded = null;
      try {
        embedded = image.kind === "png"
          ? await ctx.doc.embedPng(image.bytes)
          : await ctx.doc.embedJpg(image.bytes);
      } catch (err) {
        ctx.warn("One image could not be included because it is damaged or uses a feature this converter does not read.");
      }
      image.attempted = true;
      image.embedded = embedded;
      seen.set(signature, embedded);
    }
  }

  function fitImage(image, maxWidth, maxHeight, allowUpscale) {
    const width = Math.max(1, image.width);
    const height = Math.max(1, image.height);
    let scale = Math.min(maxWidth / width, maxHeight / height);
    if (!allowUpscale) scale = Math.min(scale, 1);
    return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
  }

  /* ---------- conversion context ---------- */

  function createContext(doc, fonts, shaper, pdf) {
    const seen = new Set();
    return {
      doc,
      fonts,
      shaper,
      pdf,
      name: "",
      kind: "",
      colors: COLORS,
      warnings: [],
      stats: { images: 0, characters: 0, droppedCharacters: 0 },
      warn(message) {
        if (!message || seen.has(message)) return;
        seen.add(message);
        this.warnings.push(message);
      },
      color(rgb) {
        return pdf.rgb(rgb[0], rgb[1], rgb[2]);
      },
      addPage(width, height) {
        return this.doc.addPage([width, height]);
      },
    };
  }

  /* ---------- page flow (Word and Excel) ---------- */

  function createFlow(ctx, width, height, startPage) {
    const flow = {
      page: null,
      pageWidth: width,
      pageHeight: height,
      left: MARGIN,
      right: width - MARGIN,
      top: TOP_MARGIN,
      bottom: height - MARGIN,
      y: TOP_MARGIN,
      newPage() {
        this.page = ctx.addPage(width, height);
        this.y = this.top;
        return this.page;
      },
      // `y` counts down the page; PDF measures up from the bottom-left corner.
      down(distance) {
        return height - distance;
      },
      ensure(needed) {
        if (this.y + needed <= this.bottom) return false;
        this.newPage();
        return true;
      },
      advance(needed) {
        this.ensure(needed);
        this.y += needed;
      },
      // Space between paragraphs is dropped rather than forced: a break here
      // would leave a stub of white space at the top of the next page, and a
      // gap that will not fit is not worth a blank page of its own.
      gap(needed) {
        if (this.y + needed <= this.bottom) this.y += needed;
      },
    };
    if (startPage !== false) flow.newPage();
    return flow;
  }

  // Each visual line is drawn as whole text runs rather than one call per run of
  // the source document: a reader that extracts the text then sees real spaces
  // between the words, and the PDF carries fewer, tidier show operations.
  function paintLine(ctx, page, line, x, baseline, justifyExtra) {
    let cursor = x;
    let run = null;
    let gaps = 0;
    if (justifyExtra) {
      for (const piece of line.pieces) if (piece.text === " ") gaps++;
    }
    const extra = gaps ? justifyExtra / gaps : 0;
    const flush = () => {
      if (run && run.text) {
        // Sanitised again on the way to the page: cheap, idempotent, and it means
        // a future call site cannot reintroduce the "whole file fails on one odd
        // character" bug.
        const safe = ctx.shaper.sanitize(run.text);
        page.drawText(safe, {
          x: run.x,
          y: baseline,
          size: run.size,
          font: run.font,
          color: ctx.color(COLORS.text),
        });
        ctx.stats.characters += safe.length;
      }
      run = null;
    };
    for (const piece of line.pieces) {
      const size = piece.seg.size;
      // Justified text has to break at every space, because that is where the
      // slack is being taken up.
      const continues = run && run.font === piece.seg.font && run.size === size
        && !(extra && piece.text === " ");
      if (continues) run.text += piece.text;
      else {
        flush();
        run = { x: cursor, size, font: piece.seg.font, text: piece.text };
      }
      cursor += piece.width + (extra && piece.text === " " ? extra : 0);
    }
    flush();
  }

  function paintImageInFlow(ctx, flow, image) {
    if (!image.embedded) return;
    const maxWidth = flow.right - flow.left;
    const size = fitImage(image, maxWidth, flow.bottom - flow.top, false);
    if (flow.y + size.height > flow.bottom) flow.newPage();
    flow.page.drawImage(image.embedded, {
      x: flow.left,
      y: flow.down(flow.y + size.height),
      width: size.width,
      height: size.height,
    });
    ctx.stats.images++;
    flow.y += size.height + 6;
  }

  function renderFlowItems(ctx, flow, items, options) {
    const left = options.left === undefined ? flow.left : options.left;
    const maxWidth = options.maxWidth === undefined ? flow.right - flow.left : options.maxWidth;
    const lineHeight = options.lineHeight || BODY_SIZE * LINE_FACTOR;
    const align = options.align || "left";
    const lines = wrapTokens(tokenize(items, ctx), maxWidth, ctx);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.image) {
        paintImageInFlow(ctx, flow, line.image);
        continue;
      }
      flow.advance(lineHeight);
      const size = lineSize(line, options.size);
      // flow.y is the foot of the line box, counted down from the top of the
      // page; PDF measures up from the foot of the sheet.
      const baseline = flow.down(flow.y - lineHeight + size * 0.82);
      let justifyExtra = 0;
      let x = left;
      if (align === "center") x = left + Math.max(0, (maxWidth - line.width) / 2);
      else if (align === "right") x = left + Math.max(0, maxWidth - line.width);
      else if (align === "both" && index < lines.length - 1) {
        // Justification hands the slack to the spaces, so nothing is re-measured
        // and no line can be pushed past the margin.
        const slack = maxWidth - line.width;
        if (slack > 0 && slack < maxWidth * 0.6) justifyExtra = slack;
      }
      paintLine(ctx, flow.page, line, x, baseline, justifyExtra);
    }
  }

  /* ---------- DOCX ---------- */

  const HEADING_SIZES = { title: 24, 1: 18, 2: 15, 3: 13, 4: 12, 5: 11, 6: 11 };

  function headingInfo(style) {
    const lower = String(style || "").toLowerCase().replace(/\s+/g, "");
    // The level is recorded alongside the size: extract() needs to know it was
    // a heading, while the renderer only ever wanted the point size.
    if (lower === "title") return { level: 1, size: HEADING_SIZES.title, spaceBefore: 10 };
    if (lower === "subtitle") return { level: 2, size: 13, spaceBefore: 6 };
    const match = lower.match(/^heading([1-6])$/);
    if (match) {
      return { level: Number(match[1]), size: HEADING_SIZES[match[1]], spaceBefore: match[1] === "1" ? 10 : 7 };
    }
    return null;
  }

  function docxAlign(value) {
    const lower = String(value || "").toLowerCase();
    if (lower === "center" || lower === "right") return lower;
    if (lower === "both" || lower === "justify") return "both";
    return "left";
  }

  function findImageRef(node) {
    for (const child of node.children) {
      const tag = localName(child);
      // A drawing usually ships a DrawingML and a legacy VML copy of itself;
      // reading both would place every picture twice.
      if (tag === "AlternateContent") {
        const branch = firstOf(child, "Choice") || firstOf(child, "Fallback");
        const found = branch ? findImageRef(branch) : null;
        if (found) return found;
        continue;
      }
      if (tag === "blip") {
        const id = relAttr(child, "embed");
        if (id) return { id };
        continue;
      }
      if (tag === "imagedata") {
        const id = relAttr(child, "id");
        if (id) return { id };
        continue;
      }
      const found = findImageRef(child);
      if (found) return found;
    }
    return null;
  }

  function findExtent(node) {
    for (const child of node.children) {
      const tag = localName(child);
      if (tag === "extent" || tag === "ext") {
        const width = numAttr(child, "cx");
        const height = numAttr(child, "cy");
        if (width > 0 && height > 0) return { width: width / EMU_PER_PT, height: height / EMU_PER_PT };
        continue;
      }
      const found = findExtent(child);
      if (found) return found;
    }
    return null;
  }

  function pushDocxImage(items, rels, ctx, node) {
    const ref = findImageRef(node);
    if (!ref) return;
    const part = rels.get(ref.id);
    if (!part) {
      ctx.warn("Some pictures in this document could not be found and were left out.");
      return;
    }
    items.push({
      image: {
        part,
        bytes: null,
        kind: null,
        width: 0,
        height: 0,
        extent: findExtent(node),
        embedded: null,
        attempted: false,
        broken: false,
      },
    });
  }

  function collectDocxRuns(node, items, rels, ctx, baseSize, baseBold) {
    for (const child of node.children) {
      const tag = localName(child);
      if (tag === "pPr") continue;
      if (tag === "drawing" || tag === "pict" || tag === "object" || tag === "AlternateContent") {
        pushDocxImage(items, rels, ctx, child);
        continue;
      }
      if (tag === "r") {
        const props = firstOf(child, "rPr");
        const bold = flagOn(firstOf(props, "b")) || baseBold;
        const italic = flagOn(firstOf(props, "i"));
        const halfPoints = props ? numAttr(firstOf(props, "sz"), "val") / 2 : 0;
        const size = halfPoints > 0 ? clamp(halfPoints, 4, 200) : baseSize;
        const font = pickFont(ctx, bold, italic);
        let text = "";
        const flushText = () => {
          if (!text) return;
          items.push({ text: ctx.shaper.sanitize(text), font, size, bold, italic });
          text = "";
        };
        for (const part of child.children) {
          const partTag = localName(part);
          if (partTag === "t") text += part.textContent;
          else if (partTag === "tab") text += "\t";
          else if (partTag === "br" || partTag === "cr") text += "\n";
          else if (partTag === "noBreakHyphen") text += "-";
          else if (partTag === "drawing" || partTag === "pict" || partTag === "object"
            || partTag === "AlternateContent") {
            flushText();
            pushDocxImage(items, rels, ctx, part);
          }
        }
        flushText();
        continue;
      }
      if (tag === "hyperlink" || tag === "smartTag" || tag === "ins" || tag === "sdt"
        || tag === "sdtContent" || tag === "bdo" || tag === "dir" || tag === "del") {
        collectDocxRuns(child, items, rels, ctx, baseSize, baseBold);
      }
    }
  }

  function readDocxParagraph(node, rels, ctx, counter) {
    counter.count++;
    const props = firstOf(node, "pPr");
    const heading = headingInfo(attr(firstOf(props, "pStyle"), "val"));
    const size = heading ? heading.size : BODY_SIZE;
    const items = [];
    collectDocxRuns(node, items, rels, ctx, size, !!heading);
    return {
      type: "para",
      heading: heading ? heading.level : 0,
      items,
      size,
      align: docxAlign(attr(firstOf(props, "jc"), "val")),
      listItem: !!firstOf(props, "numPr"),
      spaceBefore: heading ? heading.spaceBefore : 0,
    };
  }

  function readDocxTable(node, rels, ctx, counter) {
    const rows = [];
    for (const row of childrenOf(node, "tr")) {
      const cells = [];
      for (const cell of childrenOf(row, "tc")) {
        const lines = [];
        for (const paragraph of childrenOf(cell, "p")) {
          const items = [];
          collectDocxRuns(paragraph, items, rels, ctx, BODY_SIZE, false);
          counter.count++;
          let text = "";
          for (const item of items) if (item.text) text += item.text;
          if (text) lines.push(text);
        }
        cells.push(lines.join("\n"));
      }
      if (cells.length) rows.push(cells);
    }
    return rows.length ? { type: "table", rows } : null;
  }

  function appendDocxBlocks(node, rels, ctx, counter, blocks) {
    for (const child of node.children) {
      const tag = localName(child);
      if (tag === "p") blocks.push(readDocxParagraph(child, rels, ctx, counter));
      else if (tag === "tbl") {
        const table = readDocxTable(child, rels, ctx, counter);
        if (table) blocks.push(table);
      } else if (tag === "sdt") {
        const content = firstOf(child, "sdtContent");
        if (content) appendDocxBlocks(content, rels, ctx, counter, blocks);
      }
    }
  }

  function renderDocx(ctx, flow, blocks) {
    const contentWidth = flow.right - flow.left;
    for (const block of blocks) {
      if (block.type === "table") {
        renderDocxTable(ctx, flow, block.rows);
        continue;
      }
      if (block.spaceBefore) flow.gap(block.spaceBefore);
      const indent = block.listItem ? 14 : 0;
      const items = block.listItem
        ? [{ text: "\u2022 ", font: ctx.fonts.regular, size: block.size }].concat(block.items)
        : block.items;
      renderFlowItems(ctx, flow, items, {
        left: flow.left + indent,
        maxWidth: contentWidth - indent,
        lineHeight: block.size * LINE_FACTOR,
        size: block.size,
        align: block.align,
      });
      flow.gap(block.size * 0.4);
    }
  }

  function renderDocxTable(ctx, flow, rows) {
    let widest = 1;
    for (const row of rows) widest = Math.max(widest, row.length);
    const used = Math.min(widest, MAX_GRID_COLUMNS);
    if (widest > used) {
      ctx.warn("Some columns in a table were left out because it is wider than a page.");
    }
    const contentWidth = flow.right - flow.left;
    const cellWidth = contentWidth / used;
    const padding = 3;
    const textWidth = Math.max(12, cellWidth - padding * 2);
    const lineHeight = BODY_SIZE * LINE_FACTOR;

    for (const row of rows) {
      const cells = [];
      let wanted = 0;
      for (let column = 0; column < used; column++) {
        const lines = wrapTokens(
          tokenize([{ text: row[column] || "", font: ctx.fonts.regular, size: BODY_SIZE }], ctx),
          textWidth,
          ctx,
        );
        cells.push(lines);
        wanted = Math.max(wanted, lines.length);
      }
      const rowHeight = wanted * lineHeight + padding * 2;
      if (flow.y + rowHeight > flow.bottom) flow.newPage();
      const height = Math.min(rowHeight, flow.bottom - flow.y);
      if (rowHeight > height) {
        ctx.warn("Some rows in a table were taller than the space left on the page and were cut short.");
      }
      const top = flow.y;
      const bottom = top + height;
      flow.page.drawRectangle({
        x: flow.left,
        y: flow.down(bottom),
        width: contentWidth,
        height,
        borderColor: ctx.color(COLORS.rule),
        borderWidth: 0.5,
      });
      for (let column = 0; column < used; column++) {
        const x = flow.left + column * cellWidth;
        if (column > 0) {
          flow.page.drawLine({
            start: { x, y: flow.down(bottom) },
            end: { x, y: flow.down(top) },
            thickness: 0.4,
            color: ctx.color(COLORS.grid),
          });
        }
        for (let index = 0; index < cells[column].length; index++) {
          const offset = padding + index * lineHeight;
          if (offset + BODY_SIZE * 0.82 > height) break;
          paintLine(ctx, flow.page, cells[column][index], x + padding,
            flow.down(top + offset + BODY_SIZE * 0.82));
        }
      }
      flow.y = bottom;
    }
    flow.gap(6);
  }

  /* ---------- PPTX ---------- */

  function findXfrm(node) {
    for (const child of node.children) {
      const tag = localName(child);
      if (tag === "xfrm") {
        const offset = firstOf(child, "off");
        const extent = firstOf(child, "ext");
        if (offset && extent) {
          return {
            x: numAttr(offset, "x") / EMU_PER_PT,
            y: numAttr(offset, "y") / EMU_PER_PT,
            width: numAttr(extent, "cx") / EMU_PER_PT,
            height: numAttr(extent, "cy") / EMU_PER_PT,
          };
        }
      }
      const found = findXfrm(child);
      if (found) return found;
    }
    return null;
  }

  function readTextBody(body, ctx, fallbackSize) {
    const paragraphs = [];
    for (const paragraph of childrenOf(body, "p")) {
      const props = firstOf(paragraph, "pPr");
      const algn = attr(props, "algn");
      const align = algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "both" : "left";
      const segments = [];
      for (const node of paragraph.children) {
        const tag = localName(node);
        if (tag !== "r" && tag !== "fld" && tag !== "br") continue;
        const runProps = firstOf(node, "rPr");
        const rawSize = runProps ? numAttr(runProps, "sz") : 0;
        const size = rawSize > 0 ? clamp(rawSize / 100, 4, 400) : fallbackSize;
        const bold = attr(runProps, "b") === "1";
        const italic = attr(runProps, "i") === "1";
        let text = "";
        for (const part of node.children) {
          const partTag = localName(part);
          if (partTag === "t") text += part.textContent;
          else if (partTag === "br") text += "\n";
        }
        if (text) {
          // Slide text was reaching drawText unsanitised, so a single Devanagari
          // or emoji character made encodeText throw and lost the whole deck.
          segments.push({
            text: ctx.shaper.sanitize(text),
            font: pickFont(ctx, bold, italic),
            size,
            align,
            bold,
            italic,
          });
        }
      }
      paragraphs.push({ align, segments });
    }
    return paragraphs;
  }

  function readGraphicTable(frame, ctx) {
    const table = findFirst(frame, "tbl");
    if (!table) return null;
    const grid = firstOf(table, "tblGrid");
    const columns = [];
    for (const column of grid ? childrenOf(grid, "gridCol") : []) {
      columns.push(numAttr(column, "w") / EMU_PER_PT);
    }
    const rows = [];
    for (const row of childrenOf(table, "tr")) {
      const cells = [];
      for (const cell of childrenOf(row, "tc")) {
        const body = firstOf(cell, "txBody");
        if (!body) { cells.push(""); continue; }
        cells.push(readTextBody(body, ctx, 12)
          .map((paragraph) => paragraph.segments.map((segment) => segment.text).join(""))
          .join(" "));
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return null;
    if (!columns.length) columns.push(1);
    return { columns, rows };
  }

  function walkSlideTree(node, boxes, state, ctx) {
    for (const child of node.children) {
      const tag = localName(child);
      if (tag === "sp") {
        const body = firstOf(child, "txBody");
        if (!body) continue;
        const paragraphs = readTextBody(body, ctx, state.defaultSize);
        if (!paragraphs.some((paragraph) => paragraph.segments.length)) continue;
        boxes.push({
          kind: "text",
          box: findXfrm(child) || state.nextFlowBox(),
          paragraphs,
        });
        continue;
      }
      if (tag === "pic") {
        const blip = findFirst(child, "blip");
        const id = blip ? relAttr(blip, "embed") : null;
        if (!id) continue;
        boxes.push({
          kind: "imageRef",
          relId: id,
          box: findXfrm(child) || state.nextFlowBox(),
        });
        continue;
      }
      if (tag === "graphicFrame") {
        const table = readGraphicTable(child, ctx);
        if (table) boxes.push({ kind: "table", box: findXfrm(child) || state.nextFlowBox(), table });
        else state.sawUnsupported = true;
        continue;
      }
      if (tag === "grpSp") {
        // Group offsets are not applied, so say so rather than place the
        // children in a plausible-looking but wrong spot.
        state.sawGroup = true;
        walkSlideTree(child, boxes, state, ctx);
        continue;
      }
      if (tag === "AlternateContent") {
        const branch = firstOf(child, "Choice") || firstOf(child, "Fallback");
        if (branch) walkSlideTree(branch, boxes, state, ctx);
      }
    }
  }

  function readSlideTree(zip, part, ctx, slideBox) {
    return xmlPart(zip, part).then((root) => {
      if (!root) return null;
      const boxes = [];
      const state = { defaultSize: 18, sawGroup: false, sawUnsupported: false, cursor: 0 };
      state.nextFlowBox = function nextFlowBox() {
        // A shape with no position still has to go somewhere; stacking it down
        // the slide keeps reading order without pretending to be exact.
        const box = { x: 24, y: 24 + this.cursor, width: slideBox.width - 48, height: 400 };
        this.cursor += 40;
        return box;
      };
      const tree = findFirst(root, "spTree");
      if (tree) walkSlideTree(tree, boxes, state, ctx);
      return { part, boxes, state };
    });
  }

  async function parsePptx(zip, ctx, options) {
    const part = "ppt/presentation.xml";
    const root = await xmlPart(zip, part);
    if (!root) {
      throw userError(ctx.name,
        "could not be opened because it does not contain a readable PowerPoint presentation inside it. It may be damaged, or it may be a presentation saved in a format this converter does not read.");
    }
    const size = firstOf(root, "sldSz");
    const width = clamp(numAttr(size, "cx") / EMU_PER_PT || 960, 72, 4000);
    const height = clamp(numAttr(size, "cy") / EMU_PER_PT || 540, 72, 4000);
    const rels = await parseRels(zip, part);

    // Slide order comes from the presentation, never from the file names.
    const order = [];
    const list = firstOf(root, "sldIdLst");
    for (const slideId of list ? childrenOf(list, "sldId") : []) {
      const id = relAttr(slideId, "id");
      const target = id ? rels.get(id) : null;
      if (target) order.push(target);
    }
    // extract() reports an empty deck as an empty list rather than refusing:
    // a conversion that produces an empty file beats a failed conversion.
    if (!order.length) {
      if (options && options.allowEmpty) return { width, height, slides: [] };
      throw userError(ctx.name, "does not contain any slides.");
    }

    const slideBox = { width, height };
    const slides = [];
    for (const slidePart of order) {
      const slide = await readSlideTree(zip, slidePart, ctx, slideBox);
      if (slide) slides.push(slide);
    }
    if (!slides.length && !(options && options.allowEmpty)) {
      throw userError(ctx.name, "does not contain any slides that could be read.");
    }
    if (slides.some((slide) => slide.state.sawGroup)) {
      ctx.warn("Some slides use grouped objects, which are placed in reading order rather than at their exact grouped position.");
    }
    if (slides.some((slide) => slide.state.sawUnsupported)) {
      ctx.warn("Some objects on a slide were charts or drawings and could not be included.");
    }
    return { width, height, slides };
  }

  function layoutBoxText(ctx, box, maxWidth, scale) {
    const lines = [];
    let total = 0;
    for (const paragraph of box.paragraphs) {
      const segments = paragraph.segments.map((segment) => ({
        ...segment,
        size: Math.max(4, segment.size * scale),
      }));
      if (!segments.length) {
        const height = 12 * scale * LINE_FACTOR;
        lines.push({ line: { pieces: [], width: 0 }, size: 12 * scale, height, align: paragraph.align });
        total += height;
        continue;
      }
      for (const line of wrapTokens(tokenize(segments, ctx), maxWidth, ctx)) {
        const size = lineSize(line, segments[0].size);
        const height = size * LINE_FACTOR;
        lines.push({ line, size, height, align: paragraph.align });
        total += height;
      }
    }
    return { lines, height: total };
  }

  function clampBox(box, width, height) {
    const x = clamp(box.x, 0, width - 8);
    const y = clamp(box.y, 0, height - 8);
    const boxWidth = Math.min(Math.max(8, box.width), width - x);
    const boxHeight = Math.min(Math.max(8, box.height), height - y);
    if (boxWidth < 4 || boxHeight < 4) return null;
    return { x, y, width: boxWidth, height: boxHeight };
  }

  function renderSlide(ctx, page, slide, width, height) {
    // A thin edge makes a 16:9 page read as a slide when pages are flipped
    // through quickly in a PDF reader.
    page.drawRectangle({
      x: 0.5,
      y: 0.5,
      width: Math.max(1, width - 1),
      height: Math.max(1, height - 1),
      borderColor: ctx.color(COLORS.slideEdge),
      borderWidth: 0.7,
    });
    for (const box of slide.boxes) {
      if (box.kind === "skip") continue;
      const frame = clampBox(box.box, width, height);
      if (!frame) continue;
      // Slide coordinates count down from the top-left; PDF counts up from
      // the bottom-left, so every y crosses the origin exactly once, here.
      const down = (distance) => height - distance;
      if (box.kind === "text") renderSlideText(ctx, page, box, frame, down);
      else if (box.kind === "image") renderSlideImage(ctx, page, box, frame, down);
      else if (box.kind === "table") renderSlideTable(ctx, page, box, frame, down);
    }
  }

  function renderSlideText(ctx, page, box, frame, down) {
    let scale = 1;
    let layout = layoutBoxText(ctx, box, frame.width, scale);
    if (layout.height > frame.height && layout.height > 0) {
      // Shrink before clipping: a box that overflows by a little should still
      // read, and only a hopeless box gets truncated.
      scale = clamp(frame.height / layout.height, 0.55, 1);
      layout = layoutBoxText(ctx, box, frame.width, scale);
    }
    let y = frame.y;
    let truncated = false;
    for (const entry of layout.lines) {
      if (y + entry.height > frame.y + frame.height + 0.5) { truncated = true; break; }
      let x = frame.x;
      if (entry.align === "center") x += Math.max(0, (frame.width - entry.line.width) / 2);
      else if (entry.align === "right") x += Math.max(0, frame.width - entry.line.width);
      let extra = 0;
      if (entry.align === "both") {
        const slack = frame.width - entry.line.width;
        if (slack > 0 && slack < frame.width * 0.6) extra = slack;
      }
      paintLine(ctx, page, entry.line, x, down(y + entry.size * 0.82), extra);
      y += entry.height;
    }
    if (truncated) {
      ctx.warn("Text that did not fit inside its shape was cut off. Shorten it, or change the font size, for a complete slide.");
    }
  }

  function renderSlideImage(ctx, page, box, frame, down) {
    if (!box.image || !box.image.embedded) return;
    const fitted = fitImage(box.image, frame.width, frame.height, true);
    page.drawImage(box.image.embedded, {
      x: frame.x + (frame.width - fitted.width) / 2,
      y: down(frame.y + frame.height - (frame.height - fitted.height) / 2),
      width: fitted.width,
      height: fitted.height,
    });
    ctx.stats.images++;
  }

  function renderSlideTable(ctx, page, box, frame, down) {
    const count = box.table.columns.length;
    const widths = normalizeColumns(box.table.columns, frame.width, count);
    const size = 12;
    const lineHeight = size * LINE_FACTOR;
    let y = frame.y;
    for (const row of box.table.rows) {
      const cells = [];
      let lines = 1;
      for (let column = 0; column < count; column++) {
        const wrapped = wrapTokens(
          tokenize([{ text: row[column] || "", font: ctx.fonts.regular, size }], ctx),
          Math.max(10, widths[column] - 6),
          ctx,
        );
        cells.push(wrapped);
        lines = Math.max(lines, wrapped.length);
      }
      const rowHeight = lines * lineHeight + 4;
      if (y + rowHeight > frame.y + frame.height) break;
      page.drawRectangle({
        x: frame.x,
        y: down(y + rowHeight),
        width: frame.width,
        height: rowHeight,
        borderColor: ctx.color(COLORS.rule),
        borderWidth: 0.4,
      });
      let x = frame.x;
      for (let column = 0; column < count; column++) {
        for (let index = 0; index < cells[column].length; index++) {
          const top = y + 2 + index * lineHeight;
          paintLine(ctx, page, cells[column][index], x + 3, down(top + size * 0.82));
        }
        x += widths[column];
      }
      y += rowHeight;
    }
  }

  function normalizeColumns(columns, total, count) {
    const widths = [];
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const width = columns[i] > 0 ? columns[i] : total / count;
      widths.push(width);
      sum += width;
    }
    if (sum <= 0) return widths.map(() => total / count);
    const scale = Math.min(1, total / sum);
    return widths.map((width) => width * scale);
  }

  /* ---------- XLSX ---------- */

  function parseCellRef(reference) {
    const match = /^([A-Z]+)(\d+)$/i.exec(String(reference || "").trim());
    if (!match) return null;
    let column = 0;
    for (const letter of match[1].toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
    return { column: column - 1, row: Number(match[2]) - 1 };
  }

  function formatNumber(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return String(raw);
    if (Number.isInteger(value)) return String(value);
    // Spreadsheets carry far more precision than anyone reads off a page.
    return String(Number(value.toPrecision(12)));
  }

  function readCellValue(cell, shared) {
    const type = attr(cell, "t") || "n";
    if (type === "s") {
      const node = firstOf(cell, "v");
      const index = Number(node ? node.textContent : -1);
      return Number.isInteger(index) && shared[index] !== undefined ? shared[index] : "";
    }
    if (type === "inlineStr") {
      const node = firstOf(cell, "is");
      return node ? concatDescendantText(node) : "";
    }
    if (type === "str") {
      const node = firstOf(cell, "v");
      return node ? node.textContent : "";
    }
    if (type === "b") {
      const node = firstOf(cell, "v");
      return node && node.textContent === "1" ? "TRUE" : "FALSE";
    }
    const node = firstOf(cell, "v");
    return node ? formatNumber(node.textContent) : "";
  }

  async function readSharedStrings(zip) {
    const root = await xmlPart(zip, "xl/sharedStrings.xml");
    if (!root) return [];
    return childrenOf(root, "si").map((entry) => concatDescendantText(entry));
  }

  async function readXlsxSheet(zip, part, shared, ctx) {
    const root = await xmlPart(zip, part);
    if (!root) return null;
    const columns = new Map();
    const declared = firstOf(root, "cols");
    for (const column of declared ? childrenOf(declared, "col") : []) {
      const min = numAttr(column, "min");
      const max = numAttr(column, "max");
      const width = numAttr(column, "width");
      if (!width || min < 1) continue;
      const last = Math.min(max, min + MAX_GRID_COLUMNS);
      for (let index = min; index <= last; index++) {
        columns.set(index - 1, clamp(width * CHAR_WIDTH_PT + 5, 20, 400));
      }
    }

    const cells = new Map();
    const data = firstOf(root, "sheetData");
    let lost = 0;
    let rowCursor = -1;
    for (const rowElement of data ? childrenOf(data, "row") : []) {
      const declaredRow = numAttr(rowElement, "r");
      rowCursor = declaredRow > 0 ? declaredRow - 1 : rowCursor + 1;
      let columnCursor = -1;
      for (const cell of childrenOf(rowElement, "c")) {
        const position = parseCellRef(attr(cell, "r"));
        const column = position ? position.column : columnCursor + 1;
        const row = position ? position.row : rowCursor;
        columnCursor = column;
        const text = readCellValue(cell, shared);
        if (!text) {
          // A cell holding a reference into the workbook's list of shared words,
          // with no word there to be found, is a cell whose text is being lost.
          // It is counted rather than dropped in silence: a workbook whose word
          // list is missing is otherwise nothing but numbers.
          if ((attr(cell, "t") || "") === "s" && firstOf(cell, "v")) lost++;
          continue;
        }
        let rowCells = cells.get(row);
        if (!rowCells) {
          rowCells = new Map();
          cells.set(row, rowCells);
        }
        rowCells.set(column, ctx.shaper.sanitize(text));
      }
    }
    return { part, cells, columns, lost, bounds: cells.size ? measureGrid(cells) : null };
  }

  function measureGrid(cells) {
    let minRow = Infinity;
    let maxRow = -Infinity;
    let minColumn = Infinity;
    let maxColumn = -Infinity;
    for (const [row, rowCells] of cells) {
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      for (const column of rowCells.keys()) {
        if (column < minColumn) minColumn = column;
        if (column > maxColumn) maxColumn = column;
      }
    }
    return { minRow, maxRow, minColumn, maxColumn };
  }

  function trimGrid(sheet, ctx) {
    const cells = sheet.cells;
    const original = sheet.bounds;
    // A sheet with nothing in it has no bounds to trim. toPdf never gets one
    // this far, but extract() keeps empty sheets so nothing is lost on the way
    // to another format.
    if (!original) return false;
    let { minRow, maxRow, minColumn, maxColumn } = original;
    const rowIsEmpty = (row) => !cells.has(row) || cells.get(row).size === 0;
    const columnIsEmpty = (column) => {
      for (const rowCells of cells.values()) if (rowCells.has(column)) return false;
      return true;
    };
    while (minRow < maxRow && rowIsEmpty(minRow)) minRow++;
    while (maxRow > minRow && rowIsEmpty(maxRow)) maxRow--;
    while (minColumn < maxColumn && columnIsEmpty(minColumn)) minColumn++;
    while (maxColumn > minColumn && columnIsEmpty(maxColumn)) maxColumn--;
    if (maxColumn - minColumn + 1 > MAX_GRID_COLUMNS) maxColumn = minColumn + MAX_GRID_COLUMNS - 1;
    if (maxRow - minRow + 1 > MAX_GRID_ROWS) maxRow = minRow + MAX_GRID_ROWS - 1;
    if (minRow === original.minRow && maxRow === original.maxRow
      && minColumn === original.minColumn && maxColumn === original.maxColumn) return false;
    if (maxColumn < original.maxColumn || maxRow < original.maxRow) {
      ctx.warn("Part of a sheet was too large to lay out and was left out.");
    }
    sheet.bounds = { minRow, maxRow, minColumn, maxColumn };
    return true;
  }

  async function parseXlsx(zip, ctx, options) {
    const part = "xl/workbook.xml";
    const root = await xmlPart(zip, part);
    if (!root) {
      throw userError(ctx.name,
        "could not be opened because it does not contain a readable Excel workbook inside it. It may be damaged, or it may be a workbook saved in a format this converter does not read.");
    }
    const rels = await parseRels(zip, part);
    const shared = await readSharedStrings(zip);
    const declared = firstOf(root, "sheets");
    const sheets = [];
    for (const sheetElement of declared ? childrenOf(declared, "sheet") : []) {
      const id = relAttr(sheetElement, "id");
      const target = id ? rels.get(id) : null;
      if (!target) continue;
      const sheet = await readXlsxSheet(zip, target, shared, ctx);
      if (!sheet) continue;
      sheet.name = attr(sheetElement, "name") || "Sheet";
      sheets.push(sheet);
    }
    if (!sheets.length && !(options && options.allowEmpty)) {
      throw userError(ctx.name, "does not contain any sheets.");
    }
    let lost = 0;
    for (const sheet of sheets) lost += sheet.lost || 0;
    if (lost) {
      ctx.warn(`${lost} ${lost === 1 ? "cell holds" : "cells hold"} text this workbook refers to by number, and the list of words those numbers point at is missing or unreadable, so ${lost === 1 ? "it was" : "they were"} left out. The numbers in the workbook are all here. Save the workbook again from Excel and convert it once more to get the text back.`);
    }
    const filled = sheets.filter((sheet) => sheet.bounds);
    if (!filled.length && !(options && options.allowEmpty)) {
      throw userError(ctx.name, "does not contain any cells with content, so there is nothing to convert.");
    }
    // extract() keeps the empty sheets too, so a workbook with one filled sheet
    // and one blank one does not lose the blank one on its way out.
    return { sheets: options && options.allowEmpty ? sheets : filled };
  }

  // Sharing a page out between the columns of a wide sheet is the one place
  // this engine can lose somebody's data, because there is only so much paper.
  // Scaling every column by the same factor is what does it: one long note
  // makes the factor small enough to cut a word in half in every other column
  // as well. So each column is measured against what it actually holds, the
  // spare room around it is handed back first, the text is made smaller if that
  // is what it takes, and whatever still does not fit is named in `warnings`
  // rather than quietly clipped.
  function sheetGeometry(ctx, flow, sheet) {
    const bounds = sheet.bounds;
    const columnCount = bounds
      ? Math.min(bounds.maxColumn, bounds.minColumn + MAX_GRID_COLUMNS - 1) - bounds.minColumn + 1
      : 0;
    const contentWidth = Math.max(1, flow.right - flow.left);
    // A sheet with no bounds at all still gets one column of geometry, so
    // nothing below has to special-case it.
    const count = Math.max(1, columnCount);
    const ideal = [];
    const needed = [];
    for (let index = 0; index < count; index++) {
      const column = (bounds ? bounds.minColumn : 0) + index;
      const declared = sheet.columns.has(column) ? sheet.columns.get(column) : 0;
      // A column grows to fit its widest value before anything is cut short:
      // silently shortening a number is worse than a wide column.
      const wanted = widestValue(ctx, sheet, column);
      const room = clamp(wanted + SHEET_CELL_PAD + SHEET_CELL_SLACK, MIN_COLUMN_PT, MAX_COLUMN_PT);
      needed.push(room);
      // The width the file asks for is a preference. It is honoured only for
      // as long as it costs no column its own text.
      ideal.push(clamp(Math.max(declared, DEFAULT_COLUMN_PT, wanted + SHEET_ROOMY_COLUMN_PT), room, MAX_COLUMN_PT));
    }

    // The standard PDF fonts measure width in proportion to the size, so the
    // measurements taken at SHEET_FONT_SIZE are the same numbers at any size
    // this is about to choose, and a wide sheet is never re-measured.
    const neededSum = totalOf(needed);
    const fontScale = neededSum > contentWidth
      ? clamp(contentWidth / neededSum, MIN_SHEET_FONT / SHEET_FONT_SIZE, 1)
      : 1;

    const widths = shrinkToFit(
      ideal.map((width) => width * fontScale),
      needed.map((width) => width * fontScale),
      contentWidth
    );
    // A sheet too wide even for the smallest text still has to fit the paper,
    // so what is over the right margin is shared out evenly rather than left
    // hanging off the side of the page. Every column was already down to the
    // width its own text needs, so this is the one place data can be lost.
    const squeezed = totalOf(widths) > contentWidth;
    if (squeezed) {
      const scale = contentWidth / totalOf(widths);
      for (let index = 0; index < widths.length; index++) widths[index] *= scale;
    } else if (widths.length) {
      // Stretch the last column to the right margin so the page looks like a
      // page rather than a table floating in the middle of one.
      widths[widths.length - 1] += contentWidth - totalOf(widths);
    }
    const positions = [];
    let x = flow.left;
    for (const width of widths) {
      positions.push(x);
      x += width;
    }
    return {
      columnCount,
      widths,
      positions,
      contentWidth,
      fontSize: SHEET_FONT_SIZE * fontScale,
      rowHeight: Math.max(MIN_SHEET_ROW_PT, SHEET_ROW_HEIGHT * fontScale),
      // The padding inside a column is measured in the same units as the text,
      // so it has to shrink with it or the gap alone eats a small column.
      pad: SHEET_CELL_PAD * fontScale,
      squeezed: squeezed || fontScale < 1,
    };
  }

  function totalOf(list) {
    let sum = 0;
    for (const value of list) sum += value;
    return sum;
  }

  // Hands the overflow back from whichever columns can best spare it: every
  // column gives up the same amount in each pass and drops out of the round as
  // soon as it reaches the width its own text needs, so a narrow column is
  // never made narrow a second time to pay for a wide one.
  function shrinkToFit(ideal, needed, available) {
    const widths = ideal.slice();
    let excess = totalOf(widths) - available;
    let active = [];
    for (let index = 0; index < widths.length; index++) {
      if (widths[index] > needed[index] + 0.01) active.push(index);
    }
    let rounds = widths.length + 2;
    while (excess > 0.01 && active.length && rounds > 0) {
      rounds--;
      const share = excess / active.length;
      const stillGiving = [];
      for (const index of active) {
        const give = Math.min(share, widths[index] - needed[index]);
        widths[index] -= give;
        excess -= give;
        if (widths[index] > needed[index] + 0.01) stillGiving.push(index);
      }
      active = stillGiving;
    }
    return widths;
  }

  function widestValue(ctx, sheet, column) {
    let widest = 0;
    for (const rowCells of sheet.cells.values()) {
      const text = rowCells.get(column);
      if (!text) continue;
      const width = ctx.shaper.width(text, ctx.fonts.regular, SHEET_FONT_SIZE);
      if (width > widest) widest = width;
    }
    return widest;
  }

  function renderSheet(ctx, flow, sheet, tally) {
    const geometry = sheetGeometry(ctx, flow, sheet);
    const rowLimit = Math.min(sheet.bounds.maxRow, sheet.bounds.minRow + MAX_GRID_ROWS - 1);
    const rowHeight = geometry.rowHeight;
    let row = sheet.bounds.minRow + 1;
    let firstPage = true;

    if (tally && geometry.squeezed) tally.squeezed++;

    // do/while, not while: a sheet holding nothing but a header row still owes
    // the reader a page.
    do {
      flow.newPage();
      const gridTop = firstPage ? TOP_MARGIN + 18 : TOP_MARGIN;
      if (firstPage) {
        flow.page.drawText(ctx.shaper.sanitize(sheet.name) || "Sheet", {
          x: flow.left,
          y: flow.down(TOP_MARGIN - 5),
          size: 9,
          font: ctx.fonts.bold,
          color: ctx.color(COLORS.muted),
        });
      }
      drawSheetHeader(ctx, flow, geometry, sheet, gridTop, tally);
      flow.y = gridTop + rowHeight;
      let drew = false;
      while (row <= rowLimit && flow.y + rowHeight <= flow.bottom) {
        drawSheetRow(ctx, flow, geometry, sheet, row, tally);
        flow.y += rowHeight;
        drew = true;
        row++;
      }
      firstPage = false;
      if (row > rowLimit || !drew) break;
    } while (true);
  }

  // `flow.y` counts downwards from the top of the page; PDF counts upwards from
  // the bottom, so every drawing call goes through down().
  function drawSheetHeader(ctx, flow, geometry, sheet, gridTop, tally) {
    const bandBottom = gridTop + geometry.rowHeight;
    flow.page.drawRectangle({
      x: flow.left,
      y: flow.down(bandBottom),
      width: geometry.contentWidth,
      height: geometry.rowHeight,
      color: ctx.color(COLORS.headerFill),
    });
    flow.page.drawLine({
      start: { x: flow.left, y: flow.down(bandBottom) },
      end: { x: flow.right, y: flow.down(bandBottom) },
      thickness: 0.8,
      color: ctx.color(COLORS.rule),
    });
    // Vertical rules after the fill, so the header band does not hide them.
    for (let index = 0; index <= geometry.columnCount; index++) {
      const x = index === geometry.columnCount ? flow.right : geometry.positions[index];
      flow.page.drawLine({
        start: { x, y: flow.down(flow.bottom) },
        end: { x, y: flow.down(gridTop) },
        thickness: 0.4,
        color: ctx.color(COLORS.grid),
      });
    }
    const cells = sheet.cells.get(sheet.bounds.minRow);
    if (!cells) return;
    for (const [column, text] of cells) {
      const index = column - sheet.bounds.minColumn;
      if (index < 0 || index >= geometry.columnCount) continue;
      const shown = fitCellText(ctx, text, geometry.widths[index] - geometry.pad, geometry.fontSize, tally);
      flow.page.drawText(shown, {
        x: geometry.positions[index] + 3,
        y: flow.down(bandBottom - geometry.rowHeight * 0.27),
        size: geometry.fontSize,
        font: ctx.fonts.bold,
        color: ctx.color(COLORS.text),
      });
      ctx.stats.characters += shown.length;
    }
  }

  function drawSheetRow(ctx, flow, geometry, sheet, row, tally) {
    const bottom = flow.y + geometry.rowHeight;
    flow.page.drawLine({
      start: { x: flow.left, y: flow.down(bottom) },
      end: { x: flow.right, y: flow.down(bottom) },
      thickness: 0.4,
      color: ctx.color(COLORS.grid),
    });
    const cells = sheet.cells.get(row);
    if (!cells) return;
    for (const [column, text] of cells) {
      const index = column - sheet.bounds.minColumn;
      if (index < 0 || index >= geometry.columnCount) continue;
      // A value is only truncated when something sits next to it; a lone long
      // string may run on into the empty cells to its right.
      const room = cells.has(column + 1)
        ? geometry.widths[index]
        : geometry.positions[index] + geometry.widths[index] - flow.left;
      const shown = fitCellText(ctx, text, room, geometry.fontSize, tally);
      flow.page.drawText(shown, {
        x: geometry.positions[index] + 3,
        y: flow.down(bottom - geometry.rowHeight * 0.27),
        size: geometry.fontSize,
        font: ctx.fonts.regular,
        color: ctx.color(COLORS.text),
      });
      ctx.stats.characters += shown.length;
    }
  }

  // Every cut made here is counted, because a cell that is quietly shortened
  // to fit its column is exactly the kind of loss the caller has to be told
  // about rather than left to find for themselves.
  function fitCellText(ctx, text, room, size, tally) {
    const plain = String(text);
    // Defaulted rather than required: a call site that left the size out would
    // measure against NaN and shorten every cell to one character.
    const at = size || SHEET_FONT_SIZE;
    if (ctx.shaper.width(plain, ctx.fonts.regular, at) <= room) return plain;
    let out = plain;
    while (out.length > 1 && ctx.shaper.width(`${out}\u2026`, ctx.fonts.regular, at) > room) {
      out = out.slice(0, -1);
    }
    if (tally) tally.cut++;
    return `${out}\u2026`;
  }

  /* ---------- zip reading and image resolution ---------- */

  async function xmlPart(zip, path) {
    const entry = zip.file(path);
    if (!entry) return null;
    try {
      return parseXml(await entry.async("string"));
    } catch (err) {
      return null;
    }
  }

  async function parseRels(zip, part) {
    const map = new Map();
    const slash = part.lastIndexOf("/");
    const relPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
    const root = await xmlPart(zip, relPath);
    if (!root) return map;
    for (const relationship of childrenOf(root, "Relationship")) {
      const id = attr(relationship, "Id");
      const target = attr(relationship, "Target");
      if (!id || !target) continue;
      if ((attr(relationship, "TargetMode") || "").toLowerCase() === "external") continue;
      map.set(id, resolvePart(part, target));
    }
    return map;
  }

  // Reading every image up front means the layout pass never has to await, and
  // an unreadable picture is dropped once rather than halfway down a page.
  async function resolveImages(zip, ctx, items, options) {
    let unsupported = 0;
    let missing = 0;
    for (const item of items) {
      const image = item.image;
      if (!image || image.broken) continue;
      const entry = zip.file(image.part);
      let bytes = null;
      if (entry) {
        try {
          bytes = await entry.async("uint8array");
        } catch (err) {
          bytes = null;
        }
      }
      const kind = bytes ? sniffImage(bytes) : null;
      if (!kind) {
        image.broken = true;
        if (entry && bytes) unsupported++;
        else missing++;
        continue;
      }
      const pixels = imagePixelSize(bytes, kind);
      const extent = image.extent;
      image.bytes = bytes;
      image.kind = kind;
      // The size the renderer works in is points, taken from the layout extent;
      // the pixel size is what a writer needs to place the same picture in
      // another file, so both are kept rather than one standing in for both.
      image.pixels = pixels;
      image.width = extent && extent.width > 0 ? extent.width : pixels.width;
      image.height = extent && extent.height > 0 ? extent.height : pixels.height;
      if (!Number.isFinite(image.width) || image.width <= 0) image.width = pixels.width;
      if (!Number.isFinite(image.height) || image.height <= 0) image.height = pixels.height;
    }
    if (unsupported) ctx.warn(IMAGE_WARNING);
    if (missing) ctx.warn("Some pictures in this document were missing from the file and were left out.");
    // `embed: false` is extract(): it hands the raw bytes straight on to a
    // writer, and has no PDF document to embed them into.
    if (options && options.embed === false) return;
    await embedImages(ctx, items.filter((item) => item.image && !item.image.broken));
  }

  /* ---------- per-kind assembly ---------- */

  // Pull the bytes behind every picture a Word document refers to and drop the
  // ones that turn out to be unusable. Shared with extract() so both agree,
  // exactly, on which pictures survive.
  async function resolveDocxImages(zip, ctx, blocks, options) {
    const references = [];
    for (const block of blocks) {
      if (block.type === "table") continue;
      for (const item of block.items) if (item.image) references.push(item);
    }
    await resolveImages(zip, ctx, references, options);
    for (const block of blocks) {
      if (block.type === "table") continue;
      block.items = block.items.filter((item) => !item.image || !item.image.broken);
    }
  }

  // The same for slides: turn a relationship reference into bytes.
  async function resolveSlideImages(zip, parsed, ctx, options) {
    const references = [];
    for (const slide of parsed.slides) {
      const rels = await parseRels(zip, slide.part);
      for (const box of slide.boxes) {
        if (box.kind !== "imageRef") continue;
        const part = rels.get(box.relId);
        if (!part) { box.kind = "skip"; continue; }
        box.kind = "image";
        box.image = {
          part,
          bytes: null,
          kind: null,
          width: 0,
          height: 0,
          extent: null,
          embedded: null,
          attempted: false,
          broken: false,
        };
        references.push({ image: box.image });
      }
    }
    await resolveImages(zip, ctx, references, options);
    for (const slide of parsed.slides) {
      for (const box of slide.boxes) {
        if (box.kind === "image" && box.image.broken) box.kind = "skip";
      }
    }
  }

  // Parse word/document.xml into the renderer's own block list. This is the
  // single Word parser; the PDF path and extract() both come through here, so
  // there is no way for the two to drift apart on what a document says.
  async function parseDocx(zip, ctx, options) {
    const part = "word/document.xml";
    const root = await xmlPart(zip, part);
    const body = root ? firstOf(root, "body") : null;
    if (!body) {
      throw userError(ctx.name,
        "could not be opened because it does not contain a readable Word document inside it. It may be damaged, or it may be a document saved in a format this converter does not read.");
    }
    const rels = await parseRels(zip, part);
    const counter = { count: 0 };
    const blocks = [];
    appendDocxBlocks(body, rels, ctx, counter, blocks);
    await resolveDocxImages(zip, ctx, blocks, options);
    return { blocks, counter };
  }

  async function buildDocx(ctx, zip) {
    const parsed = await parseDocx(zip, ctx);
    const blocks = parsed.blocks;
    const counter = parsed.counter;

    const hasContent = blocks.some((block) => {
      if (block.type === "table") return block.rows.length > 0;
      return block.items.some((item) => item.text || item.image);
    });
    if (!hasContent) {
      throw userError(ctx.name, "does not contain any text or pictures to convert.");
    }
    ctx.stats.paragraphs = counter.count;

    const flow = createFlow(ctx, A4_WIDTH, A4_HEIGHT);
    renderDocx(ctx, flow, blocks);
  }

  async function buildPptx(ctx, zip) {
    const parsed = await parsePptx(zip, ctx);
    await resolveSlideImages(zip, parsed, ctx);
    for (const slide of parsed.slides) {
      renderSlide(ctx, ctx.addPage(parsed.width, parsed.height), slide, parsed.width, parsed.height);
    }
    ctx.stats.slides = parsed.slides.length;
  }

  async function buildXlsx(ctx, zip) {
    const parsed = await parseXlsx(zip, ctx);
    let trimmed = false;
    for (const sheet of parsed.sheets) trimmed = trimGrid(sheet, ctx) || trimmed;
    if (trimmed) ctx.warn("Rows and columns that are empty at the edges of a sheet were left out.");
    // What a sheet had to give up is counted while it is drawn, so the warnings
    // below can say what happened instead of hinting that something might have.
    const tally = { cut: 0, squeezed: 0 };
    // One flow for the whole workbook: each sheet begins by asking for a fresh
    // page, so no blank page is ever produced between them.
    const flow = createFlow(ctx, A4_WIDTH, A4_HEIGHT, false);
    for (const sheet of parsed.sheets) renderSheet(ctx, flow, sheet, tally);
    ctx.stats.sheets = parsed.sheets.length;
    if (tally.squeezed) {
      ctx.warn(tally.squeezed === 1
        ? "One sheet in this workbook has more columns than fit across the page, so its text was made smaller and its columns were made narrower to get as much of it as possible onto one page."
        : `${tally.squeezed} sheets in this workbook have more columns than fit across the page, so their text was made smaller and their columns were made narrower to get as much of them as possible onto one page.`);
    }
    if (tally.cut) {
      ctx.warn(`${tally.cut} ${tally.cut === 1 ? "cell was" : "cells were"} too long for the column ${tally.cut === 1 ? "it is" : "they are"} in, so ${tally.cut === 1 ? "it was" : "each was"} cut short with an “…” on the page. The value itself has not been changed: widen that column in Excel, or split the sheet across two sheets, to read all of it.`);
    }
  }

  /* ---------- structured extraction ----------
   * The blocks below are the agreed hand-off between this engine and the
   * writers that turn them into .docx, .xlsx and .pptx. They are produced from
   * the same parseDocx/parsePptx/parseXlsx the PDF path uses, through the same
   * relationship resolution, the same zip-bomb guard and the same sanitiser -
   * there is deliberately no second parser to drift out of step. */

  const IMAGE_MIMES = { png: "image/png", jpg: "image/jpeg" };

  function appendRun(runs, item) {
    const text = item.text || "";
    if (!text) return;
    const bold = !!item.bold;
    const italic = !!item.italic;
    const last = runs[runs.length - 1];
    // "hel" and "lo" in two runs is one piece of text, so runs that share
    // formatting are merged rather than passed on as fragments.
    if (last && last.bold === bold && last.italic === italic) last.text += text;
    else runs.push({ text, bold, italic });
  }

  function joinRuns(runs) {
    let out = "";
    for (const run of runs) out += run.text;
    return out;
  }

  // Runs are only worth carrying when they say something. A plain paragraph is
  // one string, which keeps a hundred-page document cheap to hand over.
  function styledRuns(runs) {
    const plain = runs.length < 2 && !(runs[0] && (runs[0].bold || runs[0].italic));
    if (plain) return null;
    return runs.map((run) => ({ text: run.text, bold: run.bold, italic: run.italic }));
  }

  function publicRows(rows) {
    return rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
  }

  function imageBlock(image) {
    const pixels = image.pixels;
    const width = Math.round(pixels && pixels.width > 0 ? pixels.width : image.width);
    const height = Math.round(pixels && pixels.height > 0 ? pixels.height : image.height);
    return {
      type: "image",
      bytes: image.bytes,
      mime: IMAGE_MIMES[image.kind] || "application/octet-stream",
      width: width > 0 ? width : 1,
      height: height > 0 ? height : 1,
    };
  }

  function docxBlocksToPublic(blocks) {
    const out = [];
    let listItems = null;

    const flushList = () => {
      if (listItems && listItems.length) out.push({ type: "list", items: listItems });
      listItems = null;
    };

    // One Word paragraph becomes a block, except where it holds a picture in
    // the middle: the picture is emitted where it sits rather than after all
    // the text around it.
    const pushText = (block, runs) => {
      const text = joinRuns(runs);
      if (!text) return;
      if (block.listItem) {
        if (!listItems) listItems = [];
        listItems.push(text);
        return;
      }
      flushList();
      if (block.heading) {
        out.push({ type: "heading", level: clamp(block.heading, 1, 6), text });
        return;
      }
      const paragraph = { type: "paragraph", text };
      const styled = styledRuns(runs);
      if (styled) paragraph.runs = styled;
      out.push(paragraph);
    };

    for (const block of blocks) {
      if (block.type === "table") {
        flushList();
        out.push({ type: "table", rows: publicRows(block.rows) });
        continue;
      }
      let runs = [];
      for (const item of block.items) {
        if (item.image) {
          pushText(block, runs);
          runs = [];
          if (!item.image.broken) out.push(imageBlock(item.image));
          continue;
        }
        appendRun(runs, item);
      }
      pushText(block, runs);
    }
    flushList();
    return out;
  }

  function pptxBlocksToPublic(parsed) {
    const slides = [];
    for (const slide of parsed.slides) {
      const blocks = [];
      for (const box of slide.boxes) {
        if (box.kind === "image") {
          if (box.image && !box.image.broken) blocks.push(imageBlock(box.image));
          continue;
        }
        if (box.kind === "table") {
          blocks.push({ type: "table", rows: publicRows(box.table.rows) });
          continue;
        }
        if (box.kind !== "text") continue;
        for (const paragraph of box.paragraphs) {
          const runs = [];
          for (const segment of paragraph.segments) appendRun(runs, segment);
          const text = joinRuns(runs);
          if (!text) continue;
          const block = { type: "paragraph", text };
          const styled = styledRuns(runs);
          if (styled) block.runs = styled;
          blocks.push(block);
        }
      }
      slides.push({ type: "slide", blocks });
    }
    return slides;
  }

  // The rectangular grid between the sheet's bounds. Rows are already capped by
  // trimGrid, so this cannot be asked for more than the renderer would lay out.
  function gridToRows(sheet) {
    const bounds = sheet.bounds;
    if (!bounds) return [];
    const rows = [];
    for (let row = bounds.minRow; row <= bounds.maxRow; row++) {
      const cells = sheet.cells.get(row);
      const line = [];
      for (let column = bounds.minColumn; column <= bounds.maxColumn; column++) {
        const value = cells ? cells.get(column) : undefined;
        line.push(value === null || value === undefined ? "" : String(value));
      }
      rows.push(line);
    }
    return rows;
  }

  async function extractDocx(zip, ctx) {
    const parsed = await parseDocx(zip, ctx, { embed: false });
    return docxBlocksToPublic(parsed.blocks);
  }

  async function extractPptx(zip, ctx) {
    const parsed = await parsePptx(zip, ctx, { allowEmpty: true });
    await resolveSlideImages(zip, parsed, ctx, { embed: false });
    return pptxBlocksToPublic(parsed);
  }

  async function extractXlsx(zip, ctx) {
    // An empty sheet is a fact about the workbook, not a reason to fail, so
    // every sheet survives here - including ones the PDF path would skip.
    const parsed = await parseXlsx(zip, ctx, { allowEmpty: true });
    let trimmed = false;
    for (const sheet of parsed.sheets) trimmed = trimGrid(sheet, ctx) || trimmed;
    if (trimmed) ctx.warn("Rows and columns that are empty at the edges of a sheet were left out.");
    const blocks = [];
    for (const sheet of parsed.sheets) {
      blocks.push({ type: "sheet", name: String(sheet.name || "Sheet"), rows: gridToRows(sheet) });
    }
    return blocks;
  }

  async function readDocument(file, step) {
    const source = await readSource(file);
    step("Opening the file");
    const zip = await openZip(source.bytes, source.name);

    // The context carries warnings, and normally a PDF document and pdf-lib to
    // draw with. extract() draws nothing, so those stay null and the shaper is
    // the only piece it actually needs.
    const ctx = createContext(null, null, createShaper(null, { preserve: true }), null);
    ctx.name = source.name;
    ctx.kind = source.kind;
    ctx.warn(EXTRACT_WARNINGS[source.kind]);

    step(source.kind === "xlsx" ? "Reading the sheets"
      : source.kind === "pptx" ? "Reading the slides" : "Reading the document");
    const blocks = source.kind === "docx"
      ? await extractDocx(zip, ctx)
      : source.kind === "pptx"
        ? await extractPptx(zip, ctx)
        : await extractXlsx(zip, ctx);

    // Nothing was replaced on this path, so the count is a heads-up rather
    // than a loss report - and it is the very same count toPdf would report.
    if (ctx.shaper.dropped.count > 0) ctx.warn(UNICODE_WARNING);
    step("Finishing up");

    return {
      kind: source.kind,
      title: source.name.replace(/\.[^.]+$/, ""),
      blocks,
      warnings: ctx.warnings,
    };
  }

  /* ---------- public conversion ---------- */

  async function toPdf(file, options) {
    const settings = options || {};
    const onProgress = typeof settings.onProgress === "function" ? settings.onProgress : null;
    const name = nameOrFallback(file);
    const kind = kindOf(file);
    const step = createProgress(onProgress, 4);

    try {
      const source = await readSource(file);
      step("Opening the file");
      const zip = await openZip(source.bytes, source.name);

      const pdf = await loadPdfLib();
      const doc = await pdf.PDFDocument.create();
      doc.setTitle(name.replace(/\.[^.]+$/, ""));
      doc.setProducer("SwiftPDF");
      doc.setCreator("SwiftPDF");

      const fonts = {
        regular: await doc.embedFont(pdf.StandardFonts.Helvetica),
        bold: await doc.embedFont(pdf.StandardFonts.HelveticaBold),
        italic: await doc.embedFont(pdf.StandardFonts.HelveticaOblique),
        boldItalic: await doc.embedFont(pdf.StandardFonts.HelveticaBoldOblique),
      };
      const shaper = createShaper(fonts);
      const ctx = createContext(doc, fonts, shaper, pdf);
      ctx.name = name;
      ctx.kind = kind;
      ctx.warn(BASE_WARNINGS[kind]);
      ctx.warn(UNSUPPORTED_WARNINGS[kind]);

      step(kind === "xlsx" ? "Reading the sheets" : kind === "pptx" ? "Reading the slides" : "Reading the document");
      if (kind === "docx") await buildDocx(ctx, zip);
      else if (kind === "pptx") await buildPptx(ctx, zip);
      else await buildXlsx(ctx, zip);

      step("Laying out the pages");
      if (shaper.dropped.count > 0) {
        ctx.stats.droppedCharacters = shaper.dropped.count;
        ctx.warn(FONT_WARNING);
      }
      const saved = await doc.save();
      step("Writing the PDF");

      const stats = {
        images: ctx.stats.images,
        characters: ctx.stats.characters,
        droppedCharacters: ctx.stats.droppedCharacters,
      };
      if (ctx.stats.paragraphs !== undefined) stats.paragraphs = ctx.stats.paragraphs;
      if (ctx.stats.slides !== undefined) stats.slides = ctx.stats.slides;
      if (ctx.stats.sheets !== undefined) stats.sheets = ctx.stats.sheets;

      return {
        bytes: saved,
        pageCount: doc.getPageCount(),
        warnings: ctx.warnings,
        stats,
      };
    } catch (err) {
      if (err && err.swiftOfficeUserFacing) throw err;
      // The person gets a sentence they can act on; the console keeps the real
      // cause, so a bug report is not a dead end.
      console.error(err);
      throw userError(name,
        "could not be converted. The file may be damaged, or it may use a feature this converter does not support. Try saving it again from the app it was made in.");
    }
  }

  /**
   * Reads a .docx, .pptx or .xlsx and returns its content as ordered blocks -
   * headings, paragraphs, lists, tables, sheets, slides and pictures - ready to
   * be written out as a different office format.
   *
   * Unlike toPdf(), the text comes back exactly as it is written, including
   * scripts the PDF fonts cannot draw; a warning says so instead of quietly
   * replacing the characters. Rejects only for a file it cannot read at all,
   * with the same finished sentence the UI shows for a failed conversion.
   */
  async function extract(file, options) {
    const settings = options || {};
    const onProgress = typeof settings.onProgress === "function" ? settings.onProgress : null;
    const step = createProgress(onProgress, 3);
    const name = nameOrFallback(file);
    try {
      return await readDocument(file, step);
    } catch (err) {
      if (err && err.swiftOfficeUserFacing) throw err;
      console.error(err);
      throw userError(name,
        "could not be read. The file may be damaged, or it may use a feature this converter does not support. Try saving it again from the app it was made in.");
    }
  }

  // The three names the converter tool advertises stay enumerable, and exactly
  // those three: office.spec.mjs holds the published surface to that, and
  // pdf-core.js probes isOfficeFile on whatever it finds. extract() is the
  // structured-content API used by the other office formats, not part of the
  // advertised PDF converter, so it is attached without being enumerable - a
  // real, public, callable method, deliberately outside that surface.
  window.SwiftOffice = { isOfficeFile, kindOf, toPdf, extract };
})();
