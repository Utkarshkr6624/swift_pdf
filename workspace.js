// Full-page image workspace (smallpdf-style): grid of pages with
// drag-to-reorder, crop, rotate, delete, add more. Operates directly on the
// strip's items array so the tool page stays in sync.
// openWorkspace(stripInstance) -> resolves when user closes it.

let wsStrip = null;
let wsDragItem = null;
let wsLastDragTarget = null;
let wsDragOrder = null;

function openWorkspace(stripInstance) {
  wsStrip = stripInstance;
  try {
    renderWorkspace();
  } catch (err) {
    console.error("workspace:", err);
  }
  document.getElementById("workspaceOverlay").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeWorkspace() {
  document.getElementById("workspaceOverlay").hidden = true;
  wsStrip = null;
  document.body.style.overflow = "";
}

function renumberCells() {
  const grid = document.getElementById("wsGrid");
  grid.querySelectorAll(".ws-cell").forEach((c, idx) => {
    const num = c.querySelector(".ws-num");
    if (num) num.textContent = idx + 1;
  });
  if (wsStrip) {
    const noun = window.WS_IMAGE_MODE === true ? "image" : "file";
    document.getElementById("wsCount").textContent =
      wsStrip.items.length + " " + noun + (wsStrip.items.length === 1 ? "" : "s");
  }
}

function renderWorkspace() {
  if (!wsStrip) return;
  const grid = document.getElementById("wsGrid");
  const addCard = document.getElementById("wsAddCard");
  const cameraCard = document.getElementById("wsCameraCard");
  grid.innerHTML = "";
  grid.appendChild(addCard); // innerHTML wipe detached it; reattach so cells can be inserted before it
  if (cameraCard) grid.appendChild(cameraCard);

  const imageMode = window.WS_IMAGE_MODE === true;
  wsStrip.items.forEach((item, i) => {
    const cell = document.createElement("div");
    cell.className = "ws-cell";
    // Both image and PDF editors can reorder files.
    cell.draggable = true;
    cell._item = item;
    cell.dataset.i = i;

    let thumb;
    if (item.url) {
      thumb = document.createElement("img");
      thumb.src = item.url;
      thumb.alt = item.file.name;
      thumb.draggable = false;
    } else {
      thumb = document.createElement("div");
      thumb.className = "ws-fallback";
      thumb.textContent = (item.file.name.split(".").pop() || "PDF").toUpperCase();
    }
    cell.appendChild(thumb);

    const num = document.createElement("span");
    num.className = "ws-num";
    num.textContent = i + 1;
    cell.appendChild(num);

    const actions = document.createElement("div");
    actions.className = "ws-actions";
    let btns = "";
    if (imageMode) {
      btns += '<button type="button" data-act="crop" title="Crop">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg></button>' +
        '<button type="button" data-act="rotate" title="Rotate">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M21 8a9 9 0 1 0 2.4 6"/></svg></button>';
    }
    if (imageMode) {
      btns += '<button type="button" data-act="delete" class="ws-del" title="Remove">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>';
    }
    actions.innerHTML = btns;
    if (imageMode) {
      cell.appendChild(actions);

      actions.addEventListener("click", async (e) => {
      const act = e.target.closest("button") && e.target.closest("button").dataset.act;
      if (!act) return;
      e.stopPropagation();
      try {
        if (act === "crop") {
          const rect = await openCrop(item.file);
          if (rect) {
            item.crop = rect;
            await refreshWsThumb(item, rect);
          }
        } else if (act === "rotate") {
          await rotateWsItem(item);
        } else if (act === "delete") {
          hideResultBar();
          if (item.url) URL.revokeObjectURL(item.url);
          wsStrip.items.splice(i, 1);
          renderWorkspace();
          wsStrip.render();
        }
      } catch (err) {
        setStatus(err.message || "Could not edit this image.", "error");
      }
    });
    }

    // Files can be reordered in the editor for both image and PDF tools.
    cell.addEventListener("dragstart", (e) => {
      wsDragItem = item;
      wsDragOrder = [...wsStrip.items];
      wsLastDragTarget = null;
      cell.classList.add("ws-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.file.name);
    });
    cell.addEventListener("dragend", () => {
      cell.classList.remove("ws-dragging");
      const ordered = [...grid.querySelectorAll(".ws-cell")].map((el) => el._item);
      if (wsStrip && ordered.length === wsStrip.items.length) {
        const changed = wsDragOrder && ordered.some((entry, index) => entry !== wsDragOrder[index]);
        if (changed) hideResultBar();
        wsStrip.items.splice(0, wsStrip.items.length, ...ordered);
        renumberCells();
        wsStrip.render();
      }
      wsDragItem = null;
      wsLastDragTarget = null;
      wsDragOrder = null;
    });
    cell.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!wsDragItem || item === wsDragItem) return;
      const rect = cell.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2 ||
        (Math.abs(e.clientY - (rect.top + rect.height / 2)) < rect.height / 3 && e.clientX > rect.left + rect.width / 2);
      if (wsLastDragTarget && wsLastDragTarget.item === item && wsLastDragTarget.after === after) return;
      const moving = [...grid.querySelectorAll(".ws-cell")].find((el) => el._item === wsDragItem);
      if (!moving) return;
      const reference = after ? cell.nextElementSibling : cell;
      if (reference !== moving && reference !== moving.nextElementSibling) grid.insertBefore(moving, reference || document.getElementById("wsAddCard"));
      wsLastDragTarget = { item, after };
    });

    grid.insertBefore(cell, addCard);
  });

  const isImages = window.WS_IMAGE_MODE === true;
  const titleEl = document.getElementById("wsTitle");
  if (titleEl) titleEl.textContent = isImages ? "Edit images" : "Edit files";
  const noun = isImages ? "image" : "file";
  const countEl = document.getElementById("wsCount");
  if (countEl) countEl.textContent =
    wsStrip.items.length + " " + noun + (wsStrip.items.length === 1 ? "" : "s");
  document.body.style.overflow = "hidden";
}

async function refreshWsThumb(item, rect) {
  hideResultBar();
  const canvas = document.createElement("canvas");
  const img = new Image();
  const src = URL.createObjectURL(item.file);
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(`Could not read ${item.file.name}.`)); img.src = src; });
    const maxSide = 360;
    const s = Math.min(1, maxSide / Math.max(rect.w, rect.h));
    canvas.width = Math.max(1, Math.round(rect.w * s));
    canvas.height = Math.max(1, Math.round(rect.h * s));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("This browser could not prepare the cropped preview.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res, rej) => canvas.toBlob((result) => result ? res(result) : rej(new Error("Could not save the cropped preview.")), "image/jpeg", 0.85));
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = URL.createObjectURL(blob);
  } finally {
    URL.revokeObjectURL(src);
    canvas.width = 0;
    canvas.height = 0;
  }
  wsStrip.render();
}

async function rotateWsItem(item) {
  hideResultBar();
  const canvas = document.createElement("canvas");
  const img = new Image();
  const src = URL.createObjectURL(item.file);
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(`Could not read ${item.file.name}.`)); img.src = src; });
    const crop = item.crop;
    const sx = crop ? crop.x : 0, sy = crop ? crop.y : 0;
    const sw = crop ? crop.w : img.naturalWidth, sh = crop ? crop.h : img.naturalHeight;
    canvas.width = sh; canvas.height = sw;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser could not prepare the rotated image.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
    const blob = await new Promise((res, rej) => canvas.toBlob((result) => result ? res(result) : rej(new Error("Could not save the rotated image.")), "image/jpeg", 0.92));
    const baseName = item.file.name.replace(/\.[^.]+$/, "");
    item.file = new File([blob], `${baseName}-rotated.jpg`, { type: "image/jpeg" });
    item.crop = null; // Rotation is baked into the replacement JPEG.
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = URL.createObjectURL(blob);
  } finally {
    URL.revokeObjectURL(src);
    canvas.width = 0;
    canvas.height = 0;
  }
  wsStrip.render();
}

// hook up add-more inside the workspace
// (runs immediately — scripts load at end of body, after DOMContentLoaded)
function initWorkspaceUI() {
  const addCard = document.getElementById("wsAddCard");
  const doneBtn = document.getElementById("wsDoneBtn");
  const overlay = document.getElementById("workspaceOverlay");
  if (!overlay) return;

  if (addCard) addCard.addEventListener("click", () => document.getElementById("fileInput").click());
  if (doneBtn) doneBtn.addEventListener("click", () => {
    if (wsStrip) wsStrip.render();
    closeWorkspace();
  });
  overlay.addEventListener("dragover", (e) => e.preventDefault());
  overlay.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length && wsStrip) wsStrip.addFiles(e.dataTransfer.files);
  });
  // click outside the workspace box closes it
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && wsStrip) {
      wsStrip.render();
      closeWorkspace();
    }
  });
  // Escape closes it too
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden && wsStrip) {
      wsStrip.render();
      closeWorkspace();
    }
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initWorkspaceUI);
else initWorkspaceUI();

