// Merge PDF tool — merges PDFs via pdf-lib; Office files get an honest message
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");
const resultBar = document.getElementById("resultBar");

const strip = createFileStrip({ input: fileInput, stripEl, accept: "pdf", toolbar });
wireDropzone(dropzone, fileInput, (f) => strip.addFiles(f));

clearBtn.addEventListener("click", () => strip.clear());

convertBtn.addEventListener("click", async () => {
  const items = strip.items;
  if (!items.length) return;
  const office = items.filter((it) => /\.(docx?|pptx?|xlsx?|odt)$/i.test(it.file.name));
  if (office.length) {
    setStatus(`Word/PowerPoint files can't be converted in the browser — that needs a conversion server, which is on the roadmap. Remove ${office.length > 1 ? "them" : "it"} (or convert to PDF first) and merge the PDFs.`, "error");
    return;
  }

  convertBtn.disabled = true;
  resultBar.hidden = true;
  setStatus("Merging…");

  try {
    const pdfLib = await loadPdfLib();
    const merged = await pdfLib.PDFDocument.create();
    for (const item of items) {
      const bytes = await item.file.arrayBuffer();
      try {
        // Some PDFs have editing restrictions that pdf-lib normally enforces.
        const src = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      } catch (vectorError) {
        // Keep processing readable PDFs with unsupported features by flattening that file's pages.
        console.warn("Using rendered-page fallback for", item.file.name, vectorError);
        await appendRenderedPdf(merged, bytes, pdfLib, item.file.name);
      }
      setStatus("Merging… added " + item.file.name);
    }
    const out = await merged.save();
    const blob = new Blob([out], { type: "application/pdf" });
    showResult(blob, "merged.pdf");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Merge failed. This PDF may be corrupted or require an open password.", "error");
  } finally {
    convertBtn.disabled = false;
  }
});

async function appendRenderedPdf(target, bytes, pdfLib, filename) {
  const pdfjs = await loadPdfJs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  } catch (err) {
    if (err && err.name === "PasswordException") {
      const password = window.prompt(`Enter the password to open ${filename}:`);
      if (!password) throw new Error(`Merging stopped: ${filename} requires an open password.`);
      doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), password }).promise;
    } else {
      throw new Error(`Could not read ${filename}. It may be damaged or use an unsupported PDF feature.`);
    }
  }
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    setStatus(`Rendering ${filename} — page ${pageNo} of ${doc.numPages}…`);
    const page = await doc.getPage(pageNo);
    const scale = Math.min(2, 2400 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1]));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const jpeg = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render a PDF page.")), "image/jpeg", 0.92));
    const image = await target.embedJpg(await jpeg.arrayBuffer());
    const outPage = target.addPage([page.view[2] - page.view[0], page.view[3] - page.view[1]]);
    outPage.drawImage(image, { x: 0, y: 0, width: outPage.getWidth(), height: outPage.getHeight() });
    canvas.width = 0;
    canvas.height = 0;
  }
  doc.destroy();
}
// workspace (edit files)
const wsBtn = document.getElementById("wsBtn");
wsBtn.addEventListener("click", () => openWorkspace(strip));
