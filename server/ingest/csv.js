// Hand-rolled RFC 4180 CSV parser. No regex in the hot path — a single
// char-by-char state machine handles quoted fields, "" escapes, embedded
// newlines, CRLF/LF/CR endings. Recovers from ragged rows and unterminated
// quotes with recorded issues instead of throwing.
import { readFile } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";

const CANDIDATES = [",", ";", "\t"];

// Count delimiter occurrences outside quoted regions for one physical line.
function countOutsideQuotes(line, delim) {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === delim && !inQ) n++;
  }
  return n;
}

// Sniff delimiter from the first 20 physical lines: for each candidate take
// the modal per-line count; score = lines agreeing with a nonzero mode.
export function sniffDelimiter(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length && lines.length < 20; i++) {
    const c = text[i];
    if (c === "\n" || c === "\r") {
      if (i > start) lines.push(text.slice(start, i));
      if (c === "\r" && text[i + 1] === "\n") i++;
      start = i + 1;
    }
  }
  if (start < text.length && lines.length < 20) lines.push(text.slice(start));
  if (lines.length === 0) return ",";

  let best = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    let mode = 0;
    let modeFreq = 0;
    for (const [c, f] of freq) {
      if (c > 0 && (f > modeFreq || (f === modeFreq && c > mode))) {
        mode = c;
        modeFreq = f;
      }
    }
    const score = mode > 0 ? modeFreq * 1000 + mode : 0;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return bestScore > 0 ? best : null; // null -> single-column file
}

// Core state machine: text -> array of string[] records.
function parseRecords(text, delim, issues) {
  const records = [];
  let field = "";
  let record = [];
  let inQ = false;
  let i = 0;
  const n = text.length;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQ = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      if (field.length === 0) {
        inQ = true; // opening quote at field start
      } else {
        field += ch; // stray quote inside unquoted field: keep literal
      }
      i++;
    } else if (delim !== null && ch === delim) {
      pushField();
      i++;
    } else if (ch === "\n") {
      pushRecord();
      i++;
    } else if (ch === "\r") {
      pushRecord();
      i += text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (inQ) {
    issues.push({
      kind: "unterminated_quote",
      detail: "quote opened but never closed; remainder taken as one field",
    });
  }
  if (field.length > 0 || record.length > 0) pushRecord();
  // Drop fully-empty trailing records (file ends with newline)
  while (
    records.length &&
    records[records.length - 1].length === 1 &&
    records[records.length - 1][0] === ""
  ) {
    records.pop();
  }
  return records;
}

const NUM_RE = /^[+-]?\d+(\.\d+)?$/;

// First record is a header iff: all cells non-empty, none purely numeric,
// and names are usable. Otherwise synthesize col1..colN.
function looksLikeHeader(rec) {
  if (rec.length === 0) return false;
  for (const cell of rec) {
    const t = cell.trim();
    if (t === "") return false;
    if (NUM_RE.test(t)) return false;
  }
  return true;
}

function makeHeader(records, issues) {
  let width = 0; // no spread: records can number in the millions
  for (const r of records) if (r.length > width) width = r.length;
  if (looksLikeHeader(records[0])) {
    const names = [];
    const assigned = new Set();
    // Raw header names are reserved up front so a synthesized "_N" suffix can
    // never steal a REAL later column's name (headers "x,x,x_2" must keep all
    // three columns: x, x_3, x_2 — not silently collapse two onto "x_2").
    const rawSet = new Set(records[0].map((r) => r.trim()));
    let dup = false;
    for (const raw of records[0]) {
      const base = raw.trim();
      let name = base;
      if (assigned.has(name)) {
        dup = true;
        let k = 2;
        while (assigned.has(`${base}_${k}`) || rawSet.has(`${base}_${k}`)) k++;
        name = `${base}_${k}`;
      }
      assigned.add(name);
      names.push(name);
    }
    while (names.length < width) {
      let i = names.length + 1;
      while (assigned.has(`col${i}`)) i++;
      assigned.add(`col${i}`);
      names.push(`col${i}`);
    }
    if (dup)
      issues.push({ kind: "dup_header", detail: "duplicate header names deduped with _N suffix" });
    return { names, dataStart: 1 };
  }
  issues.push({
    kind: "no_header",
    detail: "first row does not look like a header; synthesized col1..colN",
  });
  return { names: Array.from({ length: width }, (_, i) => `col${i + 1}`), dataStart: 0 };
}

// Parse a CSV/TSV file from disk. Whole-buffer read (fine <= 200MB).
// Returns {rows: object[], issues: [{kind, detail, row?}]}.
export async function parse(filePath, { delimiter } = {}) {
  let buf;
  try {
    buf = await readFile(filePath);
  } catch (e) {
    throw new ConcordError("FILE_READ", `cannot read ${filePath}: ${e.message}`, { filePath });
  }
  // BOM strip
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }
  const text = buf.toString("utf8");
  const issues = [];
  if (text.trim() === "") {
    issues.push({ kind: "empty", detail: "file contains no data" });
    return { rows: [], issues };
  }
  const delim = delimiter !== undefined ? delimiter : sniffDelimiter(text);
  const records = parseRecords(text, delim, issues);
  if (records.length === 0) {
    issues.push({ kind: "empty", detail: "no records after parsing" });
    return { rows: [], issues };
  }
  const { names, dataStart } = makeHeader(records, issues);
  const rows = [];
  for (let r = dataStart; r < records.length; r++) {
    const rec = records[r];
    const row = {};
    if (rec.length !== names.length) {
      issues.push({
        kind: "ragged_row",
        detail: `row has ${rec.length} cells, expected ${names.length}; ${rec.length < names.length ? "padded" : "extras kept as __extraN"}`,
        row: rows.length,
      });
    }
    for (let c = 0; c < names.length; c++) row[names[c]] = rec[c] !== undefined ? rec[c] : "";
    for (let c = names.length; c < rec.length; c++) row[`__extra${c - names.length + 1}`] = rec[c];
    rows.push(row);
  }
  return { rows, issues };
}
