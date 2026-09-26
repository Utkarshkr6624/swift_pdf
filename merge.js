// Merge PDF tool — merges PDFs via pdf-lib; Office files get an honest message
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");

const strip = createFileStrip({ input: fileInput, stripEl, accept: "pdf", toolbar });
wireDropzone(dropzone, fileInput, (f) => strip.addFiles(f));
wireStartAnother(fileInput, () => strip.clear());

clearBtn.addEventListener("click", () => strip.clear());

convertBtn.addEventListener("click", async () => {
  const items = strip.items;
  if (!items.length) return;
  const office = items.filter((it) => /\.(docx?|pptx?|xlsx?|odt)$/i.test(it.file.name));
  if (office.length) {
    setStatus(`Word/PowerPoint files can't be converted in the browser — that needs a conversion server, which is on the roadmap. Remove ${office.length > 1 ? "them" : "it"} (or convert to PDF first) and merge the PDFs.`, "error");
    return;
  }

  setToolBusy(true);
  convertBtn.disabled = true;
  hideResultBar();
  setStatus("Merging…");

  try {
    const pdfLib = await loadPdfLib();
    const merged = await pdfLib.PDFDocument.create();
    const flattenedFiles = [];
    for (const item of items) {
      const bytes = await item.file.arrayBuffer();
      try {
        // Do not bypass encryption checks here: pdf-lib can copy encrypted streams without decrypting them.
        // Its normal error path sends restricted PDFs through the PDF.js renderer below instead.
        const src = await pdfLib.PDFDocument.load(bytes);
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      } catch (vectorError) {
        // Keep processing readable PDFs with unsupported features by flattening that file's pages.
        console.warn("Using rendered-page fallback for", item.file.name, vectorError);
        await appendRenderedPdf(merged, bytes, pdfLib, item.file.name);
        flattenedFiles.push(item.file.name);
      }
      setStatus("Merging… added " + item.file.name);
    }
    const out = await merged.save();
    const blob = new Blob([out], { type: "application/pdf" });
    showResult(blob, "merged.pdf");
    if (flattenedFiles.length) {
      const details = flattenedFiles.length === 1 ? flattenedFiles[0] : `${flattenedFiles.length} PDFs`;
      document.querySelector(".result-text").textContent = `Merged successfully. ${details} needed a compatibility fallback, so those pages may not keep selectable text.`;
      setStatus("Merged successfully. Some pages were rendered for compatibility.", "success");
    }
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Merging these PDFs", items[0] && items[0].file.name), "error");
  } finally {
    convertBtn.disabled = false;
    setToolBusy(false);
  }
});

async function appendRenderedPdf(target, bytes, pdfLib, filename) {
  const pdfjs = await loadPdfJs();
  let doc;
  const loadDocument = (password) => {
    // Give PDF.js a fresh buffer for every attempt because its worker can transfer the supplied bytes.
    const options = { data: new Uint8Array(bytes.slice(0)) };
    if (password !== undefined) options.password = password;
    return pdfjs.getDocument(options).promise;
  };
  try { doc = await loadDocument(); }
  catch (err) {
    if (!err || err.name !== "PasswordException") {
      throw new Error(`Could not read ${filename}. It may be damaged or use an unsupported PDF feature.`);
    }

    // Try an empty user password first. Permission-restricted PDFs often have no open password.
    try { doc = await loadDocument(""); }
    catch (emptyPasswordError) {
      if (!emptyPasswordError || emptyPasswordError.name !== "PasswordException") throw emptyPasswordError;
      for (let attempt = 0; attempt < 3 && !doc; attempt++) {
        const prompt = attempt === 0
          ? `Enter the open password for ${filename}:`
          : `That password was not accepted. Try again for ${filename} (attempt ${attempt + 1} of 3):`;
        const password = window.prompt(prompt);
        if (password === null) throw new Error(`Merging stopped: ${filename} requires its correct open password.`);
        try { doc = await loadDocument(password); }
        catch (passwordError) {
          if (!passwordError || passwordError.name !== "PasswordException") throw passwordError;
        }
      }
      if (!doc) throw new Error(`The password was not accepted for ${filename}. Enter the correct open password and try again.`);
    }
  }
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      setStatus(`Rendering ${filename} — page ${pageNo} of ${doc.numPages}…`);
      const page = await doc.getPage(pageNo);
      const scale = Math.min(2, 2400 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1]));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const jpeg = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render a PDF page.")), "image/jpeg", 0.92));
        const image = await target.embedJpg(await jpeg.arrayBuffer());
        const pageWidth = viewport.width / scale;
        const pageHeight = viewport.height / scale;
        const outPage = target.addPage([pageWidth, pageHeight]);
        outPage.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    await doc.destroy();
  }
}
// workspace (edit files)
const wsBtn = document.getElementById("wsBtn");
wsBtn.addEventListener("click", () => openWorkspace(strip));
