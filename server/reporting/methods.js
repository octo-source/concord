// Methods-section generator. Compiles journal-register prose from the project
// ledger and object graph — template-based and deterministic, no LLM anywhere.
//
// Citation discipline: EVERY sentence ends with an inline token
// `[ledger:<hash8>].` that resolves to a real ledger event. Claims that have a
// provenance event cite it; claims that derive from object state recorded at
// export time cite the `export.methods` event generate() appends BEFORE
// rendering. That event's payload commits to stateHash: sha256 over the
// canonical form of the FULL tuple the prose reads — the analysis object, the
// construct, corpus metadata, the run's {id, status, cost, escalation,
// quarantine, pinned, model, snapshot}, the goldset's {id, design, n,
// piSummary, coderIds, humanAgreement, uncodableUnits, excluded} and the
// instrument's {versionHash, frozen, certificate, stability}. Changing ANY of
// those between exports yields a different stateHash, so the chain closes
// over what was claimed.
//
// generatePreview() renders the same prose WITHOUT appending to the ledger:
// citations resolve against existing events only (the latest export-of-record
// for this analysis, else the chain head) and a banner line marks the output
// "Preview — not an export of record".
//
// Prose rules the citation contract depends on: no abbreviations that end in
// a period mid-sentence ("et al.", "e.g."); interpolated free text has
// internal sentence terminators demoted to semicolons, trailing terminators
// stripped, and anything matching the citation-token grammar removed — so
// quoted text can neither end a sentence uncited nor smuggle a fake citation.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import { canonical, sha256 } from "../core/ids.js";
import * as ledger from "../core/ledger.js";
import { readNdjson } from "../core/store.js";

export const LEVEL_MARKS = { exploratory: "◌", stabilized: "◑", calibrated: "●", corrected: "◉" };
export const LEVEL_NAMES = { exploratory: "Exploratory", stabilized: "Stabilized", calibrated: "Calibrated", corrected: "Corrected" };

// Honest one-liners for every rung below Corrected (and the top rung's claim).
const LEVEL_SENTENCES = {
  exploratory: "Estimates are exploratory; no human validation was performed",
  stabilized: "Estimates are stabilized for test-retest consistency only; no human validation was performed",
  calibrated: "Estimates are calibrated against human gold labels but remain uncorrected for residual machine error",
  corrected: "Estimates are corrected for machine misclassification against designed human gold labels",
};

// The corrected one-liner hedges for uncertainty-targeted gold designs, whose
// recorded π are nominal n/N over a deterministic ranking — not a probability
// design, so the design-based unbiasedness guarantee does not transfer.
function levelSentence(level, goldset) {
  if (level === "corrected" && goldset?.design === "uncertainty") {
    return "Estimates are corrected for machine misclassification against human gold labels from an uncertainty-targeted sample; the design-based unbiasedness guarantee does not apply";
  }
  return LEVEL_SENTENCES[level] ?? LEVEL_SENTENCES.exploratory;
}

// Providers whose ADAPTERS actually transmit a seed parameter on the wire:
// openai (body.seed), openrouter (inherits the openai body), ollama
// (options.seed) and mock (the seed feeds its deterministic stream).
// anthropic exposes no seed parameter — a recorded seed is metadata only.
const SEED_TRANSMITTING_PROVIDERS = new Set(["openai", "openrouter", "ollama", "mock"]);

function fail(message, details = {}) {
  throw new ConcordError("VALIDATION", message, details);
}

// ---------------------------------------------------------------- formatting

// Journal convention: agreement coefficients and proportions at 2 decimals,
// estimates/SEs/π at 3, CIs in brackets.
export function fmt(x, d = 2) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "—";
  const s = x.toFixed(d);
  return s === `-${(0).toFixed(d)}` ? (0).toFixed(d) : s; // never "-0.00"
}

export function fmtCI(ci, d = 2) {
  if (!ci || typeof ci.lo !== "number" || typeof ci.hi !== "number") return null;
  return `[${fmt(ci.lo, d)}, ${fmt(ci.hi, d)}]`;
}

function fmtPct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

// Free text interpolated mid-sentence must not break the per-sentence
// citation contract: strip anything shaped like a citation token (so quoted
// text cannot smuggle one in), demote INTERNAL sentence terminators (. ? !)
// to semicolons, and strip trailing terminators. Known cost, documented:
// dotted abbreviations ("U.S. policy") also demote — acceptable for the
// contract's sake.
function inline(text) {
  return String(text ?? "")
    .replace(/\[ledger:[0-9a-f]{8}\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!]+\s*$/g, "")
    .replace(/[.?!]+\s+/g, "; ")
    .trim();
}

function count(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}

const DESIGN_PHRASES = {
  srs: "a simple random sample",
  stratified: "a stratified random sample",
  uncertainty: "an uncertainty-targeted sample",
};

// ------------------------------------------------------------------ loaders

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      throw new ConcordError("CORRUPT", `${path.basename(file)} is not valid JSON`, { file });
    }
    throw err;
  }
}

export async function loadAnalysis(project, projectDir, analysisId) {
  const fromFile = await readJson(path.join(projectDir, "analyses", `${analysisId}.json`));
  const analysis = fromFile ?? (project.analyses ?? []).find((a) => a?.id === analysisId && a.spec) ?? null;
  if (!analysis) {
    throw new ConcordError("NOT_FOUND", `Analysis '${analysisId}' not found`, { analysisId }, { status: 404 });
  }
  return analysis;
}

export async function loadGoldset(project, projectDir, goldsetId) {
  if (!goldsetId) return null;
  const fromFile = await readJson(path.join(projectDir, "gold", `${goldsetId}.json`));
  return fromFile ?? (project.goldsets ?? []).find((g) => g?.id === goldsetId) ?? null;
}

export async function loadRun(projectDir, runId) {
  if (!runId) return null;
  return readJson(path.join(projectDir, "runs", runId, "run.json"));
}

// ---------------------------------------------------------------- generator

// Export of record: appends an export.methods event (whose payload commits to
// the stateHash) and cites it from every object-state sentence.
export async function generate(project, analysisId, options = {}) {
  return compose(project, analysisId, options, "export");
}

// Side-effect-free preview: SAME prose, NO ledger append. Citations resolve
// against existing events only, and a banner marks the output as a preview.
export async function generatePreview(project, analysisId, options = {}) {
  return compose(project, analysisId, options, "preview");
}

async function compose(project, analysisId, { projectDir } = {}, mode) {
  if (!project || typeof project !== "object" || !project.id) fail("generate requires a project object");
  if (typeof analysisId !== "string" || !analysisId) fail("generate requires an analysisId");
  if (typeof projectDir !== "string" || !projectDir) fail("generate requires options.projectDir");

  const analysis = await loadAnalysis(project, projectDir, analysisId);
  const spec = analysis.spec ?? {};

  // Level/estimator coherence guard: a Corrected mark asserts a correction
  // was applied — refuse to narrate one that records no correction estimator.
  const estimator = String(analysis.results?.estimator ?? spec.estimator ?? "");
  if (analysis.level === "corrected" && !/^(dsl|ppi)/.test(estimator)) {
    fail(`analysis '${analysisId}' carries the Corrected level but records no correction estimator`, {
      analysisId, estimator: estimator || null,
    });
  }
  const run = await loadRun(projectDir, spec.runId);
  const instrument = (project.instruments ?? []).find((i) => i.id === (spec.instrumentId ?? run?.instrumentId)) ?? null;
  const construct = (project.constructs ?? []).find((c) => c.id === (instrument?.constructId ?? spec.constructId)) ?? null;
  const corpusId = spec.corpusId ?? run?.corpusId ?? project.corpora?.[0]?.id;
  const corpus = (project.corpora ?? []).find((c) => c.id === corpusId) ?? null;
  const goldsetId = spec.goldsetId ?? instrument?.certificate?.goldsetId ?? null;
  const goldset = await loadGoldset(project, projectDir, goldsetId);
  const silverset = await loadGoldset(project, projectDir, instrument?.silver?.goldsetId);

  // ledger index: most-recent event per (type, ref) — the state a sentence cites
  const events = await ledger.query(projectDir);
  const find = (type, ref) => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== type) continue;
      if (ref === undefined || Object.values(e.refs ?? {}).includes(ref)) return e;
    }
    return null;
  };

  // stateHash commits to the FULL tuple the prose below reads (see header).
  const goldPis = (goldset?.sample ?? []).map((x) => x.pi).filter((p) => typeof p === "number");
  const stateHash = sha256(canonical({
    analysis,
    construct: construct ?? null,
    corpusMeta: corpus ? {
      id: corpus.id, name: corpus.name ?? null, source: corpus.source ?? null,
      unitization: corpus.unitization ?? null, unitCount: corpus.unitCount ?? null,
    } : null,
    run: run ? {
      id: run.id, status: run.status ?? null, cost: run.cost ?? null,
      escalation: run.escalation ?? null, quarantine: run.quarantine ?? null,
      pinned: run.pinned ?? null, model: run.model ?? null, snapshot: run.snapshot ?? null,
    } : null,
    goldset: goldset ? {
      id: goldset.id, design: goldset.design ?? null, n: goldset.sample?.length ?? null,
      piSummary: goldPis.length ? { min: Math.min(...goldPis), max: Math.max(...goldPis) } : null,
      coderIds: (goldset.coders ?? []).map((c) => c.coderId ?? null),
      humanAgreement: goldset.humanAgreement ?? null,
      uncodableUnits: [...new Set((goldset.coders ?? []).flatMap((c) => Object.keys(c.uncodable ?? {})))].sort(),
      excluded: goldset.excluded ?? null,
    } : null,
    instrument: instrument ? {
      versionHash: instrument.versionHash ?? null, frozen: instrument.frozen ?? false,
      certificate: instrument.certificate ?? null, stability: instrument.stability ?? null,
    } : null,
  }));

  // Export: the export.methods event is appended FIRST so object-state
  // sentences can cite it. Preview: NO append — anchor on the most recent
  // export-of-record for this analysis, else the current chain head.
  let anchorEvent;
  if (mode === "export") {
    anchorEvent = await ledger.append(projectDir, "system", "export.methods",
      { projectId: project.id, analysisId }, { analysisId, stateHash, format: "markdown" });
  } else {
    anchorEvent = [...events].reverse().find((e) => e.type === "export.methods" && e.refs?.analysisId === analysisId)
      ?? events[events.length - 1];
    if (!anchorEvent) fail("preview requires at least one ledger event to cite", { analysisId });
  }

  // citations: dedup by token; cite() returns the inline token text
  const citations = new Map();
  const cite = (event) => {
    const e = event ?? anchorEvent;
    const token = `ledger:${e.hash.slice(0, 8)}`;
    if (!citations.has(token)) citations.set(token, { token, hash: e.hash, type: e.type });
    return `[${token}]`;
  };
  // sentence: text (no trailing period) + citation + period
  const s = (text, event) => `${text} ${cite(event)}.`;

  const out = [];
  out.push("# Methods");
  out.push("");
  if (mode === "preview") {
    out.push("> Preview — not an export of record");
    out.push("");
    out.push(s("This section was generated by Concord from the project ledger, and every sentence cites the hash-chained ledger event that substantiates it", anchorEvent));
  } else {
    out.push(s("This section was generated by Concord from the project ledger; every sentence cites the hash-chained ledger event that substantiates it, and the export itself is recorded in the same ledger", anchorEvent));
  }
  out.push("");

  let n = 0;
  const section = (title) => {
    n += 1;
    out.push(`## ${n}. ${title}`);
    out.push("");
  };
  const para = (...sentences) => {
    out.push(sentences.join(" "));
    out.push("");
  };

  // ---- 1. Data and unitization
  section("Data and unitization");
  {
    const imported = find("corpus.imported", corpus?.id);
    const unitized = find("corpus.unitized", corpus?.id);
    const rows = corpus?.source?.rows ?? imported?.payload?.rows;
    const unitCount = corpus?.unitCount ?? unitized?.payload?.unitCount
      ?? (corpus ? (await readNdjson(path.join(projectDir, "corpora", corpus.id, "units.ndjson"))).length : null);
    const scheme = corpus?.unitization?.scheme ?? unitized?.payload?.scheme ?? "response";
    const src = corpus?.source ?? {};
    const sentences = [];
    if (corpus) {
      sentences.push(s(`The corpus "${inline(corpus.name ?? corpus.id)}" was imported from ${inline(src.filename ?? "the source file")}${src.format ? ` (${src.format}${rows != null ? `, ${rows} rows` : ""})` : ""}`, imported));
      sentences.push(s(`Texts were unitized at the ${scheme} level, yielding ${unitCount ?? "the recorded number of"} analyzable units`, unitized));
    } else {
      sentences.push(s("No corpus metadata is attached to this analysis; unit counts derive from the stored unit files at export time", anchorEvent));
    }
    para(...sentences);
  }

  // ---- 2. Construct and codebook development
  if (construct) {
    section("Construct and codebook development");
    const created = find("construct.created", construct.id);
    const edited = find("construct.edited", construct.id);
    const sentences = [];
    sentences.push(s(`The construct "${inline(construct.name)}" (${construct.type}) was defined as: "${inline(construct.definition)}"`, created));
    if (construct.authoredBy === "director" && construct.humanTouched && edited) {
      sentences.push(s("The codebook entry was drafted by the AI Director and subsequently reviewed and edited by the research team", edited));
    } else if (construct.authoredBy === "director" && construct.humanTouched) {
      sentences.push(s("The codebook entry was drafted by the AI Director and subsequently accepted by the research team", created));
    } else if (construct.authoredBy === "director") {
      sentences.push(s("The codebook entry was drafted by the AI Director and has not been edited by a human", created));
    } else {
      sentences.push(s("The codebook entry was authored by the research team", created ?? edited));
    }
    // Constructs are never frozen: even a frozen instrument's prompt slots
    // are filled from the LIVE construct at call time, so the entry is always
    // the state recorded at export time. (A construct snapshot taken at
    // instrument freeze is roadmap; until then the gap is disclosed below.)
    sentences.push(s(`As recorded at export time, the entry specifies ${count(construct.criteria?.include?.length ?? 0, "inclusion criterion", "inclusion criteria")}, ${count(construct.criteria?.exclude?.length ?? 0, "exclusion criterion", "exclusion criteria")}, ${count(construct.edgeCases?.length ?? 0, "documented edge case")} and ${count(construct.examples?.length ?? 0, "worked example")}`, anchorEvent));
    if (instrument?.frozen) {
      sentences.push(s(`The instrument freeze versions the prompt template, not the codebook entry: these counts read the live construct rather than a snapshot "As frozen for this analysis", which Concord does not yet take`, anchorEvent));
    }
    para(...sentences);
  }

  // ---- 3. Gold-standard sample (only when human gold exists)
  if (goldset && goldset.tier === "gold") {
    section("Gold-standard sample");
    const sampled = find("goldset.sampled", goldset.id) ?? find("goldset.created", goldset.id);
    const labelEv = find("goldset.label", goldset.id);
    const adjudicatedEv = find("goldset.adjudicated", goldset.id);
    // hand-queued rows ({pi: null, queued: true}) are NOT design-sampled and
    // never enter the corrected estimators — report them separately, never
    // inside the design-sample n
    const sampleRows = goldset.sample ?? [];
    const designRows = sampleRows.filter((x) => typeof x.pi === "number" && Number.isFinite(x.pi));
    const queuedN = sampleRows.length - designRows.length;
    const nGold = designRows.length;
    const pis = designRows.map((x) => x.pi);
    const piMin = Math.min(...pis);
    const piMax = Math.max(...pis);
    const design = DESIGN_PHRASES[goldset.design] ?? `a ${goldset.design} sample`;
    const strata = goldset.strata?.by ? ` stratified by ${inline(goldset.strata.by)}` : "";
    const sentences = [];
    sentences.push(s(queuedN > 0
      ? `A gold-standard validation sample of n = ${nGold} design-sampled units (π recorded) was drawn as ${design}${strata}, plus ${count(queuedN, "hand-queued unit")} excluded from the corrected estimators`
      : `A gold-standard validation sample of n = ${nGold} units was drawn as ${design}${strata}`, sampled));
    if (pis.length > 0) {
      const piText = piMax - piMin < 1e-12
        ? `π = ${fmt(piMin, 3)} for every sampled unit`
        : `π ranging from ${fmt(piMin, 3)} to ${fmt(piMax, 3)} across strata`;
      // uncertainty targeting records π as nominal n/N over a deterministic
      // ranking — that is not a probability design, and the prose must not
      // claim design-fixed inclusion probabilities for it
      sentences.push(s(goldset.design === "uncertainty"
        ? `Unit inclusion probabilities were recorded as nominal n/N over a deterministic uncertainty ranking (${piText}); the design-based unbiasedness guarantee does not apply`
        : `Unit inclusion probabilities were fixed by the design and recorded at sampling time (${piText})`, sampled));
    }
    const coders = goldset.coders ?? [];
    if (coders.length > 0) {
      // the blind flags record blindness to machine labels and to the other
      // coders' labels; the structural claim is about the INTERFACE — the
      // blind /next route serves coders no machine labels and no co-coder
      // labels — not about what a coder might have seen elsewhere
      const blind = coders.every((c) => c.blind);
      sentences.push(s(`${count(coders.length, "human coder")} labeled the sample independently${blind ? "; labels were collected through Concord's blind coding interface, which serves coders no machine labels and no co-coder labels, so each coder was blind to machine labels and to each other's labels" : ""}`, labelEv ?? sampled));
    }
    if (goldset.adjudicated) {
      // matches the gold assembly rule: explicit adjudications win, and units
      // where at least two coders agreed unanimously carry the consensus label
      sentences.push(s("Coder disagreements were resolved by adjudication, and the adjudicated labels, together with units where at least two coders agreed unanimously, constitute the gold standard used below", adjudicatedEv ?? anchorEvent));
    }
    para(...sentences);
  }

  // ---- 4. Human reliability
  const ha = goldset?.humanAgreement ?? instrument?.certificate?.humanAgreement;
  if (ha) {
    section("Human reliability");
    const agreeEv = find("goldset.agreement", goldset?.id);
    // The "computed before any machine comparison" claim is made ONLY when
    // the ledger proves the order: the latest agreement computation must
    // precede every event that compares machine output to this goldset's
    // labels (freeze/calibration, silver tuning, analyses).
    const MACHINE_COMPARISON_TYPES = new Set(["instrument.frozen", "instrument.calibrated", "instrument.silver_tuned", "analysis.created"]);
    const agreeIdx = agreeEv ? events.indexOf(agreeEv) : -1;
    const firstMachineIdx = events.findIndex((e) => MACHINE_COMPARISON_TYPES.has(e.type)
      && (goldset?.id ? Object.values(e.refs ?? {}).includes(goldset.id) : true));
    const orderProven = agreeIdx !== -1 && (firstMachineIdx === -1 || agreeIdx < firstMachineIdx);
    const blindCoders = (goldset?.coders ?? []).length > 0 && goldset.coders.every((c) => c.blind);
    const bits = [];
    if (typeof ha.percent === "number") bits.push(`raw agreement of ${fmtPct(ha.percent)}`);
    // ordinal constructs are scored with linear weights (agreementReport
    // passes weighted: "linear") — name the statistic that was computed
    if (typeof ha.kappa === "number") bits.push(`${construct?.type === "ordinal" ? "linear-weighted Cohen's kappa" : "Cohen's kappa"} = ${fmt(ha.kappa)}`);
    if (typeof ha.alpha === "number") bits.push(`Krippendorff's alpha = ${fmt(ha.alpha)}${fmtCI(ha.ci) ? `, 95% CI ${fmtCI(ha.ci)} (${ha.ci.method ?? "bootstrap"})` : ""}`);
    const sentences = [
      s(orderProven
        ? "Inter-coder reliability was computed before any machine output was compared to the human labels"
        : `Inter-coder reliability was computed from the ${blindCoders ? "blind " : ""}double-coded sample`, agreeEv),
      s(`On the ${ha.n ?? goldset?.sample?.length ?? "gold"} jointly coded units the coders reached ${bits.join(", ")}`, agreeEv),
    ];
    // The uncodable channel, disclosed factually whenever it was used: units
    // a coder marked uncodable contribute no agreement row for that coder
    // (missing data, never a forced binary guess), and adjudication-excluded
    // units are out of the gold standard everywhere. Counts are object state
    // recorded at export time, so the sentence cites the export anchor.
    const uncodableN = new Set((goldset?.coders ?? []).flatMap((c) => Object.keys(c.uncodable ?? {}))).size;
    const excludedN = (goldset?.excluded ?? []).length;
    if (uncodableN > 0 || excludedN > 0) {
      const clauses = [];
      if (uncodableN > 0) clauses.push(`${count(uncodableN, "unit")} ${uncodableN === 1 ? "was" : "were"} marked uncodable by at least one coder`);
      if (excludedN > 0) clauses.push(`${count(excludedN, "unit")} ${excludedN === 1 ? "was" : "were"} excluded from the gold standard after adjudication`);
      sentences.push(s(clauses.join("; "), anchorEvent));
    }
    para(...sentences);
  }

  // ---- 5. Instrument
  if (instrument) {
    section("Instrument");
    const createdEv = find("instrument.created", instrument.id);
    const compiledEv = find("instrument.compiled", instrument.id);
    const frozenEv = find("instrument.frozen", instrument.id);
    const silverEv = find("instrument.silver_tuned", instrument.id);
    const stabilityEv = find("instrument.stability", instrument.id);
    const p = instrument.payload ?? {};
    const sentences = [];
    if (instrument.kind === "judge" || instrument.kind === "panel") {
      const jurors = instrument.kind === "panel" ? (p.jurors ?? []) : [p];
      // panels: name the recorded models; "model families" are not a recorded
      // fact, so no disjointness claim
      const snap = (j) => (j?.snapshot ? inline(j.snapshot) : "not recorded");
      const head = instrument.kind === "panel"
        ? `Machine labels were produced by a panel of ${count(jurors.length, "LLM juror")}: ${jurors.map((j) => `${inline(j?.model ?? "model not recorded")} (snapshot ${snap(j)})`).join(", ")}`
        : `Machine labels were produced by a single LLM judge: model ${inline(jurors[0]?.model)} (snapshot ${snap(jurors[0])}) served by ${inline(jurors[0]?.provider)}`;
      sentences.push(s(head, compiledEv ?? createdEv));
      // decoding parameters: one shared description only when the jurors
      // actually share them; unrecorded values say so instead of defaulting
      const paramSets = new Set(jurors.map((j) => canonical(j?.params ?? null)));
      if (instrument.kind === "panel" && paramSets.size > 1) {
        sentences.push(s("Decoding parameters varied across jurors; the per-juror configurations are recorded in the replication archive export", compiledEv ?? createdEv));
      } else {
        const params = jurors[0]?.params ?? {};
        const decode = [
          typeof params.temperature === "number" ? `temperature ${params.temperature}` : "a temperature that was not recorded",
          typeof params.maxTokens === "number" ? `a maximum of ${params.maxTokens} output tokens` : "an output-token maximum that was not recorded",
        ];
        // "a fixed seed" is earned only when every serving adapter actually
        // transmits the seed parameter; otherwise the seed is a recorded
        // intention the provider never saw, and the prose must say so
        const seedProviders = [...new Set(jurors.map((j) => j?.provider).filter(Boolean))];
        const seedNonTransmitting = seedProviders.filter((pr) => !SEED_TRANSMITTING_PROVIDERS.has(pr));
        if (params.seed !== undefined && seedProviders.length > 0 && seedNonTransmitting.length === 0) {
          decode.push(`a fixed seed of ${params.seed}`);
        }
        sentences.push(s(`Decoding used ${decode.join(", ")}`, compiledEv ?? createdEv));
        if (params.seed !== undefined && (seedProviders.length === 0 || seedNonTransmitting.length > 0)) {
          const transmitting = seedProviders.filter((pr) => SEED_TRANSMITTING_PROVIDERS.has(pr));
          const plural = (list) => (list.length > 1 ? "do" : "does");
          const text = seedProviders.length === 0
            ? `A seed of ${params.seed} was recorded, but no serving provider was recorded, so whether the seed was transmitted is unknown`
            : transmitting.length === 0
              ? `A seed of ${params.seed} was recorded; ${seedNonTransmitting.map(inline).join(", ")} ${plural(seedNonTransmitting)} not accept a seed parameter, so the seed was not transmitted with the calls`
              : `A seed of ${params.seed} was recorded; it was transmitted to ${transmitting.map(inline).join(", ")}, while ${seedNonTransmitting.map(inline).join(", ")} ${plural(seedNonTransmitting)} not accept a seed parameter`;
          sentences.push(s(text, compiledEv ?? createdEv));
        }
      }
      // "injected verbatim" only when every juror's template actually carries
      // all three codebook slots
      const templates = jurors.map((j) => j?.promptTemplate ?? p.promptTemplate).filter((t) => typeof t === "string");
      const allSlots = templates.length > 0
        && templates.every((t) => ["{{definition}}", "{{criteria}}", "{{examples}}"].every((slot) => t.includes(slot)));
      if (allSlots) {
        sentences.push(s("The compiled codebook (definition, criteria and worked examples) was injected into the prompt verbatim", compiledEv ?? createdEv));
      }
      if (jurors[0]?.rationaleFirst) {
        sentences.push(s("Each judgment required a written rationale before the verdict and was returned as schema-constrained structured output", compiledEv ?? createdEv));
      }
    } else if (instrument.kind === "dictionary") {
      const cats = p.categories ?? [];
      const terms = cats.reduce((acc, c) => acc + (c.terms?.length ?? 0), 0);
      sentences.push(s(`Measurement used a closed-vocabulary dictionary instrument with ${cats.length} ${cats.length === 1 ? "category" : "categories"} and ${terms} terms, scored as ${p.scoring ?? "percentOfWords"}${p.negation?.enabled ? ` with a ${p.negation.window}-token negation window` : ""}, executed locally without any model call`, createdEv));
    } else {
      sentences.push(s(`Measurement used a ${instrument.kind} instrument`, createdEv));
    }
    sentences.push(s("The complete instrument specification, including the full prompt text where applicable, is available in the replication archive export accompanying this report", anchorEvent));
    if (instrument.silver?.iterations?.length) {
      // "Before any human validation" is claimed only when the ledger proves
      // the order: the latest silver-tune event must precede every human
      // gold-labeling event (same pattern as the agreement-order proof)
      const HUMAN_VALIDATION_TYPES = new Set(["goldset.label", "goldset.adjudicated"]);
      const silverIdx = silverEv ? events.indexOf(silverEv) : -1;
      const firstHumanIdx = events.findIndex((e) => HUMAN_VALIDATION_TYPES.has(e.type));
      const tunedFirst = silverIdx !== -1 && (firstHumanIdx === -1 || silverIdx < firstHumanIdx);
      const tuned = `the instrument was tuned against ${silverset?.sample?.length ?? "a sample of"} Director-labeled silver units over ${count(instrument.silver.iterations.length, "iteration")}, reaching agreement of ${fmt(instrument.silver.iterations.at(-1).agreement)}`;
      sentences.push(s(tunedFirst
        ? `Before any human validation, ${tuned}`
        : `${tuned.charAt(0).toUpperCase()}${tuned.slice(1)}; the ledger does not establish whether tuning preceded human validation`, silverEv ?? createdEv));
    }
    if (instrument.stability) {
      sentences.push(s(`A ${instrument.stability.k}-run test-retest stability check on ${instrument.stability.n} units yielded alpha = ${fmt(instrument.stability.alpha)}`, stabilityEv ?? anchorEvent));
    }
    if (instrument.frozen) {
      sentences.push(s(`The instrument was frozen as version ${instrument.version} with content hash ${instrument.versionHash.slice(0, 12)}…, so any subsequent edit forks a new version rather than altering the version reported here`, frozenEv ?? anchorEvent));
    }
    // Pinning is the RUN's recorded fact — and run.pinned records only that a
    // snapshot string was RECORDED for every juror. No adapter transmits the
    // snapshot to the provider (ollama records a digest while calling a
    // mutable tag), so the prose claims recording, never verified serving.
    if (run) {
      const runStartedEv = find("run.started", run.id);
      if (run.pinned && instrument.kind === "dictionary") {
        sentences.push(s("The dictionary instrument executed locally with no model call; the run records the instrument version hash as its snapshot, pinned for every call in this run", runStartedEv ?? anchorEvent));
      } else if (run.pinned) {
        const jurorList = instrument.kind === "panel" ? (p.jurors ?? []) : [p];
        const snaps = [...new Set(jurorList.map((j) => j?.snapshot).filter((x) => typeof x === "string" && x.length > 0))];
        const everyRecorded = jurorList.length > 0 && jurorList.every((j) => typeof j?.snapshot === "string" && j.snapshot.length > 0);
        if (everyRecorded) {
          sentences.push(s(`A model snapshot identifier was recorded for every juror (${snaps.map(inline).join(", ")}) and is reported as pinned for every call in this run; Concord records but does not verify that the provider served ${snaps.length === 1 ? "that snapshot" : "those snapshots"}`, runStartedEv ?? anchorEvent));
        } else if (typeof run.snapshot === "string" && run.snapshot) {
          sentences.push(s(`A model snapshot identifier was recorded (${inline(run.snapshot)}) and is reported as pinned for every call in this run; Concord records but does not verify that the provider served that snapshot`, runStartedEv ?? anchorEvent));
        } else {
          sentences.push(s("The run reports its model snapshot as pinned for every call in this run, but no snapshot identifier was recorded; this gap should be weighed when interpreting reproducibility", runStartedEv ?? anchorEvent));
        }
      } else {
        sentences.push(s("The run did not pin a model snapshot; the recorded snapshot string identifies the model as served at run time, and this limitation should be weighed when interpreting reproducibility", runStartedEv ?? anchorEvent));
      }
    }
    para(...sentences);
  }

  // ---- 6. Calibration results
  const cert = instrument?.certificate;
  if (cert?.agreement) {
    section("Calibration results");
    const frozenEv = find("instrument.frozen", instrument.id);
    const a = cert.agreement;
    const bits = [];
    if (typeof a.percent === "number") bits.push(`${fmtPct(a.percent)} raw agreement`);
    if (typeof a.kappa === "number") bits.push(`kappa = ${fmt(a.kappa)}`);
    if (typeof a.alpha === "number") bits.push(`alpha = ${fmt(a.alpha)}${fmtCI(a.ci) ? `, 95% CI ${fmtCI(a.ci)}` : ""}`);
    para(s(`Against the adjudicated gold standard (n = ${a.n}), the frozen instrument achieved ${bits.join(", ")}`, frozenEv ?? anchorEvent));
    if (Array.isArray(a.perClass) && a.perClass.length > 0) {
      para(s("Per-class operating characteristics of the frozen instrument were as follows", frozenEv ?? anchorEvent));
      out.push("| Label | Precision | Recall | F1 | Support |");
      out.push("|---|---|---|---|---|");
      for (const r of a.perClass) {
        out.push(`| ${inline(String(r.label))} | ${fmt(r.precision)} | ${fmt(r.recall)} | ${fmt(r.f1)} | ${r.support} |`);
      }
      out.push("");
    }
  }

  // ---- 7. Aggregation and run execution
  if (instrument?.kind === "panel" || run) {
    section("Aggregation and run execution");
    const sentences = [];
    if (instrument?.kind === "panel") {
      const agg = instrument.payload?.aggregation;
      sentences.push(s(agg
        ? `Juror outputs were aggregated per unit by the ${inline(agg)} rule, and the aggregate verdict is the machine label analyzed below`
        : "Juror outputs were aggregated per unit; the aggregation rule was not recorded", find("instrument.compiled", instrument.id) ?? anchorEvent));
    } else if (instrument) {
      // "exactly one machine judgment" is true only when zero escalations
      // were recorded (an escalation replaces the primary judgment with a
      // Director second opinion)
      sentences.push(s(run?.escalation?.count === 0
        ? "Each unit received exactly one machine judgment from the instrument; no panel aggregation was applied"
        : "Machine labels came from the instrument with no panel aggregation", anchorEvent));
    }
    if (run) {
      const completedEv = find("run.completed", run.id);
      const startedEv = find("run.started", run.id);
      const done = run.checkpoint?.done;
      const total = run.checkpoint?.total;
      const progress = typeof done === "number" && typeof total === "number"
        ? `completing ${done} of ${total} units`
        : "with completion counts not recorded";
      // costs are token counts metered from responses, priced from a STATIC
      // rate table (anthropic rates are estimate-grade; unknown models meter
      // $0) — never a provider-billed amount, so say what the number is
      const cost = typeof run.cost?.actualUSD === "number"
        ? `at a cost of $${fmt(run.cost.actualUSD, 2)} (metered token counts priced at estimate-grade static rates)`
        : "with no metered cost recorded";
      sentences.push(s(`The instrument was applied to the corpus in run ${run.id}, ${progress}, ${cost}`, completedEv ?? startedEv ?? anchorEvent));
      // escalations are methodologically material: say how many, what the
      // predicate is (engine: low confidence, panel entropy, schema repair,
      // atypical length), and whether a Director gave a second opinion — a
      // run without a configured Director records flags, nothing more
      const escN = run.escalation?.count;
      if (typeof escN === "number" && escN > 0) {
        const dm = run.escalation?.directorModel;
        sentences.push(s(dm
          ? `${count(escN, "unit")} ${escN === 1 ? "was" : "were"} escalated: the primary judgment was flagged by the escalation predicate (low confidence, panel disagreement, schema repair, or unusually long text) and judged again by the Director model (${inline(dm)}); on disagreement the Director's verdict replaced the primary judgment`
          : `${count(escN, "unit")} ${escN === 1 ? "was" : "were"} escalated: the primary judgment was flagged by the escalation predicate (low confidence, high entropy, schema repair, or unusually long text); the run names no Director model (not recorded), so flags carry no second opinion and escalated units keep the primary judgment`, completedEv ?? anchorEvent));
      }
      if (run.quarantine?.length > 0) {
        sentences.push(s(`${count(run.quarantine.length, "unit")} failed structured-output enforcement (schema validation after constrained repair, provider refusal, or truncation) and ${run.quarantine.length === 1 ? "was" : "were"} quarantined rather than silently dropped`, completedEv ?? anchorEvent));
      }
    }
    para(...sentences);
  }

  // ---- 8. Statistical correction / estimation
  const mark = LEVEL_MARKS[analysis.level] ?? "◌";
  const levelName = LEVEL_NAMES[analysis.level] ?? analysis.level;
  const results = analysis.results ?? {};
  const isDsl = analysis.level === "corrected" && /^(dsl|ppi)/.test(estimator);
  if (isDsl) {
    section("Statistical correction");
    const analysisEv = find("analysis.created", analysis.id) ?? anchorEvent;
    const estimatorName = /^ppi/.test(estimator) ? "prediction-powered inference" : "design-based supervised learning";
    const design = DESIGN_PHRASES[goldset?.design] ?? "a designed gold sample";
    const sentences = [];
    sentences.push(s(`Population estimates were corrected for machine misclassification with ${estimatorName}, combining the machine labels on every unit with the adjudicated gold labels on ${design} whose inclusion probabilities were recorded at sampling time (Egami, Hinck, Stewart, and Wei 2023; Angelopoulos, Bates, Fannjiang, Jordan and Zrnic 2023)`, analysisEv));
    if (goldset?.design === "uncertainty") {
      sentences.push(s("The gold sample was uncertainty-targeted: its recorded inclusion probabilities are nominal n/N over a deterministic uncertainty ranking, so the design-based unbiasedness guarantee of this estimator does not apply", analysisEv));
    }
    sentences.push(s("For each estimand the gold-corrected pseudo-outcome replaces the raw machine label in the usual moment condition, and sandwich standard errors with normal-quantile 95% confidence intervals are reported", analysisEv));
    sentences.push(s("The uncorrected naive estimate is reported beside every corrected value, never instead of it", analysisEv));
    if (results.diff && typeof results.diff.est === "number") {
      const d = results.diff;
      sentences.push(s(`The corrected ${inline(results.outcome ?? "outcome")} difference between ${inline(d.a)} and ${inline(d.b)} was ${fmt(d.est, 3)} (SE ${fmt(d.se, 3)}), 95% CI [${fmt(d.ciLo, 3)}, ${fmt(d.ciHi, 3)}], against a naive difference of ${fmt(d.naive?.est, 3)}`, analysisEv));
    } else if (Array.isArray(results.cells) && results.cells[0] && typeof results.cells[0].est === "number") {
      // the naive companion rides the per-cell sentence too — the promise two
      // sentences up ("beside every corrected value") must hold right here
      const c = results.cells[0];
      const naiveBit = c.naive && typeof c.naive.est === "number"
        ? `, against a naive estimate of ${fmt(c.naive.est, 3)}`
        : ", with no naive companion recorded";
      sentences.push(s(`The corrected estimate for ${inline(String(c.group))} was ${fmt(c.est, 3)} (SE ${fmt(c.se, 3)}), 95% CI [${fmt(c.ciLo, 3)}, ${fmt(c.ciHi, 3)}]${naiveBit}`, analysisEv));
    }
    sentences.push(s(`This analysis carries the ${levelName} (${mark}) evidence mark, the highest level on Concord's evidence ladder`, analysisEv));
    para(...sentences);
  } else {
    section("Statistical estimation");
    const analysisEv = find("analysis.created", analysis.id) ?? anchorEvent;
    para(
      s("No statistical correction was applied to the reported estimates", analysisEv),
      s(`This analysis carries the ${levelName} (${mark}) evidence mark`, analysisEv),
      s(levelSentence(analysis.level, goldset), anchorEvent)
    );
  }

  return { markdown: out.join("\n").trimEnd() + "\n", citations: [...citations.values()] };
}
