// Full-page image workspace (smallpdf-style): grid of pages with
// drag-to-reorder, crop, rotate, delete, add more. Operates directly on the
// strip's items array so the tool page stays in sync.
// openWorkspace(stripInstance) -> resolves when user closes it.

let wsStrip = null;
let wsDragEl = null;

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
    document.getElementById("wsCount").textContent =
      wsStrip.items.length + " image" + (wsStrip.items.length === 1 ? "" : "s");
  }
}

function renderWorkspace() {
  if (!wsStrip) return;
  const grid = document.getElementById("wsGrid");
  const addCard = document.getElementById("wsAddCard");
  grid.innerHTML = "";
  grid.appendChild(addCard); // innerHTML wipe detached it; reattach so cells can be inserted before it

  const imageMode = window.WS_IMAGE_MODE === true;
  wsStrip.items.forEach((item, i) => {
    const cell = document.createElement("div");
    cell.className = "ws-cell";
    // drag & click actions are for image editing only; PDF tools show a read-only grid
    cell.draggable = imageMode;
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
      if (act === "crop") {
        const rect = await openCrop(item.file);
        if (rect) {
          item.crop = rect;
          await refreshWsThumb(item, rect);
        }
      } else if (act === "rotate") {
        await rotateWsItem(item);
      } else if (act === "delete") {
        if (item.url) URL.revokeObjectURL(item.url);
        wsStrip.items.splice(i, 1);
        renderWorkspace();
        wsStrip.render();
      }
    });
    }

    // drag & drop reorder (image editing only)
    if (!imageMode) { /* skip drag listeners for read-only grids */ }
    cell.addEventListener("dragstart", (e) => {
      wsDragEl = i;
      cell.classList.add("ws-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", item.file.name); } catch {}
    });
    cell.addEventListener("dragend", () => {
      wsDragEl = null;
      cell.classList.remove("ws-dragging");
    });
    cell.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (wsDragEl === null) return;
      const grid = document.getElementById("wsGrid");
      const cells = [...grid.querySelectorAll(".ws-cell")];
      const targetIdx = cells.indexOf(cell);
      if (targetIdx === -1 || targetIdx === wsDragEl) return;
      const moving = cells[wsDragEl];
      if (targetIdx < wsDragEl) grid.insertBefore(moving, cell);
      else grid.insertBefore(moving, cell.nextSibling);
      const [moved] = wsStrip.items.splice(wsDragEl, 1);
      wsStrip.items.splice(targetIdx, 0, moved);
      wsDragEl = targetIdx;
      renumberCells();
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
  const canvas = document.createElement("canvas");
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = res; img.src = URL.createObjectURL(item.file); });
  const maxSide = 360;
  const s = Math.min(1, maxSide / Math.max(rect.w, rect.h));
  canvas.width = Math.max(1, Math.round(rect.w * s));
  canvas.height = Math.max(1, Math.round(rect.h * s));
  canvas.getContext("2d").drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  await new Promise((res) => canvas.toBlob((blob) => {
    if (!blob) return res();
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = URL.createObjectURL(blob);
    res();
  }, "image/jpeg", 0.85));
  renderWorkspace();
  wsStrip.render();
}

async function rotateWsItem(item) {
  const canvas = document.createElement("canvas");
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = URL.createObjectURL(item.file); });
  URL.revokeObjectURL(img.src);
  const crop = item.crop;
  const sx = crop ? crop.x : 0, sy = crop ? crop.y : 0;
  const sw = crop ? crop.w : img.naturalWidth, sh = crop ? crop.h : img.naturalHeight;
  canvas.width = sh; canvas.height = sw;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  item.crop = null; // rotation is baked into the new thumbnail/preview
  await new Promise((res) => canvas.toBlob(async (blob) => {
    item.file = new File([blob], item.file.name.replace(/\.jpe?g$/i, "") + "-rotated.jpg", { type: "image/jpeg" });
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = URL.createObjectURL(blob);
    res();
  }, "image/jpeg", 0.92));
  renderWorkspace();
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

