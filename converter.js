// Image tools get crop + rotate inside the workspace
window.WS_IMAGE_MODE = true;

// Image to PDF tool — crop, camera, and full-page workspace support
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const cameraInput = document.getElementById("cameraInput");
const cameraFallback = document.getElementById("cameraFallback");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");
const resultBar = document.getElementById("resultBar");
const wsBtn = document.getElementById("wsBtn");

const strip = createFileStrip({
  input: fileInput,
  stripEl,
  accept: "image",
  toolbar,
  extraMenu(item, menu) {
    const cropBtn = document.createElement("button");
    cropBtn.textContent = item.crop ? "Re-crop" : "Crop";
    cropBtn.addEventListener("click", async () => {
      closeAllMenus();
      const rect = await openCrop(item.file);
      if (!rect) return;
      item.crop = rect;
      await refreshThumb(item, rect);
      strip.render();
    });
    menu.prepend(cropBtn);
  },
});

async function refreshThumb(item, rect) {
  const canvas = document.createElement("canvas");
  const img = new Image();
  const src = URL.createObjectURL(item.file);
  await new Promise((res, rej) => { img.onload = res; img.onerror = res; img.src = src; });
  URL.revokeObjectURL(src);
  const maxSide = 240;
  const s = Math.min(1, maxSide / Math.max(rect.w, rect.h));
  canvas.width = Math.max(1, Math.round(rect.w * s));
  canvas.height = Math.max(1, Math.round(rect.h * s));
  canvas.getContext("2d").drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  await new Promise((res) => canvas.toBlob((blob) => {
    if (!blob) return res();
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = URL.createObjectURL(blob);
    res();
  }, "image/jpeg", 0.85));
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

// camera: getUserMedia capture event + fallback input + desktop input
window.addEventListener("swiftpdf-photo", (e) => {
  const detail = e.detail;
  if (!detail) return;
  const list = detail.length !== undefined && !(detail instanceof File) ? detail : [detail];
  strip.addFiles(list);
  const wsOverlay = document.getElementById("workspaceOverlay");
  if (!wsOverlay.hidden) renderWorkspace();
});
cameraInput.addEventListener("change", () => {
  if (cameraInput.files.length) strip.addFiles(cameraInput.files);
  cameraInput.value = "";
});
cameraFallback.addEventListener("change", () => {
  if (cameraFallback.files.length) strip.addFiles(cameraFallback.files);
  cameraFallback.value = "";
});

wsBtn.addEventListener("click", () => openWorkspace(strip));

clearBtn.addEventListener("click", () => strip.clear());

convertBtn.addEventListener("click", async () => {
  if (!strip.items.length) return;
  convertBtn.disabled = true;
  resultBar.hidden = true;
  setStatus("Converting…");

  try {
    const pages = [];
    for (const item of strip.items) pages.push(await toJpegPage(item.file, item.crop));
    const bytes = buildPdf(pages);
    const blob = new Blob([bytes], { type: "application/pdf" });
    showResult(blob, "swiftpdf.pdf");
  } catch (err) {
    console.error(err);
    setStatus("Conversion failed. Please try again with different images.", "error");
  } finally {
    convertBtn.disabled = false;
  }
});