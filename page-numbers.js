const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const toolbar = document.getElementById("numberOptions");
const strip = createFileStrip({ input: fileInput, stripEl: document.getElementById("fileStrip"), accept: "pdf", toolbar });
const numberBtn = document.getElementById("numberBtn");

wireDropzone(dropzone, fileInput, (files) => {
  strip.clear();
  strip.addFiles(Array.from(files).slice(0, 1));
  hideResultBar();
});
wireStartAnother(fileInput, () => strip.clear());

numberBtn.addEventListener("click", async () => {
  const item = strip.items[0];
  if (!item) return;
  const start = Number.parseInt(document.getElementById("startNumber").value, 10);
  if (!Number.isInteger(start) || start < 1 || start > 999999) {
    setStatus("Enter a starting number from 1 to 999999.", "error");
    return;
  }
  setToolBusy(true);
  numberBtn.disabled = true;
  hideResultBar();
  setStatus("Adding page numbers…");
  try {
    const pdfLib = await loadPdfLib();
    const pdf = await pdfLib.PDFDocument.load(await item.file.arrayBuffer());
    const font = await pdf.embedFont(pdfLib.StandardFonts.Helvetica);
    const size = Number(document.getElementById("numberSize").value);
    const position = document.getElementById("numberPosition").value;
    pdf.getPages().forEach((page, index) => {
      const label = String(start + index);
      const width = font.widthOfTextAtSize(label, size);
      const pageSize = page.getSize();
      page.drawText(label, {
        x: (pageSize.width - width) / 2,
        y: position === "top" ? pageSize.height - size - 18 : 18,
        size,
        font,
        color: pdfLib.rgb(0.32, 0.35, 0.42),
      });
    });
    showResult(new Blob([await pdf.save()], { type: "application/pdf" }), "numbered.pdf");
    setStatus(`Added numbers to ${pdf.getPageCount()} pages.`, "success");
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Adding page numbers to this PDF", item.file.name), "error");
  } finally {
    numberBtn.disabled = false;
    setToolBusy(false);
  }
});
