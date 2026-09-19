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
      const src = await pdfLib.PDFDocument.load(bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
      setStatus("Merging… added " + item.file.name);
    }
    const out = await merged.save();
    const blob = new Blob([out], { type: "application/pdf" });
    showResult(blob, "merged.pdf");
  } catch (err) {
    console.error(err);
    setStatus("Merge failed — one of the PDFs may be corrupted or password-protected.", "error");
  } finally {
    convertBtn.disabled = false;
  }
});
// workspace (edit files)
const wsBtn = document.getElementById("wsBtn");
wsBtn.addEventListener("click", () => openWorkspace(strip));
