// Full-page image workspace (smallpdf-style): grid of pages with
// drag-to-reorder, crop, rotate, delete, add more. Operates directly on the
// strip's items array so the tool page stays in sync.
// openWorkspace(stripInstance) -> resolves when user closes it.

let wsStrip = null;

function openWorkspace(stripInstance) {
  wsStrip = stripInstance;
  try {
    renderWorkspace();
  } catch (err) {
    console.error("workspace:", err);
  }
  showModalOverlay(document.getElementById("workspaceOverlay"));
  document.body.style.overflow = "hidden";
}

function closeWorkspace() {
  hideModalOverlay(document.getElementById("workspaceOverlay"));
  wsStrip = null;
  document.body.style.overflow = "";
}

// Icon-only action buttons are labelled with their own verb rather than a fixed
// string so a reorder can rewrite the position they carry.
const WS_ACTION_VERBS = { crop: "Crop", rotate: "Rotate", delete: "Remove" };

// Everything a cell says about its position - the badge, the cell label and the
// icon-only action labels - is written here and only here. The action labels
// used to be baked in when the cell was built, so a cell renumbered in place
// kept naming the position it was created with.
function renumberCells() {
  const grid = document.getElementById("wsGrid");
  if (!grid) return;
  const noun = window.WS_IMAGE_MODE === true ? "image" : "file";
  const cells = grid.querySelectorAll(".ws-cell");
  const total = wsStrip ? wsStrip.items.length : cells.length;
  cells.forEach((cell, idx) => {
    const position = idx + 1;
    const num = cell.querySelector(".ws-num");
    if (num) num.textContent = position;
    cell.dataset.i = idx;
    const name = (cell._item && cell._item.file && cell._item.file.name) || "Untitled";
    cell.setAttribute("aria-label", `${name}, position ${position} of ${total}`);
    cell.querySelectorAll(".ws-actions button[data-act]").forEach((btn) => {
      const verb = WS_ACTION_VERBS[btn.dataset.act];
      if (verb) btn.setAttribute("aria-label", `${verb} ${noun} ${position}`);
    });
  });
  if (wsStrip) {
    const countEl = document.getElementById("wsCount");
    if (countEl) {
      countEl.textContent =
        wsStrip.items.length + " " + noun + (wsStrip.items.length === 1 ? "" : "s");
    }
  }
}

// The visible "drag to reorder" hint is useless without a pointer, so the
// shortcuts are spelled out once in a live region the cells point at.
function updateWsKeyboardHelp() {
  const help = document.getElementById("wsKeyboardHelp");
  if (!help) return;
  const noun = window.WS_IMAGE_MODE === true ? "image" : "file";
  help.textContent =
    `Use the arrow keys to move the focused ${noun}. Press Home or End to move it to the first or last place.`;
}

// A rebuild destroys the focused node, and a PDF thumbnail or a newly added
// file can trigger one at any moment - including halfway through a keyboard
// reorder - so the focused item is handed back to its replacement.
function restoreWsFocus(item, index, act) {
  if (!item && index < 0) return;
  const grid = document.getElementById("wsGrid");
  const cells = grid ? [...grid.querySelectorAll(".ws-cell")] : [];
  if (!cells.length) return;
  const same = item ? cells.find((c) => c._item === item) : null;
  // The item itself is gone, so focus lands on whatever took its place.
  const cell = same || cells[Math.max(0, Math.min(index, cells.length - 1))];
  if (!cell) return;
  const btn = same && act ? cell.querySelector('.ws-actions button[data-act="' + act + '"]') : null;
  (btn || cell).focus();
}

function renderWorkspace() {
  if (!wsStrip) return;
  const grid = document.getElementById("wsGrid");
  const addCard = document.getElementById("wsAddCard");
  const cameraCard = document.getElementById("wsCameraCard");
  const active = document.activeElement;
  const activeCell = active && active.closest && grid.contains(active) ? active.closest(".ws-cell") : null;
  const focusedItem = activeCell ? activeCell._item : null;
  const focusedIndex = activeCell ? [...grid.querySelectorAll(".ws-cell")].indexOf(activeCell) : -1;
  const focusedAct = activeCell && active.dataset ? active.dataset.act : null;
  grid.innerHTML = "";
  grid.appendChild(addCard); // innerHTML wipe detached it; reattach so cells can be inserted before it
  if (cameraCard) grid.appendChild(cameraCard);

  const imageMode = window.WS_IMAGE_MODE === true;
  wsStrip.items.forEach((item, i) => {
    const cell = document.createElement("div");
    cell.className = "ws-cell";
    cell._item = item;
    cell.dataset.i = i;
    // Focusable so the arrow keys have something to move; a group so the label
    // written by renumberCells() and the shortcut hint are announced on focus.
    // The label text itself is left to renumberCells(), the single source of
    // positions.
    cell.tabIndex = 0;
    cell.setAttribute("role", "group");
    cell.setAttribute("aria-describedby", "wsKeyboardHelp");

    let thumb;
    if (item.url) {
      thumb = document.createElement("img");
      thumb.src = item.url;
      thumb.alt = ""; // The visible filename below provides the accessible label.
      thumb.draggable = false;
    } else {
      thumb = document.createElement("div");
      thumb.className = "ws-fallback";
      thumb.textContent = (item.file.name.split(".").pop() || "PDF").toUpperCase();
    }
    cell.appendChild(thumb);

    const filename = document.createElement("span");
    filename.className = "ws-filename";
    filename.textContent = item.file.name;
    filename.title = item.file.name;
    filename.setAttribute("aria-label", `File: ${item.file.name}`);
    cell.appendChild(filename);

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
          // Found by identity, not by the index this cell was built with: a
          // cell that outlived a reorder would otherwise remove whatever had
          // since taken its place.
          const at = wsStrip.items.indexOf(item);
          if (at === -1) return;
          hideResultBar();
          if (item.url) URL.revokeObjectURL(item.url);
          wsStrip.items.splice(at, 1);
          renderWorkspace();
          wsStrip.render();
        }
      } catch (err) {
        setStatus(err.message || "Could not edit this image.", "error");
      }
    });
    }

    grid.insertBefore(cell, addCard);
  });

  const titleEl = document.getElementById("wsTitle");
  if (titleEl) titleEl.textContent = window.WS_IMAGE_MODE === true ? "Edit images" : "Edit files";
  renumberCells();
  updateWsKeyboardHelp();
  restoreWsFocus(focusedItem, focusedIndex, focusedAct);
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

// The DOM order is the truth after a move; adopt it into the strip only when it
// still describes exactly the items it was built from.
function commitWsOrder(ordered) {
  if (!wsStrip || ordered.length !== wsStrip.items.length) return;
  if (ordered.some((entry) => !wsStrip.items.includes(entry))) return;
  hideResultBar();
  wsStrip.items.splice(0, wsStrip.items.length, ...ordered);
  renumberCells();
  wsStrip.render();
}

// Keyboard equivalent of the drag: slot the cell into place, then hand the fresh
// order to the same commit the pointer path uses. Focus is restored because
// re-inserting a node drops it in every engine.
function moveWsCell(cell, target) {
  const grid = document.getElementById("wsGrid");
  if (!wsStrip || !grid || !cell) return false;
  const item = cell._item;
  const cells = [...grid.querySelectorAll(".ws-cell")];
  const from = cells.indexOf(cell);
  if (from === -1) return false;
  const to = Math.max(0, Math.min(cells.length - 1, target(from)));
  if (to === from) return false;
  // Take the cell out of the list first and then slot it back in at the target
  // index. Inserting relative to cells[to] lands one place out on every move
  // that runs backwards, because the target itself has already shifted along.
  const rest = cells.filter((c) => c !== cell);
  // Cells are inserted before #wsAddCard, so that card marks the end of the list.
  grid.insertBefore(cell, rest[to] || document.getElementById("wsAddCard"));
  commitWsOrder([...grid.querySelectorAll(".ws-cell")].map((c) => c._item));
  // Committing re-renders the grid, so the cell that moved is a different node
  // by now and has to be looked up again before focus is handed to it.
  const moved = [...grid.querySelectorAll(".ws-cell")].find((c) => c._item === item);
  if (moved) moved.focus();
  return true;
}

function wireWsKeyboard(grid) {
  const help = document.createElement("p");
  help.id = "wsKeyboardHelp";
  help.setAttribute("role", "status");
  help.setAttribute("aria-live", "polite");
  // Visually hidden in the only stylesheet-safe way: no class is guaranteed to
  // survive across every page that loads this file.
  help.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
  (grid.parentElement || document.body).appendChild(help);

  grid.addEventListener("keydown", (e) => {
    if (!wsStrip || e.altKey || e.ctrlKey || e.metaKey) return;
    // Only the cell itself reacts. A focused crop/rotate/remove button keeps
    // Enter and Space, and the arrow keys stay with the cell underneath it.
    const cell = e.target.closest(".ws-cell");
    if (!cell || e.target !== cell) return;
    const last = grid.querySelectorAll(".ws-cell").length - 1;
    let to = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i) => i + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i) => i - 1;
    else if (e.key === "Home") to = () => 0;
    else if (e.key === "End") to = () => last;
    // Nothing moved at an edge, so the keys are left to scroll the body as usual.
    if (!to || !moveWsCell(cell, to)) return;
    e.preventDefault();
  });
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
  // A press on the dimmed backdrop closes the workspace on both touch and mouse.
  overlay.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && e.target === overlay && wsStrip) {
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

  // renderWorkspace() wipes and rebuilds the cells but keeps #wsGrid itself, so
  // one call here covers every render; the flag is only a double-init guard.
  const grid = document.getElementById("wsGrid");
  if (grid && !grid._wsSortWired) {
    grid._wsSortWired = true;
    wireTouchSort(grid, ".ws-cell", (cell) => cell._item, commitWsOrder, {
      // Mouse included: the HTML5 path gave no drop preview and needed a second
      // insertion rule kept in sync by hand.
      pointerTypes: ["mouse", "touch", "pen"],
      // .ws-grid wraps and never overflows, so the edges to auto-scroll belong
      // to the scrolling .ws-body around it.
      scrollContainer: document.querySelector("#workspaceOverlay .ws-body"),
    });
    wireWsKeyboard(grid);
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initWorkspaceUI);
else initWorkspaceUI();

