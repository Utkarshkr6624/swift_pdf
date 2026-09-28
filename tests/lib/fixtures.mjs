// Sample files generated in memory, so the suite needs no binary fixtures and
// no network. makePdf() writes a real, standards-shaped PDF that pdf-lib,
// pdf.js and the tools themselves can all read.
import { Buffer } from "node:buffer";

const latin1 = (s) => Buffer.from(s, "latin1");

function escapePdfText(text) {
  return text.replace(/([\\()])/g, "\\$1");
}

/**
 * options: { pages, width, height, text }
 * `pages` pages are written; `text` is drawn on each page as "<text> page N",
 * which is what the specs read back out of a merged file to check its order.
 * text: null writes a page with no text layer at all, the way a scan looks.
 */
export function makePdf({ pages = 1, width = 595.28, height = 841.89, text = "SwiftPDF fixture" } = {}) {
  const count = Math.max(1, Math.floor(pages));
  const chunks = [];
  const offsets = [];
  let offset = 0;
  const write = (s) => {
    const bytes = latin1(s);
    chunks.push(bytes);
    offset += bytes.length;
  };
  const beginObj = (num, body) => {
    offsets[num] = offset;
    write(`${num} 0 obj\n${body}\nendobj\n`);
  };

  const pageObj = (i) => 3 + i * 2;
  const contentObj = (i) => 4 + i * 2;
  const fontObj = 3 + count * 2;

  write("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  beginObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  beginObj(2, `<< /Type /Pages /Count ${count} /Kids [ ${Array.from({ length: count }, (_, i) => `${pageObj(i)} 0 R`).join(" ")} ] >>`);

  for (let i = 0; i < count; i++) {
    const content =
      text === null
        ? ""
        : `BT /F1 18 Tf 56 700 Td (${escapePdfText(`${text} page ${i + 1}`)}) Tj ET\n0 0 1 RG 4 w 56 60 m 539 60 l S`;
    beginObj(
      pageObj(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${width} ${height} ] ` +
        `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`
    );
    beginObj(contentObj(i), `<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`);
  }
  beginObj(fontObj, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const total = fontObj + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  write(xref);

  return Buffer.concat(chunks, offset);
}

// A real 2x2 PNG (two opaque pixels, two transparent ones), used wherever a
// strip or workspace needs a decodable image.
const PNG_2x2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4zwAC/xlA9P" +
    "//DAAj7AT8sAOFywAAAABJRU5ErkJggg==",
  "base64"
);

export function makePng() {
  return PNG_2x2;
}

export function makeTextFile(name = "notes.txt", body = "not a pdf") {
  return { name, mimeType: "text/plain", buffer: Buffer.from(body, "utf8") };
}

export function makePdfFile(name, options) {
  return { name, mimeType: "application/pdf", buffer: makePdf(options) };
}

// A named PDF whose pages say which file they came from, so a spec can read
// the order back out of a merged document.
export function makeNamedPdfFile(name, { pages = 1 } = {}) {
  const label = name.replace(/\.pdf$/i, "");
  return makePdfFile(name, { pages, text: label });
}

export function makeBrokenPdfFile(name = "broken.pdf") {
  return {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nthis is not a pdf body\n%%EOF\n", "latin1"),
  };
}
