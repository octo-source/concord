// Corpora: paginated unit listing with meta filters + substring search, and
// the all-local Instant Read (length histogram, language-mix heuristic, top
// distinctive terms, VADER sentiment sketch through the dictionary engine,
// metadata marginals). Instant Read computes on demand and caches into the
// corpus meta; it never touches a model.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConcordError } from "../core/errors.js";
import { newId, unitId } from "../core/ids.js";
import { loadProject, updateProject } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { detect } from "../ingest/mapping.js";
import { scan as junkScan } from "../ingest/junk.js";
import { scan as piiScan, pseudonymize } from "../ingest/pii.js";
import { score as dictScore, tokenize as dictTokenize } from "../instruments/dictionary.js";
import { estimateRun } from "../providers/costs.js";
import { getAdapter } from "../providers/registry.js";
import { briefSampleTarget } from "../director/brief.js";
import { metaColumnsOf } from "./import.js";
import { findOr404, readCorpusUnits, requireBody, pdirOf, writeTextAtomic, corpusUnitsFile, readJsonFile, writeJsonAtomic } from "./_shared.js";

// ------------------------------------------------------------------- scope

// Scope provenance off a corpus entry (import.js records the fields at
// confirm/reunitize). Old corpora predate them: fall back to the unitization
// block where possible and read null — never throw — for the rest.
export function scopeOf(corpus) {
  return {
    textColumn: corpus.textColumn ?? corpus.unitization?.textColumn ?? null,
    scheme: corpus.scheme ?? corpus.unitization?.scheme ?? null,
    unitCount: corpus.unitCount ?? null,
    junk: corpus.junk ?? null,
    metaColumns: corpus.metaColumns ?? null,
    derivedFrom: corpus.derivedFrom ?? null,
  };
}

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

// Stopwords for the Instant Read's distinctive-terms ranking: English +
// Spanish function words PLUS the connective/adverbial glue that survey prose
// (and our demo generator) leans on — "meanwhile", "honestly", "plus", "on
// top of that" — which raw frequency would otherwise rank above theme words.
const EN_STOP = new Set((
  "the a an and or but of to in on at for with from by is are was were be been being it its this that these those " +
  "i you he she we they them me him her us my your our their as not no nor do does did done have has had having " +
  "will would can could should shall may might must about so if then than there here what which who whom whose when " +
  "where why how all any both each few more most other some such only own same too very just also even still yet " +
  "again further once because while during before after above below beyond between into through over under out off up down " +
  "against am isn isnt arent wasnt werent dont doesnt didnt wont wouldnt cant couldnt shouldnt im ive youre theyre " +
  "weve youve id youd hed shed wed theyd ill youll well thats whats lets one two three first second third never " +
  "always often sometimes usually really actually honestly frankly truly simply basically literally meanwhile plus " +
  "anyway anyhow besides instead moreover however therefore thus hence otherwise although though despite regarding " +
  "since until unless whether either neither around across along within without toward towards onto upon per via " +
  "top made make makes making get gets got getting go goes going went gone come comes coming came say says said " +
  "saying see sees seen saw look looks looked looking way ways thing things stuff lot lots bit kind sort like liked " +
  "want wanted wants know knows knew known think thinks thought feel feels felt time times year years month months " +
  "week weeks day days people person someone anyone everyone nothing something anything everything none much many " +
  "back end ended start started keep keeps kept put puts let need needs needed asked ask asks new old last next " +
  "every another able sure right left good bad better best worse worst big small long short high low real own"
).split(/\s+/));
const ES_STOP = new Set((
  "el la los las un una unos unas de del que y o u e en es son fue era eran ser está están estaba estaban estar " +
  "por para con sin no ni se su sus lo le les al como más menos pero este esta estos estas ese esa esos esas aquel " +
  "aquella yo tú usted él ella nosotros nosotras ellos ellas mi mis tu tus nuestro nuestra nuestros nuestras hay " +
  "muy ya todo toda todos todas nada algo alguien nadie cada cual cuales quien quienes cuando donde mientras aunque " +
  "porque pues entonces también tampoco además luego después antes desde hasta entre sobre bajo contra durante " +
  "sino siempre nunca jamás casi sólo solo bien mal mucho mucha muchos muchas poco poca pocos pocas otro otra otros " +
  "otras mismo misma mismos mismas vez veces año años mes meses día días gente persona cosa cosas fui fue eso esto " +
  "aquí allí ahí así tan tanto tanta tantos tantas qué cómo dónde cuándo me te nos os les uno dos tres haber tener " +
  "tenía tenían tiene tienen hacer hace hacen hacía hicieron hizo decir dice dicen dijo ir va van iba fueron"
).split(/\s+/));

// Top distinctive terms: tokenize with the dictionary engine's tokenizer
// (lowercased, apostrophe-normalized), drop stopwords and tokens shorter
// than 3 chars or purely numeric, then rank by tf·idf — count × log(N/df),
// i.e. term frequency damped by document frequency. The damping is what
// makes this "distinctiveness": corpus-wide glue that survives the stoplist
// (appearing in most units) gets idf ≈ 0, while theme vocabulary that
// concentrates in a fraction of units keeps its weight. Top 20 [{term, count}].
function topDistinctiveTerms(tokensPer, { limit = 20, minLength = 3 } = {}) {
  const count = new Map(); // term → total occurrences
  const df = new Map();    // term → number of units containing the term
  const nUnits = tokensPer.length || 1;
  for (const toks of tokensPer) {
    const seen = new Set();
    for (const t of toks) {
      if (t.length < minLength || EN_STOP.has(t) || ES_STOP.has(t) || /^\d+$/.test(t)) continue;
      count.set(t, (count.get(t) ?? 0) + 1);
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  return [...count.entries()]
    .map(([term, n]) => ({ term, count: n, score: n * Math.log(nUnits / df.get(term)) }))
    .sort((a, b) => b.score - a.score || b.count - a.count || (a.term < b.term ? -1 : 1))
    .slice(0, limit)
    .map(({ term, count: n }) => ({ term, count: n }));
}

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

  // top distinctive terms — tf·idf over the dictionary tokenizer (see above)
  const topTerms = topDistinctiveTerms(units.map((u) => dictTokenize(u.text)));

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
    // mean unit length in characters — cached so the brief price (which is
    // NOT cached: it follows the live Director slot) never re-reads units
    meanUnitChars: Math.round(units.reduce((n, u) => n + (u.text ?? "").length, 0) / units.length),
    lengthHist,
    langMix,
    topTerms,
    sentimentSketch,
    metaMarginals,
    computedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------- columns

// The corpus's REAL variable list (contract for pickers, stratification and
// the workbench): mapping.detect over the units' metadata, sampled at most
// COLUMNS_SAMPLE_LIMIT units for speed, cached on the corpus entry like
// instantread (recomputed only on absence). The corpus's text column is NOT
// in the list — it is the unit text, not a variable. Categorical columns
// carry their top values [{value, n}] so the UI never invents demo columns.
const COLUMNS_SAMPLE_LIMIT = 2000;
const COLUMNS_TOP_VALUES = 8;

const isBlankMetaValue = (v) => v === null || v === undefined || String(v).trim() === "";

async function computeColumns(slug, corpusId, corpus) {
  const units = await readCorpusUnits(slug, corpusId, { limit: COLUMNS_SAMPLE_LIMIT });
  if (units.length === 0) {
    throw new ConcordError("VALIDATION", `corpus '${corpusId}' has no units`, { corpusId });
  }
  const textColumn = scopeOf(corpus).textColumn;
  const { columns } = detect(units.map((u) => u.meta ?? {}));
  const out = [];
  for (const c of columns) {
    if (c.name === textColumn) continue; // the unit text is not a variable
    const entry = { name: c.name, role: c.role, distinct: c.stats.distinct, missing: c.stats.missing };
    if (c.role === "categorical") {
      const counts = new Map();
      for (const u of units) {
        const v = u.meta?.[c.name];
        if (isBlankMetaValue(v)) continue;
        const key = String(v);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      entry.values = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, COLUMNS_TOP_VALUES)
        .map(([value, n]) => ({ value, n }));
    }
    out.push(entry);
  }
  return { columns: out, sampledUnits: units.length, computedAt: new Date().toISOString() };
}

// ----------------------------------------------------- the brief's price tag

// Design §6.1: the level-up affordance always states its price. The Instant
// Read's one CTA is the Corpus Brief, so the response carries briefEstimate
// {usd, etaMin} — or null when no Director slot is configured (there is no
// honest price to quote). Estimated with costs.estimateRun in the brief's
// actual shape: ONE Director call whose input is the stratified sample
// (≤500 units, director/brief.js sampling policy) at the corpus's mean unit
// length plus the prompt overhead, emitting ~3000 output tokens.

const BRIEF_PROMPT_OVERHEAD_CHARS = 2500; // preamble + task framing (prompts.js briefPrompt)
const BRIEF_PER_UNIT_FRAME_CHARS = 40;    // "unit u_… (meta): " framing per sampled unit
const BRIEF_OUTPUT_TOKENS = 3000;         // a long structured memo
const BRIEF_CALL_SECONDS = 60;            // one big call ≈ a minute of wall clock

// Director slot pricing via the adapter catalog, cached per provider/model
// (same recipe as director/director.js — an unreachable catalog degrades to
// zero pricing rather than blocking the read).
const briefPricingCache = new Map();

async function directorSlotPricing(project, slot) {
  const key = `${slot.provider} ${slot.model}`;
  if (briefPricingCache.has(key)) return briefPricingCache.get(key);
  const { adapter } = getAdapter(project, slot.provider); // privacy gates apply
  let pricing = { inUSDper1M: 0, outUSDper1M: 0 };
  try {
    const cat = await adapter.catalog();
    const entry = cat.find((m) => m.id === slot.model || m.snapshot === slot.model);
    if (entry?.pricing) pricing = entry.pricing;
  } catch { /* unreachable catalog → zero pricing (local backends cost $0 anyway) */ }
  briefPricingCache.set(key, pricing);
  return pricing;
}

async function briefEstimateFor(project, { unitCount, meanUnitChars }) {
  const slot = project?.director;
  if (!slot || !slot.provider || !slot.model) return null; // no Director → no price
  let pricing;
  try {
    pricing = await directorSlotPricing(project, slot);
  } catch {
    return null; // privacy-blocked or unknown provider — the brief cannot run, so no price
  }
  const sampleN = Math.min(500, briefSampleTarget(unitCount));
  const inputChars = sampleN * (meanUnitChars + BRIEF_PER_UNIT_FRAME_CHARS);
  const e = estimateRun({
    units: ["x".repeat(Math.max(1, Math.round(inputChars)))], // the whole sample rides ONE call
    template: "x".repeat(BRIEF_PROMPT_OVERHEAD_CHARS),
    maxTokens: BRIEF_OUTPUT_TOKENS,
    pricing,
    secondsPerCall: BRIEF_CALL_SECONDS,
    concurrency: 1,
  });
  return { usd: e.estUSD, etaMin: Math.max(1, e.etaMinutes) };
}

// Older cached instant reads predate meanUnitChars — recover it from the
// corpus once rather than recomputing the whole read.
async function meanUnitCharsOf(slug, corpusId) {
  const units = await readCorpusUnits(slug, corpusId);
  if (units.length === 0) return 0;
  return Math.round(units.reduce((n, u) => n + (u.text ?? "").length, 0) / units.length);
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
    pattern: "/api/projects/:p/corpora/:c/columns",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const corpus = findOr404(project.corpora, params.c, "corpus");
      let cached = corpus.columns; // cached in corpus meta, like instantread
      if (!cached) {
        cached = await computeColumns(params.p, params.c, corpus);
        await updateProject(params.p, (p) => {
          const c = p.corpora.find((x) => x.id === params.c);
          if (c) c.columns = cached;
        });
      }
      return { columns: cached.columns };
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/corpora/:c/instantread",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const corpus = findOr404(project.corpora, params.c, "corpus");
      let read = corpus.instantread; // cached in corpus meta
      if (!read) {
        read = await computeInstantRead(params.p, params.c);
        await updateProject(params.p, (p) => {
          const c = p.corpora.find((x) => x.id === params.c);
          if (c) c.instantread = read;
        });
      }
      // the brief price overlays per request (it follows the CURRENT Director
      // slot and catalog pricing) — it is never persisted into the cache, and
      // neither is the scope block (it follows the live corpus entry)
      const meanUnitChars = typeof read.meanUnitChars === "number"
        ? read.meanUnitChars
        : await meanUnitCharsOf(params.p, params.c);
      const briefEstimate = await briefEstimateFor(project, { unitCount: read.unitCount, meanUnitChars });
      return { ...read, briefEstimate, scope: scopeOf(corpus) };
    },
  },
  {
    // Fix a wrong text-column choice WITHOUT re-import: build a NEW corpus
    // whose unit text is the chosen metadata column, preserving the old text
    // under its original column name (design §6.2 — re-unitization versions
    // the corpus; the original is never touched).
    method: "POST",
    pattern: "/api/projects/:p/corpora/:c/reunitize",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const source = findOr404(project.corpora, params.c, "corpus");
      const { textColumn } = requireBody(req, ["textColumn"]);
      const units = await readCorpusUnits(params.p, params.c);
      if (units.length === 0) {
        throw new ConcordError("VALIDATION", `corpus '${params.c}' has no units to re-unitize`, { corpusId: params.c });
      }
      if (!(textColumn in (units[0].meta ?? {}))) {
        const known = Object.keys(units[0].meta ?? {});
        throw new ConcordError("VALIDATION", `"${textColumn}" is not a metadata column of this corpus — columns: ${known.join(", ") || "(none)"}`, { textColumn, known });
      }

      // the old text survives under the old corpus's text column name when
      // known; legacy corpora that never recorded one fall back to "text_prev"
      const prevKey = scopeOf(source).textColumn ?? "text_prev";
      const corpusId = newId("corp");
      let skipped = 0;
      let next = [];
      units.forEach((u, i) => {
        const v = u.meta?.[textColumn];
        const text = v === undefined || v === null ? "" : String(v).trim();
        if (!text) {
          skipped++;
          return;
        }
        const meta = { ...u.meta };
        delete meta[textColumn];
        meta[prevKey] = u.text;
        // ids hash the SOURCE position (i), never the emitted ordinal, so
        // skipped units do not renumber their neighbors (same rule as unitize)
        next.push({ id: unitId(corpusId, i, text), text, meta, pos: u.pos });
      });
      if (next.length === 0) {
        throw new ConcordError("VALIDATION", `every unit's "${textColumn}" is empty — nothing to re-unitize onto`, { textColumn });
      }

      // PII — the derived corpus RE-RUNS the source's mode (absent record =
      // corpora predating the pii fields → the import default, "scan").
      // Re-run, not inherit-the-record-alone: on corpora whose metadata was
      // masked before metadata coverage existed, promoting a column would
      // otherwise put raw identifiers in unit text and silently bypass the
      // masking chosen at import. Same order as import/confirm: pii BEFORE
      // the junk scan, before anything persists.
      const piiMode = source.pii?.mode === "pseudonymize" || source.pii?.mode === "off"
        ? source.pii.mode
        : "scan";
      let pii = { mode: piiMode };
      let piiVault = null;
      if (piiMode === "scan") {
        const { counts } = piiScan(next); // mutates unit.flags.pii in place
        pii = { mode: "scan", counts };
      } else if (piiMode === "pseudonymize") {
        // The derived corpus gets its OWN vault at vault/<corpusId>.json,
        // seeded with the parent's map: tokens already in the promoted text
        // stay protected no-ops, numbering continues past them, and the
        // derived corpus re-identifies without reaching back to the parent.
        // The parent vault is read, never written. A missing parent vault is
        // NOT seeded — pseudonymize then refuses the orphaned tokens
        // (VAULT_CONFLICT) rather than reminting them over new originals.
        const vaultDir = path.join(pdirOf(project.slug), "vault");
        const vaultPath = path.join(vaultDir, `${corpusId}.json`);
        const parentVault = await readJsonFile(path.join(vaultDir, `${source.id}.json`));
        if (parentVault) await writeJsonAtomic(vaultPath, parentVault);
        const masked = await pseudonymize(next, vaultPath);
        next = masked.units; // the MASKED units are what persists
        piiVault = masked.vault;
        pii = { mode: "pseudonymize", counts: masked.vault.counts };
      }

      const junk = junkScan(next); // mutates unit.flags in place, like import/confirm

      await writeTextAtomic(
        corpusUnitsFile(project.slug, corpusId),
        next.map((u) => JSON.stringify(u)).join("\n") + "\n",
      );

      const sourceScheme = scopeOf(source).scheme;
      const entry = {
        id: corpusId,
        name: `${source.name ?? source.id} · text=${textColumn}`,
        ...(source.source ? { source: source.source } : {}),
        unitization: { ...(sourceScheme ? { scheme: sourceScheme } : {}), textColumn },
        unitCount: next.length,
        createdAt: new Date().toISOString(),
        textColumn,
        scheme: sourceScheme,
        junk: junk.counts,
        // what happened to identifiers, re-run from the source's mode —
        // {mode} for "off", {mode, counts} for "scan"/"pseudonymize" (counts
        // are what THIS pass found/replaced; zero when the parent's masking
        // already covered everything promoted)
        pii,
        metaColumns: metaColumnsOf(next),
        sourceName: source.sourceName ?? source.source?.filename ?? null,
        derivedFrom: source.id,
      };
      await updateProject(project.slug, (p) => {
        p.corpora.push(entry);
      });
      const pdir = pdirOf(project.slug);
      await ledger.append(pdir, "human", "corpus.unitized", { corpusId }, {
        textColumn,
        derivedFrom: source.id,
        unitCount: next.length,
        skipped,
        pii,
      });
      if (piiMode === "pseudonymize") {
        // the taxonomy's reserved event, same as import/confirm
        await ledger.append(pdir, "human", "pii.pseudonymized", { corpusId }, {
          counts: piiVault.counts,
          tokenCount: piiVault.tokenCount,
        });
      }
      return { corpusId, unitCount: next.length, junk: junk.counts, textColumn, skipped, pii };
    },
  },
];
