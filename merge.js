// Merge PDF tool — merges PDFs via pdf-lib; Word, PowerPoint and Excel files
// are converted to PDF here first, and what that conversion loses is said out loud
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");

const compressToggle = document.getElementById("compressToggle");
const compressQuality = document.getElementById("compressQuality");

// Same scale/JPEG levels the standalone compress tool uses, so a file compressed
// here comes out the same as one compressed there.
const COMPRESS_QUALITY = {
  small: { scale: 1.2, jpeg: 0.5, label: "Smallest" },
  medium: { scale: 1.6, jpeg: 0.68, label: "Balanced" },
  high: { scale: 2.0, jpeg: 0.85, label: "Best quality" },
};
let compressLevel = "medium";

if (compressToggle && compressQuality) {
  compressToggle.addEventListener("change", () => {
    compressQuality.hidden = !compressToggle.checked;
  });
  compressQuality.querySelectorAll(".pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      compressQuality.querySelectorAll(".pill").forEach((p) => p.classList.remove("selected"));
      pill.classList.add("selected");
      compressLevel = pill.dataset.q;
    });
  });
}

const strip = createFileStrip({ input: fileInput, stripEl, accept: "pdf-office", toolbar });
wireDropzone(dropzone, fileInput, (f) => strip.addFiles(f));
wireStartAnother(fileInput, () => strip.clear());

clearBtn.addEventListener("click", () => strip.clear());

// Older Office formats the browser cannot open, named before any work starts. The
// newer .docx/.pptx/.xlsx files are converted instead, so these are the ones worth
// stopping for rather than failing halfway through a merge.
const LEGACY_OFFICE = /\.(doc|ppt|xls|odt|ods|odp|rtf)$/i;

// office-to-pdf.js answers this from the file name, and the page repeats the test
// only to notice an Office file before the engine is known to have loaded.
const OFFICE_NAME = /\.(docx|pptx|xlsx)$/i;

// Keeps the result bar to one readable sentence. The converted filenames and
// the engine's warnings matter, but they are reference detail, not the headline.
function showMergeNotes(converted, warnings, extra) {
  const details = document.getElementById("mergeNotes");
  const body = document.getElementById("mergeNotesBody");
  const summary = document.getElementById("mergeNotesSummary");
  if (!details || !body) return;
  const convertedNames = converted || [];
  const notes = (warnings || []).concat(extra || []);
  if (!convertedNames.length && !notes.length) { details.hidden = true; return; }
  body.innerHTML = "";
  if (convertedNames.length) {
    const label = document.createElement("p");
    label.className = "merge-notes-label";
    label.textContent = `Converted from ${convertedNames.length} file${convertedNames.length === 1 ? "" : "s"}:`;
    const list = document.createElement("ul");
    convertedNames.forEach((name) => { const li = document.createElement("li"); li.textContent = name; list.appendChild(li); });
    body.append(label, list);
  }
  if (notes.length) {
    const label = document.createElement("p");
    label.className = "merge-notes-label";
    label.textContent = "Differences from the originals:";
    const list = document.createElement("ul");
    notes.forEach((note) => { const li = document.createElement("li"); li.textContent = note; list.appendChild(li); });
    body.append(label, list);
  }
  if (summary) summary.textContent = convertedNames.length
    ? `Converted ${convertedNames.length} file${convertedNames.length === 1 ? "" : "s"} — what could not be kept`
    : "What could not be kept";
  details.hidden = false;
  details.open = false;
}

convertBtn.addEventListener("click", async () => {
  const items = strip.items;
  if (!items.length) return;
  const legacy = items.find((it) => LEGACY_OFFICE.test(it.file.name));
  if (legacy) {
    setStatus(`${legacy.file.name} is an older Word, PowerPoint or Excel file. SwiftPDF opens the newer .docx, .pptx and .xlsx files; open this one in the app it came from and save it in the newer format, or save it as PDF, then merge again.`, "error");
    return;
  }

  setToolBusy(true);
  convertBtn.disabled = true;
  hideResultBar();
  setStatus("Merging…");
  // Declared out here on purpose: a let inside the try block is not in scope in
  // the catch, so the error handler could not name the file that failed.
  let currentName = items[0] && items[0].file.name;

  try {
    const pdfLib = await loadPdfLib();
    const merged = await pdfLib.PDFDocument.create();
    const flattenedFiles = [];
    const converted = [];
    const officeWarnings = [];
    // office-to-pdf.js is 41 KB gzipped on its own and nothing here needs it
    // until an Office file is in play, so it is fetched now rather than on page
    // load. If it did not come, an Office file has no way through, and a missing
    // script is a different problem from a damaged document, so it is named as one.
    let office = null;
    if (items.some((it) => OFFICE_NAME.test(it.file.name))) {
      try {
        office = await loadOfficeToPdf();
      } catch (loadError) {
        console.warn(loadError);
      }
      if (!office) {
        throw new Error("The Word, PowerPoint and Excel converter did not load. Reload the page and try again.");
      }
    }
    // With no engine to ask, the name is all there is to go on — and it is
    // what the engine answers with anyway, so the two routes cannot disagree.
    const isOffice = (file) => (office ? office.isOfficeFile(file) : OFFICE_NAME.test(file.name));
    for (const item of items) {
      currentName = item.file.name;
      let bytes;
      let added = item.file.name;
      if (isOffice(item.file)) {
        bytes = await convertOfficeFile(item.file, officeWarnings);
        converted.push(item.file.name);
        added = item.file.name + " (converted to PDF)";
      } else {
        bytes = await item.file.arrayBuffer();
      }
      try {
        // Do not bypass encryption checks here: pdf-lib can copy encrypted streams without decrypting them.
        // Its normal error path sends restricted PDFs through the PDF.js renderer below instead.
        const src = await pdfLib.PDFDocument.load(bytes);
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      } catch (vectorError) {
        // Keep processing readable PDFs with unsupported features by flattening that file's pages.
        console.warn("Using rendered-page fallback for", item.file.name, vectorError);
        await appendRenderedPdf(merged, bytes, pdfLib, item.file.name);
        flattenedFiles.push(item.file.name);
      }
      setStatus("Merging… added " + added);
    }
    const mergedBytes = await merged.save();
    const inputSize = items.reduce((total, it) => total + it.file.size, 0);
    let bytes = mergedBytes;
    let compressed = false;
    let note = "";
    if (compressToggle && compressToggle.checked) {
      setStatus("Compressing the merged PDF…");
      const q = COMPRESS_QUALITY[compressLevel] || COMPRESS_QUALITY.medium;
      bytes = await compressPdfBytes(mergedBytes, pdfLib, q, merged.getPageCount());
      compressed = true;
      const saved = Math.max(0, mergedBytes.length - bytes.length);
      note = saved > 0
        ? ` Compressed at ${q.label} quality — ${formatSize(mergedBytes.length)} → ${formatSize(bytes.length)}, saving ${formatSize(saved)}.`
        : ` Compressed at ${q.label} quality, but the file was already lean, so it is about the same size.`;
    }
    const blob = new Blob([bytes], { type: "application/pdf" });
    showResult(blob, "merged.pdf");
    const resultText = document.querySelector(".result-text");
    if (converted.length) {
      // The conversion is lossy, so its warnings are shown word for word rather
      // than summarised away: someone merging a Hindi or Chinese document has to
      // be told that those characters come out as "?".
      const extra = [];
      if (compressed) extra.push(note.trim());
      if (flattenedFiles.length) {
        extra.push(`${flattenedFiles.length === 1 ? flattenedFiles[0] : `${flattenedFiles.length} PDFs`} needed a compatibility fallback, so those pages were rendered as images.`);
      }
      // One short line, and everything else behind a disclosure. Dumping every
      // filename and every warning into this sentence made the result unreadable
      // on a merge of a dozen files, and then repeated it in the status line.
      resultText.textContent = `Merged ${items.length} file${items.length === 1 ? "" : "s"} — ${formatSize(bytes.length)}. ${converted.length} converted to PDF first.`;
      showMergeNotes(converted, officeWarnings, extra);
      setStatus(`Merged ${items.length} file${items.length === 1 ? "" : "s"} — ${formatSize(bytes.length)}. ${converted.length} Word, PowerPoint or Excel file${converted.length === 1 ? " was" : "s were"} converted here first.`, "success");
    } else if (compressed && flattenedFiles.length) {
      resultText.textContent = `Merged and compressed. ${flattenedFiles.length === 1 ? flattenedFiles[0] : `${flattenedFiles.length} PDFs`} needed a compatibility fallback, so those pages were rendered as images.${note}`;
      setStatus("Merged and compressed. Some pages were rendered for compatibility.", "success");
    } else if (compressed) {
      resultText.textContent = `Merged ${items.length} PDF${items.length === 1 ? "" : "s"} — ${formatSize(bytes.length)}.${note.trim() ? " " + note.trim() : ""}`;
      showMergeNotes([], [], []);
      setStatus(`Merged ${items.length} PDF${items.length === 1 ? "" : "s"} and compressed.${note}`, "success");
    } else if (flattenedFiles.length) {
      const details = flattenedFiles.length === 1 ? flattenedFiles[0] : `${flattenedFiles.length} PDFs`;
      resultText.textContent = `Merged ${inputSize > 0 ? `${items.length} PDFs, ` : ""}${formatSize(bytes.length)}. ${details} needed a compatibility fallback, so those pages may not keep selectable text.`;
      setStatus("Merged successfully. Some pages were rendered for compatibility.", "success");
    } else {
      resultText.textContent = `Merged ${items.length} PDF${items.length === 1 ? "" : "s"} — ${formatSize(bytes.length)}.`;
      setStatus(`Merged ${items.length} PDF${items.length === 1 ? "" : "s"}.`, "success");
    }
  } catch (err) {
    console.error(err);
    setStatus(explainProcessingError(err, "Merging these PDFs", currentName), "error");
  } finally {
    convertBtn.disabled = false;
    setToolBusy(false);
  }
});

// A Word, PowerPoint or Excel file becomes a PDF here, in the browser, before
// the merge starts. The engine's warnings are kept and shown afterwards instead
// of being swallowed: it carries text and images across, not the original layout,
// and characters outside the standard PDF font come out as "?".
async function convertOfficeFile(file, warnings) {
  setStatus(`Converting ${file.name} to PDF…`);
  // Already fetched by the merge above; the loader hands back the same promise.
  const office = await loadOfficeToPdf();
  const result = await office.toPdf(file, {
    onProgress: (done, total, label) => setStatus(`Converting ${file.name} — ${label || `step ${done} of ${total}`}…`),
  });
  for (const warning of result.warnings || []) {
    // Several files of the same kind report the same warning. One copy of each is
    // enough, and the file names are listed beside them.
    if (warnings.indexOf(warning) === -1) warnings.push(warning);
  }
  return result.bytes;
}

async function appendRenderedPdf(target, bytes, pdfLib, filename) {
  const pdfjs = await loadPdfJs();
  let doc;
  const loadDocument = (password) => {
    // Give PDF.js a fresh buffer for every attempt because its worker can transfer the supplied bytes.
    const options = { data: new Uint8Array(bytes.slice(0)) };
    if (password !== undefined) options.password = password;
    return pdfjs.getDocument(options).promise;
  };
  try { doc = await loadDocument(); }
  catch (err) {
    if (!err || err.name !== "PasswordException") {
      throw new Error(`Could not read ${filename}. It may be damaged or use an unsupported PDF feature.`);
    }

    // Try an empty user password first. Permission-restricted PDFs often have no open password.
    try { doc = await loadDocument(""); }
    catch (emptyPasswordError) {
      if (!emptyPasswordError || emptyPasswordError.name !== "PasswordException") throw emptyPasswordError;
      for (let attempt = 0; attempt < 3 && !doc; attempt++) {
        const prompt = attempt === 0
          ? `Enter the open password for ${filename}:`
          : `That password was not accepted. Try again for ${filename} (attempt ${attempt + 1} of 3):`;
        const password = window.prompt(prompt);
        if (password === null) throw new Error(`Merging stopped: ${filename} requires its correct open password.`);
        try { doc = await loadDocument(password); }
        catch (passwordError) {
          if (!passwordError || passwordError.name !== "PasswordException") throw passwordError;
        }
      }
      if (!doc) throw new Error(`The password was not accepted for ${filename}. Enter the correct open password and try again.`);
    }
  }
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      setStatus(`Rendering ${filename} — page ${pageNo} of ${doc.numPages}…`);
      const page = await doc.getPage(pageNo);
      const scale = Math.min(2, 2400 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1]));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const jpeg = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render a PDF page.")), "image/jpeg", 0.92));
        const image = await target.embedJpg(await jpeg.arrayBuffer());
        const pageWidth = viewport.width / scale;
        const pageHeight = viewport.height / scale;
        const outPage = target.addPage([pageWidth, pageHeight]);
        outPage.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    await doc.destroy();
  }
}
// Re-renders every page of the merged document as a JPEG and rebuilds it, which
// is the only way to make a PDF meaningfully smaller in the browser. Pages are
// embedded one at a time and the canvas is released straight after, so memory
// stays flat instead of holding every rendered page at once.
async function compressPdfBytes(mergedBytes, pdfLib, q, totalPages) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(mergedBytes.slice(0)) }).promise;
  const out = await pdfLib.PDFDocument.create();
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const pageSize = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: q.scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
        const jpeg = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render a page."))), "image/jpeg", q.jpeg);
        });
        const image = await out.embedJpg(await jpeg.arrayBuffer());
        // Keep the original page size so the merged layout does not change.
        const outPage = out.addPage([pageSize.width, pageSize.height]);
        outPage.drawImage(image, { x: 0, y: 0, width: pageSize.width, height: pageSize.height });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
      setStatus(`Compressing — page ${pageNo} of ${totalPages || doc.numPages}…`);
    }
  } finally {
    await doc.destroy();
  }
  return out.save();
}

// workspace (edit files)
const wsBtn = document.getElementById("wsBtn");
wsBtn.addEventListener("click", () => openWorkspace(strip));
