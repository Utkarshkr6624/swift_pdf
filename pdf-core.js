// Shared helpers used by every tool page.

// Keep modal dismissal consistent and give the backdrop a brief exit motion.
// The token prevents an old transition callback from hiding a modal reopened quickly.
function showModalOverlay(overlay) {
  if (!overlay) return;
  clearTimeout(overlay._swiftPdfCloseTimer);
  if (overlay._swiftPdfCloseHandler) {
    overlay.removeEventListener("transitionend", overlay._swiftPdfCloseHandler);
    overlay._swiftPdfCloseHandler = null;
  }
  overlay._swiftPdfCloseToken = (overlay._swiftPdfCloseToken || 0) + 1;
  overlay.classList.remove("is-closing");
  overlay.inert = false;
  overlay.removeAttribute("aria-hidden");
  overlay.hidden = false;
}

function hideModalOverlay(overlay, onHidden) {
  if (!overlay || overlay.hidden) {
    if (onHidden) onHidden();
    return;
  }

  const token = (overlay._swiftPdfCloseToken || 0) + 1;
  overlay._swiftPdfCloseToken = token;
  overlay.inert = true;
  overlay.setAttribute("aria-hidden", "true");

  const finish = (event) => {
    if (event && (event.target !== overlay || event.propertyName !== "opacity")) return;
    if (overlay._swiftPdfCloseToken !== token) return;
    clearTimeout(overlay._swiftPdfCloseTimer);
    overlay.removeEventListener("transitionend", finish);
    overlay._swiftPdfCloseHandler = null;
    overlay.hidden = true;
    overlay.classList.remove("is-closing");
    overlay.inert = false;
    overlay.removeAttribute("aria-hidden");
    if (onHidden) onHidden();
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }

  overlay._swiftPdfCloseHandler = finish;
  overlay.addEventListener("transitionend", finish);
  overlay.classList.add("is-closing");
  // Fallback for browsers that skip transitionend when the tab is backgrounded.
  overlay._swiftPdfCloseTimer = setTimeout(finish, 240);
}

/* ---------- File strip (horizontal, with per-file "…" menu) ---------- */
function placeChipMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  const pad = 8;
  const mw = Math.max(180, menu.offsetWidth);
  const mh = menu.offsetHeight;
  let left = r.right - mw;
  if (left < pad) left = pad;
  if (left + mw > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - mw - pad);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - pad) top = Math.max(pad, r.top - mh - 6);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  menu.style.right = "auto";
}

// A chip's hover transform makes it the containing block for a position:fixed
// menu inside it, so open menus live under <body> until closed.
function closeAllMenus() {
  document.querySelectorAll(".menu.open").forEach((m) => {
    m.classList.remove("open");
    if (m._home && m.parentElement !== m._home) m._home.appendChild(m);
  });
}

// Reorder cards on touch devices with pointer capture so dragging remains
// attached to the finger even when it moves beyond the original card.
function wireTouchSort(container, selector, getItem, onSort) {
  if (!container) return;
  let state = null;
  container.addEventListener("pointerdown", (event) => {
    if ((event.pointerType !== "touch" && event.pointerType !== "pen") || event.button !== 0 || event.target.closest("button, input, label")) return;
    const node = event.target.closest(selector);
    if (!node || !container.contains(node)) return;
    const children = [...container.querySelectorAll(selector)];
    state = {
      node, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false,
      order: children.map(getItem),
      rects: new Map(children.map((child) => [getItem(child), child.getBoundingClientRect()])),
    };
    try { node.setPointerCapture(event.pointerId); } catch {}
  });
  container.addEventListener("pointermove", (event) => {
    if (!state || event.pointerId !== state.pointerId) return;
    if (!state.active && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 6) return;
    state.active = true;
    state.node.classList.add("touch-dragging");
    event.preventDefault();
    if (container.scrollWidth > container.clientWidth) {
      const bounds = container.getBoundingClientRect();
      if (event.clientX < bounds.left + 32) container.scrollLeft -= 18;
      else if (event.clientX > bounds.right - 32) container.scrollLeft += 18;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(selector);
    if (!target || target === state.node || !container.contains(target)) return;
    const rect = target.getBoundingClientRect();
    const horizontal = container.scrollWidth > container.clientWidth;
    const after = horizontal
      ? event.clientX > rect.left + rect.width / 2
      : event.clientY > rect.top + rect.height / 2 ||
        (Math.abs(event.clientY - (rect.top + rect.height / 2)) < rect.height / 3 && event.clientX > rect.left + rect.width / 2);
    const reference = after ? target.nextElementSibling : target;
    if (reference !== state.node && reference !== state.node.nextElementSibling) container.insertBefore(state.node, reference || null);
  }, { passive: false });
  const finish = (event) => {
    if (!state || (event && event.pointerId !== state.pointerId)) return;
    const current = state;
    state = null;
    current.node.classList.remove("touch-dragging");
    if (!current.active) return;
    const ordered = [...container.querySelectorAll(selector)].map(getItem);
    if (ordered.some((item, index) => item !== current.order[index])) onSort(ordered, current.rects);
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", finish);
}

function createFileStrip({ input, stripEl, accept, toolbar, extraMenu, onChange }) {
  let items = []; // { file, url?, isPdf }
  const wrap = document.createElement("div");
  wrap.className = "file-strip-wrap";
  const strip = document.createElement("div");
  strip.className = "file-strip";
  const arrows = document.createElement("div");
  arrows.className = "strip-arrows";
  const leftBtn = document.createElement("button");
  leftBtn.className = "strip-arrow";
  leftBtn.type = "button";
  leftBtn.setAttribute("aria-label", "Scroll left");
  leftBtn.innerHTML = "&#8249;";
  const rightBtn = document.createElement("button");
  rightBtn.className = "strip-arrow";
  rightBtn.type = "button";
  rightBtn.setAttribute("aria-label", "Scroll right");
  rightBtn.innerHTML = "&#8250;";
  arrows.className = "strip-actions";
  arrows.append(leftBtn, rightBtn);
  wrap.append(strip, arrows);
  stripEl.replaceWith(wrap);

  const scrollAmt = () => Math.max(240, wrap.clientWidth * 0.7);
  function updateArrows() {
    const max = strip.scrollWidth - strip.clientWidth;
    arrows.style.display = max > 4 ? "flex" : "none";
    leftBtn.disabled = strip.scrollLeft <= 4;
    rightBtn.disabled = strip.scrollLeft >= max - 4;
  }
  leftBtn.addEventListener("click", () => strip.scrollBy({ left: -scrollAmt(), behavior: "smooth" }));
  rightBtn.addEventListener("click", () => strip.scrollBy({ left: scrollAmt(), behavior: "smooth" }));
  strip.addEventListener("scroll", () => {
    updateArrows();
    closeAllMenus();
  }, { passive: true });
  window.addEventListener("resize", updateArrows);

  let dragFrom = -1; // index currently being drag-reordered

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canAnimate = () => !reduceMotion && items.length < 150;

  function captureRects() {
    const map = new Map();
    Array.from(strip.children).forEach((el, i) => map.set(items[i], el.getBoundingClientRect()));
    return map;
  }

  function render(opts = {}) {
    closeAllMenus();
    strip.innerHTML = "";
    const frag = document.createDocumentFragment();

    items.forEach((item, i) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.draggable = true;
      chip._fileStripItem = item;
      chip.dataset.i = i;
      chip.addEventListener("dragstart", (e) => {
        dragFrom = i;
        chip.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", item.file.name); } catch {}
      });
      chip.addEventListener("dragend", () => {
        dragFrom = -1;
        chip.classList.remove("dragging");
        hideResultBar();
        // DOM was reordered directly; re-render so menu buttons hold fresh indices
        render();
      });
      chip.addEventListener("dragover", (e) => {
        if (dragFrom === -1) return;
        e.preventDefault();
        const targetIdx = [...strip.children].indexOf(chip);
        if (targetIdx === -1 || targetIdx === dragFrom) return;
        // move the DOM node directly — no re-render, no jitter
        const moving = strip.children[dragFrom];
        if (targetIdx < dragFrom) strip.insertBefore(moving, chip);
        else strip.insertBefore(moving, chip.nextSibling);
        const [moved] = items.splice(dragFrom, 1);
        items.splice(targetIdx, 0, moved);
        dragFrom = targetIdx;
      });

      let thumb;
      if (item.url) {
        thumb = document.createElement("img");
        thumb.src = item.url;
        thumb.alt = "";
      } else {
        thumb = document.createElement("div");
        thumb.className = "chip-fallback";
        const ext = item.file.name.split(".").pop().toUpperCase().slice(0, 4);
        thumb.textContent = ext.toUpperCase();
      }
      chip.appendChild(thumb);

      const name = document.createElement("span");
      name.className = "chip-name";
      name.textContent = item.file.name;
      name.title = item.file.name;
      const size = document.createElement("span");
      size.className = "chip-size";
      size.textContent = formatSize(item.file.size);
      chip.append(name, size);

      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.className = "chip-menu-btn";
      menuBtn.setAttribute("aria-label", "More options for " + item.file.name);
      menuBtn.textContent = "…";

      const menu = document.createElement("div");
      menu.className = "menu";
      const mvLeft = document.createElement("button");
      mvLeft.textContent = "Move earlier";
      mvLeft.disabled = i === 0;
      const mvRight = document.createElement("button");
      mvRight.textContent = "Move later";
      mvRight.disabled = i === items.length - 1;
      const rm = document.createElement("button");
      rm.textContent = "Remove";
      rm.className = "danger";
      menu.append(mvLeft, mvRight, rm);
      if (extraMenu) extraMenu(item, menu, i);

      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = menu.classList.contains("open");
        closeAllMenus();
        if (!wasOpen) {
          menu._home = chip;
          document.body.appendChild(menu);
          menu.classList.add("open");
          placeChipMenu(menu, menuBtn);
        }
      });
      mvLeft.addEventListener("click", () => {
        hideResultBar();
        const rects = canAnimate() ? captureRects() : null;
        [items[i - 1], items[i]] = [items[i], items[i - 1]];
        render({ rects, fromIndex: i });
      });
      mvRight.addEventListener("click", () => {
        hideResultBar();
        const rects = canAnimate() ? captureRects() : null;
        [items[i + 1], items[i]] = [items[i], items[i + 1]];
        render({ rects, fromIndex: i });
      });
      rm.addEventListener("click", () => {
        const doRemove = () => {
          hideResultBar();
          if (item.url) URL.revokeObjectURL(item.url);
          const rects = canAnimate() ? captureRects() : null;
          items.splice(i, 1);
          render({ rects, fromIndex: i });
        };
        if (canAnimate()) {
          chip.classList.add("chip-out");
          chip.addEventListener("animationend", doRemove, { once: true });
        } else doRemove();
      });
      chip.append(menuBtn, menu);

      const x = document.createElement("button");
      x.type = "button";
      x.className = "chip-x";
      x.setAttribute("aria-label", "Remove " + item.file.name);
      x.textContent = "✕";
      x.addEventListener("click", () => rm.click());
      chip.appendChild(x);

      frag.appendChild(chip);
    });

    strip.appendChild(frag);

    // FLIP: animate chips that moved from their previous positions
    if (opts.rects && reduceMotion === false) {
      strip.querySelectorAll(".chip").forEach((el, i) => {
        const old = opts.rects.get(items[i]);
        if (!old) {
          if (canAnimate() && opts.fromIndex != null && i >= opts.fromIndex)
            el.classList.add("chip-in");
          return;
        }
        const dx = old.left - el.getBoundingClientRect().left;
        if (Math.abs(dx) > 1) {
          el.style.transition = "none";
          el.style.transform = `translateX(${dx}px)`;
          requestAnimationFrame(() => {
            el.style.transition = "transform .3s cubic-bezier(.2,.8,.2,1)";
            el.style.transform = "";
          });
        }
      });
    }

    toolbar.hidden = items.length === 0;
    if (typeof onChange === "function") onChange(items.length);
    const workspaceOverlay = document.getElementById("workspaceOverlay");
    if (workspaceOverlay && !workspaceOverlay.hidden && typeof renderWorkspace === "function") renderWorkspace();
    requestAnimationFrame(updateArrows);
    if (!toolbar.hidden && canAnimate()) {
      toolbar.classList.remove("revealed");
      void toolbar.offsetWidth;
      toolbar.classList.add("revealed");
    }
  }

  const docClickHandler = (e) => {
    if (!e.target.closest(".menu") && !e.target.closest(".chip-menu-btn"))
      closeAllMenus();
  };
  document.addEventListener("click", docClickHandler);

  function addFiles(list) {
    let skipped = 0;
    const fromIndex = items.length;
    if (list && list.length) hideResultBar();
    for (const f of list) {
      if (matches(f)) {
        const item = { file: f, url: makesThumb() ? URL.createObjectURL(f) : null, crop: null };
        items.push(item);
        if (accept === "pdf") queuePdfThumb(item);
      }
      else skipped++;
    }
    if (skipped) flashStatus(`${skipped} file(s) skipped — supported types: ${acceptLabel()}.`, "error");
    render({ rects: null, fromIndex });
  }

  function matches(f) {
    if (accept === "pdf") return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    if (accept === "image") {
      // Let the browser's image decoder decide which image formats it can actually read.
      return /^image\//i.test(f.type || "") || /\.(jpe?g|jpe|jfif|png|webp|gif|bmp|dib|avif|apng|tif|tiff|ico|svg|heic|heif)$/i.test(f.name);
    }
    return false;
  }
  function makesThumb() { return accept === "image"; }
  function acceptLabel() { return accept === "pdf" ? "PDF files" : "image formats supported by your browser"; }

  // Sequential queue so many PDFs render their first page one after another
  let thumbChain = Promise.resolve();
  const thumbDone = new WeakSet();

  function queuePdfThumb(item) {
    if (thumbDone.has(item)) return;
    thumbDone.add(item);
    thumbChain = thumbChain.then(() => renderPdfThumb(item)).catch(() => {
      // failed (offline or corrupt PDF) — keep the fallback tile
    });
  }

  async function renderPdfThumb(item) {
    let pdf = null;
    let page = null;
    let canvas = null;
    try {
      const pdfjs = await loadPdfJs();
      const data = await item.file.arrayBuffer();
      pdf = await pdfjs.getDocument({ data }).promise;
      page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const s = 160 / base.width;
      const viewport = page.getViewport({ scale: s });
      canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.8));
      if (blob && items.includes(item)) {
        item.url = URL.createObjectURL(blob);
        render({ rects: null, fromIndex: -1 });
      }
    } catch (err) {
      // keep fallback tile
    } finally {
      if (page) page.cleanup();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      if (pdf) await pdf.destroy();
    }
  }

  return {
    get items() { return items; },
    render: () => render(),
    addFiles,
    clear() {
      items.forEach((it) => { if (it.url) URL.revokeObjectURL(it.url); });
      items = [];
      render();
      hideResultBar();
      const status = document.getElementById("status");
      if (status) setStatus("");
    },
  };
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function setStatus(msg, kind = "") {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg == null ? "" : String(msg);
  el.className = "status" + (kind ? " " + kind : "");
  // Keep progress announcements calm, but announce failures immediately.
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  el.setAttribute("aria-atomic", "true");
}
const flashStatus = setStatus;

// Translate common browser/PDF-library failures into a next step people can use.
function explainProcessingError(error, action, filename) {
  const message = error && error.message ? String(error.message) : String(error || "");
  const name = error && error.name ? String(error.name) : "";
  const subject = filename ? `“${filename}”` : "this file";
  const lower = `${name} ${message}`.toLowerCase();

  if (name === "AbortError" || /usercancelled|user canceled|operation was aborted/i.test(message)) {
    return "Processing was interrupted. Choose the file again and retry when you are ready.";
  }
  if (/passwordexception|password.?protected|incorrect password|password was not accepted|requires? (?:an? )?open password|encrypted/i.test(lower)) {
    return `${subject} needs its correct open password. Enter the password and try again; SwiftPDF cannot recover or guess it.`;
  }
  if (/out of memory|memory limit|allocation failed|quotaexceeded|array buffer allocation/i.test(lower)) {
    return `${action} ran out of memory on this device. Try fewer files, smaller files, or close other tabs and retry.`;
  }
  if (/failed to fetch|networkerror|loading chunk|import\(\).*failed|pdf processing engine/i.test(lower)) {
    return "The PDF processing tools could not load. Check your internet connection, reload this page, and retry.";
  }
  if (/invalidpdfexception|missingpdfexception|invalid pdf|malformed|unexpected eof|xref|cross.?reference|pdf header|file is corrupted/i.test(lower)) {
    return `${subject} could not be read as a valid PDF. Open it in a PDF reader and save a fresh copy, then retry.`;
  }
  if (/unsupported|not supported|decode|encoding|image format|could not read image/i.test(lower)) {
    return `${action} could not read ${subject}. Try opening it in another app and saving it as a supported PDF or image format.`;
  }

  // Preserve useful messages created by the tool itself; hide low-level JS errors.
  const isTechnical = /^(typeerror|referenceerror|syntaxerror|rangeerror|unknownerror):/i.test(message) ||
    /(?:\.js:\d+| at (?:async )?[\w$.]+\s*\(|cannot read properties of undefined|is not a function)/i.test(message);
  if (message && !isTechnical && message.length <= 220) return message;
  return `${action} could not finish. Check that ${subject} opens correctly, then retry with a smaller file if needed.`;
}

function wireDropzone(dropzone, input, addFn) {
  dropzone.addEventListener("click", () => { if (!input.disabled) input.click(); });
  dropzone.addEventListener("keydown", (e) => { if (!input.disabled && (e.key === "Enter" || e.key === " ")) input.click(); });
  input.addEventListener("change", () => {
    addFn(input.files);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
  dropzone.addEventListener("drop", (e) => { if (!input.disabled) addFn(e.dataTransfer.files); });
}

function setToolBusy(busy) {
  const selector = "#dropzone button, #toolbar button, #organizerToolbar button, #numberOptions button, #themePanel button, #workspaceOverlay button, #organizerWorkspace button, #cropOverlay button";
  document.querySelectorAll(selector).forEach((button) => {
    if (busy) {
      if (!button.hasAttribute("data-was-disabled")) button.dataset.wasDisabled = button.disabled ? "true" : "false";
      button.disabled = true;
    } else if (button.hasAttribute("data-was-disabled")) {
      button.disabled = button.dataset.wasDisabled === "true";
      delete button.dataset.wasDisabled;
    }
  });
  document.querySelectorAll('#fileInput, #imageInput, #replaceImageInput, #themePanel input').forEach((input) => {
    if (busy) { input.dataset.wasDisabled = input.disabled ? "true" : "false"; input.disabled = true; }
    else if (input.hasAttribute("data-was-disabled")) {
      input.disabled = input.dataset.wasDisabled === "true";
      delete input.dataset.wasDisabled;
    }
  });
  document.querySelectorAll(".file-strip-wrap, #pageGrid, #editorGrid").forEach((surface) => {
    if (busy) {
      if (!surface.hasAttribute("data-was-pointer-events")) surface.dataset.wasPointerEvents = surface.style.pointerEvents || "";
      surface.style.pointerEvents = "none";
    } else if (surface.hasAttribute("data-was-pointer-events")) {
      surface.style.pointerEvents = surface.dataset.wasPointerEvents;
      delete surface.dataset.wasPointerEvents;
    }
  });
  const status = document.getElementById("status");
  if (status) {
    status.classList.toggle("working", busy);
    if (busy) status.setAttribute("aria-busy", "true");
    else status.removeAttribute("aria-busy");
  }
}

/* ---------- Result bar (download + preview) ---------- */
function hideResultBar() {
  const bar = document.getElementById("resultBar");
  if (!bar) return;
  if (bar._resultUrl) URL.revokeObjectURL(bar._resultUrl);
  bar._resultUrl = null;
  bar.hidden = true;
}

function wireStartAnother(input, reset) {
  const button = document.getElementById("newJobBtn");
  if (!button) return;
  button.addEventListener("click", () => {
    hideResultBar();
    if (typeof reset === "function") reset();
    if (input) input.click();
  });
}

function showResult(blob, filename, extension = "pdf") {
  const bar = document.getElementById("resultBar");
  if (!bar) throw new Error("The result area is missing. Reload this page and retry.");
  if (bar._resultUrl) URL.revokeObjectURL(bar._resultUrl);
  const url = URL.createObjectURL(blob);
  bar._resultUrl = url;
  const download = document.getElementById("downloadBtn");
  if (!download) throw new Error("The download button is missing. Reload this page and retry.");
  download.onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    const nameInput = document.getElementById("fileName");
    const given = nameInput && nameInput.value.trim();
    a.download = (given ? given.trim() : "") || filename || "swiftpdf";
    if (!a.download.toLowerCase().endsWith("." + extension)) a.download += "." + extension;
    a.click();
  };
  let preview = document.getElementById("previewBtn");
  if (extension === "pdf" && !preview) {
    preview = document.createElement("button");
    preview.type = "button";
    preview.id = "previewBtn";
    preview.className = "btn btn-ghost";
    preview.textContent = "Preview PDF";
    const actions = download.parentElement;
    if (actions && actions !== bar) actions.insertBefore(preview, download);
    else bar.insertBefore(preview, download);
  }
  if (preview && !preview.hasAttribute("aria-controls")) preview.hidden = extension !== "pdf";
  if (preview && !preview.hasAttribute("aria-controls")) {
    preview.setAttribute("aria-label", `Preview ${extension.toUpperCase()} output`);
    preview.onclick = () => {
      const opened = window.open(url, "_blank");
      if (!opened) setStatus("Your browser blocked the preview window. Allow pop-ups for this site or download the file.", "error");
      else opened.opener = null;
    };
  }
  const ext = document.querySelector(".result-bar .name-ext");
  if (ext) ext.textContent = "." + extension;
  bar.hidden = false;
  bar.tabIndex = -1;
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", `${extension.toUpperCase()} result ready`);
  bar.classList.remove("revealed");
  void bar.offsetWidth;
  bar.classList.add("revealed");
  setStatus(`Your ${extension.toUpperCase()} is ready. ${preview && extension === "pdf" ? "Preview it or download it." : "Download it when you are ready."}`, "success");
  bar.focus({ preventScroll: true });
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  bar.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
  return url;
}

/* ---------- Shared PDF generation (no external libraries) ---------- */
function dataUrlBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// pages: [{ dataUrl: "data:image/jpeg;base64,...", w, h }]
function buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [0];

  const write = (s) => {
    const data = typeof s === "string" ? enc.encode(s) : s;
    chunks.push(data);
    offset += data.length;
  };
  const beginObj = (num) => {
    offsets[num] = offset;
    write(`${num} 0 obj\n`);
  };

  const n = pages.length;
  const pageObj = (i) => 3 + i;
  const imgObj = (i) => 3 + n + i * 2;
  const contentObj = (i) => 4 + n + i * 2;

  const defaultPageW = 595.28, defaultPageH = 841.89;

  write("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");

  beginObj(1);
  write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObj(2);
  write(`<< /Type /Pages /Count ${n} /Kids [ ${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")} ] >>\nendobj\n`);

  pages.forEach((p, i) => {
    const jpegBytes = dataUrlBytes(p.dataUrl);
    // Most image-to-PDF pages use A4; PDF compression can supply original page dimensions.
    const pageW = Number.isFinite(p.pageWidth) && p.pageWidth > 0 ? p.pageWidth : defaultPageW;
    const pageH = Number.isFinite(p.pageHeight) && p.pageHeight > 0 ? p.pageHeight : defaultPageH;
    const requestedMargin = Number.isFinite(p.margin) ? Math.max(0, p.margin) : 24;
    const margin = Math.min(requestedMargin, pageW / 2, pageH / 2);
    const maxW = Math.max(1, pageW - margin * 2), maxH = Math.max(1, pageH - margin * 2);
    const scale = Math.min(maxW / p.w, maxH / p.h);
    const w = p.w * scale, h = p.h * scale;
    const x = (pageW - w) / 2, y = (pageH - h) / 2;

    beginObj(imgObj(i));
    write(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
    write(jpegBytes);
    write("\nendstream\nendobj\n");

    const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${i} Do Q`;
    beginObj(contentObj(i));
    write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

    beginObj(pageObj(i));
    write(`<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)} ] /Resources << /XObject << /Im${i} ${imgObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>\nendobj\n`);
  });

  const total = contentObj(n - 1) + 1;
  const xrefStart = offset;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  write(xref);

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

/* ---------- Image helpers ---------- */
function toJpegPage(file, crop) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        URL.revokeObjectURL(url);
        if (!img.naturalWidth || !img.naturalHeight) throw new Error("The image has no readable pixels.");
        const maxSide = 4096;
        let cx = 0, cy = 0, cw = img.naturalWidth, ch = img.naturalHeight;
        if (crop) {
          cx = Math.max(0, Math.min(Number(crop.x) || 0, img.naturalWidth - 1));
          cy = Math.max(0, Math.min(Number(crop.y) || 0, img.naturalHeight - 1));
          cw = Math.max(1, Math.min(Number(crop.w) || 1, img.naturalWidth - cx));
          ch = Math.max(1, Math.min(Number(crop.h) || 1, img.naturalHeight - cy));
        }
        const scale = Math.min(1, maxSide / Math.max(cw, ch));
        const w = Math.max(1, Math.round(cw * scale));
        const h = Math.max(1, Math.round(ch * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("This browser could not prepare the image.");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, cx, cy, cw, ch, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        canvas.width = 0; canvas.height = 0;
        resolve({ dataUrl, w, h });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not convert ${file.name}. This image format may not be supported by your browser.`));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read image ${file.name}. Try a browser-supported image format.`)); };
    img.src = url;
  });
}

/* ---------- pdf.js loader ---------- */
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
let pdfJsLoadPromise = null;

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfJsLoadPromise) return pdfJsLoadPromise;
  pdfJsLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFJS_URL;
    s.onload = () => {
      if (!window.pdfjsLib) return reject(new Error("The PDF engine loaded but could not be initialized."));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("Could not load the PDF engine. Check your internet connection and reload."));
    document.head.appendChild(s);
  }).catch((error) => { pdfJsLoadPromise = null; throw error; });
  return pdfJsLoadPromise;
}

/* ---------- pdf-lib loader ---------- */
const PDFLIB_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
let pdfLibLoadPromise = null;

function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (pdfLibLoadPromise) return pdfLibLoadPromise;
  pdfLibLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFLIB_URL;
    s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error("The PDF engine loaded but could not be initialized."));
    s.onerror = () => reject(new Error("Could not load the PDF engine. Check your internet connection and reload."));
    document.head.appendChild(s);
  }).catch((error) => { pdfLibLoadPromise = null; throw error; });
  return pdfLibLoadPromise;
}

/* ---------- JSZip loader ---------- */
const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
let jsZipLoadPromise = null;

function loadJsZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (jsZipLoadPromise) return jsZipLoadPromise;
  jsZipLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = JSZIP_URL;
    s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error("Could not load the ZIP engine."));
    s.onerror = () => reject(new Error("Could not load the ZIP engine. Check your internet connection and reload."));
    document.head.appendChild(s);
  }).catch((error) => { jsZipLoadPromise = null; throw error; });
  return jsZipLoadPromise;
}
