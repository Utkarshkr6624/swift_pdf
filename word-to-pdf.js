// The file converter: every direction between PDF, Word, Excel and PowerPoint
// except a format to itself — one file at a time, converted on this device.
//
// Every one of those twelve conversions is a rebuild: the words, tables and
// pictures are read out of the file and written again somewhere new. Nothing
// here copies a layout, and every surface says so — the line under the two
// pickers, the toolbar, and the list of warnings shown after a conversion.
// The engine's own warnings are shown, never summarised away, and a conversion
// that would produce an empty file is refused instead of handed over.
//
// A PDF is the hard direction: it has no paragraphs in it, only glyphs at
// coordinates, so the reader below rebuilds the lines, headings and tables on a
// page from where the text sits. That is a reading of the page and not a copy
// of it, and the notes after every PDF conversion say so.
const dropzone = document.getElementById("dropzone");
const dropTitle = document.getElementById("dropTitle");
const dropHint = document.getElementById("dropHint");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const fromSelect = document.getElementById("fromFormat");
const toSelect = document.getElementById("toFormat");
const formatNote = document.getElementById("formatNote");
const pageTitle = document.getElementById("pageTitle");
const toolbar = document.getElementById("toolbar");
const toolbarHint = document.getElementById("toolbarHint");
const fileLabel = document.getElementById("fileLabel");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");
const notesEl = document.getElementById("notes");
const notesTitle = document.getElementById("notesTitle");
const notesList = document.getElementById("notesList");
const resultText = document.getElementById("resultText");
const downloadBtn = document.getElementById("downloadBtn");
const previewBtn = document.getElementById("previewBtn");
const nameExt = document.querySelector(".result-bar .name-ext");
const compressBox = document.getElementById("convertCompress");
const compressToggle = document.getElementById("compressToggle");
const compressQuality = document.getElementById("compressQuality");

// The same scale and JPEG levels the merge tool and the compress tool use, so a
// file compressed here comes out the same as one compressed there.
const COMPRESS_LEVELS = {
  small: { scale: 1.2, jpeg: 0.5, label: "Smallest" },
  medium: { scale: 1.6, jpeg: 0.68, label: "Balanced" },
  high: { scale: 2.0, jpeg: 0.85, label: "Best quality" },
};
let compressLevel = "medium";

if (compressToggle) {
  compressToggle.addEventListener("change", () => {
    if (compressQuality) compressQuality.hidden = !compressToggle.checked;
  });
}
if (compressQuality) {
  compressQuality.querySelectorAll(".pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      compressQuality.querySelectorAll(".pill").forEach((other) => other.classList.remove("selected"));
      pill.classList.add("selected");
      compressLevel = pill.dataset.q;
    });
  });
}

// The four things this page reads. A key is also the file extension, which is
// why the writer names and the office parser names line up with the labels.
const FORMATS = {
  pdf: {
    label: "PDF",
    file: "PDF file (.pdf)",
    pick: "Select a PDF",
    accept: ".pdf,application/pdf",
    article: "a",
  },
  docx: {
    label: "Word",
    file: "Word document (.docx)",
    pick: "Select a Word document",
    accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    article: "a",
  },
  xlsx: {
    label: "Excel",
    file: "Excel workbook (.xlsx)",
    pick: "Select an Excel workbook",
    accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    article: "an",
  },
  pptx: {
    label: "PowerPoint",
    file: "PowerPoint presentation (.pptx)",
    pick: "Select a PowerPoint presentation",
    accept: ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation",
    article: "a",
  },
};

// One sentence per pair, and it is the contract: what the result is, and what
// it is not. It feeds the line under the pickers, and it is the first entry in
// the notes panel after a conversion.
const PAIR_NOTES = {
  "docx>pdf": "The words, tables and pictures are copied into a new PDF set in a standard font. The page size, margins and page breaks are new, and Word's fonts, colours, columns, headers, footnotes and text boxes are not carried over.",
  "docx>xlsx": "Every paragraph, list and table is read out of the document and written into a worksheet as plain text and plain grids. Word's fonts, colours, styles, columns and page design are not carried over, pictures do not go into a spreadsheet, and the result is a sheet of values rather than a page of writing.",
  "docx>pptx": "The document's text, lists, tables and pictures become text boxes on blank slides, in the order they were written and spread over as many slides as it takes. Word's fonts, colours, styles, columns and page design are not carried over — you get the content on plain slides, not a picture of the pages.",
  "xlsx>pdf": "Only the cells that have content are included, drawn as a plain grid. The page breaks are new, and number formats, formulas, charts, comments, colours and merged cells are not carried over.",
  "xlsx>docx": "Every sheet's filled cells are written into the document in workbook order, with each sheet's name as a heading. The grid, number formats, formulas, colours, charts and merged cells are not carried over — the numbers and labels survive as plain paragraphs and tables.",
  "xlsx>pptx": "Every sheet's filled cells are written onto blank slides, a dozen rows to a slide, each slide carrying its sheet's name. The grid, number formats, formulas, colours and charts are not carried over — this is the values as text, not a spreadsheet.",
  "pptx>pdf": "Each slide becomes one page at the size the deck was made at. Fonts, colours, backgrounds, animations and slide layouts are not reproduced, and text that did not fit inside its box is cut short.",
  "pptx>docx": "The text, tables and pictures of every slide are written into the document in slide order. Slide layouts, fonts, colours, backgrounds and animations are not carried over — the result is a page-style document, not a deck.",
  "pptx>xlsx": "The text and tables of every slide are written into a worksheet in slide order. Slide layouts, fonts, colours, pictures and animations are not carried over — the words survive, the deck does not.",
  "pdf>docx": "The words are read out of the PDF and written again in a standard Word style. Headings, paragraphs and tables are worked out from the size and position of the words on each page, so a page that was laid out unusually may be grouped differently. The page design, fonts, colours, columns and page breaks are not carried over, and pictures and drawings in a PDF are not recovered.",
  "pdf>xlsx": "The words are read out of the PDF and written into a worksheet, with a page's grid written out as a table. The rows and columns are worked out from where each piece of text sits on the page, so a page laid out unusually may be grouped differently. The page design, fonts, colours and pictures are not carried over.",
  "pdf>pptx": "The pages of the PDF become slides, spread over as many slides as it takes, with the words of each page read out and the grids written out as tables. The page design, fonts, colours, pictures and page breaks are not carried over, so the deck is the words on plain slides, not a picture of the PDF.",
};

// The same sentence again, worded for the notes panel a reader keeps after the
// file is downloaded. A conversion made from read-out text is never the
// original document, and saying it twice is cheaper than a wrong assumption.
const REBUILD_NOTES = {
  "docx>xlsx": "The workbook you get is rebuilt text and tables written into a new sheet. The document's styles, colours, columns and page design are not carried across, and pictures do not go into a spreadsheet.",
  "docx>pptx": "The deck you get is rebuilt text, tables and pictures on blank slides. The document's fonts, colours, styles, columns and page design are not carried across.",
  "xlsx>docx": "The document you get is rebuilt text and tables in a plain Word style. The workbook's grid, number formats, formulas, colours and merged cells are not carried across.",
  "xlsx>pptx": "The deck you get is rebuilt cell values, a dozen rows to a slide. The workbook's grid, number formats, formulas, colours and charts are not carried across.",
  "pptx>docx": "The document you get is rebuilt text, tables and pictures in slide order. Slide layouts, fonts, colours, backgrounds and animations are not carried across.",
  "pptx>xlsx": "The workbook you get is rebuilt slide text in a worksheet. Slide layouts, fonts, colours, pictures and animations are not carried across, and the slide boundaries are not marked.",
  "pdf>docx": "The document you get is rebuilt text: the headings, paragraphs and tables worked out from where the words sit on each page of the PDF. The original page design, fonts, colours, columns, pictures and drawings are not carried across, and a page laid out unusually may be grouped differently.",
  "pdf>xlsx": "The workbook you get is rebuilt text from the PDF, with the grids on the pages written out as tables. The original page design, fonts, colours and pictures are not carried across, and the rows are worked out from where each piece of text sits on the page.",
  "pdf>pptx": "The deck you get is rebuilt text from the PDF's pages, with the grids written out as tables. The original page design, fonts, colours, pictures and page breaks are not carried across.",
};

// A PDF's text layer is the only thing that can be read out of it. A scan of a
// page has none, so the honest thing is to refuse rather than deliver a blank
// file, and to say which file was refused.
const SCAN_NOTE =
  "A PDF made from a scan or a photograph has no text to read, so nothing was carried across. Open the file in a tool that can recognise text (OCR) and save it again first.";

// Stands in for the engine's warnings if it ever hands back none, so the limits
// of the conversion are never the thing that goes missing.
const ALWAYS_SHOWN =
  "The words, tables and pictures were copied into a new file set in a standard style. The original fonts, colours and layout were not reproduced.";

// Below this many characters a "converted" file is a blank page with a title
// on it, which is worth pointing at before somebody relies on it.
const NEARLY_EMPTY = 24;

// Shrinking a PDF in a browser means drawing each page again as a picture, so
// the saving is real and so is the price. It is stated in the notes every time
// rather than only when the saving is small.
const COMPRESS_NOTE =
  "Compressing re-rendered every page as an image, so the words in this PDF can no longer be selected, copied or searched for. The pages look the same, but a reader cannot find text inside the file any more.";

let chosen = null;
let queue = [];

function pairKey(from, to) {
  return `${from}>${to}`;
}

function sameFormatSentence(from, to) {
  const name = FORMATS[from].label;
  return `${name} to ${name} is not a conversion — the file would come back as the format it already is. Choose a different format for one of the two.`;
}

function baseName(file) {
  const raw = ((file && file.name) || "document").split(/[\\/]/).pop();
  return raw.replace(/\.[^.]+$/, "") || "document";
}

function hideNotes() {
  notesEl.hidden = true;
  notesList.replaceChildren();
}

function showNotes(lines) {
  const list = (lines || []).filter((line) => typeof line === "string" && line.trim() !== "");
  notesList.replaceChildren(
    ...(list.length ? list : [ALWAYS_SHOWN]).map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    })
  );
  notesEl.hidden = false;
}

function forgetFile() {
  chosen = null;
  queue = [];
  fileLabel.textContent = "";
  toolbar.hidden = true;
  setStatus("");
}

// A file is accepted by what it is, not only by what it is called: a renamed
// .docx can arrive reporting application/pdf, and a real PDF sometimes arrives
// with an empty type.
//
// What a file's name says it is, which is all office-to-pdf.js looks at as
// well. office-to-pdf.js is 25 KB gzipped and is fetched when a file is chosen
// rather than on page load, and a verdict about the wrong file must not wait on a
// download: the answer is the same either way, and the fetch is already running.
const OFFICE_KINDS = ["docx", "pptx", "xlsx"];
function officeKindOf(file) {
  const match = String((file && file.name) || "").split(/[?#]/)[0].trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match && OFFICE_KINDS.indexOf(match[1]) !== -1 ? match[1] : null;
}

function matchesSource(file, from) {
  if (!file) return false;
  if (from === "pdf") return isPdfFile(file);
  return officeKindOf(file) === from;
}

// The two heavy scripts are fetched the moment the pair says they will be
// needed — a file has been chosen, and either the source or the target is an
// Office format — so the engine is already on its way while the person is
// still looking at the page. A visit that never chooses a file never pays for
// either of them. Nothing is awaited here: a failure is reported by the
// conversion itself, in the words that conversion already uses.
function primeEngines() {
  if (!chosen) return;
  if (fromSelect.value !== "pdf") loadOfficeToPdf().catch((error) => console.warn(error));
  if (toSelect.value !== "pdf") loadFileWriters().catch((error) => console.warn(error));
}

// A person who drops the wrong file deserves to be told which file is wrong,
// what it is, and what to do about it — not just "unsupported".
function whyWrongFile(file, from) {
  const name = (file && file.name) || "That file";
  const wanted = FORMATS[from].file;
  const lower = name.toLowerCase();

  // Whatever it really is, say so first: that is the sentence that helps.
  const kind = officeKindOf(file);
  const actual = isPdfFile(file) ? FORMATS.pdf : kind ? FORMATS[kind] : null;
  const need = `${FORMATS[from].article} ${wanted}`;
  if (actual) {
    return `“${name}” is ${actual === FORMATS.pdf ? "a PDF" : `${actual.article} ${actual.file}`}, but “Convert from” is set to ${FORMATS[from].label}. Change “Convert from”, or choose ${need}.`;
  }
  if (/\.docx\.zip$/.test(lower) || /\.zip$/.test(lower)) {
    return `“${name}” is a zip archive, not ${need}. Open it and choose the file inside it.`;
  }
  if (/\.(docm|dotm|dot|doc|pptm|potm|ppt|xlsm|xltm|xls|csv|ods|odt|odp)$/.test(lower)) {
    return `“${name}” is not ${need}. Open it in its own app, use Save As, and choose the ${FORMATS[from].label} file it saves.`;
  }
  return `“${name}” is not ${need}, which is the only kind of file this page reads when “Convert from” is ${FORMATS[from].label}.`;
}

// Re-pointing the whole page at a new pair: the accept list, the dropzone
// words, the toolbar line, the button, the filename extension and the honest
// sentence all follow from the two selects.
function applySelection() {
  const from = fromSelect.value;
  const to = toSelect.value;
  const fromFormat = FORMATS[from];
  const toFormat = FORMATS[to];
  const same = from === to;

  fileInput.accept = fromFormat.accept;
  dropTitle.textContent = fromFormat.pick;
  dropHint.textContent = `or drag & drop it here — one ${fromFormat.file} at a time`;
  dropzone.setAttribute("aria-label", `Choose a ${fromFormat.file} or drop it here`);

  formatNote.textContent = same ? sameFormatSentence(from, to) : PAIR_NOTES[pairKey(from, to)];
  formatNote.classList.toggle("is-error", same);
  // The heading names the conversion being offered, so the page never claims to
  // be one thing while it is doing another.
  pageTitle.textContent = `${fromFormat.label} to ${toFormat.label} Converter`;

  // Short on purpose: the long sentence already sits under the pickers, and
  // the toolbar is the first thing read on a phone.
  toolbarHint.textContent = same
    ? `Choose two different formats. This page never converts a ${fromFormat.label} into another ${fromFormat.label}.`
    : `${fromFormat.label} to ${toFormat.label}, one file at a time. The result is rebuilt text and tables, so open it and check it.`;

  // Never disabled: a control that is locked leaves a person with nothing to do
  // and no way to tell why. A same-format pair is refused in words when the
  // button is pressed, not by going dead.
  convertBtn.textContent = same ? "Pick a different format" : `Convert to ${toFormat.label}`;
  // The refusal is the status while the pair is the same, and it goes as soon
  // as the pair is not, so nobody is left reading a message about a choice
  // they have already changed.
  if (same) setStatus(sameFormatSentence(from, to), "error");
  else if (statusEl.textContent === sameFormatSentence(from, to)) setStatus("");

  // A preview opens the file in a new tab, which only means anything for a PDF.
  previewBtn.hidden = to !== "pdf";
  // Only a PDF has anything to compress. A Word, Excel or PowerPoint file is
  // already zipped, and a switch that does nothing is worse than no switch, so
  // it goes away with the target rather than sitting there greyed out.
  if (compressBox) compressBox.hidden = to !== "pdf";
  if (compressQuality) compressQuality.hidden = to !== "pdf" || !compressToggle || !compressToggle.checked;
  downloadBtn.textContent = `↓ Download ${toFormat.label}`;
  resultText.textContent = same
    ? "No file has been made yet."
    : `Your ${toFormat.label} file is ready. Open it and check it before you rely on it.`;
  // The key of a format is its extension, so the pair name doubles as the file
  // name and the type the result bar advertises.
  nameExt.textContent = "." + to;
  if (notesEl.hidden === false) notesTitle.textContent = `What this ${fromFormat.label}-to-${toFormat.label} conversion does not keep`;
}

// Changing either select invalidates a finished result, and a chosen file only
// survives if it still matches the new source.
function onPairChange() {
  hideResultBar();
  hideNotes();
  const nameInput = document.getElementById("fileName");
  if (nameInput) nameInput.value = "";
  const from = fromSelect.value;
  if (chosen && !matchesSource(chosen, from)) {
    const dropped = chosen.name;
    forgetFile();
    applySelection();
    setStatus(`“${dropped}” is not ${FORMATS[from].article} ${FORMATS[from].file}, so it was removed. Choose a file for the format you have selected now.`, "error");
    return;
  }
  applySelection();
  primeEngines();
}

// Re-opens what was just written, the way a reader would, and refuses to hand it
// over if it will not open or has lost the text. This is the last line of defence
// between a writer bug and a download the user cannot use.
async function verifyResult(result, file, to) {
  const bytes = result.bytes;
  try {
    if (to === "pdf") {
      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      try {
        if (!doc.numPages) throw new Error("it holds no pages");
        if (!result.characters) throw new Error("it holds no readable text");
      } finally {
        await doc.destroy();
      }
      return true;
    }
    const JSZipCtor = await loadJsZip();
    const zip = await JSZipCtor.loadAsync(bytes);
    const parts = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    if (parts.length < 4) throw new Error("it is missing parts of the document");
    for (const name of parts) {
      if (!/\.(xml|rels)$/i.test(name)) continue;
      const xml = await zip.file(name).async("string");
      if (new DOMParser().parseFromString(xml, "application/xml").querySelector("parsererror")) {
        throw new Error("part of it is not valid");
      }
    }
    if (!result.characters) throw new Error("it holds no readable text");
    return true;
  } catch (err) {
    throw new Error(
      `${file.name} could not be read back after conversion, so it is not being offered: ${(err && err.message) || "it would not open"}. Nothing has been downloaded, so nothing is lost.`
    );
  }
}

fromSelect.addEventListener("change", onPairChange);
toSelect.addEventListener("change", onPairChange);

wireDropzone(dropzone, fileInput, (files) => {
  const list = Array.from(files || []);
  hideResultBar();
  hideNotes();
  forgetFile();
  applySelection();
  if (!list.length) return;

  const from = fromSelect.value;
  // One file at a time is the design, so the first file is the one that counts
  // and the rest are named as set aside rather than quietly dropped.
  // Every file of the chosen kind is kept, so several can be converted in one
  // go. Files of the wrong kind are named rather than dropped in silence.
  const good = list.filter((entry) => matchesSource(entry, from));
  const refused = list.filter((entry) => !matchesSource(entry, from));
  if (!good.length) {
    setStatus(whyWrongFile(list[0], from), "error");
    return;
  }
  const refusedNote = refused.length
    ? ` ${refused.map((entry) => entry.name).join(", ")} ${refused.length === 1 ? "is" : "are"} not a ${FORMATS[from].label} file and ${refused.length === 1 ? "was" : "were"} left out.`
    : "";

  chosen = good[0];
  queue = good;
  primeEngines();
  fileLabel.textContent = good.length === 1 ? `${chosen.name} · ${formatSize(chosen.size)}` : `${good.length} files ready`;
  toolbar.hidden = false;
  const extra = list.length - 1;
  const aside = extra > 0
    ? ` ${extra} other file${extra === 1 ? " was" : "s were"} set aside — this page converts one file at a time.`
    : "";
  // A file chosen while both selectors name the same format has nowhere to
  // go, and saying "ready to convert" here would be a promise the page
  // cannot keep.
  const same = from === toSelect.value;
  setStatus(
    same
      ? sameFormatSentence(from, toSelect.value)
      : `Ready to convert ${good.length === 1 ? chosen.name : `${good.length} ${FORMATS[from].label} files`}.${refusedNote} Check the result before you rely on it.`,
    same ? "error" : ""
  );
});

wireStartAnother(fileInput, () => {
  forgetFile();
  hideNotes();
  applySelection();
});
clearBtn.addEventListener("click", () => {
  forgetFile();
  hideResultBar();
  hideNotes();
  applySelection();
});

/* ---------- reading a PDF ----------
 * A PDF does not store paragraphs. It stores glyphs at coordinates, and pdf.js
 * hands each run of them back with the position, size and width it was drawn
 * at — which is everything needed to work the shape of the page back out. This
 * is a reading of the geometry and not a copy of the original file: a heading
 * here is a line drawn larger than the body, a table is a run of lines with
 * wide gaps between them, and a paragraph is a run of body-sized lines whose
 * gaps and indents say they belong together. Every surface that reports the
 * result says it was worked out this way.
 *
 * Two thresholds worth knowing about, because they are what stop the reading
 * running away: a line only counts as a heading when it is both noticeably
 * bigger than the page's body size and short enough to be a title rather than a
 * paragraph, and a line only counts as a table row when the gaps are wide
 * *and* every cell in it is short. Justified prose has wide gaps too, but its
 * first cell is a long run of words, so it stays prose.
 */
const LINE_TOLERANCE = 2;      // points; one visual line is usually several text items
const HEADING_RATIO = 1.15;    // this much bigger than the body size, a line is a heading
// How much bigger than the body each heading level is. The first band is wide
// because a PDF has no style sheet to say which level a title is.
const HEADING_BANDS = [1.35, 1.6, 1.9, 2.3, 2.8];
const MAX_HEADING_WORDS = 20;  // a long line in a big font is a paragraph, not a title
const MIN_CELL_GAP = 8;        // points; wider than this between two runs is a column edge
const MAX_CELL_WORDS = 6;      // a cell longer than this is prose that happens to be spaced out
const PARAGRAPH_GAP = 1.5;     // times the line spacing, before the gap counts as a break
const INDENT = 0.8;            // body-size points of indent that start a new paragraph
const LONE_WORD = 25;          // characters; shorter than this, one word is not a paragraph of its own

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return 0;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

// 1.2x the body reads as a level 1 heading, and each band below is one step
// further down, so a page of differently sized titles lands at sensible levels.
function headingLevel(ratio) {
  let level = 1;
  while (level < 6 && ratio >= HEADING_BANDS[level - 1]) level += 1;
  return level;
}

// The text items as plain records, dropping the empty ones pdf.js leaves behind
// where a line was spaced out with a positioning jump.
function textRuns(items) {
  const runs = [];
  for (const item of items || []) {
    const str = item && typeof item.str === "string" ? item.str.trim() : "";
    if (!str) continue;
    const t = Array.isArray(item.transform) ? item.transform : [];
    const x = Number.isFinite(t[4]) ? t[4] : 0;
    const y = Number.isFinite(t[5]) ? t[5] : 0;
    const width = Number.isFinite(item.width) && item.width > 0 ? item.width : 0;
    const height = Number.isFinite(item.height) && item.height > 0 ? item.height : 0;
    runs.push({ str, x, y, width, height });
  }
  return runs;
}

// Items that share a baseline are one visual line. y grows upward, so reading
// order is a descending sort; within a line it is left to right.
function lineGroups(runs) {
  const lines = [];
  for (const run of runs.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines[lines.length - 1];
    // The baseline is averaged as the line grows, so a run a fraction of a
    // point lower does not push the next one onto a line of its own.
    if (line && line.y - run.y <= LINE_TOLERANCE) {
      line.items.push(run);
      line.y = line.items.reduce((sum, item) => sum + item.y, 0) / line.items.length;
    } else {
      lines.push({ y: run.y, items: [run] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.size = line.items.reduce((largest, item) => Math.max(largest, item.height), 0);
    line.left = line.items[0].x;
  }
  return lines;
}

// A line broken into cells wherever the gap between two runs is wide enough to
// be a column rather than a word space. One cell means the line is continuous
// text, which is what separates a heading or a paragraph from a table row.
function lineCells(line, space) {
  const limit = Math.max(MIN_CELL_GAP, space * 2);
  const cells = [];
  let current = "";
  for (let index = 0; index < line.items.length; index++) {
    const item = line.items[index];
    const previous = line.items[index - 1];
    if (previous && item.x - (previous.x + previous.width) > limit) {
      cells.push(current.trim());
      current = "";
    }
    current += (current ? " " : "") + item.str;
  }
  cells.push(current.trim());
  return cells.filter(Boolean);
}

// One page's items turned into blocks: headings, tables and paragraphs in the
// order they are drawn.
function structureForPage(items) {
  const runs = textRuns(items);
  if (!runs.length) return { blocks: [], tables: 0 };
  const lines = lineGroups(runs);
  const body = median(lines.map((line) => line.size));
  // The average width of a character on this page, which stands in for a word
  // space: no PDF says how wide its own space is.
  const space = median(runs.map((run) => run.width / Math.max(1, run.str.length)));

  const blocks = [];
  let rows = [];
  let paragraph = null;
  let previous = null;
  let spacing = 0;
  let tables = 0;

  const flushParagraph = () => {
    if (!paragraph) return;
    const text = paragraph.parts.join(" ").replace(/\s+/g, " ").trim();
    paragraph = null;
    if (!text) return;
    const last = blocks[blocks.length - 1];
    // A line the page did not give enough room for is a leftover word, and a
    // Word file should not open on a paragraph made of "and". It is folded into
    // the line before it rather than dropped, because the words still matter.
    if (last && last.type === "paragraph" && text.length < LONE_WORD && !text.includes(" ")) {
      last.text += ` ${text}`;
      return;
    }
    blocks.push({ type: "paragraph", text });
  };

  // Body-sized lines belong together until the gap, the indents or the sentence
  // before them say otherwise.
  const addBody = (entry, left) => {
    const gap = previous ? previous.y - entry.y : 0;
    if (gap > 0) spacing = spacing || gap;
    const breaks = paragraph && (
      // A gap much larger than the page's own line spacing is a blank line.
      (spacing > 0 && gap > spacing * PARAGRAPH_GAP && gap > body * 1.25)
      // The previous line finished a sentence, so this one starts another.
      || previous.sentence
      // A different indent means the writer moved the cursor deliberately.
      || Math.abs(left - paragraph.indent) > body * INDENT
    );
    if (breaks) flushParagraph();
    if (!paragraph) paragraph = { parts: [], indent: left };
    paragraph.parts.push(entry.text);
    previous = { y: entry.y, sentence: /[.!?:;][")\]]?$/.test(entry.text) };
  };

  // Rows are held back until a second one turns up, because a single spaced-out
  // line — a page number beside a caption, a two-word title — is not a grid.
  const flushRows = () => {
    if (rows.length > 1) {
      flushParagraph();
      const grid = rows.map((held) => held.cells);
      const columns = grid.reduce((widest, row) => Math.max(widest, row.length), 1);
      // Every row of a table is the same width, so a short one is padded rather
      // than left ragged — Word reads a ragged row as missing columns.
      blocks.push({
        type: "table",
        rows: grid.map((row) => row.concat(new Array(Math.max(0, columns - row.length)).fill(""))),
      });
      tables += 1;
      previous = null;
    } else {
      for (const held of rows) addBody({ y: held.y, text: held.text }, held.left);
    }
    rows = [];
  };

  for (const line of lines) {
    const text = line.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const cells = lineCells(line, space);
    const row = cells.length > 1 && cells.every((cell) => cell.split(/\s+/).length <= MAX_CELL_WORDS);
    if (row) {
      rows.push({ cells, y: line.y, left: line.left, text });
      continue;
    }
    flushRows();

    const words = text.split(/\s+/).length;
    if (body > 0 && line.size >= body * HEADING_RATIO && words <= MAX_HEADING_WORDS) {
      flushParagraph();
      blocks.push({ type: "heading", level: headingLevel(line.size / body), text });
      previous = null;
      continue;
    }
    addBody({ y: line.y, text }, line.left);
  }
  flushRows();
  flushParagraph();
  return { blocks, tables };
}

// pdf.js keeps a view of the file it is given and detaches the buffer, so it
// gets a copy and is told to let go of it however this ends.
async function readPdfText(file, onProgress) {
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const total = doc.numPages;
  const blocks = [];
  const warnings = [];
  const tablePages = [];
  let characters = 0;
  let blank = 0;
  let pages = 0;

  try {
    for (let index = 1; index <= total; index++) {
      onProgress(`Reading page ${index} of ${total}…`);
      const page = await doc.getPage(index);
      try {
        const content = await page.getTextContent();
        const read = structureForPage(content.items);
        if (!read.blocks.length) {
          blank += 1;
          continue;
        }
        pages += 1;
        characters += countText(read.blocks);
        blocks.push(...read.blocks);
        if (read.tables) tablePages.push(index);
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }

  if (blank) {
    warnings.push(
      blank === 1
        ? `One of the ${total} pages has no text in it and was left out. A page that is only a picture has nothing to read.`
        : `${blank} of the ${total} pages have no text in them and were left out. A page that is only a picture has nothing to read.`
    );
  }
  if (blank === total) {
    throw new Error(`${file.name} has no readable text at all. ${SCAN_NOTE}`);
  }
  // The three things a person needs to know about a reading of a page: that it
  // was worked out rather than copied, where a grid was recognised, and that
  // the parts of a PDF which are not text are not recovered.
  warnings.push(
    "The shape of each page was worked out from the size and position of the words on it, because a PDF stores the words and their coordinates and nothing else. That is a reading of the page rather than a copy of it, so a page laid out unusually may be grouped differently."
  );
  if (tablePages.length) {
    warnings.push(
      tablePages.length === 1
        ? `Page ${tablePages[0]} of the PDF had a grid of values on it, and that page was written out as a table.`
        : `Pages ${tablePages.join(", ")} of the PDF had grids of values on them, and those pages were written out as tables.`
    );
  }
  warnings.push(
    "Pictures, charts and drawings in a PDF are not recovered. The PDF's text layer is the only part of it that can be read out, so anything that was drawn rather than typed is left behind."
  );

  const tables = blocks.filter((block) => block.type === "table").length;
  const detail = `${pages} page${pages === 1 ? "" : "s"} of text${tables ? `, and ${tables} table${tables === 1 ? "" : "s"}` : ""}`;
  return { blocks, characters, warnings, pages, tables, detail };
}

// Every block shape the extractors produce, so "is there anything in this" is
// answered the same way whichever format it came from.
function countText(blocks) {
  let total = 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || "").toLowerCase();
    if (type === "paragraph" || type === "heading" || type === "text") {
      const text = typeof block.text === "string"
        ? block.text
        : (Array.isArray(block.runs) ? block.runs.map((run) => (run && run.text) || "").join("") : "");
      total += text.trim().length;
    } else if (type === "list") {
      for (const item of Array.isArray(block.items) ? block.items : []) total += String(item || "").trim().length;
    } else if (type === "table" || type === "sheet") {
      for (const row of Array.isArray(block.rows) ? block.rows : []) {
        for (const cell of Array.isArray(row) ? row : []) total += String(cell || "").trim().length;
      }
    } else if (type === "slide") {
      total += countText(block.blocks);
    }
  }
  return total;
}

// file-writers.js is 16 KB gzipped and only the nine conversions that end in an
// Office format need it, so it is fetched on first use. A fetch that fails raises
// the sentence the page has always used for a writer that is not there.
async function writers() {
  const api = await loadFileWriters().catch((error) => {
    console.warn(error);
    return null;
  });
  if (!api) {
    throw new Error("The Word, Excel and PowerPoint writer could not be loaded. Reload this page and try again.");
  }
  return api;
}

/* ---------- shaping the blocks for the writer ----------
 * Each writer has its own idea of what a document is made of, and left alone
 * two of the twelve pairs would quietly lose everything: a deck arrives as a
 * run of "slide" blocks, which the workbook writer never looks inside, and a
 * workbook arrives as a run of "sheet" blocks, which the deck writer skips.
 * A slide also has room for only so much — a table that does not fit is not
 * drawn at all. So the content is repacked here into blocks the writer will
 * carry. Nothing is rewritten, and whatever the repacking costs is written
 * down in the notes rather than left for the user to discover. */

const SLIDE_TEXT_BUDGET = 620;   // body characters that read comfortably on one slide
const SLIDE_TABLE_ROWS = 12;     // table rows that fit under a slide title
const SLIDE_TABLE_COLUMNS = 10;  // the ceiling the deck writer puts on a table
const SLIDE_TEXT_LINES = 8;      // lines of plain text on one slide
const SLIDE_TEXT_CHARS = 700;    // characters of plain text that read on one slide
const CELL_SEPARATOR = " | ";    // stands in for a column where a grid cannot be drawn
const LONG_PARAGRAPH = 1200;     // a paragraph longer than this is split

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (Array.isArray(block.runs)) return block.runs.map((run) => (run && run.text) || "").join("");
  return "";
}

function isType(block, name) {
  return Boolean(block) && typeof block === "object" && String(block.type || "").toLowerCase() === name;
}

// Split on a space where there is one, so a word is never cut in half.
function splitText(value, limit) {
  const text = String(value || "");
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : [text];
}

function rowList(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => (Array.isArray(row) ? row : [row]));
}

function widestRow(rows) {
  let widest = 0;
  for (const row of rows) widest = Math.max(widest, row.length);
  return widest;
}

// A table too tall for a slide is not shrunk by the writer, it is left out, so
// it is cut into slides' worth here. A table too wide is not cut either, so it
// is written as plain text, a row to a line, with the cells separated by a bar.
// A bar rather than a tab, because a tab inside a run of slide text is not
// something every reader lays out as a column, and two cells written next to
// each other with nothing between them are read as one value. The row keeps
// every value it had, at the cost of the grid.
function tablePieces(rows) {
  const list = rowList(rows);
  if (!list.length) return [];
  if (widestRow(list) > SLIDE_TABLE_COLUMNS) {
    const pieces = [];
    let lines = [];
    let used = 0;
    for (const row of list) {
      const line = row.join(CELL_SEPARATOR);
      // A slide is a fixed height, so a piece is cut at whichever limit comes
      // first: too many lines, or more characters than read on one slide.
      if (lines.length && (lines.length >= SLIDE_TEXT_LINES || used + line.length > SLIDE_TEXT_CHARS)) {
        pieces.push({ type: "paragraph", text: lines.join("\n") });
        lines = [];
        used = 0;
      }
      lines.push(line);
      used += line.length;
    }
    if (lines.length) pieces.push({ type: "paragraph", text: lines.join("\n") });
    return pieces;
  }
  const pieces = [];
  for (let index = 0; index < list.length; index += SLIDE_TABLE_ROWS) {
    pieces.push({ type: "table", rows: list.slice(index, index + SLIDE_TABLE_ROWS) });
  }
  return pieces;
}

function blockWeight(block) {
  if (isType(block, "table") || isType(block, "sheet")) {
    return Math.max(0.4, (Array.isArray(block.rows) ? block.rows.length : 0) / SLIDE_TABLE_ROWS);
  }
  if (isType(block, "image")) return 0.5;
  if (isType(block, "list")) return Math.max(0.2, (Array.isArray(block.items) ? block.items.length : 0) / 6);
  return Math.max(0.2, blockText(block).length / SLIDE_TEXT_BUDGET);
}

// Everything the writer is handed is a list of blocks; a slide block is the
// one nesting level that only one of the two writers understands.
function* eachBlock(blocks) {
  const queue = Array.isArray(blocks) ? blocks.slice() : [];
  let head = 0;
  while (head < queue.length) {
    const block = queue[head++];
    if (!block || typeof block !== "object") continue;
    if (isType(block, "slide")) {
      for (const inner of Array.isArray(block.blocks) ? block.blocks : []) yield inner;
      continue;
    }
    yield block;
  }
}

// A spreadsheet is rows, so a document, a deck or a set of PDF pages is laid
// out as one: a heading starts a fresh row, a run of paragraphs fills the cells
// of the next one, and a table is written out row by row as it stands. The
// sheets are built here rather than left to the writer, which would drop
// everything except the first table it found.
function toWorkbookSheets(blocks, title) {
  const sheets = [];
  let rows = [];
  let line = [];
  let pictures = 0;

  const flushLine = () => {
    if (line.length) rows.push(line);
    line = [];
  };
  const flushSheet = () => {
    flushLine();
    if (!rows.length) return;
    sheets.push({ name: String(title || "Sheet").replace(/\.[^.]+$/, "") || "Sheet", rows });
    rows = [];
  };

  for (const block of eachBlock(blocks)) {
    if (isType(block, "sheet")) {
      flushSheet();
      const list = rowList(block.rows);
      if (list.length) sheets.push({ name: String(block.name || "Sheet"), rows: list });
      continue;
    }
    if (isType(block, "table")) {
      flushLine();
      for (const row of rowList(block.rows)) rows.push(row);
      continue;
    }
    if (isType(block, "list")) {
      for (const item of Array.isArray(block.items) ? block.items : []) {
        const value = String(item === null || item === undefined ? "" : item);
        if (value.trim()) line.push(`• ${value}`);
      }
      continue;
    }
    if (isType(block, "image")) {
      pictures++;
      continue;
    }
    const value = blockText(block);
    if (!value.trim()) continue;
    line.push(value);
    if (isType(block, "heading")) flushLine();
  }
  flushSheet();
  // A workbook with no sheet in it is a file Excel offers to repair.
  if (!sheets.length) sheets.push({ name: "Sheet1", rows: [] });
  return { sheets, pictures };
}

// Repack extracted content into something the chosen writer can carry, and
// report what the repacking cost so the notes panel can say it out loud.
function shapeFor(target, blocks, title) {
  const notes = [];
  if (target === "xlsx") {
    // Opening up the slide blocks is the first half of the job: without it a
    // deck becomes an empty workbook.
    let fromSlides = 0;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (isType(block, "slide")) fromSlides++;
    }
    const { sheets, pictures } = toWorkbookSheets(blocks, title);
    if (fromSlides) {
      notes.push("The slides were written out in slide order. Where one slide ended and the next began is not marked, and a spreadsheet is not a slide show.");
    }
    if (pictures) {
      notes.push(`${pictures} picture${pictures === 1 ? "" : "s"} in the document ${pictures === 1 ? "was" : "were"} not carried into the spreadsheet. Only the words and tables were.`);
    }
    const kept = sheets.map((sheet) => ({ type: "sheet", name: sheet.name, rows: sheet.rows }));
    return { payload: { sheets }, notes, blocks: kept };
  }

  if (target === "pptx") {
    const slides = [];
    let current = { title: "", blocks: [] };
    let used = 0;
    let split = 0;
    let widened = 0;

    const flush = () => {
      if (current.blocks.length) slides.push(current);
      current = { title: "", blocks: [] };
      used = 0;
    };

    for (const block of eachBlock(blocks)) {
      if (isType(block, "sheet")) {
        // A sheet has no slide of its own, so it becomes as many slides as it
        // takes, each carrying the sheet's name.
        flush();
        const name = String(block.name || "Sheet").trim() || "Sheet";
        const pieces = tablePieces(block.rows);
        if (!pieces.length) {
          slides.push({ title: name, blocks: [{ type: "paragraph", text: `${name} has no cells with content in it.` }] });
          continue;
        }
        if (widestRow(rowList(block.rows)) > SLIDE_TABLE_COLUMNS) widened++;
        pieces.forEach((piece, index) => {
          slides.push({ title: index === 0 ? name : `${name} (${index + 1})`, blocks: [piece] });
        });
        continue;
      }
      // A table is a single shape, so it gets a slide of its own rather than
      // being pushed off the bottom of somebody else's.
      const pieces = isType(block, "table") ? tablePieces(block.rows) : null;
      if (pieces) {
        if (widestRow(rowList(block.rows)) > SLIDE_TABLE_COLUMNS) widened++;
        if (pieces.length > 1) split++;
        for (const piece of pieces) {
          flush();
          current.blocks.push(piece);
          used = 1;
        }
        flush();
        continue;
      }
      const weight = blockWeight(block);
      if (used && used + weight > 1) {
        flush();
        if (weight > 1) split++;
      }
      const text = blockText(block);
      if (weight > 1 && text.length > LONG_PARAGRAPH) {
        for (const piece of splitText(text, LONG_PARAGRAPH)) {
          if (used) flush();
          current.blocks.push({ type: "paragraph", text: piece });
          used = 1;
        }
        continue;
      }
      current.blocks.push(block);
      used += weight;
    }
    flush();
    if (!slides.length) slides.push({ title: "", blocks: [] });

    if (slides.length > 1) {
      notes.push(`The content was spread over ${slides.length} slides, because one slide cannot hold it all. No words were left out, but the slide breaks are the converter's own and do not follow the original pages.`);
    }
    if (widened) {
      notes.push(`Some tables were too wide for a slide and were written out as plain text, a row to a line with the cells separated by a bar, because a slide holds at most ${SLIDE_TABLE_COLUMNS} columns. Every value is there; the grid is not.`);
    }
    return { payload: { slides }, notes, blocks: slides.flatMap((slide) => slide.blocks) };
  }

  // The Word writer opens a sheet up by itself: the writer's own linearBlocks
  // turns a sheet into its name as a heading and its rows as a table, so a
  // workbook handed straight over keeps every cell. Repacking it here would
  // only cost the sheet names. The blocks are still handed back so the caller
  // can count what is actually going into the file.
  return { payload: { blocks }, notes: [], blocks };
}

/* ---------- compressing the PDF ---------- */
// The shared helper in pdf-core.js does this for every tool. It is optional, so
// a page that loads without it falls back to the copy below rather than showing
// a switch that quietly does nothing.
async function compressOutput(bytes, level, onProgress) {
  const shared =
    (window.SwiftPdfCompress && typeof window.SwiftPdfCompress.compressPdfBytes === "function"
      ? window.SwiftPdfCompress.compressPdfBytes
      : null) || (typeof compressPdfBytes === "function" ? compressPdfBytes : null);
  if (shared) {
    const result = await shared(bytes, { level, onProgress });
    return { bytes: result.bytes, warnings: result.warnings || [] };
  }
  return { bytes: await renderPagesAsPictures(bytes, COMPRESS_LEVELS[level] || COMPRESS_LEVELS.medium, onProgress), warnings: [] };
}

// Re-renders every page as a JPEG and rebuilds the document around it, which is
// the only way to make a PDF meaningfully smaller in a browser. Pages are drawn
// one at a time and the canvas is released straight after, so memory stays flat
// instead of holding every rendered page at once.
async function renderPagesAsPictures(bytes, quality, onProgress) {
  const pdfjs = await loadPdfJs();
  const pdfLib = await loadPdfLib();
  // pdf.js may hand the buffer to its worker, so it gets a copy it cannot take.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes).slice() }).promise;
  const out = await pdfLib.PDFDocument.create();
  try {
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: quality.scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
        const jpeg = await new Promise((resolve, reject) => {
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not render a page."))), "image/jpeg", quality.jpeg);
        });
        const image = await out.embedJpg(await jpeg.arrayBuffer());
        // The page keeps the size it had, so the document does not change shape.
        const target = out.addPage([size.width, size.height]);
        target.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
      if (onProgress) onProgress(`Compressing — page ${number} of ${doc.numPages}…`);
    }
  } finally {
    await doc.destroy();
  }
  return out.save();
}

// office-to-pdf.js is fetched on first use like the writer above. Reaching a
// conversion without it means the fetch failed, which is a different problem from
// a damaged document and is named as one.
async function officeEngine() {
  const office = await loadOfficeToPdf().catch((error) => {
    console.warn(error);
    return null;
  });
  if (!office) {
    throw new Error("The Word, PowerPoint and Excel converter did not load. Reload this page and try again.");
  }
  return office;
}

// The three routes, and nothing else. An office file to a PDF is drawn by the
// PDF engine; a PDF to an office file is read with pdf.js and written by the
// writers; an office file to another office file is extracted and written.
async function convertFile(file, from, to, onProgress) {
  if (from === to) throw new Error(sameFormatSentence(from, to));

  if (to === "pdf") {
    const office = await officeEngine();
    const result = await office.toPdf(file, {
      onProgress: (_done, _total, label) => onProgress(`${label}…`),
    });
    let bytes = result.bytes;
    const warnings = [...(result.warnings || [])];
    let compression = null;

    if (compressToggle && compressToggle.checked) {
      onProgress("Compressing the PDF…");
      const level = COMPRESS_LEVELS[compressLevel] ? compressLevel : "medium";
      const packed = await compressOutput(bytes, level, onProgress);
      const saved = Math.max(0, bytes.length - packed.bytes.length);
      compression = { label: COMPRESS_LEVELS[level].label, before: bytes.length, after: packed.bytes.length, saved };
      bytes = packed.bytes;
      // The shared helper says the price of compressing in its own words; the
      // fallback path has to be told the same thing, or the notes would promise
      // a saving and stay quiet about what it costs.
      warnings.push(...(packed.warnings.length ? packed.warnings : [COMPRESS_NOTE]));
    }
    if (compression) {
      warnings.unshift(
        compression.saved > 0
          ? `The PDF was compressed at ${compression.label} — ${formatSize(compression.before)} → ${formatSize(compression.after)}, saving ${formatSize(compression.saved)}.`
          : `The PDF was compressed at ${compression.label}, but it was already lean, so it is about the same size.`
      );
    }

    return {
      bytes,
      ext: "pdf",
      warnings,
      detail: `${result.pageCount} page${result.pageCount === 1 ? "" : "s"}`,
      characters: result.stats ? result.stats.characters : 0,
      compression,
    };
  }

  const api = await writers();
  if (from === "pdf") {
    const read = await readPdfText(file, onProgress);
    const kept = countText(read.blocks);
    if (!kept) {
      throw new Error(`${file.name} produced an empty ${FORMATS[to].label} file, so there is nothing to download.`);
    }
    onProgress(`Writing the ${FORMATS[to].label} file…`);
    const shaped = shapeFor(to, read.blocks, baseName(file));
    const bytes = await api[to]({ title: baseName(file), ...shaped.payload });
    const warnings = [REBUILD_NOTES[pairKey(from, to)], ...read.warnings, ...shaped.notes];
    if (kept < NEARLY_EMPTY) {
      warnings.push(`This PDF held only ${kept} character${kept === 1 ? "" : "s"} of text, so the ${FORMATS[to].label} file is almost empty.`);
    }
    return {
      bytes,
      ext: to,
      warnings,
      detail: read.detail,
      characters: kept,
    };
  }

  const office = await officeEngine();
  const extracted = await office.extract(file, {
    onProgress: (_done, _total, label) => onProgress(`${label}…`),
  });
  const characters = countText(extracted.blocks);
  if (!characters) {
    throw new Error(`${file.name} holds no text and no tables, so there is nothing in it to turn into ${FORMATS[to].article} ${FORMATS[to].file}.`);
  }
  onProgress(`Writing the ${FORMATS[to].label} file…`);
  const shaped = shapeFor(to, extracted.blocks, extracted.title || baseName(file));
  const bytes = await api[to]({ title: extracted.title || baseName(file), ...shaped.payload });
  const warnings = [REBUILD_NOTES[pairKey(from, to)], ...shaped.notes, ...extracted.warnings];
  // Counted on the repacked content rather than the extraction, because that is
  // what actually reaches the file.
  const kept = shaped.blocks ? countText(shaped.blocks) : characters;
  if (!kept) {
    throw new Error(`${file.name} produced an empty ${FORMATS[to].label} file, so there is nothing to download.`);
  }
  if (kept < NEARLY_EMPTY) {
    warnings.push(`This file held only ${kept} character${kept === 1 ? "" : "s"} of text, so the ${FORMATS[to].label} file is almost empty.`);
  }
  return {
    bytes,
    ext: to,
    warnings,
    detail: `${kept} character${kept === 1 ? "" : "s"} of text`,
    characters: kept,
  };
}

// Saves one converted file straight away. The result bar holds the last one, so
// a batch is still visible after the fact.
function triggerDownload(entry, index) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(entry.blob);
  link.href = url;
  link.download = `${baseName(entry.file)}.${entry.result.ext}`;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked late: an immediate revoke can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30000 + index * 400);
}


convertBtn.addEventListener("click", async () => {
  const from = fromSelect.value;
  const to = toSelect.value;
  // Both refusals come before anything is read, so a press that cannot
  // succeed says why instead of doing nothing at all.
  if (from === to) {
    setStatus(sameFormatSentence(from, to), "error");
    return;
  }
  if (!chosen) {
    setStatus(`Choose ${FORMATS[from].article} ${FORMATS[from].file} first, then press this button again.`, "error");
    return;
  }
  const batch = queue.length ? queue.slice() : [chosen];
  setToolBusy(true);
  fromSelect.disabled = true;
  toSelect.disabled = true;
  hideResultBar();
  hideNotes();
  setStatus(
    batch.length === 1
      ? "Getting the conversion engine ready — it loads from the internet on first use…"
      : `Getting the conversion engine ready, then converting ${batch.length} files…`
  );

  const done = [];
  const failed = [];
  let last = null;

  try {
    const mime = to === "pdf" ? "application/pdf" : (await writers()).mimeFor(to);
    for (let index = 0; index < batch.length; index++) {
      const file = batch[index];
      const label = batch.length === 1 ? "" : ` (${index + 1} of ${batch.length})`;
      try {
        const result = await convertFile(file, from, to, (text) => setStatus(`${text}${label}`));
        if (!result.bytes || !result.bytes.length) {
          throw new Error(`${file.name} produced an empty file, so there is nothing to download.`);
        }
        // Read the finished file back before offering it. A file that will not
        // open is worse than a refusal, and a silent one is worse still, so this
        // turns any package the writer got wrong into an honest message.
        await verifyResult(result, file, to);
        const blob = new Blob([result.bytes], { type: mime });
        done.push({ file, result, blob });
        last = { result, blob };
      } catch (err) {
        console.error(err);
        // One bad file must not abandon the rest of the batch.
        failed.push({
          file,
          message: explainProcessingError(err, `Converting this ${FORMATS[from].label} file`, file.name),
        });
      }
    }

    if (!last) {
      hideResultBar();
      const first = failed[0];
      setStatus(
        failed.length === 1
          ? first.message
          : `None of the ${failed.length} files could be converted. ${first.file.name}: ${first.message}`,
        "error"
      );
      return;
    }

    notesTitle.textContent = `What this ${FORMATS[from].label}-to-${FORMATS[to].label} conversion does not keep`;
    showResult(last.blob, `${baseName(last.result.fileName || batch[0].name)}.${last.result.ext}`, last.result.ext);
    showNotes(last.result.warnings);
    const packed = last.result.compression
      ? ` It was compressed at ${last.result.compression.label}: ${formatSize(last.result.compression.before)} → ${formatSize(last.result.compression.after)}, saving ${formatSize(last.result.compression.saved)}.`
      : "";

    if (done.length === 1) {
      setStatus(
        `Converted ${done[0].file.name} into ${formatSize(last.blob.size)} of ${FORMATS[to].label} (${last.result.detail}).${packed} The list below says what it could not keep.`,
        "success"
      );
    } else {
      // Each file is its own download, so the summary says so plainly rather
      // than leaving the user wondering where the other files went.
      const names = done.map((entry) => entry.file.name).join(", ");
      const lost = failed.length
        ? ` ${failed.length === 1 ? "One file was" : `${failed.length} files were`} left out: ${failed.map((entry) => entry.file.name).join(", ")}.`
        : "";
      setStatus(
        `Converted ${done.length} files into ${FORMATS[to].label} — ${names}. Each one has been downloaded separately.${lost} The list below is what this conversion cannot keep.`,
        failed.length ? "" : "success"
      );
    }

    // Staggered so the browser does not treat a burst as a popup and drop them.
    for (let index = done.length - 1; index >= 0; index--) {
      triggerDownload(done[index], index);
    }

  } finally {
    fromSelect.disabled = false;
    toSelect.disabled = false;
    // The busy lock is released first: it restores the buttons it disabled, and
    // applySelection then puts the right state back on the convert button.
    setToolBusy(false);
    applySelection();
  }
});

applySelection();
