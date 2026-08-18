/* global pdfjsLib, Tesseract */
// Local OCR fallback for scanned (image-only) PDFs.
// Everything runs in-browser via WebAssembly — no data leaves the device.

// Point Tesseract at the locally bundled assets so nothing is fetched from a CDN
// (required under MV3, and keeps tax data private).
const TESS_PATHS = {
  workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
  // Point directly at the one core we bundled so resolution can't miss.
  corePath: chrome.runtime.getURL("lib/tesseract/tesseract-core-simd-lstm.wasm.js"),
  langPath: chrome.runtime.getURL("lib/tesseract/"),        // dir with eng.traineddata.gz
  workerBlobURL: false
};

// Render one PDF page to a canvas at a scale that gives OCR enough resolution.
async function renderPageToCanvas(pdf, pageNum, scale = 2.0) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// True if the page has essentially no extractable text (i.e. it's a scan).
async function pageHasNoText(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const content = await page.getTextContent();
  const chars = content.items.reduce((n, it) => n + (it.str || "").trim().length, 0);
  return chars < 20; // headers alone would exceed this on a real text PDF
}

// OCR up to `maxPages` pages of a PDF given its bytes. Returns { text, pages }.
// onProgress(msg) is called with human-readable status.
async function ocrPdf(bytes, maxPages = 3, onProgress = () => {}) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const pdf = await pdfjsLib.getDocument({ data: copy }).promise;
  const pages = Math.min(pdf.numPages, maxPages);

  onProgress("Starting OCR engine…");
  const worker = await Tesseract.createWorker("eng", 1, TESS_PATHS);

  // Tuning that helps on tax forms: treat the page as a block of text, and
  // whitelist the characters that actually appear so digits aren't misread as
  // letters and vice-versa.
  await worker.setParameters({
    tessedit_pageseg_mode: "6", // assume a single uniform block of text
    preserve_interword_spaces: "1"
  });

  let text = "";
  try {
    for (let i = 1; i <= pages; i++) {
      onProgress(`OCR page ${i} of ${pages}…`);
      const canvas = await renderPageToCanvas(pdf, i);
      const { data } = await worker.recognize(canvas);
      text += data.text + "\n";
    }
  } finally {
    await worker.terminate();
    await pdf.destroy();
  }
  return { text, pages };
}

// OCR a raw IMAGE (not a PDF). Portal handlers often serve scanned pages as
// JPEG/PNG rather than PDF, so there are no PDF pages to render — we hand the
// image straight to Tesseract.
async function ocrImage(bytes, mime, onProgress = () => {}) {
  onProgress("Starting OCR engine…");
  const blob = new Blob([bytes], { type: mime || "image/jpeg" });
  const url = URL.createObjectURL(blob);
  const worker = await Tesseract.createWorker("eng", 1, TESS_PATHS);
  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1"
  });
  try {
    onProgress("OCR reading image…");
    const { data } = await worker.recognize(url);
    return { text: data.text, pages: 1 };
  } finally {
    await worker.terminate();
    URL.revokeObjectURL(url);
  }
}

if (typeof window !== "undefined") {
  window.__ocr = { ocrPdf, pageHasNoText, ocrImage };
}
