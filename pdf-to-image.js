// PDF to Image tool — renders each page to PNG via pdf.js
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stripEl = document.getElementById("fileStrip");
const toolbar = document.getElementById("toolbar");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");

let scale = 2;
document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach((p) => p.classList.remove("selected"));
    pill.classList.add("selected");
    scale = parseFloat(pill.dataset.scale);
  });
});

const strip = createFileStrip({ input: fileInput, stripEl, accept: "pdf", toolbar });
wireDropzone(dropzone, fileInput, (f) => strip.addFiles(f));

clearBtn.addEventListener("click", () => strip.clear());

convertBtn.addEventListener("click", async () => {
  const items = strip.items;
  if (!items.length) return;
  convertBtn.disabled = true;
  setStatus("Rendering pages…");

  try {
    const pdfjs = await loadPdfJs();
    let total = 0;
    for (const item of items) {
      const data = await item.file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data }).promise;
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const base = items.length > 1 ? item.file.name.replace(/\.pdf$/i, "") + "-" : "";
        const link = document.createElement("a");
        link.href = canvas.toDataURL("image/png");
        link.download = base + "page-" + p + ".png";
        link.click();
        total++;
        setStatus(`Rendering pages… ${total} done`, "success");
        await new Promise((r) => setTimeout(r, 150)); // let the browser handle multiple downloads
      }
    }
    setStatus(`Done — ${total} image${total === 1 ? "" : "s"} downloaded.`, "success");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Conversion failed. Please try again.", "error");
  } finally {
    convertBtn.disabled = false;
  }
});
// workspace (edit files)
const wsBtn = document.getElementById("wsBtn");
wsBtn.addEventListener("click", () => openWorkspace(strip));
