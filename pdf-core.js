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

// Reorder cards with pointer capture so dragging stays attached to the pointer
// even when it moves beyond the original card. Works for touch, pen and mouse,
// so a workspace never needs a second, browser-driven drag implementation.
//
// options.pointerTypes widens which pointer kinds may start a drag (default
// touch+pen, the historical behaviour) and options.scrollContainer names the
// element that should be nudged at its edges when that is not the container --
// a wrapping grid never overflows itself, so its scrolling ancestor is the one
// that has to move. Both options are optional; callers that pass neither behave
// exactly as before.
function wireTouchSort(container, selector, getItem, onSort, options = {}) {
  if (!container) return;
  const pointerTypes = options.pointerTypes || ["touch", "pen"];
  const threshold = options.threshold || 6;
  const resolveScroller = () => {
    const el = typeof options.scrollContainer === "function" ? options.scrollContainer() : options.scrollContainer;
    return el || container;
  };
  // overflow:hidden still accepts programmatic scrolling, visible/clip does not,
  // so an axis that is neither is never worth trying to nudge.
  const canScrollAxis = (value) => value !== "visible" && value !== "clip";
  let state = null;
  let swallowClick = false;
  container.addEventListener("pointerdown", (event) => {
    if (!pointerTypes.includes(event.pointerType) || event.button !== 0 || event.target.closest("button, input, label")) return;
    const node = event.target.closest(selector);
    if (!node || !container.contains(node)) return;
    const children = [...container.querySelectorAll(selector)];
    const scroller = resolveScroller();
    const style = getComputedStyle(scroller);
    state = {
      node, pointerId: event.pointerId, pointerType: event.pointerType,
      x: event.clientX, y: event.clientY, active: false,
      scroller,
      scrollX: canScrollAxis(style.overflowX),
      scrollY: canScrollAxis(style.overflowY),
      order: children.map(getItem),
      rects: new Map(children.map((child) => [getItem(child), child.getBoundingClientRect()])),
    };
    try { node.setPointerCapture(event.pointerId); } catch {}
  });
  container.addEventListener("pointermove", (event) => {
    if (!state || event.pointerId !== state.pointerId) return;
    // A re-render mid-drag (a PDF thumbnail finishing, a file being removed) replaces
    // every node, which detaches the one being dragged. Re-inserting it afterwards
    // would put a stale copy back beside its replacement and duplicate a file, so
    // end the gesture cleanly and leave whatever order the re-render produced.
    if (!state.node.isConnected || state.node.parentElement !== container) { state = null; return; }
    if (!state.active && Math.hypot(event.clientX - state.x, event.clientY - state.y) < threshold) return;
    state.active = true;
    state.node.classList.add("touch-dragging");
    event.preventDefault();
    const { scroller } = state;
    if (state.scrollX && scroller.scrollWidth > scroller.clientWidth) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientX < bounds.left + 32) scroller.scrollLeft -= 18;
      else if (event.clientX > bounds.right - 32) scroller.scrollLeft += 18;
    }
    if (state.scrollY && scroller.scrollHeight > scroller.clientHeight) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientY < bounds.top + 32) scroller.scrollTop -= 18;
      else if (event.clientY > bounds.bottom - 32) scroller.scrollTop += 18;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(selector);
    if (!target || target === state.node || !container.contains(target)) return;
    const rect = target.getBoundingClientRect();
    const horizontal = state.scrollX && scroller.scrollWidth > scroller.clientWidth;
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
    // A completed mouse drag is still followed by a click on whatever sat under
    // the pointer at release; swallowing just that one click stops the drop from
    // registering as a tap. Touch already has its own click suppression rules.
    if (current.pointerType === "mouse") {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
    }
    const ordered = [...container.querySelectorAll(selector)].map(getItem);
    if (ordered.some((item, index) => item !== current.order[index])) onSort(ordered, current.rects);
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", finish);
  // Callers that suspend work mid-gesture need to know it is over even when the
  // order did not change and onSort never runs.
  if (typeof options.onEnd === "function") {
    container.addEventListener("pointerup", () => options.onEnd(), true);
    container.addEventListener("pointercancel", () => options.onEnd(), true);
  }
  container.addEventListener("click", (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);
}

// A file counts as a PDF by the type it reports or by its name, because either
// one can be wrong on its own: a renamed .docx arrives as application/pdf, and a
// real PDF sometimes arrives with an empty type.
function isPdfFile(f) {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
}

// Word, PowerPoint and Excel. office-to-pdf.js is asked when the page has it,
// and the name is used when it does not, so a strip that offers them still
// knows which files to accept.
function isOfficeFile(f) {
  if (window.SwiftOffice && window.SwiftOffice.isOfficeFile) return window.SwiftOffice.isOfficeFile(f);
  return /\.(docx|pptx|xlsx)$/i.test(f.name);
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

  wireTouchSort(strip, ".chip", (chip) => chip._fileStripItem, (ordered, rects) => {
    if (ordered.length !== items.length || ordered.some((entry) => !items.includes(entry))) return;
    items = ordered;
    hideResultBar();
    render({ rects, fromIndex: -1 });
  }, {
    // Mouse included so one gesture reorders a chip the same way with a finger
    // or a cursor. The HTML5 handlers this replaces gave no drop preview, needed
    // a second insertion rule kept in sync by hand, and lost track of the
    // dragged chip whenever a PDF thumbnail arrived and re-rendered the strip.
    pointerTypes: ["mouse", "touch", "pen"],
    onEnd: flushPending,
  });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canAnimate = () => !reduceMotion && items.length < 150;

  function captureRects() {
    const map = new Map();
    Array.from(strip.children).forEach((el, i) => map.set(items[i], el.getBoundingClientRect()));
    return map;
  }

  // A thumbnail that finishes while the user is mid-drag must not rebuild the
  // strip under their finger: that both cancels the reorder (the node being
  // dragged is detached) and makes the whole list appear to jump. Hold the call
  // and apply it once the gesture is over - the drag's own render flushes it.
  let renderPending = null;
  let renderBackstop = 0;
  function flushPending() {
    clearTimeout(renderBackstop);
    renderBackstop = 0;
    if (!renderPending) return;
    const held = renderPending;
    renderPending = null;
    render(held);
  }
  // Puts one finished thumbnail onto its own chip and leaves every other chip
  // exactly as it is. That is what keeps the row still while thumbnails arrive
  // one at a time, instead of the strip flashing once per file.
  function applyThumbToChip(item) {
    if (!item || !item.url) return false;
    const chip = [...strip.children].find((el) => el._fileStripItem === item);
    if (!chip) return false;
    const current = chip.querySelector(".chip-thumb");
    if (current && current.getAttribute("src") === item.url) return true;
    const img = document.createElement("img");
    img.className = "chip-thumb";
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    img.src = item.url;
    const fallback = chip.querySelector(".chip-fallback");
    if (fallback) chip.replaceChild(img, fallback);
    else chip.insertBefore(img, chip.firstChild);
    return true;
  }

  function render(opts = {}) {
    // moment would call closeAllMenus() and snatch the menu out from under the user.
    if (strip.querySelector(".chip.touch-dragging")) {
      renderPending = opts;
      // Belt and braces: a gesture can end without a pointer event reaching
      // the page (an interrupted touch, a system gesture, the captured element
      // being removed). Without this backstop the strip would never repaint.
      if (!renderBackstop) renderBackstop = setTimeout(flushPending, 400);
      return;
    }
    renderPending = null;
    // A thumbnail arriving mid-interaction must not snatch an open chip menu out
    // from under the user; every other render still tidies up as before.
    if (!opts.keepMenus) closeAllMenus();
    strip.innerHTML = "";
    const frag = document.createDocumentFragment();

    items.forEach((item, i) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip._fileStripItem = item;
      chip.dataset.i = i;
      let thumb;
      if (item.url) {
        thumb = document.createElement("img");
        // An <img> is draggable on its own. Left alone it starts a native drag on
        // the first move, which cancels the pointer gesture the reorder is built
        // on and leaves the strip showing an order the model never agreed to.
        thumb.draggable = false;
        // Every render() replaces the chips, so each thumbnail is decoded afresh.
        // Async keeps that decode off the main thread, which matters most during
        // a drag, when the pointer handler is the only thing driving the frame.
        thumb.className = "chip-thumb";

        thumb.decoding = "async";
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
            // Hand the chip back to the stylesheet once the slide has finished.
            // Leaving the inline transition behind outranks the .chip rule from
            // then on, and that also stops any later rule from being able to
            // switch transitions off - the drag guard needs to do exactly that.
            const release = () => {
              el.style.transition = "";
              el.style.removeProperty("transform");
              el.removeEventListener("transitionend", release);
            };
            el.addEventListener("transitionend", release);
            setTimeout(release, 400);
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
        if (accept === "pdf" || accept === "pdf-office") queuePdfThumb(item);
      }
      else skipped++;
    }
    if (skipped) flashStatus(`${skipped} file(s) skipped — supported types: ${acceptLabel()}.`, "error");
    render({ rects: null, fromIndex });
  }

  function matches(f) {
    if (accept === "pdf") return isPdfFile(f);
    if (accept === "pdf-office") return isPdfFile(f) || isOfficeFile(f);
    if (accept === "image") {
      // Let the browser's image decoder decide which image formats it can actually read.
      return /^image\//i.test(f.type || "") || /\.(jpe?g|jpe|jfif|png|webp|gif|bmp|dib|avif|apng|tif|tiff|ico|svg|heic|heif)$/i.test(f.name);
    }
    return false;
  }
  function makesThumb() { return accept === "image"; }
  function acceptLabel() {
    if (accept === "pdf") return "PDF files";
    if (accept === "pdf-office") return "PDF files, or Word, PowerPoint and Excel files (.docx, .pptx, .xlsx)";
    return "image formats supported by your browser";
  }

  // Sequential queue so many PDFs render their first page one after another
  let thumbChain = Promise.resolve();
  const thumbDone = new WeakSet();
  // A thumbnail is a nicety, and it costs the whole file being read and parsed
  // to produce one 160-pixel image. On a big batch of scans that is most of the
  // memory the page will ever need, spent before the user has pressed Merge - so
  // the queue gives up after a while and the rest keep their fallback tile.
  const MAX_PDF_THUMBS = 40;
  const MAX_THUMB_BYTES = 24 * 1024 * 1024;
  let pdfThumbsMade = 0;

  function queuePdfThumb(item) {
    if (thumbDone.has(item)) return;
    if (pdfThumbsMade >= MAX_PDF_THUMBS || item.file.size > MAX_THUMB_BYTES) return;
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
      let source;
      if (isOfficeFile(item.file)) {
        // A .docx/.pptx/.xlsx is not a PDF, so pdf.js cannot open it. Convert the
        // first page instead; the engine is fetched here, because this is the
        // first moment an Office file has actually been opened.
        let office;
        try { office = await loadOfficeToPdf(); } catch (err) { return; }
        const converted = await office.toPdf(item.file);
        // Hand pdf.js its own copy: it detaches the buffer it is handed.
        source = new Uint8Array(converted.bytes).slice();
      } else {
        source = new Uint8Array(await item.file.arrayBuffer());
      }
      pdf = await pdfjs.getDocument({ data: source }).promise;
      page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const s = 160 / base.width;
      const viewport = page.getViewport({ scale: s });
      canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.8));
      pdfThumbsMade += 1;
      if (blob && items.includes(item)) {
        item.url = URL.createObjectURL(blob);
        // Only this one chip changes. Rebuilding the whole strip re-created
        // every <img>, so the page flashed and the row appeared to shake
        // once per file as each thumbnail decoded again.
        applyThumbToChip(item);
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

// Depth-counted so overlapping work (a user dropping a second file while the
// first is still opening) cannot lose the lock and leave controls permanently
// disabled. The snapshot is taken only on the 0 -> 1 edge and restored only when
// the count returns to 0, which is what the old attribute-presence check got
// wrong. Restore targets [data-was-disabled] rather than the original selector so
// a control that appeared mid-operation is handed back too.
let toolBusyDepth = 0;

function setToolBusy(busy) {
  if (busy) toolBusyDepth++;
  else toolBusyDepth = Math.max(0, toolBusyDepth - 1);
  const locked = toolBusyDepth > 0;

  const selector = "#dropzone button, #toolbar button, #organizerToolbar button, #numberOptions button, #themePanel button, #workspaceOverlay button, #organizerWorkspace button, #cropOverlay button";
  const buttons = busy ? document.querySelectorAll(selector) : document.querySelectorAll("[data-was-disabled]");
  buttons.forEach((button) => {
    if (busy) {
      if (!button.hasAttribute("data-was-disabled")) button.dataset.wasDisabled = button.disabled ? "true" : "false";
      button.disabled = true;
    } else if (toolBusyDepth === 0 && button.hasAttribute("data-was-disabled")) {
      button.disabled = button.dataset.wasDisabled === "true";
      delete button.dataset.wasDisabled;
    }
  });

  const inputs = busy
    ? document.querySelectorAll('#fileInput, #imageInput, #replaceImageInput, #themePanel input')
    : document.querySelectorAll("#fileInput[data-was-disabled], #imageInput[data-was-disabled], #replaceImageInput[data-was-disabled], #themePanel input[data-was-disabled]");
  inputs.forEach((input) => {
    if (busy) {
      if (!input.hasAttribute("data-was-disabled")) input.dataset.wasDisabled = input.disabled ? "true" : "false";
      input.disabled = true;
    } else if (toolBusyDepth === 0 && input.hasAttribute("data-was-disabled")) {
      input.disabled = input.dataset.wasDisabled === "true";
      delete input.dataset.wasDisabled;
    }
  });

  document.querySelectorAll(".file-strip-wrap, #pageGrid, #editorGrid").forEach((surface) => {
    if (busy) {
      if (!surface.hasAttribute("data-was-pointer-events")) surface.dataset.wasPointerEvents = surface.style.pointerEvents || "";
      surface.style.pointerEvents = "none";
    } else if (toolBusyDepth === 0 && surface.hasAttribute("data-was-pointer-events")) {
      surface.style.pointerEvents = surface.dataset.wasPointerEvents;
      delete surface.dataset.wasPointerEvents;
    }
  });

  const status = document.getElementById("status");
  if (status) {
    status.classList.toggle("working", locked);
    if (locked) status.setAttribute("aria-busy", "true");
    else status.removeAttribute("aria-busy");
  }
}

/* ---------- Result bar (download + preview) ---------- */

// A merge of a lot of files, or a conversion of a lot of images, asks the
// browser for one very large buffer. When a device runs out of room the buffer
// comes back short, and a short PDF is not a PDF: the reader still offers a
// download, the file lands on disk, and it will not open. Nothing downstream can
// tell, because the caller believes it handed over a finished document.
//
// So the bytes are checked before the result bar settles on them. Both ends are
// read rather than the whole thing - a PDF's header is its first five bytes and
// its trailer is in the last kilobyte - so this costs nothing on a large file.
async function assertLooksLikePdf(blob) {
  if (!blob || typeof blob.arrayBuffer !== "function" || blob.size < 32) return;
  let header, trailer;
  try {
    header = String.fromCharCode(...new Uint8Array(await blob.slice(0, 5).arrayBuffer()));
    trailer = String.fromCharCode(...new Uint8Array(await blob.slice(Math.max(0, blob.size - 2048)).arrayBuffer()));
  } catch (err) {
    return;  // A browser that will not slice a blob will not be told about it.
  }
  if (header === "%PDF-" && trailer.includes("%%EOF")) return;
  throw new RangeError(
    "This device ran out of memory part way through, so the file that came back is incomplete " +
    "and will not open. Try again with fewer or smaller files, or close other tabs and retry."
  );
}

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
  if (extension === "pdf") {
    // The download is offered and withdrawn a moment later if the bytes turn out
    // not to be a PDF. The check is kept out of the call signature on purpose:
    // showResult is synchronous and is called straight from a dozen tools, and
    // awaiting here would put the whole appearance of the bar behind a promise
    // to read two kilobytes.
    assertLooksLikePdf(blob).catch((error) => {
      // A later result has already taken the bar over; leave that one alone.
      if (bar._resultUrl !== url) return;
      URL.revokeObjectURL(url);
      bar._resultUrl = null;
      bar.hidden = true;
      setStatus(error.message, "error");
    });
  }
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

  // A page may arrive either with its bytes already decoded or as a data URL.
  // The decoders upstream stopped producing data URLs, because a base64 string
  // costs two bytes per character and buildPdf had to decode it straight back
  // again; the data URL form is kept for the camera and for any caller still
  // passing one.
  const imageBytes = (p) => (p.bytes instanceof Uint8Array ? p.bytes : dataUrlBytes(p.dataUrl));

  pages.forEach((p, i) => {
    const jpegBytes = imageBytes(p);
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

// An A4 page holds roughly 3500 pixels at 300 dpi, so a longer side beyond that
// is being shrunk past the point where the extra pixels can still be seen.
// Capping here rather than higher is what stops a phone photograph being
// carried into the PDF at several times the size it needs to be.
const MAX_PAGE_SIDE_PX = 4096;
function toJpegPage(file, crop) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    // Decoded off the main thread so a large photo does not stall the conversion
    // between onload firing and the drawImage call.
    img.decoding = "async";
    img.onload = () => {
      try {
        URL.revokeObjectURL(url);
        if (!img.naturalWidth || !img.naturalHeight) throw new Error("The image has no readable pixels.");
        const maxSide = MAX_PAGE_SIDE_PX;
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
        // JPEG has no transparency, so a PNG that has any comes out with a black
        // background unless the canvas is filled first.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, cx, cy, cw, ch, 0, 0, w, h);
        // toBlob rather than toDataURL: a data URL is the JPEG base64-encoded
        // into a string, and a string costs two bytes per character, so asking
        // for one holds about two and a half times the picture before buildPdf
        // has decoded it back into bytes. On a folder of photographs that was
        // the largest single thing between this tool and finishing.
        canvas.toBlob((blob) => {
          canvas.width = 0; canvas.height = 0;
          const failed = () => reject(new Error(`Could not convert ${file.name}. This image format may not be supported by your browser.`));
          if (!blob) { failed(); return; }
          blob.arrayBuffer().then((buffer) => resolve({ bytes: new Uint8Array(buffer), w, h }), failed);
        }, "image/jpeg", 0.92);
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

/* ---------- Office converter and writer loaders ---------- */
// office-to-pdf.js and file-writers.js are this site's own two heaviest scripts,
// 41 KB gzipped between them, and neither is needed until a Word, PowerPoint or
// Excel file is actually in play. They are fetched on first use here, exactly as
// the three CDN libraries above are, so a visit that never opens an Office file
// never pays for them.
function loadSiteScript(url, missingMessage) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(missingMessage));
    document.head.appendChild(s);
  });
}

const OFFICE_TO_PDF_URL = "office-to-pdf.js";
const OFFICE_TO_PDF_MISSING =
  "The Word, PowerPoint and Excel converter could not load. Check your internet connection, reload this page and try again.";
let officeToPdfLoadPromise = null;

function loadOfficeToPdf() {
  if (window.SwiftOffice) return Promise.resolve(window.SwiftOffice);
  if (officeToPdfLoadPromise) return officeToPdfLoadPromise;
  officeToPdfLoadPromise = loadSiteScript(OFFICE_TO_PDF_URL, OFFICE_TO_PDF_MISSING)
    .then(() => {
      if (!window.SwiftOffice) throw new Error("The Word, PowerPoint and Excel converter loaded but could not be started.");
      return window.SwiftOffice;
    })
    .catch((error) => { officeToPdfLoadPromise = null; throw error; });
  return officeToPdfLoadPromise;
}

const FILE_WRITERS_URL = "file-writers.js";
const FILE_WRITERS_MISSING =
  "The Word, Excel and PowerPoint writer could not load. Check your internet connection, reload this page and try again.";
let fileWritersLoadPromise = null;

function loadFileWriters() {
  if (window.SwiftFileWriters) return Promise.resolve(window.SwiftFileWriters);
  if (fileWritersLoadPromise) return fileWritersLoadPromise;
  fileWritersLoadPromise = loadSiteScript(FILE_WRITERS_URL, FILE_WRITERS_MISSING)
    .then(() => {
      if (!window.SwiftFileWriters) throw new Error("The Word, Excel and PowerPoint writer loaded but could not be started.");
      return window.SwiftFileWriters;
    })
    .catch((error) => { fileWritersLoadPromise = null; throw error; });
  return fileWritersLoadPromise;
}

/* ---------- Shared PDF compression (pages re-rendered as JPEG) ---------- */

// The three trade-offs the Merge tool already offers, under the same level names
// so one control can be reused verbatim: the render scale and the JPEG quality
// move together, because a page drawn at 1.2x cannot show detail a 0.5 JPEG
// encoder threw away.
const PDF_COMPRESS_LEVELS = {
  small: { scale: 1.2, jpeg: 0.5, label: "Smallest" },
  medium: { scale: 1.6, jpeg: 0.68, label: "Balanced" },
  high: { scale: 2.0, jpeg: 0.85, label: "Best quality" },
};

// toDataURL would hand back a base64 string, which costs roughly 2.7 bytes of
// memory for every byte of image; the raw blob bytes are what the writer wants.
function encodeCanvasJpeg(canvas, jpegQuality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("This browser could not encode a page as an image."));
      try {
        resolve(new Uint8Array(await blob.arrayBuffer()));
      } catch (err) {
        reject(err);
      }
    }, "image/jpeg", jpegQuality);
  });
}

// Streaming PDF writer. buildPdf() cannot start until it has every page, so a long
// document would sit in memory as one base64 string per page and then again as a
// separate copy of the finished file. Here each page is appended to the output the
// moment it is encoded, and the catalog and page tree are written last, once the
// page count is known. The objects produced are the same ones buildPdf produces, so
// readers see the same document either way.
function createStreamingPdfWriter() {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [0];
  let length = 0;
  let pages = 0;

  const write = (data) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const beginObj = (num) => {
    offsets[num] = length;
    write(`${num} 0 obj\n`);
  };

  write("%PDF-1.4\n");
  // Marker bytes go out raw; as characters they would be UTF-8 encoded into
  // eight bytes that no longer read as the binary marker.
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  return {
    // Pages fill their media box edge to edge, keeping the size the page had.
    addPage(jpeg, w, h, pageWidth, pageHeight) {
      const i = pages++;
      const imgObj = 3 + i * 3;
      const contentObj = 4 + i * 3;
      const pageObj = 5 + i * 3;
      const pageW = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 595.28;
      const pageH = Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 841.89;
      const scale = Math.min(pageW / w, pageH / h);
      const dw = w * scale, dh = h * scale;
      const x = (pageW - dw) / 2, y = (pageH - dh) / 2;

      beginObj(imgObj);
      write(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      write(jpeg);
      write("\nendstream\nendobj\n");

      const content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${i} Do Q`;
      beginObj(contentObj);
      write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

      beginObj(pageObj);
      write(`<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)} ] /Resources << /XObject << /Im${i} ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);
    },

    // Returns one contiguous Uint8Array. Each part is released as it is copied in,
    // so the peak is the finished file rather than twice the finished file.
    finish() {
      const kids = [];
      for (let i = 0; i < pages; i++) kids.push(`${5 + i * 3} 0 R`);
      beginObj(1);
      write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
      beginObj(2);
      write(`<< /Type /Pages /Count ${pages} /Kids [ ${kids.join(" ")} ] >>\nendobj\n`);

      const total = 3 + pages * 3;
      const xrefStart = length;
      let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
      for (let i = 1; i < total; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
      xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
      write(xref);

      const out = new Uint8Array(length);
      let pos = 0;
      for (let i = 0; i < parts.length; i++) {
        out.set(parts[i], pos);
        pos += parts[i].length;
        parts[i] = null;
      }
      parts.length = 0;
      return out;
    },
  };
}

// Re-render a PDF's pages as JPEGs and rebuild it smaller. The only way to make a
// PDF meaningfully smaller in a browser is to throw away the vector page and keep
// a picture of it, so this always costs something: the text is no longer
// selectable or searchable, and links and form fields go with it. That is said out
// loud in the returned warnings rather than left for the caller to remember.
//
//   bytes     Uint8Array | ArrayBuffer - the PDF to compress
//   level     "small" | "medium" | "high", defaulting to "medium"
//   onProgress (done, total, message) - called once per page, after it is encoded;
//             the message is a ready-to-show status line, so a caller can ignore
//             the counts and just write the third argument into its status area
//
// Returns a NEW Uint8Array, so the caller's own copy is untouched and the size of
// the input is still available for the "N KB -> M KB, saved X" line.
async function compressPdfBytes(bytes, options = {}) {
  const opts = options || {};
  const q = PDF_COMPRESS_LEVELS[opts.level] || PDF_COMPRESS_LEVELS.medium;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (!source.length) throw new Error("This PDF is empty, so there is nothing to compress.");

  const pdfjs = await loadPdfJs();
  // pdf.js detaches the buffer it is handed, so it gets a copy of its own.
  const doc = await pdfjs.getDocument({ data: source.slice() }).promise;
  const out = createStreamingPdfWriter();
  const total = doc.numPages;
  let done = 0;
  try {
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      const pageSize = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: q.scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("This browser could not prepare a page for compression.");
        await page.render({ canvasContext: ctx, viewport }).promise;
        out.addPage(
          await encodeCanvasJpeg(canvas, q.jpeg),
          canvas.width,
          canvas.height,
          pageSize.width,
          pageSize.height
        );
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
      done = n;
      if (onProgress) onProgress(n, total, `Compressing — page ${n} of ${total}…`);
    }
  } finally {
    await doc.destroy();
  }
  // A page-less document would come out as a file no reader can open.
  if (!done) throw new Error("This PDF has no pages to compress.");

  const result = out.finish();
  const warnings = [
    "Compressing redraws every page as an image, so the text in the copy is no longer selectable or searchable.",
  ];
  const delta = source.length - result.length;
  if (delta < 0) {
    warnings.push("Re-encoding made this PDF bigger: it was already well compressed, so the original is the better copy.");
  } else if (delta === 0) {
    warnings.push("The compressed copy came out the same size as the original.");
  }
  return { bytes: result, warnings };
}

// A page that ships merge.js declares its own compressPdfBytes, and a classic
// script's later declaration wins, so this namespace is the handle that cannot be
// overwritten by a page-specific helper.
window.SwiftPdfCompress = { compressPdfBytes, levels: PDF_COMPRESS_LEVELS };
