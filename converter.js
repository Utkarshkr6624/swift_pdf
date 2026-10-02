// Image tools get crop + rotate inside the workspace
window.WS_IMAGE_MODE = true;

// Image to PDF tool — crop and full-page workspace support
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");
const wsBtn = document.getElementById("wsBtn");

const strip = createFileStrip({
  input: fileInput,
  stripEl,
  accept: "image",
  toolbar,
  onChange(count) {
    const noun = count === 1 ? "image" : "images";
    const pageNoun = count === 1 ? "PDF page" : "PDF pages";
    document.getElementById("imagePageCount").textContent = `${count} ${noun} · ${count} ${pageNoun}`;
  },
  extraMenu(item, menu) {
    const cropBtn = document.createElement("button");
    cropBtn.textContent = item.crop ? "Re-crop" : "Crop";
    cropBtn.addEventListener("click", async () => {
      closeAllMenus();
      const rect = await openCrop(item.file);
      if (!rect) return;
      try {
        await refreshThumb(item, rect);
        item.crop = rect;
        strip.render();
      } catch (err) {
        setStatus(err.message || `Could not crop ${item.file.name}.`, "error");
      }
    });
    menu.prepend(cropBtn);
  },
});

async function refreshThumb(item, rect) {
  hideResultBar();
  const canvas = document.createElement("canvas");
  const img = new Image();
  const src = URL.createObjectURL(item.file);
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(`Could not read ${item.file.name}.`)); img.src = src; });
    const maxSide = 240;
    const s = Math.min(1, maxSide / Math.max(rect.w, rect.h));
    canvas.width = Math.max(1, Math.round(rect.w * s));
    canvas.height = Math.max(1, Math.round(rect.h * s));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser could not prepare the cropped image preview.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res, rej) => canvas.toBlob((result) => result ? res(result) : rej(new Error("Could not save the cropped image preview.")), "image/jpeg", 0.85));
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = URL.createObjectURL(blob);
  } finally {
    URL.revokeObjectURL(src);
    canvas.width = 0;
    canvas.height = 0;
  }
}

// "cropped" badge
new MutationObserver(() => {
  document.querySelectorAll(".chip").forEach((chip, i) => {
    const item = strip.items[i];
    const badge = chip.querySelector(".chip-cropped");
    if (item && item.crop && !badge) {
      const b = document.createElement("span");
      b.className = "chip-cropped";
      b.textContent = "cropped";
      chip.appendChild(b);
    } else if (item && !item.crop && badge) {
      badge.remove();
    }
  });
}).observe(document.querySelector(".file-strip-wrap"), { childList: true, subtree: true });

wireDropzone(dropzone, fileInput, (f) => strip.addFiles(f));
wireStartAnother(fileInput, () => strip.clear());

wsBtn.addEventListener("click", () => openWorkspace(strip));

clearBtn.addEventListener("click", () => strip.clear());

convertBtn.addEventListener("click", async () => {
  if (!strip.items.length) return;
  setToolBusy(true);
  convertBtn.disabled = true;
  hideResultBar();
  setStatus("Converting…");

  try {
    const items = strip.items;
    // Each page is encoded, appended and released before the next picture is
    // opened, so what is held at once is the finished PDF plus one photograph -
    // rather than every photograph, and then every photograph again inside the
    // finished PDF. buildPdf() cannot do that: it needs every page in hand
    // before it writes the first byte of the cross-reference table.
    const writer = createStreamingPdfWriter();
    for (let i = 0; i < items.length; i++) {
      setStatus(`Converting… ${i + 1} of ${items.length}`);
      const page = await toJpegPage(items[i].file, items[i].crop);
      writer.addPage(page.bytes, page.w, page.h);
    }
    const blob = new Blob([writer.finish()], { type: "application/pdf" });
    showResult(blob, "swiftpdf.pdf");
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Converting these images", strip.items[0] && strip.items[0].file.name), "error");
  } finally {
    convertBtn.disabled = false;
    setToolBusy(false);
  }
});

// Shared by the live camera and the native mobile camera picker.
window.swiftPdfAddCameraPhoto = (file, crop = null) => {
  if (!file) return;
  const previousCount = strip.items.length;
  strip.addFiles([file]);
  const newItem = strip.items[previousCount];
  if (newItem && crop) {
    newItem.crop = crop;
    refreshThumb(newItem, crop)
      .then(() => strip.render())
      .catch((err) => setStatus(err.message || "Could not update the captured photo preview.", "error"));
  }
};
