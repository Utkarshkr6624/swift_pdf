const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const toolbar = document.getElementById("toolbar");
const strip = createFileStrip({ input: fileInput, stripEl: document.getElementById("fileStrip"), accept: "pdf", toolbar });
const convertBtn = document.getElementById("convertBtn");
const passwordInput = document.getElementById("openPassword");

wireDropzone(dropzone, fileInput, (files) => {
  strip.clear();
  strip.addFiles(Array.from(files).slice(0, 1));
  hideResultBar();
});
wireStartAnother(fileInput, () => { strip.clear(); passwordInput.value = ""; });

convertBtn.addEventListener("click", async () => {
  const item = strip.items[0];
  if (!item) return;
  setToolBusy(true);
  convertBtn.disabled = true;
  hideResultBar();
  setStatus("Unlocking PDF…");
  try {
    const inputBytes = await item.file.arrayBuffer();
    const pdfLib = await loadPdfLib();
    try {
      const pdf = await pdfLib.PDFDocument.load(inputBytes.slice(0));
      const bytes = await pdf.save();
      showResult(new Blob([bytes], { type: "application/pdf" }), "unlocked.pdf");
      setStatus("PDF copy prepared. Download the result.", "success");
      return;
    } catch (loadError) {
      const pdfjs = await loadPdfJs();
      let doc;
      try {
        const options = { data: new Uint8Array(inputBytes.slice(0)) };
        if (passwordInput.value) options.password = passwordInput.value;
        doc = await pdfjs.getDocument(options).promise;
      } catch (err) {
        if (err && err.name === "PasswordException") {
          throw new Error(passwordInput.value ? "The password was not accepted. Check it and try again." : "This PDF requires an open password. Enter its password and try again.");
        }
        throw loadError;
      }
      const unlocked = await pdfLib.PDFDocument.create();
      try {
        for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
          setStatus(`Creating unlocked copy — page ${pageNo} of ${doc.numPages}…`);
          const page = await doc.getPage(pageNo);
          const scale = Math.min(2, 2400 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1]));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          try {
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not render a PDF page.")), "image/jpeg", 0.94));
            const image = await unlocked.embedJpg(await blob.arrayBuffer());
            const width = viewport.width / scale;
            const height = viewport.height / scale;
            const outPage = unlocked.addPage([width, height]);
            outPage.drawImage(image, { x: 0, y: 0, width, height });
          } finally {
            page.cleanup();
            canvas.width = 0;
            canvas.height = 0;
          }
        }
      } finally {
        await doc.destroy();
      }
      showResult(new Blob([await unlocked.save()], { type: "application/pdf" }), "unlocked.pdf");
      setStatus("Unlocked copy created. Pages were flattened; selectable text and signatures are not preserved.", "success");
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not unlock this PDF. It may be damaged or use unsupported encryption.", "error");
  } finally {
    convertBtn.disabled = false;
    setToolBusy(false);
  }
});
