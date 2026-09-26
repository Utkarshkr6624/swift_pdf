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
    const pages = [];
    const inputSize = items.reduce((s, it) => s + it.file.size, 0);

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
            pages.push({
              dataUrl: canvas.toDataURL("image/jpeg", q.jpeg),
              w: canvas.width,
              h: canvas.height,
              pageWidth: pageSize.width,
              pageHeight: pageSize.height,
              margin: 0,
            });
          } finally {
            page.cleanup();
            canvas.width = 0;
            canvas.height = 0;
          }
          setStatus(`Re-encoding page ${pages.length}…`);
        }
      } finally {
        await pdf.destroy();
      }
    }

    const bytes = buildPdf(pages);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const saved = Math.max(0, inputSize - blob.size);
    showResult(blob, "compressed.pdf");
    document.querySelector(".result-text").textContent =
      saved > 0
        ? `Done — ${formatSize(inputSize)} → ${formatSize(blob.size)} (saved ${formatSize(saved)}).`
        : `Done — ${formatSize(inputSize)} → ${formatSize(blob.size)}. This PDF was already lean.`;
    if (saved === 0) setStatus("This PDF was already well compressed — the copy is the same size.", "");
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
