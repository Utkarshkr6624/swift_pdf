// Shared helpers used by every tool page.

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

function createFileStrip({ input, stripEl, accept, toolbar, extraMenu }) {
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
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
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
    strip.innerHTML = "";
    const frag = document.createDocumentFragment();

    items.forEach((item, i) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.draggable = true;
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
        document.querySelectorAll(".menu.open").forEach((m) => { if (m !== menu) m.classList.remove("open"); });
        menu.classList.toggle("open");
        if (menu.classList.contains("open")) placeChipMenu(menu, menuBtn);
      });
      mvLeft.addEventListener("click", () => {
        const rects = canAnimate() ? captureRects() : null;
        [items[i - 1], items[i]] = [items[i], items[i - 1]];
        render({ rects, fromIndex: i });
      });
      mvRight.addEventListener("click", () => {
        const rects = canAnimate() ? captureRects() : null;
        [items[i + 1], items[i]] = [items[i], items[i + 1]];
        render({ rects, fromIndex: i });
      });
      rm.addEventListener("click", () => {
        const doRemove = () => {
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
    requestAnimationFrame(updateArrows);
    if (!toolbar.hidden && canAnimate()) {
      toolbar.classList.remove("revealed");
      void toolbar.offsetWidth;
      toolbar.classList.add("revealed");
    }
  }

  const docClickHandler = (e) => {
    if (!e.target.closest(".menu") && !e.target.closest(".chip-menu-btn"))
      document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
  };
  document.addEventListener("click", docClickHandler);

  function addFiles(list) {
    let skipped = 0;
    const fromIndex = items.length;
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
    if (accept === "image") return f.type.startsWith("image/") && f.type !== "image/gif";
    return false;
  }
  function makesThumb() { return accept === "image"; }
  function acceptLabel() { return accept === "pdf" ? "PDF files" : "JPG, PNG, WebP"; }

  // Sequential queue so many PDFs render their first page one after another
  let thumbChain = Promise.resolve();
  const thumbDone = new WeakSet();

  function queuePdfThumb(item) {
    if (thumbDone.has(item.file)) return;
    thumbDone.add(item.file);
    thumbChain = thumbChain.then(() => renderPdfThumb(item)).catch(() => {
      // failed (offline or corrupt PDF) — keep the fallback tile
    });
  }

  async function renderPdfThumb(item) {
    try {
      const pdfjs = await loadPdfJs();
      const data = await item.file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const s = 160 / base.width;
      const viewport = page.getViewport({ scale: s });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.8));
      if (blob && items.includes(item)) {
        item.url = URL.createObjectURL(blob);
        render({ rects: null, fromIndex: -1 });
        // refresh the workspace grid too if it's open
        const wsOverlay = document.getElementById("workspaceOverlay");
        if (wsOverlay && !wsOverlay.hidden && typeof renderWorkspace === "function") renderWorkspace();
      }
      pdf.cleanup && pdf.cleanup();
    } catch (err) {
      // keep fallback tile
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
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}
const flashStatus = setStatus;

function wireDropzone(dropzone, input, addFn) {
  dropzone.addEventListener("click", () => input.click());
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", () => { addFn(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
  dropzone.addEventListener("drop", (e) => addFn(e.dataTransfer.files));
}

/* ---------- Result bar (download + preview) ---------- */
function showResult(blob, filename) {
  const bar = document.getElementById("resultBar");
  const url = URL.createObjectURL(blob);
  document.getElementById("downloadBtn").onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    const nameInput = document.getElementById("fileName");
    const given = nameInput && nameInput.value.trim();
    a.download = (given ? given.trim() : "") || filename || "swiftpdf";
    if (!/\.pdf$/i.test(a.download)) a.download += ".pdf";
    a.click();
  };
  const preview = document.getElementById("previewBtn");
  if (preview) preview.onclick = () => window.open(url, "_blank");
  bar.hidden = false;
  bar.classList.remove("revealed");
  void bar.offsetWidth;
  bar.classList.add("revealed");
  setStatus("Your PDF is ready.", "success");
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

  const pageW = 595.28, pageH = 841.89, margin = 24;
  const maxW = pageW - margin * 2, maxH = pageH - margin * 2;

  write("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");

  beginObj(1);
  write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObj(2);
  write(`<< /Type /Pages /Count ${n} /Kids [ ${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")} ] >>\nendobj\n`);

  pages.forEach((p, i) => {
    const jpegBytes = dataUrlBytes(p.dataUrl);
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
      URL.revokeObjectURL(url);
      const maxSide = 4096;
      let cx = 0, cy = 0, cw = img.naturalWidth, ch = img.naturalHeight;
      if (crop) {
        cx = Math.min(crop.x, img.naturalWidth - 1);
        cy = Math.min(crop.y, img.naturalHeight - 1);
        cw = Math.max(1, Math.min(crop.w, img.naturalWidth - cx));
        ch = Math.max(1, Math.min(crop.h, img.naturalHeight - cy));
      }
      const scale = Math.min(1, maxSide / Math.max(cw, ch));
      const w = Math.max(1, Math.round(cw * scale));
      const h = Math.max(1, Math.round(ch * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, cx, cy, cw, ch, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.92), w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image: " + file.name)); };
    img.src = url;
  });
}

/* ---------- pdf.js loader ---------- */
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFJS_URL;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("Could not load the PDF engine. Check your internet connection and reload."));
    document.head.appendChild(s);
  });
}

/* ---------- pdf-lib loader ---------- */
const PDFLIB_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";

function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFLIB_URL;
    s.onload = () => resolve(window.PDFLib);
    s.onerror = () => reject(new Error("Could not load the PDF engine. Check your internet connection and reload."));
    document.head.appendChild(s);
  });
}