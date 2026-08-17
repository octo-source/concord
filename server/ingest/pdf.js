// PDF ingestion via pdfjs-dist (legacy build, works in Node without a worker
// thread). Text items are grouped into lines by shared baseline y, lines into
// paragraphs by vertical gap; each paragraph records its page anchor in a
// `pages` array parallel to `paras`.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ConcordError } from "../core/errors.js";

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

// Group one page's text items into paragraph strings.
// Items carry transform[4]=x, transform[5]=y (origin bottom-left).
// Items without a usable transform array are filtered out rather than crashing
// the page. NOTE: rotated or multi-column pages degrade to scrambled-but-
// nonempty text by design in v1 — items are clustered by raw y then x only,
// with no rotation or column detection.
export function pageParagraphs(items) {
  const placed = items
    .filter(
      (it) =>
        it.str &&
        it.str.trim().length > 0 &&
        Array.isArray(it.transform) &&
        it.transform.length >= 6,
    )
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], h: it.height || 0 }));
  if (placed.length === 0) return [];
  // Cluster into lines by y (tolerance: half the median glyph height, min 2pt)
  placed.sort((a, b) => b.y - a.y || a.x - b.x);
  const heights = placed
    .map((p) => p.h)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const tol = Math.max(2, medH / 2);
  const lines = [];
  for (const p of placed) {
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && Math.abs(line.y - p.y) <= tol) {
      line.parts.push(p);
    } else {
      lines.push({ y: p.y, parts: [p] });
    }
  }
  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);
    line.text = line.parts
      .map((p) => p.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  // Group lines into paragraphs by vertical gap. Normal leading is ~1.2-1.5x
  // font size, so a gap beyond ~2.2x glyph height means a paragraph break.
  // When the document has identifiable intra-paragraph gaps (<= 3x height),
  // also require 1.8x their median, which adapts to generous line spacing.
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const intraGaps = gaps.filter((g) => g > 0 && g <= medH * 3).sort((a, b) => a - b);
  const medIntra = intraGaps.length ? intraGaps[Math.floor(intraGaps.length / 2)] : 0;
  const threshold = Math.max(medH * 2.2, medIntra * 1.8);
  const paras = [];
  let cur = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i - 1].y - lines[i].y > threshold && cur.length) {
      paras.push(cur.join(" "));
      cur = [];
    }
    cur.push(lines[i].text);
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras.filter((p) => p.length > 0);
}

export async function parse(filePath) {
  let buf;
  try {
    buf = await readFile(filePath);
  } catch (e) {
    throw new ConcordError("FILE_READ", `cannot read ${filePath}: ${e.message}`, { filePath });
  }
  const pdfjs = await loadPdfjs();
  // pdfjs-dist v6 removed PDFDocumentProxy#destroy(); cleanup now happens via
  // the loading task (getDocument()'s return value), so we keep it around.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    disableFontFace: true,
    // keep pdfjs quiet about missing worker in Node
    verbosity: 0,
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (e) {
    throw new ConcordError("BAD_PDF", `pdfjs cannot open ${filePath}: ${e.message}`, { filePath });
  }
  const issues = [];
  const paras = [];
  const pages = []; // page anchor per paragraph (1-based)
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      // pageParagraphs runs INSIDE the per-page try: a malformed page becomes
      // a bad_page issue and the rest of the document still imports, instead
      // of one bad page aborting the whole doc.
      let pageParas;
      try {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        pageParas = pageParagraphs(content.items);
      } catch (e) {
        issues.push({ kind: "bad_page", detail: `page ${p}: ${e.message}` });
        continue;
      }
      for (const para of pageParas) {
        paras.push(para);
        pages.push(p);
      }
    }
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
  if (paras.length === 0)
    issues.push({ kind: "empty", detail: "no extractable text (scanned/image-only PDF?)" });
  return { docs: [{ name: basename(filePath), paras, pages }], issues };
}
