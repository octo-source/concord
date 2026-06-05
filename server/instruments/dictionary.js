// Concord dictionary engine — LIWC-style closed-vocabulary measurement.
//
// Dictionaries are instruments: instant, free, transparent, deterministic.
// Everything in this module is a pure function of its inputs — no clocks, no
// randomness, no I/O — so identical text always yields identical scores.
//
// DictionaryPayload contract (instruments store this):
//   { categories: [{name, terms: [{term, weight?}]}],
//     negation:   {enabled: boolean, window: number},
//     scoring:    "percentOfWords" | "count" | "binary" }
//
// Term syntax:
//   pay                     plain word (exact token match)
//   underpa*                wildcard prefix (zero-or-more trailing chars)
//   "work life balance"     quoted phrase (token sequence; any unquoted term
//                           containing whitespace is also treated as a phrase)
// "*" is ONLY valid as the final character of a term; anywhere else (e.g.
// "under*pay", "*pay") compile() throws DICTIONARY_INVALID rather than
// silently reinterpreting the term.
//
// Scoring semantics (per unit) — note the deliberate dedup asymmetry:
//   percentOfWords  100 × (matched token positions) / (token count), where
//                   positions are DEDUPED per effective category: a token
//                   matched by several terms of the same category counts
//                   once, so no category can exceed 100%. Phrases claim every
//                   token they cover.
//   count           the sum of weights over EVERY raw term hit, with NO
//                   positional dedup: a token matched by N terms of one
//                   category contributes N times (e.g. token "pay" against
//                   terms `pay` and `pay*` in the same category scores 2).
//                   Each phrase hit contributes once regardless of length.
//   binary          1 if the category had any hit, else 0.
//
// Negation (the LIWC-ish convention): when negation.enabled, a negator token
// within `window` tokens BEFORE a matched term flips that match into category
// NOT_<category> instead of <category>. Spans are still reported for the UI.
// Because results carry NOT_<category> and `empty` keys, category names may
// not be "empty" or start with "NOT_".

import { ConcordError } from "../core/errors.js";

const SCORING_MODES = new Set(["percentOfWords", "count", "binary"]);

// Negator set per spec: not, no, never, nothing, hardly, without — plus any
// token ending in n't (don't, isn't, won't…). Tokens are normalized before
// this check (lowercase, curly apostrophe → straight).
const NEGATORS = new Set(["not", "no", "never", "nothing", "hardly", "without"]);
const isNegator = (tok) => NEGATORS.has(tok) || tok.endsWith("n't");

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

// Unicode-aware: a token is a run of letters/digits, optionally joined by
// internal apostrophes ("don't" stays one token; "gestión" stays intact).
// Leading/trailing apostrophes are quote marks, not token characters.
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Lowercased unicode-aware tokens of `text`. */
export function tokenize(text) {
  return tokenizeSpans(text).map((t) => t.token);
}

// Internal: tokens with their character spans (for hits()). Curly apostrophes
// are normalized to straight so lexicon entries like "don't" match both forms.
function tokenizeSpans(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    out.push({
      token: m[0].toLowerCase().replaceAll("’", "'"),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compile: payload → matcher (build once, score many)
// ---------------------------------------------------------------------------

const COMPILED = Symbol.for("concord.dictionary.compiled");

// Raw payload object → compiled matcher. WeakMap keeps memoization leak-free:
// callers that pass the same payload object to score()/hits() repeatedly pay
// the compile cost once instead of per call. Mutating a payload object after
// its first compile is NOT picked up — build a new object instead.
const RAW_CACHE = new WeakMap();

/**
 * Compile a DictionaryPayload into a matcher: an exact-token map, a prefix
 * trie for wildcards, and a phrase table keyed by first word. score()/hits()
 * accept either a payload (compiled on the fly) or a compiled matcher.
 * Compiling the same payload OBJECT twice returns the same memoized matcher
 * (see RAW_CACHE above), so repeated raw-payload score()/hits() calls are
 * harmless.
 */
export function compile(payload) {
  if (payload && payload[COMPILED]) return payload;
  const cached = typeof payload === "object" && payload !== null
    ? RAW_CACHE.get(payload)
    : undefined;
  if (cached) return cached;
  validatePayload(payload);

  const matcher = {
    [COMPILED]: true,
    categoryNames: payload.categories.map((c) => c.name),
    scoring: payload.scoring ?? "percentOfWords",
    negation: {
      enabled: Boolean(payload.negation?.enabled),
      // validatePayload guarantees window, when present, is a positive integer.
      window: payload.negation?.window ?? 3,
    },
    exact: new Map(), // token → [{cat, weight, src}]
    trieRoot: null, // char trie; node = {children: Map, entries: []|null}
    phrasesByFirst: new Map(), // first word (exact) → [phraseEntry]
    prefixFirstPhrases: [], // phrases whose FIRST word is a wildcard (rare)
    hasPrefixes: false,
    hasPhrases: false,
  };

  for (let ci = 0; ci < payload.categories.length; ci++) {
    const cat = payload.categories[ci];
    for (const t of cat.terms) {
      if (!t || typeof t.term !== "string" || t.term.trim() === "") {
        throw new ConcordError("DICTIONARY_INVALID", "term must be a non-empty string", {
          category: cat.name,
          term: t?.term,
        });
      }
      if (t.weight !== undefined && typeof t.weight !== "number") {
        throw new ConcordError("DICTIONARY_INVALID", "term weight must be a number", {
          category: cat.name,
          term: t.term,
        });
      }
      addTerm(matcher, ci, t.term, t.weight ?? 1);
    }
  }
  RAW_CACHE.set(payload, matcher);
  return matcher;
}

function validatePayload(payload) {
  if (!payload || !Array.isArray(payload.categories)) {
    throw new ConcordError("DICTIONARY_INVALID", "payload.categories must be an array");
  }
  if (payload.scoring !== undefined && !SCORING_MODES.has(payload.scoring)) {
    throw new ConcordError(
      "DICTIONARY_INVALID",
      `scoring must be one of ${[...SCORING_MODES].join("|")}`,
      { scoring: payload.scoring }
    );
  }
  const win = payload.negation?.window;
  if (win !== undefined && (!Number.isInteger(win) || win <= 0)) {
    throw new ConcordError("DICTIONARY_INVALID", "negation.window must be a positive integer", {
      window: win,
    });
  }
  const seen = new Set();
  for (const cat of payload.categories) {
    if (!cat || typeof cat.name !== "string" || cat.name === "") {
      throw new ConcordError("DICTIONARY_INVALID", "category name must be a non-empty string");
    }
    if (cat.name === "empty" || cat.name.startsWith("NOT_")) {
      throw new ConcordError(
        "DICTIONARY_INVALID",
        `category name "${cat.name}" is reserved (result objects use "empty" and "NOT_<category>" keys)`,
        { category: cat.name }
      );
    }
    if (seen.has(cat.name)) {
      throw new ConcordError("DICTIONARY_INVALID", `duplicate category "${cat.name}"`);
    }
    seen.add(cat.name);
    if (!Array.isArray(cat.terms)) {
      throw new ConcordError("DICTIONARY_INVALID", `category "${cat.name}" terms must be an array`);
    }
  }
}

// Parse one authored term string into matcher structures. `src` is preserved
// verbatim for hit reporting and .dic round-trips.
function addTerm(matcher, cat, src, weight) {
  let body = src.trim();
  const quoted = body.length >= 2 && body.startsWith('"') && body.endsWith('"');
  if (quoted) body = body.slice(1, -1).trim();

  // "*" is only meaningful as the final character (trailing wildcard). A star
  // anywhere else would be silently dropped by the tokenizer — "under*pay"
  // would become the phrase "under pay" and "*pay" the exact term "pay" — so
  // reject it loudly instead of reinterpreting the author's intent.
  const star = body.indexOf("*");
  if (star !== -1 && star !== body.length - 1) {
    throw new ConcordError(
      "DICTIONARY_INVALID",
      `term "${src}": "*" is only allowed as the final character (trailing wildcard)`,
      { term: src }
    );
  }

  const words = tokenize(body); // normalizes case/apostrophes like real text
  if (words.length === 0) {
    throw new ConcordError("DICTIONARY_INVALID", `term "${src}" contains no word characters`);
  }
  const wildcard = /\*\s*$/.test(body); // trailing * applies to the LAST word
  const wordSpecs = words.map((w, i) => ({
    prefix: wildcard && i === words.length - 1,
    value: w,
  }));

  if (wordSpecs.length === 1) {
    const [w] = wordSpecs;
    const entry = { cat, weight, src };
    if (w.prefix) {
      matcher.hasPrefixes = true;
      matcher.trieRoot ??= { children: new Map(), entries: null };
      let node = matcher.trieRoot;
      // Insert CODE UNITS (w.value[i]), not code points (for…of), so the trie
      // agrees with the code-unit walk in matchTokens — otherwise terms with
      // astral-plane characters (surrogate pairs) could never match.
      for (let ci = 0; ci < w.value.length; ci++) {
        const ch = w.value[ci];
        let next = node.children.get(ch);
        if (!next) {
          next = { children: new Map(), entries: null };
          node.children.set(ch, next);
        }
        node = next;
      }
      (node.entries ??= []).push(entry);
    } else {
      let list = matcher.exact.get(w.value);
      if (!list) matcher.exact.set(w.value, (list = []));
      list.push(entry);
    }
    return;
  }

  // Phrase.
  matcher.hasPhrases = true;
  const phrase = { words: wordSpecs, len: wordSpecs.length, cat, weight, src };
  if (wordSpecs[0].prefix) {
    matcher.prefixFirstPhrases.push(phrase);
  } else {
    let list = matcher.phrasesByFirst.get(wordSpecs[0].value);
    if (!list) matcher.phrasesByFirst.set(wordSpecs[0].value, (list = []));
    list.push(phrase);
  }
}

// ---------------------------------------------------------------------------
// Matching core
// ---------------------------------------------------------------------------

const unitText = (unit) =>
  typeof unit === "string" ? unit : unit && typeof unit.text === "string" ? unit.text : "";

const wordMatches = (spec, tok) =>
  spec.prefix ? tok.startsWith(spec.value) : tok === spec.value;

// All raw term matches in a token stream: {cat, weight, src, at, len, negated}.
function matchTokens(tokens, m) {
  const out = [];
  const n = tokens.length;
  for (let i = 0; i < n; i++) {
    const tok = tokens[i].token;

    const exactList = m.exact.get(tok);
    if (exactList) {
      for (const e of exactList) out.push({ e, at: i, len: 1 });
    }

    if (m.hasPrefixes) {
      let node = m.trieRoot;
      for (let c = 0; c < tok.length && node; c++) {
        node = node.children.get(tok[c]);
        if (node && node.entries) {
          for (const e of node.entries) out.push({ e, at: i, len: 1 });
        }
      }
    }

    if (m.hasPhrases) {
      const cands = m.phrasesByFirst.get(tok);
      if (cands) {
        for (const p of cands) {
          if (i + p.len <= n && phraseMatchesAt(p, tokens, i, 1)) {
            out.push({ e: p, at: i, len: p.len });
          }
        }
      }
      if (m.prefixFirstPhrases.length > 0) {
        for (const p of m.prefixFirstPhrases) {
          if (i + p.len <= n && wordMatches(p.words[0], tok) && phraseMatchesAt(p, tokens, i, 1)) {
            out.push({ e: p, at: i, len: p.len });
          }
        }
      }
    }
  }

  if (m.negation.enabled && out.length > 0) {
    const w = m.negation.window;
    for (const hit of out) {
      const from = Math.max(0, hit.at - w);
      for (let j = from; j < hit.at; j++) {
        if (isNegator(tokens[j].token)) {
          hit.negated = true;
          break;
        }
      }
    }
  }
  return out;
}

function phraseMatchesAt(p, tokens, i, fromWord) {
  for (let k = fromWord; k < p.len; k++) {
    if (!wordMatches(p.words[k], tokens[i + k].token)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// score / hits
// ---------------------------------------------------------------------------

/**
 * Score units against a payload (or precompiled matcher). `units` must be an
 * ARRAY of strings or {text} objects (a bare string throws DICTIONARY_INVALID
 * — it would otherwise be scored per character). Returns one result object
 * per unit: {<category>: value, ...} per payload.scoring; when negation is
 * enabled, NOT_<category> keys are always present too. Empty / zero-token
 * units score 0 everywhere and carry `empty: true`.
 *
 * Dedup semantics differ by mode — this is intentional:
 * - percentOfWords dedupes token POSITIONS per effective category: a token
 *   matched by several terms of the same category counts once, so values
 *   never exceed 100. Phrases claim every token they cover.
 * - count applies NO positional dedup: every raw hit adds its term weight,
 *   so a token matched by both `pay` and `pay*` in one category scores 2.
 *   Each phrase hit adds its weight once regardless of phrase length.
 * - binary reports 1 for any hit in the category, else 0.
 */
export function score(units, payload) {
  if (!Array.isArray(units)) {
    throw new ConcordError(
      "DICTIONARY_INVALID",
      "score() units must be an array of strings or {text} objects",
      { received: typeof units }
    );
  }
  const m = compile(payload);
  const results = new Array(units.length);
  for (let u = 0; u < units.length; u++) {
    results[u] = scoreOne(tokenizeSpans(unitText(units[u])), m);
  }
  return results;
}

function blankResult(m) {
  const r = {};
  for (const name of m.categoryNames) {
    r[name] = 0;
    if (m.negation.enabled) r["NOT_" + name] = 0;
  }
  return r;
}

function scoreOne(tokens, m) {
  const r = blankResult(m);
  if (tokens.length === 0) {
    r.empty = true;
    return r;
  }
  const matches = matchTokens(tokens, m);
  if (matches.length === 0) return r;

  if (m.scoring === "percentOfWords") {
    // Percent of words: unique token positions per effective category, so a
    // token matched by two terms of the same category counts once and no
    // category can exceed 100%. Phrases count their full token length.
    const positions = new Map(); // effective cat name → Set<token index>
    for (const hit of matches) {
      const name = (hit.negated ? "NOT_" : "") + m.categoryNames[hit.e.cat];
      let set = positions.get(name);
      if (!set) positions.set(name, (set = new Set()));
      for (let k = 0; k < hit.len; k++) set.add(hit.at + k);
    }
    for (const [name, set] of positions) r[name] = (100 * set.size) / tokens.length;
  } else if (m.scoring === "count") {
    for (const hit of matches) {
      const name = (hit.negated ? "NOT_" : "") + m.categoryNames[hit.e.cat];
      r[name] += hit.e.weight;
    }
  } else {
    // binary
    for (const hit of matches) {
      const name = (hit.negated ? "NOT_" : "") + m.categoryNames[hit.e.cat];
      r[name] = 1;
    }
  }
  return r;
}

/**
 * Character spans of every term match in one unit, for UI highlighting:
 * [{category, term, start, end}], sorted by start then category. Overlapping
 * matches from different categories are all reported; negated matches carry
 * their NOT_<category> name.
 */
export function hits(unit, payload) {
  const m = compile(payload);
  const tokens = tokenizeSpans(unitText(unit));
  const out = matchTokens(tokens, m).map((hit) => ({
    category: (hit.negated ? "NOT_" : "") + m.categoryNames[hit.e.cat],
    term: hit.e.src,
    start: tokens[hit.at].start,
    end: tokens[hit.at + hit.len - 1].end,
  }));
  out.sort((a, b) => a.start - b.start || a.end - b.end || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// LIWC .dic format
// ---------------------------------------------------------------------------

/**
 * Parse LIWC .dic text:
 *   %
 *   1<TAB>posemo
 *   2<TAB>negemo
 *   %
 *   happy<TAB>1
 *   abandon*<TAB>2
 * Wildcards are preserved; a term field containing spaces becomes a phrase.
 * Negation defaults off (LIWC dictionaries do not encode it) and scoring
 * defaults to percentOfWords, the LIWC convention.
 *
 * Returns { payload, warnings } — NOT the bare payload. Genuine LIWC
 * 2007/2015 files contain parenthesized conditional entries (e.g.
 * `like<TAB>(2 134)2/96`) that plain term→category lines cannot express;
 * each such line is skipped and reported in `warnings` as
 * {line, term, reason: "LIWC conditional syntax unsupported"} so the rest of
 * the file still imports. Malformed non-conditional lines still throw
 * DICTIONARY_PARSE with their line number.
 */
export function parseDic(text) {
  if (typeof text !== "string") {
    throw new ConcordError("DICTIONARY_PARSE", ".dic input must be a string");
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== "%") {
    throw new ConcordError("DICTIONARY_PARSE", '.dic must open with a "%" header line', {
      line: i + 1,
    });
  }
  i++;

  const idToIndex = new Map();
  const categories = [];
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (line === "%") {
      i++;
      break;
    }
    const sep = line.search(/\s/);
    if (sep === -1) {
      throw new ConcordError("DICTIONARY_PARSE", `bad category line: "${line}"`, { line: i + 1 });
    }
    const id = line.slice(0, sep).trim();
    const name = line.slice(sep).trim();
    if (!/^\d+$/.test(id) || name === "") {
      throw new ConcordError("DICTIONARY_PARSE", `bad category line: "${line}"`, { line: i + 1 });
    }
    if (idToIndex.has(id)) {
      throw new ConcordError("DICTIONARY_PARSE", `duplicate category id ${id}`, { line: i + 1 });
    }
    idToIndex.set(id, categories.length);
    categories.push({ name, terms: [] });
  }
  if (idToIndex.size === 0) {
    throw new ConcordError("DICTIONARY_PARSE", ".dic has no categories");
  }

  const warnings = [];
  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    // Term is everything before the first tab (LIWC) — may contain spaces
    // (phrase). Fall back to last-whitespace split for space-separated files
    // with single-word terms.
    let term, idPart;
    const tab = raw.indexOf("\t");
    if (tab !== -1) {
      term = raw.slice(0, tab).trim();
      idPart = raw.slice(tab + 1);
    } else {
      const t = raw.trim();
      const sp = t.search(/\s/);
      if (sp === -1) {
        throw new ConcordError("DICTIONARY_PARSE", `term line has no category ids: "${t}"`, {
          line: i + 1,
        });
      }
      term = t.slice(0, sp).trim();
      idPart = t.slice(sp);
    }
    const ids = idPart.trim().split(/\s+/);
    if (term === "" || ids.length === 0 || ids[0] === "") {
      throw new ConcordError("DICTIONARY_PARSE", `bad term line: "${raw}"`, { line: i + 1 });
    }
    // LIWC 2007/2015 conditional entries put a parenthesized expression in
    // the id field, e.g. `like<TAB>(2 134)2/96`. Those are not expressible
    // here — skip the line with a warning instead of failing the import.
    if (ids.some((id) => id.startsWith("("))) {
      warnings.push({ line: i + 1, term, reason: "LIWC conditional syntax unsupported" });
      continue;
    }
    for (const id of ids) {
      const idx = idToIndex.get(id);
      if (idx === undefined) {
        throw new ConcordError("DICTIONARY_PARSE", `term "${term}" references unknown id ${id}`, {
          line: i + 1,
        });
      }
      categories[idx].terms.push({ term });
    }
  }

  return {
    payload: {
      categories,
      negation: { enabled: false, window: 3 },
      scoring: "percentOfWords",
    },
    warnings,
  };
}

/**
 * Serialize a payload to LIWC .dic text. Terms shared across categories are
 * merged onto one line with multiple ids (the LIWC convention). Weights and
 * negation settings cannot be expressed in .dic — weighted payloads throw,
 * as do category names or terms containing tabs/newlines (the format's
 * delimiters), all with DICTIONARY_UNSUPPORTED.
 */
export function toDic(payload) {
  validatePayload(payload);
  const lines = ["%"];
  payload.categories.forEach((cat, i) => {
    if (/[\t\n]/.test(cat.name)) {
      throw new ConcordError(
        "DICTIONARY_UNSUPPORTED",
        ".dic format cannot express tabs or newlines in category names",
        { category: cat.name }
      );
    }
    lines.push(`${i + 1}\t${cat.name}`);
  });
  lines.push("%");

  const termIds = new Map(); // verbatim term → [ids], in first-appearance order
  payload.categories.forEach((cat, i) => {
    for (const t of cat.terms) {
      if (typeof t.term === "string" && /[\t\n]/.test(t.term)) {
        throw new ConcordError(
          "DICTIONARY_UNSUPPORTED",
          ".dic format cannot express tabs or newlines in terms",
          { category: cat.name, term: t.term }
        );
      }
      if (t.weight !== undefined && t.weight !== 1) {
        throw new ConcordError(
          "DICTIONARY_UNSUPPORTED",
          ".dic format cannot express term weights",
          { category: cat.name, term: t.term, weight: t.weight }
        );
      }
      let ids = termIds.get(t.term);
      if (!ids) termIds.set(t.term, (ids = []));
      if (!ids.includes(i + 1)) ids.push(i + 1);
    }
  });
  for (const [term, ids] of termIds) lines.push(`${term}\t${ids.join("\t")}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// TSV lexicon import (NRC EmoLex et al. — import-not-bundle for license)
// ---------------------------------------------------------------------------

/**
 * Build a DictionaryPayload from a TSV lexicon such as NRC EmoLex
 * (term<TAB>category<TAB>flag). Column options are 0-based indices.
 * With valueCol: rows whose value is 0 are skipped (EmoLex's "no
 * association"); a value of exactly 1 adds an unweighted term; any other
 * number becomes the term weight (covers intensity lexicons).
 */
export function importTsvLexicon(text, { termCol, categoryCol, valueCol } = {}) {
  if (typeof text !== "string") {
    throw new ConcordError("DICTIONARY_PARSE", "TSV input must be a string");
  }
  if (!Number.isInteger(termCol) || !Number.isInteger(categoryCol)) {
    throw new ConcordError("DICTIONARY_PARSE", "termCol and categoryCol are required (0-based)");
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const catIndex = new Map();
  const categories = [];
  const need = Math.max(termCol, categoryCol, valueCol ?? 0);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const cols = lines[i].split("\t").map((c) => c.trim());
    if (cols.length <= need) {
      throw new ConcordError("DICTIONARY_PARSE", `row ${i + 1} has ${cols.length} columns, need > ${need}`, {
        line: i + 1,
      });
    }
    const term = cols[termCol];
    const catName = cols[categoryCol];
    if (term === "" || catName === "") {
      throw new ConcordError("DICTIONARY_PARSE", `row ${i + 1} has an empty term or category`, {
        line: i + 1,
      });
    }
    let weight;
    if (valueCol !== undefined) {
      const v = Number(cols[valueCol]);
      if (Number.isNaN(v)) {
        throw new ConcordError("DICTIONARY_PARSE", `row ${i + 1} value "${cols[valueCol]}" is not a number`, {
          line: i + 1,
        });
      }
      if (v === 0) continue; // no association
      if (v !== 1) weight = v;
    }
    let idx = catIndex.get(catName);
    if (idx === undefined) {
      idx = categories.length;
      catIndex.set(catName, idx);
      categories.push({ name: catName, terms: [] });
    }
    categories[idx].terms.push(weight === undefined ? { term } : { term, weight });
  }

  return {
    categories,
    negation: { enabled: false, window: 3 },
    scoring: "percentOfWords",
  };
}
