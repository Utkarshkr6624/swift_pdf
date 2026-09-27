const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const editorShell = document.getElementById("editorShell");
const editorGrid = document.getElementById("editorGrid");
const edStage = document.getElementById("edStage");
const pageCanvasWrap = document.getElementById("pageCanvasWrap");
const pageCanvas = document.getElementById("pageCanvas");
const pageOverlay = document.getElementById("pageOverlay");
const pagePrev = document.getElementById("pagePrev");
const pageNext = document.getElementById("pageNext");
const pageCounter = document.getElementById("pageCounter");
const pageChips = document.getElementById("pageChips");
const zoomOut = document.getElementById("zoomOut");
const zoomLevel = document.getElementById("zoomLevel");
const zoomIn = document.getElementById("zoomIn");
const zoomFit = document.getElementById("zoomFit");
const revertPageBtn = document.getElementById("revertPageBtn");
const discardAllBtn = document.getElementById("discardAllBtn");
const edSelection = document.getElementById("edSelection");
const textInput = document.getElementById("textInput");
const fontFamily = document.getElementById("fontFamily");
const fontSize = document.getElementById("fontSize");
const textColor = document.getElementById("textColor");
const boldToggle = document.getElementById("boldToggle");
const italicToggle = document.getElementById("italicToggle");
const applyBtn = document.getElementById("applyBtn");
const saveBtn = document.getElementById("saveBtn");
const fileNameInput = document.getElementById("fileName");
const edConfirm = document.getElementById("edConfirm");
const confirmSummary = document.getElementById("confirmSummary");
const confirmKeep = document.getElementById("confirmKeep");
const confirmDiscard = document.getElementById("confirmDiscard");
const confirmCancel = document.getElementById("confirmCancel");

// Fit scale is clamped so a huge poster page or a small phone both stay workable,
// and the render scale is capped so a 300% zoom on a large page cannot blow up memory.
const MIN_FIT = 0.2;
const MAX_FIT = 2.5;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;
const MAX_RENDER_SCALE = 4;
// Must match the .ed-box::before inset in styles.css for the coarse-pointer rule,
// so JS hit-testing covers exactly the area the browser considers tappable.
const TOUCH_BLEED = 20;

let currentFile = null;
let pdf = null;
let pageMeta = []; // [{ width, height }] for every page — cheap, fetched on open
const textCache = new Map(); // pageIndex -> items, fetched only when a page is shown
let currentPage = 0;
let zoom = 1;
let displayScale = 1; // authoritative canvas-to-PDF-point ratio, read back from the DOM
let selectedIndex = -1;
let editCount = 0;
let renderToken = 0;
let loadToken = 0;
let editorBusyDepth = 0; // overlapping editor lock windows (open, save, re-open)
let confirmOpen = false; // the keep/discard card is showing
let confirmRestoreFocus = null; // where focus came from, so closing never drops it on the floor
const pending = new Map();
// A live, uncommitted preview of the line currently being typed into. It paints
// on the page as the user types; leaving the line commits it, so nothing is ever
// silently thrown away.
let draft = null;
let baseLayer = null;

const editKey = (pageIndex, itemIndex) => `${pageIndex}:${itemIndex}`;
const pageItems = () => textCache.get(currentPage) || [];
const editedPageCount = () => {
  const pages = new Set();
  pending.forEach((_, key) => pages.add(Number(key.split(":")[0])));
  return pages.size;
};

wireDropzone(dropzone, fileInput, (files) => {
  const file = Array.from(files || []).find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!file) return;
  openPdf(file);
});
wireStartAnother(fileInput, resetEditor);

// The dropzone already opens the file picker on any click, so this button only
// has to stop the click from bubbling back up to the dropzone.
const dropzoneButton = document.getElementById("choosePdfBtn") || (dropzone ? dropzone.querySelector("button") : null);
if (dropzoneButton) {
  dropzoneButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (fileInput && !fileInput.disabled) fileInput.click();
  });
}

if (pagePrev) pagePrev.addEventListener("click", () => goToPage(currentPage - 1));
if (pageNext) pageNext.addEventListener("click", () => goToPage(currentPage + 1));
if (zoomOut) zoomOut.addEventListener("click", () => setZoom(zoom - ZOOM_STEP));
if (zoomIn) zoomIn.addEventListener("click", () => setZoom(zoom + ZOOM_STEP));
if (zoomFit) zoomFit.addEventListener("click", () => setZoom(1));
if (applyBtn) applyBtn.addEventListener("click", applyEdit);
if (revertPageBtn) revertPageBtn.addEventListener("click", revertPage);
if (discardAllBtn) discardAllBtn.addEventListener("click", () => openConfirm("discard"));
if (saveBtn) saveBtn.addEventListener("click", () => openConfirm("save"));

if (confirmKeep) confirmKeep.addEventListener("click", () => { closeConfirm(); savePdf(); });
if (confirmDiscard) confirmDiscard.addEventListener("click", () => { closeConfirm(); discardAll(); });
if (confirmCancel) confirmCancel.addEventListener("click", () => { closeConfirm(); setStatus("Still editing — nothing was changed."); });

if (textInput) {
  textInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      applyEdit();
    }
  });
  // Live preview: the page follows the replacement box as it is typed, so Apply
  // is a confirmation rather than the thing that makes the edit appear.
  textInput.addEventListener("input", updateDraft);
}
// The style controls repaint the preview too, so changing size or colour is as
// immediate as changing the words.
[fontFamily, fontSize, textColor, boldToggle, italicToggle].forEach((el) => {
  if (!el) return;
  el.addEventListener("input", updateDraft);
  el.addEventListener("change", updateDraft);
});

document.addEventListener("keydown", (event) => {
  if (editorShell && editorShell.hidden) return;
  // While the card is up it owns the keyboard: Escape cancels and nothing else
  // fires, so a stray keypress can never fall through and wipe a selection or
  // turn the page on a user who is only trying to read the summary.
  if (confirmOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirm();
      setStatus("Still editing — nothing was changed.");
    }
    return;
  }
  const target = event.target;
  const inField = target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable);
  if (event.key === "Escape") {
    clearSelectionFields();
    return;
  }
  if (inField || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    goToPage(currentPage - 1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    goToPage(currentPage + 1);
  }
});

// Observe the stage (the element we measure), not the canvas wrapper, which is
// sized by the canvas and would fire the observer in a loop.
let resizeTimer = 0;
const scheduleRerender = () => {
  if (!pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderCanvas(); }, 120);
};
if (window.ResizeObserver && edStage) {
  new ResizeObserver(scheduleRerender).observe(edStage);
} else {
  window.addEventListener("resize", scheduleRerender);
}

async function openPdf(file) {
  setToolBusy(true);
  hideResultBar();
  resetEditor(false);
  // After the reset, so the re-enabled state sync inside it cannot undo the lock.
  setEditorBusy(true);
  setStatus("Reading this PDF…");
  try {
    const pdfjs = await loadPdfJs();
    pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    currentFile = file;
    if (fileNameInput) fileNameInput.value = baseName(file.name);
    pageMeta = [];
    textCache.clear();
    for (let i = 1; i <= pdf.numPages; i++) {
      const pdfPage = await pdf.getPage(i);
      const size = pdfPage.getViewport({ scale: 1 });
      pageMeta.push({ width: size.width, height: size.height });
      pdfPage.cleanup();
    }
    // Only the first page is inspected up front: if it has no text layer the whole
    // file is a scan, and the user should be told before touching any more pages.
    const firstItems = await ensurePageItems(0);
    if (!firstItems.length) {
      setStatus("No selectable text was found in this PDF. It looks like a scan or image-only file — those have no text layer to edit. Run it through an OCR tool first, then edit it here.", "error");
      dropzone.hidden = false;
      editorShell.hidden = true;
      return;
    }
    currentPage = 0;
    selectedIndex = -1;
    dropzone.hidden = true;
    editorShell.hidden = false;
    renderPageChips();
    clearSelectionFields();
    await renderCanvas();
    renderBoxes();
    const scrolled = revealStage();
    const pages = `${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}`;
    setStatus(scrolled
      ? `Loaded ${pages}. Scrolled to the page — tap any text on it to edit it.`
      : `Loaded ${pages}. Tap any text on the page to edit it.`, "success");
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Opening this PDF", file.name), "error");
    dropzone.hidden = false;
    editorShell.hidden = true;
  } finally {
    setEditorBusy(false);
    setToolBusy(false);
  }
}

function baseName(name) {
  return String(name || "").replace(/\.[^.]+$/, "") || "edited";
}

// Fetch a page's text items on demand and cache them. Reading every page up front
// exhausts memory on long documents, so only the visible page is ever pulled.
async function ensurePageItems(index) {
  if (textCache.has(index)) return textCache.get(index);
  if (!pdf) return [];
  const pdfPage = await pdf.getPage(index + 1);
  const meta = pageMeta[index] || { height: 0 };
  const content = await pdfPage.getTextContent();
  const items = content.items
    .filter((entry) => entry.str && entry.str.trim())
    .map((entry) => readItem(entry, meta.height));
  pdfPage.cleanup();
  textCache.set(index, items);
  return items;
}

function readItem(entry, pageHeight) {
  const t = entry.transform || [];
  const x = t[4] || 0;
  const baselineY = t[5] || 0;
  const size = Math.hypot(t[2], t[3]) || t[0] || 10;
  const width = entry.width || size * 0.5 * entry.str.length;
  return {
    str: entry.str,
    fontName: entry.fontName || "",
    x,
    baselineY,
    size,
    left: x,
    top: pageHeight - baselineY - size * 0.9,
    boxHeight: size * 1.25,
    boxWidth: width,
  };
}

function stageContentWidth() {
  if (edStage) {
    const styles = window.getComputedStyle(edStage);
    const padX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    return Math.max(120, edStage.clientWidth - padX);
  }
  return Math.max(120, pageCanvasWrap ? pageCanvasWrap.clientWidth : window.innerWidth);
}

function fitScale() {
  const meta = pageMeta[currentPage];
  if (!meta) return 1;
  return Math.min(MAX_FIT, Math.max(MIN_FIT, stageContentWidth() / meta.width));
}

function renderScale() {
  return Math.min(MAX_RENDER_SCALE, Math.max(MIN_FIT * MIN_ZOOM, fitScale() * zoom));
}

function setZoom(next) {
  const value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100));
  if (value === zoom) {
    syncZoom();
    return;
  }
  zoom = value;
  syncZoom();
  renderCanvas();
}

function syncZoom() {
  if (zoomLevel) zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  if (zoomFit) zoomFit.disabled = zoom === 1;
  if (zoomOut) zoomOut.disabled = zoom <= MIN_ZOOM;
  if (zoomIn) zoomIn.disabled = zoom >= MAX_ZOOM;
}

async function renderCanvas() {
  const meta = pageMeta[currentPage];
  if (!pdf || !meta) return;
  const token = ++renderToken;
  const pdfPage = await pdf.getPage(currentPage + 1);
  if (token !== renderToken) return;
  const viewport = pdfPage.getViewport({ scale: renderScale() });
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  // Render into a scratch canvas so a slow frame that loses the race can never
  // paint over a newer page.
  const scratch = document.createElement("canvas");
  scratch.width = Math.max(1, Math.floor(viewport.width * ratio));
  scratch.height = Math.max(1, Math.floor(viewport.height * ratio));
  const ctx = scratch.getContext("2d", { alpha: false });
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  if (token !== renderToken) return;
  pdfPage.cleanup();
  pageCanvas.width = scratch.width;
  pageCanvas.height = scratch.height;
  pageCanvas.style.width = `${viewport.width}px`;
  pageCanvas.style.height = `${viewport.height}px`;
  const target = pageCanvas.getContext("2d", { alpha: false });
  target.drawImage(scratch, 0, 0);
  // Keep the un-edited page so a draft can be repainted as the user types without
  // re-rendering the PDF through pdf.js on every keystroke.
  if (!baseLayer || baseLayer.width !== scratch.width || baseLayer.height !== scratch.height) {
    baseLayer = document.createElement("canvas");
  }
  baseLayer.width = scratch.width;
  baseLayer.height = scratch.height;
  baseLayer.getContext("2d", { alpha: false }).drawImage(scratch, 0, 0);
  // The canvas is owned by JS and never shrunk by CSS, so its real width is the
  // only trustworthy mapping from PDF points to screen pixels.
  displayScale = (pageCanvas.clientWidth || viewport.width) / meta.width;
  paintEdits();
  positionBoxes();
}

// Restore the clean page and redraw every edit over it. Cheap enough to run on
// each keystroke, unlike a full pdf.js render.
function repaintEdits() {
  if (!baseLayer || !pageCanvas) return false;
  const ctx = pageCanvas.getContext("2d");
  if (!ctx) return false;
  if (pageCanvas.width !== baseLayer.width || pageCanvas.height !== baseLayer.height) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pageCanvas.width, pageCanvas.height);
  ctx.drawImage(baseLayer, 0, 0);
  paintEdits();
  return true;
}

// The cover rectangle uses the ORIGINAL item box — never a box resized to the
// length of the replacement — so it cannot wipe out neighbouring text.
function paintEdits() {
  const ctx = pageCanvas.getContext("2d");
  if (!ctx) return;
  const ratio = pageCanvas.width / Math.max(1, pageCanvas.clientWidth);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  pageItems().forEach((item, index) => {
    // The live draft wins over the committed edit for this line, so typing
    // previews over the top of whatever was applied earlier.
    const edit = draft && draft.pageIndex === currentPage && draft.itemIndex === index
      ? draft.edit
      : pending.get(editKey(currentPage, index));
    if (!edit) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(item.left * displayScale, item.top * displayScale, item.boxWidth * displayScale, item.boxHeight * displayScale);
    // Drawing the replacement here — on the page itself, with the same font,
    // size, colour and baseline savePdf() writes into the file — is what makes an
    // edit show up the moment it is typed. The overlay boxes are invisible hit
    // targets, so this is the only thing the user ever sees.
    ctx.font = cssFont(edit);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = edit.color || "#000000";
    ctx.fillText(edit.text, edit.x * displayScale, canvasBaselineY(edit));
  });
}

function cssFont(edit) {
  const style = edit.italic ? "italic " : "";
  const weight = edit.bold ? "700" : "400";
  return `${style}${weight} ${Math.max(1, edit.size * displayScale)}px ${cssFamily(edit.family)}`;
}

// PDF space counts up from the bottom of the page, the canvas counts down from
// the top, so a baseline has to be flipped before it can be drawn. This is the
// same value readItem() used to build item.top from, which is why the cover
// rectangle and the new text sit on top of each other exactly.
function canvasBaselineY(edit) {
  const pageHeight = (pageMeta[currentPage] && pageMeta[currentPage].height) || 0;
  return (pageHeight - edit.baselineY) * displayScale;
}

function renderBoxes() {
  if (!pageOverlay) return;
  pageOverlay.innerHTML = "";
  const frag = document.createDocumentFragment();
  pageItems().forEach((item, index) => {
    const box = document.createElement("button");
    box.type = "button";
    box.className = "ed-box";
    box.dataset.index = String(index);
    box.textContent = item.str;
    box.setAttribute("aria-label", `Text: ${item.str.slice(0, 60)}`);
    box.addEventListener("click", (event) => {
      // Dense body copy puts neighbouring lines a few pixels apart, so several
      // enlarged hit areas overlap under the touch point. Resolve the intended
      // line here rather than letting DOM order decide.
      selectItem(hitTestBox(event.clientX, event.clientY, index), true);
    });
    frag.appendChild(box);
  });
  pageOverlay.appendChild(frag);
  positionBoxes();
}

// Returns the index of the box the user meant to hit. Candidates are the boxes
// whose padded rect contains the point; among those, the one whose painted rect
// is closest wins, so a tap on a line is never stolen by its neighbour.
function hitTestBox(clientX, clientY, fallbackIndex) {
  const boxes = pageOverlay ? pageOverlay.children : [];
  if (!boxes.length) return fallbackIndex;
  const pad = coarsePointer() ? TOUCH_BLEED : 0;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const rect = boxes[i].getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const insideX = clientX >= rect.left - pad && clientX <= rect.right + pad;
    const insideY = clientY >= rect.top - pad && clientY <= rect.bottom + pad;
    if (!insideX || !insideY) continue;
    // Distance to the painted rect, not the padded one: a point sitting exactly
    // on a line scores 0 for that line and >0 for every overlapping neighbour.
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const score = Math.hypot(dx, dy);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best === -1 ? fallbackIndex : best;
}

function coarsePointer() {
  return window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false;
}

function positionBoxes() {
  if (!pageOverlay) return;
  const boxes = pageOverlay.children;
  pageItems().forEach((item, index) => {
    const box = boxes[index];
    if (!box) return;
    const edit = pending.get(editKey(currentPage, index));
    const base = styleOfSource(item.fontName);
    const size = edit ? edit.size : item.size;
    box.classList.toggle("is-edited", Boolean(edit));
    // A dashed underline marks a line that is only being previewed, so the user
    // can see the difference between "typed but not applied" and "saved".
    box.classList.toggle("is-draft", Boolean(draft) && draft.pageIndex === currentPage && draft.itemIndex === index);
    // The box is a hit target only — the replacement is painted on the canvas, so
    // the overlay text is never seen. It is forced transparent here rather than
    // left to CSS so an unstyled rule cannot ever double-print a line of text.
    box.textContent = item.str;
    box.style.color = "transparent";
    if (edit) box.setAttribute("aria-label", `Edited to: ${edit.text.slice(0, 60)}`);
    box.style.left = `${item.left * displayScale}px`;
    box.style.top = `${item.top * displayScale}px`;
    box.style.width = `${Math.max(6, item.boxWidth * displayScale)}px`;
    // Track the painted glyph box exactly. Inflating the height to a minimum
  // pushes the centre of a small line's box into the line below it, so a tap on
  // the text resolves to the wrong item. Touch tolerance comes from the
  // coarse-pointer bleed in CSS, resolved by hitTestBox(), instead.
  box.style.height = `${Math.max(1, item.boxHeight * displayScale)}px`;
    box.style.fontSize = `${size * displayScale}px`;
    box.style.fontFamily = cssFamily(edit ? edit.family : base.family);
    box.style.fontWeight = edit ? (edit.bold ? "700" : "400") : (base.bold ? "700" : "400");
    box.style.fontStyle = edit ? (edit.italic ? "italic" : "normal") : (base.italic ? "italic" : "normal");
  });
}

function renderPageChips() {
  if (!pageChips) return;
  pageChips.innerHTML = "";
  const frag = document.createDocumentFragment();
  pageMeta.forEach((_, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ed-page-btn";
    chip.textContent = String(index + 1);
    chip.setAttribute("aria-label", `Go to page ${index + 1}`);
    chip.addEventListener("click", () => goToPage(index));
    frag.appendChild(chip);
  });
  pageChips.appendChild(frag);
  syncPageNav();
}

function syncPageNav() {
  if (pageCounter) {
    const total = Math.max(1, pageMeta.length);
    // The badge shows the short form; the label carries the sentence a screen
    // reader needs, since the visible text alone would read as "1 slash 3".
    pageCounter.textContent = `${currentPage + 1} / ${total}`;
    pageCounter.setAttribute("aria-label", `Page ${currentPage + 1} of ${total}`);
  }
  if (pagePrev) {
    pagePrev.disabled = currentPage === 0 || !pageMeta.length;
    pagePrev.setAttribute("aria-pressed", String(currentPage > 0));
  }
  if (pageNext) {
    pageNext.disabled = !pageMeta.length || currentPage >= pageMeta.length - 1;
    pageNext.setAttribute("aria-pressed", String(currentPage < pageMeta.length - 1));
  }
  if (!pageChips) return;
  Array.from(pageChips.children).forEach((chip, index) => {
    const active = index === currentPage;
    chip.classList.toggle("is-active", active);
    if (active) chip.setAttribute("aria-current", "page");
    else chip.removeAttribute("aria-current");
  });
}

async function goToPage(index) {
  if (!pageMeta.length) return;
  const next = Math.max(0, Math.min(pageMeta.length - 1, index));
  if (next === currentPage && textCache.has(next)) {
    syncPageNav();
    return;
  }
  // Leaving a page commits the live preview, same as leaving a line.
  commitDraft();
  currentPage = next;
  const token = ++loadToken;
  selectedIndex = -1;
  clearSelectionFields();
  syncPageNav();
  syncZoom();
  try {
    const items = await ensurePageItems(next);
    if (token !== loadToken) return;
    await renderCanvas();
    if (token !== loadToken) return;
    renderBoxes();
    setStatus(`Page ${currentPage + 1}. ${items.length} text item${items.length === 1 ? "" : "s"} on this page.`);
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Reading this page"), "error");
  }
}

function selectItem(index, scroll) {
  // Moving off a line commits whatever was being typed, so an edit is never lost
  // just because the user tapped somewhere else.
  if (index !== selectedIndex) commitDraft();
  selectedIndex = index;
  const item = pageItems()[index];
  if (!item) return;
  const edit = pending.get(editKey(currentPage, index));
  const base = styleOfSource(item.fontName);
  const source = edit
    ? { text: edit.text, family: edit.family, size: edit.size, color: edit.color, bold: edit.bold, italic: edit.italic }
    : { text: item.str, family: base.family, size: item.size, color: "#000000", bold: base.bold, italic: base.italic };
  textInput.value = source.text;
  fontFamily.value = source.family;
  fontSize.value = String(Math.round(source.size * 10) / 10);
  textColor.value = source.color;
  boldToggle.checked = source.bold;
  italicToggle.checked = source.italic;
  syncSelection();
  if (scroll && pageOverlay) revealBoxInStage(pageOverlay.children[index]);
}

// scrollIntoView() moves EVERY scrollable ancestor, the document included, so
// tapping a line used to nudge the whole page down. Anything selected is on
// screen already — the user just tapped it — so the only adjustment worth making
// is a nudge of the stage's own scrollTop, and only when the box really sits
// outside it. Setting scrollTop can never move the document, which is the whole
// point of the guarantee.
function revealBoxInStage(box) {
  if (!edStage || !box || !box.getBoundingClientRect) return;
  const stage = edStage.getBoundingClientRect();
  const rect = box.getBoundingClientRect();
  if (!rect.height) return;
  const margin = 12;
  let delta = 0;
  if (rect.top < stage.top + margin) delta = rect.top - (stage.top + margin);
  else if (rect.bottom > stage.bottom - margin) delta = rect.bottom - (stage.bottom - margin);
  if (!delta) return;
  const max = Math.max(0, edStage.scrollHeight - edStage.clientHeight);
  // A stage that does not scroll clamps to 0, so this stays a no-op there.
  edStage.scrollTop = Math.max(0, Math.min(edStage.scrollTop + delta, max));
}

function syncSelection() {
  if (pageOverlay) {
    Array.from(pageOverlay.children).forEach((box, index) => box.classList.toggle("is-selected", index === selectedIndex));
  }
  syncSelectionInfo();
}

function syncSelectionInfo() {
  if (!edSelection) return;
  const item = pageItems()[selectedIndex];
  if (!item) {
    edSelection.textContent = "Nothing selected yet. Tap a piece of text on the page to edit it.";
    edSelection.classList.remove("is-active");
    return;
  }
  const edit = pending.get(editKey(currentPage, selectedIndex));
  const flat = item.str.replace(/\s+/g, " ").trim();
  const shown = flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
  edSelection.textContent = `Original: “${shown}” — ${Math.round(item.size * 10) / 10} pt${edit ? " · edited" : ""}`;
  edSelection.classList.add("is-active");
}

function clearSelectionFields() {
  selectedIndex = -1;
  textInput.value = "";
  fontFamily.value = "helvetica";
  fontSize.value = "12";
  textColor.value = "#000000";
  boldToggle.checked = false;
  italicToggle.checked = false;
  syncSelection();
}

function styleOfSource(fontName) {
  const name = String(fontName || "").toLowerCase();
  let family = "helvetica";
  if (/times|serif|roman|georgia|garamond/.test(name)) family = "times";
  else if (/courier|mono/.test(name)) family = "courier";
  return {
    family,
    bold: /bold|black|heavy|semibold/.test(name),
    italic: /italic|oblique/.test(name),
  };
}

function applyEdit() {
  const item = pageItems()[selectedIndex];
  if (!item) {
    setStatus("Select a text item on the page first.", "error");
    return;
  }
  const text = textInput.value;
  if (!text.trim()) {
    setStatus("Enter the replacement text before applying.", "error");
    return;
  }
  commitDraft();
  editCount = pending.size;
  // The canvas keeps the painted text, so it goes on showing the new wording
  // straight away — no reload, no zoom change, nothing to re-render around.
  paintEdits();
  positionBoxes();
  setStatus(`Applied on page ${currentPage + 1}. ${editCount} edit${editCount === 1 ? "" : "s"} pending — press “Save edited PDF” when you are done.`, "success");
}

// Builds the pending edit for the selected line from the current field values.
// Geometry is snapshotted from the ORIGINAL item so the cover and the new text
// keep the same anchor no matter how the replacement length compares.
function editFromFields(item) {
  return {
    text: textInput.value,
    family: fontFamily.value,
    size: Math.min(200, Math.max(4, Number(fontSize.value) || item.size)),
    color: textColor.value || "#000000",
    bold: boldToggle.checked,
    italic: italicToggle.checked,
    x: item.x,
    baselineY: item.baselineY,
    left: item.left,
    top: item.top,
    boxWidth: item.boxWidth,
    boxHeight: item.boxHeight,
  };
}

// Called on every keystroke and on every style control change. Repaints just the
// affected line from the cached page bitmap, so typing stays smooth.
function updateDraft() {
  const item = pageItems()[selectedIndex];
  if (!item) return;
  const edit = editFromFields(item);
  // The preview shows exactly what Apply would commit, so changing only the size
  // or colour previews too. It only disappears once every control is back to what
  // the line already is.
  if (!edit.text.trim() || sameAsCurrent(edit, item)) {
    if (draft) {
      draft = null;
      if (!repaintEdits()) renderCanvas();
      positionBoxes();
    }
    return;
  }
  if (!draft || draft.pageIndex !== currentPage || draft.itemIndex !== selectedIndex) {
    draft = { pageIndex: currentPage, itemIndex: selectedIndex, edit: null };
  }
  draft.edit = edit;
  if (!repaintEdits()) renderCanvas();
  positionBoxes();
}

// True when the panel matches what the line already shows, meaning there is
// nothing to preview. The source colour is not exposed by pdf.js, so an
// unedited line is compared against black, which is what it is drawn as.
function sameAsCurrent(edit, item) {
  const committed = pending.get(editKey(currentPage, selectedIndex));
  const base = styleOfSource(item.fontName);
  const current = committed || {
    text: item.str, family: base.family, size: item.size,
    color: "#000000", bold: base.bold, italic: base.italic,
  };
  return edit.text === current.text
    && edit.family === current.family
    && Math.abs(edit.size - current.size) < 0.05
    && String(edit.color).toLowerCase() === String(current.color).toLowerCase()
    && edit.bold === current.bold
    && edit.italic === current.italic;
}

// Moves the live preview into the saved set. Called by Apply, and implicitly
// whenever the user moves to a different line or page, so no typing is lost.
function commitDraft() {
  if (!draft) return;
  const { pageIndex, itemIndex, edit } = draft;
  draft = null;
  if (edit && edit.text.trim()) {
    pending.set(editKey(pageIndex, itemIndex), edit);
    editCount = pending.size;
  }
  // selectItem() only refreshes the selection classes, so the committed edit has
  // to repaint and re-mark the line here or it keeps its "not applied" look.
  if (pageIndex === currentPage) {
    if (!repaintEdits()) renderCanvas();
    positionBoxes();
  }
}

async function revertPage() {
  if (!pageMeta.length) return;
  // A preview on this page would be repainted straight back over the undo, so
  // drop it along with the applied edits.
  if (draft && draft.pageIndex === currentPage) draft = null;
  let removed = 0;
  pageItems().forEach((_, index) => {
    if (pending.delete(editKey(currentPage, index))) removed++;
  });
  editCount = pending.size;
  if (!removed) {
    setStatus(`Page ${currentPage + 1} has no applied edits to undo.`);
    return;
  }
  await renderCanvas();
  positionBoxes();
  setStatus(`Reverted ${removed} edit${removed === 1 ? "" : "s"} on page ${currentPage + 1}. ${editCount} still pending.`);
}

// The card is the only thing standing between a user and losing an afternoon of
// edits, so it states the count before anything is done and every exit is
// explicit: keep writes the file, discard throws the edits away, cancel does
// nothing at all. Nothing is destroyed without a click on the card itself.
function openConfirm(mode) {
  if (!pending.size) {
    setStatus(mode === "save"
      ? "No edits have been applied yet. Click a piece of text, type the replacement, and press Apply before saving."
      : "There are no edits to discard.", "error");
    return;
  }
  if (!edConfirm) {
    // The card is part of the page, so this only fires if the markup is missing.
    if (mode === "save") savePdf();
    else discardAll();
    return;
  }
  const count = pending.size;
  const pages = editedPageCount();
  if (confirmSummary) {
    confirmSummary.textContent = `${count} edit${count === 1 ? "" : "s"} across ${pages} page${pages === 1 ? "" : "s"}`;
  }
  if (confirmKeep) {
    // Discarding something nobody saved has nothing to keep, so the button goes.
    confirmKeep.hidden = mode !== "save";
  }
  confirmRestoreFocus = document.activeElement;
  if (!edConfirm.hasAttribute("tabindex")) edConfirm.setAttribute("tabindex", "-1");
  edConfirm.hidden = false;
  confirmOpen = true;
  const first = (mode === "save" ? confirmKeep : confirmDiscard) || confirmCancel;
  if (first && first.focus) first.focus();
}

function closeConfirm() {
  if (!edConfirm) return;
  edConfirm.hidden = true;
  confirmOpen = false;
  const back = confirmRestoreFocus;
  confirmRestoreFocus = null;
  // Focus has to go somewhere visible or the next Tab starts at the top of the
  // document. The button that opened the card is normally still there.
  if (back && back.focus && document.contains(back)) back.focus();
  else if (saveBtn && saveBtn.focus) saveBtn.focus();
}

async function discardAll() {
  if (!pending.size) {
    setStatus("There are no edits to discard.");
    return;
  }
  const count = pending.size;
  draft = null;
  pending.clear();
  editCount = 0;
  // A full repaint rather than a touch-up: the cover rectangles and the painted
  // text both come off the canvas with it, so the page returns to its original
  // text with no leftovers.
  await renderCanvas();
  positionBoxes();
  clearSelectionFields();
  setStatus(`Discarded ${count} edit${count === 1 ? "" : "s"}. The PDF is back to its original text.`);
}

async function savePdf() {
  if (!currentFile || !pdf) return;
  if (!pending.size) {
    setStatus("No edits have been applied yet. Click a piece of text, type the replacement, and press Apply before saving.", "error");
    return;
  }
  setToolBusy(true);
  setEditorBusy(true);
  hideResultBar();
  setStatus("Writing your edited PDF…");
  let fallbacks = 0;
  let dropped = 0;
  let skipped = 0;
  try {
    const pdfLib = await loadPdfLib();
    const out = await pdfLib.PDFDocument.load(await currentFile.arrayBuffer());
    const cache = new Map();
    const fontFor = async (family, bold, italic) => {
      const key = `${family}|${bold}|${italic}`;
      if (cache.has(key)) return cache.get(key);
      const font = await out.embedFont(pdfLib.StandardFonts[standardFontName(family, bold, italic)]);
      cache.set(key, font);
      return font;
    };
    const byPage = new Map();
    pending.forEach((edit, key) => {
      const split = key.split(":");
      const pageIndex = Number(split[0]);
      if (!byPage.has(pageIndex)) byPage.set(pageIndex, []);
      byPage.get(pageIndex).push({ edit, itemIndex: Number(split[1]) });
    });
    for (const [pageIndex, entries] of byPage) {
      const page = out.getPages()[pageIndex];
      if (!page) continue;
      const pageSize = page.getSize();
      entries.sort((a, b) => a.itemIndex - b.itemIndex);
      for (const entry of entries) {
        const edit = entry.edit;
        // Each edit is isolated: one unencodable item must never lose the others.
        try {
          page.drawRectangle({
            x: Math.max(0, edit.x - 1),
            y: pageSize.height - edit.top - edit.boxHeight - 1,
            width: edit.boxWidth + 2,
            height: edit.boxHeight + 2,
            color: pdfLib.rgb(1, 1, 1),
          });
          const font = await pickFont(pdfLib, fontFor, edit);
          if (font.fallbackUsed) fallbacks++;
          dropped += font.dropped;
          page.drawText(font.text, {
            x: Math.max(0, edit.x),
            y: Math.max(0, edit.baselineY - edit.size * 0.2),
            size: edit.size,
            font: font.font,
            color: hexToRgb(pdfLib, edit.color),
          });
        } catch (err) {
          console.warn("Skipped an edit that could not be drawn.", err);
          skipped++;
        }
      }
    }
    const bytes = await out.save();
    showResult(new Blob([bytes], { type: "application/pdf" }), "edited.pdf");
    const count = pending.size;
    const notes = [];
    if (fallbacks) notes.push(`${fallbacks} replacement${fallbacks === 1 ? "" : "s"} used a different standard font because the one you picked could not draw those characters`);
    if (dropped) notes.push(`${dropped} character${dropped === 1 ? "" : "s"} could not be drawn and were left out`);
    if (skipped) notes.push(`${skipped} edit${skipped === 1 ? "" : "s"} could not be drawn and were skipped`);
    setStatus(`Saved ${count} edit${count === 1 ? "" : "s"} across ${byPage.size} page${byPage.size === 1 ? "" : "s"}${notes.length ? `. Note: ${notes.join("; ")}.` : "."}`, "success");
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Editing this PDF", currentFile.name), "error");
  } finally {
    setEditorBusy(false);
    setToolBusy(false);
  }
}

// The standard fonts are WinAnsi only, so anything outside it (₹, curly quotes,
// CJK, emoji) has to be probed. widthOfTextAtSize throws for unencodable runs,
// which is the cheapest reliable check the library gives us.
function canEncode(font, text, size) {
  try {
    font.widthOfTextAtSize(text, size);
    return true;
  } catch (err) {
    return false;
  }
}

function dropUnencodable(font, text, size) {
  let kept = "";
  for (const ch of text) {
    if (canEncode(font, kept + ch, size)) kept += ch;
  }
  return kept;
}

async function pickFont(pdfLib, fontFor, edit) {
  const candidates = [
    { family: edit.family, bold: edit.bold, italic: edit.italic },
    { family: edit.family, bold: false, italic: false },
    { family: "helvetica", bold: false, italic: false },
  ];
  let fallbackUsed = false;
  for (let i = 0; i < candidates.length; i++) {
    const pick = candidates[i];
    let font;
    try {
      font = await fontFor(pick.family, pick.bold, pick.italic);
    } catch (err) {
      continue;
    }
    if (canEncode(font, edit.text, edit.size)) {
      return { font, text: edit.text, dropped: 0, fallbackUsed };
    }
    fallbackUsed = true;
  }
  // Nothing in the family can draw the text, so keep only the characters that can.
  const font = await fontFor("helvetica", false, false);
  const text = dropUnencodable(font, edit.text, edit.size);
  return { font, text, dropped: Math.max(0, Array.from(edit.text).length - Array.from(text).length), fallbackUsed: true };
}

function standardFontName(family, bold, italic) {
  if (family === "times") {
    if (bold && italic) return "TimesRomanBoldItalic";
    if (bold) return "TimesRomanBold";
    if (italic) return "TimesRomanItalic";
    return "TimesRoman";
  }
  if (family === "courier") {
    if (bold && italic) return "CourierBoldOblique";
    if (bold) return "CourierBold";
    if (italic) return "CourierOblique";
    return "Courier";
  }
  if (bold && italic) return "HelveticaBoldOblique";
  if (bold) return "HelveticaBold";
  if (italic) return "HelveticaOblique";
  return "Helvetica";
}

function cssFamily(family) {
  if (family === "times") return '"Times New Roman", Times, serif';
  if (family === "courier") return '"Courier New", Courier, monospace';
  return "Helvetica, Arial, sans-serif";
}

function hexToRgb(pdfLib, hex) {
  const clean = String(hex || "").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.padEnd(6, "0");
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return pdfLib.rgb(0, 0, 0);
  return pdfLib.rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

// setToolBusy only covers the shared chrome, so the editor disables its own panel.
// Busy windows can overlap (a second file dropped while the first is still
// opening, a save started before that load finished), so a nesting depth is the
// only honest way to know when the last one is done. An attribute alone cannot do
// it: the inner busy(true) would not re-snapshot, the first busy(false) would
// delete the snapshot, and the second would find nothing to restore — leaving the
// panel disabled forever.
function setEditorBusy(busy) {
  // The 0 -> 1 edge has to be sampled BEFORE the counter moves: a busy(false)
  // that only drops the depth from 2 to 1 is still an "active" call, and
  // snapshotting there would record the disabled state we just set ourselves.
  const entering = busy && editorBusyDepth === 0;
  editorBusyDepth = Math.max(0, editorBusyDepth + (busy ? 1 : -1));
  const active = editorBusyDepth > 0;
  const controls = [
    pagePrev, pageNext, zoomOut, zoomIn, zoomFit, revertPageBtn, discardAllBtn,
    applyBtn, saveBtn, textInput, fontFamily, fontSize, textColor, boldToggle, italicToggle,
  ];
  if (pageChips) controls.push(...Array.from(pageChips.children));
  if (editorGrid) editorGrid.setAttribute("aria-busy", String(active));
  controls.forEach((el) => {
    if (!el) return;
    if (active) {
      // Snapshot once, on the way in; deeper windows must not overwrite it with
      // the "true" we just wrote.
      if (entering) el.dataset.edWasDisabled = el.disabled ? "true" : "false";
      el.disabled = true;
    } else if (el.hasAttribute("data-ed-was-disabled")) {
      el.disabled = el.dataset.edWasDisabled === "true";
      delete el.dataset.edWasDisabled;
    } else {
      // No snapshot means the control only showed up while the panel was locked —
      // a freshly rendered page chip. The busy branch disabled it, so the restore
      // has to re-enable it or it stays dead after the run.
      el.disabled = false;
    }
  });
  // Still locked: these two manage exactly the states the lock is overriding.
  if (active) return;
  // The snapshot was taken before the run, so a blind restore would undo states
  // that changed since: the page-prev button is legitimately disabled on the
  // first page and the fit button at 100%. Re-assert both edges after the restore.
  syncPageNav();
  syncZoom();
}

// On a phone the editor opens well below the fold, so a freshly opened file used
// to show nothing but chrome. Bring the page up once per open — doing it on every
// page turn or re-render would yank the view while the user is reading.
function revealStage() {
  if (!edStage) return false;
  const rect = edStage.getBoundingClientRect();
  // The site header is sticky, so anything scrolled to the very top hides under
  // it; leave that much room and the page stays fully visible.
  const siteNav = document.querySelector(".nav");
  const offset = (siteNav ? siteNav.getBoundingClientRect().height : 0) + 8;
  if (rect.top >= offset && rect.bottom <= window.innerHeight) return false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Anchor on the page-nav row, not the whole toolbar: the nav is what the user
  // needs to turn the page, and on a phone the toolbar is taller than the space
  // left over once the page itself is on screen. The stage is the first child of
  // the grid, so the nav has to be found from its own button, not from a sibling.
  const nav = (pagePrev && pagePrev.closest(".ed-pagenav")) || document.querySelector(".ed-toolbar");
  const navHeight = nav ? nav.getBoundingClientRect().height : 0;
  const fitsTogether = rect.height + navHeight + offset <= window.innerHeight;
  const anchorTop = fitsTogether && nav ? nav.getBoundingClientRect().top : rect.top;
  window.scrollTo({ top: Math.max(0, Math.round(anchorTop + window.scrollY - offset)), behavior: reducedMotion ? "auto" : "smooth" });
  return true;
}

function resetEditor(clearStatus = true) {
  renderToken++;
  loadToken++;
  draft = null;
  baseLayer = null;
  if (pdf) {
    const stale = pdf;
    pdf = null;
    Promise.resolve(stale.destroy()).catch(() => {});
  }
  // A card left open over a file that is being torn down would keep its buttons
  // live, so the dialog goes before anything else is cleared.
  if (confirmOpen) closeConfirm();
  currentFile = null;
  pending.clear();
  textCache.clear();
  pageMeta = [];
  editCount = 0;
  currentPage = 0;
  selectedIndex = -1;
  zoom = 1;
  displayScale = 1;
  if (pageOverlay) pageOverlay.innerHTML = "";
  if (pageChips) pageChips.innerHTML = "";
  if (textInput) textInput.value = "";
  syncZoom();
  syncPageNav();
  if (editorShell) editorShell.hidden = true;
  if (dropzone) dropzone.hidden = false;
  if (clearStatus) setStatus("");
}
