// Unitization: parsed source -> Unit[] for schemes response|sentence|paragraph|turn.
// Unit: {id, text, meta, pos} with id = ids.unitId(corpusId, sourceIndex, text),
// where sourceIndex is derived from the unit's position in the parsed source
// (not the emitted ordinal), so ids are stable across re-imports.
import { unitId } from "../core/ids.js";
import { ConcordError } from "../core/errors.js";
import { bestTextColumn } from "./mapping.js";

// Abbreviations that end with "." but do not end a sentence.
const ABBREV = [
  "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "St.", "vs.", "etc.", "e.g.", "i.e.",
  "U.S.", "No.", "Fig.", "Jr.", "Sr.", "al.", "Inc.", "Ltd.", "Co.", "Ave.",
  "Dept.", "approx.", "Mt.", "Rev.", "Gen.", "Sgt.", "Capt.", "Col.",
];
const ABBREV_LOWER = ABBREV.map((a) => a.toLowerCase());

function endsWithAbbrev(chunk) {
  // chunk includes the terminating punctuation, e.g. "He met Dr."
  const lower = chunk.toLowerCase();
  for (const a of ABBREV_LOWER) {
    if (lower.endsWith(a)) {
      // require a word boundary before the abbreviation ("Dr." yes, "badr." no)
      const before = lower[lower.length - a.length - 1];
      if (before === undefined || !/[a-z0-9]/.test(before)) return true;
    }
  }
  // single-letter initials: "J. Smith"
  if (/(^|[^A-Za-z])[A-Za-z]\.$/.test(chunk)) return true;
  return false;
}

// Split text into sentences: boundary = [.!?]+ then whitespace then a capital
// (optionally behind quotes/brackets), unless the text so far ends in a
// guarded abbreviation.
export function splitSentences(text) {
  const t = text.trim();
  if (!t) return [];
  const out = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    let j = i;
    while (j + 1 < t.length && (t[j + 1] === "." || t[j + 1] === "!" || t[j + 1] === "?" || t[j + 1] === '"' || t[j + 1] === "'" || t[j + 1] === ")")) j++;
    let k = j + 1;
    if (k >= t.length) break; // end of text closes last sentence below
    if (!/\s/.test(t[k])) continue; // needs whitespace after punctuation
    while (k < t.length && /\s/.test(t[k])) k++;
    let c = t[k];
    if (c === '"' || c === "'" || c === "(" || c === "[") c = t[k + 1];
    if (c === undefined || !/[A-Z0-9À-Ü]/.test(c)) continue; // next sentence starts with capital/digit
    if (ch === "." && endsWithAbbrev(t.slice(start, i + 1))) continue;
    out.push(t.slice(start, j + 1).trim());
    start = k;
    i = k - 1;
  }
  const last = t.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function pickTextColumn(rows, textColumn, issues) {
  if (textColumn) return textColumn;
  const best = bestTextColumn(rows);
  if (best) return best;
  // Fallback: longest mean-length string column so tiny corpora still work.
  let bestName = null;
  let bestLen = -1;
  const names = rows.length ? Object.keys(rows[0]) : [];
  for (const name of names) {
    if (name.startsWith("__")) continue;
    let sum = 0;
    for (const r of rows) sum += String(r[name] ?? "").length;
    if (sum / rows.length > bestLen) {
      bestLen = sum / rows.length;
      bestName = name;
    }
  }
  if (!bestName) throw new ConcordError("NO_TEXT_COLUMN", "cannot determine a text column", {});
  issues?.push?.({ kind: "text_column_guess", detail: `no clear text column; using "${bestName}"` });
  return bestName;
}

// unitize(corpusId, parsed, scheme, {textColumn?}) -> Unit[]
// Schemes: response (rows), paragraph (docs), turn (turns),
// sentence (any source: splits each base text into sentence units).
export function unitize(corpusId, parsed, scheme, { textColumn } = {}) {
  if (!parsed || typeof parsed !== "object") {
    throw new ConcordError("BAD_PARSED", "unitize requires a parsed result object", {});
  }
  const bases = []; // {text, meta, pos}
  if (Array.isArray(parsed.rows)) {
    if (scheme !== "response" && scheme !== "sentence") {
      throw new ConcordError("BAD_SCHEME", `scheme "${scheme}" does not apply to tabular rows`, { scheme });
    }
    const col = parsed.rows.length ? pickTextColumn(parsed.rows, textColumn, parsed.issues) : textColumn;
    parsed.rows.forEach((row, r) => {
      const text = String(row[col] ?? "").trim();
      if (!text) return;
      const meta = {};
      for (const [k, v] of Object.entries(row)) {
        if (k !== col) meta[k] = v === undefined ? null : v;
      }
      bases.push({ text, meta, pos: { row: r }, src: r });
    });
  } else if (Array.isArray(parsed.docs)) {
    if (scheme !== "paragraph" && scheme !== "sentence" && scheme !== "response") {
      throw new ConcordError("BAD_SCHEME", `scheme "${scheme}" does not apply to documents`, { scheme });
    }
    parsed.docs.forEach((doc, di) => {
      if (scheme === "response") {
        // whole document as one unit
        const text = doc.paras.join("\n\n").trim();
        if (text) bases.push({ text, meta: { doc: doc.name }, pos: { doc: doc.name }, src: di });
        return;
      }
      doc.paras.forEach((p, pi) => {
        const text = String(p).trim();
        if (!text) return;
        const pos = { doc: doc.name, para: pi };
        const meta = { doc: doc.name };
        if (Array.isArray(doc.pages) && doc.pages[pi] !== undefined) meta.page = doc.pages[pi];
        bases.push({ text, meta, pos, src: `${di}:${pi}` });
      });
    });
  } else if (Array.isArray(parsed.turns)) {
    if (scheme !== "turn" && scheme !== "sentence") {
      throw new ConcordError("BAD_SCHEME", `scheme "${scheme}" does not apply to transcripts`, { scheme });
    }
    parsed.turns.forEach((turn, ti) => {
      const text = String(turn.text ?? "").trim();
      if (!text) return;
      bases.push({
        text,
        meta: { speaker: turn.speaker ?? null },
        pos: { turn: ti, speaker: turn.speaker ?? null, t0: turn.t0 ?? null, t1: turn.t1 ?? null },
        src: ti,
      });
    });
  } else {
    throw new ConcordError("BAD_PARSED", "parsed result has none of rows/docs/turns", { keys: Object.keys(parsed) });
  }

  const units = [];
  for (const b of bases) {
    const texts = scheme === "sentence" ? splitSentences(b.text) : [b.text];
    texts.forEach((text, si) => {
      // Ids hash the unit's SOURCE index (b.src), never the emitted ordinal,
      // so ids stay stable across re-imports even when empty elements are
      // skipped: rows use the literal row index, paragraphs "<doc>:<para>",
      // turns the turn index, whole-doc responses the doc index. Sentence
      // units append the sentence's index within its source element
      // ("<src>:<n>"), which keeps identical sentences in different elements
      // from colliding.
      const idx = scheme === "sentence" ? `${b.src}:${si}` : b.src;
      units.push({ id: unitId(corpusId, idx, text), text, meta: b.meta, pos: b.pos });
    });
  }
  return units;
}
