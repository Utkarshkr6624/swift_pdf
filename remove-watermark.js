const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const convertBtn = document.getElementById("convertBtn");
const strip = createFileStrip({ input: fileInput, stripEl, accept: "pdf", toolbar });

wireDropzone(dropzone, fileInput, (files) => {
  strip.clear();
  strip.addFiles(Array.from(files).slice(0, 1));
  hideResultBar();
});
wireStartAnother(fileInput, () => strip.clear());

convertBtn.addEventListener("click", async () => {
  const item = strip.items[0];
  if (!item) return;
  setToolBusy(true);
  convertBtn.disabled = true;
  hideResultBar();
  setStatus("Checking PDF annotations…");
  try {
    const pdfLib = await loadPdfLib();
    const pdf = await pdfLib.PDFDocument.load(await item.file.arrayBuffer());
    let removed = 0;
    for (const page of pdf.getPages()) {
      const key = pdfLib.PDFName.of("Annots");
      const annotsRef = page.node.get(key);
      if (!annotsRef) continue;
      const annots = pdf.context.lookup(annotsRef);
      if (!(annots instanceof pdfLib.PDFArray)) continue;
      const refs = annots.asArray();
      const kept = [];
      for (const ref of refs) {
        let dict;
        try { dict = pdf.context.lookup(ref); } catch { dict = null; }
        const subtype = dict instanceof pdfLib.PDFDict ? dict.get(pdfLib.PDFName.of("Subtype")) : null;
        const isWatermark = subtype && subtype.toString() === "/Watermark";
        if (isWatermark) removed++;
        else kept.push(ref);
      }
      if (kept.length !== refs.length) {
        const next = pdfLib.PDFArray.withContext(pdf.context);
        kept.forEach((ref) => next.push(ref));
        page.node.set(pdfLib.PDFName.of("Annots"), next);
      }
    }
    if (!removed) {
      // Annotation dictionaries in pdf-lib are low-level objects; retain the original array entries
      // and report honestly when no PDF /Watermark annotations were found.
      setStatus("No removable watermark annotations were found. This PDF may have its watermark flattened into the page artwork, which cannot be safely erased automatically.", "error");
      return;
    }
    const bytes = await pdf.save();
    showResult(new Blob([bytes], { type: "application/pdf" }), "cleaned.pdf");
    setStatus(`Removed ${removed} watermark annotation${removed === 1 ? "" : "s"}.`, "success");
  } catch (err) {
    console.error(err);
    setStatus("Could not process this PDF. It may be corrupted, encrypted, or use unsupported annotations.", "error");
  } finally {
    convertBtn.disabled = false;
    setToolBusy(false);
  }
});
