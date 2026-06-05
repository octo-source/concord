// DOCX ingestion via mammoth: raw text extraction, split into paragraphs
// (mammoth separates paragraphs with two newlines). Position = para index.
import { basename } from "node:path";
import mammoth from "mammoth";
import { ConcordError } from "../core/errors.js";

export async function parse(filePath) {
  let result;
  try {
    result = await mammoth.extractRawText({ path: filePath });
  } catch (e) {
    throw new ConcordError("BAD_DOCX", `mammoth cannot parse ${filePath}: ${e.message}`, { filePath });
  }
  const issues = (result.messages || []).map((m) => ({ kind: `mammoth_${m.type}`, detail: m.message }));
  const paras = result.value
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paras.length === 0) issues.push({ kind: "empty", detail: "document contains no text" });
  return { docs: [{ name: basename(filePath), paras }], issues };
}
