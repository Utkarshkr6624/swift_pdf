const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const pageGrid = document.getElementById("pageGrid");
const pageScroller = document.getElementById("pageScroller");
const pageScrollActions = document.getElementById("pageScrollActions");
const pageScrollLeft = document.getElementById("pageScrollLeft");
const pageScrollRight = document.getElementById("pageScrollRight");
const toolbar = document.getElementById("organizerToolbar");
const selectionCount = document.getElementById("selectionCount");
const extractBtn = document.getElementById("extractBtn");
const splitBtn = document.getElementById("splitBtn");
const saveBtn = document.getElementById("saveBtn");
const editPagesBtn = document.getElementById("editPagesBtn");
const editorOverlay = document.getElementById("organizerWorkspace");
const editorGrid = document.getElementById("editorGrid");
const imageInput = document.getElementById("imageInput");
const replaceImageInput = document.getElementById("replaceImageInput");
let sourceFile = null;
let sourceBytes = null;
let sourcePassword = null;
let pageItems = [];
let dragItem = null;
let lastTarget = null;
let busy = false;
let replaceTarget = null;
let loadGeneration = 0;

const pageScrollAmount = () => Math.max(240, pageGrid.clientWidth * 0.72);
function updatePageScrollButtons() {
  const max = pageGrid.scrollWidth - pageGrid.clientWidth;
  pageScrollActions.style.display = max > 4 ? "flex" : "none";
  pageScrollLeft.disabled = pageGrid.scrollLeft <= 4;
  pageScrollRight.disabled = pageGrid.scrollLeft >= max - 4;
}
pageScrollLeft.addEventListener("click", () => pageGrid.scrollBy({ left: -pageScrollAmount(), behavior: "smooth" }));
pageScrollRight.addEventListener("click", () => pageGrid.scrollBy({ left: pageScrollAmount(), behavior: "smooth" }));
pageGrid.addEventListener("scroll", updatePageScrollButtons, { passive: true });
window.addEventListener("resize", updatePageScrollButtons);

// HTML drag-and-drop is unavailable on touch screens. Touch movement reorders
// the page directly; the visible arrow controls scroll the page rail.
function bindTouchReorder(container, selector, itemProperty, onCommit) {
  let state = null;
  container.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1 || event.target.closest("button, input, label")) return;
    const node = event.target.closest(selector);
    if (!node) return;
    state = {
      node,
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      order: [...container.querySelectorAll(selector)].map((entry) => entry[itemProperty]),
      active: false,
    };
  }, { passive: true });

  container.addEventListener("touchmove", (event) => {
    if (!state || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const distance = Math.hypot(touch.clientX - state.x, touch.clientY - state.y);
    if (!state.active) {
      const dx = Math.abs(touch.clientX - state.x);
      const dy = Math.abs(touch.clientY - state.y);
      if (distance < 6) {
        if (container === pageGrid && dx > dy && dx > 4) event.preventDefault();
        return;
      }
      state.active = true;
      state.node.classList.add("touch-dragging");
    }
    event.preventDefault();
    if (container === pageGrid) {
      const bounds = container.getBoundingClientRect();
      if (touch.clientX < bounds.left + 36) container.scrollLeft -= 18;
      else if (touch.clientX > bounds.right - 36) container.scrollLeft += 18;
    }
    const target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest(selector);
    if (!target || target === state.node || !container.contains(target)) return;
    const rect = target.getBoundingClientRect();
    const dx = touch.clientX - (rect.left + rect.width / 2);
    const dy = touch.clientY - (rect.top + rect.height / 2);
    const after = Math.abs(dx) > Math.abs(dy) ? dx > 0 : dy > 0;
    const reference = after ? target.nextElementSibling : target;
    if (reference !== state.node && reference !== state.node.nextElementSibling) {
      container.insertBefore(state.node, reference || null);
    }
  }, { passive: false });

  const finish = () => {
    if (!state) return;
    const current = state;
    state = null;
    current.node.classList.remove("touch-dragging");
    if (!current.active) return;
    const ordered = [...container.querySelectorAll(selector)].map((entry) => entry[itemProperty]);
    const changed = ordered.some((item, index) => item !== current.order[index]);
    if (changed) onCommit(ordered);
  };
  container.addEventListener("touchend", finish, { passive: true });
  container.addEventListener("touchcancel", finish, { passive: true });
}

bindTouchReorder(pageGrid, ".page-card", "_pageItem", (ordered) => {
  pageItems = ordered;
  pageGrid.querySelectorAll(".page-card-number").forEach((node, index) => { node.textContent = `Page ${index + 1}`; });
  hideResultBar();
  updateSelection();
  setStatus("Page order updated. Save the PDF when you are ready.", "success");
});
bindTouchReorder(editorGrid, ".organizer-editor-cell", "_item", (ordered) => {
  pageItems = ordered;
  editorGrid.querySelectorAll(".ws-num").forEach((node, index) => { node.textContent = String(index + 1); });
  hideResultBar();
  const cards = new Map([...pageGrid.querySelectorAll(".page-card")].map((card) => [card._pageItem, card]));
  pageItems.forEach((item, index) => {
    const card = cards.get(item);
    if (!card) return;
    card.querySelector(".page-card-number").textContent = `Page ${index + 1}`;
    pageGrid.appendChild(card);
  });
  updateSelection();
  setStatus("Page order updated. Save the PDF when you are ready.", "success");
});

wireDropzone(dropzone, fileInput, (files) => loadFile(Array.from(files)[0]));
fileInput.addEventListener("change", () => { fileInput.value = ""; });
editPagesBtn.addEventListener("click", () => { renderEditor(); showModalOverlay(editorOverlay); document.body.style.overflow = "hidden"; });
document.getElementById("editorDoneBtn").addEventListener("click", closeEditor);
document.getElementById("addImagesBtn").addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", () => { addImages(Array.from(imageInput.files || [])); imageInput.value = ""; });
replaceImageInput.addEventListener("change", () => {
  const file = Array.from(replaceImageInput.files || [])[0];
  if (file && replaceTarget && isBrowserImage(file)) {
    if (replaceTarget.thumb) URL.revokeObjectURL(replaceTarget.thumb);
    replaceTarget.file = file;
    replaceTarget.crop = null;
    replaceTarget.rotation = 0;
    replaceTarget.thumb = URL.createObjectURL(file);
    hideResultBar();
    renderEditor(); drawPageCards();
    setStatus(`Replaced image with ${file.name}.`, "success");
  }
  replaceTarget = null;
  replaceImageInput.value = "";
});
editorOverlay.addEventListener("pointerdown", (event) => {
  if (event.button === 0 && event.target === editorOverlay) closeEditor();
});
editorOverlay.addEventListener("dragover", (event) => event.preventDefault());
editorOverlay.addEventListener("drop", (event) => {
  if (event.dataTransfer.files.length) { event.preventDefault(); addImages(Array.from(event.dataTransfer.files)); }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !editorOverlay.hidden && document.getElementById("cropOverlay").hidden) closeEditor();
});

async function loadFile(file) {
  if (!file || !(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
    setStatus("Choose a PDF file to organize.", "error");
    return;
  }
  clearPages();
  const generation = loadGeneration;
  sourceFile = file;
  sourcePassword = null;
  hideResultBar();
  setStatus("Reading PDF pages…");
  try {
    sourceBytes = await file.arrayBuffer();
    const pdfjs = await loadPdfJs();
    const pdf = await openPdf(pdfjs, sourceBytes, file.name);
    if (generation !== loadGeneration) { await pdf.destroy(); return; }
    pageItems = Array.from({ length: pdf.numPages }, (_, index) => ({ type: "pdf", index, rotation: 0, cropScale: 1, selected: false, thumb: null }));
    document.getElementById("documentName").textContent = file.name;
    document.getElementById("organizerHeading").hidden = false;
    pageScroller.hidden = false;
    try { await renderPages(pdf, generation); }
    finally { await pdf.destroy(); }
    if (generation !== loadGeneration) return;
    toolbar.hidden = false;
    setStatus(`${pageItems.length} page${pageItems.length === 1 ? "" : "s"} loaded.`, "success");
    updateSelection();
  } catch (err) {
    if (generation !== loadGeneration) return;
    clearPages();
    setStatus(explainProcessingError(err, "Opening this PDF", file.name), "error");
  }
}

function closeEditor() {
  hideModalOverlay(editorOverlay);
  document.body.style.overflow = "";
  drawPageCards();
}

async function addImages(files) {
  if (busy) return;
  const images = files.filter(isBrowserImage);
  if (!images.length) { setStatus("Choose one or more image files to add as PDF pages.", "error"); return; }
  setStatus(`Adding ${images.length} image${images.length === 1 ? "" : "s"}…`);
  for (const file of images) {
    const item = { type: "image", file, rotation: 0, crop: null, selected: false, thumb: URL.createObjectURL(file) };
    pageItems.push(item);
  }
  hideResultBar();
  renderEditor();
  drawPageCards();
  setStatus(`${images.length} image${images.length === 1 ? "" : "s"} added as page${images.length === 1 ? "" : "s"}.`, "success");
}

async function openPdf(pdfjs, bytes, filename) {
  const load = (password) => {
    const options = { data: new Uint8Array(bytes.slice(0)) };
    if (password !== undefined) options.password = password;
    return pdfjs.getDocument(options).promise;
  };
  if (sourcePassword !== null) {
    try { return await load(sourcePassword); }
    catch (err) {
      if (!err || err.name !== "PasswordException") throw err;
      sourcePassword = null;
    }
  }
  try { return await load(); }
  catch (err) {
    if (!err || err.name !== "PasswordException") throw err;
    const password = window.prompt(`Enter the open password for ${filename}:`);
    if (password === null) throw new Error("This PDF needs its open password before it can be organized.");
    try {
      const pdf = await load(password);
      sourcePassword = password;
      return pdf;
    } catch (passwordError) {
      if (passwordError && passwordError.name === "PasswordException") {
        throw new Error(`The password was not accepted for ${filename}. Enter the correct open password and try again.`);
      }
      throw passwordError;
    }
  }
}

function isBrowserImage(file) {
  return /^image\//i.test(file.type || "") || /\.(jpe?g|jpe|jfif|png|webp|gif|bmp|dib|avif|apng|tif|tiff|ico|svg|heic|heif)$/i.test(file.name);
}

async function renderPages(pdf, generation) {
  for (let index = 0; index < pageItems.length; index++) {
    if (generation !== loadGeneration) return;
    const item = pageItems[index];
    const page = await pdf.getPage(item.index + 1);
    let canvas = null;
    try {
      const base = page.getViewport({ scale: 1, rotation: page.rotate + item.rotation });
      const scale = Math.min(1, 180 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale, rotation: page.rotate + item.rotation });
      canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare page previews.");
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise((resolve, reject) => canvas.toBlob((imageBlob) => imageBlob ? resolve(imageBlob) : reject(new Error("Could not create page preview.")), "image/jpeg", 0.82));
      item.thumb = URL.createObjectURL(blob);
    } finally {
      page.cleanup();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
    if (index % 10 === 0 || index === pageItems.length - 1) {
      setStatus(`Preparing page previews… ${index + 1} of ${pageItems.length}`);
    }
  }
  if (generation !== loadGeneration) return;
  drawPageCards();
}

function drawPageCards() {
  pageGrid.replaceChildren();
  pageItems.forEach((item, position) => {
    const card = document.createElement("article");
    card.className = "page-card";
    card.draggable = true;
    card._pageItem = item;
    const imageWrap = document.createElement("div");
    imageWrap.className = "page-card-preview";
    const image = document.createElement("img");
    image.src = item.thumb;
    image.alt = item.type === "image" ? `Preview of added image ${item.file.name}` : `Preview of PDF page ${item.index + 1}`;
    image.draggable = false;
    imageWrap.appendChild(image);
    const number = document.createElement("span");
    number.className = "page-card-number";
    number.textContent = `Page ${position + 1}`;
    const select = document.createElement("label");
    select.className = "page-select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.selected;
    checkbox.addEventListener("change", () => { item.selected = checkbox.checked; updateSelection(); });
    select.append(checkbox, document.createTextNode(" Extract"));
    const actions = document.createElement("div");
    actions.className = "page-card-actions";
    actions.appendChild(makeSmallButton("Crop", `Crop page ${position + 1}`, () => applyCropToItem(item)));
    if (item.type !== "image") {
      const rotate = makeSmallButton("↻", `Rotate page ${position + 1}`, async () => {
        item.rotation = (item.rotation + 90) % 360;
        if (item.crop) { item.crop = null; item.cropScale = 1; }
        setStatus(`Updating page ${position + 1} preview…`);
        try { await replaceThumb(item); drawPageCards(); hideResultBar(); }
        catch (err) { setStatus(explainProcessingError(err, "Updating this page preview", sourceFile && sourceFile.name), "error"); }
      });
      const remove = makeSmallButton("×", `Remove page ${position + 1}`, () => removePage(item));
      actions.append(rotate, remove);
    }
    card.append(imageWrap, number, select, actions);
    card.addEventListener("dragstart", (event) => {
      dragItem = item;
      lastTarget = null;
      card.classList.add("page-card-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(position + 1));
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("page-card-dragging");
      pageItems = [...pageGrid.querySelectorAll(".page-card")].map((node) => node._pageItem);
      pageGrid.querySelectorAll(".page-card-number").forEach((node, index) => { node.textContent = `Page ${index + 1}`; });
      if (dragItem) hideResultBar();
      dragItem = null;
      lastTarget = null;
    });
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragItem || dragItem === item) return;
      const rect = card.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      if (lastTarget && lastTarget.item === item && lastTarget.after === after) return;
      const moving = [...pageGrid.querySelectorAll(".page-card")].find((node) => node._pageItem === dragItem);
      const reference = after ? card.nextElementSibling : card;
      if (moving && reference !== moving && reference !== moving.nextElementSibling) pageGrid.insertBefore(moving, reference);
      lastTarget = { item, after };
    });
    pageGrid.appendChild(card);
  });
  document.getElementById("pageCount").textContent = `${pageItems.length} total page${pageItems.length === 1 ? "" : "s"}`;
  requestAnimationFrame(updatePageScrollButtons);
  saveBtn.disabled = busy || pageItems.length === 0;
  splitBtn.disabled = busy || pageItems.length === 0;
  updateSelection();
}

function renderEditor() {
  editorGrid.replaceChildren();
  pageItems.forEach((item, index) => {
    const cell = document.createElement("article");
    cell.className = "ws-cell organizer-editor-cell";
    cell.draggable = true;
    cell._item = item;
    const image = document.createElement("img");
    image.src = item.thumb;
    image.alt = item.type === "image" ? `Added image ${item.file.name}` : `PDF page ${item.index + 1}`;
    image.draggable = false;
    cell.appendChild(image);
    const number = document.createElement("span");
    number.className = "ws-num";
    number.textContent = String(index + 1);
    cell.appendChild(number);
    const actions = document.createElement("div");
    actions.className = "ws-actions";
    addEditorAction(actions, "Crop", `Crop page ${index + 1}`, () => applyCropToItem(item));
    if (item.type === "image") {
      addEditorAction(actions, "Replace", `Replace ${item.file.name}`, () => { replaceTarget = item; replaceImageInput.click(); });
    }
    addEditorAction(actions, "↻", `Rotate page ${index + 1}`, async () => {
      item.rotation = (item.rotation + 90) % 360;
      if (item.type === "pdf" && item.crop) { item.crop = null; item.cropScale = 1; setStatus("Rotation changed. Crop this page again if needed."); }
      try { await replaceThumb(item); renderEditor(); drawPageCards(); hideResultBar(); }
      catch (err) { setStatus(explainProcessingError(err, "Updating this page preview", sourceFile && sourceFile.name), "error"); }
    });
    addEditorAction(actions, "×", `Delete page ${index + 1}`, () => removePage(item));
    cell.appendChild(actions);
    cell.addEventListener("dragstart", (event) => {
      dragItem = item;
      lastTarget = null;
      cell.classList.add("ws-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    });
    cell.addEventListener("dragend", () => {
      cell.classList.remove("ws-dragging");
      pageItems = [...editorGrid.querySelectorAll(".ws-cell")].map((node) => node._item);
      editorGrid.querySelectorAll(".ws-num").forEach((node, i) => { node.textContent = String(i + 1); });
      if (dragItem) hideResultBar();
      dragItem = null; lastTarget = null;
      drawPageCards();
    });
    cell.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragItem || dragItem === item) return;
      const rect = cell.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      if (lastTarget && lastTarget.item === item && lastTarget.after === after) return;
      const moving = [...editorGrid.querySelectorAll(".ws-cell")].find((node) => node._item === dragItem);
      const reference = after ? cell.nextElementSibling : cell;
      if (moving && reference !== moving && reference !== moving.nextElementSibling) editorGrid.insertBefore(moving, reference);
      lastTarget = { item, after };
    });
    editorGrid.appendChild(cell);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "ws-add";
  add.innerHTML = '<span class="ws-add-plus">+</span>Add images';
  add.addEventListener("click", () => imageInput.click());
  editorGrid.appendChild(add);
  document.getElementById("editorCount").textContent = `${pageItems.length} page${pageItems.length === 1 ? "" : "s"} · drag to reorder. On phones, press and hold a page to drag it.`;
}

function addEditorAction(container, label, title, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", (event) => { event.stopPropagation(); action(); });
  container.appendChild(button);
}

function removePage(item) {
  if (pageItems.length <= 1) { setStatus("Keep at least one page in the organized PDF.", "error"); return; }
  if (item.thumb) URL.revokeObjectURL(item.thumb);
  pageItems.splice(pageItems.indexOf(item), 1);
  hideResultBar();
  renderEditor(); drawPageCards(); updateSelection();
}

async function applyCropToItem(item) {
  try {
    const selection = await cropPage(item);
    if (!selection) return;
    item.crop = selection.rect;
    item.cropScale = selection.scale;
    await replaceThumb(item);
    hideResultBar();
    renderEditor();
    drawPageCards();
  } catch (err) {
    setStatus(explainProcessingError(err, "Cropping this page", sourceFile && sourceFile.name), "error");
  }
}

function makeSmallButton(text, label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "page-action-btn";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", action);
  return button;
}

async function replaceThumb(item) {
  if (item.type === "image") {
    const full = await makeImageCanvas(item);
    const scale = Math.min(1, 180 / Math.max(full.width, full.height));
    const thumb = document.createElement("canvas");
    thumb.width = Math.max(1, Math.round(full.width * scale));
    thumb.height = Math.max(1, Math.round(full.height * scale));
    thumb.getContext("2d").drawImage(full, 0, 0, thumb.width, thumb.height);
    const blob = await canvasBlob(thumb, "image/jpeg", 0.82);
    if (item.thumb) URL.revokeObjectURL(item.thumb);
    item.thumb = URL.createObjectURL(blob);
    full.width = 0; full.height = 0; thumb.width = 0; thumb.height = 0;
    return;
  }
  const dimensions = await getPdfPageSize(item);
  const scale = Math.min(1, 180 / Math.max(dimensions.width, dimensions.height));
  const canvas = await renderPdfPageCanvas(item, scale);
  let previewCanvas = canvas;
  if (item.crop) {
    const crop = item.crop;
    const ratio = scale / (item.cropScale || 1);
    previewCanvas = document.createElement("canvas");
    previewCanvas.width = Math.max(1, Math.round(crop.w * ratio));
    previewCanvas.height = Math.max(1, Math.round(crop.h * ratio));
    previewCanvas.getContext("2d").drawImage(canvas, crop.x * ratio, crop.y * ratio, crop.w * ratio, crop.h * ratio, 0, 0, previewCanvas.width, previewCanvas.height);
  }
  const url = URL.createObjectURL(await canvasBlob(previewCanvas, "image/jpeg", 0.82));
  if (item.thumb) URL.revokeObjectURL(item.thumb);
  item.thumb = url;
  canvas.width = 0; canvas.height = 0;
  if (previewCanvas !== canvas) { previewCanvas.width = 0; previewCanvas.height = 0; }
}

async function getPdfPageSize(item) {
  const pdfjs = await loadPdfJs();
  const pdf = await openPdf(pdfjs, sourceBytes, sourceFile.name);
  try {
    const page = await pdf.getPage(item.index + 1);
    const rotation = ((page.rotate + item.rotation) % 360 + 360) % 360;
    const viewport = page.getViewport({ scale: 1, rotation });
    const size = { width: viewport.width, height: viewport.height };
    page.cleanup();
    return size;
  } finally { await pdf.destroy(); }
}

async function renderPdfPageCanvas(item, scale) {
  const pdfjs = await loadPdfJs();
  const pdf = await openPdf(pdfjs, sourceBytes, sourceFile.name);
  try {
    const page = await pdf.getPage(item.index + 1);
    const rotation = ((page.rotate + item.rotation) % 360 + 360) % 360;
    const viewport = page.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    page.cleanup();
    return canvas;
  } finally { await pdf.destroy(); }
}

async function cropPage(item) {
  if (item.type === "image") {
    const rect = await openCrop(item.file);
    return rect ? { rect, scale: 1 } : null;
  }
  const dimensions = await getPdfPageSize(item);
  const scale = Math.min(1, 2400 / Math.max(dimensions.width, dimensions.height));
  const canvas = await renderPdfPageCanvas(item, scale);
  try {
    const blob = await canvasBlob(canvas, "image/png");
    const file = new File([blob], `page-${item.index + 1}-crop.png`, { type: "image/png" });
    const rect = await openCrop(file);
    return rect ? { rect, scale } : null;
  } finally { canvas.width = 0; canvas.height = 0; }
}

async function makeImageCanvas(item) {
  const image = new Image();
  const url = URL.createObjectURL(item.file);
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error(`Could not read image ${item.file.name}.`)); image.src = url; });
  } finally { URL.revokeObjectURL(url); }
  const crop = item.crop || { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight };
  const sx = Math.max(0, Math.min(image.naturalWidth - 1, crop.x));
  const sy = Math.max(0, Math.min(image.naturalHeight - 1, crop.y));
  const sw = Math.max(1, Math.min(image.naturalWidth - sx, crop.w));
  const sh = Math.max(1, Math.min(image.naturalHeight - sy, crop.h));
  const rotated = item.rotation % 180 !== 0;
  const canvas = document.createElement("canvas");
  canvas.width = rotated ? sh : sw;
  canvas.height = rotated ? sw : sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser could not prepare the image page.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(item.rotation * Math.PI / 180);
  ctx.drawImage(image, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  return canvas;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not prepare the image page.")), type, quality));
}

async function addImagePage(document, item, pdfLib) {
  const canvas = await makeImageCanvas(item);
  try {
    const blob = await canvasBlob(canvas, "image/jpeg", 0.94);
    const bytes = await blob.arrayBuffer();
    const image = await document.embedJpg(bytes);
    const landscape = canvas.width > canvas.height;
    const pageWidth = landscape ? 841.89 : 595.28;
    const pageHeight = landscape ? 595.28 : 841.89;
    const margin = 24;
    const scale = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
    const width = canvas.width * scale, height = canvas.height * scale;
    const page = document.addPage([pageWidth, pageHeight]);
    page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
    return page;
  } finally { canvas.width = 0; canvas.height = 0; }
}

async function addCroppedPdfPage(document, item, pdfLib) {
  const dimensions = await getPdfPageSize(item);
  const scale = Math.min(2, 6000 / Math.max(dimensions.width, dimensions.height));
  const rendered = await renderPdfPageCanvas(item, scale);
  const crop = item.crop;
  const ratio = scale / (item.cropScale || 1);
  const width = Math.max(1, Math.round(crop.w * ratio));
  const height = Math.max(1, Math.round(crop.h * ratio));
  const cropped = document.createElement("canvas");
  cropped.width = width; cropped.height = height;
  cropped.getContext("2d").drawImage(rendered, crop.x * ratio, crop.y * ratio, crop.w * ratio, crop.h * ratio, 0, 0, width, height);
  const blob = await canvasBlob(cropped, "image/jpeg", 0.94);
  const image = await document.embedJpg(await blob.arrayBuffer());
  // A scale-1 PDF.js viewport uses the PDF page's user-space dimensions.
  const pageWidth = crop.w / (item.cropScale || 1);
  const pageHeight = crop.h / (item.cropScale || 1);
  const page = document.addPage([pageWidth, pageHeight]);
  page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  rendered.width = 0; rendered.height = 0; cropped.width = 0; cropped.height = 0;
  return page;
}

function updateSelection() {
  const selected = pageItems.filter((item) => item.selected).length;
  selectionCount.textContent = selected ? `${selected} page${selected === 1 ? "" : "s"} selected for extraction.` : "Select pages to extract.";
  extractBtn.disabled = busy || selected === 0;
}

async function addRenderedPdfPage(document, item) {
  const dimensions = await getPdfPageSize(item);
  const scale = Math.min(2, 2400 / Math.max(dimensions.width, dimensions.height));
  const canvas = await renderPdfPageCanvas(item, scale);
  try {
    const image = await document.embedJpg(await (await canvasBlob(canvas, "image/jpeg", 0.92)).arrayBuffer());
    // Preserve the original user-space dimensions reported by the scale-1 viewport.
    const pageWidth = dimensions.width;
    const pageHeight = dimensions.height;
    const page = document.addPage([pageWidth, pageHeight]);
    page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  } finally { canvas.width = 0; canvas.height = 0; }
}

async function loadSourceForCopy(pdfLib) {
  try { return await pdfLib.PDFDocument.load(sourceBytes.slice(0)); }
  catch (err) {
    // pdf-lib cannot decrypt a document after PDF.js opens it; encrypted sources use the rendered-page path.
    if (err && /encrypt|password/i.test(err.message || "")) return null;
    throw err;
  }
}

async function appendOrganizedPage(out, item, sourceDoc, pdfLib) {
  if (item.type === "image") await addImagePage(out, item, pdfLib);
  else if (item.crop) await addCroppedPdfPage(out, item, pdfLib);
  else if (sourceDoc) {
    const [page] = await out.copyPages(sourceDoc, [item.index]);
    addRotatedPage(out, page, item, pdfLib);
  } else await addRenderedPdfPage(out, item);
}

async function makePdf(items) {
  if (!items.length) throw new Error("There are no pages to save.");
  const pdfLib = await loadPdfLib();
  const src = await loadSourceForCopy(pdfLib);
  const out = await pdfLib.PDFDocument.create();
  for (const item of items) await appendOrganizedPage(out, item, src, pdfLib);
  out.setTitle(sourceFile.name.replace(/\.pdf$/i, ""));
  return new Blob([await out.save()], { type: "application/pdf" });
}

async function runAction(action) {
  if (busy || !pageItems.length) return;
  busy = true;
  setToolBusy(true);
  [extractBtn, splitBtn, saveBtn].forEach((button) => { button.disabled = true; });
  hideResultBar();
  try {
    if (action === "save") {
      setStatus("Saving organized PDF…");
      showResult(await makePdf(pageItems), "organized.pdf");
      setStatus("Organized PDF is ready to download.", "success");
    } else if (action === "extract") {
      const selected = pageItems.filter((item) => item.selected);
      if (!selected.length) throw new Error("Select at least one page to extract.");
      setStatus("Extracting selected pages…");
      showResult(await makePdf(selected), "extracted-pages.pdf");
      setStatus(`${selected.length} page${selected.length === 1 ? "" : "s"} extracted.`, "success");
    } else {
      setStatus("Splitting pages into individual PDFs…");
      const pdfLib = await loadPdfLib();
      const zipFactory = await loadJsZip();
      const zip = new zipFactory();
      const src = await loadSourceForCopy(pdfLib);
      for (let i = 0; i < pageItems.length; i++) {
        const out = await pdfLib.PDFDocument.create();
        await appendOrganizedPage(out, pageItems[i], src, pdfLib);
        const blob = new Blob([await out.save()], { type: "application/pdf" });
        zip.file(`page-${String(i + 1).padStart(3, "0")}.pdf`, blob);
        setStatus(`Splitting PDF… ${i + 1} of ${pageItems.length} pages`);
      }
      const zipped = await zip.generateAsync({ type: "blob" }, (meta) => setStatus(`Packing split files… ${Math.round(meta.percent)}%`));
      showResult(zipped, "split-pages.zip", "zip");
      setStatus("Split PDFs are ready in one ZIP file.", "success");
    }
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Processing this PDF", sourceFile && sourceFile.name), "error");
  } finally {
    busy = false;
    drawPageCards();
    setToolBusy(false);
  }
}

function addRotatedPage(document, page, item, pdfLib) {
  if (item.rotation) {
    const currentRotation = page.getRotation().angle || 0;
    page.setRotation(pdfLib.degrees((currentRotation + item.rotation) % 360));
  }
  document.addPage(page);
}

extractBtn.addEventListener("click", () => runAction("extract"));
splitBtn.addEventListener("click", () => runAction("split"));
saveBtn.addEventListener("click", () => runAction("save"));

function clearPages() {
  loadGeneration++;
  pageItems.forEach((item) => { if (item.thumb) URL.revokeObjectURL(item.thumb); });
  pageItems = [];
  sourceBytes = null;
  sourceFile = null;
  sourcePassword = null;
  pageGrid.replaceChildren();
  pageGrid.scrollLeft = 0;
  pageScroller.hidden = true;
  updatePageScrollButtons();
  toolbar.hidden = true;
  document.getElementById("organizerHeading").hidden = true;
  hideResultBar();
}

wireStartAnother(fileInput, clearPages);
