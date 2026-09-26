(() => {
  const input = document.getElementById("fileInput");
  const dropzone = document.getElementById("dropzone");
  const themePanel = document.getElementById("themePanel");
  const themeHint = document.getElementById("themeHint");
  const convertBtn = document.getElementById("convertBtn");
  const themeOptions = [...document.querySelectorAll("[data-pdf-theme]")];
  const customThemePanel = document.getElementById("customThemePanel");
  const customColorError = document.getElementById("customColorError");
  const previewPanel = document.getElementById("pdfPreview");
  const previewCanvas = document.getElementById("previewCanvas");
  const previewButton = document.getElementById("previewBtn");
  const colorFields = ["primary", "secondary", "text"].map((name) => ({
    picker: document.getElementById(`${name}Picker`),
    hex: document.getElementById(`${name}Hex`),
  }));
  const palettes = {
    dark: { paper: [23, 26, 34], ink: [238, 240, 246] },
    sepia: { paper: [244, 231, 207], ink: [61, 43, 28] },
    blue: { paper: [21, 34, 57], ink: [220, 232, 255] },
    sage: { paper: [225, 239, 225], ink: [36, 59, 44] },
  };
  let selectedFile = null;
  let selectedTheme = "dark";
  let outputBytes = null;
  let previewPdf = null;
  let previewRendering = false;
  let previewLoading = false;

  function closePreview() {
    previewPanel.hidden = true;
    previewButton.setAttribute("aria-expanded", "false");
    previewButton.textContent = "Preview PDF";
  }

  function releaseOutput() {
    if (previewPdf) previewPdf.destroy().catch(() => {});
    previewPdf = null;
    outputBytes = null;
    previewCanvas.width = 0;
    previewCanvas.height = 0;
    document.getElementById("previewPageCount").textContent = "Page 1";
    document.getElementById("previewPageLabel").textContent = "Page 1 of 1";
    document.getElementById("previousPageBtn").disabled = true;
    document.getElementById("nextPageBtn").disabled = true;
    closePreview();
  }

  function parseHex(value) {
    const match = /^#?([\da-f]{6})$/i.exec(value.trim());
    if (!match) return null;
    const hex = match[1];
    return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  }

  function getPalette() {
    if (selectedTheme === "custom") {
      const [primary, secondary, text] = colorFields.map((field) => parseHex(field.hex.value));
      if (primary && secondary && text) return { primary, secondary, text };
      colorFields.forEach(({ hex }) => hex.setAttribute("aria-invalid", String(!parseHex(hex.value))));
      customColorError.hidden = false;
      return null;
    }
    const preset = palettes[selectedTheme];
    if (!preset) return null;
    const secondary = preset.ink.map((channel, index) => Math.round((channel + preset.paper[index]) / 2));
    return { primary: preset.paper, secondary, text: preset.ink };
  }

  function syncCustomPreview() {
    const colors = colorFields.map(({ hex }) => parseHex(hex.value));
    const customSwatch = document.querySelector(".swatch-custom");
    if (customSwatch && colors.every(Boolean)) {
      customSwatch.style.setProperty("--custom-primary", `#${colorFields[0].hex.value.replace(/^#/, "")}`);
      customSwatch.style.setProperty("--custom-secondary", `#${colorFields[1].hex.value.replace(/^#/, "")}`);
      customSwatch.style.setProperty("--custom-text", `#${colorFields[2].hex.value.replace(/^#/, "")}`);
    }
    customColorError.hidden = colors.every(Boolean);
  }

  colorFields.forEach(({ picker, hex }) => {
    const syncHex = () => {
      hex.value = picker.value;
      hex.removeAttribute("aria-invalid");
      syncCustomPreview();
    };
    const syncPicker = () => {
      const rgb = parseHex(hex.value);
      hex.setAttribute("aria-invalid", String(!rgb));
      if (rgb) picker.value = `#${hex.value.replace(/^#/, "")}`.toLowerCase();
      syncCustomPreview();
    };
    // Some mobile color controls commit with change rather than input.
    picker.addEventListener("input", syncHex);
    picker.addEventListener("change", syncHex);
    hex.addEventListener("input", syncPicker);
    hex.addEventListener("change", syncPicker);
  });
  syncCustomPreview();

  async function renderPreviewPage(pageNumber) {
    if (!previewPdf || previewRendering) return;
    previewRendering = true;
    const previous = document.getElementById("previousPageBtn");
    const next = document.getElementById("nextPageBtn");
    previous.disabled = true;
    next.disabled = true;
    try {
      const page = await previewPdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const stageWidth = Math.max(220, previewCanvas.parentElement.clientWidth - 30);
      const scale = Math.min(1.5, stageWidth / base.width, 1000 / base.height);
      const viewport = page.getViewport({ scale });
      previewCanvas.width = Math.ceil(viewport.width);
      previewCanvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: previewCanvas.getContext("2d"), viewport }).promise;
      page.cleanup();
      document.getElementById("previewPageCount").textContent = `Page ${pageNumber} of ${previewPdf.numPages}`;
      document.getElementById("previewPageLabel").textContent = `Page ${pageNumber} of ${previewPdf.numPages}`;
      previous.disabled = pageNumber <= 1;
      next.disabled = pageNumber >= previewPdf.numPages;
      previous.dataset.page = String(pageNumber - 1);
      next.dataset.page = String(pageNumber + 1);
    } catch (error) {
      if (!error || error.name !== "RenderingCancelledException") {
        setStatus(error && error.message ? error.message : "Could not render the PDF preview page.", "error");
      }
    } finally {
      previewRendering = false;
    }
  }

  async function openPreview() {
    if (!outputBytes || previewLoading) return;
    previewLoading = true;
    previewPanel.hidden = false;
    previewButton.setAttribute("aria-expanded", "true");
    previewButton.textContent = "Hide preview";
    try {
      if (!previewPdf) {
        setStatus("Preparing PDF preview…");
        const pdfjs = await loadPdfJs();
        previewPdf = await pdfjs.getDocument({ data: new Uint8Array(outputBytes) }).promise;
      }
      const page = Number(document.getElementById("previewPageLabel").textContent.match(/Page (\d+)/)?.[1]) || 1;
      await renderPreviewPage(Math.min(page, previewPdf.numPages));
      setStatus("Preview ready. Check the pages before downloading.", "success");
    } catch (error) {
      setStatus(error && error.message ? error.message : "Could not load the PDF preview.", "error");
    } finally {
      previewLoading = false;
    }
  }

  function chooseFile(file) {
    if (!file) return;
    if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
      setStatus("Choose a PDF file.", "error");
      return;
    }
    selectedFile = file;
    releaseOutput();
    document.getElementById("selectedName").textContent = file.name;
    themePanel.hidden = false;
    hideResultBar();
    setStatus("PDF ready. Choose a color theme and apply it.");
  }

  input.addEventListener("change", () => {
    chooseFile(input.files && input.files[0]);
    input.value = "";
  });
  dropzone.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    if (!input.disabled) input.click();
  });
  dropzone.addEventListener("keydown", (event) => {
    if (!input.disabled && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      input.click();
    }
  });
  ["dragenter", "dragover"].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  }));
  dropzone.addEventListener("drop", (event) => chooseFile(event.dataTransfer.files && event.dataTransfer.files[0]));

  themeOptions.forEach((option) => option.addEventListener("click", () => {
    selectedTheme = option.dataset.pdfTheme;
    themeOptions.forEach((item) => {
      const active = item === option;
      item.classList.toggle("selected", active);
      item.setAttribute("aria-pressed", String(active));
    });
    customThemePanel.hidden = selectedTheme !== "custom";
    if (selectedTheme === "custom") syncCustomPreview();
    else customColorError.hidden = true;
    themeHint.textContent = `${option.querySelector("strong").textContent} theme selected.`;
  }));

  previewButton.addEventListener("click", () => {
    if (previewPanel.hidden) openPreview();
    else closePreview();
  });
  document.getElementById("closePreviewBtn").addEventListener("click", closePreview);
  document.getElementById("previousPageBtn").addEventListener("click", (event) => renderPreviewPage(Number(event.currentTarget.dataset.page)));
  document.getElementById("nextPageBtn").addEventListener("click", (event) => renderPreviewPage(Number(event.currentTarget.dataset.page)));
  window.addEventListener("resize", () => {
    if (!previewPanel.hidden && previewPdf && !previewRendering) {
      const page = Number(document.getElementById("previewPageLabel").textContent.match(/Page (\d+)/)?.[1]) || 1;
      renderPreviewPage(page);
    }
  });

  convertBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    const palette = getPalette();
    if (!palette) return;
    setToolBusy(true);
    hideResultBar();
    releaseOutput();
    let pdf = null;
    let canvas = null;
    try {
      setStatus("Loading PDF tools…");
      const [pdfjs, pdfLib] = await Promise.all([loadPdfJs(), loadPdfLib()]);
      const bytes = await selectedFile.arrayBuffer();
      pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      const out = await pdfLib.PDFDocument.create();
      canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("This browser cannot create the page preview needed to recolor the PDF.");
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        setStatus(`Applying theme to page ${pageNo} of ${pdf.numPages}…`);
        const page = await pdf.getPage(pageNo);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.sqrt(12000000 / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: ctx, viewport, background: "rgb(255,255,255)" }).promise;

        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = pixels.data;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i], green = data[i + 1], blue = data[i + 2];
          const high = Math.max(red, green, blue);
          const low = Math.min(red, green, blue);
          if (high - low <= 46) {
            const tone = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
            const lowToMid = Math.min(1, tone * 2);
            const midToHigh = Math.max(0, (tone - 0.5) * 2);
            const lower = tone < 0.5;
            const amount = lower ? lowToMid : midToHigh;
            for (let channel = 0; channel < 3; channel++) {
              const from = lower ? palette.text[channel] : palette.secondary[channel];
              const to = lower ? palette.secondary[channel] : palette.primary[channel];
              data[i + channel] = Math.round(from * (1 - amount) + to * amount);
            }
          }
        }
        ctx.putImageData(pixels, 0, 0);
        const imageBytes = await new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
          if (!blob) return reject(new Error(`Could not encode page ${pageNo}.`));
          try { resolve(await blob.arrayBuffer()); } catch (error) { reject(error); }
        }, "image/jpeg", 0.92));
        const embedded = await out.embedJpg(imageBytes);
        const outPage = out.addPage([base.width * 0.75, base.height * 0.75]);
        outPage.drawImage(embedded, { x: 0, y: 0, width: base.width * 0.75, height: base.height * 0.75 });
        page.cleanup();
      }

      const output = await out.save();
      outputBytes = new Uint8Array(output);
      showResult(new Blob([output], { type: "application/pdf" }), "themed.pdf");
      setStatus(`Done. ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"} recolored.`, "success");
    } catch (error) {
      const message = error && error.name === "PasswordException"
        ? "This PDF requires an open password. Enter the correct password in the Unlock PDF tool first, then try the theme again."
        : explainProcessingError(error, "Changing this PDF theme", selectedFile && selectedFile.name);
      setStatus(message, "error");
    } finally {
      if (pdf) await pdf.destroy();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      setToolBusy(false);
    }
  });

  wireStartAnother(input, () => {
    selectedFile = null;
    releaseOutput();
    themePanel.hidden = true;
    document.getElementById("selectedName").textContent = "or drag & drop it here";
    setStatus("");
  });
})();
