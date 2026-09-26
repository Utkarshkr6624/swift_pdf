// Crop modal: draggable/resizable selection over an image preview.
// Mouse + touch via pointer events. Handles on all corners and edges.
// openCrop(file) -> Promise<{x,y,w,h} in natural pixels | null>

let cropState = null; // { canvas, box, resolve, scale, W, H, r, drag }

function openCrop(file) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("cropOverlay");
    if (!overlay) { resolve(null); return; }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // show the overlay FIRST so the dialog has real dimensions to measure
      showModalOverlay(overlay);
      setupCropUI(img, resolve, file);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus(`Could not open ${file.name}. Try an image format supported by your browser.`, "error");
      resolve(null);
    };
    img.src = url;
  });
}

function setupCropUI(img, resolve, file) {
  const stage = document.getElementById("cropStage");
  const wrap = document.getElementById("cropStageWrap") || stage;
  const canvas = document.getElementById("cropCanvas");
  const box = document.getElementById("cropBox");

  requestAnimationFrame(() => requestAnimationFrame(() => {
    let maxW = wrap.clientWidth - 8;
    let maxH = wrap.clientHeight - 8;
    if (maxW < 120) maxW = window.innerWidth - 24;
    if (maxH < 120) maxH = Math.round(window.innerHeight * 0.72);
    maxW = Math.max(240, maxW);
    maxH = Math.max(240, maxH);
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    const W = Math.max(1, Math.round(img.naturalWidth * scale));
    const H = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.width = W; canvas.height = H;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    const context = canvas.getContext("2d");
    if (!context) {
      hideModalOverlay(document.getElementById("cropOverlay"));
      setStatus("This browser could not prepare the crop preview.", "error");
      cropState = null;
      resolve(null);
      return;
    }
    context.drawImage(img, 0, 0, W, H);

    const r = { x: W * 0.075, y: H * 0.075, w: W * 0.85, h: H * 0.85 };
    cropState = { canvas, box, img, resolve, scale, W, H, r, drag: null, file };
    placeBox();

    stage.onpointerdown = onPointerDown;
    canvas.onpointermove = onPointerMove;
    canvas.onpointerup = onPointerUp;
    canvas.onpointercancel = onPointerUp;
  }));
}

function placeBox() {
  const { box, r } = cropState;
  box.style.left = r.x + "px";
  box.style.top = r.y + "px";
  box.style.width = r.w + "px";
  box.style.height = r.h + "px";
  drawCropPreview();
}

// live zoomed preview of the selected region at native resolution
function drawCropPreview() {
  const pv = document.getElementById("cropPreview");
  if (!pv || !cropState || !cropState.img) return;
  const { img, scale, r } = cropState;
  const boxW = 360, boxH = 260;
  const sx = r.x / scale, sy = r.y / scale;
  const sw = r.w / scale, sh = r.h / scale;
  const s = Math.min(boxW / sw, boxH / sh);
  pv.width = Math.max(1, Math.round(sw * s));
  pv.height = Math.max(1, Math.round(sh * s));
  pv.style.width = pv.width + "px";
  pv.style.height = pv.height + "px";
  const ctx = pv.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, pv.width, pv.height);
  const dimensions = document.getElementById("cropDimensions");
  if (dimensions) dimensions.textContent = `${Math.round(sw)} × ${Math.round(sh)} px`;
}

function stagePos(e) {
  const rect = cropState.canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(cropState.W, (e.clientX - rect.left) * (cropState.W / rect.width))),
    y: Math.max(0, Math.min(cropState.H, (e.clientY - rect.top) * (cropState.H / rect.height))),
  };
}

function clampRect(r) {
  const MIN = 32;
  r.w = Math.max(MIN, Math.min(r.w, cropState.W - r.x));
  r.h = Math.max(MIN, Math.min(r.h, cropState.H - r.y));
  r.x = Math.max(0, Math.min(r.x, cropState.W - MIN));
  r.y = Math.max(0, Math.min(r.y, cropState.H - MIN));
  return r;
}

function onPointerDown(e) {
  if (!cropState) return;
  const handle = e.target.closest("[data-handle]");
  const onBox = e.target.closest(".crop-box");
  const mode = handle ? handle.dataset.handle : (onBox ? "move" : "new");
  const p = stagePos(e);
  cropState.drag = { mode, startX: p.x, startY: p.y, orig: { ...cropState.r } };
  if (mode === "new") cropState.r = clampRect({ x: p.x, y: p.y, w: MIN_SIZE(), h: MIN_SIZE() });
  try { cropState.canvas.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
}

const MIN_SIZE = () => 32;

function onPointerMove(e) {
  if (!cropState || !cropState.drag) return;
  const drag = cropState.drag;
  const orig = drag.orig;
  const p = stagePos(e);
  const dx = p.x - drag.startX, dy = p.y - drag.startY;
  let r = { ...orig };

  switch (drag.mode) {
    case "move": {
      r.x = orig.x + dx;
      r.y = orig.y + dy;
      r.x = Math.max(0, Math.min(r.x, cropState.W - orig.w));
      r.y = Math.max(0, Math.min(r.y, cropState.H - orig.h));
      break;
    }
    case "new": {
      r = {
        x: Math.min(drag.startX, p.x),
        y: Math.min(drag.startY, p.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      };
      break;
    }
    case "e": r.w = orig.w + dx; break;
    case "w": r.x = orig.x + dx; r.w = orig.w - dx; break;
    case "s": r.h = orig.h + dy; break;
    case "n": r.y = orig.y + dy; r.h = orig.h - dy; break;
    case "se": r.w = orig.w + dx; r.h = orig.h + dy; break;
    case "sw": r.x = orig.x + dx; r.w = orig.w - dx; r.h = orig.h + dy; break;
    case "ne": r.y = orig.y + dy; r.h = orig.h - dy; r.w = orig.w + dx; break;
    case "nw": r.x = orig.x + dx; r.y = orig.y + dy; r.w = orig.w - dx; r.h = orig.h - dy; break;
  }

  cropState.r = clampRect(r);
  placeBox();
}

function onPointerUp() {
  if (cropState) cropState.drag = null;
}

function saveCroppedImage() {
  if (!cropState || !cropState.img) return;
  const { img, scale, r, file } = cropState;
  const x = Math.max(0, Math.round(r.x / scale));
  const y = Math.max(0, Math.round(r.y / scale));
  const w = Math.max(1, Math.round(r.w / scale));
  const h = Math.max(1, Math.round(r.h / scale));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const context = out.getContext("2d", { alpha: false });
  if (!context) {
    setStatus("This browser could not prepare the cropped image.", "error");
    return;
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, w, h);
  context.drawImage(img, x, y, w, h, 0, 0, w, h);
  const base = (file && file.name ? file.name.replace(/\.[^.]+$/, "") : "image") + "-cropped.jpg";
  out.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = base;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/jpeg", 0.92);
}

function applyCrop() {
  if (!cropState) return;
  const { resolve, scale, r } = cropState;
  const natural = {
    x: Math.round(r.x / scale),
    y: Math.round(r.y / scale),
    w: Math.round(r.w / scale),
    h: Math.round(r.h / scale),
  };
  closeCrop();
  resolve(natural);
}

function resetCrop() {
  if (!cropState) return;
  cropState.r = { x: cropState.W * 0.075, y: cropState.H * 0.075, w: cropState.W * 0.85, h: cropState.H * 0.85 };
  placeBox();
}

function cancelCrop() {
  if (!cropState) return;
  const { resolve } = cropState;
  closeCrop();
  resolve(null);
}

function closeCrop() {
  hideModalOverlay(document.getElementById("cropOverlay"));
  cropState = null;
}

// Pressing outside the crop dialog or Escape cancels the crop (mouse and touch).
document.addEventListener("DOMContentLoaded", () => {
  const overlay = document.getElementById("cropOverlay");
  if (!overlay) return;
  overlay.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && e.target === overlay && cropState) cancelCrop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cropState) cancelCrop();
  });
});
