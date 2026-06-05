// Corpora: paginated unit listing with meta filters + substring search, and
// the all-local Instant Read (length histogram, language-mix heuristic, top
// distinctive terms, VADER sentiment sketch through the dictionary engine,
// metadata marginals). Instant Read computes on demand and caches into the
// corpus meta; it never touches a model.
import { readFile } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import { loadProject, updateProject } from "../core/store.js";
import { detect } from "../ingest/mapping.js";
import { score as dictScore } from "../instruments/dictionary.js";
import { findOr404, readCorpusUnits } from "./_shared.js";

// ----------------------------------------------------------- units listing

function unitFilterFrom(query) {
  const q = (query.q ?? "").toLowerCase();
  const metaFilters = Object.entries(query)
    .filter(([k]) => k.startsWith("meta."))
    .map(([k, v]) => [k.slice(5), String(v)]);
  if (!q && metaFilters.length === 0) return null;
  return (u) => {
    for (const [k, v] of metaFilters) {
      if (String(u.meta?.[k]) !== v) return false;
    }
    if (q && !(u.text ?? "").toLowerCase().includes(q)) return false;
    return true;
  };
}

// -------------------------------------------------------------- instantread

const EN_STOP = new Set(("the a an and or but of to in on at for with from by is are was were be been being it its this that these those i you he she we they them my your our as not no do does did have has had will would can could should about so if then than there here what which who when how all any more most very just also").split(" "));
const ES_STOP = new Set(("el la los las un una unos unas de del que y o en es son fue por para con sin no se su sus lo al como más pero este esta estos estas yo tú él ella nosotros ellos mi tu nuestro hay muy ya todo nada".split(" ")));

let vaderPayload = null; // built once from the bundled lexicon

async function getVaderPayload() {
  if (vaderPayload) return vaderPayload;
  const raw = JSON.parse(await readFile(new URL("../lexicons/vader.json", import.meta.url), "utf8"));
  const pos = [];
  const neg = [];
  for (const [term, valence] of Object.entries(raw.terms ?? {})) {
    if (typeof valence !== "number" || valence === 0) continue;
    if (valence > 0) pos.push({ term, weight: valence });
    else neg.push({ term, weight: -valence });
  }
  vaderPayload = {
    categories: [
      { name: "positive", terms: pos },
      { name: "negative", terms: neg },
    ],
    negation: { enabled: true, window: 3 },
    scoring: "count",
  };
  return vaderPayload;
}

function tokenizeWords(text) {
  return (text ?? "").toLowerCase().match(/[\p{L}']+/gu) ?? [];
}

function lengthHistogram(wordCounts, bins = 10) {
  if (wordCounts.length === 0) return { bins: [] };
  const max = Math.max(...wordCounts);
  const width = Math.max(1, Math.ceil((max + 1) / bins));
  const out = Array.from({ length: Math.ceil((max + 1) / width) }, (_, i) => ({
    lo: i * width,
    hi: (i + 1) * width - 1,
    n: 0,
  }));
  for (const c of wordCounts) out[Math.floor(c / width)].n += 1;
  return { bins: out, unit: "words" };
}

function languageOf(tokens) {
  let en = 0;
  let es = 0;
  for (const t of tokens) {
    if (EN_STOP.has(t)) en++;
    if (ES_STOP.has(t)) es++;
  }
  if (en === 0 && es === 0) return "other";
  return en >= es ? "en" : "es";
}

async function computeInstantRead(slug, corpusId) {
  const units = await readCorpusUnits(slug, corpusId);
  if (units.length === 0) {
    throw new ConcordError("VALIDATION", `corpus '${corpusId}' has no units`, { corpusId });
  }
  const tokensPer = units.map((u) => tokenizeWords(u.text));

  // length histogram (word counts)
  const lengthHist = lengthHistogram(tokensPer.map((t) => t.length));

  // language mix
  const langCounts = { en: 0, es: 0, other: 0 };
  tokensPer.forEach((toks) => { langCounts[languageOf(toks)] += 1; });
  const langMix = Object.fromEntries(
    Object.entries(langCounts).map(([k, n]) => [k, Math.round((n / units.length) * 1000) / 1000]),
  );

  // top distinctive terms: frequency excluding stopwords of both languages
  const freq = new Map();
  for (const toks of tokensPer) {
    for (const t of toks) {
      if (t.length < 3 || EN_STOP.has(t) || ES_STOP.has(t)) continue;
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const topTerms = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 20)
    .map(([term, n]) => ({ term, n }));

  // sentiment sketch via the dictionary engine over the VADER lexicon
  const payload = await getVaderPayload();
  const scores = dictScore(units.map((u) => u.text), payload);
  let posN = 0;
  let negN = 0;
  let neuN = 0;
  let valenceSum = 0;
  for (const s of scores) {
    // negated positive terms count as negative signal and vice versa
    const val = (s.positive ?? 0) + (s.NOT_negative ?? 0) - (s.negative ?? 0) - (s.NOT_positive ?? 0);
    valenceSum += val;
    if (val > 0) posN++;
    else if (val < 0) negN++;
    else neuN++;
  }
  const sentimentSketch = {
    lexicon: "VADER",
    positive: Math.round((posN / units.length) * 1000) / 1000,
    negative: Math.round((negN / units.length) * 1000) / 1000,
    neutral: Math.round((neuN / units.length) * 1000) / 1000,
    meanValence: Math.round((valenceSum / units.length) * 1000) / 1000,
  };

  // metadata marginals: top values per categorical column
  const { columns } = detect(units.map((u) => u.meta ?? {}));
  const metaMarginals = columns
    .filter((c) => c.role === "categorical")
    .map((c) => {
      const counts = new Map();
      for (const u of units) {
        const v = String(u.meta?.[c.name] ?? "");
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const values = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 10)
        .map(([value, n]) => ({ value, n }));
      return { column: c.name, values };
    });

  return {
    local: true, // computed entirely on this machine — no model, no network
    unitCount: units.length,
    lengthHist,
    langMix,
    topTerms,
    sentimentSketch,
    metaMarginals,
    computedAt: new Date().toISOString(),
  };
}

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/corpora/:c/units",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      findOr404(project.corpora, params.c, "corpus");
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50) || 50));
      const filter = unitFilterFrom(req.query);
      const units = await readCorpusUnits(params.p, params.c, { offset, limit, ...(filter ? { filter } : {}) });
      const total = (await readCorpusUnits(params.p, params.c, filter ? { filter } : {})).length;
      return { units, total, offset, limit };
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/corpora/:c/instantread",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const corpus = findOr404(project.corpora, params.c, "corpus");
      if (corpus.instantread) return corpus.instantread; // cached in corpus meta
      const result = await computeInstantRead(params.p, params.c);
      await updateProject(params.p, (p) => {
        const c = p.corpora.find((x) => x.id === params.c);
        if (c) c.instantread = result;
      });
      return result;
    },
  },
];
