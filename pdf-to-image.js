// PDF to Image tool — renders each page to PNG via pdf.js
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");

let scale = 2;
document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach((p) => p.classList.remove("selected"));
    pill.classList.add("selected");
    scale = parseFloat(pill.dataset.scale);
  });
});

const strip = createFileStrip({ input: fileInput, stripEl, accept: "pdf", toolbar });
wireDropzone(dropzone, fileInput, (f) => strip.addFiles(f));
wireStartAnother(fileInput, () => strip.clear());

clearBtn.addEventListener("click", () => strip.clear());

convertBtn.addEventListener("click", async () => {
  const items = strip.items;
  if (!items.length) return;
  setToolBusy(true);
  convertBtn.disabled = true;
  hideResultBar();
  setStatus("Rendering pages…");

  try {
    const pdfjs = await loadPdfJs();
    const JSZip = await loadJsZip();
    const zip = new JSZip();
    let total = 0;
    for (let fileIndex = 0; fileIndex < items.length; fileIndex++) {
      const item = items[fileIndex];
      const data = await item.file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data }).promise;
      try {
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          try {
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            const png = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not create a PNG for page " + p + ".")), "image/png"));
            const base = item.file.name.replace(/\.pdf$/i, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "document";
            const prefix = items.length > 1 ? String(fileIndex + 1).padStart(2, "0") + "-" : "";
            zip.file(prefix + base + "-page-" + String(p).padStart(3, "0") + ".png", png);
            total++;
            setStatus(`Rendering pages… ${total} ready`, "");
          } finally {
            page.cleanup();
            canvas.width = 0;
            canvas.height = 0;
          }
        }
      } finally {
        await pdf.destroy();
      }
    }
    const blob = await zip.generateAsync({ type: "blob" }, (meta) => setStatus(`Packing images… ${Math.round(meta.percent)}%`));
    showResult(blob, "pdf-images.zip", "zip");
    setStatus(`Done — ${total} image${total === 1 ? "" : "s"} packed into one ZIP download.`, "success");
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Converting this PDF to images", items[0] && items[0].file.name), "error");
  } finally {
    convertBtn.disabled = false;
    setToolBusy(false);
  }
});
// workspace (edit files)
const wsBtn = document.getElementById("wsBtn");
wsBtn.addEventListener("click", () => openWorkspace(strip));
