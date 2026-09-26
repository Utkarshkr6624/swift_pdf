const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const editorShell = document.getElementById("editorShell");
const pageCanvasWrap = document.getElementById("pageCanvasWrap");
const pageCanvas = document.getElementById("pageCanvas");
const pageOverlay = document.getElementById("pageOverlay");
const pagePrev = document.getElementById("pagePrev");
const pageNext = document.getElementById("pageNext");
const pageCounter = document.getElementById("pageCounter");
const textList = document.getElementById("textList");
const textInput = document.getElementById("textInput");
const fontFamily = document.getElementById("fontFamily");
const fontSize = document.getElementById("fontSize");
const textColor = document.getElementById("textColor");
const boldToggle = document.getElementById("boldToggle");
const italicToggle = document.getElementById("italicToggle");
const applyBtn = document.getElementById("applyBtn");
const revertPageBtn = document.getElementById("revertPageBtn");
const saveBtn = document.getElementById("saveBtn");

const MIN_SCALE = 0.6;
const MAX_SCALE = 2;

let currentFile = null;
let pdf = null;
let pages = [];
let currentPage = 0;
let scale = 1;
let selectedIndex = -1;
let editCount = 0;
const pending = new Map();

const editKey = (pageIndex, itemIndex) => `${pageIndex}:${itemIndex}`;
const pageItems = () => (pages[currentPage] ? pages[currentPage].items : []);

wireDropzone(dropzone, fileInput, (files) => {
  const file = Array.from(files || []).find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!file) return;
  openPdf(file);
});
wireStartAnother(fileInput, resetEditor);

pagePrev.addEventListener("click", () => goToPage(currentPage - 1));
pageNext.addEventListener("click", () => goToPage(currentPage + 1));
applyBtn.addEventListener("click", applyEdit);
revertPageBtn.addEventListener("click", revertPage);
saveBtn.addEventListener("click", savePdf);

let resizeTimer = 0;
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    if (!pdf) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderCanvas(); positionBoxes(); }, 120);
  }).observe(pageCanvasWrap);
} else {
  window.addEventListener("resize", () => {
    if (!pdf) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderCanvas(); positionBoxes(); }, 120);
  });
}

async function openPdf(file) {
  setToolBusy(true);
  hideResultBar();
  resetEditor(false);
  setStatus("Reading this PDF…");
  try {
    if (pdf) await pdf.destroy();
    pdf = null;
    currentFile = file;
    const pdfjs = await loadPdfJs();
    pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const size = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter((entry) => entry.str && entry.str.trim());
      pages.push({ width: size.width, height: size.height, items: items.map((entry) => readItem(entry, size.height)) });
      page.cleanup();
    }
    if (!pages.some((page) => page.items.length)) {
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
    renderTextList();
    const count = pages.reduce((total, page) => total + page.items.length, 0);
    setStatus(`Loaded ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"} with ${count} text item${count === 1 ? "" : "s"}. Click any text on the page to edit it.`, "success");
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Opening this PDF", file.name), "error");
    dropzone.hidden = false;
    editorShell.hidden = true;
  } finally {
    setToolBusy(false);
  }
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

function fitScale() {
  const page = pages[currentPage];
  if (!page) return 1;
  const available = pageCanvasWrap.clientWidth || page.width;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, available / page.width));
}

async function renderCanvas() {
  const page = pages[currentPage];
  if (!pdf || !page) return;
  const pdfPage = await pdf.getPage(currentPage + 1);
  const next = fitScale();
  const viewport = pdfPage.getViewport({ scale: next });
  const ratio = window.devicePixelRatio || 1;
  pageCanvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  pageCanvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  pageCanvas.style.width = `${viewport.width}px`;
  pageCanvas.style.height = `${viewport.height}px`;
  const ctx = pageCanvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  pageCanvasWrap.style.minHeight = `${viewport.height}px`;
  scale = viewport.scale;
  paintEdits();
}

function paintEdits() {
  const page = pages[currentPage];
  if (!page) return;
  const ctx = pageCanvas.getContext("2d");
  ctx.save();
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  page.items.forEach((item, index) => {
    const edit = pending.get(editKey(currentPage, index));
    if (!edit) return;
    ctx.fillStyle = "#ffffff";
    // Match the white box written into the saved PDF so the preview is not wider
    // than the text it covers.
    ctx.fillRect(edit.left * scale, edit.top * scale, edit.boxWidth * scale + 2, edit.boxHeight * scale + 2);
  });
  ctx.restore();
}

function renderBoxes() {
  pageOverlay.innerHTML = "";
  const frag = document.createDocumentFragment();
  pageItems().forEach((item, index) => {
    const box = document.createElement("button");
    box.type = "button";
    box.className = "ed-box";
    box.dataset.index = String(index);
    box.textContent = item.str;
    box.setAttribute("aria-label", `Text: ${item.str.slice(0, 60)}`);
    box.addEventListener("click", () => selectItem(index, true));
    frag.appendChild(box);
  });
  pageOverlay.appendChild(frag);
  positionBoxes();
}

function positionBoxes() {
  const page = pages[currentPage];
  if (!page) return;
  const boxes = pageOverlay.children;
  page.items.forEach((item, index) => {
    const box = boxes[index];
    if (!box) return;
    const edit = pending.get(editKey(currentPage, index));
    const base = styleOfSource(item.fontName);
    const view = edit
      ? { left: edit.left, top: edit.top, boxWidth: edit.boxWidth, boxHeight: edit.boxHeight, size: edit.size, family: edit.family, bold: edit.bold, italic: edit.italic, text: edit.text, color: edit.color }
      : { left: item.left, top: item.top, boxWidth: item.boxWidth, boxHeight: item.boxHeight, size: item.size, family: base.family, bold: base.bold, italic: base.italic, text: item.str };
    box.classList.toggle("is-edited", Boolean(edit));
    box.textContent = view.text;
    box.style.left = `${view.left * scale}px`;
    box.style.top = `${view.top * scale}px`;
    box.style.width = `${Math.max(6, view.boxWidth * scale)}px`;
    box.style.height = `${Math.max(10, view.boxHeight * scale)}px`;
    box.style.fontSize = `${view.size * scale}px`;
    box.style.fontFamily = cssFamily(view.family);
    box.style.fontWeight = view.bold ? "700" : "400";
    box.style.fontStyle = view.italic ? "italic" : "normal";
    box.style.color = edit ? view.color : "";
  });
}

function renderTextList() {
  textList.innerHTML = "";
  const items = pageItems();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "ed-legend";
    empty.textContent = "This page has no text layer to edit.";
    textList.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  items.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ed-item";
    row.dataset.index = String(index);
    row.textContent = item.str;
    row.addEventListener("click", () => selectItem(index, true));
    frag.appendChild(row);
  });
  textList.appendChild(frag);
  syncSelection();
}

function renderPageChips() {
  let host = document.getElementById("pageChips");
  if (!host) {
    const nav = pagePrev.closest(".ed-pagenav") || pagePrev.parentElement || pageCanvasWrap;
    host = document.createElement("div");
    host.id = "pageChips";
    host.className = "ed-pagenav";
    host.setAttribute("aria-label", "All pages");
    nav.parentElement.insertBefore(host, nav.nextSibling);
  }
  host.innerHTML = "";
  const frag = document.createDocumentFragment();
  pages.forEach((_, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ed-page-btn";
    chip.textContent = String(index + 1);
    chip.setAttribute("aria-label", `Go to page ${index + 1}`);
    chip.addEventListener("click", () => goToPage(index));
    frag.appendChild(chip);
  });
  host.appendChild(frag);
  syncPageNav();
}

function syncPageNav() {
  pageCounter.textContent = `Page ${currentPage + 1} of ${pages.length}`;
  pagePrev.disabled = currentPage === 0;
  pageNext.disabled = currentPage === pages.length - 1;
  pagePrev.setAttribute("aria-pressed", String(currentPage > 0));
  pageNext.setAttribute("aria-pressed", String(currentPage < pages.length - 1));
  const host = document.getElementById("pageChips");
  if (!host) return;
  Array.from(host.children).forEach((chip, index) => {
    const active = index === currentPage;
    chip.classList.toggle("is-active", active);
    if (active) chip.setAttribute("aria-current", "page");
    else chip.removeAttribute("aria-current");
  });
}

async function goToPage(index) {
  if (!pages.length) return;
  const next = Math.max(0, Math.min(pages.length - 1, index));
  if (next === currentPage && pageOverlay.children.length) {
    syncPageNav();
    return;
  }
  currentPage = next;
  selectedIndex = -1;
  clearSelectionFields();
  syncPageNav();
  await renderCanvas();
  renderBoxes();
  renderTextList();
  setStatus(`Page ${currentPage + 1}. ${pageItems().length} text item${pageItems().length === 1 ? "" : "s"} on this page.`);
}

function selectItem(index, scroll) {
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
  if (scroll && pageOverlay.children[index] && pageOverlay.children[index].scrollIntoView) {
    pageOverlay.children[index].scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function syncSelection() {
  Array.from(pageOverlay.children).forEach((box, index) => box.classList.toggle("is-selected", index === selectedIndex));
  Array.from(textList.querySelectorAll(".ed-item")).forEach((row, index) => row.classList.toggle("is-active", index === selectedIndex));
  const listRow = textList.querySelectorAll(".ed-item")[selectedIndex];
  if (listRow && listRow.scrollIntoView) listRow.scrollIntoView({ block: "nearest" });
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
    setStatus("Select a text item on the page or in the list first.", "error");
    return;
  }
  const text = textInput.value;
  if (!text.trim()) {
    setStatus("Enter the replacement text before applying.", "error");
    return;
  }
  const size = Math.min(200, Math.max(4, Number(fontSize.value) || item.size));
  const color = textColor.value || "#000000";
  const unchanged = text === item.str;
  const ratio = item.str.length ? text.length / item.str.length : 1;
  pending.set(editKey(currentPage, selectedIndex), {
    text,
    family: fontFamily.value,
    size,
    color,
    bold: boldToggle.checked,
    italic: italicToggle.checked,
    left: item.left,
    top: item.top,
    boxWidth: unchanged ? item.boxWidth : item.boxWidth * Math.max(0.2, Math.min(4, ratio)),
    boxHeight: item.boxHeight,
  });
  editCount = pending.size;
  paintEdits();
  positionBoxes();
  renderTextList();
  setStatus(`Applied on page ${currentPage + 1}. ${editCount} edit${editCount === 1 ? "" : "s"} pending — press “Save edited PDF” to write the file.`, "success");
}

async function revertPage() {
  if (!pages.length) return;
  let removed = 0;
  pages[currentPage].items.forEach((_, index) => {
    if (pending.delete(editKey(currentPage, index))) removed++;
  });
  editCount = pending.size;
  if (!removed) {
    setStatus(`Page ${currentPage + 1} has no applied edits to undo.`);
    return;
  }
  await renderCanvas();
  positionBoxes();
  renderTextList();
  setStatus(`Reverted ${removed} edit${removed === 1 ? "" : "s"} on page ${currentPage + 1}. ${editCount} still pending.`);
}

async function savePdf() {
  if (!currentFile || !pdf) return;
  if (!pending.size) {
    setStatus("No edits have been applied yet. Click a piece of text, type the replacement, and press Apply before saving.", "error");
    return;
  }
  setToolBusy(true);
  saveBtn.disabled = true;
  hideResultBar();
  setStatus("Writing your edited PDF…");
  let usedFallback = false;
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
    const fallback = await fontFor("helvetica", false, false);
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
        const source = pages[pageIndex] && pages[pageIndex].items[entry.itemIndex];
        if (!source) continue;
        const edit = entry.edit;
        const left = Math.max(0, source.x - 1);
        const boxBottom = pageSize.height - edit.top - edit.boxHeight;
        page.drawRectangle({
          x: left,
          y: boxBottom - 1,
          width: edit.boxWidth + 2,
          height: edit.boxHeight + 2,
          color: pdfLib.rgb(1, 1, 1),
        });
        let font = await fontFor(edit.family, edit.bold, edit.italic);
        try {
          font.widthOfTextAtSize(edit.text, edit.size);
        } catch (err) {
          font = fallback;
          usedFallback = true;
        }
        page.drawText(edit.text, {
          x: left,
          y: Math.max(0, source.baselineY - edit.size * 0.2),
          size: edit.size,
          font,
          color: hexToRgb(pdfLib, edit.color),
        });
      }
    }
    const bytes = await out.save();
    const count = pending.size;
    showResult(new Blob([bytes], { type: "application/pdf" }), "edited.pdf");
    setStatus(`Saved ${count} edit${count === 1 ? "" : "s"} across ${byPage.size} page${byPage.size === 1 ? "" : "s"}.${usedFallback ? " Some replacements used a Helvetica fallback because the source font or those characters were not available." : ""}`, "success");
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Editing this PDF", currentFile.name), "error");
  } finally {
    saveBtn.disabled = false;
    setToolBusy(false);
  }
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
  return 'Helvetica, Arial, sans-serif';
}

function hexToRgb(pdfLib, hex) {
  const clean = String(hex || "").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.padEnd(6, "0");
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return pdfLib.rgb(0, 0, 0);
  return pdfLib.rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function resetEditor(clearStatus = true) {
  pending.clear();
  editCount = 0;
  pages = [];
  currentPage = 0;
  selectedIndex = -1;
  pageOverlay.innerHTML = "";
  textList.innerHTML = "";
  const chips = document.getElementById("pageChips");
  if (chips) chips.innerHTML = "";
  editorShell.hidden = true;
  dropzone.hidden = false;
  if (clearStatus) setStatus("");
}
