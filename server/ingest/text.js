// Plain-text family ingestion: TXT/MD split into paragraphs on blank lines;
// HTML stripped by a small hand-rolled scanner (no dependency) that drops
// script/style/comments and preserves block-element boundaries.
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { ConcordError } from "../core/errors.js";

const BLOCK_TAGS = new Set([
  "p", "div", "br", "li", "ul", "ol", "table", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "section",
  "article", "header", "footer", "nav", "aside", "main", "figure",
  "figcaption", "hr", "form", "fieldset", "address", "dt", "dd", "dl",
]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

export function textToParas(raw) {
  return raw
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// Hand-rolled tag stripper. Single pass; <script>/<style> contents skipped
// up to their closing tag; comments skipped; block tags emit a paragraph
// boundary marker.
export function htmlToParas(html) {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const ch = html[i];
    if (ch !== "<") {
      out += ch;
      i++;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const close = html.indexOf(">", i);
    if (close === -1) break; // malformed trailing "<"
    const rawTag = html.slice(i + 1, close);
    const m = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag);
    const tag = m ? m[1].toLowerCase() : "";
    if ((tag === "script" || tag === "style") && rawTag[0] !== "/") {
      const closer = new RegExp(`</${tag}\\s*>`, "i");
      closer.lastIndex = close + 1;
      const rest = html.slice(close + 1);
      const cm = closer.exec(rest);
      i = cm ? close + 1 + cm.index + cm[0].length : n;
      out += "\n\n";
      continue;
    }
    if (BLOCK_TAGS.has(tag)) out += tag === "br" ? "\n" : "\n\n";
    i = close + 1;
  }
  return decodeEntities(out)
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim())
    .filter((p) => p.length > 0);
}

export async function parse(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    throw new ConcordError("FILE_READ", `cannot read ${filePath}: ${e.message}`, { filePath });
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const ext = extname(filePath).toLowerCase();
  const looksHtml = ext === ".html" || ext === ".htm" || /^\s*(<!doctype html|<html)/i.test(raw);
  const issues = [];
  const paras = looksHtml ? htmlToParas(raw) : textToParas(raw);
  if (paras.length === 0) issues.push({ kind: "empty", detail: "file contains no text" });
  return { docs: [{ name: basename(filePath), paras }], issues };
}
