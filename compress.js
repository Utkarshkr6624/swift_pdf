// Compress PDF tool — re-renders pages at chosen quality and rebuilds the PDF
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const compressBtn = document.getElementById("compressBtn");
const clearBtn = document.getElementById("clearBtn");

const QUALITY = {
  small: { scale: 1.2, jpeg: 0.5, label: "Smallest" },
  medium: { scale: 1.6, jpeg: 0.68, label: "Balanced" },
  high: { scale: 2.0, jpeg: 0.85, label: "Best quality" },
};
let quality = "medium";
document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach((p) => p.classList.remove("selected"));
    pill.classList.add("selected");
    quality = pill.dataset.q;
  });
});

const strip = createFileStrip({ input: fileInput, stripEl, accept: "pdf", toolbar });
wireDropzone(dropzone, fileInput, (f) => strip.addFiles(f));
wireStartAnother(fileInput, () => strip.clear());

clearBtn.addEventListener("click", () => strip.clear());

// Encode a page straight to JPEG bytes. toDataURL would hand back a base64
// string, which costs roughly 2.7 bytes of memory for every byte of image.
function encodeJpeg(canvas, jpegQuality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("This browser could not encode a page as an image."));
      try {
        resolve(new Uint8Array(await blob.arrayBuffer()));
      } catch (err) {
        reject(err);
      }
    }, "image/jpeg", jpegQuality);
  });
}

// Streaming PDF writer. buildPdf() in pdf-core.js cannot start until it has
// every page, so a long document used to sit in memory as one base64 string per
// page and then again as a separate copy of the finished file. Here each page
// is appended to the output the moment it is encoded; the catalog and page tree
// are written last, once the page count is known. The objects produced are the
// same ones buildPdf produces, so readers see the same document either way.
function createPdfStream() {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [0];
  let length = 0;
  let pages = 0;

  const write = (data) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const beginObj = (num) => {
    offsets[num] = length;
    write(`${num} 0 obj\n`);
  };

  write("%PDF-1.4\n");
  // Marker bytes go out raw; as characters they would be UTF-8 encoded into
  // eight bytes that no longer read as the binary marker.
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  return {
    // Pages fill their media box edge to edge, as they did before.
    addPage(jpeg, w, h, pageWidth, pageHeight) {
      const i = pages++;
      const imgObj = 3 + i * 3;
      const contentObj = 4 + i * 3;
      const pageObj = 5 + i * 3;
      const pageW = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 595.28;
      const pageH = Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 841.89;
      const scale = Math.min(pageW / w, pageH / h);
      const dw = w * scale, dh = h * scale;
      const x = (pageW - dw) / 2, y = (pageH - dh) / 2;

      beginObj(imgObj);
      write(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      write(jpeg);
      write("\nendstream\nendobj\n");

      const content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${i} Do Q`;
      beginObj(contentObj);
      write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

      beginObj(pageObj);
      write(`<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)} ] /Resources << /XObject << /Im${i} ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);
    },

    finish() {
      const kids = [];
      for (let i = 0; i < pages; i++) kids.push(`${5 + i * 3} 0 R`);
      beginObj(1);
      write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
      beginObj(2);
      write(`<< /Type /Pages /Count ${pages} /Kids [ ${kids.join(" ")} ] >>\nendobj\n`);

      const total = 3 + pages * 3;
      const xrefStart = length;
      let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
      for (let i = 1; i < total; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
      xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
      write(xref);

      // Blob copies the parts, so dropping them here caps the peak at the
      // finished file rather than twice the finished file.
      const blob = new Blob(parts, { type: "application/pdf" });
      parts.length = 0;
      return blob;
    },
  };
}

compressBtn.addEventListener("click", async () => {
  const items = strip.items;
  if (!items.length) return;
  const q = QUALITY[quality];
  setToolBusy(true);
  compressBtn.disabled = true;
  hideResultBar();
  setStatus("Loading PDF engine…");

  try {
    const pdfjs = await loadPdfJs();
    const out = createPdfStream();
    const inputSize = items.reduce((s, it) => s + it.file.size, 0);
    let pages = 0;

    for (const item of items) {
      const data = await item.file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data }).promise;
      try {
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const pageSize = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: q.scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          try {
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            out.addPage(
              await encodeJpeg(canvas, q.jpeg),
              canvas.width,
              canvas.height,
              pageSize.width,
              pageSize.height
            );
          } finally {
            page.cleanup();
            canvas.width = 0;
            canvas.height = 0;
          }
          pages++;
          setStatus(`Re-encoding page ${pages}…`);
        }
      } finally {
        await pdf.destroy();
      }
    }
    // A page-less document would come out as a file no reader can open.
    if (!pages) throw new Error("This PDF has no pages to compress.");
    const blob = out.finish();

    // Re-encoding pages as images can make an already-lean PDF bigger, and the
    // old wording called that "already lean" while handing back the larger file.
    const delta = inputSize - blob.size;
    const from = formatSize(inputSize);
    const to = formatSize(blob.size);
    showResult(blob, "compressed.pdf");
    document.querySelector(".result-text").textContent =
      delta > 0
        ? `Done — ${from} → ${to} (saved ${formatSize(delta)}).`
        : delta === 0
          ? `Done — ${from} → ${to}. The copy came out the same size.`
          : `Done — ${from} → ${to}. This PDF is already well compressed, so re-encoding its pages as images made it bigger. The original is the better copy.`;
    if (delta < 0)
      setStatus("Re-encoding made this file bigger — it was already well compressed, so keep the original.");
    else if (delta === 0) setStatus("The compressed copy came out the same size as the original.");
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Compressing this PDF", items[0] && items[0].file.name), "error");
  } finally {
    compressBtn.disabled = false;
    setToolBusy(false);
  }
});
// workspace (edit files)
const wsBtn = document.getElementById("wsBtn");
wsBtn.addEventListener("click", () => openWorkspace(strip));
